package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;

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
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.IntegrationTest;
import ae.mover.hr.HrConnectionFactory;
import ae.mover.hr.HrSourceAdapter;
import ae.mover.hr.HrSyncService;

/**
 * Journey G of the Stationing V3 acceptance (owner gate of 4 Nov 2026, §10) through the HR synchronisation path the
 * application uses — never a direct hierarchy update: the read-only source views change a parent, the manual sync
 * ({@code POST /hr/sync}, the same {@link HrSyncService} run as the hourly one) projects and publishes the snapshot, the
 * publication event reaches Stationing, the request under review pauses with the owner's message, the earlier route
 * stays in history, the requester reconfirms, the route is derived again from the same requesting unit, every approval
 * runs again, activation waits for it; then the hierarchy is restored through the same sync. The source is the
 * Oracle-compatible test source of {@code HrSyncAcceptanceIT} (PostgreSQL views behind a read-only account), because
 * the acceptance environment has no HR source attached. Fictional units, levels and people only.
 */
@Import(RestationingHrSyncIT.SourceConnections.class)
class RestationingHrSyncIT extends IntegrationTest {

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

    String schema;
    String reader;
    Api admin;
    double lat0, lng0;

    @BeforeEach
    void source() {
        // one HR source per installation: earlier tests' source and snapshots are cleared, never their projections
        jdbc.sql("delete from hr_sync_issue").update();
        jdbc.sql("delete from hr_unit").update();
        jdbc.sql("delete from hr_person").update();
        jdbc.sql("delete from hr_snapshot").update();
        jdbc.sql("delete from hr_sync_run").update();
        jdbc.sql("delete from hr_mapping_version").update();
        jdbc.sql("delete from hr_source").update();
        schema = "hrg_" + sfx;
        reader = "hrg_reader_" + sfx;
        exec("create schema " + schema,
                "create table " + schema + ".units_t (id text, name text, parent_id text, status int, code text, lvl int)",
                "create table " + schema + ".people_t (person_id text, emp_no text, full_name text, unit_id text, status_desc text)",
                "create view " + schema + ".units_v as select * from " + schema + ".units_t",
                "create view " + schema + ".people_v as select * from " + schema + ".people_t",
                "create role " + reader + " login password 'Reader#" + sfx + "'",
                "grant usage on schema " + schema + " to " + reader,
                "grant select on " + schema + ".units_v, " + schema + ".people_v to " + reader);
        UUID root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
        // far from every other test's fixtures
        lat0 = 23.4 + Math.random() * 0.4;
        lng0 = 53.0 + Math.random() * 0.4;
    }

