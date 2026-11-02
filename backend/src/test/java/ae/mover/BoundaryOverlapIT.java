package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * P1-4 of the enterprise audit: two registered site boundaries may overlap only when one site is an ancestor of the
 * other (a zone inside its campus). A shared edge is not an overlap. A site the editor may not see is not named in the
 * refusal. The scene sits at a random place so it never meets other tests' sites in the shared database.
 */
class BoundaryOverlapIT extends IntegrationTest {

    final double lat0 = 10 + Math.random() * 20;
    final double lng0 = 40 + Math.random() * 20;
    final double d = 0.002; // about 200 m
    UUID root, orgX, orgY, siteA, siteB, siteC, siteE, siteH;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgX = org("X", root);
        orgY = org("Y", root);
        siteA = siteAt("A", null, orgX, lat0, lng0);
        siteB = siteAt("B", null, orgX, lat0, lng0 + 2 * d);
        siteC = siteAt("C", siteA, orgX, lat0, lng0);
        siteE = siteAt("E", null, orgX, lat0 + 10 * d, lng0);
        siteH = siteAt("H", null, orgY, lat0 + 10 * d, lng0 + d);
        person("fm", role("FM", "ALL", "MANAGE_FACILITIES", "VIEW"), root);
        person("fmx", role("FMX", "ORGANIZATION", "MANAGE_FACILITIES", "VIEW"), orgX);
    }

    UUID siteAt(String code, UUID parent, UUID org, double lat, double lng) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into site(id, code, name, kind, parent_id, lat, lng) values (:id, :c, :n, 'مرفق', :p, :lat, :lng)")
                .param("id", id).param("c", code + "-" + sfx).param("n", "موقع " + code + " " + sfx).param("p", parent)
                .param("lat", lat).param("lng", lng).update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("s", id).param("o", org).update();
        return id;
    }

    static Map<String, Object> rect(double x0, double y0, double x1, double y1) {
        return Map.of("type", "Polygon", "coordinates", List.of(List.of(List.of(x0, y0), List.of(x1, y0), List.of(x1, y1), List.of(x0, y1), List.of(x0, y0))));
    }

    Res save(Api a, UUID site, Map<String, Object> g) {
        return a.post("/sites/" + site + "/geometry", Map.of("geometry", g, "crs", "EPSG:4326", "expectedVersion", 0,
                "reason", "حدود اختبار التداخل", "method", "COORDINATES"));
    }

    @Test
    @DisplayName("P1-4: an unrelated overlap is refused at validation and save; a shared edge and a zone inside its parent are accepted")
    void overlapRules() {
        Api fm = login("fm");
        assertThat(save(fm, siteA, rect(lng0, lat0, lng0 + d, lat0 + d)).status()).isEqualTo(200);

        Map<String, Object> overlapping = rect(lng0 + d / 2, lat0, lng0 + 1.5 * d, lat0 + d);
        Res v = fm.post("/sites/" + siteB + "/geometry/validate", Map.of("geometry", overlapping, "crs", "EPSG:4326"));
        assertThat(v.body().path("valid").asBoolean()).as("validate: " + v).isFalse();
        assertThat(v.body().path("problems").toString()).contains("تتداخل");
        Res refused = save(fm, siteB, overlapping);
        assertThat(refused.status()).as(refused.toString()).isEqualTo(400);
        assertThat(refused.toString()).contains("تتداخل").contains("موقع A " + sfx);

        // a shared edge is not an overlap
        assertThat(save(fm, siteB, rect(lng0 + d, lat0, lng0 + 2 * d, lat0 + d)).status()).as("adjacent").isEqualTo(200);
        // a zone inside its own parent site is allowed
        assertThat(save(fm, siteC, rect(lng0 + d / 4, lat0 + d / 4, lng0 + 3 * d / 4, lat0 + 3 * d / 4)).status()).as("child zone")
                .isEqualTo(200);
    }

    Res move(Api a, UUID site, String code, UUID parent, UUID org) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("code", code + "-" + sfx);
        body.put("name", "موقع " + code + " " + sfx);
        body.put("kind", "مرفق");
        body.put("parentId", parent == null ? null : parent.toString());
        body.put("responsibleOrgId", org.toString());
        body.put("location", Map.of("lat", lat0, "lng", lng0));
        return a.put("/sites/" + site, body);
    }

    @Test
    @DisplayName("ADR-027: the site-tree exemption is containment only, and is neither gained nor kept by moving a site in the tree")
    void treeExemptionIsContainment() {
        Api fm = login("fm");
        assertThat(save(fm, siteA, rect(lng0, lat0, lng0 + d, lat0 + d)).status()).isEqualTo(200);
        // a zone straddling its parent's boundary is not "inside" it
        Res straddling = save(fm, siteC, rect(lng0 + d / 2, lat0 + d / 4, lng0 + 1.5 * d, lat0 + 3 * d / 4));
        assertThat(straddling.status()).as(straddling.toString()).isEqualTo(400);
        assertThat(straddling.toString()).contains("خارج حدود");
        assertThat(save(fm, siteC, rect(lng0 + d / 4, lat0 + d / 4, lng0 + 3 * d / 4, lat0 + 3 * d / 4)).status()).isEqualTo(200);
        // detaching the zone from its parent would leave two unrelated, overlapping sites
        Res detached = move(fm, siteC, "C", null, orgX);
        assertThat(detached.status()).as(detached.toString()).isEqualTo(400);
        assertThat(detached.toString()).contains("تتداخل");
        Res sideways = move(fm, siteC, "C", siteB, orgX);
        assertThat(sideways.status()).as("under a sibling: " + sideways).isEqualTo(400);
        assertThat(jdbc.sql("select parent_id from site where id = :s").param("s", siteC).query(UUID.class).single()).isEqualTo(siteA);
        // an unrelated move of a site without overlaps still works
        assertThat(move(fm, siteE, "E", siteB, orgX).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("P1-4: the refusal does not name a site the editor may not see")
    void overlapWithHiddenSite() {
        assertThat(save(login("fm"), siteH, rect(lng0 + d, lat0 + 10 * d, lng0 + 2 * d, lat0 + 11 * d)).status()).isEqualTo(200);
        Res refused = save(login("fmx"), siteE, rect(lng0 + d / 2, lat0 + 10 * d, lng0 + 1.5 * d, lat0 + 11 * d));
        assertThat(refused.status()).as(refused.toString()).isEqualTo(400);
        assertThat(refused.toString()).contains("تتداخل").doesNotContain("موقع H " + sfx);
    }
}
