package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import javax.sql.DataSource;

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
import ae.mover.security.IdentityService;
import ae.mover.security.OidcClient;

/**
 * ADR-065 (owner decision, 16 Nov 2026): HR people come in one by one, as MOVER. Connecting HR copies nobody: the sync reads the
 * whole unit tree but only the linked people; a manager's live lookup writes nothing; «إضافة مستخدم» imports exactly one person
 * with no permission; a first sign-in imports that one active person with no permission; and the clean-up of an existing
 * installation removes only people nobody refers to. The source is the Oracle-compatible test source of {@code HrSyncAcceptanceIT}
 * (PostgreSQL views behind a SELECT-only login). Fictional units and people only.
 */
@Import(HrLinkedPeopleIT.SourceConnections.class)
class HrLinkedPeopleIT extends IntegrationTest {

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
    private static final String LEFT = "منتهية خدمته";

    @Autowired
    HrSyncService sync;
    @Autowired
    IdentityService identities;
    @Autowired
    DataSource dataSource;

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
        schema = "hrlp_" + sfx;
        reader = "hrlp_reader_" + sfx;
        exec("create schema " + schema,
                "create table " + schema + ".units_t (id text, name text, parent_id text, status int, code text)",
                "create table " + schema + ".people_t (person_id text, emp_no text, full_name text, unit_id text, status_desc text,"
                        + " account text, position_id text, position_name text, grade_name text, leave_text text, legacy_no text)",
                "create view " + schema + ".units_v as select * from " + schema + ".units_t",
                "create view " + schema + ".people_v as select * from " + schema + ".people_t",
                "create role " + reader + " login password 'Reader#" + sfx + "'",
                "grant usage on schema " + schema + " to " + reader,
                "grant select on " + schema + ".units_v, " + schema + ".people_v to " + reader);
        UUID root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
        unit("1", "الجهة الرئيسية", null);
        for (int i = 2; i <= 5; i++) {
            unit(String.valueOf(i), "إدارة " + i, "1");
        }
        // eight fictional people: 1→unit 2, 2→3, 3→4, 4→2, 5→3, 6→4, 7→5, 8→5 (8 has left the service)
        String[] units = {"2", "3", "4", "2", "3", "4", "5", "5"};
        for (int i = 1; i <= 8; i++) {
            personRow(String.valueOf(i), "موظف " + i, units[i - 1], i == 8 ? LEFT : SERVING);
        }
        configure();
        firstRun = run("SCHEDULED", null);
        assertThat(firstRun.path("status").asText()).as(firstRun.toString()).isEqualTo("SUCCEEDED");
    }

    JsonNode firstRun;

    /** A test source left enabled would be asked live by later classes' «إضافة مستخدم» and sign-ins. */
    @AfterEach
    void disableSource() {
        jdbc.sql("update hr_source set enabled = false").update();
    }

    // ---- fixtures -------------------------------------------------------------------------------------------

    private void exec(String... sql) {
        for (String s : sql) {
            jdbc.sql(s).update();
        }
    }

    private String u(String id) {
        return "U" + sfx + "-" + id;
    }

    private String p(String id) {
        return "P" + sfx + "-" + id;
    }

    private String number(String id) {
        return "N" + sfx + "-" + id;
    }

    /** The account as HR stores it (upper case); sign-ins and lookups use it in any case. */
    private String account(String id) {
        return ("ACCT" + id + "-" + sfx).toUpperCase();
    }

    private void unit(String id, String name, String parent) {
        jdbc.sql("insert into " + schema + ".units_t values (:i, :n, :p, 1, :c)")
                .param("i", u(id)).param("n", name).param("p", parent == null ? null : u(parent)).param("c", "C" + id).update();
    }

    private void personRow(String id, String name, String unitId, String status) {
        jdbc.sql("insert into " + schema + ".people_t values (:i, :e, :n, :u, :s, :a, :pos, :pn, null, null, :ln)")
                .param("i", p(id)).param("e", number(id)).param("n", name).param("u", u(unitId)).param("s", status)
                .param("a", account(id)).param("pos", "POS" + id).param("pn", "منصب " + id).param("ln", legacy(id)).update();
    }

    /** The earlier (legacy) number, MOVER's MILITARY_NUMBER beside the new one. */
    private String legacy(String id) {
        return "L" + sfx + "-" + id;
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
        src.put("peopleSync", true); // this suite checks linked people following HR in every run (ADR-094 keeps it behind the switch)
        assertThat(admin.put("/hr/source", src).status()).isEqualTo(200);
        List<Map<String, Object>> f = new ArrayList<>();
        f.add(field("UNIT", "external_unit_id", "ID"));
        f.add(field("UNIT", "name", "NAME"));
        f.add(field("UNIT", "parent_external_unit_id", "PARENT_ID"));
        f.add(field("UNIT", "status", "STATUS"));
        f.add(field("UNIT", "code", "CODE"));
        f.add(field("PERSON", "external_person_id", "PERSON_ID"));
        f.add(field("PERSON", "employee_number", "EMP_NO"));
        f.add(field("PERSON", "legacy_employee_number", "LEGACY_NO"));
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

    private JsonNode run(String trigger, String override) {
        UUID id = sync.run(trigger, null, override);
        Map<String, Object> r = jdbc.sql("select status, error_code, counts::text as counts from hr_sync_run where id = :id")
                .param("id", id).query().singleRow();
        return JSON.valueToTree(r);
    }

    private JsonNode counts(JsonNode run) throws Exception {
        return JSON.readTree(run.path("counts").asText());
    }

    private UUID orgOf(String unitId) {
        return jdbc.sql("select id from organization where source = 'HR' and source_external_id = :x").param("x", u(unitId))
                .query(UUID.class).single();
    }

    private UUID personOf(String id) {
        return jdbc.sql("select id from person where source = 'HR' and source_external_id = :x").param("x", p(id))
                .query(UUID.class).optional().orElse(null);
    }

    /** How many of this test's HR people exist in TMRKZ. */
    private long ourPeople() {
        return jdbc.sql("select count(*) from person where source = 'HR' and source_external_id like :x").param("x", "P" + sfx + "-%")
                .query(Long.class).single();
    }

    private long count(String sql, UUID person) {
        return jdbc.sql(sql).param("p", person).query(Long.class).single();
    }

    private Res lookup(Api a, UUID org, String key) {
        return a.get("/access/unit-members/lookup?organizationId=" + org + "&key=" + java.net.URLEncoder.encode(key, java.nio.charset.StandardCharsets.UTF_8));
    }

    private Res importInto(Api a, String unitId, String id) {
        return a.post("/access/unit-members", Map.of("organizationId", orgOf(unitId).toString(), "employeeNo", number(id)));
    }

    private OidcClient.Identity signIn(String key) {
        return new OidcClient.Identity("http://idp.test/realms/tmrkz", UUID.randomUUID().toString(), key, "دخول " + key, key,
                Instant.now(), null, "LOGIN", "/", null, false);
    }

    private String refusal(OidcClient.Identity id) {
        try {
            identities.resolve(id);
        } catch (ApiException e) {
            return String.valueOf(e.details().get("reason"));
        }
        return null;
    }

    // ---- tests ----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("LP-1: connecting HR copies nobody — the whole unit tree, but only linked people are read and projected")
    void syncReadsLinkedPeopleOnly() throws Exception {
        JsonNode first = counts(firstRun);
        assertThat(first.path("units").asInt()).isEqualTo(5);
        assertThat(first.path("organizationsCreated").asInt()).isEqualTo(5);
        // people linked by earlier tests' sources are asked for and not found here; nobody of this source is read
        assertThat(first.path("people").asInt()).isZero();
        assertThat(ourPeople()).as("no HR person becomes a TMRKZ person by connecting").isZero();
        assertThat(jdbc.sql("select count(*) from hr_person where external_id like :x").param("x", "P" + sfx + "-%").query(Long.class).single())
                .as("nor a mirror row").isZero();

        assertThat(importInto(admin, "4", "3").status()).isEqualTo(200);
        JsonNode second = run("SCHEDULED", null);
        assertThat(second.path("status").asText()).as(second.toString()).isEqualTo("SUCCEEDED");
        assertThat(counts(second).path("linkedPeople").asInt()).isEqualTo(first.path("linkedPeople").asInt() + 1);
        assertThat(counts(second).path("people").asInt()).isEqualTo(1);
        assertThat(ourPeople()).isEqualTo(1);
        assertThat(jdbc.sql("""
                select count(*) from hr_person h join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED'
                where h.external_id like :x""").param("x", "P" + sfx + "-%").query(Long.class).single())
                .as("the published snapshot holds the linked person only").isEqualTo(1);
    }

    @Test
    @DisplayName("LP-2: a linked person still follows HR — transfer, rank, leave, leaving the service, vanishing from the view")
    void linkedPersonFollowsHr() throws Exception {
        UUID one = personOfImported("2", "1");
        UUID two = personOfImported("3", "2");
        UUID three = personOfImported("4", "3");
        exec("update " + schema + ".people_t set unit_id = '" + u("5") + "', grade_name = 'عقيد', leave_text = 'إجازة سنوية' where person_id = '" + p("1") + "'",
                "update " + schema + ".people_t set status_desc = '" + LEFT + "' where person_id = '" + p("2") + "'",
                "delete from " + schema + ".people_t where person_id = '" + p("3") + "'",
                "update " + schema + ".people_t set full_name = 'اسم جديد' where person_id = '" + p("6") + "'");
        JsonNode r = run("SCHEDULED", null);
        assertThat(r.path("status").asText()).as(r.toString()).isEqualTo("SUCCEEDED");
        assertThat(counts(r).path("linkedNotInSource").asInt()).as("person 3; earlier tests' people were disabled by the first run")
                .isEqualTo(1);

        // transfer: the affiliation and the unit entry move with the person
        assertThat(jdbc.sql("select organization_id from affiliation where person_id = :p and valid_to is null").param("p", one)
                .query(UUID.class).single()).isEqualTo(orgOf("5"));
        assertThat(jdbc.sql("select ended_reason from unit_member where person_id = :p and organization_id = :o").param("p", one)
                .param("o", orgOf("2")).query(String.class).single()).isEqualTo("HR_TRANSFER");
        assertThat(jdbc.sql("select count(*) from unit_member where person_id = :p and organization_id = :o and ended_at is null")
                .param("p", one).param("o", orgOf("5")).query(Long.class).single()).isEqualTo(1);
        // rank and leave from the published snapshot
        assertThat(jdbc.sql("""
                select h.rank_name from hr_person h join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED'
                where h.external_id = :x""").param("x", p("1")).query(String.class).single()).isEqualTo("عقيد");
        assertThat(jdbc.sql("select hr_unavailable from person where id = :p").param("p", one).query(String.class).single())
                .isEqualTo("إجازة سنوية");
        // left the service, or vanished from the view: disabled, never deleted
        assertThat(jdbc.sql("select status from person where id = :p").param("p", two).query(String.class).single()).isEqualTo("DISABLED");
        assertThat(jdbc.sql("select status from person where id = :p").param("p", three).query(String.class).single()).isEqualTo("DISABLED");
        // the unlinked person's change reaches nothing in TMRKZ
        assertThat(personOf("6")).isNull();
        assertThat(ourPeople()).isEqualTo(3);
    }

    private UUID personOfImported(String unitId, String id) {
        Res r = importInto(admin, unitId, id);
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        return personOf(id);
    }

    @Test
    @DisplayName("LP-3: the live lookup finds an HR person not in TMRKZ inside the manager's reach, and writes nothing")
    void lookupWritesNothing() {
        String roleCode = role("LPMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        person("lpm3", roleCode, orgOf("3"));
        Api m3 = login("lpm3");
        String before = jdbc.sql("""
                select (select count(*) from person) || '/' || (select count(*) from hr_person) || '/' || (select count(*) from affiliation)
                       || '/' || (select count(*) from unit_member) || '/' || (select count(*) from hr_snapshot_scope)
                       || '/' || (select count(*) from audit_event)""").query(String.class).single();

        Res byNumber = lookup(admin, orgOf("2"), number("4"));
        assertThat(byNumber.status()).as(String.valueOf(byNumber.body())).isEqualTo(200);
        assertThat(byNumber.body().path("personId").isNull()).isTrue();
        assertThat(byNumber.body().path("importOnSave").asBoolean()).isTrue();
        assertThat(byNumber.body().path("displayName").asText()).isEqualTo("موظف 4");
        assertThat(byNumber.body().path("unitName").asText()).isEqualTo("إدارة 2");
        assertThat(byNumber.body().path("acting").asBoolean()).isFalse();
        // MOVER's lookup takes the new number or the earlier one (hr_live.find_person_by_number): the same person either way
        Res byLegacy = lookup(admin, orgOf("2"), legacy("4"));
        assertThat(byLegacy.status()).as("by the earlier number").isEqualTo(200);
        assertThat(byLegacy.body().path("displayName").asText()).isEqualTo("موظف 4");
        assertThat(byLegacy.body().path("importOnSave").asBoolean()).isTrue();
        Res byAccount = lookup(admin, orgOf("3"), account("4").toLowerCase());
        assertThat(byAccount.status()).as("by User ID, any case").isEqualTo(200);
        assertThat(byAccount.body().path("acting").asBoolean()).as("posted in unit 2").isTrue();

        // the manager of unit 3 finds unit 3's person, never unit 2's: the same answer as for someone unknown or inactive
        assertThat(lookup(m3, orgOf("3"), number("5")).status()).isEqualTo(200);
        Res outside = lookup(m3, orgOf("3"), number("4"));
        Res unknown = lookup(m3, orgOf("3"), "N" + sfx + "-nobody");
        Res inactive = lookup(admin, orgOf("5"), number("8"));
        assertThat(outside.status()).isEqualTo(404);
        assertThat(unknown.status()).isEqualTo(404);
        assertThat(inactive.status()).isEqualTo(404);
        assertThat(outside.body().path("message").asText()).isEqualTo(unknown.body().path("message").asText());

        String after = jdbc.sql("""
                select (select count(*) from person) || '/' || (select count(*) from hr_person) || '/' || (select count(*) from affiliation)
                       || '/' || (select count(*) from unit_member) || '/' || (select count(*) from hr_snapshot_scope)
                       || '/' || (select count(*) from audit_event)""").query(String.class).single();
        assertThat(after).as("a lookup writes nothing, not even the mirror").isEqualTo(before);
        assertThat(ourPeople()).isZero();
    }

    @Test
    @DisplayName("LP-4: «إضافة مستخدم» imports exactly one person, with no permission, as a user of the unit; audited")
    void importCreatesOnePerson() throws Exception {
        Res r = importInto(admin, "3", "5");
        assertThat(r.status()).as(String.valueOf(r.body())).isEqualTo(200);
        assertThat(r.body().path("already").asBoolean()).isFalse();
        UUID five = personOf("5");
        assertThat(five).isNotNull();
        assertThat(r.body().path("personId").asText()).isEqualTo(five.toString());
        assertThat(ourPeople()).as("that one person only").isEqualTo(1);
        assertThat(count("select count(*) from membership where person_id = :p", five)).as("no permission").isZero();
        assertThat(count("select count(*) from delegation where delegate_id = :p", five)).isZero();
        assertThat(jdbc.sql("select organization_id from unit_member where person_id = :p and ended_at is null").param("p", five)
                .query(UUID.class).single()).isEqualTo(orgOf("3"));
        assertThat(jdbc.sql("select organization_id from affiliation where person_id = :p and valid_to is null").param("p", five)
                .query(UUID.class).single()).isEqualTo(orgOf("3"));
        assertThat(jdbc.sql("select status || '|' || display_name || '|' || employee_no from person where id = :p").param("p", five)
                .query(String.class).single()).isEqualTo("ACTIVE|موظف 5|" + number("5"));
        assertThat(jdbc.sql("""
                select count(*) from hr_person h join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED'
                where h.external_id like :x""").param("x", "P" + sfx + "-%").query(Long.class).single())
                .as("one mirror row, that person's").isEqualTo(1);
        assertThat(jdbc.sql("select detail->>'via' from audit_event where action = 'HR_PERSON_IMPORTED' and entity_id = :p")
                .param("p", five.toString()).query(String.class).single()).isEqualTo("UNIT_MEMBER");
        assertThat(jdbc.sql("select count(*) from hr_linked_person where id = :p").param("p", five).query(Long.class).single())
                .as("linked from now on").isEqualTo(1);

        // found in TMRKZ from now on; adding again changes nothing
        Res again = lookup(admin, orgOf("3"), number("5"));
        assertThat(again.body().path("personId").asText()).isEqualTo(five.toString());
        assertThat(importInto(admin, "3", "5").body().path("already").asBoolean()).isTrue();
        assertThat(ourPeople()).isEqualTo(1);
        // an inactive HR person is not imported
        assertThat(importInto(admin, "5", "8").status()).isEqualTo(404);
        assertThat(personOf("8")).isNull();
        // the next sync reads them
        JsonNode next = run("SCHEDULED", null);
        assertThat(counts(next).path("linkedPeople").asInt()).isEqualTo(counts(firstRun).path("linkedPeople").asInt() + 1);
        assertThat(counts(next).path("people").asInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("LP-5: a first sign-in imports that one active HR person with no permission; inactive, unknown, ambiguous refused")
    void firstSignInImportsOnePerson() {
        OidcClient.Identity six = signIn(account("6").toLowerCase());
        UUID person = identities.resolve(six);
        assertThat(person).isEqualTo(personOf("6"));
        assertThat(ourPeople()).isEqualTo(1);
        assertThat(count("select count(*) from membership where person_id = :p", person)).as("no permission").isZero();
        assertThat(count("select count(*) from unit_member where person_id = :p", person)).as("a user of no unit").isZero();
        assertThat(count("select count(*) from identity_link where person_id = :p", person)).isEqualTo(1);
        assertThat(jdbc.sql("select detail->>'via' from audit_event where action = 'HR_PERSON_IMPORTED' and entity_id = :p")
                .param("p", person.toString()).query(String.class).single()).isEqualTo("SIGN_IN");
        assertThat(identities.resolve(six)).as("the next sign-in is the same person").isEqualTo(person);
        assertThat(ourPeople()).isEqualTo(1);

        assertThat(refusal(signIn(account("8")))).isEqualTo("INACTIVE");
        assertThat(refusal(signIn("nobody-" + sfx))).isEqualTo("NO_MATCH");
        // a second HR record holding person 7's account: never linked automatically
        exec("insert into " + schema + ".people_t values ('" + p("7b") + "', '" + number("7b") + "', 'سجل آخر', '" + u("5") + "', '"
                + SERVING + "', '" + account("7") + "', null, null, null, null)");
        assertThat(refusal(signIn(account("7")))).isEqualTo("AMBIGUOUS");
        assertThat(ourPeople()).as("refusals create nobody").isEqualTo(1);
        assertThat(jdbc.sql("""
                select count(*) from identity_link_issue where reason in ('INACTIVE', 'NO_MATCH', 'AMBIGUOUS') and lower(claimed_key) like :k""")
                .param("k", "%" + sfx + "%").query(Long.class).single()).as("each refusal is on the review list").isEqualTo(3);
    }

    // ---- clean-up of an existing installation -------------------------------------------------------------------

    /** Runs ops/hr-prune-unlinked.sql as the operator would; the step counts it prints. */
    private Map<String, Long> prune(boolean apply) throws Exception {
        String sql = Files.readString(Path.of("../ops/hr-prune-unlinked.sql"));
        Map<String, Long> out = new LinkedHashMap<>();
        try (Connection c = dataSource.getConnection(); Statement st = c.createStatement()) {
            st.execute("set tmrkz.prune_apply = '" + (apply ? "on" : "off") + "'");
            boolean rows = st.execute(sql);
            while (true) {
                if (rows) {
                    try (ResultSet rs = st.getResultSet()) {
                        while (rs.next()) {
                            out.put(rs.getString(1), rs.getLong(2));
                        }
                    }
                } else if (st.getUpdateCount() == -1) {
                    break;
                }
                rows = st.getMoreResults();
            }
            st.execute("set tmrkz.prune_apply = 'off'");
        }
        return out;
    }

    /** A person as the projection made them before ADR-065: every HR employee, with an affiliation and a mirror row. */
    private UUID copied(String code) {
        UUID id = UUID.randomUUID();
        String ext = "Q" + sfx + "-" + code;
        jdbc.sql("insert into person(id, employee_no, display_name, source, source_external_id) values (:id, :e, :n, 'HR', :x)")
                .param("id", id).param("e", "QN" + sfx + "-" + code).param("n", "منسوخ " + code).param("x", ext).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (:id, :p, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("p", id).param("o", orgOf("2")).update();
        mirrorRow(ext, "QN" + sfx + "-" + code);
        return id;
    }

    private void mirrorRow(String ext, String number) {
        jdbc.sql("""
                insert into hr_person(snapshot_id, external_id, employee_number, full_name, unit_external_id, active)
                select id, :x, :n, 'منسوخ', :u, true from hr_snapshot where status = 'PUBLISHED'""")
                .param("x", ext).param("n", number).param("u", u("2")).update();
    }

    private boolean exists(UUID person) {
        return count("select count(*) from person where id = :p", person) == 1;
    }

    @Test
    @DisplayName("LP-6: the clean-up counts first and changes nothing; applied, it removes only unlinked people nobody refers to")
    void pruneRemovesOnlyUnreferenced() throws Exception {
        UUID adminId = jdbc.sql("select id from person where username = :u").param("u", "admin-" + sfx).query(UUID.class).single();
        UUID plain = copied("plain");                    // copied, nothing refers to it: removed
        UUID removedUser = copied("removed");            // once added to a unit, since removed: referenced, kept
        jdbc.sql("""
                insert into unit_member(id, person_id, organization_id, acting, added_by, added_at, ended_at, ended_by, ended_reason)
                values (:id, :p, :o, false, :a, now() - interval '1 day', now(), :a, 'اختبار')""")
                .param("id", UUID.randomUUID()).param("p", removedUser).param("o", orgOf("2")).param("a", adminId).update();
        UUID signedIn = copied("signed");                // signed in once: linked, kept
        jdbc.sql("insert into identity_link(id, person_id, issuer, subject, method) values (:id, :p, 'http://idp.test', :s, 'ENTERPRISE_KEY')")
                .param("id", UUID.randomUUID()).param("p", signedIn).param("s", "sub-" + sfx).update();
        UUID audited = copied("audited");                // named in the audit trail: kept
        jdbc.sql("insert into audit_event(actor_name, action, entity_type, entity_id) values ('test', 'HR_AFFILIATION_CHANGED', 'PERSON', :p)")
                .param("p", audited.toString()).update();
        mirrorRow("Q" + sfx + "-never", "QN" + sfx + "-never"); // an HR employee never projected: their mirror row goes
        long mirrorOf = jdbc.sql("select count(*) from hr_person where external_id like :x").param("x", "Q" + sfx + "-%").query(Long.class).single();
        assertThat(mirrorOf).isEqualTo(5);

        Map<String, Long> dry = prune(false);
        assertThat(dry.get("applied")).isZero();
        assertThat(dry.get("hr_people_to_remove")).isGreaterThanOrEqualTo(1);
        assertThat(dry.get("hr_people_kept_referenced")).isGreaterThanOrEqualTo(2);
        assertThat(dry.get("mirror_rows_to_remove")).isGreaterThanOrEqualTo(2);
        assertThat(dry.get("hr_people_unlinked")).isEqualTo(dry.get("hr_people_to_remove") + dry.get("hr_people_kept_referenced"));
        assertThat(List.of(plain, removedUser, signedIn, audited)).allMatch(this::exists);
        assertThat(count("select count(*) from affiliation where person_id = :p", plain)).as("a dry run changes nothing").isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from hr_person where external_id like :x").param("x", "Q" + sfx + "-%").query(Long.class).single())
                .isEqualTo(5);

        Map<String, Long> applied = prune(true);
        assertThat(applied.get("applied")).isEqualTo(1);
        assertThat(exists(plain)).isFalse();
        assertThat(count("select count(*) from affiliation where person_id = :p", plain)).isZero();
        assertThat(List.of(removedUser, signedIn, audited)).as("a referenced or linked person is never removed").allMatch(this::exists);
        assertThat(jdbc.sql("select external_id from hr_person where external_id like :x order by external_id").param("x", "Q" + sfx + "-%")
                .query(String.class).list()).containsExactly("Q" + sfx + "-audited", "Q" + sfx + "-removed", "Q" + sfx + "-signed");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'HR_UNLINKED_PRUNED'").query(Long.class).single()).isPositive();

        Map<String, Long> again = prune(false);
        assertThat(again.get("applied")).isZero();
        assertThat(List.of(removedUser, signedIn, audited)).as("re-runnable").allMatch(this::exists);
    }
}
