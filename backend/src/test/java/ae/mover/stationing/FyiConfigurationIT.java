package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import javax.sql.DataSource;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One source for «الجهات الرئيسية للعلم» (owner brief 25 Nov 2026, item 5; V69): what the screen writes through
 * {@code /access/fyi-mains} is what a re-stationing final approval distributes to, the rows of the superseded
 * {@code fyi_designation} are carried over by the real migration, only an access manager whose scope is everything changes
 * the list, and every change is audited with who, when and the reason. Real PostgreSQL + PostGIS with OpenFGA in the loop;
 * fictional administrative units and people only.
 */
class FyiConfigurationIT extends RestationingTestBase {

    @Autowired
    DataSource dataSource;

    /** The organisation-wide list as earlier classes left it in this shared database: cleared for each test, put back after. */
    private List<Map<String, Object>> listBefore;

    @BeforeEach
    void isolateTheList() {
        listBefore = jdbc.sql("select organization_id::text as o, include_descendants as d, added_by::text as b, added_at::text as a from fyi_main_command")
                .query().listOfRows();
        jdbc.sql("delete from fyi_main_command").update();
        person("fyiAdmin", "SYSTEM_ADMIN", top);
    }

    @AfterEach
    void restoreTheList() {
        if (listBefore == null) {
            return;
        }
        jdbc.sql("delete from fyi_main_command").update();
        for (Map<String, Object> row : listBefore) {
            jdbc.sql("""
                    insert into fyi_main_command(organization_id, include_descendants, added_by, added_at)
                    values (cast(:o as uuid), :d, cast(:b as uuid), cast(:a as timestamptz))""")
                    .param("o", row.get("o")).param("d", row.get("d")).param("b", row.get("b")).param("a", row.get("a")).update();
        }
        jdbc.sql("delete from fyi_designation where unit_id in (:a, :b, :c, :d, :e, :f)")
                .param("a", top).param("b", dept).param("c", sec).param("d", team).param("e", other).param("f", otherSec).update();
    }

