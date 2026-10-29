package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.hr.HrConnectionFactory;
import ae.mover.hr.HrSourceAdapter;
import ae.mover.hr.HrSyncService;

/**
 * HR mirror acceptance (PA-01…PA-06, PA-09). The production adapter, sync and projection run against fictional views in a
 * throw-away schema read through a login role that holds SELECT on the views only — the shape of the read-only Oracle
 * account. Only the connection is substituted (same SQL: SET TRANSACTION READ ONLY, SELECT … WHERE 1 = 0, SELECT cols).
 * Connecting to the enterprise Oracle itself is an integration step that needs its address and account.
 */
@Import(HrSyncAcceptanceIT.SourceConnections.class)
class HrSyncAcceptanceIT extends IntegrationTest {

    @TestConfiguration
    static class SourceConnections {
        @Bean
        @Primary
        HrConnectionFactory testSourceConnections(@Value("${spring.datasource.url}") String url) {
            return new HrConnectionFactory() {
                @Override
                public Connection connect(HrSourceAdapter.Config cfg) throws SQLException {
                    return DriverManager.getConnection(url, cfg.username(), cfg.password());
                }
            };
        }
    }

    @Autowired
    HrSyncService sync;
    @Autowired
    HrSourceAdapter adapter;

    String schema;
    String reader;
    UUID root;
    Api admin;

    @BeforeEach
    void source() {
        // One HR source exists per installation: earlier tests' source and snapshots are cleared, never their projections.
        jdbc.sql("delete from hr_sync_issue").update();
        jdbc.sql("delete from hr_unit").update();
        jdbc.sql("delete from hr_person").update();
        jdbc.sql("delete from hr_snapshot").update();
        jdbc.sql("delete from hr_sync_run").update();
        jdbc.sql("delete from hr_mapping_version").update();
        jdbc.sql("delete from hr_source").update();
        schema = "hrsrc_" + sfx;
        reader = "hr_reader_" + sfx;
        exec("create schema " + schema,
                "create table " + schema + ".units_t (id text, name text, parent_id text, status int, code text)",
                "create table " + schema + ".people_t (person_id text, emp_no text, full_name text, unit_id text, status_desc text,"
                        + " account text, position_id text, position_name text, mobile text)",
                "create view " + schema + ".units_v as select * from " + schema + ".units_t",
                "create view " + schema + ".people_v as select * from " + schema + ".people_t",
                "create role " + reader + " login password 'Reader#" + sfx + "'",
                "grant usage on schema " + schema + " to " + reader,
                "grant select on " + schema + ".units_v, " + schema + ".people_v to " + reader);
        root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
    }

    // ---- fixtures -------------------------------------------------------------------------------------------

    private void exec(String... sql) {
        jdbc.sql("select 1").query().singleRow();
        for (String s : sql) {
            jdbc.sql(s).update();
        }
    }

    /** Replaces a source view (column names may change) and grants it to the read-only account again. */
    private void view(String name, String select) {
        exec("drop view " + schema + "." + name, "create view " + schema + "." + name + " as " + select,
                "grant select on " + schema + "." + name + " to " + reader);
    }

    private String u(String id) {
        return "U" + sfx + "-" + id;
    }

    private String p(String id) {
        return "P" + sfx + "-" + id;
    }

    private void unit(String id, String name, String parent, int status) {
        jdbc.sql("insert into " + schema + ".units_t values (:i, :n, :p, :s, :c)")
                .param("i", u(id)).param("n", name).param("p", parent == null ? null : u(parent)).param("s", status)
                .param("c", "C" + id).update();
    }

    private void personRow(String id, String name, String unitId, String status, String position) {
        jdbc.sql("insert into " + schema + ".people_t values (:i, :e, :n, :u, :s, :a, :pos, :pn, '0500000000')")
                .param("i", p(id)).param("e", "N" + sfx + "-" + id).param("n", name).param("u", u(unitId)).param("s", status)
                .param("a", "acct" + id).param("pos", position).param("pn", position == null ? null : "منصب " + position).update();
    }

    /** Ten units in two levels and twenty people, all fictional. */
    private void standardSource() {
        unit("1", "الجهة الرئيسية", null, 1);
        for (int i = 2; i <= 10; i++) {
            unit(String.valueOf(i), "إدارة " + i, "1", 1);
        }
        for (int i = 1; i <= 20; i++) {
            personRow(String.valueOf(i), "موظف " + i, String.valueOf(2 + i % 9), "في الخدمة", "POS" + i);
        }
    }

