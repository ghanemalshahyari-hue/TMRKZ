package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
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
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.hr.HrConnectionFactory;
import ae.mover.hr.HrPeopleService;
import ae.mover.hr.HrSourceAdapter;
import ae.mover.hr.HrSyncService;

/**
 * ADR-094 (owner, 20 Nov 2026): Oracle is not a dependency. The units are imported on demand («استيراد الوحدات الآن») and, when
 * switched on, every N hours from the source's own schedule; people are never synced in bulk — fetched when needed and
 * refreshed after a day on the next need; a directory sign-in that HR cannot confirm now enters as a zero-access person
 * «بانتظار مطابقة HR» (a toggle) and is matched when HR answers again; the scope a person may ask for is their MAIN unit's tree.
 */
class HrOnDemandIT extends IntegrationTest {

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

    /** The manual form checks the password against the fictional StartTLS directory of {@link DirectorySignInIT} (direct bind). */
    @DynamicPropertySource
    static void directory(DynamicPropertyRegistry r) {
        r.add("tmrkz.ldap.url", () -> "ldap://localhost:" + DirectorySignInIT.LDAP.getListenPort());
        r.add("tmrkz.ldap.start-tls", () -> "true");
        r.add("tmrkz.ldap.users-dn", () -> DirectorySignInIT.BASE);
        r.add("tmrkz.ldap.ca-dir", DirectorySignInIT.CA_DIR::toString);
        r.add("tmrkz.ldap.direct-bind-pattern", () -> "uid={username}," + DirectorySignInIT.PEOPLE);
        // the directory names the person's unit (ADR-068): a zero-access person lands in it when it exists in TMRKZ
        r.add("tmrkz.ldap.unit-id-attribute", () -> "departmentNumber");
        r.add("tmrkz.ldap.rank-attribute", () -> "employeeType");
    }

    @Autowired
    HrSyncService sync;
    @Autowired
    HrPeopleService hrPeople;

    String schema;
    String reader;
    Api admin;

