package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * «موقع جديد» of «تهيئة المواقع والتمركز» (ADR-067, owner's full acceptance specification of 16 Nov 2026), on real PostgreSQL +
 * PostGIS with OpenFGA in the loop: the site, its initial stationing and each unit's two deployment areas in one audited save;
 * any refusal leaves nothing behind; only the setup administrator (facilities and corrections over everything) may do it; and
 * what it writes reads exactly as an activated request's. Fictional data only; the policy is the base's test policy (REQUIRED,
 * primary 5–8 km, alternative 3–5 km, no terrain).
 */
class SiteSetupIT extends RestationingTestBase {

    UUID fresh, fresh2;
    double siteLat;

    @BeforeEach
    void setupFixtures() {
        UUID snapshot = publishedSnapshot();
        fresh = hrOrg("SUA", sec, 10, snapshot);
        fresh2 = hrOrg("SUB", sec, 10, snapshot);
        // about 10 km north of the base's sites, inside this test's own cell
        siteLat = lat0 + 0.09;
        person("setup", role("SUADM", "ALL", "VIEW", "MANAGE_FACILITIES", "MANAGE_SITE_LINKS", "CORRECT_STATIONING"), top);
        person("facOnly", role("SUFAC", "ALL", "VIEW", "MANAGE_FACILITIES"), top);
        person("unitSetup", role("SUORG", "ORGANIZATION", "VIEW", "MANAGE_FACILITIES", "CORRECT_STATIONING"), top);
        person("rqOnly", role("SUREQ", "ORGANIZATION", "VIEW", "CREATE_RESTATIONING", "REQUEST_SITE_REGISTRATION"), sec);
        person("postureViewer", role("SUPOST", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), sec);
    }

    // ---- bodies -------------------------------------------------------------------------------------------------------

    private String siteName(String tag) {
        return "موقع تهيئة " + tag + " " + sfx;
    }

    private Map<String, Object> siteInput(String tag) {
        Map<String, Object> site = new LinkedHashMap<>();
        site.put("code", "");
        site.put("name", siteName(tag));
        site.put("kind", "معسكر");
        site.put("responsibleOrgId", null);
        site.put("location", Map.of("lat", siteLat, "lng", lng0));
        return site;
    }

    private Map<String, Object> boundaryInput() {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("geometry", square(siteLat, lng0, 0.0008));
        b.put("crs", "EPSG:4326");
        b.put("expectedVersion", 0);
        b.put("method", "DRAWN");
        return b;
    }

    private Map<String, Object> body(String tag, List<Map<String, Object>> units) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("site", siteInput(tag));
        b.put("boundary", boundaryInput());
        b.put("units", units);
        b.put("reason", "تهيئة الموقع وتمركزه الأولي للاختبار");
        b.put("reference", "اختبار التهيئة");
        return b;
    }

    /** A unit with both areas: the primary 6 km from the site (east, or west for {@code side} 1), the alternative 4 km north of it. */
    private Map<String, Object> unit(UUID org, int side) {
        double lng = lng0 + (side == 0 ? 1 : -1) * offsetLng(6_000);
        Map<String, Object> u = new LinkedHashMap<>();
        u.put("organizationId", org.toString());
        u.put("primary", square(siteLat, lng, 0.002));
        u.put("alternative", square(siteLat + offsetLat(4_000), lng, 0.002));
        return u;
    }

    private Map<String, Object> bare(UUID org) {
        return Map.of("organizationId", org.toString());
    }

    private long count(String sql, Object... params) {
        var q = jdbc.sql(sql);
        for (int i = 0; i < params.length; i++) {
            q = q.param("p" + i, params[i]);
        }
        return q.query(Long.class).single();
    }

    private long sitesNamed(String tag) {
        return count("select count(*) from site where name = :p0", siteName(tag));
    }

    private long stationings(UUID org) {
        return count("select count(*) from org_stationing where organization_id = :p0", org);
    }

    private long areas(UUID org) {
        return count("select count(*) from deployment_area where organization_id = :p0", org);
    }

    private long setupAudits(String tag) {
        return count("select count(*) from audit_event where action = 'SITE_SETUP_BOOTSTRAPPED' and entity_label = :p0", siteName(tag));
    }

    private static List<String> problems(Res r) {
        List<String> out = new ArrayList<>();
        r.body().path("details").path("problems").forEach(n -> out.add(n.asText()));
        if (out.isEmpty()) {
            out.add(r.body().path("message").asText());
        }
        return out;
    }

    // ---- tests ----------------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("SETUP-01 the setup administrator registers a site, two units' stationing and their four areas in one audited save; a resend changes nothing")
    void bootstrapsAtomically() {
        Res r = login("setup").post("/site-setup", body("A", List.of(unit(fresh, 0), unit(fresh2, 1))), "setup-a-" + sfx);
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        UUID site = UUID.fromString(r.body().path("site").path("id").asText());
        assertThat(r.body().path("site").path("code").asText()).as("the server gives the code").startsWith("S-");
        assertThat(r.body().path("units")).hasSize(2);

        Map<String, Object> row = jdbc.sql("select geometry_version, name from site where id = :s").param("s", site).query().singleRow();
        assertThat(row.get("geometry_version")).as("the boundary is registered with the site").isEqualTo(1);
        for (UUID org : List.of(fresh, fresh2)) {
            Map<String, Object> st = jdbc.sql("""
                    select site_id, origin, request_id, kind, valid_to, reason, reference from org_stationing where organization_id = :o""")
                    .param("o", org).query().singleRow();
            assertThat(st.get("site_id")).isEqualTo(site);
            assertThat(st.get("origin")).isEqualTo("SETUP");
            assertThat(st.get("request_id")).isNull();
            assertThat(st.get("kind")).isEqualTo("PERMANENT");
            assertThat(st.get("valid_to")).isNull();
            assertThat(st.get("reference")).isEqualTo("اختبار التهيئة");
            assertThat(count("""
                    select count(*) from deployment_area a join org_stationing s on s.id = a.stationing_id
                     where a.organization_id = :p0 and a.origin = 'SETUP' and a.request_id is null and a.state = 'ACTIVE' and a.site_id = :p1""", org, site))
                    .as("both areas on the unit's own stationing record").isEqualTo(2);
            assertThat(count("""
                    select count(*) from stationing_outbox where organization_id = :p0 and event_type = 'STATIONING_CORRECTED' and payload->>'siteId' = :p1""",
                    org, site.toString())).as("the event a correction writes").isEqualTo(1);
        }
        assertThat(count("select count(*) from deployment_area where site_id = :p0", site)).isEqualTo(4);
        assertThat(setupAudits("A")).as("one audit event for the whole setup").isEqualTo(1);
        assertThat(count("select count(*) from audit_event where action = 'STATIONING_CORRECTED' and detail->>'siteId' = :p0", site.toString()))
                .as("no per-unit correction audit").isZero();
        JsonNode detail = readTree(jdbc.sql("select detail::text from audit_event where action = 'SITE_SETUP_BOOTSTRAPPED' and entity_id = :p")
                .param("p", site.toString()).query(String.class).single());
        assertThat(detail.path("siteId").asText()).isEqualTo(site.toString());
        assertThat(detail.path("units")).hasSize(2);
        assertThat(detail.path("units").get(0).path("areas").path("PRIMARY").asText()).isNotBlank();
        assertThat(jdbc.sql("select reason from audit_event where action = 'SITE_SETUP_BOOTSTRAPPED' and entity_id = :p").param("p", site.toString())
                .query(String.class).single()).isEqualTo("تهيئة الموقع وتمركزه الأولي للاختبار");

        // the same key and body again: the first save's answer, never a second site
        Res again = login("setup").post("/site-setup", body("A", List.of(unit(fresh, 0), unit(fresh2, 1))), "setup-a-" + sfx);
        assertThat(again.status()).as(again.toString()).isEqualTo(200);
        assertThat(again.body().path("site").path("id").asText()).isEqualTo(site.toString());
        assertThat(sitesNamed("A")).isEqualTo(1);
        assertThat(setupAudits("A")).isEqualTo(1);
        // a second save of the same units (another key) is refused: they are stationed now
        Res twice = login("setup").post("/site-setup", body("A2", List.of(unit(fresh, 0))));
        assertThat(twice.status()).isEqualTo(400);
        assertThat(sitesNamed("A2")).isZero();
    }

    @Test
    @DisplayName("SETUP-07 «مدير النظام» holds the setup (ADR-076): the six-step save stations its unit with both areas; «تثبيت» on a site's card stations another; still no request content")
    void systemAdministratorSetsUp() {
        person("platformAdmin", "SYSTEM_ADMIN", top);
        Api admin = login("platformAdmin");
        Res r = admin.post("/site-setup", body("ADM", List.of(unit(fresh, 0))), "setup-adm-" + sfx);
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        UUID site = UUID.fromString(r.body().path("site").path("id").asText());
        assertThat(jdbc.sql("select origin from org_stationing where organization_id = :o and site_id = :s and valid_to is null")
                .param("o", fresh).param("s", site).query(String.class).single()).as("stationed by the setup").isEqualTo("SETUP");
        assertThat(count("select count(*) from deployment_area where site_id = :p0 and state = 'ACTIVE'", site)).isEqualTo(2);
        Res fixed = admin.post("/stationing/corrections", Map.of("organizationId", fresh2.toString(), "siteId", site.toString(),
                "reason", "الجهة المسؤولة هي الوحدة المتمركزة"));
        assertThat(fixed.status()).as("«تثبيت» on the site's card: " + fixed).isEqualTo(200);
        assertThat(admin.get("/me").body().path("permissions").toString()).as("still no reading or deciding")
                .contains("CORRECT_STATIONING", "MANAGE_SITE_LINKS").doesNotContain("\"VIEW\"", "APPROVE");
    }

    @Test
    @DisplayName("SETUP-02 a unit already stationed is refused and nothing at all is written (no site, no stationing, no area, no audit, no event)")
    void stationedUnitRefused() {
        long outboxBefore = count("select count(*) from stationing_outbox where organization_id = :p0", fresh);
        Res r = login("setup").post("/site-setup", body("B", List.of(unit(fresh, 0), unit(sec, 1))));
        assertThat(r.status()).as(r.toString()).isEqualTo(400);
        assertThat(String.join(" ", problems(r))).contains("متمركزة حالياً");
        assertThat(sitesNamed("B")).as("no half site").isZero();
        assertThat(stationings(fresh)).isZero();
        assertThat(areas(fresh)).isZero();
        assertThat(setupAudits("B")).isZero();
        assertThat(count("select count(*) from audit_event where action = 'SITE_CREATED' and entity_label = :p0", siteName("B"))).isZero();
        assertThat(count("select count(*) from stationing_outbox where organization_id = :p0", fresh)).isEqualTo(outboxBefore);
    }

    @Test
    @DisplayName("SETUP-03 an area out of range, or over occupied ground, is refused by the request path's own leg rule and nothing is written; the review says why, writing nothing")
    void legsRefused() {
        // the primary 20 km away: outside 5–8 km (and beyond the exception's extra kilometre)
        Map<String, Object> far = unit(fresh, 0);
        far.put("primary", square(siteLat, lng0 + offsetLng(20_000), 0.002));
        far.put("alternative", square(siteLat + offsetLat(4_000), lng0 + offsetLng(20_000), 0.002));
        Res check = login("setup").post("/site-setup/check", body("C", List.of(far)));
        assertThat(check.status()).as(check.toString()).isEqualTo(200);
        assertThat(check.body().path("ok").asBoolean()).isFalse();
        JsonNode legs = check.body().path("units").get(0).path("legs");
        assertThat(legs.get(0).path("status").asText()).isEqualTo("OUT_OF_RANGE");
        assertThat(legs.get(0).path("effectiveMaxM").asDouble()).as("the range of the policy in force").isEqualTo(8000);
        assertThat(sitesNamed("C")).as("the review registers nothing").isZero();
        assertThat(count("select count(*) from audit_event where entity_label = :p0", siteName("C"))).isZero();

        Res r = login("setup").post("/site-setup", body("C", List.of(far)));
        assertThat(r.status()).as(r.toString()).isEqualTo(400);
        assertThat(String.join(" ", problems(r))).contains("خارج النطاق المسموح");
        assertThat(sitesNamed("C")).isZero();
        assertThat(stationings(fresh)).isZero();
        assertThat(areas(fresh)).isZero();

        // the alternative right over the base's occupied site (sec and team are stationed there), 4 km from a primary 6 km south of the new site
        Map<String, Object> occupied = new LinkedHashMap<>();
        occupied.put("organizationId", fresh.toString());
        occupied.put("primary", square(siteLat - offsetLat(6_000), lng0, 0.002));
        occupied.put("alternative", square(lat0, lng0, 0.002));
        Res o = login("setup").post("/site-setup", body("D", List.of(occupied)));
        assertThat(o.status()).as(o.toString()).isEqualTo(400);
        assertThat(String.join(" ", problems(o))).contains("تتداخل مع أرض مشغولة").contains("موقع SSEC");
        assertThat(sitesNamed("D")).isZero();
        assertThat(stationings(fresh)).isZero();
        assertThat(areas(fresh)).isZero();
        assertThat(setupAudits("D")).isZero();

        // a clean pair passes the review and the save
        Res ok = login("setup").post("/site-setup/check", body("E", List.of(unit(fresh, 0))));
        assertThat(ok.body().path("ok").asBoolean()).as(ok.toString()).isTrue();
        assertThat(ok.body().path("units").get(0).path("legs").get(1).path("status").asText()).isEqualTo("OK");
        assertThat(sitesNamed("E")).isZero();
        assertThat(login("setup").post("/site-setup", body("E", List.of(unit(fresh, 0)))).status()).isEqualTo(200);
        assertThat(sitesNamed("E")).isEqualTo(1);
    }

    @Test
    @DisplayName("SETUP-04 only facilities AND corrections over everything: facilities alone, a unit-scoped holder of both, or a stationing requester get 403 and write nothing")
    void onlyTheSetupAdministrator() {
        for (String who : List.of("facOnly", "unitSetup", "rqOnly")) {
            Res r = login(who).post("/site-setup", body("F" + who, List.of(unit(fresh, 0))));
            assertThat(r.status()).as(who + " " + r).isEqualTo(403);
            assertThat(login(who).post("/site-setup/check", body("F" + who, List.of(unit(fresh, 0)))).status()).as(who).isEqualTo(403);
            assertThat(sitesNamed("F" + who)).isZero();
        }
        assertThat(stationings(fresh)).isZero();
        // the facilities manager keeps today's three-step creation of the site alone
        Map<String, Object> site = siteInput("Fsite");
        site.put("reason", "تسجيل موقع للاختبار");
        Map<String, Object> boundary = boundaryInput();
        boundary.put("reason", "تسجيل موقع للاختبار");
        Res made = login("facOnly").post("/sites/with-boundary", Map.of("site", site, "boundary", boundary));
        assertThat(made.status()).as(made.toString()).isEqualTo(200);
        assertThat(sitesNamed("Fsite")).isEqualTo(1);
    }

    @Test
    @DisplayName("SETUP-05 SETUP rows read exactly like activated ones: hub, posture, register; a correction retires the areas with their record")
    void readsLikeActivated() {
        Res r = login("setup").post("/site-setup", body("G", List.of(unit(fresh, 0))));
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        String site = r.body().path("site").path("id").asText();

        JsonNode hub = login("rqOnly").get("/request-hub/units/" + fresh).body();
        assertThat(hub.path("state").asText()).as("both areas in force").isEqualTo("DEPLOYMENT_COMPLETE");
        assertThat(hub.path("site").path("id").asText()).isEqualTo(site);

        JsonNode posture = login("postureViewer").get("/operational-posture").body();
        JsonNode one = null;
        for (JsonNode u : posture.path("units")) {
            if (fresh.toString().equals(u.path("id").asText())) {
                one = u;
            }
        }
        assertThat(one).as(posture.toString()).isNotNull();
        assertThat(one.path("site").path("id").asText()).isEqualTo(site);
        assertThat(one.path("kind").asText()).isEqualTo("PERMANENT");
        assertThat(one.path("primary").path("type").asText()).isEqualTo("Polygon");
        assertThat(one.path("alternative").path("type").asText()).isEqualTo("Polygon");

        JsonNode current = login("setup").get("/stationing/current?orgId=" + fresh).body();
        assertThat(current).hasSize(1);
        assertThat(current.get(0).path("siteId").asText()).isEqualTo(site);
        assertThat(current.get(0).path("origin").asText()).isEqualTo("SETUP");

        // an audited correction moves the unit: its SETUP areas retire with the record they belong to, as an activated request's do
        Res moved = login("setup").post("/stationing/corrections", Map.of("organizationId", fresh.toString(), "siteId", sOther.toString(),
                "reason", "تصحيح بعد التهيئة للاختبار"));
        assertThat(moved.status()).as(moved.toString()).isEqualTo(200);
        assertThat(count("select count(*) from deployment_area where organization_id = :p0 and state = 'ACTIVE'", fresh)).isZero();
        assertThat(count("select count(*) from deployment_area where organization_id = :p0 and state = 'RETIRED' and origin = 'SETUP'", fresh)).isEqualTo(2);
    }

    @Test
    @DisplayName("SETUP-06 the policy decides whether areas are required: REQUIRED refuses a unit without them; OPTIONAL accepts none, never one alone")
    void requirementFromPolicy() {
        Res none = login("setup").post("/site-setup", body("H", List.of(bare(fresh))));
        assertThat(none.status()).as(none.toString()).isEqualTo(400);
        assertThat(String.join(" ", problems(none))).contains("منطقتا الانتشار الرئيسية والبديلة مطلوبتان");
        assertThat(sitesNamed("H")).isZero();
        assertThat(stationings(fresh)).isZero();

        // OPTIONAL in force (a test value, published as the base publishes its own)
        Res policy = login("sysadmin").get("/stationing/policy");
        Map<String, Object> values = new LinkedHashMap<>(JSON.convertValue(policy.body().path("inForce").path("values"), Map.class));
        values.put("deploymentRequirement", "OPTIONAL");
        Res published = login("sysadmin").post("/stationing/policy/versions", Map.of("values", values, "reason", "مناطق اختيارية للاختبار", "reference", "اختبار التهيئة"));
        assertThat(published.status()).as(published.toString()).isEqualTo(200);

        Map<String, Object> half = new LinkedHashMap<>(bare(fresh));
        half.put("primary", unit(fresh, 0).get("primary"));
        Res alone = login("setup").post("/site-setup", body("H", List.of(half)));
        assertThat(alone.status()).isEqualTo(400);
        assertThat(String.join(" ", problems(alone))).contains("زوج كامل");
        assertThat(sitesNamed("H")).isZero();

        // a site that is one point, with a unit and no areas
        Map<String, Object> point = body("I", List.of(bare(fresh)));
        point.remove("boundary");
        Res ok = login("setup").post("/site-setup", point);
        assertThat(ok.status()).as(ok.toString()).isEqualTo(200);
        UUID site = UUID.fromString(ok.body().path("site").path("id").asText());
        assertThat(jdbc.sql("select geometry_version from site where id = :s").param("s", site).query().singleRow().get("geometry_version")).isNull();
        assertThat(jdbc.sql("select origin from org_stationing where organization_id = :o").param("o", fresh).query(String.class).single()).isEqualTo("SETUP");
        assertThat(areas(fresh)).isZero();
        assertThat(login("rqOnly").get("/request-hub/units/" + fresh).body().path("state").asText()).isEqualTo("DEPLOYMENT_MISSING");
    }

    private static JsonNode readTree(String s) {
        try {
            return JSON.readTree(s);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