    private static Map<String, Object> field(String entity, String field, String column) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("entity", entity);
        f.put("field", field);
        f.put("column", column);
        f.put("transform", "none");
        f.put("enabled", true);
        return f;
    }

    private List<Map<String, Object>> fields() {
        List<Map<String, Object>> f = new ArrayList<>();
        f.add(field("UNIT", "external_unit_id", "ID"));
        f.add(field("UNIT", "name", "NAME"));
        f.add(field("UNIT", "parent_external_unit_id", "PARENT_ID"));
        f.add(field("UNIT", "status", "STATUS"));
        f.add(field("UNIT", "code", "CODE"));
        f.add(field("PERSON", "external_person_id", "PERSON_ID"));
        f.add(field("PERSON", "employee_number", "EMP_NO"));
        f.add(field("PERSON", "full_name", "FULL_NAME"));
        f.add(field("PERSON", "unit_external_id", "UNIT_ID"));
        f.add(field("PERSON", "status_text", "STATUS_DESC"));
        f.add(field("PERSON", "domain_account", "ACCOUNT"));
        f.add(field("PERSON", "position_id", "POSITION_ID"));
        f.add(field("PERSON", "position", "POSITION_NAME"));
        return f;
    }

    private static Map<String, Object> rules() {
        return Map.of("UNIT", Map.of("column", "STATUS", "operator", "EQUALS", "values", List.of("1")),
                "PERSON", Map.of("column", "STATUS_DESC", "operator", "EQUALS", "values", List.of("في الخدمة")));
    }

    /** Configures the source through the API (password encrypted with TMRKZ's key), then drafts, discovers, publishes. */
    private void configure(List<Map<String, Object>> fields) {
        Map<String, Object> src = new LinkedHashMap<>();
        src.put("name", "مصدر الموارد البشرية");
        src.put("enabled", true);
        src.put("hostOrUrl", "hr-db.example.internal");
        src.put("port", 1521);
        src.put("serverName", "HRSVC");
        src.put("nameType", "service_name");
        src.put("username", reader);
        src.put("password", "Reader#" + sfx);
        src.put("unitView", schema + ".units_v");
        src.put("personView", schema + ".people_v");
        Res saved = admin.put("/hr/source", src);
        assertThat(saved.status()).as(saved.toString()).isEqualTo(200);
        assertThat(saved.body().has("password")).isFalse();
        assertThat(saved.body().path("passwordSet").asBoolean()).isTrue();
        String stored = jdbc.sql("select settings_ciphertext from hr_source").query(String.class).single();
        assertThat(stored).startsWith("v1:").doesNotContain("Reader#");
        Res draft = admin.post("/hr/mappings/draft", Map.of("fields", fields, "activeRules", rules()));
        assertThat(draft.status()).as(draft.toString()).isEqualTo(200);
        String id = draft.body().path("id").asText();
        assertThat(admin.post("/hr/mappings/" + id + "/discover", Map.of()).status()).isEqualTo(200);
        Res pub = admin.post("/hr/mappings/" + id + "/publish", Map.of());
        assertThat(pub.status()).as(pub.toString()).isEqualTo(200);
    }

    private JsonNode run(String trigger, String override) {
        UUID id = sync.run(trigger, null, override);
        return JSON.valueToTree(jdbc.sql("select status, error_code, counts::text as counts from hr_sync_run where id = :id")
                .param("id", id).query().singleRow());
    }

    private String status(JsonNode run) {
        return run.path("status").asText();
    }

    private UUID orgOf(String unitId) {
        return jdbc.sql("select id from organization where source = 'HR' and source_external_id = :x").param("x", u(unitId))
                .query(UUID.class).single();
    }

    private UUID personOf(String id) {
        return jdbc.sql("select id from person where source = 'HR' and source_external_id = :x").param("x", p(id))
                .query(UUID.class).single();
    }

    // ---- tests ----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("PA-01: the HR views are read through the published contract in a read-only transaction; no DML or DDL")
    void readOnlyContract() throws Exception {
        standardSource();
        configure(fields());
        JsonNode r = run("SCHEDULED", null);
        assertThat(status(r)).as(r.toString()).isEqualTo("SUCCEEDED");
        JsonNode counts = JSON.readTree(r.path("counts").asText());
        assertThat(counts.path("units").asInt()).isEqualTo(10);
        assertThat(counts.path("people").asInt()).isEqualTo(20);
        assertThat(counts.path("organizationsCreated").asInt()).isEqualTo(10);
        assertThat(counts.path("peopleCreated").asInt()).isEqualTo(20);
        // The tree is projected from source identifiers; unmapped columns (here: a phone number) are never read.
        assertThat(jdbc.sql("select parent_id from organization where id = :id").param("id", orgOf("5")).query(UUID.class).single())
                .isEqualTo(orgOf("1"));
        assertThat(jdbc.sql("select count(*) from hr_person where external_id like :x").param("x", "P" + sfx + "%").query(Long.class).single())
                .isEqualTo(20);

        // The adapter issues only the read-only transaction statement and SELECTs.
        HrSourceAdapter.Config cfg = new HrSourceAdapter.Config("hr-db.example.internal", 1521, "HRSVC", "service_name", reader,
                "Reader#" + sfx, schema + ".units_v", schema + ".people_v", 10, 30000);
        try (HrSourceAdapter.Session s = adapter.open(cfg)) {
            s.columns(cfg.unitView());
            s.stream(cfg.personView(), List.of("person_id", "full_name"), 100, 10, rows -> { });
            assertThat(s.statements()).allMatch(sql -> sql.equals("SET TRANSACTION READ ONLY") || sql.startsWith("SELECT "));
        }
        // The source account cannot write even if asked to: its session is read-only and it holds SELECT only.
        try (Connection c = DriverManager.getConnection(jdbcUrl(), reader, "Reader#" + sfx); Statement st = c.createStatement()) {
            assertThatThrownBy(() -> st.executeUpdate("insert into " + schema + ".units_t values ('x','x',null,1,'x')"))
                    .isInstanceOf(SQLException.class);
        }
        assertThat(jdbc.sql("select has_table_privilege(:r, :t, 'INSERT')").param("r", reader).param("t", schema + ".units_t")
                .query(Boolean.class).single()).isFalse();
    }

    @Value("${spring.datasource.url}")
    String datasourceUrl;

    private String jdbcUrl() {
        return datasourceUrl;
    }

    @Test
    @DisplayName("PA-02: a mapping that does not fit the view metadata is refused without guessing and the mirror is untouched")
    void contractMismatch() {
        standardSource();
        List<Map<String, Object>> wrong = fields();
        wrong.set(1, field("UNIT", "name", "UNIT_TITLE"));
        Res draft = admin.post("/hr/mappings/draft", Map.of("fields", wrong, "activeRules", rules()));
        assertThat(draft.status()).isEqualTo(409); // no source yet
        configure(fields());
        assertThat(status(run("SCHEDULED", null))).isEqualTo("SUCCEEDED");
        String before = jdbc.sql("select name from organization where id = :id").param("id", orgOf("3")).query(String.class).single();

        Res d2 = admin.post("/hr/mappings/draft", Map.of("fields", wrong, "activeRules", rules()));
        String id = d2.body().path("id").asText();
        admin.post("/hr/mappings/" + id + "/discover", Map.of());
        Res pub = admin.post("/hr/mappings/" + id + "/publish", Map.of());
        assertThat(pub.status()).isEqualTo(409);
        assertThat(pub.code()).isEqualTo("HR_CONTRACT_MISMATCH");

        // The source drops a column the published mapping needs: the run is rejected and nothing changes.
        view("units_v", "select id, parent_id, status, code, name as title from " + schema + ".units_t");
        jdbc.sql("update " + schema + ".units_t set name = 'اسم جديد' where id = :i").param("i", u("3")).update();
        JsonNode r = run("SCHEDULED", null);
        assertThat(status(r)).isEqualTo("REJECTED");
        assertThat(r.path("error_code").asText()).isEqualTo("HR_CONTRACT_MISMATCH");
        assertThat(jdbc.sql("select name from organization where id = :id").param("id", orgOf("3")).query(String.class).single())
                .isEqualTo(before);
        assertThat(jdbc.sql("select count(*) from hr_snapshot where status = 'STAGING'").query(Long.class).single()).isZero();
    }

    @Test
    @DisplayName("PA-03: after a full sync, a failing, empty or sharply smaller source keeps the last valid copy")
    void protections() {
        standardSource();
        configure(fields());
        assertThat(status(run("SCHEDULED", null))).isEqualTo("SUCCEEDED");
        UUID published = jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).single();

        // Failure part-way through reading: a row the view cannot produce.
        view("people_v", "select person_id, emp_no,"
                + " case when person_id = '" + p("15") + "' then (1 / 0)::text else full_name end as full_name,"
                + " unit_id, status_desc, account, position_id, position_name, mobile from " + schema + ".people_t");
        JsonNode failed = run("SCHEDULED", null);
        assertThat(status(failed)).isEqualTo("FAILED");
        assertThat(failed.path("error_code").asText()).startsWith("SOURCE_");
        view("people_v", "select * from " + schema + ".people_t");

        // Empty source: always refused, even with a reason.
        exec("delete from " + schema + ".people_t");
        JsonNode empty = run("MANUAL", "تحديث مقصود بعد إعادة هيكلة الجهات");
        assertThat(status(empty)).isEqualTo("REJECTED");
        assertThat(empty.path("error_code").asText()).isEqualTo("EMPTY_SOURCE");

        // Half the people gone: refused unless an authorised manual run explains it.
        for (int i = 1; i <= 10; i++) {
            personRow(String.valueOf(i), "موظف " + i, String.valueOf(2 + i % 9), "في الخدمة", "POS" + i);
        }
        JsonNode drop = run("SCHEDULED", null);
        assertThat(status(drop)).isEqualTo("REJECTED");
        assertThat(drop.path("error_code").asText()).isEqualTo("LARGE_DROP");
        assertThat(jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).single()).isEqualTo(published);
        assertThat(jdbc.sql("select status from person where id = :id").param("id", personOf("15")).query(String.class).single())
                .isEqualTo("ACTIVE");

        JsonNode override = run("MANUAL", "نقل عشرة موظفين إلى جهة خارج نطاق المصدر بقرار إداري");
        assertThat(status(override)).as(override.toString()).isEqualTo("SUCCEEDED");
        assertThat(jdbc.sql("select status from person where id = :id").param("id", personOf("15")).query(String.class).single())
                .isEqualTo("DISABLED");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'HR_SYNC_OVERRIDE_USED'").query(Long.class).single()).isPositive();
        assertThat(jdbc.sql("select count(*) from hr_sync_run where status = 'FAILED' and error_message like '%موظف%'").query(Long.class).single())
                .as("failure records never contain source rows").isZero();
    }

    @Test
    @DisplayName("PA-04: one run at a time across instances, safe recovery after a stopped worker, hourly schedule")
    void noOverlap() throws Exception {
        standardSource();
        configure(fields());
        try (Connection other = DriverManager.getConnection(jdbcUrl(), System.getenv().getOrDefault("MOVER_TEST_DB_USER", "mover"),
                System.getenv().getOrDefault("MOVER_TEST_DB_PASSWORD", "devpass")); Statement st = other.createStatement()) {
            st.execute("select pg_advisory_lock(" + 0x544D524B5A4852L + ")");
            JsonNode skipped = run("SCHEDULED", null);
            assertThat(status(skipped)).isEqualTo("SKIPPED");
            assertThat(jdbc.sql("select count(*) from hr_snapshot").query(Long.class).single()).isZero();
            st.execute("select pg_advisory_unlock(" + 0x544D524B5A4852L + ")");
        }
        // A worker that stopped mid-run left a RUNNING row and staging rows: the next run closes them first.
        UUID stale = UUID.randomUUID();
        jdbc.sql("insert into hr_sync_run(id, trigger, status, started_at) values (:id, 'SCHEDULED', 'RUNNING', now() - interval '2 hours')")
                .param("id", stale).update();
        assertThat(status(run("SCHEDULED", null))).isEqualTo("SUCCEEDED");
        assertThat(jdbc.sql("select error_code from hr_sync_run where id = :id").param("id", stale).query(String.class).single())
                .isEqualTo("INTERRUPTED");
        JsonNode st = admin.get("/hr/status").body();
        assertThat(st.path("intervalSeconds").asLong()).isEqualTo(3600);
        assertThat(st.path("stale").asBoolean()).isFalse();
        assertThat(java.time.Duration.between(java.time.Instant.parse(st.path("lastRun").path("finishedAt").asText()),
                java.time.Instant.parse(st.path("nextRunAt").asText())).getSeconds()).isEqualTo(3600);

        // The manual button follows the same path and refuses a second concurrent run.
        // A slow source row (in a mapped column, so it is actually read) keeps the first run busy for about two seconds.
        view("units_v", "select id, name || (select '' from pg_sleep(case when id = '" + u("1") + "' then 2 else 0 end)) as name,"
                + " parent_id, status, code from " + schema + ".units_t");
        assertThat(admin.post("/hr/sync", Map.of()).status()).isEqualTo(202);
        Res second = admin.post("/hr/sync", Map.of());
        assertThat(second.status()).isEqualTo(409);
        assertThat(second.code()).isEqualTo("HR_SYNC_IN_PROGRESS");
        for (int i = 0; i < 100 && sync.running(); i++) {
            Thread.sleep(100);
        }
        assertThat(sync.running()).isFalse();
    }

    @Test
    @DisplayName("PA-05 + PA-06: identities survive rename and transfer; HR fields are read-only; local additions survive the sync")
    void identityAndLocalAdditions() {
        standardSource();
        configure(fields());
        assertThat(status(run("SCHEDULED", null))).isEqualTo("SUCCEEDED");
        UUID unit3 = orgOf("3");
        UUID person4 = personOf("4");
        UUID oldAffiliation = jdbc.sql("select organization_id from affiliation where person_id = :p and valid_to is null")
                .param("p", person4).query(UUID.class).single();

        // HR fields cannot be changed outside the sync; local additions can.
        assertThatThrownBy(() -> jdbc.sql("update organization set name = 'تعديل يدوي' where id = :id").param("id", unit3).update())
                .hasMessageContaining("HR_FIELD_READ_ONLY");
        assertThatThrownBy(() -> jdbc.sql("update person set display_name = 'تعديل يدوي' where id = :id").param("id", person4).update())
                .hasMessageContaining("HR_FIELD_READ_ONLY");
        assertThat(admin.put("/organizations/" + unit3 + "/local", Map.of("displayName", "الاسم المحلي", "tags", List.of("مرافق")))
                .status()).isEqualTo(200);
        UUID site = site("HRS", null, unit3);
        UUID grant = membership(person4, "REQUESTER", orgOf("1"), null);

        // The source renames unit 3 and moves person 4 to unit 3 (still inside unit 1's subtree).
        jdbc.sql("update " + schema + ".units_t set name = 'إدارة 3 بعد إعادة التسمية' where id = :i").param("i", u("3")).update();
        jdbc.sql("update " + schema + ".people_t set unit_id = :u where person_id = :p").param("u", u("3")).param("p", p("4")).update();
        JsonNode r = run("SCHEDULED", null);
        assertThat(status(r)).isEqualTo("SUCCEEDED");

        assertThat(orgOf("3")).isEqualTo(unit3);
        assertThat(personOf("4")).isEqualTo(person4);
        assertThat(jdbc.sql("select name from organization where id = :id").param("id", unit3).query(String.class).single())
                .isEqualTo("إدارة 3 بعد إعادة التسمية");
        assertThat(jdbc.sql("select display_name from local_metadata where entity_id = :id").param("id", unit3).query(String.class).single())
                .isEqualTo("الاسم المحلي");
        assertThat(jdbc.sql("select organization_id from site_responsibility where site_id = :s and valid_to is null").param("s", site)
                .query(UUID.class).single()).isEqualTo(unit3);
        assertThat(jdbc.sql("select organization_id from affiliation where person_id = :p and valid_to is null").param("p", person4)
                .query(UUID.class).single()).isEqualTo(unit3);
        assertThat(jdbc.sql("select ended_reason from affiliation where person_id = :p and organization_id = :o and valid_to is not null")
                .param("p", person4).param("o", oldAffiliation).query(String.class).single()).isEqualTo("HR_TRANSFER");
        // The grant on the parent organisation still covers the new unit, so it is kept.
        assertThat(jdbc.sql("select valid_to is null from membership where id = :id").param("id", grant).query(Boolean.class).single()).isTrue();
        // Source identifiers are for authorised administrators only.
        String run = jdbc.sql("select id::text from hr_sync_run where status = 'SUCCEEDED' order by started_at desc limit 1")
                .query(String.class).single();
        assertThat(login("admin").get("/hr/runs/" + run + "/issues").status()).isEqualTo(200);
        person("plain", "REQUESTER", root);
        assertThat(login("plain").get("/hr/runs/" + run + "/issues").status()).isEqualTo(403);
        assertThat(login("plain").get("/hr/status").status()).isEqualTo(403);
    }

    @Test
    @DisplayName("PA-09: a transfer hands open tasks to the sole new holder of the position; with nobody left they go to the access manager")
    void transferRealignsTasks() {
        String seatRole = role("SEATAPR", "ALL", "VIEW", "REVIEW", "APPROVE");
        unit("1", "الجهة الرئيسية", null, 1);
        unit("2", "الإدارة أ", "1", 1);
        unit("3", "الإدارة ب", "1", 1);
        personRow("A", "شاغل المنصب الأول", "2", "في الخدمة", "POS-APR");
        personRow("B", "موظف آخر", "3", "في الخدمة", "POS-OTHER");
        configure(fields());
        assertThat(status(run("SCHEDULED", null))).isEqualTo("SUCCEEDED");
        UUID unit2 = orgOf("2");
        assertThat(admin.post("/position-seats", Map.of("organizationId", unit2.toString(), "positionId", "POS-APR",
                "name", "صاحب الاعتماد", "roleCode", seatRole)).status()).isEqualTo(200);

        // A local requester submits; the final stage belongs to the seat's role.
        UUID orgR = org("REQ", root);
        UUID site = site("SITE", null, orgR);
        UUID res = resource("RES", site, null, 0);
        person("req", "REQUESTER", orgR);
        String type = requestType("NEW_RESERVATION", workflow(List.of(), stage("final_approval", "ALL", true, seatRole + "|ANY")), null);
        UUID request = login("req").submitted(type, orgR, List.of(res), day("2029-01-01"), day("2029-01-02"));
        UUID task = jdbc.sql("select id from task_assignment where request_id = :r and status = 'OPEN'").param("r", request)
                .query(UUID.class).single();

        // A moves away; B takes the position: B is the sole holder now.
        jdbc.sql("update " + schema + ".people_t set unit_id = :u, position_id = 'POS-NEW' where person_id = :p").param("u", u("3")).param("p", p("A")).update();
        jdbc.sql("update " + schema + ".people_t set unit_id = :u, position_id = 'POS-APR' where person_id = :p").param("u", u("2")).param("p", p("B")).update();
        assertThat(status(run("SCHEDULED", null))).isEqualTo("SUCCEEDED");
        Map<String, Object> moved = jdbc.sql("select outcome, holders::text as h from task_reassignment where task_id = :t order by created_at")
                .param("t", task).query().listOfRows().get(0);
        assertThat(moved.get("outcome")).isEqualTo("SOLE_SUBSTITUTE");
        assertThat((String) moved.get("h")).contains(personOf("B").toString());
        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and kind = 'TASK_REALIGNED'").param("p", personOf("B"))
                .query(Long.class).single()).isEqualTo(1);

        // B leaves the service: nobody holds the position, so the access managers receive the task to resolve.
        jdbc.sql("update " + schema + ".people_t set status_desc = 'منتهية خدمته' where person_id = :p").param("p", p("B")).update();
        assertThat(status(run("SCHEDULED", null))).isEqualTo("SUCCEEDED");
        Map<String, Object> routed = jdbc.sql("select outcome, routed_to_org from task_reassignment where task_id = :t order by created_at desc limit 1")
                .param("t", task).query().singleRow();
        assertThat(routed.get("outcome")).isEqualTo("ROUTED_TO_ACCESS_MANAGER");
        assertThat(routed.get("routed_to_org")).isEqualTo(orgR);
        UUID adminId = jdbc.sql("select id from person where username = :u").param("u", "admin-" + sfx).query(UUID.class).single();
        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and kind = 'TASK_ROUTED'").param("p", adminId)
                .query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select status from person where id = :id").param("id", personOf("B")).query(String.class).single())
                .isEqualTo("DISABLED");
        assertThat(jdbc.sql("select count(*) from decision where request_id = :r").param("r", request).query(Long.class).single()).isZero();
    }
}