    @BeforeEach
    void source() {
        jdbc.sql("delete from hr_sync_issue").update();
        jdbc.sql("delete from hr_unit").update();
        jdbc.sql("delete from hr_person").update();
        jdbc.sql("delete from hr_snapshot_scope").update();
        jdbc.sql("delete from hr_snapshot").update();
        jdbc.sql("delete from hr_sync_run").update();
        jdbc.sql("delete from hr_mapping_version").update();
        jdbc.sql("delete from hr_source").update();
        schema = "hrod_" + sfx;
        reader = "hr_od_" + sfx;
        for (String s : new String[]{
                "create schema " + schema,
                "create table " + schema + ".units_t (id text, name text, parent_id text, status int, code text, main_id text)",
                "create table " + schema + ".people_t (person_id text, emp_no text, full_name text, unit_id text, status_desc text, account text, position_name text, grade_name text)",
                "create view " + schema + ".units_v as select * from " + schema + ".units_t",
                "create view " + schema + ".people_v as select * from " + schema + ".people_t",
                "create role " + reader + " login password 'Reader#" + sfx + "'",
                "grant usage on schema " + schema + " to " + reader,
                "grant select on " + schema + ".units_v, " + schema + ".people_v to " + reader}) {
            jdbc.sql(s).update();
        }
        UUID root = org("ODROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
    }

    private String u(String id) {
        return "U" + sfx + "-" + id;
    }

    private String p(String id) {
        return "P" + sfx + "-" + id;
    }

    private void unit(String id, String name, String parent, String main) {
        jdbc.sql("insert into " + schema + ".units_t values (:i, :n, :p, 1, :c, :m)")
                .param("i", u(id)).param("n", name).param("p", parent == null ? null : u(parent)).param("c", "C" + id).param("m", u(main)).update();
    }

    private void personRow(String id, String name, String unitId, String account, String rank) {
        jdbc.sql("insert into " + schema + ".people_t values (:i, :e, :n, :u, 'في الخدمة', :a, 'منصب', :g)")
                .param("i", p(id)).param("e", "N" + sfx + "-" + id).param("n", name).param("u", u(unitId)).param("a", account).param("g", rank).update();
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

    /** The source through the API; the schedule and people settings as given; the mapping drafted, discovered, published. */
    private void configure(boolean autoSync, boolean peopleSync, boolean directorySuffices) {
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
        src.put("autoSync", autoSync);
        src.put("syncIntervalHours", 24);
        src.put("peopleSync", peopleSync);
        src.put("directorySignInSuffices", directorySuffices);
        Res saved = admin.put("/hr/source", src);
        assertThat(saved.status()).as(saved.toString()).isEqualTo(200);
        assertThat(saved.body().path("autoSync").asBoolean()).isEqualTo(autoSync);
        assertThat(saved.body().path("syncIntervalHours").asInt()).isEqualTo(24);
        assertThat(saved.body().path("peopleSync").asBoolean()).isEqualTo(peopleSync);
        assertThat(saved.body().path("directorySignInSuffices").asBoolean()).isEqualTo(directorySuffices);
        List<Map<String, Object>> f = new ArrayList<>();
        f.add(field("UNIT", "external_unit_id", "ID"));
        f.add(field("UNIT", "name", "NAME"));
        f.add(field("UNIT", "parent_external_unit_id", "PARENT_ID"));
        f.add(field("UNIT", "status", "STATUS"));
        f.add(field("UNIT", "code", "CODE"));
        f.add(field("UNIT", "main_external_unit_id", "MAIN_ID"));
        f.add(field("PERSON", "external_person_id", "PERSON_ID"));
        f.add(field("PERSON", "employee_number", "EMP_NO"));
        f.add(field("PERSON", "full_name", "FULL_NAME"));
        f.add(field("PERSON", "unit_external_id", "UNIT_ID"));
        f.add(field("PERSON", "status_text", "STATUS_DESC"));
        f.add(field("PERSON", "domain_account", "ACCOUNT"));
        f.add(field("PERSON", "position", "POSITION_NAME"));
        f.add(field("PERSON", "rank", "GRADE_NAME"));
        Map<String, Object> rules = Map.of("UNIT", Map.of("column", "STATUS", "operator", "EQUALS", "values", List.of("1")),
                "PERSON", Map.of("column", "STATUS_DESC", "operator", "EQUALS", "values", List.of("في الخدمة")));
        Res draft = admin.post("/hr/mappings/draft", Map.of("fields", f, "activeRules", rules));
        assertThat(draft.status()).as(draft.toString()).isEqualTo(200);
        String id = draft.body().path("id").asText();
        assertThat(admin.post("/hr/mappings/" + id + "/discover", Map.of()).status()).isEqualTo(200);
        Res pub = admin.post("/hr/mappings/" + id + "/publish", Map.of());
        assertThat(pub.status()).as(pub.toString()).isEqualTo(200);
    }

    private JsonNode run() {
        UUID id = sync.run("MANUAL", null, null);
        JsonNode r = admin.get("/hr/runs").body();
        for (JsonNode n : r) {
            if (id.toString().equals(n.path("id").asText())) {
                return n;
            }
        }
        throw new AssertionError("run not listed");
    }

    private UUID orgOf(String unitId) {
        return jdbc.sql("select id from organization where source = 'HR' and source_external_id = :x").param("x", u(unitId)).query(UUID.class).single();
    }

    /** A tree with two main units under the root: U1 ⟶ {U2 (main) ⟶ U3, U4 (main) ⟶ U5}. */
    private void tree() {
        unit("1", "القيادة", null, "1");
        unit("2", "الوحدة الرئيسية أ", "1", "2");
        unit("3", "فرع أ-1", "2", "2");
        unit("4", "الوحدة الرئيسية ب", "1", "4");
        unit("5", "فرع ب-1", "4", "4");
    }

    @Test
    @DisplayName("OD-01 units import now; people never in bulk — one added on demand, carried by the next run, refreshed after a day on the next need; the source's own schedule")
    void unitsNowPeopleOnDemand() {
        tree();
        personRow("1", "موظف واحد", "3", "acct1" + sfx, "رائد");
        personRow("2", "موظف اثنان", "3", "acct2" + sfx, "نقيب");
        configure(false, false, true);
        JsonNode first = run();
        assertThat(first.path("status").asText()).as(first.toString()).isEqualTo("SUCCEEDED");
        assertThat(jdbc.sql("select count(*) from organization where source = 'HR' and source_external_id like :p").param("p", "U" + sfx + "-%").query(Long.class).single()).isEqualTo(5);
        assertThat(jdbc.sql("select count(*) from person where source = 'HR' and employee_no like :p").param("p", "N" + sfx + "-%").query(Long.class).single()).as("no person comes with the units").isZero();
        Res status = admin.get("/hr/status");
        assertThat(status.body().path("autoSync").asBoolean()).isFalse();
        assertThat(status.body().path("nextRunAt").isNull()).as("manual only: no next run").isTrue();
        assertThat(sync.due()).isFalse();

        // one person is fetched on demand («إضافة مستخدم» by number) and only that one
        Res added = admin.post("/access/unit-members", Map.of("organizationId", orgOf("3").toString(), "employeeNo", "N" + sfx + "-1"));
        assertThat(added.status()).as(added.toString()).isEqualTo(200);
        UUID one = jdbc.sql("select id from person where employee_no = :n").param("n", "N" + sfx + "-1").query(UUID.class).single();
        assertThat(jdbc.sql("select count(*) from person where source = 'HR' and employee_no like :p").param("p", "N" + sfx + "-%").query(Long.class).single()).isEqualTo(1);

        // the source changes the person's name; the next run carries the record unchanged (units only), nothing refreshes people in bulk
        jdbc.sql("update " + schema + ".people_t set full_name = 'موظف واحد — اسم جديد' where person_id = :i").param("i", p("1")).update();
        JsonNode second = run();
        assertThat(second.path("status").asText()).as(second.toString()).isEqualTo("SUCCEEDED");
        assertThat(second.path("counts").path("peopleCarried").asInt()).isEqualTo(1);
        assertThat(jdbc.sql("select display_name from person where id = :p").param("p", one).query(String.class).single()).isEqualTo("موظف واحد");

        // a need within the day leaves the record; a need after a day refreshes this one person from HR
        assertThat(refresh(one)).isFalse();
        jdbc.sql("update person set hr_fetched_at = now() - interval '25 hours' where id = :p").param("p", one).update();
        assertThat(refresh(one)).isTrue();
        assertThat(jdbc.sql("select display_name from person where id = :p").param("p", one).query(String.class).single()).isEqualTo("موظف واحد — اسم جديد");
        assertThat(jdbc.sql("select hr_fetched_at > now() - interval '1 minute' from person where id = :p").param("p", one).query(Boolean.class).single()).isTrue();
        // HR not answering changes nothing and refuses nothing (Oracle is not a dependency)
        jdbc.sql("update person set hr_fetched_at = now() - interval '25 hours' where id = :p").param("p", one).update();
        jdbc.sql("alter role " + reader + " password 'Changed#" + sfx + "'").update();
        assertThat(refresh(one)).isFalse();
        assertThat(jdbc.sql("select display_name from person where id = :p").param("p", one).query(String.class).single()).isEqualTo("موظف واحد — اسم جديد");
        jdbc.sql("alter role " + reader + " password 'Reader#" + sfx + "'").update();

        // the automatic sync is the source's own schedule: on, every 24 hours, due when the last success is older
        Map<String, Object> on = new LinkedHashMap<>();
        on.put("name", "مصدر الموارد البشرية");
        on.put("enabled", true);
        on.put("hostOrUrl", "hr-db.example.internal");
        on.put("port", 1521);
        on.put("serverName", "HRSVC");
        on.put("nameType", "service_name");
        on.put("username", reader);
        on.put("unitView", schema + ".units_v");
        on.put("personView", schema + ".people_v");
        on.put("autoSync", true);
        on.put("syncIntervalHours", 24);
        Res again = admin.put("/hr/source", on);
        assertThat(again.status()).as(again.toString()).isEqualTo(200);
        assertThat(sync.due()).as("just synced: not due").isFalse();
        jdbc.sql("update hr_source set last_success_at = now() - interval '25 hours'").update();
        assertThat(sync.due()).isTrue();
        assertThat(admin.get("/hr/status").body().path("nextRunAt").asText()).isNotEqualTo("");

        // the old way stays available: people refreshed in every run when «peopleSync» is on
        jdbc.sql("update hr_source set people_sync = true").update();
        jdbc.sql("update " + schema + ".people_t set full_name = 'موظف واحد — اسم ثالث' where person_id = :i").param("i", p("1")).update();
        JsonNode third = run();
        assertThat(third.path("status").asText()).as(third.toString()).isEqualTo("SUCCEEDED");
        assertThat(jdbc.sql("select display_name from person where id = :p").param("p", one).query(String.class).single()).isEqualTo("موظف واحد — اسم ثالث");
        jdbc.sql("update hr_source set enabled = false").update();
    }

    @Test
    @DisplayName("OD-02 the scope a person may ask for is their MAIN unit's tree, never another main unit's; a request outside it is refused")
    void scopeIsTheMainUnitTree() {
        tree();
        personRow("1", "موظف واحد", "3", "acct1" + sfx, "رائد");
        configure(false, false, true);
        assertThat(run().path("status").asText()).isEqualTo("SUCCEEDED");
        assertThat(admin.post("/access/unit-members", Map.of("organizationId", orgOf("3").toString(), "employeeNo", "N" + sfx + "-1")).status()).isEqualTo(200);
        UUID one = jdbc.sql("select id from person where employee_no = :n").param("n", "N" + sfx + "-1").query(UUID.class).single();
        Api me = apiFor(one);
        Res mine = me.get("/access-requests/mine");
        assertThat(mine.status()).as(mine.toString()).isEqualTo(200);
        List<String> offered = mine.body().path("scopeUnits").findValuesAsText("id");
        assertThat(offered).containsExactlyInAnyOrder(orgOf("2").toString(), orgOf("3").toString());
        assertThat(offered).doesNotContain(orgOf("1").toString(), orgOf("4").toString(), orgOf("5").toString());
        jdbc.sql("update hr_source set enabled = false").update();
    }

    @Test
    @DisplayName("OD-04 «معاينة الوحدات» reads the source without writing a unit, a run or a snapshot; the status states source against local; the person refresh period is a setting")
    void previewUnitsWritesNothing() {
        tree();
        unit("6", "جهة يتيمة", "99", "6");          // parent the source does not hold
        unit("3", "فرع أ-1 مكرر", "2", "2");         // duplicate key
        personRow("1", "موظف واحد", "3", "acct1" + sfx, "رائد");
        personRow("2", "موظف اثنان", "3", "acct2" + sfx, "نقيب");
        configure(false, false, true);
        Res before = admin.get("/hr/status");
        long importedBefore = before.body().path("unitsImported").asLong(); // other classes' HR units share the database
        assertThat(before.body().path("lastPreview").isNull()).isTrue();
        assertThat(before.body().path("personRefreshHours").asInt()).isEqualTo(24);

        Res preview = admin.post("/hr/units/preview", Map.of());
        assertThat(preview.status()).as(preview.toString()).isEqualTo(200);
        JsonNode p = preview.body();
        assertThat(p.path("ok").asBoolean()).as(p.toString()).isTrue();
        assertThat(p.path("units").asInt()).isEqualTo(6);
        assertThat(p.path("mainUnits").asInt()).as("1, 2, 4 and 6 point to themselves").isEqualTo(4);
        assertThat(p.path("roots").asInt()).isEqualTo(1);
        assertThat(p.path("people").asLong()).isEqualTo(2);
        assertThat(p.path("problems").path("duplicateKey").asInt()).isEqualTo(1);
        assertThat(p.path("problems").path("parentMissing").asInt()).isEqualTo(1);
        assertThat(p.path("problemCount").asInt()).isEqualTo(2);
        assertThat(p.path("samples").size()).isEqualTo(2);
        // nothing written
        assertThat(jdbc.sql("select count(*) from hr_sync_run").query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from hr_snapshot").query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from organization where source = 'HR' and source_external_id like :p").param("p", "U" + sfx + "-%").query(Long.class).single()).isZero();
        // the status states the source as last seen against what is held locally
        Res after = admin.get("/hr/status");
        assertThat(after.body().path("lastPreview").path("units").asInt()).isEqualTo(6);
        assertThat(after.body().path("lastPreviewAt").isTextual()).isTrue();
        assertThat(after.body().path("sourceConnection").path("ok").asBoolean()).isTrue();
        assertThat(after.body().path("unitsImported").asLong()).as("the preview imported nothing").isEqualTo(importedBefore);
        assertThat(after.body().path("lastAttemptAt").isNull()).as("no import attempted").isTrue();
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'HR_UNITS_PREVIEWED'").query(Long.class).single()).isEqualTo(1);

        // «تحديث بيانات الشخص بعد»: 0 = never automatically; the installation's state is open and counts the units
        Map<String, Object> src = new LinkedHashMap<>();
        src.put("name", "مصدر الموارد البشرية");
        src.put("enabled", true);
        src.put("hostOrUrl", "hr-db.example.internal");
        src.put("port", 1521);
        src.put("serverName", "HRSVC");
        src.put("nameType", "service_name");
        src.put("username", reader);
        src.put("unitView", schema + ".units_v");
        src.put("personView", schema + ".people_v");
        src.put("personRefreshHours", 0);
        Res saved = admin.put("/hr/source", src);
        assertThat(saved.status()).as(saved.toString()).isEqualTo(200);
        assertThat(saved.body().path("personRefreshHours").asInt()).isZero();
        assertThat(admin.get("/hr/status").body().path("personRefreshHours").asInt()).isZero();
        Res state = admin.get("/system/state");
        assertThat(state.status()).isEqualTo(200);
        assertThat(state.body().path("units").asLong()).isGreaterThanOrEqualTo(1);
        assertThat(state.body().path("empty").asBoolean()).isFalse();
        Res mine = admin.post("/me/hr-refresh", Map.of());
        assertThat(mine.status()).isEqualTo(200);
        assertThat(mine.body().path("refreshed").asBoolean()).as("a local account has no HR record").isFalse();
    }

    @Test
    @DisplayName("OD-03 «الدخول بالدليل يكفي»: HR not answering, the directory sign-in enters as a zero-access person «بانتظار مطابقة HR», placed in its unit, matched when HR answers; off, it is refused as before")
    void directorySignInSufficesWhenHrIsDown() throws Exception {
        tree();
        configure(false, false, true);
        assertThat(run().path("status").asText()).isEqualTo("SUCCEEDED");
        String login = "od" + sfx;
        DirectorySignInIT.LDAP.add("dn: uid=" + login + "," + DirectorySignInIT.PEOPLE, "objectClass: inetOrgPerson", "uid: " + login,
                "cn: شخص الدليل " + login, "sn: Test", "employeeNumber: N" + sfx + "-9", "departmentNumber: " + u("3"), "employeeType: رائد",
                "userPassword: Dir#Pass-" + sfx);
        // HR cannot be asked (the read-only account's password changed under it): the person is admitted from the directory
        jdbc.sql("alter role " + reader + " password 'Changed#" + sfx + "'").update();
        Signed in = signIn(login, "Dir#Pass-" + sfx);
        assertThat(in.status()).as(String.valueOf(in.body())).isEqualTo(200);
        assertThat(in.body().path("hrMatch").asText()).isEqualTo("PENDING");
        assertThat(in.body().path("permissions").size()).as("zero access").isZero();
        UUID person = UUID.fromString(in.body().path("id").asText());
        Map<String, Object> row = jdbc.sql("select source, hr_match_pending, employee_no from person where id = :p").param("p", person).query().singleRow();
        assertThat(row.get("source")).isEqualTo("LOCAL");
        assertThat(row.get("hr_match_pending")).isEqualTo(true);
        assertThat(row.get("employee_no")).isEqualTo("N" + sfx + "-9");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'IDENTITY_HR_MATCH_PENDING' and entity_id = :p").param("p", person.toString()).query(Long.class).single()).isEqualTo(1);
        // placed in the unit the directory names, so «طلب صلاحية» offers that unit's main-unit tree
        Res mine = apiWith(in.cookie()).get("/access-requests/mine");
        assertThat(mine.status()).as(mine.toString()).isEqualTo(200);
        assertThat(mine.body().path("scopeUnits").findValuesAsText("id")).contains(orgOf("3").toString());

        // HR answers again and knows the person: the next sign-in matches the record onto them
        jdbc.sql("alter role " + reader + " password 'Reader#" + sfx + "'").update();
        personRow("9", "شخص الدليل من الموارد البشرية", "3", login, "رائد");
        Signed later = signIn(login, "Dir#Pass-" + sfx);
        assertThat(later.status()).isEqualTo(200);
        assertThat(later.body().path("hrMatch").asText()).isEqualTo("MATCHED");
        Map<String, Object> after = jdbc.sql("select source, hr_match_pending, source_external_id from person where id = :p").param("p", person).query().singleRow();
        assertThat(after.get("source")).isEqualTo("HR");
        assertThat(after.get("hr_match_pending")).isEqualTo(false);
        assertThat(after.get("source_external_id")).isEqualTo(p("9"));

        // the toggle off: with HR down a new directory sign-in is refused and reviewed, as before
        jdbc.sql("update hr_source set directory_sign_in_suffices = false").update();
        String other = "odx" + sfx;
        DirectorySignInIT.LDAP.add("dn: uid=" + other + "," + DirectorySignInIT.PEOPLE, "objectClass: inetOrgPerson", "uid: " + other,
                "cn: شخص آخر " + other, "sn: Test", "employeeNumber: N" + sfx + "-8", "userPassword: Dir#Pass-" + sfx);
        jdbc.sql("alter role " + reader + " password 'Changed#" + sfx + "'").update();
        Signed refused = signIn(other, "Dir#Pass-" + sfx);
        assertThat(refused.status()).isEqualTo(403);
        assertThat(refused.body().path("details").path("reason").asText()).isEqualTo("SOURCE_UNAVAILABLE");
        jdbc.sql("alter role " + reader + " password 'Reader#" + sfx + "'").update();
        jdbc.sql("update hr_source set enabled = false").update();
    }

    private boolean refresh(UUID person) {
        Boolean r = tx.execute(s -> hrPeople.refreshIfStale(person));
        return Boolean.TRUE.equals(r);
    }

    /** A session for a person by id (as {@link #login} does by username). */
    private Api apiFor(UUID person) {
        ae.mover.security.AuthService.LoginResult r = auth.issueSession(person, "test-issuer", null, java.time.Instant.now(), "127.0.0.1", "acceptance-test");
        return apiWith(ae.mover.security.SessionFilter.COOKIE + "=" + r.token());
    }

    /** An API client carrying a session cookie («name=value») the sign-in returned. */
    private Api apiWith(String cookie) {
        Api api = new Api();
        java.net.HttpCookie c = new java.net.HttpCookie(cookie.substring(0, cookie.indexOf('=')), cookie.substring(cookie.indexOf('=') + 1));
        c.setPath("/");
        c.setVersion(0);
        ((java.net.CookieManager) api.http.cookieHandler().orElseThrow()).getCookieStore().add(URI.create("http://localhost:" + port), c);
        return api;
    }

    private Signed signIn(String username, String password) throws Exception {
        HttpResponse<String> r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(
                        "http://localhost:" + port + "/api/v1/auth/directory/login"))
                .header("Content-Type", "application/json").header("X-Requested-With", "mover")
                .POST(HttpRequest.BodyPublishers.ofString(write(Map.of("username", username, "password", password)))).build(),
                HttpResponse.BodyHandlers.ofString());
        String cookie = r.headers().allValues("Set-Cookie").stream().filter(c -> c.startsWith("MOVER_SESSION="))
                .map(c -> c.split(";")[0]).findFirst().orElse(null);
        return new Signed(r.statusCode(), r.body().isEmpty() ? null : JSON.readTree(r.body()), cookie);
    }

    private record Signed(int status, JsonNode body, String cookie) {
    }
}
