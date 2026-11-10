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
    @DisplayName("A site saved without a code gets the next free S-number, one each, and keeps a code typed by hand (ADR-048)")
    void codeGeneratedWhenEmpty() {
        var fma = login("fma");
        java.util.function.Function<String, Map<String, Object>> body = code -> {
            Map<String, Object> b = new java.util.HashMap<>(Map.of("name", "موقع بلا رمز " + sfx, "kind", "معسكر", "responsibleOrgId", orgA.toString(),
                    "location", Map.of("lat", lat0 + 0.02, "lng", lng0 + 0.02), "reason", "تهيئة موقع بلا رمز"));
            if (code != null) b.put("code", code);
            return b;
        };
        var first = fma.post("/sites", body.apply(""));
        var second = fma.post("/sites", body.apply(null));
        var typed = fma.post("/sites", body.apply("BY-HAND-" + sfx));
        assertThat(first.status()).as(first.toString()).isEqualTo(200);
        assertThat(second.status()).as(second.toString()).isEqualTo(200);
        String a = first.body().path("code").asText(), b = second.body().path("code").asText();
        assertThat(a).matches("S-\\d{4,}");
        assertThat(Integer.parseInt(b.substring(2))).isEqualTo(Integer.parseInt(a.substring(2)) + 1);
        assertThat(typed.body().path("code").asText()).isEqualTo("BY-HAND-" + sfx);
        var audited = lastAudit(UUID.fromString(first.body().path("id").asText()), "SITE_CREATED");
        assertThat(audited.path("detail").path("code").asText()).isEqualTo(a);
        // an update still needs its code
        var noCode = fma.put("/sites/" + first.body().path("id").asText(), Map.of("code", "", "name", "x", "kind", "معسكر", "reason", "تعديل بلا رمز"));
        assertThat(noCode.status()).isEqualTo(400);
    }

    @Test
    @DisplayName("A site's map symbol (V32): saved with the site, shown on the map, changed and cleared with a reason; tactical graphics refused")
    void siteSymbol() {
        var fma = login("fma");
        Map<String, Object> body = new java.util.HashMap<>(Map.of("name", "معسكر برمز " + sfx, "kind", "معسكر", "responsibleOrgId", orgA.toString(),
                "location", Map.of("lat", lat0 + 0.03, "lng", lng0 + 0.03), "reason", "تهيئة موقع برمز", "symbol", "SFGPIB----H----"));
        var made = fma.post("/sites", body);
        assertThat(made.status()).as(made.toString()).isEqualTo(200);
        String id = made.body().path("id").asText();
        var detail = fma.get("/sites/" + id);
        assertThat(detail.body().path("symbol").path("sidc").asText()).isEqualTo("SFGPIB----H----");
        assertThat(detail.body().path("symbol").path("standard").asText()).isEqualTo("2525C");
        var features = fma.get("/map/features?bbox=" + (lng0 - 1) + "," + (lat0 - 1) + "," + (lng0 + 1) + "," + (lat0 + 1));
        boolean onMap = false;
        for (JsonNode f : features.body().path("features")) {
            if (f.path("siteId").asText().equals(id)) onMap = "SFGPIB----H----".equals(f.path("symbol").asText());
        }
        assertThat(onMap).as(features.toString()).isTrue();
        // a tactical graphic (a checkpoint) or a malformed code is no site symbol
        body.put("symbol", "GFGPGPPK------X");
        assertThat(fma.post("/sites", body).status()).isEqualTo(400);
        body.put("symbol", "not-a-code");
        assertThat(fma.post("/sites", body).status()).isEqualTo(400);
        // changed from the card, with a reason; then cleared; someone without the right is refused
        assertThat(fma.put("/sites/" + id + "/symbol", Map.of("symbol", "SFGPUSM--------", "reason", "x")).status()).isEqualTo(400);
        var changed = fma.put("/sites/" + id + "/symbol", Map.of("symbol", "SFGPUSM--------", "reason", "عيادة في الموقع"));
        assertThat(changed.status()).as(changed.toString()).isEqualTo(200);
        assertThat(changed.body().path("sidc").asText()).isEqualTo("SFGPUSM--------");
        assertThat(lastAudit(UUID.fromString(id), "SITE_SYMBOL_SET").path("detail").path("before").asText()).isEqualTo("SFGPIB----H----");
        assertThat(login("vw").put("/sites/" + id + "/symbol", Map.of("symbol", "SFGPIB----H----", "reason", "محاولة بلا صلاحية")).status()).isEqualTo(403);
        assertThat(login("fmb").put("/sites/" + id + "/symbol", Map.of("symbol", "SFGPIB----H----", "reason", "جهة أخرى")).status()).isEqualTo(403);
        Map<String, Object> clear = new java.util.HashMap<>();
        clear.put("symbol", null);
        clear.put("reason", "بلا رمز");
        assertThat(fma.put("/sites/" + id + "/symbol", clear).status()).isEqualTo(200);
        assertThat(fma.get("/sites/" + id).body().path("symbol").isNull()).isTrue();
        assertThat(lastAudit(UUID.fromString(id), "SITE_SYMBOL_CLEARED")).isNotNull();
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
