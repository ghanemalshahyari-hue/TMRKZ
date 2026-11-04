package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.IntegrationTest;

/**
 * Shared fixtures of the re-stationing integration tests (ADR-033, ADR-034): fictional HR-shaped units with levels
 * L6–L10 in the published snapshot, seats, sites with boundaries, starting stationing and a published policy, and the
 * request helpers. Fictional data only.
 */
abstract class RestationingTestBase extends IntegrationTest {

    private static final int CELL_START = (int) (Math.random() * 48);
    private static final AtomicInteger CELLS = new AtomicInteger();

    @Autowired
    RestationingService service;

    UUID top, dept, sec, team, other, otherSec, sSec, sOther;
    double lat0, lng0;

    @BeforeEach
    void fixtures() {
        UUID snapshot = publishedSnapshot();
        top = hrOrg("TOP", null, 6, snapshot);
        dept = hrOrg("DEPT", top, 7, snapshot);
        sec = hrOrg("SEC", dept, 8, snapshot);
        team = hrOrg("TEAM", sec, 10, snapshot);
        other = hrOrg("OTHER", top, 7, snapshot);
        otherSec = hrOrg("OSEC", other, 8, snapshot);
        // far from every other test's fixtures (they sit near 25.2 N, 55.3 E), and each test in a cell of its own: the
        // shared test database keeps earlier tests' sites and deployment areas, and a layout reaches 12 km east
        int cell = Math.floorMod(CELL_START + CELLS.getAndIncrement(), 48);
        lat0 = 21.0 + (cell / 8) * 0.15;
        lng0 = 52.0 + (cell % 8) * 0.3;
        sSec = siteWithBoundary("SSEC", lat0, lng0, sec);
        sOther = siteWithBoundary("SOTH", lat0, lng0 + 0.02, other);
        person("req", role("RSREQ", "ORGANIZATION", "CREATE_RESTATIONING", "VIEW"), sec);
        String seat = role("RSSEAT", "ORGANIZATION", "APPROVE", "VIEW");
        person("apSec", seat, sec);
        person("apDept", seat, dept);
        person("apTop", seat, top);
        person("apOther", seat, other);
        person("activator", role("RSACT", "ORGANIZATION", "ACTIVATE_STATIONING", "VIEW"), top);
        person("exc", role("RSEXC", "ALL", "APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION", "VIEW"), top);
        person("sysadmin", role("RSPOL", "ALL", "CONFIGURE"), top);
        person("stranger", role("RSVIEW", "ORGANIZATION", "VIEW"), other);
        stationed(sec, sSec);
        stationed(team, sSec);
        stationed(otherSec, sOther);
        Res published = publishPolicy(false);
        assertThat(published.status()).as(published.toString()).isEqualTo(200);
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    String approvedPermanent(List<UUID> scope) {
        String id = create("req", permanent(scope));
        Res submitted = login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(submitted.status()).as(submitted.toString()).isEqualTo(200);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        assertThat(decide("apTop", id, "APPROVE").body().path("state").asText()).isEqualTo("APPROVED_NOT_ACTIVATED");
        return id;
    }

    String create(String who, Map<String, Object> content) {
        Res r = login(who).post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "content", content));
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        return r.body().path("id").asText();
    }

    Res decide(String who, String id, String decision) {
        return login(who).post("/restationing-requests/" + id + "/decision", Map.of("decision", decision));
    }

    List<String> problems(String id) {
        return texts(login("req").get("/restationing-requests/" + id + "/checks").body().path("problems"));
    }

    Map<String, Object> permanent(List<UUID> scope) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("kind", "PERMANENT");
        c.put("scope", scope.stream().map(UUID::toString).toList());
        c.put("site", Map.of("geometry", square(lat0 - 0.01, lng0, 0.0008), "shape", "COPY"));
        c.put("primary", square(lat0 - 0.01, lng0 + offsetLng(6_000), 0.002));
        c.put("alternative", square(lat0 - 0.01 + offsetLat(4_000), lng0 + offsetLng(6_000), 0.002));
        c.put("reason", "نقل إداري للاختبار");
        return c;
    }

    Map<String, Object> temporary(List<UUID> scope, Instant start, Instant end) {
        Map<String, Object> c = permanent(scope);
        c.put("kind", "TEMPORARY");
        c.put("start", start.toString());
        c.put("end", end.toString());
        return c;
    }

    double offsetLng(double m) {
        return m / (111_320 * Math.cos(Math.toRadians(lat0)));
    }

    static double offsetLat(double m) {
        return m / 110_900;
    }

    static Map<String, Object> square(double lat, double lng, double h) {
        return Map.of("type", "Polygon", "coordinates", List.of(List.of(List.of(lng - h, lat - h), List.of(lng + h, lat - h),
                List.of(lng + h, lat + h), List.of(lng - h, lat + h), List.of(lng - h, lat - h))));
    }

    Res publishPolicy(boolean independent) {
        String dataset = dataset();
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("maxFootprintAreaM2", 200_000);
        p.put("deploymentRequirement", "REQUIRED");
        p.put("primary", Map.of("minM", 5000, "maxM", 8000, "terrainApplies", false));
        p.put("alternative", Map.of("minM", 3000, "maxM", 5000, "terrainApplies", false));
        p.put("terrainSlopeClassification", Map.of("datasetCode", "TEST_SLOPE", "datasetVersion", dataset, "classes", StationingFoundationIT.classes()));
        p.put("terrainAllowancesM", StationingFoundationIT.allowances());
        p.put("terrainClassPriority", List.of("UNDULATING", "FLAT", "ROLLING", "HILLY", "MOUNTAINOUS"));
        p.put("terrainAppliesTo", "MAX_ONLY");
        p.put("exception", Map.of("allowed", true, "maxExtraM", 1000));
        p.put("crossBranch", Map.of("allowed", true, "authorities", List.of("OTHER_UNIT"), "independent", independent));
        p.put("routing", Map.of("startAt", "SELF", "levels", List.of(
                Map.of("level", 10, "approves", false, "label", "الفريق", "finalStage", false, "dependsOn", List.of()),
                Map.of("level", 8, "approves", true, "label", "اعتماد القسم", "finalStage", false, "dependsOn", List.of("SCOPE", "SITE", "DURATION")),
                Map.of("level", 7, "approves", true, "label", "اعتماد الإدارة", "finalStage", false, "dependsOn", List.of("SCOPE")),
                Map.of("level", 6, "approves", true, "label", "الاعتماد النهائي", "finalStage", true, "dependsOn", List.of()))));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("values", p);
        body.put("reason", "سياسة اختبار سير العمل");
        body.put("reference", "اختبار 1");
        return login("sysadmin").post("/stationing/policy/versions", body);
    }

    /** A one-cell synthetic slope dataset (the policy names a loaded dataset; these legs apply no terrain). */
    String dataset() {
        String version = "w-" + sfx + "-" + (int) (Math.random() * 1e6);
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into terrain_dataset(id, code, version, surface_model, slope_encoding, manifest, slope_sha256)
                values (:id, 'TEST_SLOPE', :v, 'DSM', 'SLOPE_PERCENT_X100_FLOOR_U16', '{}', 'test')""").param("id", id).param("v", version).update();
        jdbc.sql("insert into terrain_slope(dataset_id, rast) select :id, ST_AddBand(ST_MakeEmptyRaster(1, 1, 0, 0, 0.001, -0.001, 0, 0, 4326), '16BUI'::text, 100, 65535)")
                .param("id", id).update();
        return version;
    }

    UUID publishedSnapshot() {
        UUID s = jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).optional().orElse(null);
        if (s != null) {
            return s;
        }
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        s = UUID.randomUUID();
        jdbc.sql("insert into hr_source(id, name) values (:id, 'مصدر اختبار')").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'DRAFT', '{}', '{}')")
                .param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, trigger, status, started_at) values (:id, 'MANUAL', 'SUCCEEDED', now())").param("id", run).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())")
                .param("id", s).param("r", run).param("m", mapping).update();
        return s;
    }

    UUID hrOrg(String code, UUID parent, int level, UUID snapshot) {
        UUID id = UUID.randomUUID();
        String ext = code + "-" + sfx;
        jdbc.sql("""
                insert into organization(id, code, name, parent_id, valid_from, source, source_external_id)
                values (:id, :c, :n, :p, '2026-01-01T00:00:00Z', 'HR', :e)""")
                .param("id", id).param("c", "HR-" + ext).param("n", "وحدة " + code).param("p", parent).param("e", ext).update();
        jdbc.sql("insert into hr_unit(snapshot_id, external_id, name, active, level) values (:s, :e, :n, true, :l)")
                .param("s", snapshot).param("e", ext).param("n", "وحدة " + code).param("l", level).update();
        return id;
    }

    /** The Oracle sync (and only it) changes an HR parent: simulated through the projection's guard. */
    void moveUnder(UUID unit, UUID parent) {
        tx.executeWithoutResult(s -> {
            jdbc.sql("select set_config('tmrkz.hr_projection', 'on', true)").query().singleRow();
            jdbc.sql("update organization set parent_id = :p where id = :id").param("p", parent).param("id", unit).update();
        });
    }

    UUID siteWithBoundary(String code, double lat, double lng, UUID responsible) {
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

    void stationed(UUID org, UUID site) {
        stationed(org, site, false);
    }

    void stationed(UUID org, UUID site, boolean replace) {
        if (replace) {
            jdbc.sql("update org_stationing set valid_to = now(), end_reason = 'CORRECTED', ended_at = now() where organization_id = :o and valid_to is null")
                    .param("o", org).update();
        }
        jdbc.sql("""
                insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
                values (gen_random_uuid(), :o, :s, 'PERMANENT', case when :r then now() else now() - interval '1 day' end,
                        'CORRECTION', 'تمركز للاختبار', (select id from person order by created_at limit 1))""")
                .param("o", org).param("s", site).param("r", replace).update();
    }

    String seatRole() {
        return jdbc.sql("select m.role_code from membership m where m.person_id = :p").param("p", personId("apSec")).query(String.class).list().get(0);
    }

    /** A second person record of the same human (a sign-in linked to apSec's employee number). */
    UUID secondRecordOf(String username, String role, UUID org) {
        UUID alias = person("aliasApSec", role, org);
        jdbc.sql("""
                insert into identity_link_issue(id, issuer, subject, claimed_key, display_name, reason, resolved_at, resolved_person_id, resolution)
                values (:id, :i, :s, :k, 'حساب ثانٍ', 'ALREADY_LINKED', now(), :p, 'LINKED')""")
                .param("id", UUID.randomUUID()).param("i", "https://idp-alt.test/" + sfx).param("s", "alt-" + sfx)
                .param("k", ("t-" + username + "-" + sfx).toUpperCase()).param("p", alias).update();
        return alias;
    }

    UUID personId(String username) {
        return jdbc.sql("select id from person where username = :u").param("u", username + "-" + sfx).query(UUID.class).single();
    }

    static List<String> keys(JsonNode route) {
        List<String> out = new ArrayList<>();
        route.forEach(s -> out.add(s.path("key").asText()));
        return out;
    }

    static List<String> marks(JsonNode route) {
        List<String> out = new ArrayList<>();
        route.forEach(s -> out.add(s.path("mark").isNull() ? "null" : s.path("mark").asText()));
        return out;
    }

    static List<String> texts(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }
}