    @Test
    @DisplayName("G: an HR parent change, synchronised and published, pauses the request; reconfirmation rebuilds the route; restored by the sync")
    void hierarchyChangeThroughHrSync() throws Exception {
        // the test HR source: TOP (L6) ← DEPT_A, DEPT_B (L7) ← SEC (L8) under DEPT_A
        unit("TOP", null, 6);
        unit("DEPT_A", "TOP", 7);
        unit("DEPT_B", "TOP", 7);
        unit("SEC", "DEPT_A", 8);
        personRow("1", "موظف اختبار 1", "SEC");
        personRow("2", "موظف اختبار 2", "DEPT_B");
        configure();
        JsonNode first = syncNow();
        assertThat(first.path("status").asText()).as(first.toString()).isEqualTo("SUCCEEDED");
        UUID top = orgOf("TOP"), deptA = orgOf("DEPT_A"), deptB = orgOf("DEPT_B"), sec = orgOf("SEC");
        assertThat(parentOf(sec)).isEqualTo(deptA);

        // people, seats and the starting stationing on the synchronised units
        person("req", role("GREQ", "ORGANIZATION", "CREATE_RESTATIONING", "VIEW"), sec);
        String seat = role("GSEAT", "ORGANIZATION", "APPROVE", "VIEW");
        person("apSec", seat, sec);
        person("apA", seat, deptA);
        person("apB", seat, deptB);
        person("apTop", seat, top);
        person("activator", role("GACT", "ORGANIZATION", "ACTIVATE_STATIONING", "VIEW"), top);
        person("sysadmin", role("GPOL", "ALL", "CONFIGURE"), top);
        stationed(sec, siteWithBoundary("GSEC", lat0, lng0, sec));
        Res published = publishPolicy();
        assertThat(published.status()).as(published.toString()).isEqualTo(200);

        // a request from SEC (L8): SEC → DEPT_A → TOP; two stages decided before the change
        Res created = login("req").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "content", permanent(sec)));
        assertThat(created.status()).as(created.toString()).isEqualTo(200);
        String id = created.body().path("id").asText();
        Res submitted = login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(submitted.status()).as(submitted.toString()).isEqualTo(200);
        assertThat(keys(submitted.body().path("route"))).containsExactly("H:" + sec, "H:" + deptA, "H:" + top);
        assertThat(decide("apSec", id).status()).isEqualTo(200);
        assertThat(decide("apA", id).status()).isEqualTo(200);

        // 1–3. the HR source changes SEC's parent; the application's sync processes and publishes it
        exec("update " + schema + ".units_t set parent_id = '" + u("DEPT_B") + "' where id = '" + u("SEC") + "'");
        JsonNode moved = syncNow();
        assertThat(moved.path("status").asText()).as(moved.toString()).isEqualTo("SUCCEEDED");
        assertThat(parentOf(sec)).as("the projection follows the source").isEqualTo(deptB);
        assertThat(jdbc.sql("select count(*) from hr_snapshot where status = 'PUBLISHED' and run_id = cast(:r as uuid)")
                .param("r", moved.path("id").asText()).query(Long.class).single()).as("the new snapshot is published").isEqualTo(1);

        // 4–6. the publication reached Stationing: the request is paused with the owner's message
        JsonNode paused = login("req").get("/restationing-requests/" + id).body();
        assertThat(paused.path("state").asText()).isEqualTo("PAUSED_HIERARCHY_CHANGED");
        assertThat(paused.path("paused").path("reason").asText()).isEqualTo(HierarchyDrift.MESSAGE).isEqualTo("تغير الهيكل التنظيمي بعد تقديم الطلب");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'RESTATIONING_PAUSED' and entity_id = :id").param("id", id)
                .query(Long.class).single()).isEqualTo(1);
        Res refused = decide("apTop", id);
        assertThat(refused.status()).isEqualTo(400);
        assertThat(refused.body().path("message").asText()).contains(HierarchyDrift.MESSAGE);
        assertThat(login("activator").post("/restationing-requests/" + id + "/activate", Map.of()).status()).isEqualTo(400);

        // 7–9. reconfirmation (a reason is required) derives a new route from the same requesting unit; the old one is kept
        assertThat(login("req").post("/restationing-requests/" + id + "/submit", Map.of()).status()).isEqualTo(400);
        Res rebuilt = login("req").post("/restationing-requests/" + id + "/submit", Map.of("reason", "أؤكد الطلب بالهيكل الجديد"));
        assertThat(rebuilt.status()).as(rebuilt.toString()).isEqualTo(200);
        assertThat(rebuilt.body().path("requestingUnit").path("id").asText()).isEqualTo(sec.toString());
        assertThat(rebuilt.body().path("routeNo").asInt()).isEqualTo(2);
        assertThat(keys(rebuilt.body().path("route"))).containsExactly("H:" + sec, "H:" + deptB, "H:" + top);
        assertThat(marks(rebuilt.body().path("route"))).containsOnly("null");
        JsonNode previous = rebuilt.body().path("previousRoutes").get(0).path("stages");
        assertThat(keys(previous)).containsExactly("H:" + sec, "H:" + deptA, "H:" + top);
        assertThat(marks(previous)).containsExactly("APPROVED", "APPROVED", "null");

        // 10–11. every approval runs again; activation stays blocked until they are done
        assertThat(decide("apA", id).status()).as("the earlier route's seat no longer decides").isIn(403, 404);
        assertThat(decide("apSec", id).status()).isEqualTo(200);
        assertThat(login("activator").post("/restationing-requests/" + id + "/activate", Map.of()).status()).isEqualTo(400);
        assertThat(decide("apB", id).status()).isEqualTo(200);
        assertThat(login("activator").post("/restationing-requests/" + id + "/activate", Map.of()).status()).isEqualTo(400);
        assertThat(decide("apTop", id).status()).isEqualTo(200);
        Res activated = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(activated.status()).as(activated.toString()).isEqualTo(200);
        assertThat(activated.body().path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");

        // restored through the same synchronisation path
        exec("update " + schema + ".units_t set parent_id = '" + u("DEPT_A") + "' where id = '" + u("SEC") + "'");
        JsonNode restored = syncNow();
        assertThat(restored.path("status").asText()).as(restored.toString()).isEqualTo("SUCCEEDED");
        assertThat(parentOf(sec)).isEqualTo(deptA);
    }

    // ---- the test HR source --------------------------------------------------------------------------------

    private void exec(String... sql) {
        for (String s : sql) {
            jdbc.sql(s).update();
        }
    }

    private String u(String id) {
        return "G" + sfx + "-" + id;
    }

    private void unit(String id, String parent, int level) {
        jdbc.sql("insert into " + schema + ".units_t values (:i, :n, :p, 1, :c, :l)")
                .param("i", u(id)).param("n", "وحدة اختبار " + id).param("p", parent == null ? null : u(parent))
                .param("c", "G" + id + "-" + sfx).param("l", level).update();
    }

    private void personRow(String id, String name, String unitId) {
        jdbc.sql("insert into " + schema + ".people_t values (:i, :e, :n, :u, 'في الخدمة')")
                .param("i", "GP" + sfx + "-" + id).param("e", "GN" + sfx + "-" + id).param("n", name).param("u", u(unitId)).update();
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

    /** The source, its mapping (with the HR level) and publication, all through the API as in HrSyncAcceptanceIT. */
    private void configure() {
        Map<String, Object> src = new LinkedHashMap<>();
        src.put("name", "مصدر الموارد البشرية للاختبار");
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
        List<Map<String, Object>> fields = new ArrayList<>(List.of(
                field("UNIT", "external_unit_id", "ID"), field("UNIT", "name", "NAME"), field("UNIT", "parent_external_unit_id", "PARENT_ID"),
                field("UNIT", "status", "STATUS"), field("UNIT", "code", "CODE"), field("UNIT", "level", "LVL"),
                field("PERSON", "external_person_id", "PERSON_ID"), field("PERSON", "employee_number", "EMP_NO"),
                field("PERSON", "full_name", "FULL_NAME"), field("PERSON", "unit_external_id", "UNIT_ID"),
                field("PERSON", "status_text", "STATUS_DESC")));
        Map<String, Object> rules = Map.of("UNIT", Map.of("column", "STATUS", "operator", "EQUALS", "values", List.of("1")),
                "PERSON", Map.of("column", "STATUS_DESC", "operator", "EQUALS", "values", List.of("في الخدمة")));
        Res draft = admin.post("/hr/mappings/draft", Map.of("fields", fields, "activeRules", rules));
        assertThat(draft.status()).as(draft.toString()).isEqualTo(200);
        String mapping = draft.body().path("id").asText();
        assertThat(admin.post("/hr/mappings/" + mapping + "/discover", Map.of()).status()).isEqualTo(200);
        Res pub = admin.post("/hr/mappings/" + mapping + "/publish", Map.of());
        assertThat(pub.status()).as(pub.toString()).isEqualTo(200);
    }

    /** The administrator's «تحديث الآن» ({@code POST /hr/sync}): the same run as the hourly sync, awaited. */
    private JsonNode syncNow() throws InterruptedException {
        Res accepted = admin.post("/hr/sync", Map.of());
        assertThat(accepted.status()).as(accepted.toString()).isEqualTo(202);
        String run = accepted.body().path("runId").asText();
        for (int i = 0; i < 300 && (sync.running() || jdbc.sql("select count(*) from hr_sync_run where id = cast(:r as uuid) and finished_at is not null")
                .param("r", run).query(Long.class).single() == 0); i++) {
            Thread.sleep(100);
        }
        return JSON.valueToTree(jdbc.sql("select id::text as id, status, error_code, counts::text as counts from hr_sync_run where id = cast(:r as uuid)")
                .param("r", run).query().singleRow());
    }

    private UUID orgOf(String unitId) {
        return jdbc.sql("select id from organization where source = 'HR' and source_external_id = :x").param("x", u(unitId))
                .query(UUID.class).single();
    }

    private UUID parentOf(UUID org) {
        return jdbc.sql("select parent_id from organization where id = :id").param("id", org).query(UUID.class).single();
    }

    // ---- the request -----------------------------------------------------------------------------------------

    private Res decide(String user, String id) {
        return login(user).post("/restationing-requests/" + id + "/decision", Map.of("decision", "APPROVE"));
    }

    private Map<String, Object> permanent(UUID unit) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("kind", "PERMANENT");
        c.put("scope", List.of(unit.toString()));
        c.put("site", Map.of("geometry", RestationingWorkflowIT.square(lat0 - 0.01, lng0, 0.0008), "shape", "DRAWN"));
        double lng = 6_000 / (111_320 * Math.cos(Math.toRadians(lat0)));
        c.put("primary", RestationingWorkflowIT.square(lat0 - 0.01, lng0 + lng, 0.002));
        c.put("alternative", RestationingWorkflowIT.square(lat0 - 0.01 + 4_000 / 110_900.0, lng0 + lng, 0.002));
        c.put("reason", "نقل إداري لاختبار تغير الهيكل");
        return c;
    }

    /** Levels 6–8 approve (L6 final); the hierarchy stages rest on the facts of the owner model (V2 §4.5). */
    private Res publishPolicy() {
        String version = "g-" + sfx;
        UUID ds = UUID.randomUUID();
        jdbc.sql("""
                insert into terrain_dataset(id, code, version, surface_model, slope_encoding, manifest, slope_sha256)
                values (:id, 'TEST_SLOPE', :v, 'DSM', 'SLOPE_PERCENT_X100_FLOOR_U16', '{}', 'test')""").param("id", ds).param("v", version).update();
        jdbc.sql("insert into terrain_slope(dataset_id, rast) select :id, ST_AddBand(ST_MakeEmptyRaster(1, 1, 0, 0, 0.001, -0.001, 0, 0, 4326), '16BUI'::text, 100, 65535)")
                .param("id", ds).update();
        List<String> facts = List.of("SCOPE", "CLASSIFICATION", "DURATION", "SITE", "DEPLOYMENT");
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("maxFootprintAreaM2", 500_000);
        p.put("deploymentRequirement", "REQUIRED");
        p.put("primary", Map.of("minM", 5000, "maxM", 8000, "terrainApplies", false));
        p.put("alternative", Map.of("minM", 3000, "maxM", 5000, "terrainApplies", false));
        p.put("terrainSlopeClassification", Map.of("datasetCode", "TEST_SLOPE", "datasetVersion", version, "classes", StationingFoundationIT.classes()));
        p.put("terrainAllowancesM", StationingFoundationIT.allowances());
        p.put("terrainClassPriority", List.of("MOUNTAINOUS", "HILLY", "ROLLING", "UNDULATING", "FLAT"));
        p.put("terrainAppliesTo", "MAX_ONLY");
        p.put("exception", Map.of("allowed", false, "maxExtraM", 0));
        p.put("crossBranch", Map.of("allowed", false, "authorities", List.of(), "independent", false));
        p.put("routing", Map.of("startAt", "SELF", "levels", List.of(
                Map.of("level", 8, "approves", true, "label", "اعتماد المستوى L8", "finalStage", false, "dependsOn", facts),
                Map.of("level", 7, "approves", true, "label", "اعتماد المستوى L7", "finalStage", false, "dependsOn", facts),
                Map.of("level", 6, "approves", true, "label", "اعتماد المستوى L6", "finalStage", true, "dependsOn", List.of()))));
        return login("sysadmin").post("/stationing/policy/versions", Map.of("values", p, "reason", "سياسة اختبار تغير الهيكل", "reference", "اختبار G"));
    }

    private UUID siteWithBoundary(String code, double lat, double lng, UUID responsible) {
        UUID id = site(code, null, responsible);
        jdbc.sql("update site set lat = :lat, lng = :lng where id = :id").param("lat", lat).param("lng", lng).param("id", id).update();
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type)
                select gen_random_uuid(), :id, 1, ST_AsGeoJSON(g)::jsonb, 'EPSG:4326', 'اختبار', now(), g, 'Polygon'
                  from (select ST_SetSRID(ST_MakeEnvelope(:w, :s, :e, :n), 4326) as g) x""")
                .param("id", id).param("w", lng - 0.0006).param("s", lat - 0.0005).param("e", lng + 0.0006).param("n", lat + 0.0005).update();
        jdbc.sql("update site set geometry_version = 1 where id = :id").param("id", id).update();
        return id;
    }

    private void stationed(UUID org, UUID site) {
        jdbc.sql("""
                insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
                values (gen_random_uuid(), :o, :s, 'PERMANENT', now() - interval '1 day', 'CORRECTION', 'تمركز للاختبار',
                        (select id from person order by created_at limit 1))""")
                .param("o", org).param("s", site).update();
    }

    private static List<String> keys(JsonNode route) {
        return RestationingWorkflowIT.keys(route);
    }

    private static List<String> marks(JsonNode route) {
        return RestationingWorkflowIT.marks(route);
    }
}
