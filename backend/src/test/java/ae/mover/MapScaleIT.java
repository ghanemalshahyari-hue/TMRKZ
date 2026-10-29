package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Map query time and response size at a declared site volume — 10,000 sites with registered boundaries (12-vertex
 * polygons) and 2,000 active reservations — separate from the organisation tree volume (7,000 / 200,000 in
 * ops/load). A measurement, not a capacity acceptance: the numbers go to docs/PERFORMANCE.md with the hardware. The
 * assertions only guard against pathological regressions and check that the spatial indexes are used.
 */
class MapScaleIT extends IntegrationTest {

    static final int SITES = 10_000;
    static final int RESERVATIONS = 2_000;

    @Test
    @DisplayName("Scale: /map/features for 10,000 sites with boundaries — viewport query time, size and index use")
    void tenThousandSites() throws Exception {
        UUID org = org("SCALE", null);
        person("scale", "APPROVER", org);
        String prefix = "SC-" + sfx + "-";
        long t0 = System.nanoTime();
        tx.executeWithoutResult(s -> {
            jdbc.sql("""
                    insert into site(id, code, name, kind, lat, lng)
                    select md5(:p || g)::uuid, :p || g, 'موقع قياس ' || g, 'مرفق',
                           30 + (g / 100) * 0.01 + 0.005, 40 + (g % 100) * 0.01 + 0.005 from generate_series(0, :n - 1) g""")
                    .param("p", prefix).param("n", SITES).update();
            jdbc.sql("""
                    insert into site_responsibility(id, site_id, organization_id, valid_from)
                    select md5('r' || :p || g)::uuid, md5(:p || g)::uuid, :org, '2026-01-01T00:00:00Z' from generate_series(0, :n - 1) g""")
                    .param("p", prefix).param("org", org).param("n", SITES).update();
            jdbc.sql("""
                    insert into resource(id, site_id, code, name, kind, policy)
                    select md5('x' || :p || g)::uuid, md5(:p || g)::uuid, 'R' || :p || g, 'مورد قياس ' || g, 'مورد', 'EXCLUSIVE'
                    from generate_series(0, :n - 1) g""").param("p", prefix).param("n", SITES).update();
            jdbc.sql("""
                    insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type,
                        original_format, original_crs, transform, reason)
                    select md5('g' || :p || g)::uuid, s.id, 1, ST_AsGeoJSON(b, 9)::jsonb, 'EPSG:4326', 'بيانات قياس', now(), b,
                           'Polygon', 'GEOJSON', 'EPSG:4326', 'لا تحويل', 'بيانات قياس'
                    from generate_series(0, :n - 1) g join site s on s.id = md5(:p || g)::uuid,
                         lateral (select ST_Buffer(s.marker, 0.003, 3) as b) x""").param("p", prefix).param("n", SITES).update();
            jdbc.sql("update site set geometry_version = 1 where code like :p").param("p", prefix + "%").update();
            jdbc.sql("""
                    insert into reservation(id, resource_id, organization_id, source, period_start, period_end, status)
                    select md5('v' || :p || g)::uuid, md5('x' || :p || (g * 5))::uuid, :org, 'SEED_IMPORT',
                           '2028-02-01T00:00:00Z', '2028-02-03T00:00:00Z', 'ACTIVE' from generate_series(0, :n - 1) g""")
                    .param("p", prefix).param("org", org).param("n", RESERVATIONS).update();
            jdbc.sql("""
                    insert into reservation_lock(reservation_id, resource_id, kind, period)
                    select md5('v' || :p || g)::uuid, md5('x' || :p || (g * 5))::uuid, 'X',
                           tstzrange('2028-02-01T00:00:00Z', '2028-02-03T00:00:00Z', '[)') from generate_series(0, :n - 1) g""")
                    .param("p", prefix).param("n", RESERVATIONS).update();
        });
        for (String t : List.of("site", "site_geometry_version", "resource", "reservation_lock", "reservation")) {
            jdbc.sql("analyze " + t).update();
        }
        long loadMs = (System.nanoTime() - t0) / 1_000_000;

        Api api = login("scale");
        String period = "&from=2028-02-01T20:00:00Z&to=2028-02-02T20:00:00Z";
        List<String> lines = new ArrayList<>();
        lines.add("MAP-SCALE sites=" + SITES + " reservations=" + RESERVATIONS + " load_ms=" + loadMs);
        String[][] views = {
                {"city 0.1°×0.1°", "40.30,30.30,40.40,30.40"},
                {"district 0.3°×0.3°", "40.20,30.20,40.50,30.50"},
                {"region 0.5°×0.5°", "40.00,30.00,40.50,30.50"},
                {"whole area 1°×1°", "40.00,30.00,41.00,31.00"}};
        JsonNode city = null;
        JsonNode whole = null;
        for (String[] v : views) {
            String url = "/map/features?bbox=" + v[1] + period + "&zoom=12";
            api.get(url); // warm-up
            List<Long> ms = new ArrayList<>();
            Res last = null;
            for (int i = 0; i < 5; i++) {
                long s = System.nanoTime();
                last = api.get(url);
                ms.add((System.nanoTime() - s) / 1_000_000);
                assertThat(last.status()).isEqualTo(200);
            }
            ms.sort(Long::compare);
            JsonNode body = last.body();
            int features = body.path("features").size();
            long withBoundary = 0;
            long busy = 0;
            for (JsonNode f : body.path("features")) {
                if (!f.path("boundary").isNull()) {
                    withBoundary++;
                }
                if ("BUSY".equals(f.path("availability").asText())) {
                    busy++;
                }
            }
            lines.add(String.format("MAP-SCALE view=%s features=%d boundaries=%d busy=%d bytes=%d median_ms=%d max_ms=%d limits=%s",
                    v[0], features, withBoundary, busy, last.raw().length, ms.get(2), ms.get(4),
                    body.path("limits").isMissingNode() ? "-" : body.path("limits").path("boundariesOmitted").asText("-")));
            assertThat(ms.get(2)).as("median for " + v[0]).isLessThan(5000);
            if (v[0].startsWith("city")) {
                city = body;
            }
            if (v[0].startsWith("whole")) {
                whole = body;
            }
        }
        assertThat(city.path("features").size()).isBetween(90, 130);
        assertThat(city.path("features").get(0).path("boundary").path("type").asText()).isEqualTo("Polygon");
        assertThat(whole.path("limits").path("boundariesOmitted").asBoolean()).isTrue();
        String plan = String.join("\n", jdbc.sql("""
                explain with env as (select ST_MakeEnvelope(40.30, 30.30, 40.40, 30.40, 4326) as e)
                select s.id from site s, env where s.status = 'ACTIVE' and s.marker && env.e
                union
                select s.id from site s join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version, env
                where s.status = 'ACTIVE' and g.geometry_type <> 'Point' and g.geom && env.e""").query(String.class).list());
        lines.add("MAP-SCALE plan uses site_marker_idx=" + plan.contains("site_marker_idx")
                + " site_geometry_geom_idx=" + plan.contains("site_geometry_geom_idx"));
        assertThat(plan).contains("site_marker_idx").contains("site_geometry_geom_idx");
        lines.forEach(System.out::println);
        Path out = Path.of("target", "map-scale.txt");
        Files.createDirectories(out.getParent());
        Files.write(out, lines);
    }

