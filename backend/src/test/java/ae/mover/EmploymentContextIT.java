package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.CookieManager;
import java.net.URI;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
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
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.common.ApiException;
import ae.mover.hr.HrConnectionFactory;
import ae.mover.hr.HrSourceAdapter;
import ae.mover.hr.HrSyncService;
import ae.mover.security.DirectoryProfile;
import ae.mover.security.EmploymentContextResolver;
import ae.mover.security.IdentityService;
import ae.mover.security.OidcClient;

/**
 * ADR-068 (LDAP specification §2-5, 25, 26, tests SOURCE-01…04): one employment context — the directory before Oracle, Oracle
 * after. People sign in first while Oracle is not in force (the HR source is configured but has never published a snapshot),
 * are created with nothing and placed by the directory's Unit ID; then Oracle's first sync publishes and the same people sign in
 * again: they are moved onto their HR records (the SAME person, never a second), the unit node is the same, Oracle decides the
 * unit, and a disagreeing directory unit is audited once. The source is the Oracle-compatible test source of
 * {@code HrLinkedPeopleIT} (PostgreSQL views behind a SELECT-only login). Fictional units and people only.
 */
@Import(EmploymentContextIT.SourceConnections.class)
class EmploymentContextIT extends IntegrationTest {

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

    private static final String SERVING = "في الخدمة";
    private static final String ISSUER = "http://idp.test/realms/tmrkz";

