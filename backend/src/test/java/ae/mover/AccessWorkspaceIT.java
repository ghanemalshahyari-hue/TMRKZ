package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * «إدارة الصلاحيات والوحدات», TNQL's access workspace (owner, 11 Nov 2026; ADR-058): reach-bound search and counts, the cell
 * states of the matrix, roles given to a whole unit, the staged save with its fingerprint and one audit reference, and final
 * approval reserved to a global access manager.
 */
class AccessWorkspaceIT extends IntegrationTest {

    UUID root, orgA, orgA1, orgB, admin, mgr, hrA1, hrA2, hrB;
    String viewer, requester, other, mgrRole;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgA1 = org("A1", orgA);
        orgB = org("B", root);
        viewer = role("WVIEW", "ORGANIZATION", "VIEW");
        requester = role("WREQ", "ORGANIZATION", "CREATE", "VIEW");
        other = role("WOTHER", "ORGANIZATION", "VIEW", "EXPORT");
        mgrRole = role("WMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        jdbc.sql("update role_def set grantable_roles = string_to_array(:g, ',') where code = :c")
                .param("g", viewer + "," + requester + ",FINAL_APPROVER").param("c", mgrRole).update();
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order)
                values ('FINAL_APPROVER', 'الاعتماد النهائي', '{VIEW,REVIEW,APPROVE}', 'ORGANIZATION', false, 3) on conflict (code) do nothing""").update();
        admin = person("admin", "SYSTEM_ADMIN", root);
        mgr = person("mgr", mgrRole, orgA);
        hrA1 = hrPerson("hra1", orgA1);
        hrA2 = hrPerson("hra2", orgA1);
        hrB = hrPerson("hrb", orgB);
    }

    private UUID hrPerson(String code, UUID org) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into person(id, employee_no, display_name, username, source, source_external_id)
                values (:id, :e, :n, :u, 'HR', :x)""")
                .param("id", id).param("e", "E-" + code + "-" + sfx).param("n", "موظف " + code).param("u", code + "-" + sfx)
                .param("x", "X-" + code + "-" + sfx).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, position_title, valid_from) values (:id, :p, :o, 'وظيفة', '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("p", id).param("o", org).update();
        return id;
    }

    private static Map<String, Object> op(UUID person, String role, String action) {
        return Map.of("personId", person.toString(), "roleCode", role, "action", action);
    }

    private Res preview(Api a, UUID org, List<Map<String, Object>> ops) {
        return a.post("/access/workspace/units/" + org + "/preview", Map.of("ops", ops));
    }

    private Res apply(Api a, UUID org, List<Map<String, Object>> ops, String fingerprint) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ops", ops);
        body.put("fingerprint", fingerprint);
        return a.post("/access/workspace/units/" + org + "/apply", body);
    }

    private long active(UUID person, UUID org, String role) {
        return jdbc.sql("""
                select count(*) from membership where person_id = :p and organization_id = :o and role_code = :r
                  and valid_from <= now() and (valid_to is null or valid_to > now())""")
                .param("p", person).param("o", org).param("r", role).query(Long.class).single();
    }

    private JsonNode row(JsonNode matrix, UUID person) {
        for (JsonNode p : matrix.path("people")) {
            if (p.path("id").asText().equals(person.toString())) {
                return p;
            }
        }
        return null;
    }

    private JsonNode column(JsonNode matrix, String code) {
        for (JsonNode c : matrix.path("columns")) {
            if (c.path("code").asText().equals(code)) {
                return c;
            }
        }
        return null;
    }

    @Test
    @DisplayName("AW-1: counts, the unit tree and search stay inside the manager's reach; each result has its path")
    void reachBound() {
        Api m = login("mgr");
        JsonNode summary = m.get("/access/workspace/summary").body();
        assertThat(summary.path("units").asLong()).as("A and A1").isEqualTo(2);
        assertThat(summary.path("people").asLong()).isEqualTo(2);
        assertThat(summary.path("pageSize").asInt()).isEqualTo(25);
        JsonNode top = m.get("/access/workspace/tree").body();
        assertThat(top).hasSize(1);
        assertThat(top.get(0).path("id").asText()).isEqualTo(orgA.toString());
        assertThat(top.get(0).path("childCount").asInt()).isEqualTo(1);
        JsonNode kids = m.get("/access/workspace/tree?parent=" + orgA).body();
        assertThat(kids.get(0).path("peopleCount").asInt()).isEqualTo(2);
        assertThat(m.get("/access/workspace/tree?parent=" + orgB).status()).as("outside the reach").isEqualTo(404);
        JsonNode units = m.get("/access/workspace/search?kind=UNITS&q=A1-" + sfx).body();
        assertThat(units).hasSize(1);
        assertThat(units.get(0).path("path").asText()).isEqualTo("جهة ROOT / جهة A / جهة A1");
        assertThat(m.get("/access/workspace/search?kind=UNITS&q=B-" + sfx).body()).isEmpty();
        assertThat(m.get("/access/workspace/search?kind=PEOPLE&q=hrb-" + sfx).body()).as("a person outside the reach").isEmpty();
        JsonNode found = m.get("/access/workspace/search?kind=PEOPLE&q=hra1-" + sfx).body();
        assertThat(found.get(0).path("unit").path("id").asText()).isEqualTo(orgA1.toString());
        JsonNode file = m.get("/access/workspace/units/" + orgA1).body();
        assertThat(file.path("parent").path("name").asText()).isEqualTo("جهة A");
        assertThat(file.path("people").asLong()).isEqualTo(2);
    }

    @Test
    @DisplayName("AW-2: the staged save is reviewed, then applied together under one audit reference; a changed cell refuses it; one refusal saves nothing")
    void stagedBatch() {
        Api m = login("mgr");
        List<Map<String, Object>> ops = List.of(op(hrA1, viewer, "GRANT"), op(hrA2, viewer, "GRANT"));
        Res review = preview(m, orgA1, ops);
        assertThat(review.status()).as(String.valueOf(review.body())).isEqualTo(200);
        assertThat(review.body().path("ok").asBoolean()).isTrue();
        assertThat(review.body().path("grants").asInt()).isEqualTo(2);
        assertThat(review.body().path("wholeUnit").asBoolean()).as("both members of the unit").isTrue();
        Res unconfirmed = apply(m, orgA1, ops, review.body().path("fingerprint").asText());
        assertThat(unconfirmed.status()).as("a change reaching the whole unit is confirmed explicitly").isEqualTo(400);
        assertThat(String.valueOf(unconfirmed.body())).contains("كل مستخدمي الوحدة");
        Map<String, Object> confirmed = new LinkedHashMap<>();
        confirmed.put("ops", ops);
        confirmed.put("fingerprint", review.body().path("fingerprint").asText());
        confirmed.put("wholeUnit", true);
        Res saved = m.post("/access/workspace/units/" + orgA1 + "/apply", confirmed);
        assertThat(saved.status()).as(String.valueOf(saved.body())).isEqualTo(200);
        String ref = saved.body().path("reference").asText();
        assertThat(ref).hasSize(12);
        assertThat(saved.body().path("affected").asInt()).isEqualTo(2);
        assertThat(active(hrA1, orgA1, viewer) + active(hrA2, orgA1, viewer)).isEqualTo(2);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'MEMBERSHIP_CREATED' and detail->>'batch' = :r").param("r", ref)
                .query(Long.class).single()).as("each grant carries the batch's reference").isEqualTo(2);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'ACCESS_BATCH_SAVED' and detail->>'reference' = :r").param("r", ref)
                .query(Long.class).single()).isEqualTo(1);
        JsonNode history = m.get("/access/workspace/units/" + orgA1 + "/history").body();
        assertThat(history.path("rows").toString()).contains(ref);

        // the same cells change after the review: the save is refused and nothing is ended
        List<Map<String, Object>> revoke = List.of(op(hrA1, viewer, "REVOKE"), op(hrA2, viewer, "REVOKE"));
        String fp = preview(m, orgA1, revoke).body().path("fingerprint").asText();
        jdbc.sql("update membership set valid_to = now() where person_id = :p and role_code = :r").param("p", hrA1).param("r", viewer).update();
        Res stale = apply(m, orgA1, revoke, fp);
        assertThat(stale.status()).isEqualTo(409);
        assertThat(active(hrA2, orgA1, viewer)).isEqualTo(1);

        // one refused change (a person outside the reach) and the batch saves nothing
        List<Map<String, Object>> mixed = List.of(op(hrA1, viewer, "GRANT"), op(hrB, viewer, "GRANT"));
        Res mixedReview = preview(m, orgA1, mixed);
        assertThat(mixedReview.body().path("ok").asBoolean()).isFalse();
        assertThat(apply(m, orgA1, mixed, mixedReview.body().path("fingerprint").asText()).status()).isEqualTo(400);
        assertThat(active(hrA1, orgA1, viewer)).isZero();
        assertThat(active(hrB, orgA1, viewer)).isZero();
    }

    @Test
    @DisplayName("AW-3: cells say direct, inherited from the unit, temporary or locked; a role given to the unit reaches every member")
    void cellStates() {
        Api m = login("mgr");
        Res given = m.put("/access/workspace/units/" + orgA1 + "/inherited", Map.of("roleCode", requester, "on", true));
        assertThat(given.status()).as(String.valueOf(given.body())).isEqualTo(200);
        assertThat(given.body().path("inherited").toString()).contains(requester);
        assertThat(m.put("/access/workspace/units/" + orgA1 + "/inherited", Map.of("roleCode", mgrRole, "on", true)).status())
                .as("a role that manages or decides is never given to a whole unit").isEqualTo(400);
        assertThat(login("hra1").get("/me").body().path("grants").toString()).as("the member holds it").contains(requester);
        assertThat(login("hrb").get("/me").body().path("grants").toString()).doesNotContain(requester);

        Map<String, Object> temp = new LinkedHashMap<>();
        temp.put("personId", hrA2.toString());
        temp.put("organizationId", orgA1.toString());
        temp.put("roleCode", viewer);
        temp.put("validTo", Instant.now().plus(7, ChronoUnit.DAYS).toString());
        assertThat(m.post("/memberships", temp).status()).isEqualTo(200);

        JsonNode matrix = m.get("/access/workspace/units/" + orgA1 + "/matrix").body();
        assertThat(row(matrix, hrA1).path("cells").path(requester).path("inherited").asText()).isEqualTo("UNIT");
        JsonNode t = row(matrix, hrA2).path("cells").path(viewer);
        assertThat(t.path("direct").isNull()).isFalse();
        assertThat(t.path("temporary").asBoolean()).isTrue();
        assertThat(column(matrix, other).path("lock").isNull()).as("a role the manager may not give is locked").isFalse();
        assertThat(column(matrix, viewer).path("lock").isNull()).isTrue();
        JsonNode own = m.get("/access/workspace/units/" + orgA + "/matrix").body();
        assertThat(row(own, mgr).path("lock").isNull()).as("one's own row").isFalse();
        assertThat(login("admin").get("/access/workspace/units/" + orgA1 + "/matrix").body().path("columns").toString()).contains(other);

        Res off = m.put("/access/workspace/units/" + orgA1 + "/inherited", Map.of("roleCode", requester, "on", false, "reason", "انتهت الحاجة"));
        assertThat(off.status()).isEqualTo(200);
        assertThat(login("hra1").get("/me").body().path("grants").toString()).doesNotContain(requester);
    }

    @Test
    @DisplayName("AW-4: final approval is given and taken by a global access manager only, even when a scoped role lists it")
    void finalIsGlobal() {
        Map<String, Object> fin = new LinkedHashMap<>();
        fin.put("personId", hrA1.toString());
        fin.put("organizationId", orgA1.toString());
        fin.put("roleCode", "FINAL_APPROVER");
        Res refused = login("mgr").post("/memberships", fin);
        assertThat(refused.status()).isEqualTo(403);
        assertThat(String.valueOf(refused.body())).contains("مدير الصلاحيات العام");
        assertThat(column(login("mgr").get("/access/workspace/units/" + orgA1 + "/matrix").body(), "FINAL_APPROVER").path("lock").asText())
                .contains("العام");
        assertThat(login("admin").post("/memberships", fin).status()).isEqualTo(200);
    }
}