    @Test
    @DisplayName("V69: what «الجهات الرئيسية للعلم» writes is exactly what the re-stationing final approval informs; its members read that one request")
    void screenWriteIsWhatFinalApprovalDistributes() {
        UUID admin = personId("fyiAdmin");
        UUID reader = member("fyiReader", otherSec);
        UUID outside = member("fyiOutside", dept);

        Res set = login("fyiAdmin").put("/access/fyi-mains/" + other, Map.of("includeDescendants", true, "reason", "إبلاغ الإدارة الأخرى وما دونها"));
        assertThat(set.status()).as(set.toString()).isEqualTo(204);
        JsonNode list = login("fyiAdmin").get("/access/fyi-mains").body();
        assertThat(list).hasSize(1);
        assertThat(list.get(0).path("id").asText()).isEqualTo(other.toString());
        assertThat(list.get(0).path("includeDescendants").asBoolean()).isTrue();
        Map<String, Object> added = jdbc.sql("""
                select actor_person_id, reason, occurred_at, detail::text as detail from audit_event
                 where action = 'FYI_MAIN_COMMAND_ADDED' and entity_id = :o""").param("o", other.toString()).query().singleRow();
        assertThat(added.get("actor_person_id")).as("who").isEqualTo(admin);
        assertThat(added.get("occurred_at")).as("when").isNotNull();
        assertThat(added.get("reason")).as("why").isEqualTo("إبلاغ الإدارة الأخرى وما دونها");
        assertThat((String) added.get("detail")).contains("\"includeDescendants\": true");

        String id = approvedPermanent(List.of(team));

        assertThat(jdbc.sql("select organization_id from restationing_fyi where request_id = cast(:id as uuid) and ended_at is null")
                .param("id", id).query(UUID.class).list())
                .as("the unit chosen on the screen and, «وما دونها», its active unit below — nothing else").containsExactlyInAnyOrder(other, otherSec);
        assertThat(FyiMainCommands.effectiveUnits(jdbc)).as("the requests' FYI reads the same list through the same reader")
                .containsExactlyInAnyOrder(other, otherSec);
        assertThat(jdbc.sql("select count(*) from fyi_designation where unit_id in (:a, :b)").param("a", other).param("b", otherSec)
                .query(Long.class).single()).as("the superseded table is not written").isZero();

        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and title like 'للعلم:%' and body = :b")
                .param("p", reader).param("b", "#restationing/" + id).query(Long.class).single()).as("a member of a unit below is told once").isEqualTo(1);
        Res opened = login("fyiReader").get("/restationing-requests/" + id);
        assertThat(opened.status()).as(opened.toString()).isEqualTo(200);
        assertThat(opened.body().path("readOnlyFyi").asBoolean()).as("read only").isTrue();
        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and title like 'للعلم:%'").param("p", outside).query(Long.class).single())
                .as("a unit not on the list is told nothing").isZero();
        assertThat(login("fyiOutside").get("/restationing-requests/" + id).status()).isEqualTo(404);
        assertThat(jdbc.sql("select fyi_note from restationing_request where id = cast(:id as uuid)").param("id", id).query(String.class).single())
                .contains("الجهات الرئيسية للعلم");
        String distributed = jdbc.sql("select detail::text from audit_event where entity_id = :id and action = 'RESTATIONING_FYI_DISTRIBUTED'")
                .param("id", id).query(String.class).single();
        assertThat(distributed).contains(other.toString()).contains(otherSec.toString()).contains(reader.toString()).contains("fyi_main_command");
    }

    @Test
    @DisplayName("V69: a change and a removal are audited with who, when and why; a call that changes nothing records nothing; a removed unit is no longer informed")
    void changesAuditedAndRemovalStopsDistribution() {
        UUID admin = personId("fyiAdmin");
        UUID reader = member("fyiReader", otherSec);
        Api api = login("fyiAdmin");
        assertThat(api.put("/access/fyi-mains/" + otherSec, Map.of("includeDescendants", false, "reason", "إضافة")).status()).isEqualTo(204);
        assertThat(api.put("/access/fyi-mains/" + otherSec, Map.of("includeDescendants", true, "reason", "توسيع إلى ما دونها")).status()).isEqualTo(204);
        assertThat(api.put("/access/fyi-mains/" + otherSec, Map.of("includeDescendants", true, "reason", "تكرار")).status()).isEqualTo(204);
        assertThat(api.delete("/access/fyi-mains/" + otherSec + "?reason=" + URLEncoder.encode("لم تعد جهة رئيسية", StandardCharsets.UTF_8)).status()).isEqualTo(204);
        assertThat(api.delete("/access/fyi-mains/" + otherSec + "?reason=" + URLEncoder.encode("تكرار", StandardCharsets.UTF_8)).status()).isEqualTo(204);

        List<Map<String, Object>> trail = jdbc.sql("""
                select action, reason, actor_person_id, occurred_at from audit_event
                 where entity_type = 'ORGANIZATION' and entity_id = :o and action like 'FYI_MAIN_COMMAND_%' order by id""")
                .param("o", otherSec.toString()).query().listOfRows();
        assertThat(trail).extracting(r -> r.get("action")).as("one event per real change, none for a repeat")
                .containsExactly("FYI_MAIN_COMMAND_ADDED", "FYI_MAIN_COMMAND_CHANGED", "FYI_MAIN_COMMAND_REMOVED");
        assertThat(trail).extracting(r -> r.get("reason")).containsExactly("إضافة", "توسيع إلى ما دونها", "لم تعد جهة رئيسية");
        assertThat(trail).allSatisfy(r -> {
            assertThat(r.get("actor_person_id")).isEqualTo(admin);
            assertThat(r.get("occurred_at")).isNotNull();
        });
        assertThat(api.get("/access/fyi-mains").body()).as("the screen shows the list as it now is").isEmpty();
        assertThat(api.put("/access/fyi-mains/" + UUID.randomUUID(), Map.of("reason", "جهة غير موجودة")).status()).as("an unknown unit").isEqualTo(400);

        String id = approvedPermanent(List.of(team));
        assertThat(jdbc.sql("select count(*) from restationing_fyi where request_id = cast(:id as uuid)").param("id", id).query(Long.class).single())
                .as("removed from the screen, so no longer informed").isZero();
        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and title like 'للعلم:%'").param("p", reader).query(Long.class).single()).isZero();
        assertThat(login("fyiReader").get("/restationing-requests/" + id).status()).isEqualTo(404);
        assertThat(jdbc.sql("select fyi_note from restationing_request where id = cast(:id as uuid)").param("id", id).query(String.class).single())
                .contains("لا جهات محددة");
    }

    @Test
    @DisplayName("V69: only an access manager whose scope is everything changes the list (as before); a scoped access manager and others are refused and leave no trace")
    void unauthorisedRefused() {
        assertThat(login("fyiAdmin").put("/access/fyi-mains/" + sec, Map.of("reason", "قائمة البداية")).status()).isEqualTo(204);
        UUID scoped = person("fyiScopedMgr", role("FYIMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW"), sec);
        UUID plain = personId("req");
        UUID config = personId("sysadmin");
        for (String who : List.of("fyiScopedMgr", "req", "sysadmin")) {
            Api api = login(who);
            assertThat(api.put("/access/fyi-mains/" + team, Map.of("includeDescendants", true, "reason", "محاولة")).status()).as(who + " adds").isEqualTo(403);
            assertThat(api.put("/access/fyi-mains/" + sec, Map.of("includeDescendants", true, "reason", "محاولة")).status()).as(who + " changes").isEqualTo(403);
            assertThat(api.delete("/access/fyi-mains/" + sec + "?reason=x").status()).as(who + " removes").isEqualTo(403);
        }
        assertThat(login("req").get("/access/fyi-mains").status()).as("no access-management right: not even the list").isEqualTo(403);
        assertThat(jdbc.sql("select organization_id::text || ':' || include_descendants from fyi_main_command").query(String.class).list())
                .as("the list is as the global manager left it").containsExactly(sec + ":false");
        assertThat(jdbc.sql("select count(*) from audit_event where action like 'FYI_MAIN_COMMAND_%' and actor_person_id in (:a, :b, :c)")
                .param("a", scoped).param("b", plain).param("c", config).query(Long.class).single()).as("nothing recorded for them").isZero();
    }

    @Test
    @DisplayName("V69 migration: every fyi_designation row reaches the one list (union, «وما دونها» kept, authors and times kept), audited once; run again it changes nothing")
    void existingRowsMigrated() throws Exception {
        UUID admin = personId("fyiAdmin");
        UUID earlier = personId("sysadmin");
        designation(dept, false, admin, "2026-03-01T08:00:00Z");
        designation(sec, false, admin, "2026-03-02T08:00:00Z");
        designation(sec, true, earlier, "2026-03-03T08:00:00Z");
        designation(other, true, admin, "2026-03-04T08:00:00Z");
        designation(team, false, null, "2026-03-05T08:00:00Z");
        designation(top, false, admin, "2026-03-06T08:00:00Z");
        mainCommand(other, false, earlier, "2026-02-01T08:00:00Z");
        mainCommand(otherSec, true, earlier, "2026-02-02T08:00:00Z");
        mainCommand(top, true, earlier, "2026-02-03T08:00:00Z");

        runV69();

        Map<UUID, Map<String, Object>> rows = mainCommands();
        assertThat(rows.keySet()).as("a unit in either list stays").containsExactlyInAnyOrder(dept, sec, other, team, otherSec, top);
        assertThat(rows.get(dept)).containsEntry("d", false).containsEntry("b", admin.toString());
        assertThat(rows.get(dept).get("a").toString()).startsWith("2026-03-01 08:00:00");
        assertThat(rows.get(sec)).as("two rows of one unit: one, «وما دونها» kept, first author").containsEntry("d", true).containsEntry("b", admin.toString());
        assertThat(rows.get(other)).as("already chosen: «وما دونها» added, the original author kept").containsEntry("d", true).containsEntry("b", earlier.toString());
        assertThat(rows.get(other).get("a").toString()).startsWith("2026-02-01 08:00:00");
        assertThat(rows.get(team)).as("no recorded author stays unrecorded").containsEntry("d", false).containsEntry("b", null);
        assertThat(rows.get(otherSec)).as("only on the screen: untouched").containsEntry("d", true).containsEntry("b", earlier.toString());
        assertThat(rows.get(top)).as("never narrowed").containsEntry("d", true).containsEntry("b", earlier.toString());
        assertThat(jdbc.sql("select count(*) from fyi_designation where unit_id in (:a, :b, :c, :d, :e)").param("a", dept).param("b", sec)
                .param("c", other).param("d", team).param("e", top).query(Long.class).single()).as("the old rows are kept for history").isEqualTo(6);
        String merged = jdbc.sql("select detail::text from audit_event where action = 'FYI_MAIN_COMMAND_MERGED' and detail::text like :u")
                .param("u", "%" + dept + "%").query(String.class).single();
        assertThat(merged).contains(sec.toString()).contains(other.toString()).contains(team.toString()).contains("INCLUDE_DESCENDANTS")
                .doesNotContain(otherSec.toString()).doesNotContain(top.toString());

        runV69();

        assertThat(mainCommands()).as("idempotent: the same rows").isEqualTo(rows);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'FYI_MAIN_COMMAND_MERGED' and detail::text like :u")
                .param("u", "%" + dept + "%").query(Long.class).single()).as("and nothing recorded again").isEqualTo(1);
        assertThat(login("fyiAdmin").get("/access/fyi-mains").body()).as("the screen shows the migrated list").hasSize(6);
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    /** A person in the unit (HR affiliation) holding an unrelated summary right, as the FYI recipients of StationingNextIT. */
    private UUID member(String username, UUID unit) {
        UUID p = person(username, role("FYIVS" + username, "ORGANIZATION", "VIEW_SUMMARY"), unit);
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (gen_random_uuid(), :p, :o, now() - interval '1 day')")
                .param("p", p).param("o", unit).update();
        return p;
    }

    private void designation(UUID unit, boolean below, UUID by, String at) {
        jdbc.sql("insert into fyi_designation(unit_id, include_descendants, set_by, set_at) values (:u, :d, cast(:b as uuid), cast(:a as timestamptz))")
                .param("u", unit).param("d", below).param("b", by == null ? null : by.toString()).param("a", at).update();
    }

    private void mainCommand(UUID unit, boolean below, UUID by, String at) {
        jdbc.sql("insert into fyi_main_command(organization_id, include_descendants, added_by, added_at) values (:u, :d, :b, cast(:a as timestamptz))")
                .param("u", unit).param("d", below).param("b", by).param("a", at).update();
    }

    private Map<UUID, Map<String, Object>> mainCommands() {
        Map<UUID, Map<String, Object>> out = new java.util.HashMap<>();
        jdbc.sql("select organization_id, include_descendants as d, added_by::text as b, (added_at at time zone 'UTC')::text as a from fyi_main_command")
                .query().listOfRows().forEach(r -> {
                    Map<String, Object> v = new java.util.HashMap<>(r);
                    out.put((UUID) v.remove("organization_id"), v);
                });
        return out;
    }

    /** The real V69 file, executed as Flyway executed it at start-up (on an empty table there). */
    private void runV69() throws Exception {
        String sql = new String(new ClassPathResource("db/migration/V69__fyi_one_source_main_command.sql").getInputStream().readAllBytes(),
                StandardCharsets.UTF_8);
        try (Connection c = dataSource.getConnection(); Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }
}
