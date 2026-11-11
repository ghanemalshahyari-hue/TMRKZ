package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/** Desktop notifications as in TNQL (owner, 11 Nov 2026; ADR-050, V34): the polled feed behind the Windows toasts. */
class DesktopFeedIT extends IntegrationTest {

    private UUID note(UUID person, String kind, String title, String body, boolean read) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into notification(id, person_id, kind, title, body, created_at, read_at)
                values (:id, :p, :k, :t, :b, now(), case when :r then now() end)""")
                .param("id", id).param("p", person).param("k", kind).param("t", title).param("b", body).param("r", read).update();
        return id;
    }

    @Test
    @DisplayName("DN-1: the first call replays nothing; then new unread items come oldest first, five at a time, with safe text")
    void feed() {
        UUID root = org("ROOT", null);
        UUID me = person("dn", "SYSTEM_ADMIN", root);
        UUID other = person("dnother", "SYSTEM_ADMIN", root);
        note(me, "REQUEST_APPROVED", "اعتُمد الطلب RQ-OLD", "قديم", false);
        Api a = login("dn");
        JsonNode first = a.get("/notifications/desktop-feed").body();
        assertThat(first.path("personId").asText()).isEqualTo(me.toString());
        assertThat(first.path("items").size()).as("nothing old is replayed").isZero();
        long cursor = first.path("latestSeq").asLong();
        assertThat(cursor).isPositive();

        String restationing = UUID.randomUUID().toString();
        List<String> kinds = List.of("TASK_ASSIGNED", "REQUEST_RETURNED", "REQUEST_APPROVED", "INFO_COPY", "FLOW_NOTICE", "TASK_OVERDUE");
        for (String k : kinds) {
            note(me, k, "عنوان فيه الرقم RQ-SECRET-" + k, "INFO_COPY".equals(k) ? "#restationing/" + restationing + " — ملاحظة" : "نص سري", false);
        }
        note(me, "REQUEST_REJECTED", "مقروء", "مقروء", true);
        note(other, "TASK_ASSIGNED", "لغيري", "لغيري", false);

        JsonNode page = a.get("/notifications/desktop-feed?since=" + cursor).body();
        assertThat(page.path("items").size()).isEqualTo(5);
        List<String> got = new ArrayList<>();
        page.path("items").forEach(i -> got.add(i.path("kind").asText()));
        assertThat(got).containsExactlyElementsOf(kinds.subList(0, 5));
        assertThat(page.toString()).as("no request number or text on a lock screen").doesNotContain("RQ-SECRET").doesNotContain("نص سري")
                .doesNotContain("ملاحظة");
        JsonNode assigned = page.path("items").get(0);
        assertThat(assigned.path("title").asText()).isEqualTo("تمركز — إشعار جديد");
        assertThat(assigned.path("body").asText()).isEqualTo("تمركز — لديك إجراء مطلوب. افتح المنصة لعرض التفاصيل.");
        assertThat(assigned.path("requireInteraction").asBoolean()).isTrue();
        assertThat(page.path("items").get(2).path("requireInteraction").asBoolean()).as("a decision is informative").isFalse();
        assertThat(page.path("items").get(3).path("url").asText()).isEqualTo("/#restationing/" + restationing);
        long next = page.path("latestSeq").asLong();
        assertThat(next).isEqualTo(page.path("items").get(4).path("seq").asLong());

        JsonNode rest = a.get("/notifications/desktop-feed?since=" + next).body();
        assertThat(rest.path("items").size()).as("the sixth; the read one and another person's never").isEqualTo(1);
        assertThat(rest.path("items").get(0).path("kind").asText()).isEqualTo("TASK_OVERDUE");
        JsonNode done = a.get("/notifications/desktop-feed?since=" + rest.path("latestSeq").asLong()).body();
        assertThat(done.path("items").size()).isZero();
        assertThat(done.path("latestSeq").asLong()).as("past the read one too").isGreaterThanOrEqualTo(rest.path("latestSeq").asLong());
    }
}
