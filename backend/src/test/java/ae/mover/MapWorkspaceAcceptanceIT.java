package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.common.Hashing;

/**
 * Administrative map workspace (docs/MAP_WORKSPACE_COMPLETION_AR.md §8) at the API and database level on real
 * PostgreSQL/PostGIS: scoped trees and search, registered boundaries only, import and drawing with versions and
 * conflicts, coverage, period and partial occupancy, request integration, pinned boundary versions and role scopes.
 * The browser parts of each MAP criterion are in tests/acceptance/map-workspace.mjs.
 */
class MapWorkspaceAcceptanceIT extends IntegrationTest {

    UUID root, orgA, orgB, deep1, deep2, deep3;
    UUID main, sub, deepSite, siteB;
    UUID resMain, resSub, resDeep, resB;
    /** Each test instance works in its own small area, so other fixtures never fall inside its viewport. */
    final double lat0 = 5 + Math.random() * 35;
    final double lng0 = -60 - Math.random() * 60;
    String type;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgB = org("B", root);
        deep1 = org("D1", orgA);
        deep2 = org("D2", deep1);
        deep3 = org("D3", deep2);
        main = siteAt("MAIN", null, orgA, lat0, lng0);
        sub = siteAt("SUB", main, orgA, lat0 + 0.002, lng0 + 0.002);
        deepSite = siteAt("DEEP", null, deep3, lat0 + 0.01, lng0 + 0.01);
        siteB = siteAt("SB", null, orgB, lat0 + 0.02, lng0 + 0.02);
        resMain = res("RM", main, null, "EXCLUSIVE", 0);
        resSub = res("RS", sub, null, "EXCLUSIVE", 0);
        resDeep = res("RD", deepSite, null, "EXCLUSIVE", 0);
        resB = res("RB", siteB, null, "EXCLUSIVE", 0);
        person("req", "REQUESTER", orgA);
        person("reqb", "REQUESTER", orgB);
        person("mgr", "ORG_MANAGER", root);
        person("apr", "APPROVER", root);
        person("apr2", "APPROVER", root);
        person("admin", "SYSTEM_ADMIN", root);
        person("lim", "LIMITED_VIEWER", orgA, sub);
        person("rev", "FACILITIES_REVIEWER", root);
        type = requestType("NEW_RESERVATION", finalOnly(), null);
    }

    UUID siteAt(String code, UUID parent, UUID org, Double lat, Double lng) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into site(id, code, name, kind, parent_id, lat, lng) values (:id, :c, :n, 'مرفق', :p, :lat, :lng)")
                .param("id", id).param("c", code + "-" + sfx).param("n", "موقع " + code + " " + sfx).param("p", parent)
                .param("lat", lat).param("lng", lng).update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("s", id).param("o", org).update();
        return id;
    }

    UUID res(String code, UUID site, UUID parent, String policy, int handover) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into resource(id, site_id, code, name, kind, policy, parent_resource_id, handover_minutes)
                values (:id, :s, :c, :n, 'مورد', :pol, :p, :h)""")
                .param("id", id).param("s", site).param("c", code + "-" + sfx).param("n", "مورد " + code)
                .param("pol", policy).param("p", parent).param("h", handover).update();
        return id;
    }

    String bbox() {
        return (lng0 - 0.05) + "," + (lat0 - 0.05) + "," + (lng0 + 0.05) + "," + (lat0 + 0.05);
    }

    JsonNode features(Api api, String extra) {
        Res r = api.get("/map/features?bbox=" + bbox() + "&from=2028-01-01T00:00:00Z&to=2028-01-02T00:00:00Z" + extra);
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        return r.body();
    }

    JsonNode feature(JsonNode fc, UUID site) {
        for (JsonNode f : fc.path("features")) {
            if (f.path("siteId").asText().equals(site.toString())) {
                return f;
            }
        }
        return null;
    }

    Set<String> siteIds(JsonNode fc) {
        Set<String> out = new HashSet<>();
        fc.path("features").forEach(f -> out.add(f.path("siteId").asText()));
        return out;
    }

    // ---- GeoJSON fixtures (explicitly imported test boundaries) --------------------------------------------

    List<List<Double>> ring(double[][] pts, double lat, double lng) {
        List<List<Double>> r = new ArrayList<>();
        for (double[] p : pts) {
            r.add(List.of(lng + p[0] * 0.001, lat + p[1] * 0.001));
        }
        return r;
    }

    /** Concave (irregular) seven-vertex outline. */
    Map<String, Object> irregular(double lat, double lng) {
        return Map.of("type", "Polygon", "coordinates", List.of(ring(new double[][]{{0, 0}, {4, 0}, {4, 1}, {1.5, 1.2},
                {1.2, 3}, {0, 2.8}, {0, 0}}, lat, lng)));
    }

    /** A square with a hole and a separate triangle. */
    Map<String, Object> multi(double lat, double lng) {
        return Map.of("type", "MultiPolygon", "coordinates", List.of(
                List.of(ring(new double[][]{{0, 0}, {2, 0}, {2, 2}, {0, 2}, {0, 0}}, lat, lng),
                        ring(new double[][]{{0.5, 0.5}, {0.5, 1.5}, {1.5, 1.5}, {1.5, 0.5}, {0.5, 0.5}}, lat, lng)),
                List.of(ring(new double[][]{{3, 0}, {4, 0}, {3.5, 1}, {3, 0}}, lat, lng))));
    }

    Map<String, Object> bowTie(double lat, double lng) {
        return Map.of("type", "Polygon", "coordinates", List.of(ring(new double[][]{{0, 0}, {2, 2}, {2, 0}, {0, 2}, {0, 0}}, lat, lng)));
    }

    Map<String, Object> feature(String code, Map<String, Object> geometry) {
        return Map.of("type", "Feature", "properties", Map.of("site_code", code + "-" + sfx), "geometry", geometry);
    }

    byte[] collection(String crs, List<Map<String, Object>> features) {
        Map<String, Object> fc = new java.util.LinkedHashMap<>();
        fc.put("type", "FeatureCollection");
        if (crs != null) {
            fc.put("crs", Map.of("type", "name", "properties", Map.of("name", crs)));
        }
        fc.put("features", features);
        return write(fc).getBytes(StandardCharsets.UTF_8);
    }

    Res multipart(Api api, String path, String fileName, byte[] content, Map<String, String> fields) {
        String boundary = "----map" + UUID.randomUUID();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        fields.forEach((k, v) -> out.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" + v + "\r\n")
                .getBytes(StandardCharsets.UTF_8)));
        out.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName
                + "\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.writeBytes(content);
        out.writeBytes(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        return api.send(HttpRequest.newBuilder(URI.create(api.url(path)))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary).header("X-Requested-With", "mover")
                .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray())));
    }

    Res importFile(Api api, String name, byte[] content, String crs) {
        return multipart(api, "/map/imports", name, content, crs == null ? Map.of() : Map.of("crs", crs));
    }

    int versions(UUID site) {
        return jdbc.sql("select count(*) from site_geometry_version where site_id = :s").param("s", site).query(Integer.class).single();
    }

    /** Stored versions keep 9 decimals (sub-millimetre); exact within that precision. */
    static void assertSameCoordinates(JsonNode a, JsonNode b) {
        assertSameCoordinates(a, b, 1e-9);
    }

    /** Map layers are sent with 7 decimals (about 1 cm). */
    static void assertSameCoordinates(JsonNode a, JsonNode b, double tolerance) {
        assertThat(a.isArray()).isEqualTo(b.isArray());
        if (a.isNumber()) {
            assertThat(a.asDouble()).isCloseTo(b.asDouble(), org.assertj.core.data.Offset.offset(tolerance));
            return;
        }
        assertThat(a.size()).isEqualTo(b.size());
        for (int i = 0; i < a.size(); i++) {
            assertSameCoordinates(a.get(i), b.get(i), tolerance);
        }
    }

    // ---- MAP-01 / MAP-02 -----------------------------------------------------------------------------------

    @Test
    @DisplayName("MAP-01: an organisation deep in a branch is found by search and lazy tree and filters the right sites; no people are sent")
    void organisationBranchFilter() {
        Api req = login("req");
        Res found = req.get("/organizations/search?q=" + java.net.URLEncoder.encode("جهة D3", StandardCharsets.UTF_8));
        assertThat(found.status()).isEqualTo(200);
        JsonNode hit = null;
        for (JsonNode o : found.body()) {
            if (o.path("id").asText().equals(deep3.toString())) {
                hit = o;
            }
        }
        assertThat(hit).as(found.toString()).isNotNull();
        List<String> path = new ArrayList<>();
        hit.path("path").forEach(p -> path.add(p.path("id").asText()));
        assertThat(path).containsExactly(root.toString(), orgA.toString(), deep1.toString(), deep2.toString());
        assertThat(found.body().toString()).doesNotContain("members").doesNotContain("employee").doesNotContain("person");
        JsonNode kids = req.get("/organizations/" + orgA + "/children").body();
        assertThat(kids.toString()).contains(deep1.toString());
        assertThat(kids.get(0).path("childCount").asInt()).isGreaterThanOrEqualTo(1);

        JsonNode branch = features(req, "&orgId=" + deep1 + "&includeSubOrgs=true");
        assertThat(siteIds(branch)).containsExactly(deepSite.toString());
        assertThat(feature(branch, deepSite).path("relations").toString()).contains("RESPONSIBLE");
        assertThat(siteIds(features(req, "&orgId=" + deep1 + "&includeSubOrgs=false"))).isEmpty();

        // Another branch: same answer as for an organisation that does not exist.
        Api reqb = login("reqb");
        Res outside = reqb.get("/map/features?bbox=" + bbox() + "&orgId=" + deep1);
        Res unknown = reqb.get("/map/features?bbox=" + bbox() + "&orgId=" + UUID.randomUUID());
        assertThat(outside.status()).isEqualTo(404);
        assertThat(outside.body().path("message")).isEqualTo(unknown.body().path("message"));
        assertThat(reqb.get("/organizations/search?q=" + java.net.URLEncoder.encode("جهة D3", StandardCharsets.UTF_8)).body().toString())
                .doesNotContain(deep3.toString());

        // Use in the period is a separate relation from responsibility.
        Api mgr = login("mgr");
        UUID r = mgr.submitted(type, orgA, List.of(resB), "2028-01-01T00:00:00Z", "2028-01-03T00:00:00Z");
        Api apr = login("apr");
        assertThat(apr.approve(apr.taskFor(r), 1).status()).isEqualTo(200);
        JsonNode byA = features(apr, "&orgId=" + orgA + "&includeSubOrgs=false");
        assertThat(feature(byA, siteB).path("relations").toString()).contains("OCCUPANT").doesNotContain("RESPONSIBLE");
        assertThat(feature(byA, main).path("relations").toString()).contains("RESPONSIBLE").doesNotContain("OCCUPANT");
    }

    @Test
    @DisplayName("MAP-02: a main site without parent and its sub-site are browsed lazily with path, details and search")
    void siteTreeAndPath() {
        Api req = login("req");
        JsonNode roots = req.get("/sites/tree").body();
        JsonNode mainNode = null;
        for (JsonNode n : roots) {
            if (n.path("id").asText().equals(main.toString())) {
                mainNode = n;
            }
        }
        assertThat(mainNode).isNotNull();
        assertThat(mainNode.path("parentId").isMissingNode() || mainNode.path("parentId").isNull()).isTrue();
        assertThat(mainNode.path("childCount").asInt()).isEqualTo(1);
        assertThat(req.get("/sites/tree?parentId=" + main).body().toString()).contains(sub.toString());
        JsonNode detail = req.get("/sites/" + sub).body();
        assertThat(detail.path("parentId").asText()).isEqualTo(main.toString());
        assertThat(detail.path("path").get(0).path("id").asText()).isEqualTo(main.toString());
        JsonNode search = req.get("/sites/search?q=SUB-" + sfx).body();
        assertThat(search.size()).isEqualTo(1);
        assertThat(search.get(0).path("path").get(0).path("id").asText()).isEqualTo(main.toString());
        assertThat(feature(features(req, ""), main).path("parentId").isNull()).isTrue();

        Api reqb = login("reqb");
        assertThat(reqb.get("/sites/" + main).status()).isEqualTo(404);
        assertThat(reqb.get("/sites/tree?parentId=" + main).status()).isEqualTo(404);
        assertThat(reqb.get("/sites/search?q=MAIN-" + sfx).body().size()).isZero();
    }

    // ---- MAP-03 / MAP-04 / MAP-05 / MAP-06 -----------------------------------------------------------------------

    @Test
    @DisplayName("MAP-03: a point-only site (also a legacy point version) has a marker and no boundary; nothing is drawn around it")
    void pointOnlySite() {
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from)
                values (:id, :s, 1, cast(:g as jsonb), 'EPSG:4326', 'سجل سابق', now())""")
                .param("id", UUID.randomUUID()).param("s", sub)
                .param("g", write(Map.of("type", "Point", "coordinates", List.of(lng0 + 0.002, lat0 + 0.002)))).update();
        jdbc.sql("update site set geometry_version = 1 where id = :s").param("s", sub).update();
        Api req = login("req");
        JsonNode fc = features(req, "");
        for (UUID s : List.of(main, sub)) {
            JsonNode f = feature(fc, s);
            assertThat(f.path("boundary").isNull()).isTrue();
            assertThat(f.path("boundaryStatus").asText()).isEqualTo("NOT_REGISTERED");
            assertThat(f.path("lat").isNumber()).isTrue();
            JsonNode d = req.get("/sites/" + s).body();
            assertThat(d.path("boundaryStatus").asText()).isEqualTo("NOT_REGISTERED");
        }
        assertThat(req.get("/sites/" + sub).body().path("geometry").path("type").asText()).isEqualTo("Point");
        assertThat(fc.toString()).doesNotContain("Polygon");
    }

    @Test
    @DisplayName("MAP-04: an irregular polygon and a MultiPolygon (GeoJSON) and a KML polygon are imported, published and read back unchanged")
    void importBoundaries() {
        Api admin = login("admin");
        Map<String, Object> poly = irregular(lat0, lng0);
        Map<String, Object> mp = multi(lat0 + 0.002, lng0 + 0.002);
        Res preview = importFile(admin, "boundaries.geojson",
                collection("urn:ogc:def:crs:OGC:1.3:CRS84", List.of(feature("MAIN", poly), feature("SUB", mp))), null);
        assertThat(preview.status()).as(preview.toString()).isEqualTo(200);
        assertThat(preview.body().path("status").asText()).as(preview.toString()).isEqualTo("PREVIEWED");
        assertThat(preview.body().path("effectiveCrs").asText()).isEqualTo("EPSG:4326");
        for (JsonNode f : preview.body().path("features")) {
            assertThat(f.path("problems").size()).isZero();
            assertThat(f.path("areaM2").asDouble()).isPositive();
            assertThat(f.path("currentVersion").asInt()).isZero();
        }
        assertThat(versions(main)).isZero();
        String job = preview.body().path("id").asText();
        assertThat(login("req").post("/map/imports/" + job + "/publish", Map.of("reason", "حدود معتمدة للاختبار")).status()).isEqualTo(404);
        Res published = admin.post("/map/imports/" + job + "/publish", Map.of("reason", "حدود معتمدة للاختبار"));
        assertThat(published.status()).as(published.toString()).isEqualTo(200);
        assertThat(published.body().path("status").asText()).isEqualTo("PUBLISHED");

        // Reload: the stored versions match the input exactly.
        Api req = login("req");
        JsonNode m = req.get("/sites/" + main).body();
        assertThat(m.path("boundaryStatus").asText()).isEqualTo("REGISTERED");
        assertThat(m.path("geometry").path("version").asInt()).isEqualTo(1);
        assertThat(m.path("geometry").path("type").asText()).isEqualTo("Polygon");
        assertSameCoordinates(m.path("geometry").path("geojson").path("coordinates"), JSON.valueToTree(poly).path("coordinates"));
        JsonNode s = req.get("/sites/" + sub).body();
        assertThat(s.path("geometry").path("type").asText()).isEqualTo("MultiPolygon");
        assertSameCoordinates(s.path("geometry").path("geojson").path("coordinates"), JSON.valueToTree(mp).path("coordinates"));
        JsonNode fc = features(req, "");
        assertThat(feature(fc, main).path("boundary").path("version").asInt()).isEqualTo(1);
        assertSameCoordinates(feature(fc, sub).path("boundary").path("geojson").path("coordinates"), JSON.valueToTree(mp).path("coordinates"), 1e-7);
        JsonNode history = admin.get("/sites/" + main + "/geometry/versions").body();
        assertThat(history.get(0).path("format").asText()).isEqualTo("GEOJSON");
        assertThat(history.get(0).path("reason").asText()).isEqualTo("حدود معتمدة للاختبار");
        assertThat(history.get(0).path("createdBy").path("name").asText()).isNotBlank();
        assertThat(req.get("/sites/" + main + "/geometry/versions").body().get(0).path("createdBy").isMissingNode()).isTrue();

        // KML (WGS 84 by definition): one placemark linked by its site code.
        String kml = """
                <?xml version="1.0" encoding="UTF-8"?>
                <kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>موقع</name>
                <ExtendedData><Data name="site_code"><value>DEEP-%s</value></Data></ExtendedData>
                <Polygon><outerBoundaryIs><LinearRing><coordinates>%s,%s,0 %s,%s,0 %s,%s,0 %s,%s,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
                </Placemark></Document></kml>""".formatted(sfx, lng0 + 0.01, lat0 + 0.01, lng0 + 0.012, lat0 + 0.01,
                lng0 + 0.011, lat0 + 0.012, lng0 + 0.01, lat0 + 0.01);
        Res k = importFile(admin, "deep.kml", kml.getBytes(StandardCharsets.UTF_8), null);
        assertThat(k.body().path("status").asText()).as(k.toString()).isEqualTo("PREVIEWED");
        assertThat(admin.post("/map/imports/" + k.body().path("id").asText() + "/publish", Map.of("reason", "حدود KML للاختبار")).status())
                .isEqualTo(200);
        assertThat(req.get("/sites/" + deepSite).body().path("geometry").path("version").asInt()).isEqualTo(1);

        // A second import creates version 2; version 1 stays readable and unchanged.
        Res again = importFile(admin, "v2.geojson", collection("CRS84", List.of(feature("MAIN", irregular(lat0 + 0.0001, lng0)))), null);
        assertThat(again.body().path("features").get(0).path("currentVersion").asInt()).isEqualTo(1);
        admin.post("/map/imports/" + again.body().path("id").asText() + "/publish", Map.of("reason", "تصحيح الحدود"));
        assertThat(req.get("/sites/" + main).body().path("geometry").path("version").asInt()).isEqualTo(2);
        assertSameCoordinates(req.get("/sites/" + main + "/geometry/versions/1").body().path("geojson").path("coordinates"),
                JSON.valueToTree(poly).path("coordinates"));
    }

    @Test
    @DisplayName("MAP-05: unknown or ambiguous CRS, invalid geometry and undeclared formats are refused with a report; nothing is published")
    void importRejections() {
        Api admin = login("admin");
        Res noCrs = importFile(admin, "a.geojson", collection(null, List.of(feature("MAIN", irregular(lat0, lng0)))), null);
        assertThat(noCrs.body().path("status").asText()).isEqualTo("REJECTED");
        assertThat(noCrs.body().path("fileProblems").toString()).contains("CRS");
        assertThat(admin.post("/map/imports/" + noCrs.body().path("id").asText() + "/publish", Map.of("reason", "محاولة نشر")).status())
                .isEqualTo(400);

        Res unknownCrs = importFile(admin, "a.geojson", collection("EPSG:9999", List.of(feature("MAIN", irregular(lat0, lng0)))), null);
        assertThat(unknownCrs.body().path("status").asText()).isEqualTo("REJECTED");
        assertThat(unknownCrs.body().path("fileProblems").toString()).contains("غير مدعوم");
        Res ambiguous = importFile(admin, "a.geojson",
                collection("urn:ogc:def:crs:EPSG::4326", List.of(feature("MAIN", irregular(lat0, lng0)))), null);
        assertThat(ambiguous.body().path("fileProblems").toString()).contains("خط العرض أولاً");

        // One valid and one self-intersecting shape: the whole file is rejected, the valid one is not published.
        Res mixed = importFile(admin, "mixed.geojson", collection("CRS84",
                List.of(feature("MAIN", irregular(lat0, lng0)), feature("SUB", bowTie(lat0, lng0)))), null);
        assertThat(mixed.body().path("status").asText()).isEqualTo("REJECTED");
        assertThat(mixed.body().path("features").get(1).path("problems").toString()).contains("تقاطع ذاتي");
        assertThat(mixed.body().path("features").get(0).path("problems").size()).isZero();
        assertThat(admin.post("/map/imports/" + mixed.body().path("id").asText() + "/publish", Map.of("reason", "محاولة نشر")).status())
                .isEqualTo(400);
        assertThat(versions(main)).isZero();
        assertThat(versions(sub)).isZero();

        Res degrees = importFile(admin, "utm-as-degrees.geojson", collection("EPSG:4326", List.of(feature("MAIN",
                Map.of("type", "Polygon", "coordinates", List.of(List.of(List.of(328700.0, 2788000.0), List.of(328800.0, 2788000.0),
                        List.of(328800.0, 2788100.0), List.of(328700.0, 2788000.0))))))), null);
        assertThat(degrees.body().path("features").get(0).path("problems").toString()).contains("خارج نطاق");

        Res point = importFile(admin, "p.geojson", collection("CRS84", List.of(feature("MAIN",
                Map.of("type", "Point", "coordinates", List.of(lng0, lat0))))), null);
        assertThat(point.body().path("features").get(0).path("problems").toString()).contains("Polygon");

        Res shp = importFile(admin, "sites.shp", new byte[]{1, 2, 3}, "EPSG:4326");
        assertThat(shp.status()).isEqualTo(400);
        assertThat(shp.body().path("message").asText()).contains("GeoJSON");
        assertThat(importFile(admin, "notes.txt", "x".getBytes(StandardCharsets.UTF_8), "EPSG:4326").status()).isEqualTo(400);
        assertThat(importFile(login("req"), "a.geojson", collection("CRS84", List.of()), null).status()).isEqualTo(403);
        assertThat(versions(main)).isZero();

        // A declared projected CRS (UTM 40N) is transformed in PostGIS, not guessed.
        Res utm = importFile(admin, "utm.geojson", collection(null, List.of(feature("MAIN",
                Map.of("type", "Polygon", "coordinates", List.of(List.of(List.of(328700.0, 2788000.0), List.of(328800.0, 2788000.0),
                        List.of(328800.0, 2788100.0), List.of(328700.0, 2788100.0), List.of(328700.0, 2788000.0))))))), "EPSG:32640");
        assertThat(utm.body().path("status").asText()).as(utm.toString()).isEqualTo("PREVIEWED");
        JsonNode first = utm.body().path("features").get(0).path("geojson").path("coordinates").get(0).get(0);
        assertThat(first.get(0).asDouble()).isBetween(55.2, 55.4);
        assertThat(first.get(1).asDouble()).isBetween(25.1, 25.35);
        assertThat(admin.post("/map/imports/" + utm.body().path("id").asText() + "/cancel", Map.of()).body().path("status").asText())
                .isEqualTo("CANCELLED");
        assertThat(versions(main)).isZero();
    }

    @Test
    @DisplayName("MAP-06: validation stores nothing, a save creates a version, and a save based on an older version is refused")
    void drawEditConflict() {
        Api admin = login("admin");
        Map<String, Object> drawn = irregular(lat0, lng0);
        Res check = admin.post("/sites/" + main + "/geometry/validate", Map.of("geometry", drawn, "crs", "EPSG:4326"));
        assertThat(check.body().path("valid").asBoolean()).as(check.toString()).isTrue();
        assertThat(versions(main)).isZero();
        assertThat(admin.post("/sites/" + main + "/geometry", Map.of("geometry", drawn, "crs", "EPSG:4326", "expectedVersion", 0,
                "method", "DRAWN")).status()).isEqualTo(400); // reason required
        Res v1 = admin.post("/sites/" + main + "/geometry", Map.of("geometry", drawn, "crs", "EPSG:4326", "expectedVersion", 0,
                "reason", "رسم الحدود الأولى", "method", "DRAWN"));
        assertThat(v1.status()).as(v1.toString()).isEqualTo(200);
        assertThat(v1.body().path("version").asInt()).isEqualTo(1);

        // Two editors start from version 1; the second save is refused and nothing is overwritten.
        Api admin2 = login("admin");
        Map<String, Object> editA = irregular(lat0 + 0.0002, lng0);
        Map<String, Object> editB = irregular(lat0 + 0.0004, lng0);
        Res a = admin.post("/sites/" + main + "/geometry", Map.of("geometry", editA, "crs", "EPSG:4326", "expectedVersion", 1,
                "reason", "تعديل الرؤوس", "method", "COORDINATES"));
        Res b = admin2.post("/sites/" + main + "/geometry", Map.of("geometry", editB, "crs", "EPSG:4326", "expectedVersion", 1,
                "reason", "تعديل متزامن", "method", "DRAWN"));
        assertThat(a.status()).isEqualTo(200);
        assertThat(b.status()).isEqualTo(409);
        assertThat(b.code()).isEqualTo("GEOMETRY_STALE");
        JsonNode current = admin.get("/sites/" + main).body().path("geometry");
        assertThat(current.path("version").asInt()).isEqualTo(2);
        assertSameCoordinates(current.path("geojson").path("coordinates"), JSON.valueToTree(editA).path("coordinates"));
        Res invalid = admin.post("/sites/" + main + "/geometry", Map.of("geometry", bowTie(lat0, lng0), "crs", "EPSG:4326",
                "expectedVersion", 2, "reason", "شكل غير صالح", "method", "DRAWN"));
        assertThat(invalid.status()).isEqualTo(400);
        assertThat(versions(main)).isEqualTo(2);
        assertThat(login("req").post("/sites/" + main + "/geometry", Map.of("geometry", drawn, "crs", "EPSG:4326",
                "expectedVersion", 2, "reason", "بلا صلاحية", "method", "DRAWN")).status()).isEqualTo(403);
    }

    // ---- MAP-08 ------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("MAP-08 / AT-31: coverage is computed from the viewport, zoom and selected package (full, partial, none)")
    void coverage() {
        Api req = login("req");
        JsonNode pkgs = req.get("/map/packages").body();
        String pkg = null;
        for (JsonNode p : pkgs) {
            if ("overlay".equals(p.path("role").asText())) {
                pkg = p.path("id").asText();
            }
        }
        assertThat(pkg).isNotNull();
        String base = "&from=2028-01-01T00:00:00Z&to=2028-01-02T00:00:00Z&packageId=" + pkg;
        assertThat(req.get("/map/features?bbox=55.25,25.15,55.40,25.25&zoom=12" + base).body().path("coverage").path("status").asText())
                .isEqualTo("FULL");
        JsonNode partial = req.get("/map/features?bbox=55.40,25.10,55.60,25.20&zoom=12" + base).body().path("coverage");
        assertThat(partial.path("status").asText()).isEqualTo("PARTIAL");
        assertThat(partial.path("fraction").asDouble()).isBetween(0.25, 0.35);
        assertThat(partial.path("message").asText()).contains("تغطية جزئية");
        JsonNode none = req.get("/map/features?bbox=46.5,24.5,46.9,24.9&zoom=12" + base).body().path("coverage");
        assertThat(none.path("status").asText()).isEqualTo("NONE");
        assertThat(none.path("message").asText()).contains("خارج تغطية");
        assertThat(req.get("/map/features?bbox=55.25,25.15,55.40,25.25&zoom=4" + base).body().path("coverage").path("status").asText())
                .isEqualTo("ZOOM_OUT_OF_RANGE");
        assertThat(req.get("/map/features?bbox=55.25,25.15,55.40,25.25&packageId=" + UUID.randomUUID()).body().path("coverage")
                .path("status").asText()).isEqualTo("NO_PACKAGE");
        JsonNode context = req.get("/map/context").body();
        assertThat(context.path("aerialInstalled").asBoolean()).isFalse();
        assertThat(context.path("extent").size()).isEqualTo(4);
    }

    // ---- MAP-09 / MAP-10 ------------------------------------------------------------------------------------------

    String state(JsonNode fc, UUID site, UUID resource) {
        for (JsonNode r : feature(fc, site).path("resources")) {
            if (r.path("id").asText().equals(resource.toString())) {
                return r.path("state").asText();
            }
        }
        return null;
    }

    JsonNode at(Api api, String from, String to) {
        String q = "/map/features?bbox=" + bbox() + "&from=" + from + (to == null ? "&open=true" : "&to=" + to);
        Res r = api.get(q);
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        return r.body();
    }

    boolean checkFree(Api api, UUID resource, String from, String to) {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("resourceIds", List.of(resource.toString()));
        body.put("start", from);
        body.put("end", to);
        return api.post("/availability/check", body).body().path("available").asBoolean();
    }

    @Test
    @DisplayName("MAP-09: hours, days and open periods match known reservations at the half-open boundaries and handover")
    void periodBoundaries() {
        UUID hand = res("RH", main, null, "EXCLUSIVE", 30);
        Api req = login("req");
        Api apr = login("apr");
        UUID r1 = req.submitted(type, orgA, List.of(resMain, hand), "2028-03-10T08:00:00Z", "2028-03-10T12:00:00Z");
        assertThat(apr.approve(apr.taskFor(r1), 1).status()).isEqualTo(200);
        UUID r2 = req.submitted(type, orgA, List.of(resMain), "2028-04-01T00:00:00Z", "2028-04-02T00:00:00Z");
        assertThat(apr.approve(apr.taskFor(r2), 1).status()).isEqualTo(200);

        String[][] cases = {
                // from, to, expected resMain, expected hand (30 min handover)
                {"2028-03-10T12:00:00Z", "2028-03-10T14:00:00Z", "FREE", "BLOCKED"},
                {"2028-03-10T12:30:00Z", "2028-03-10T14:00:00Z", "FREE", "FREE"},
                {"2028-03-10T11:00:00Z", "2028-03-10T13:00:00Z", "BLOCKED", "BLOCKED"},
                // ending at 08:00 is fine for resMain; with 30 min handover the booking would need 08:30
                {"2028-03-10T06:00:00Z", "2028-03-10T08:00:00Z", "FREE", "BLOCKED"},
                {"2028-03-10T05:00:00Z", "2028-03-10T07:30:00Z", "FREE", "FREE"},
                {day("2028-03-10"), day("2028-03-11"), "BLOCKED", "BLOCKED"},
                {day("2028-03-11"), day("2028-03-12"), "FREE", "FREE"},
                {"2028-03-10T11:59:00Z", null, "BLOCKED", "BLOCKED"},
                {"2028-03-10T12:30:00Z", null, "BLOCKED", "FREE"}, // open period reaches the April reservation of resMain
                {"2028-04-02T00:00:00Z", null, "FREE", "FREE"}};
        for (String[] c : cases) {
            JsonNode fc = at(req, c[0], c[1]);
            assertThat(state(fc, main, resMain)).as("resMain " + c[0] + " → " + c[1]).isEqualTo(c[2]);
            assertThat(state(fc, main, hand)).as("handover " + c[0] + " → " + c[1]).isEqualTo(c[3]);
            assertThat(checkFree(req, resMain, c[0], c[1])).as("check resMain " + c[0]).isEqualTo("FREE".equals(c[2]));
            assertThat(checkFree(req, hand, c[0], c[1])).as("check handover " + c[0]).isEqualTo("FREE".equals(c[3]));
            String site = feature(fc, main).path("availability").asText();
            String expected = "BLOCKED".equals(c[2]) && "BLOCKED".equals(c[3]) ? "BUSY"
                    : "BLOCKED".equals(c[2]) || "BLOCKED".equals(c[3]) ? "PARTIAL" : "FREE";
            assertThat(site).as("site " + c[0]).isEqualTo(expected);
        }
        assertThat(req.get("/map/features?bbox=" + bbox() + "&from=2028-03-10T12:00:00Z").status()).isEqualTo(400);
    }

    @Test
    @DisplayName("MAP-10: in a shared site one exclusive reservation blocks only its resource and parent; the site shows partial occupancy")
    void sharedSitePartial() {
        UUID shared = res("SH", deepSite, null, "SHARED", 0);
        UUID x1 = res("X1", deepSite, shared, "EXCLUSIVE", 0);
        UUID x2 = res("X2", deepSite, shared, "EXCLUSIVE", 0);
        UUID hall = res("HL", deepSite, null, "EXCLUSIVE", 0);
        UUID h1 = res("H1", deepSite, hall, "EXCLUSIVE", 0);
        UUID h2 = res("H2", deepSite, hall, "EXCLUSIVE", 0);
        Api req = login("req");
        Api mgr = login("mgr");
        Api apr = login("apr");
        String from = "2028-05-01T00:00:00Z", to = "2028-05-03T00:00:00Z";
        for (UUID id : List.of(req.submitted(type, orgA, List.of(x1, h1), from, to),
                req.submitted(type, deep3, List.of(shared), from, to),
                mgr.submitted(type, orgB, List.of(shared), from, to))) {
            assertThat(apr.approve(apr.taskFor(id), 1).status()).as("shared use is not exclusive").isEqualTo(200);
        }
        JsonNode fc = at(apr, from, to);
        assertThat(state(fc, deepSite, x1)).isEqualTo("BLOCKED");
        assertThat(state(fc, deepSite, x2)).isEqualTo("FREE");
        assertThat(state(fc, deepSite, shared)).isEqualTo("SHARED_IN_USE");
        assertThat(state(fc, deepSite, h1)).isEqualTo("BLOCKED");
        assertThat(state(fc, deepSite, h2)).isEqualTo("FREE");
        assertThat(state(fc, deepSite, hall)).isEqualTo("BLOCKED");
        JsonNode f = feature(fc, deepSite);
        assertThat(f.path("availability").asText()).isEqualTo("PARTIAL");
        Set<String> occupants = new HashSet<>();
        f.path("occupants").forEach(o -> occupants.add(o.path("id").asText()));
        assertThat(occupants).contains(orgA.toString(), orgB.toString(), deep3.toString());
        assertThat(feature(at(apr, from, to + "&resourceIds=" + x2), deepSite).path("availability").asText()).isEqualTo("FREE");
        assertThat(feature(at(apr, from, to + "&resourceIds=" + x1 + "," + h1), deepSite).path("availability").asText()).isEqualTo("BUSY");
        assertThat(checkFree(req, x2, from, to)).isTrue();
        assertThat(checkFree(req, x1, from, to)).isFalse();
    }

    // ---- MAP-11 / MAP-12 / MAP-13 / MAP-14 -------------------------------------------------------------------------

    @Test
    @DisplayName("MAP-11/12: a request started on the map keeps organisation, resources and period; under review it reserves nothing")
    void mapRequestReview() {
        Api req = login("req");
        String from = "2028-06-01T05:00:00Z", to = "2028-06-01T09:00:00Z";
        UUID id = req.draft(type, "MAP", deep3, List.of(resDeep, resMain), from, to, Map.of("reason", "مبرر اختبار كافٍ للطلب"));
        JsonNode d = req.get("/requests/" + id).body();
        assertThat(d.path("origin").asText()).isEqualTo("MAP");
        assertThat(d.path("ownerOrg").path("id").asText()).isEqualTo(deep3.toString());
        assertThat(d.path("resources").size()).isEqualTo(2);
        assertThat(d.path("period").path("start").asText()).isEqualTo(from);
        JsonNode draftBoundaries = req.get("/requests/" + id + "/boundaries").body();
        assertThat(draftBoundaries.path("pinned").asBoolean()).isFalse();
        assertThat(req.submit(id).status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from reservation where request_id = :id").param("id", id).query(Integer.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from reservation_lock l join reservation v on v.id = l.reservation_id where v.request_id = :id")
                .param("id", id).query(Integer.class).single()).isZero();
        JsonNode fc = at(req, from, to);
        assertThat(feature(fc, deepSite).path("administrative").asText()).isEqualTo("PENDING");
        assertThat(feature(fc, deepSite).path("pendingCount").asInt()).isEqualTo(1);
        assertThat(feature(fc, deepSite).path("availability").asText()).isEqualTo("FREE");

        Api apr = login("apr");
        assertThat(apr.decide(apr.taskFor(id), "RETURN", "عدّل الفترة من فضلك", 1).status()).isEqualTo(200);
        assertThat(feature(at(req, from, to), deepSite).path("administrative").asText()).isEqualTo("NONE");
        int version = req.get("/requests/" + id).body().path("version").asInt();
        Map<String, Object> patch = new java.util.LinkedHashMap<>();
        patch.put("expectedVersion", version);
        patch.put("period", Map.of("start", "2028-06-02T05:00:00Z", "end", "2028-06-02T09:00:00Z"));
        assertThat(req.patch("/requests/" + id + "/draft", patch).status()).isEqualTo(200);
        version = req.get("/requests/" + id).body().path("version").asInt();
        Res resubmit = req.post("/requests/" + id + "/submit", Map.of("expectedVersion", version, "resubmissionReason", "تعديل الفترة"),
                UUID.randomUUID().toString());
        assertThat(resubmit.status()).isEqualTo(200);
        assertThat(feature(at(req, "2028-06-02T05:00:00Z", "2028-06-02T09:00:00Z"), deepSite).path("administrative").asText()).isEqualTo("PENDING");
        assertThat(apr.decide(apr.taskFor(id), "REJECT", "رفض للاختبار", 2).status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from reservation where request_id = :id").param("id", id).query(Integer.class).single()).isZero();
        JsonNode pinned = req.get("/requests/" + id + "/boundaries?revision=2").body();
        assertThat(pinned.path("pinned").asBoolean()).isTrue();
        assertThat(pinned.path("boundaries").size()).isEqualTo(2);
    }

    @Test
    @DisplayName("MAP-13: two concurrent approvals of conflicting requests on one exclusive resource — exactly one succeeds")
    void concurrentApprovals() throws Exception {
        Api req = login("req");
        String from = "2028-07-01T00:00:00Z", to = "2028-07-04T00:00:00Z";
        UUID a = req.submitted(type, orgA, List.of(resSub), from, to);
        UUID b = req.submitted(type, orgA, List.of(resSub), "2028-07-02T00:00:00Z", "2028-07-05T00:00:00Z");
        assertThat(feature(at(req, from, to), sub).path("availability").asText()).isEqualTo("FREE");
        Api apr = login("apr");
        Api apr2 = login("apr2");
        String ta = apr.taskFor(a), tb = apr2.taskFor(b);
        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<Res> fa = pool.submit(() -> {
            go.await();
            return apr.approve(ta, 1);
        });
        Future<Res> fb = pool.submit(() -> {
            go.await();
            return apr2.approve(tb, 1);
        });
        go.countDown();
        List<Integer> statuses = List.of(fa.get().status(), fb.get().status());
        pool.shutdown();
        assertThat(statuses).containsExactlyInAnyOrder(200, 409);
        assertThat(activeReservations(resSub)).isEqualTo(1);
        assertThat(feature(at(req, from, to), sub).path("availability").asText()).isEqualTo("BUSY");
    }

    @Test
    @DisplayName("MAP-14: a boundary edited after approval leaves the request and its document on the original version")
    void boundaryPinnedAfterApproval() {
        Api admin = login("admin");
        Map<String, Object> v1 = irregular(lat0, lng0);
        assertThat(admin.post("/sites/" + main + "/geometry", Map.of("geometry", v1, "crs", "EPSG:4326", "expectedVersion", 0,
                "reason", "الحدود عند الطلب", "method", "DRAWN")).status()).isEqualTo(200);
        Api req = login("req");
        UUID id = req.submitted(type, orgA, List.of(resMain), "2028-08-01T00:00:00Z", "2028-08-02T00:00:00Z");
        Api apr = login("apr");
        String task = apr.taskFor(id);
        JsonNode doc = apr.get("/tasks/" + task + "/approval-document").body();
        assertThat(doc.toString()).contains("نسخ الحدود").contains("الإصدار 1");
        assertThat(apr.approve(task, 1).status()).isEqualTo(200);
        String canonical = jdbc.sql("select canonical::text from approval_document where request_id = :id").param("id", id)
                .query(String.class).single();
        assertThat(canonical).contains("boundaryVersions").contains("\"version\": 1");

        Map<String, Object> v2 = multi(lat0, lng0);
        assertThat(admin.post("/sites/" + main + "/geometry", Map.of("geometry", v2, "crs", "EPSG:4326", "expectedVersion", 1,
                "reason", "توسعة لاحقة", "method", "DRAWN")).status()).isEqualTo(200);
        JsonNode pinned = req.get("/requests/" + id + "/boundaries").body().path("boundaries").get(0);
        assertThat(pinned.path("version").asInt()).isEqualTo(1);
        assertThat(pinned.path("currentVersion").asInt()).isEqualTo(2);
        assertSameCoordinates(pinned.path("geojson").path("coordinates"), JSON.valueToTree(v1).path("coordinates"));
        JsonNode now = feature(at(req, "2028-08-01T00:00:00Z", "2028-08-02T00:00:00Z"), main).path("boundary");
        assertThat(now.path("version").asInt()).isEqualTo(2);
        assertThat(now.path("type").asText()).isEqualTo("MultiPolygon");
    }

    // ---- MAP-15 / MAP-16 --------------------------------------------------------------------------------------------

    @Test
    @DisplayName("MAP-15: summary viewer, facility manager and requester see nothing outside their scope in API, search, layers or counts")
    void roleScopes() {
        Api req = login("req");
        UUID pending = req.submitted(type, orgA, List.of(resSub), "2028-09-01T00:00:00Z", "2028-09-02T00:00:00Z");
        String period = "2028-09-01T00:00:00Z";

        // summary viewer limited to SUB: no responsible/occupant names, no request status or counts
        Api lim = login("lim");
        JsonNode l = at(lim, period, "2028-09-02T00:00:00Z");
        assertThat(siteIds(l)).containsExactly(sub.toString());
        JsonNode f = feature(l, sub);
        assertThat(f.path("view").asText()).isEqualTo("SUMMARY");
        assertThat(f.has("responsibleOrg")).isFalse();
        assertThat(f.has("occupants")).isFalse();
        assertThat(f.has("pendingCount")).isFalse();
        assertThat(f.path("administrative").asText()).isNotEqualTo("PENDING");
        assertThat(f.path("requestsVisible").asBoolean()).isFalse();
        Res hidden = lim.get("/sites/" + main);
        Res unknown = lim.get("/sites/" + UUID.randomUUID());
        assertThat(hidden.status()).isEqualTo(404);
        assertThat(hidden.body().path("message")).isEqualTo(unknown.body().path("message"));
        assertThat(lim.get("/sites/search?q=MAIN-" + sfx).body().size()).isZero();
        assertThat(lim.get("/map/boundaries/export").status()).isEqualTo(403);
        assertThat(lim.post("/availability/check", Map.of("resourceIds", List.of(resSub.toString()), "start", period,
                "end", "2028-09-02T00:00:00Z")).body().path("pendingRequests").isNull()).isTrue();

        // facility manager without VIEW: facility data, never request content or counts
        Api admin = login("admin");
        JsonNode a = feature(at(admin, period, "2028-09-02T00:00:00Z"), sub);
        assertThat(a.has("pendingCount")).isFalse();
        assertThat(a.path("administrative").asText()).isNotEqualTo("PENDING");
        assertThat(admin.get("/requests/" + pending).status()).isEqualTo(404);
        assertThat(admin.get("/requests/" + pending + "/boundaries").status()).isEqualTo(404);

        // requester: own organisation's tree only
        JsonNode r = at(req, period, "2028-09-02T00:00:00Z");
        assertThat(siteIds(r)).contains(main.toString(), sub.toString(), deepSite.toString()).doesNotContain(siteB.toString());
        assertThat(feature(r, sub).path("pendingCount").asInt()).isEqualTo(1);
        assertThat(req.get("/sites/" + siteB + "/geometry/versions").status()).isEqualTo(404);
        assertThat(req.post("/availability/check", Map.of("resourceIds", List.of(resB.toString()), "start", period,
                "end", "2028-09-02T00:00:00Z")).status()).isEqualTo(404);
        assertThat(req.get("/map/boundaries/export").status()).isEqualTo(403);
        assertThat(req.get("/sites/search?q=SB-" + sfx).body().size()).isZero();

        // export (EXPORT right) carries only boundaries of sites in scope
        admin.post("/sites/" + siteB + "/geometry", Map.of("geometry", irregular(lat0 + 0.02, lng0 + 0.02), "crs", "EPSG:4326",
                "expectedVersion", 0, "reason", "حدود للتصدير", "method", "DRAWN"));
        Api rev = login("rev");
        Res export = rev.get("/map/boundaries/export");
        assertThat(export.status()).isEqualTo(200);
        assertThat(new String(export.raw(), StandardCharsets.UTF_8)).contains("SB-" + sfx);
    }

    @Test
    @DisplayName("MAP-16: a scope change in an open session applies to the next map request")
    void scopeChangeInSession() {
        UUID extra = membership(jdbc.sql("select id from person where username = :u").param("u", "req-" + sfx).query(UUID.class).single(),
                "REQUESTER", orgB, null);
        Api req = login("req");
        assertThat(siteIds(features(req, ""))).contains(siteB.toString());
        jdbc.sql("update membership set valid_to = now(), ended_reason = 'test' where id = :id").param("id", extra).update();
        assertThat(siteIds(features(req, ""))).doesNotContain(siteB.toString()).contains(main.toString());
        assertThat(req.get("/sites/" + siteB).status()).isEqualTo(404);
    }

    // ---- map packages --------------------------------------------------------------------------------------------

    byte[] zip(Map<String, byte[]> files) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(out)) {
            for (Map.Entry<String, byte[]> e : files.entrySet()) {
                z.putNextEntry(new ZipEntry(e.getKey()));
                z.write(e.getValue());
                z.closeEntry();
            }
        }
        return out.toByteArray();
    }

    byte[] manifest(String code, String format, String path, byte[] content) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("code", code);
        m.put("name", "مخطط اختبار");
        m.put("version", "1.0");
        m.put("dataDate", "2026-10-29");
        m.put("source", "رسم اختبار");
        m.put("license", "CC0-1.0");
        m.put("attributionHtml", "مخطط اختبار");
        m.put("crs", "EPSG:4326");
        m.put("kind", "FACILITY_PLAN");
        m.put("minZoom", 14);
        m.put("maxZoom", 19);
        m.put("coverage", Map.of("minLat", lat0, "minLng", lng0, "maxLat", lat0 + 0.01, "maxLng", lng0 + 0.01));
        m.put("files", List.of(Map.of("role", "overlay", "format", format, "path", path, "sha256", Hashing.sha256(content))));
        return write(m).getBytes(StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("Map package manager: upload is checked, waits for review, is previewed by the manager only, then activated or disabled")
    void packageManager() throws Exception {
        String code = "test-plan-" + sfx;
        byte[] svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\" fill=\"#eee\"/></svg>"
                .getBytes(StandardCharsets.UTF_8);
        Api admin = login("admin");
        Api req = login("req");
        assertThat(multipart(req, "/map/packages", "p.zip", zip(Map.of("manifest.json", manifest(code, "SVG_OVERLAY", "plan.svg", svg),
                "plan.svg", svg)), Map.of()).status()).isEqualTo(403);
        byte[] evil = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".getBytes(StandardCharsets.UTF_8);
        Res script = multipart(admin, "/map/packages", "p.zip", zip(Map.of("manifest.json", manifest(code, "SVG_OVERLAY", "plan.svg", evil),
                "plan.svg", evil)), Map.of());
        assertThat(script.status()).isEqualTo(400);
        assertThat(script.body().path("message").asText()).contains("نصوص");
        Res tiles = multipart(admin, "/map/packages", "p.zip", zip(Map.of("manifest.json", manifest(code, "PMTILES", "plan.pmtiles", svg),
                "plan.pmtiles", svg)), Map.of());
        assertThat(tiles.status()).isEqualTo(400);
        assertThat(tiles.body().toString()).contains("PMTiles");
        Res traversal = multipart(admin, "/map/packages", "p.zip", zip(Map.of("../manifest.json", svg)), Map.of());
        assertThat(traversal.status()).isEqualTo(400);
        Res mismatch = multipart(admin, "/map/packages", "p.zip", zip(Map.of("manifest.json", manifest(code, "SVG_OVERLAY", "plan.svg", evil),
                "plan.svg", svg)), Map.of());
        assertThat(mismatch.body().path("message").asText()).contains("SHA-256");

        Res ok = multipart(admin, "/map/packages", "p.zip", zip(Map.of("manifest.json", manifest(code, "SVG_OVERLAY", "plan.svg", svg),
                "plan.svg", svg)), Map.of());
        assertThat(ok.status()).as(ok.toString()).isEqualTo(200);
        assertThat(ok.body().path("status").asText()).isEqualTo("PENDING_REVIEW");
        String id = ok.body().path("packages").get(0).path("id").asText();
        assertThat(req.get("/map/packages").body().toString()).doesNotContain(code);
        assertThat(req.get("/map/packages/" + id + "/content").status()).isEqualTo(404);
        assertThat(admin.get("/map/packages/" + id + "/content").status()).isEqualTo(200);
        assertThat(admin.post("/map/packages/" + code + "/1.0/status", Map.of("status", "ACTIVE")).status()).isEqualTo(400);
        assertThat(admin.post("/map/packages/" + code + "/1.0/status", Map.of("status", "ACTIVE", "reason", "روجعت الحزمة"))
                .status()).isEqualTo(200);
        assertThat(req.get("/map/packages").body().toString()).contains(code);
        Res content = req.get("/map/packages/" + id + "/content");
        assertThat(content.status()).isEqualTo(200);
        JsonNode cov = req.get("/map/features?bbox=" + (lng0 + 0.002) + "," + (lat0 + 0.002) + "," + (lng0 + 0.004) + "," + (lat0 + 0.004)
                + "&packageId=" + id + "&zoom=16").body().path("coverage");
        assertThat(cov.path("status").asText()).isEqualTo("FULL");
        assertThat(admin.post("/map/packages/" + code + "/1.0/status", Map.of("status", "DISABLED", "reason", "استبدلت بإصدار أحدث"))
                .status()).isEqualTo(200);
        assertThat(req.get("/map/packages/" + id + "/content").status()).isEqualTo(404);
    }
}
