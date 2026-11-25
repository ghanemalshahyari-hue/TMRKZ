package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.CookieManager;
import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.authz.Authorization;
import ae.mover.authz.AuthzSync;
import ae.mover.hr.HrSyncService;
import ae.mover.security.Actor;
import ae.mover.security.DirectoryProfile;
import ae.mover.security.IdentityService;
import ae.mover.security.OidcClient;

/**
 * ADR-103: «مديرو النظام» with the two verified identity lookups — Oracle HR by employee number (the Oracle-compatible test
 * source of {@link EmploymentContextIT}: PostgreSQL views behind a SELECT-only login) and a directory account verified by a
 * previous sign-in — shown for confirmation, granted through the standard grant path, least privilege, audit and the
 * last-administrator rule. Fictional people and units only.
 */
@Import(EmploymentContextIT.SourceConnections.class)
class AdministratorLifecycleIT extends IntegrationTest {

    private static final String ISSUER = "http://idp.test/realms/tmrkz";
    private static final String SERVING = "في الخدمة";

    @Autowired
    IdentityService identities;
    @Autowired
    HrSyncService hrSync;
    @Autowired
    AuthzSync authzSync;
    @Autowired
    Authorization authorization;
    @Autowired
    AccessService access;

    UUID root;
    Api admin;

    @BeforeEach
    void fixtures() {
        jdbc.sql("update hr_source set enabled = false").update();
        root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
    }

    @AfterEach
    void sourceOff() {
        jdbc.sql("update hr_source set enabled = false").update();
    }

    private UUID signedInOnce(String login) {
        return identities.resolve(new OidcClient.Identity(ISSUER, "sub-" + login, login, "دخول " + login, login, Instant.now(), null,
                "LOGIN", "/", null, false, new DirectoryProfile("D" + login.hashCode(), null, null, null, null, null, true)));
    }

    private Api session(UUID person) {
        var r = auth.issueSession(person, ISSUER, null, Instant.now(), "127.0.0.1", "acceptance-test");
        Api api = new Api();
        java.net.HttpCookie cookie = new java.net.HttpCookie(ae.mover.security.SessionFilter.COOKIE, r.token());
        cookie.setPath("/");
        cookie.setVersion(0);
        ((CookieManager) api.http.cookieHandler().orElseThrow()).getCookieStore().add(URI.create("http://localhost:" + port), cookie);
        return api;
    }

    private static Map<String, Object> lookup(String method, String value) {
        return Map.of("method", method, "value", value);
    }