    /** Test-only clean-up of the measurement rows (the delete guards are suspended for this table set only). */
    @AfterEach
    void cleanup() {
        String prefix = "SC-" + sfx + "-%";
        tx.executeWithoutResult(s -> {
            jdbc.sql("set constraints all immediate").update(); // no deferred checks pending when the guards come back
            for (String t : List.of("site", "resource", "site_geometry_version")) {
                jdbc.sql("alter table " + t + " disable trigger user").update();
            }
            jdbc.sql("delete from reservation_lock where resource_id in (select r.id from resource r join site x on x.id = r.site_id where x.code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("delete from reservation where resource_id in (select r.id from resource r join site x on x.id = r.site_id where x.code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("update site set geometry_version = null where code like :p").param("p", prefix).update();
            jdbc.sql("delete from site_geometry_version where site_id in (select id from site where code like :p)").param("p", prefix).update();
            jdbc.sql("delete from resource where site_id in (select id from site where code like :p)").param("p", prefix).update();
            jdbc.sql("delete from site_responsibility where site_id in (select id from site where code like :p)").param("p", prefix).update();
            jdbc.sql("delete from site where code like :p").param("p", prefix).update();
            for (String t : List.of("site", "resource", "site_geometry_version")) {
                jdbc.sql("alter table " + t + " enable trigger user").update();
            }
        });
    }
}
