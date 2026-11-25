package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/** «مركز الدعم» (owner, 11 Nov 2026; ADR-053, V35) and «دليل تمركز» over the API (ADR-054). */
class SupportIT extends IntegrationTest {

    UUID root, admin, user, other, agent, agent2;
    String viewer;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        viewer = role("VIEWER", "ORGANIZATION", "VIEW");
        admin = person("sadmin", "SYSTEM_ADMIN", root);
        user = person("suser", viewer, root);
        other = person("sother", viewer, root);
        agent = person("sagent", viewer, root);
        agent2 = person("sagent2", viewer, root);
    }

    private void seat(Api by, UUID person, String role) {
        Res r = by.post("/support/seats", Map.of("personId", person.toString(), "role", role));
        assertThat(r.status()).as(String.valueOf(r.body())).isEqualTo(200);
    }

    private Res act(Api a, String id, String action, Object... kv) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("action", action);
        for (int i = 0; i < kv.length; i += 2) {
            body.put((String) kv[i], kv[i + 1]);
        }
        return a.post("/support/console/cases/" + id + "/act", body);
    }

    private long notes(UUID person, String kind) {
        return jdbc.sql("select count(*) from notification where person_id = :p and kind = :k").param("p", person).param("k", kind)
                .query(Long.class).single();
    }

    @Test
    @DisplayName("SUP-1: report, take, reply, internal note, resolve, confirm — each person sees only what is theirs")
    void lifecycle() {
        Api adminApi = login("sadmin");
        seat(adminApi, agent, "SUPERVISOR");
        Api a = login("sagent");
        seat(a, agent2, "AGENT");
        assertThat(a.post("/support/seats", Map.of("personId", other.toString(), "role", "SUPERVISOR")).status())
                .as("a supervisor seat comes from a configuration administrator").isEqualTo(403);

        Api u = login("suser");
        Map<String, Object> open = new LinkedHashMap<>();
        open.put("title", "لا تظهر الخريطة");
        open.put("category", "MAP");
        open.put("priority", "HIGH");
        open.put("body", "تظهر الصفحة بيضاء بعد الدخول.");
        open.put("screen", "siteSetup");
        open.put("clientInfo", Map.of("browser", "Edge 140", "secret", "not kept", "screen", "1920x1080"));
        Res created = u.post("/support/cases", open);
        assertThat(created.status()).as(String.valueOf(created.body())).isEqualTo(200);
        String id = created.body().path("id").asText();
        assertThat(created.body().path("number").asText()).matches("SUP-\\d{4}-\\d{4}");
        assertThat(jdbc.sql("select client_info::text from support_case where id = cast(:id as uuid)").param("id", id).query(String.class).single())
                .contains("Edge 140").doesNotContain("secret");
        assertThat(notes(agent, "SUPPORT_NEW")).isEqualTo(1);
        assertThat(notes(agent2, "SUPPORT_NEW")).isEqualTo(1);

        // the case is the reporter's and the staff's only
        assertThat(login("sother").get("/support/cases/" + id).status()).isEqualTo(404);
        assertThat(login("sother").get("/support/console/cases").status()).isEqualTo(403);
        assertThat(u.get("/support/cases").body().size()).isEqualTo(1);

        JsonNode queue = a.get("/support/console/cases?filter=unassigned").body();
        assertThat(queue.toString()).contains(id);
        assertThat(act(a, id, "CLAIM").status()).isEqualTo(204);
        assertThat(act(a, id, "REPLY", "body", "ملاحظة للفريق: مشكلة في الحزمة", "internal", true).status()).isEqualTo(204);
        assertThat(act(a, id, "REPLY", "body", "هل جربت تحديث الصفحة؟", "internal", false).status()).isEqualTo(204);
        assertThat(notes(user, "SUPPORT_REPLY")).isEqualTo(1);
        JsonNode seen = u.get("/support/cases/" + id).body();
        assertThat(seen.path("status").asText()).isEqualTo("WAITING_USER");
        assertThat(seen.toString()).contains("هل جربت تحديث الصفحة").doesNotContain("ملاحظة للفريق").doesNotContain("Edge 140");
        assertThat(a.get("/support/cases/" + id).body().toString()).contains("ملاحظة للفريق").contains("Edge 140");
        assertThat(seen.path("firstResponseAt").isNull()).isFalse();

        assertThat(u.post("/support/cases/" + id + "/messages", Map.of("body", "نعم، لم يتغير شيء")).status()).isEqualTo(204);
        assertThat(notes(agent, "SUPPORT_UPDATE")).as("to the assignee").isEqualTo(1);
        assertThat(act(a, id, "PRIORITY", "priority", "CRITICAL").status()).isEqualTo(204);
        assertThat(act(login("sagent2"), id, "ASSIGN", "assigneeId", agent2.toString()).status()).as("an agent does not assign").isEqualTo(403);
        assertThat(act(a, id, "ASSIGN", "assigneeId", other.toString()).status()).as("only to a seat").isEqualTo(400);
        assertThat(act(a, id, "RESOLVE", "body", "").status()).as("the solution is written").isEqualTo(400);
        assertThat(act(a, id, "RESOLVE", "body", "أعيد تثبيت حزمة الخرائط").status()).isEqualTo(204);
        assertThat(notes(user, "SUPPORT_RESOLVED")).isEqualTo(1);

        // the person reopens, then it is resolved again and confirmed
        assertThat(u.post("/support/cases/" + id + "/confirm", Map.of("solved", false, "note", "ما زالت بيضاء")).status()).isEqualTo(204);
        assertThat(u.get("/support/cases/" + id).body().path("status").asText()).isEqualTo("IN_PROGRESS");
        assertThat(act(a, id, "RESOLVE", "body", "حُدّث المتصفح").status()).isEqualTo(204);
        assertThat(u.post("/support/cases/" + id + "/confirm", Map.of("solved", true)).status()).isEqualTo(204);
        assertThat(u.get("/support/cases/" + id).body().path("status").asText()).isEqualTo("CLOSED");
        assertThat(u.post("/support/cases/" + id + "/messages", Map.of("body", "شكراً")).status()).isEqualTo(400);
        assertThat(a.get("/support/cases/" + id).body().path("events").size()).isGreaterThanOrEqualTo(9);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action like 'SUPPORT_CASE_%'").param("id", id)
                .query(Long.class).single()).isGreaterThanOrEqualTo(8);

        // the toasts carry fixed text and open the case
        JsonNode first = u.get("/notifications/desktop-feed").body();
        jdbc.sql("update notification set read_at = null where person_id = :p").param("p", user).update();
        JsonNode feed = u.get("/notifications/desktop-feed?since=0").body();
        assertThat(first.path("items").size()).isZero();
        assertThat(feed.toString()).contains("/#support/" + id).doesNotContain("لا تظهر الخريطة").doesNotContain("SUP-");
        assertThat(u.get("/notifications").body().toString()).contains("\"link\":\"#support/" + id + "\"");
    }

    @Test
    @DisplayName("SUP-2: seats: who may give and end them; /me tells the console holder")
    void seats() {
        Api u = login("suser");
        assertThat(u.post("/support/seats", Map.of("personId", other.toString(), "role", "AGENT")).status()).isEqualTo(403);
        assertThat(u.get("/me").body().path("supportSeat").isNull()).isTrue();
        Api adminApi = login("sadmin");
        seat(adminApi, user, "AGENT");
        assertThat(u.get("/me").body().path("supportSeat").asText()).isEqualTo("AGENT");
        String seatId = adminApi.get("/support/seats").body().findValuesAsText("id").stream()
                .filter(s -> jdbc.sql("select person_id from support_seat where id = cast(:s as uuid)").param("s", s).query(UUID.class).single().equals(user))
                .findFirst().orElseThrow();
        assertThat(adminApi.post("/support/seats/" + seatId + "/end", Map.of("reason", "انتقل")).status()).isEqualTo(204);
        assertThat(u.get("/support/console/cases").status()).isEqualTo(403);
    }

    @Test
    @DisplayName("KB-4: «دليل تمركز» over the API: answers with citations, filtered by what the person may do")
    void knowledge() {
        JsonNode plain = login("suser").get("/help/search?q=" + java.net.URLEncoder.encode("كيف اضيف مستخدم للوحده", java.nio.charset.StandardCharsets.UTF_8)).body();
        JsonNode admin = login("sadmin").get("/help/search?q=" + java.net.URLEncoder.encode("كيف اضيف مستخدم للوحده", java.nio.charset.StandardCharsets.UTF_8)).body();
        assertThat(admin.get(0).path("resource").asText()).isEqualTo("tmrkz://okf/how-to/add-user");
        assertThat(plain.toString()).doesNotContain("tmrkz://okf/how-to/add-user");
        assertThat(login("suser").get("/help/doc?resource=tmrkz://okf/how-to/add-user").status()).isEqualTo(404);
        JsonNode doc = login("suser").get("/help/doc?resource=tmrkz://okf/how-to/sign-in").body();
        assertThat(doc.path("body").asText()).contains("الدخول الآلي بالحساب المؤسسي");
        assertThat(login("sadmin").get("/help/status").body().path("refused").size()).isZero();
        assertThat(login("suser").get("/help/status").body().has("refused")).isFalse();
    }

    @Test
    @DisplayName("AI-3: with the model off the assistant gives no answer, only links to the guides the person may see; audited without the question")
    void assistantOff() {
        Api u = login("suser");
        assertThat(u.get("/assistant/status").body().path("enabled").asBoolean()).isFalse();
        String question = "كيف افعل اشعارات سطح المكتب " + sfx;
        Res asked = u.post("/assistant/ask", Map.of("question", question, "screen", "home"));
        assertThat(asked.status()).as(asked.toString()).isEqualTo(200);
        JsonNode a = asked.body();
        // ADR-095 «the assistant never answers from a preprogrammed template» (owner, 20 Nov 2026; 410b5f4): with the model
        // off the answer is null (mode OFF, degraded naming the reason); the matching OKF guides stay as links only
        assertThat(a.path("mode").asText()).isEqualTo("OFF");
        assertThat(a.path("degraded").asText()).isEqualTo("OFF");
        assertThat(a.path("answer").isNull() || a.path("answer").isMissingNode()).as("no prose presented as an answer").isTrue();
        assertThat(a.path("model").isNull() || a.path("model").isMissingNode()).isTrue();
        assertThat(a.path("sources").get(0).path("resource").asText()).isEqualTo("tmrkz://okf/how-to/desktop-notifications");
        JsonNode adminOnly = u.post("/assistant/ask", Map.of("question", "كيف اضيف مستخدم للوحده")).body();
        assertThat(adminOnly.toString()).doesNotContain("tmrkz://okf/how-to/add-user");
        assertThat(u.post("/assistant/ask", Map.of("question", "س".repeat(501))).status()).isEqualTo(400);
        String detail = jdbc.sql("select detail::text from audit_event where action = 'ASSISTANT_ASKED' and actor_person_id = :p order by id limit 1")
                .param("p", user).query(String.class).single();
        assertThat(detail).contains("desktop-notifications").contains("questionLength").doesNotContain(sfx);
    }
}