    @Autowired
    HrSyncService sync;
    @Autowired
    IdentityService identities;
    @Autowired
    EmploymentContextResolver employment;

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
        schema = "ecx_" + sfx;
        reader = "ecx_reader_" + sfx;
        exec("create schema " + schema,
                "create table " + schema + ".units_t (id text, name text, parent_id text, status int, code text)",
                "create table " + schema + ".people_t (person_id text, emp_no text, full_name text, unit_id text, status_desc text,"
                        + " account text, position_id text, position_name text, grade_name text, leave_text text)",
                "create view " + schema + ".units_v as select * from " + schema + ".units_t",
                "create view " + schema + ".people_v as select * from " + schema + ".people_t",
                "create role " + reader + " login password 'Reader#" + sfx + "'",
                "grant usage on schema " + schema + " to " + reader,
                "grant select on " + schema + ".units_v, " + schema + ".people_v to " + reader);
        UUID root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
        unitRow("1", "الجهة الرئيسية", null);
        unitRow("2", "إدارة العمليات", "1");
        unitRow("3", "إدارة الإسناد", "1");
        personRow("1", "موظف أول", "2", "عقيد");
        personRow("2", "موظف ثان", "3", "رائد");
        configure();
    }

    @AfterEach
    void sourceOff() {
        jdbc.sql("update hr_source set enabled = false").update();
    }

    // ---- fixtures ---------------------------------------------------------------------------------------------

    private void exec(String... sql) {
        for (String s : sql) {
            jdbc.sql(s).update();
        }
    }

    private String u(String id) {
        return "EU" + sfx + "-" + id;
    }

    private String number(String id) {
        return "EN" + sfx + "-" + id;
    }

    private String account(String id) {
        return ("eacct" + id + "-" + sfx).toLowerCase();
    }

    private void unitRow(String id, String name, String parent) {
        jdbc.sql("insert into " + schema + ".units_t values (:i, :n, :p, 1, :c)")
                .param("i", u(id)).param("n", name).param("p", parent == null ? null : u(parent)).param("c", "C" + id).update();
    }

    private void personRow(String id, String name, String unitId, String rank) {
        jdbc.sql("insert into " + schema + ".people_t values (:i, :e, :n, :u, :s, :a, :pos, :pn, :g, null)")
                .param("i", "EP" + sfx + "-" + id).param("e", number(id)).param("n", name).param("u", u(unitId)).param("s", SERVING)
                .param("a", account(id).toUpperCase()).param("pos", "POS" + id).param("pn", "منصب " + id).param("g", rank).update();
    }

    /** A unit TMRKZ already holds before Oracle, carrying its Unit ID (the join with the directory). */
    private UUID unitWithId(String code, UUID parent, String unitId) {
        UUID id = org(code, parent);
        jdbc.sql("update organization set source_external_id = :x where id = :id").param("x", unitId).param("id", id).update();
        return id;
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

    /** The HR source and its published mapping — saved, but no snapshot yet: Oracle is not in force. */
    private void configure() {
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
        assertThat(admin.put("/hr/source", src).status()).isEqualTo(200);
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
    }

    /** A verified directory sign-in (the provider path), stating what the directory knows about the person's employment. */
    private OidcClient.Identity signIn(String subject, String account, String employeeNumber, String unitId) {
        return new OidcClient.Identity(ISSUER, subject, account, "دخول " + account, account, Instant.now(), null, "LOGIN", "/", null, false,
                new DirectoryProfile(employeeNumber, "رتبة الدليل", "منصب الدليل", unitId, "وحدة كما في الدليل", null, true));
    }

    private String refusal(OidcClient.Identity id) {
        try {
            identities.resolve(id);
        } catch (ApiException e) {
            return String.valueOf(e.details().get("reason"));
        }
        return null;
    }

    private long count(String sql, Object p) {
        return jdbc.sql(sql).param("p", p).query(Long.class).single();
    }

    /** The person's own session (opened as the callback opens it after a verified sign-in). */
    private Api session(UUID person) {
        var r = auth.issueSession(person, ISSUER, null, Instant.now(), "127.0.0.1", "acceptance-test");
        Api api = new Api();
        java.net.HttpCookie cookie = new java.net.HttpCookie(ae.mover.security.SessionFilter.COOKIE, r.token());
        cookie.setPath("/");
        cookie.setVersion(0);
        ((CookieManager) api.http.cookieHandler().orElseThrow()).getCookieStore().add(URI.create("http://localhost:" + port), cookie);
        return api;
    }

    private JsonNode firstSync() {
        UUID run = sync.run("SCHEDULED", null, null);
        Map<String, Object> r = jdbc.sql("select status, error_code, counts::text as counts from hr_sync_run where id = :id")
                .param("id", run).query().singleRow();
        assertThat(r.get("status")).as(r.toString()).isEqualTo("SUCCEEDED");
        return JSON.valueToTree(r);
    }

    // ---- tests ------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("SOURCE-01…04: the directory places people before Oracle; after activation the same people and the same unit nodes, Oracle's unit wins and the disagreement is audited once")
    void directoryThenOracle() throws Exception {
        UUID main = unitWithId("U1", null, u("1"));
        UUID ops = unitWithId("U2", main, u("2"));
        UUID support = unitWithId("U3", main, u("3"));
        long unitNodes = jdbc.sql("select count(*) from organization").query(Long.class).single();

        // ---- SOURCE-01: Oracle configured but not in force (no published snapshot): the directory decides ----
        assertThat(employment.mode()).isEqualTo(EmploymentContextResolver.Source.LDAP);
        String sub1 = "sub-1-" + sfx;
        String sub2 = "sub-2-" + sfx;
        // person 1: the directory states Oracle's employee number and the same unit Oracle will
        UUID one = identities.resolve(signIn(sub1, account("1"), number("1"), u("2")));
        // person 2: the directory carries no employee number and states a unit Oracle disagrees with (Oracle: unit 3)
        UUID two = identities.resolve(signIn(sub2, account("2"), null, u("2")));
        for (UUID p : List.of(one, two)) {
            assertThat(jdbc.sql("select source from person where id = :p").param("p", p).query(String.class).single()).isEqualTo("LOCAL");
            assertThat(count("select count(*) from membership where person_id = :p", p)).as("no grant").isZero();
            assertThat(count("select count(*) from unit_member where person_id = :p", p)).as("no unit entry").isZero();
        }
        EmploymentContextResolver.Context before = employment.of(one);
        assertThat(before.source()).isEqualTo(EmploymentContextResolver.Source.LDAP);
        assertThat(before.unitOrgId()).isEqualTo(ops);
        assertThat(before.unitExternalId()).isEqualTo(u("2"));
        assertThat(before.rank()).isEqualTo("رتبة الدليل");
        assertThat(employment.of(two).unitOrgId()).isEqualTo(ops);
        assertThat(employment.of(two).employeeNo()).as("a placeholder is never shown as a number").isNull();
        assertThat(count("select count(*) from person where employee_no = :p", "DIR-" + account("2"))).isEqualTo(1);
        // Oracle not in force: a sign-in nobody holds is still a zero-access person, never refused for HR
        UUID three = identities.resolve(signIn("sub-3-" + sfx, account("3"), null, null));
        assertThat(employment.of(three).unitOrgId()).isNull();

        // ---- Oracle's first sync publishes: Oracle in force ----
        JsonNode run = firstSync();
        assertThat(employment.mode()).isEqualTo(EmploymentContextResolver.Source.ORACLE);
        // SOURCE-03: the Unit ID is the join — the units TMRKZ held are Oracle's now, no second node
        assertThat(jdbc.sql("select count(*) from organization").query(Long.class).single()).as(run.toString()).isEqualTo(unitNodes);
        for (String id : List.of("1", "2", "3")) {
            assertThat(count("select count(*) from organization where source_external_id = :p", u(id))).isEqualTo(1);
        }
        assertThat(jdbc.sql("select source from organization where id = :p").param("p", ops).query(String.class).single()).isEqualTo("HR");
        assertThat(jdbc.sql("select name from organization where id = :p").param("p", ops).query(String.class).single())
                .as("Oracle's name").isEqualTo("إدارة العمليات");
        // connecting copies nobody: the directory people are still as they were until they sign in again (ADR-065)
        assertThat(jdbc.sql("select source from person where id = :p").param("p", one).query(String.class).single()).isEqualTo("LOCAL");

        // ---- SOURCE-02 / §25: person 1 signs in again: the SAME person moves onto the HR record; Oracle's unit ----
        assertThat(identities.resolve(signIn(sub1, account("1"), number("1"), u("2")))).isEqualTo(one);
        Map<String, Object> p1 = jdbc.sql("select source, source_external_id, employee_no, display_name from person where id = :p")
                .param("p", one).query().singleRow();
        assertThat(p1).containsEntry("source", "HR").containsEntry("source_external_id", "EP" + sfx + "-1")
                .containsEntry("employee_no", number("1")).containsEntry("display_name", "موظف أول");
        assertThat(count("select count(*) from person where employee_no = :p", number("1"))).as("never a second person").isEqualTo(1);
        assertThat(count("select count(*) from person where source_external_id = :p", "EP" + sfx + "-1")).isEqualTo(1);
        assertThat(count("select count(*) from membership where person_id = :p", one)).as("still nothing granted").isZero();
        EmploymentContextResolver.Context after = employment.of(one);
        assertThat(after.source()).isEqualTo(EmploymentContextResolver.Source.ORACLE);
        assertThat(after.unitOrgId()).as("the same unit node, now from Oracle").isEqualTo(ops);
        assertThat(after.rank()).as("Oracle's rank, not the directory's").isEqualTo("عقيد");
        assertThat(count("select count(*) from audit_event where action = 'IDENTITY_ORG_SOURCE_MISMATCH' and entity_id = :p", one.toString()))
                .as("the directory and Oracle agree").isZero();

        // ---- SOURCE-04 / §26: person 2 — no directory number, a disagreeing unit: Oracle's number and unit win ----
        assertThat(identities.resolve(signIn(sub2, account("2"), null, u("2")))).isEqualTo(two);
        assertThat(jdbc.sql("select employee_no from person where id = :p").param("p", two).query(String.class).single()).isEqualTo(number("2"));
        assertThat(count("select count(*) from person where employee_no like :p", "DIR-" + account("2"))).isZero();
        EmploymentContextResolver.Context oracle = employment.of(two);
        assertThat(oracle.unitOrgId()).as("Oracle wins the placement").isEqualTo(support);
        assertThat(oracle.unitExternalId()).isEqualTo(u("3"));
        assertThat(count("select count(*) from audit_event where action = 'IDENTITY_ORG_SOURCE_MISMATCH' and entity_id = :p", two.toString()))
                .isEqualTo(1);
        Map<String, Object> detail = jdbc.sql("""
                select detail ->> 'directoryUnitId' as d, detail ->> 'oracleUnitId' as o from audit_event
                where action = 'IDENTITY_ORG_SOURCE_MISMATCH' and entity_id = :p""").param("p", two.toString()).query().singleRow();
        assertThat(detail).containsEntry("d", u("2")).containsEntry("o", u("3"));
        // once per change: signing in again with the same disagreement audits nothing more
        identities.resolve(signIn(sub2, account("2"), null, u("2")));
        assertThat(count("select count(*) from audit_event where action = 'IDENTITY_ORG_SOURCE_MISMATCH' and entity_id = :p", two.toString()))
                .isEqualTo(1);
        // the person sees Oracle's unit only — nothing of the directory's
        JsonNode who = session(two).get("/access-requests/mine").body().path("identity");
        assertThat(who.path("sourceCode").asText()).isEqualTo("ORACLE");
        assertThat(who.path("unit").asText()).isEqualTo("إدارة الإسناد");
        assertThat(who.path("unitConfigured").asBoolean()).isTrue();
        assertThat(who.toString()).doesNotContain(u("2")).doesNotContain("إدارة العمليات").doesNotContain("وحدة كما في الدليل");
        assertThat(who.path("rank").asText()).isEqualTo("رائد");

        // ---- Oracle in force: someone neither TMRKZ nor Oracle knows is refused, as ADR-065 — no zero-access record any more ----
        String outsider = account("9");
        assertThat(refusal(signIn("sub-9-" + sfx, outsider, null, u("2")))).isEqualTo("NO_MATCH");
        assertThat(count("select count(*) from person where lower(username) = :p", outsider)).isZero();
        // the person created before Oracle and unknown to it stays as they are, signed in, with no unit from Oracle
        assertThat(identities.resolve(signIn("sub-3-" + sfx, account("3"), null, null))).isEqualTo(three);
        assertThat(employment.of(three).unitOrgId()).isNull();
        assertThat(count("select count(*) from audit_event where action = 'IDENTITY_SOURCE_TRANSITION_DEFERRED' and entity_id = :p",
                three.toString())).isEqualTo(1);
    }
}
