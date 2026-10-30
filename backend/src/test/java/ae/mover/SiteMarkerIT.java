package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Direct, audited management of a site's point marker on the map (the «add a marker / move a marker» administrative
 * function): creating a site at a clicked point and repositioning an existing site's marker. It is a facility-register
 * edit under {@code MANAGE_FACILITIES} on the responsible organisation — the same authority as boundary editing — not
 * a reservation and not an approval request. Covers authorisation, audit, coordinate validation and the retired-site
 * refusal. Boundaries, resources and responsibilities are never touched by these calls.
 */
class SiteMarkerIT extends IntegrationTest {

    UUID root, orgA, orgB, siteA, siteNoMarker;
    final double lat0 = 10 + Math.random() * 20;
    final double lng0 = 40 + Math.random() * 20;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgB = org("B", root);
        siteA = siteAt("SA", orgA, lat0, lng0);
        siteNoMarker = siteAt("SNM", orgA, null, null);
        person("fma", role("FMA", "ORGANIZATION", "MANAGE_FACILITIES", "VIEW"), orgA);
        person("fmb", role("FMB", "ORGANIZATION", "MANAGE_FACILITIES", "VIEW"), orgB);
        person("vw", role("VW", "ORGANIZATION", "VIEW"), orgA);
    }

    UUID siteAt(String code, UUID responsibleOrg, Double lat, Double lng) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into site(id, code, name, kind, lat, lng) values (:id, :c, :n, 'مرفق', :lat, :lng)")
                .param("id", id).param("c", code + "-" + sfx).param("n", "موقع " + code + " " + sfx).param("lat", lat).param("lng", lng).update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("s", id).param("o", responsibleOrg).update();
        return id;
    }

    static JsonNode parse(String json) {
        try {
            return JSON.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** The newest audit event for a site with the given action, with its reason and parsed detail, or null if none. */
    JsonNode lastAudit(UUID siteId, String action) {
        return jdbc.sql("""
                select reason, detail::text as detail from audit_event
                where entity_type = 'SITE' and entity_id = :id and action = :a order by id desc limit 1""")
                .param("id", siteId.toString()).param("a", action)
                .query((rs, n) -> {
                    com.fasterxml.jackson.databind.node.ObjectNode node = JSON.createObjectNode();
                    node.put("reason", rs.getString("reason"));
                    node.set("detail", parse(rs.getString("detail")));
                    return (JsonNode) node;
                })
                .optional().orElse(null);
    }

    @Test
    @DisplayName("A facility manager adds a new site by placing a marker; it is stored with its coordinates and audited")
    void createSiteAtPoint() {
        var fma = login("fma");
        double lat = lat0 + 0.05, lng = lng0 + 0.05;
        var body = Map.of("code", "NEW-" + sfx, "name", "مبنى إداري " + sfx, "kind", "مرفق",
                "responsibleOrgId", orgA.toString(), "location", Map.of("lat", lat, "lng", lng));
        var res = fma.post("/sites", body);
        assertThat(res.status()).as(res.toString()).isEqualTo(200);
        assertThat(res.body().path("location").path("lat").asDouble()).isCloseTo(lat, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(res.body().path("location").path("lng").asDouble()).isCloseTo(lng, org.assertj.core.data.Offset.offset(1e-6));
        String id = res.body().path("id").asText();
        JsonNode detail = fma.get("/sites/" + id).body();
        assertThat(detail.path("boundaryStatus").asText()).isEqualTo("NOT_REGISTERED");
        assertThat(detail.path("location").path("lat").asDouble()).isCloseTo(lat, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(lastAudit(UUID.fromString(id), "SITE_CREATED")).isNotNull();
    }

    @Test
    @DisplayName("A facility manager moves a marker; the coordinates change, the version bumps, and it is audited with a reason")
    void moveMarker() {
        var fma = login("fma");
        long versionBefore = jdbc.sql("select version from site where id = :id").param("id", siteA).query(Long.class).single();
        double lat = lat0 + 0.02, lng = lng0 - 0.03;
        var res = fma.post("/sites/" + siteA + "/location", Map.of("location", Map.of("lat", lat, "lng", lng), "reason", "تصحيح موضع العلامة وفق المسح"));
        assertThat(res.status()).as(res.toString()).isEqualTo(200);
        assertThat(res.body().path("location").path("lat").asDouble()).isCloseTo(lat, org.assertj.core.data.Offset.offset(1e-6));
        JsonNode stored = jdbc.sql("select lat, lng, version from site where id = :id").param("id", siteA)
                .query((rs, n) -> JSON.createObjectNode().put("lat", rs.getDouble("lat")).put("lng", rs.getDouble("lng")).put("version", rs.getLong("version"))).single();
        assertThat(stored.path("lat").asDouble()).isCloseTo(lat, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(stored.path("version").asLong()).isGreaterThan(versionBefore);
        JsonNode a = lastAudit(siteA, "SITE_MARKER_MOVED");
        assertThat(a).isNotNull();
        assertThat(a.path("reason").asText()).contains("تصحيح موضع");
        assertThat(a.path("detail").path("fromLat").asDouble()).isCloseTo(lat0, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(a.path("detail").path("toLng").asDouble()).isCloseTo(lng, org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    @DisplayName("Setting a marker on a site that had none is audited as SITE_MARKER_SET")
    void setMarkerOnSiteWithoutOne() {
        var fma = login("fma");
        var res = fma.post("/sites/" + siteNoMarker + "/location",
                Map.of("location", Map.of("lat", lat0 + 0.1, "lng", lng0 + 0.1), "reason", "تحديد موضع المرفق"));
        assertThat(res.status()).as(res.toString()).isEqualTo(200);
        assertThat(lastAudit(siteNoMarker, "SITE_MARKER_SET")).isNotNull();
        assertThat(lastAudit(siteNoMarker, "SITE_MARKER_MOVED")).isNull();
    }

    @Test
    @DisplayName("Out-of-range coordinates and a missing reason are refused; the stored marker does not change")
    void invalidInputRefused() {
        var fma = login("fma");
        var bad = fma.post("/sites/" + siteA + "/location", Map.of("location", Map.of("lat", 200.0, "lng", 10.0), "reason", "سبب كافٍ"));
        assertThat(bad.status()).isEqualTo(400);
        assertThat(bad.code()).isEqualTo("VALIDATION_FAILED");
        var noReason = fma.post("/sites/" + siteA + "/location", Map.of("location", Map.of("lat", lat0, "lng", lng0), "reason", ""));
        assertThat(noReason.status()).isEqualTo(400);
        assertThat(noReason.code()).isEqualTo("VALIDATION_FAILED");
        double lat = jdbc.sql("select lat from site where id = :id").param("id", siteA).query(Double.class).single();
        assertThat(lat).isCloseTo(lat0, org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    @DisplayName("A viewer, and a facility manager of another organisation, cannot move the marker")
    void authorisationEnforced() {
        var viewer = login("vw");
        var forbiddenViewer = viewer.post("/sites/" + siteA + "/location", Map.of("location", Map.of("lat", lat0, "lng", lng0), "reason", "محاولة"));
        assertThat(forbiddenViewer.status()).isEqualTo(403);
        var fmb = login("fmb");
        var forbiddenOtherOrg = fmb.post("/sites/" + siteA + "/location", Map.of("location", Map.of("lat", lat0, "lng", lng0), "reason", "محاولة"));
        assertThat(forbiddenOtherOrg.status()).isEqualTo(403);
        // a viewer also cannot create a site responsible to the organisation
        var create = viewer.post("/sites", Map.of("code", "X-" + sfx, "name", "س", "kind", "مرفق",
                "responsibleOrgId", orgA.toString(), "location", Map.of("lat", lat0, "lng", lng0)));
        assertThat(create.status()).isEqualTo(403);
    }

    @Test
    @DisplayName("A retired site refuses a marker move")
    void retiredSiteRefused() {
        var fma = login("fma");
        assertThat(fma.post("/sites/" + siteA + "/retire", Map.of()).status()).isEqualTo(204);
        var res = fma.post("/sites/" + siteA + "/location", Map.of("location", Map.of("lat", lat0, "lng", lng0), "reason", "محاولة بعد الإيقاف"));
        assertThat(res.status()).isEqualTo(400);
        assertThat(res.code()).isEqualTo("VALIDATION_FAILED");
    }
}