    private static Map<String, Object> confirm(JsonNode c, String reason) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("method", c.path("method").asText());
        m.put("value", c.path("value").asText());
        m.put("confirmation", c.path("confirmation").asText());
        m.put("reason", reason);
        return m;
    }

    private long currentAdminGrants(UUID person) {
        return jdbc.sql("""
                select count(*) from membership where person_id = :p and role_code = 'SYSTEM_ADMIN'
                  and valid_from <= now() and (valid_to is null or valid_to > now())""").param("p", person).query(Long.class).single();
    }

    @Test
    @DisplayName("ADM-1: a directory account verified by a sign-in is shown, then granted only with the shown confirmation and a reason; both deciders agree")
    void directoryAccount() {
        String login = "adm" + sfx;
        UUID person = signedInOnce(login);
        Res shown = admin.post("/administrators/resolve", lookup("DIRECTORY_ACCOUNT", "TMRKZ\\" + login.toUpperCase()));
        assertThat(shown.status()).as(shown.toString()).isEqualTo(200);
        JsonNode c = shown.body();
        assertThat(c.path("verifiedBy").asText()).isEqualTo("DIRECTORY_SIGN_IN");
        assertThat(c.path("personId").asText()).isEqualTo(person.toString());
        assertThat(c.path("value").asText()).as("normalised login").isEqualTo(login);
        assertThat(c.path("alreadyAdmin").asBoolean()).isFalse();
        assertThat(currentAdminGrants(person)).as("showing grants nothing").isZero();

        // never verified by the directory (a User ID typed by a manager, no sign-in yet), or unknown: not found, nothing made
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("organizationId", root.toString());
        body.put("userId", "never" + sfx);
        assertThat(admin.post("/access/unit-members", body).status()).isEqualTo(200);
        assertThat(admin.post("/administrators/resolve", lookup("DIRECTORY_ACCOUNT", "never" + sfx)).status()).isEqualTo(404);
        assertThat(admin.post("/administrators/resolve", lookup("DIRECTORY_ACCOUNT", "nobody" + sfx)).status()).isEqualTo(404);
        assertThat(admin.post("/administrators/resolve", lookup("SOMETHING", login)).status()).isEqualTo(400);

        Map<String, Object> forged = confirm(c, "مدير نظام للفرع الإداري");
        forged.put("confirmation", "0".repeat(64));
        assertThat(admin.post("/administrators", forged).status()).as("a confirmation not shown").isEqualTo(409);
        assertThat(admin.post("/administrators", confirm(c, "")).status()).as("reason required").isEqualTo(400);
        assertThat(currentAdminGrants(person)).isZero();

        Res granted = admin.post("/administrators", confirm(c, "مدير نظام للفرع الإداري"));
        assertThat(granted.status()).as(granted.toString()).isEqualTo(200);
        assertThat(granted.body().path("effective").asBoolean()).isTrue();
        Map<String, Object> m = jdbc.sql("""
                select m.scope_mode, m.scope_all, o.status as org_status,
                       (select count(*) from membership_scope_target t where t.membership_id = m.id) as targets
                from membership m join organization o on o.id = m.organization_id
                where m.person_id = :p and m.role_code = 'SYSTEM_ADMIN' and m.valid_to is null""").param("p", person).query().singleRow();
        assertThat(m).containsEntry("scope_mode", "ROLE").containsEntry("scope_all", false).containsEntry("org_status", "ACTIVE")
                .containsEntry("targets", 0L);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'ADMIN_GRANTED' and entity_id = :p and reason = 'مدير نظام للفرع الإداري'")
                .param("p", person.toString()).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'MEMBERSHIP_CREATED' and entity_id = :p")
                .param("p", person.toString()).query(Long.class).single()).as("through the standard grant path").isEqualTo(1);

        authzSync.run(false);
        var ctx = access.load(new Actor(person, null, null, null), Instant.now()).withConfirmer(authorization);
        assertThat(ctx.canEverywhere(Permission.MANAGE_ACCESS)).as("database and OpenFGA").isTrue();
        assertThat(admin.post("/administrators/resolve", lookup("DIRECTORY_ACCOUNT", login)).body().path("alreadyAdmin").asBoolean()).isTrue();
        assertThat(admin.post("/administrators", confirm(c, "مرة ثانية")).status()).isEqualTo(400);
        // the new administrator cannot hand the role to themselves (nor see themselves as a candidate)
        assertThat(session(person).post("/administrators/resolve", lookup("DIRECTORY_ACCOUNT", login)).status()).isEqualTo(403);
    }

    @Test
    @DisplayName("ADM-2: least privilege — configuration alone, or access management of one branch, cannot hand out or take back the role")
    void leastPrivilege() {
        String configOnly = role("CFG", "ALL", "CONFIGURE");
        person("cfg", configOnly, root);
        String branchMgr = role("BMGR", "ORGANIZATION", "MANAGE_ACCESS", "CONFIGURE");
        person("bmgr", branchMgr, org("BR", root));
        String login = "lp" + sfx;
        signedInOnce(login);
        assertThat(login("cfg").get("/administrators").status()).as("listing needs configuration only").isEqualTo(200);
        assertThat(login("cfg").post("/administrators/resolve", lookup("DIRECTORY_ACCOUNT", login)).status()).isEqualTo(403);
        assertThat(login("bmgr").post("/administrators/resolve", lookup("DIRECTORY_ACCOUNT", login)).status()).isEqualTo(403);
        UUID adminId = jdbc.sql("select id from person where username = :u").param("u", "admin-" + sfx).query(UUID.class).single();
        assertThat(login("cfg").post("/administrators/" + adminId + "/end", Map.of("reason", "محاولة")).status()).isEqualTo(403);
    }

    @Test
    @DisplayName("ADM-3: ending needs a reason; a platform account is not ended here; the last effective administrator is never removed")
    void endingRules() {
        UUID adminId = jdbc.sql("select id from person where username = :u").param("u", "admin-" + sfx).query(UUID.class).single();
        UUID second = person("second", "SYSTEM_ADMIN", root);
        assertThat(admin.post("/administrators/" + second + "/end", Map.of("reason", "")).status()).isEqualTo(400);
        assertThat(admin.post("/administrators/" + adminId + "/end", Map.of("reason", "نفسي")).status()).as("not oneself").isEqualTo(403);
        Res ended = admin.post("/administrators/" + second + "/end", Map.of("reason", "انتهت مهمته الإدارية"));
        assertThat(ended.status()).as(ended.toString()).isEqualTo(204);
        assertThat(currentAdminGrants(second)).isZero();
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'ADMIN_REVOKED' and entity_id = :p")
                .param("p", second.toString()).query(Long.class).single()).isEqualTo(1);
        assertThat(admin.post("/administrators/" + second + "/end", Map.of("reason", "مرة ثانية")).status()).isEqualTo(404);

        UUID platform = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username) values (:id, :e, 'حساب منصة', :u)")
                .param("id", platform).param("e", "PLATFORM-p" + sfx).param("u", "p" + sfx).update();
        membership(platform, "SYSTEM_ADMIN", root, null);
        assertThat(admin.post("/administrators/" + platform + "/end", Map.of("reason", "محاولة")).status()).isEqualTo(403);

        // the last effective administrator: every other administrator of the shared test database switched off for this check
        UUID dev = person("dev", "DEVELOPER", root);
        List<UUID> others = new ArrayList<>(jdbc.sql("""
                update person set access_disabled = true where not access_disabled and id <> :a and id in
                  (select person_id from membership where role_code = 'SYSTEM_ADMIN' and (valid_to is null or valid_to > now()))
                returning id""").param("a", adminId).query(UUID.class).list());
        try {
            Res last = login("dev").post("/administrators/" + adminId + "/end", Map.of("reason", "تجربة آخر مدير"));
            assertThat(last.status()).as(last.toString()).isEqualTo(400);
            assertThat(last.body().path("message").asText()).contains("آخر مدير نظام");
            assertThat(currentAdminGrants(adminId)).isEqualTo(1);
        } finally {
            if (!others.isEmpty()) {
                jdbc.sql("update person set access_disabled = false where id = any(string_to_array(:ids, ',')::uuid[])")
                        .param("ids", ids(others)).update();
            }
        }
        assertThat(dev).isNotNull();
    }

    // ---- Oracle HR -------------------------------------------------------------------------------------------------

    private String schema;
    private String reader;

    private void exec(String... sql) {
        for (String s : sql) {
            jdbc.sql(s).update();
        }
    }

    private void hrSource(String password) {
        Map<String, Object> src = new LinkedHashMap<>();
        src.put("name", "مصدر الموارد البشرية");
        src.put("enabled", true);
        src.put("hostOrUrl", "hr-db.example.internal");
        src.put("port", 1521);
        src.put("serverName", "HRSVC");
        src.put("nameType", "service_name");
        src.put("username", reader);
        src.put("password", password);
        src.put("unitView", schema + ".units_v");
        src.put("personView", schema + ".people_v");
        assertThat(admin.put("/hr/source", src).status()).isEqualTo(200);
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

    private void oracle() {
        exec("delete from hr_sync_issue", "delete from hr_unit", "delete from hr_person", "delete from hr_snapshot_scope",
                "delete from hr_snapshot", "delete from hr_sync_run", "delete from hr_mapping_version", "delete from hr_source");
        schema = "adm_" + sfx;
        reader = "adm_reader_" + sfx;
        exec("create schema " + schema,
                "create table " + schema + ".units_t (id text, name text, parent_id text, status int, code text)",
                "create table " + schema + ".people_t (person_id text, emp_no text, full_name text, unit_id text, status_desc text,"
                        + " account text, position_id text, position_name text, grade_name text, leave_text text)",
                "create view " + schema + ".units_v as select * from " + schema + ".units_t",
                "create view " + schema + ".people_v as select * from " + schema + ".people_t",
                "create role " + reader + " login password 'Reader#" + sfx + "'",
                "grant usage on schema " + schema + " to " + reader,
                "grant select on " + schema + ".units_v, " + schema + ".people_v to " + reader);
        jdbc.sql("insert into " + schema + ".units_t values (:i, 'الجهة الإدارية الرئيسية', null, 1, 'C1')").param("i", "AU" + sfx).update();
        hrSource("Reader#" + sfx);
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
        f.add(field("PERSON", "rank", "GRADE_NAME"));
        f.add(field("PERSON", "leave_status", "LEAVE_TEXT"));
        Map<String, Object> rules = Map.of("UNIT", Map.of("column", "STATUS", "operator", "EQUALS", "values", List.of("1")),
                "PERSON", Map.of("column", "STATUS_DESC", "operator", "EQUALS", "values", List.of(SERVING)));
        Res draft = admin.post("/hr/mappings/draft", Map.of("fields", f, "activeRules", rules));
        assertThat(draft.status()).as(draft.toString()).isEqualTo(200);
        String id = draft.body().path("id").asText();
        assertThat(admin.post("/hr/mappings/" + id + "/discover", Map.of()).status()).isEqualTo(200);
        assertThat(admin.post("/hr/mappings/" + id + "/publish", Map.of()).status()).isEqualTo(200);
        UUID run = hrSync.run("SCHEDULED", null, null);
        assertThat(jdbc.sql("select status from hr_sync_run where id = :id").param("id", run).query(String.class).single()).isEqualTo("SUCCEEDED");
    }

    private void hrPerson(String id, String number, String name, String status) {
        jdbc.sql("insert into " + schema + ".people_t values (:i, :e, :n, :u, :s, :a, 'P1', 'مدير الأنظمة', 'رائد', null)")
                .param("i", "AP" + sfx + "-" + id).param("e", number).param("n", name).param("u", "AU" + sfx).param("s", status)
                .param("a", ("acct" + id + sfx).toUpperCase()).update();
    }

    @Test
    @DisplayName("ADM-4: an employee number is verified live in Oracle HR — not configured, unavailable, unknown and inactive are refused without writing anything; an active employee is imported and granted on confirmation")
    void employeeNumberThroughOracle() {
        String number = "9" + Math.abs(sfx.hashCode());
        Res unconfigured = admin.post("/administrators/resolve", lookup("EMPLOYEE_NUMBER", number));
        assertThat(unconfigured.status()).as(unconfigured.toString()).isEqualTo(409);
        assertThat(unconfigured.code()).isEqualTo("HR_SOURCE_NOT_CONFIGURED");

        oracle();
        hrPerson("1", number, "موظف الأنظمة", SERVING);
        hrPerson("2", number + "2", "موظف متقاعد", "متقاعد");
        long people = jdbc.sql("select count(*) from person").query(Long.class).single();

        assertThat(admin.post("/administrators/resolve", lookup("EMPLOYEE_NUMBER", number + "999")).status()).as("unknown").isEqualTo(404);
        assertThat(admin.post("/administrators/resolve", lookup("EMPLOYEE_NUMBER", number + "2")).status()).as("inactive in HR").isEqualTo(400);

        Res shown = admin.post("/administrators/resolve", lookup("EMPLOYEE_NUMBER", number));
        assertThat(shown.status()).as(shown.toString()).isEqualTo(200);
        assertThat(shown.body().path("verifiedBy").asText()).isEqualTo("ORACLE_HR");
        assertThat(shown.body().path("personId").isNull()).as("not in TMRKZ yet").isTrue();
        assertThat(shown.body().path("displayName").asText()).isEqualTo("موظف الأنظمة");
        assertThat(shown.body().path("unitName").asText()).isEqualTo("الجهة الإدارية الرئيسية");
        assertThat(jdbc.sql("select count(*) from person").query(Long.class).single()).as("showing writes nothing").isEqualTo(people);

        // HR not answering: a clear refusal, never a fallback record
        hrSource("wrong-password");
        Res down = admin.post("/administrators/resolve", lookup("EMPLOYEE_NUMBER", number));
        assertThat(down.status()).as(down.toString()).isEqualTo(503);
        assertThat(down.code()).isEqualTo("HR_SOURCE_UNAVAILABLE");
        hrSource("Reader#" + sfx);

        Res granted = admin.post("/administrators", confirm(shown.body(), "مسؤول أنظمة الجهة"));
        assertThat(granted.status()).as(granted.toString()).isEqualTo(200);
        UUID imported = UUID.fromString(granted.body().path("personId").asText());
        Map<String, Object> p = jdbc.sql("select source, employee_no, status from person where id = :p").param("p", imported).query().singleRow();
        assertThat(p).containsEntry("source", "HR").containsEntry("employee_no", number).containsEntry("status", "ACTIVE");
        assertThat(currentAdminGrants(imported)).isEqualTo(1);
        assertThat(jdbc.sql("select detail->>'importedFromHr' from audit_event where action = 'ADMIN_GRANTED' and entity_id = :p")
                .param("p", imported.toString()).query(String.class).single()).isEqualTo("true");
        assertThat(jdbc.sql("select count(*) from person where employee_no = :n").param("n", number).query(Long.class).single())
                .as("one identity").isEqualTo(1);
    }
}
