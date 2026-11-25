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

/**
 * ADR-106 (owner, 25 Nov 2026): «موقع جديد» refuses a site boundary larger than the policy's maximum footprint — the setup has no
 * approver to decide it, unlike a request's proposed site (ADR-087). A site of 271 km² against a 0.5 km² maximum had been
 * registered, and every deployment area was then measured from the far edge of that boundary. Real PostgreSQL + PostGIS with
 * OpenFGA in the loop; fictional data; the base's test policy (maximum footprint 200,000 m², no terrain extra).
 */
class SiteSetupFootprintIT extends RestationingTestBase {

    UUID fresh;
    double siteLat;

    @BeforeEach
    void setupFixtures() {
        fresh = hrOrg("SFA", sec, 10, publishedSnapshot());
        // north of the base's sites and of SiteSetupIT's, inside this test's own cell
        siteLat = lat0 + 0.12;
        person("setup", role("SFADM", "ALL", "VIEW", "MANAGE_FACILITIES", "MANAGE_SITE_LINKS", "CORRECT_STATIONING"), top);
    }

    private String siteName(String tag) {
        return "موقع مساحة " + tag + " " + sfx;
    }

    /** A site whose boundary is a square of half-side {@code h} degrees, {@code n} cells (about 1.1 km) north of the first. */
    private Map<String, Object> body(String tag, double h, int n, List<Map<String, Object>> units) {
        double lat = siteLat + 0.01 * n;
        Map<String, Object> site = new LinkedHashMap<>();
        site.put("code", "");
        site.put("name", siteName(tag));
        site.put("kind", "معسكر");
        site.put("responsibleOrgId", null);
        site.put("location", Map.of("lat", lat, "lng", lng0));
        Map<String, Object> boundary = new LinkedHashMap<>();
        boundary.put("geometry", square(lat, lng0, h));
        boundary.put("crs", "EPSG:4326");
        boundary.put("expectedVersion", 0);
        boundary.put("method", "DRAWN");
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("site", site);
        b.put("boundary", boundary);
        b.put("units", units);
        b.put("reason", "تهيئة الموقع للاختبار");
        b.put("reference", "اختبار المساحة");
        return b;
    }

    private long sitesNamed(String tag) {
        return jdbc.sql("select count(*) from site where name = :n").param("n", siteName(tag)).query(Long.class).single();
    }

    private long stationings(UUID org) {
        return jdbc.sql("select count(*) from org_stationing where organization_id = :o").param("o", org).query(Long.class).single();
    }

    private static String problems(Res r) {
        List<String> out = new ArrayList<>();
        r.body().path("details").path("problems").forEach(n -> out.add(n.asText()));
        r.body().path("problems").forEach(n -> out.add(n.asText()));
        out.add(r.body().path("message").asText());
        return String.join(" ", out);
    }

    @Test
    @DisplayName("SETUP-FP-01 a boundary above the policy's maximum footprint is refused, with or without units; the review says why; nothing is written")
    void oversizedBoundaryRefused() {
        // half-side 0.003° ≈ 0.62 × 0.67 km ≈ 0.41 km², twice the test policy's 200,000 m²
        Map<String, Object> withUnit = body("BIG", 0.003, 0, List.of(Map.of("organizationId", fresh.toString())));
        Res check = login("setup").post("/site-setup/check", withUnit);
        assertThat(check.status()).as(check.toString()).isEqualTo(200);
        assertThat(check.body().path("ok").asBoolean()).as(check.toString()).isFalse();
        assertThat(problems(check)).contains("أكبر من الحد الأقصى في سياسة التمركز").contains("200,000 م²");

        Res r = login("setup").post("/site-setup", withUnit);
        assertThat(r.status()).as(r.toString()).isEqualTo(400);
        assertThat(problems(r)).contains("أكبر من الحد الأقصى في سياسة التمركز");
        assertThat(sitesNamed("BIG")).as("no site").isZero();
        assertThat(stationings(fresh)).as("no stationing").isZero();

        Res alone = login("setup").post("/site-setup", body("BIG2", 0.003, 2, List.of()));
        assertThat(alone.status()).as("a site without units is measured too: " + alone).isEqualTo(400);
        assertThat(problems(alone)).contains("أكبر من الحد الأقصى في سياسة التمركز");
        assertThat(sitesNamed("BIG2")).isZero();
    }

    @Test
    @DisplayName("SETUP-FP-02 a boundary within the maximum footprint is registered with its unit's initial stationing")
    void boundaryWithinMaximumAccepted() {
        // half-side 0.0018° ≈ 0.37 × 0.40 km ≈ 0.15 km², below 200,000 m²
        Res r = login("setup").post("/site-setup", body("OK", 0.0018, 4, List.of(Map.of("organizationId", fresh.toString()))));
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        assertThat(sitesNamed("OK")).isEqualTo(1);
        assertThat(stationings(fresh)).isEqualTo(1);
    }
}
