package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;

import ae.mover.IntegrationTest;
import ae.mover.common.Json;
import ae.mover.stationing.StationingEventSender.Destination.Result;

/**
 * Stationing V3 foundation (ADR-031, migration V18) on the disposable PostgreSQL + PostGIS with OpenFGA in the loop:
 * the append-only versioned policy and its audit, terrain classes from a slope raster (half-open bands, no-data cells,
 * largest share, priority tie and its block, version pinning), authoritative stationing by data correction with its
 * outbound event in the same transaction, links that never become stationing, the read contract filtered by VIEW
 * scope, and the outbound sender over an HTTP test transport (sequence per unit, retry, parking, audited replay).
 */
class StationingFoundationIT extends IntegrationTest {

    @Autowired
    StationingOutbox outbox;
    @Autowired
    Json json;

    UUID root, orgA, orgA1, orgB, s1, s2, s3;
    static final double S = 1.0 / 3600; // one arc-second, as GLO-30
    double ulx, uly;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgA1 = org("A1", orgA);
        orgB = org("B", root);
        s1 = site("S1", null, orgA);
        s2 = site("S2", null, orgA);
        s3 = site("S3", null, orgB);
        person("sysadmin", role("POLICY", "ALL", "CONFIGURE"), root);
        person("corrA", role("CORR", "ORGANIZATION", "CORRECT_STATIONING", "VIEW"), orgA);
        person("linkA", role("LINK", "ORGANIZATION", "MANAGE_SITE_LINKS", "VIEW"), orgA);
        person("viewB", role("VIEWB", "ORGANIZATION", "VIEW"), orgB);
        person("reqA", role("REQ", "ORGANIZATION", "CREATE"), orgA);
        person("operator", role("OPS", "ALL", "REPLAY_STATIONING_EVENTS"), root);
        person("nobody", role("NONE", "ORGANIZATION", "EXPORT"), orgB);
        ulx = 54.0 + Math.random() * 0.5;
        uly = 24.0 + Math.random() * 0.5;
    }

    // ---- schema --------------------------------------------------------------------------------------

    @Test
    @DisplayName("V18: tables, raster support, and an append-only policy history")
    void schema() {
        for (String t : List.of("stationing_policy_version", "org_stationing", "site_link", "stationing_outbox", "terrain_dataset",
                "terrain_slope")) {
            assertThat(jdbc.sql("select to_regclass(:t) is not null").param("t", t).query(Boolean.class).single()).as(t).isTrue();
        }
        assertThat(jdbc.sql("select count(*) from pg_extension where extname = 'postgis_raster'").query(Long.class).single()).isEqualTo(1);
        String dataset = dataset();
        assertThat(publish("sysadmin", policy(dataset, List.of("ROLLING", "FLAT", "HILLY")), null).status()).isEqualTo(200);
        assertThatThrownBy(() -> jdbc.sql("update stationing_policy_version set reason = 'تعديل لاحق' where true").update())
                .rootCause().hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.sql("delete from stationing_policy_version where true").update())
                .rootCause().hasMessageContaining("append-only");
    }

    // ---- policy --------------------------------------------------------------------------------------

    @Test
    @DisplayName("Policy: System Administrator only, validated, effective-dated, audited with previous and new values")
    void policyVersions() {
        String dataset = dataset();
        Map<String, Object> values = policy(dataset, List.of("ROLLING", "FLAT", "HILLY"));
        assertThat(publish("corrA", values, null).status()).isEqualTo(403);
        assertThat(publish("reqA", values, null).status()).isEqualTo(403);

        Map<String, Object> bad = new LinkedHashMap<>(values);
        Map<String, Object> allowances = new LinkedHashMap<>(allowances());
        allowances.remove("HILLY");
        bad.put("terrainAllowancesM", allowances);
        bad.put("terrainAppliesTo", "MIN_AND_MAX");
        bad.put("terrainSlopeClassification", Map.of("datasetCode", "NOT_LOADED", "datasetVersion", "9",
                "classes", classes()));
        Res r = publish("sysadmin", bad, null);
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.body().path("details").path("problems").toString())
                .contains("HILLY").contains("O-06").contains("NOT_LOADED");

        Map<String, Object> gap = new LinkedHashMap<>(values);
        List<Map<String, Object>> broken = new ArrayList<>(classes());
        broken.set(1, cls("UNDULATING", "متموّج", 2.5, 10.0));
        gap.put("terrainSlopeClassification", Map.of("datasetCode", "TEST_SLOPE", "datasetVersion", dataset, "classes", broken));
        assertThat(publish("sysadmin", gap, null).body().path("details").path("problems").toString()).contains("غير متصلة");

        Res v1 = publish("sysadmin", values, null);
        assertThat(v1.status()).as(v1.toString()).isEqualTo(200);
        int first = v1.body().path("version").path("version").asInt();
        assertThat(publish("sysadmin", values, Instant.now().minus(Duration.ofDays(1))).status()).isEqualTo(400);

        Map<String, Object> changed = new LinkedHashMap<>(values);
        changed.put("maxFootprintAreaM2", 150_000);
        Instant later = Instant.now().plus(Duration.ofDays(2));
        Res v2 = publish("sysadmin", changed, later);
        assertThat(v2.status()).isEqualTo(200);
        assertThat(v2.body().path("version").path("previousVersion").asInt()).isEqualTo(first);
        assertThat(v2.body().path("changes").size()).isEqualTo(1);
        assertThat(v2.body().path("changes").get(0).path("key").asText()).isEqualTo("maxFootprintAreaM2");

        JsonNode overview = login("reqA").get("/stationing/policy").body();
        assertThat(overview.path("inForce").path("version").asInt()).isEqualTo(first);
        assertThat(overview.path("scheduled").get(0).path("version").asInt()).isEqualTo(first + 1);
        assertThat(overview.path("initialSlopeClasses").get(0).path("code").asText()).isEqualTo("FLAT");
        assertThat(overview.path("initialSlopeClasses").get(4).path("toPct").isNull()).isTrue();
        assertThat(login("nobody").get("/stationing/policy").status()).isEqualTo(403);

        JsonNode audit = lastAudit("STATIONING_POLICY", "STATIONING_POLICY_PUBLISHED");
        assertThat(audit.path("reason").asText()).isEqualTo("تحديث قيم السياسة للاختبار");
        JsonNode change = audit.path("detail").path("changes").get(0);
        assertThat(change.path("key").asText()).isEqualTo("maxFootprintAreaM2");
        assertThat(change.path("previous").asDouble()).isEqualTo(200_000);
        assertThat(change.path("new").asDouble()).isEqualTo(150_000);
        assertThat(audit.path("detail").path("effectiveFrom").asText()).startsWith(later.toString().substring(0, 16));
        // the owner's audit fields (4 Nov 2026): stable identity, role, organisation, time, version and reference
        Map<String, Object> row = jdbc.sql("""
                select actor_person_id, actor_role, actor_org, occurred_at from audit_event
                 where entity_type = 'STATIONING_POLICY' and action = 'STATIONING_POLICY_PUBLISHED' order by id desc limit 1""")
                .query().singleRow();
        UUID publisher = jdbc.sql("select id from person where username = :u").param("u", "sysadmin-" + sfx).query(UUID.class).single();
        assertThat(row.get("actor_person_id")).isEqualTo(publisher);
        assertThat((String) row.get("actor_role")).isNotBlank();
        assertThat((String) row.get("actor_org")).isNotBlank();
        assertThat(row.get("occurred_at")).isNotNull();
        assertThat(audit.path("detail").path("actor").path("personId").asText()).isEqualTo(publisher.toString());
        assertThat(audit.path("detail").path("actor").path("employeeNo").asText()).isEqualTo("T-sysadmin-" + sfx);
        assertThat(audit.path("detail").path("version").asInt()).isEqualTo(first + 1);
        assertThat(audit.path("detail").path("reference").asText()).isEqualTo("قرار اختبار 1");
    }

    // ---- terrain -------------------------------------------------------------------------------------

    @Test
    @DisplayName("Terrain: half-open slope bands, no-data excluded, largest share, priority tie or block, pinned version")
    void terrainClasses() {
        String dataset = dataset();
        int v1 = publish("sysadmin", policy(dataset, List.of("ROLLING", "FLAT", "HILLY")), null).body().path("version").path("version").asInt();
        Api req = login("reqA");

        JsonNode all = req.post("/stationing/terrain/assess", Map.of("geometry", rect(0.1, 0.1, 19.9, 9.9))).body();
        assertThat(cells(all, "FLAT")).isEqualTo(90);        // cols 0–9 incl. 1.99 % in col 9
        assertThat(cells(all, "UNDULATING")).isEqualTo(45); // exactly 2.00 % is the next band
        assertThat(cells(all, "ROLLING")).isEqualTo(45);
        assertThat(all.path("coveredCells").asLong()).isEqualTo(180); // the no-data row is not counted
        assertThat(all.path("estimatedCells").asLong()).isBetween(190L, 200L); // 19.8 × 9.8 cells of geodesic area
        assertThat(all.path("controllingClass").asText()).isEqualTo("FLAT");
        assertThat(all.path("tie").asBoolean()).isFalse();
        assertThat(all.path("allowanceM").asDouble()).isZero();
        assertThat(all.path("primary").path("effectiveMaxM").asDouble()).isEqualTo(8000);
        assertThat(all.path("surfaceModel").asText()).isEqualTo("DSM");
        assertThat(all.path("encoding").asText()).isEqualTo(TerrainClassifier.ENCODING);
        assertThat(all.path("policyVersion").asInt()).isEqualTo(v1);

        // cols 10–19: 45 UNDULATING against 45 ROLLING; UNDULATING has no place in the priority → blocked
        JsonNode tied = req.post("/stationing/terrain/assess", Map.of("geometry", rect(9.8, 0.1, 19.9, 9.9))).body();
        assertThat(tied.path("tie").asBoolean()).isTrue();
        assertThat(tied.path("resolved").asBoolean()).isFalse();
        assertThat(tied.path("primary").path("effectiveMaxM").asDouble()).isEqualTo(8000);

        // the administrator orders the classes; the tie now resolves to the higher class and its allowance (max only)
        int v2 = publish("sysadmin", policy(dataset, List.of("UNDULATING", "ROLLING")), null).body().path("version").path("version").asInt();
        JsonNode resolved = req.post("/stationing/terrain/assess", Map.of("geometry", rect(9.8, 0.1, 19.9, 9.9))).body();
        assertThat(resolved.path("policyVersion").asInt()).isEqualTo(v2);
        assertThat(resolved.path("controllingClass").asText()).isEqualTo("UNDULATING");
        assertThat(resolved.path("allowanceM").asDouble()).isEqualTo(500);
        assertThat(resolved.path("primary").path("effectiveMinM").asDouble()).isEqualTo(5000);
        assertThat(resolved.path("primary").path("effectiveMaxM").asDouble()).isEqualTo(8500);
        // a request pinned to the earlier version is assessed under it, unchanged
        JsonNode pinned = req.post("/stationing/terrain/assess", Map.of("geometry", rect(9.8, 0.1, 19.9, 9.9), "policyVersion", v1)).body();
        assertThat(pinned.path("resolved").asBoolean()).isFalse();

        // only the no-data row: no coverage, no class
        assertThat(req.post("/stationing/terrain/assess", Map.of("geometry", rect(0.1, 9.1, 19.9, 9.9))).status()).isEqualTo(400);
        assertThat(login("nobody").post("/stationing/terrain/assess", Map.of("geometry", rect(0.1, 0.1, 19.9, 9.9))).status()).isEqualTo(403);
    }

    @Test
    @DisplayName("Terrain on real GLO-30 slope cells (N24E055 fixture): the pipeline's expected pixel-centre counts")
    void terrainOnRealFixture() throws Exception {
        String version = "real-" + sfx;
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into terrain_dataset(id, code, version, surface_model, slope_encoding, manifest, slope_sha256)
                values (:id, 'TEST_SLOPE', :v, 'DSM', 'SLOPE_PERCENT_X100_FLOOR_U16',
                        '{"processingVersion": "glo30-fixture"}', '097eb042092a60fdc172c0f7f10ae436e36a7727ee78c7d59504589d9588be0e')""")
                .param("id", id).param("v", version).update();
        String hex;
        try (InputStream in = getClass().getResourceAsStream("/terrain/slope-fixture.hexwkb")) {
            hex = new String(in.readAllBytes(), StandardCharsets.US_ASCII);
        }
        int tiles = 0;
        for (String line : hex.split("\\R")) {
            if (!line.isBlank()) {
                jdbc.sql("insert into terrain_slope(dataset_id, rast) values (:id, cast(:r as raster))").param("id", id)
                        .param("r", line.trim()).update();
                tiles++;
            }
        }
        assertThat(tiles).isEqualTo(9);
        JsonNode fixture;
        try (InputStream in = getClass().getResourceAsStream("/terrain/slope-fixture.json")) {
            fixture = JSON.readTree(in);
        }
        publish("sysadmin", policy(version, List.of("ROLLING", "FLAT", "HILLY")), null);
        JsonNode a = login("reqA").post("/stationing/terrain/assess", Map.of("geometry", JSON.convertValue(fixture.path("testPolygon"), Map.class)))
                .body();
        fixture.path("expectedCellsPixelCentre").fields().forEachRemaining(e ->
                assertThat(cells(a, e.getKey())).as(e.getKey()).isEqualTo(e.getValue().asLong()));
        assertThat(a.path("coveredCells").asLong()).isEqualTo(fixture.path("expectedCellsTotalPixelCentre").asLong());
        assertThat(a.path("controllingClass").asText()).isEqualTo("FLAT"); // 2737 of 6400 cells
        assertThat(a.path("tie").asBoolean()).isFalse();
        assertThat(a.path("processing").asText()).isEqualTo("glo30-fixture");
    }

    // ---- stationing and links ------------------------------------------------------------------------

    @Test
    @DisplayName("Correction: scoped permission, history kept, event in the same transaction, read contract by VIEW scope")
    void correctionAndReadContract() {
        Api corr = login("corrA");
        Instant t0 = Instant.now().minus(Duration.ofDays(30));
        Res first = corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", s1, "effectiveFrom", t0.toString(),
                "reason", "تسجيل التمركز القائم", "reference", "مذكرة 12/2026"));
        assertThat(first.status()).as(first.toString()).isEqualTo(200);
        assertThat(corr.post("/stationing/corrections", Map.of("organizationId", orgB, "siteId", s3, "reason", "خارج النطاق المسموح"))
                .status()).isEqualTo(403);
        assertThat(corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", s2,
                "effectiveFrom", Instant.now().plus(Duration.ofDays(1)).toString(), "reason", "تاريخ مستقبلي")).status()).isEqualTo(400);
        assertThat(corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", s1, "reason", "الموقع نفسه")).status())
                .isEqualTo(400);
        Res second = corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", s2, "reason", "تصحيح الموقع المسجل"));
        assertThat(second.status()).isEqualTo(200);

        JsonNode current = corr.get("/stationing/current?orgId=" + orgA).body();
        assertThat(current.size()).isEqualTo(1);
        assertThat(current.get(0).path("siteId").asText()).isEqualTo(s2.toString());
        JsonNode history = corr.get("/stationing/organizations/" + orgA + "/history").body();
        assertThat(history.size()).isEqualTo(2);
        assertThat(history.get(0).path("endReason").asText()).isEqualTo("CORRECTED");
        assertThat(history.get(0).path("reference").asText()).isEqualTo("مذكرة 12/2026");

        // another branch's viewer does not see unit A; a missing scope reads as not found
        assertThat(login("viewB").get("/stationing/current?orgId=" + orgA).body().size()).isZero();
        assertThat(login("viewB").get("/stationing/organizations/" + orgA + "/history").status()).isEqualTo(404);

        List<Map<String, Object>> events = events(orgA);
        assertThat(events).extracting(e -> e.get("event_type")).containsExactly("STATIONING_CORRECTED", "STATIONING_CORRECTED");
        JsonNode payload = json.tree((String) events.get(1).get("payload"));
        assertThat(payload.path("schema").asText()).isEqualTo("tmrkz.stationing.v1");
        assertThat(payload.path("orgCode").asText()).isEqualTo("A-" + sfx);
        assertThat(payload.path("siteId").asText()).isEqualTo(s2.toString());
        assertThat(payload.path("auditRef").asText()).startsWith("org_stationing:");
        assertThat(lastAudit("ORG_STATIONING", "STATIONING_CORRECTED").path("reason").asText()).isEqualTo("تصحيح الموقع المسجل");
    }

    @Test
    @DisplayName("Current stationing carries its site's place for a readable unit only, and opens nothing of the site (owner, 5 Nov 2026)")
    void currentStationingCarriesTheSitePlace() {
        // a site registered the way activation registers one: a boundary and no responsible organisation
        UUID registered = UUID.randomUUID();
        jdbc.sql("insert into site(id, code, name, kind, lat, lng) values (:id, :c, 'موقع سجّله التفعيل', 'موقع', 24.305, 54.305)")
                .param("id", registered).param("c", "ACT-" + sfx).update();
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, original_format)
                select :g, :s, 1, ST_AsGeoJSON(x.geom)::jsonb, 'EPSG:4326', 'تفعيل طلب إعادة تمركز (اختبار)', now(), x.geom, 'Polygon', 'GEOJSON'
                  from (select ST_GeomFromText('POLYGON((54.30 24.30, 54.31 24.30, 54.31 24.31, 54.30 24.31, 54.30 24.30))', 4326) as geom) x""")
                .param("g", UUID.randomUUID()).param("s", registered).update();
        jdbc.sql("update site set geometry_version = 1 where id = :s").param("s", registered).update();
        assertThat(jdbc.sql("select count(*) from site_responsibility where site_id = :s").param("s", registered).query(Long.class).single()).isZero();
        Api corr = login("corrA");
        Res siteBefore = corr.get("/sites/" + registered);
        boolean drawnBefore = corr.get("/map/features").body().path("features").toString().contains(registered.toString());
        assertThat(corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", registered,
                "reason", "تمركز في موقع سجّله التفعيل")).status()).isEqualTo(200);

        // 1 and 4: the reader of unit A's stationing gets the site's boundary with it, although no organisation is responsible
        JsonNode current = corr.get("/stationing/current?orgId=" + orgA).body();
        assertThat(current.size()).isEqualTo(1);
        JsonNode place = current.get(0).path("siteGeometry");
        assertThat(place.path("type").asText()).isEqualTo("Polygon");
        assertThat(place.path("coordinates").get(0).size()).isEqualTo(5);
        assertThat(corr.get("/stationing/current?siteId=" + registered).body().get(0).path("siteGeometry").path("type").asText()).isEqualTo("Polygon");

        // 2: whoever may not read unit A's stationing obtains neither the record nor the place
        assertThat(login("viewB").get("/stationing/current?orgId=" + orgA).body().size()).isZero();
        assertThat(login("viewB").get("/stationing/current?siteId=" + registered).body().size()).isZero();
        Res nobody = login("nobody").get("/stationing/current?siteId=" + registered);
        assertThat(nobody.status() == 403 || nobody.body().size() == 0).as(nobody.toString()).isTrue();

        // 3: the place of a readable stationing is not access to the site: the register and the map answer as before
        Res siteAfter = corr.get("/sites/" + registered);
        assertThat(siteAfter.status()).isEqualTo(siteBefore.status());
        assertThat(siteAfter.body() == null ? null : siteAfter.body().path("view").asText(null))
                .isEqualTo(siteBefore.body() == null ? null : siteBefore.body().path("view").asText(null));
        assertThat(corr.get("/map/features").body().path("features").toString().contains(registered.toString())).isEqualTo(drawnBefore);
        assertThat(login("viewB").get("/sites/" + registered).status()).isIn(403, 404);
        // the history keeps its own facts; only the current read carries a place
        assertThat(corr.get("/stationing/organizations/" + orgA + "/history").body().get(0).path("siteGeometry").isNull()).isTrue();
    }

    @Test
    @DisplayName("Links: own permission, never stationing or occupancy, published and ended with a reason")
    void linksAreNotStationing() {
        Api link = login("linkA");
        Res r = link.post("/site-links", Map.of("siteId", s3, "organizationId", orgA, "reason", "ارتباط إداري بالموقع"));
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        assertThat(link.post("/site-links", Map.of("siteId", s3, "organizationId", orgA, "reason", "ارتباط مكرر")).status()).isEqualTo(400);
        assertThat(login("corrA").post("/site-links", Map.of("siteId", s1, "organizationId", orgA, "reason", "دون صلاحية الربط")).status())
                .isEqualTo(403);
        assertThat(jdbc.sql("select count(*) from org_stationing where organization_id = :o").param("o", orgA).query(Long.class).single())
                .isZero();
        assertThat(link.get("/stationing/current?orgId=" + orgA).body().size()).isZero();
        assertThat(link.get("/site-links?orgId=" + orgA).body().size()).isEqualTo(1);
        assertThat(login("viewB").get("/site-links?siteId=" + s3).body().size()).isZero(); // unit A is outside B's scope

        String id = r.body().path("id").asText();
        assertThat(link.post("/site-links/" + id + "/end", Map.of("reason", "")).status()).isEqualTo(400);
        assertThat(link.post("/site-links/" + id + "/end", Map.of("reason", "انتهى الارتباط")).status()).isEqualTo(200);
        assertThat(link.get("/site-links?orgId=" + orgA).body().size()).isZero();
        assertThat(link.get("/site-links?orgId=" + orgA + "&includeEnded=true").body().get(0).path("endedReason").asText())
                .isEqualTo("انتهى الارتباط");
        assertThat(events(orgA)).extracting(e -> e.get("event_type")).containsExactly("SITE_LINK_CREATED", "SITE_LINK_ENDED");
    }

    // ---- outbound delivery ---------------------------------------------------------------------------

    @Test
    @DisplayName("Sender: HTTP test transport, idempotency key, sequence per unit, retry, parking and audited replay")
    void outboundDelivery() throws Exception {
        Api corr = login("corrA");
        corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", s1, "effectiveFrom",
                Instant.now().minus(Duration.ofDays(9)).toString(), "reason", "تسجيل أول"));
        corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", s2, "reason", "تسجيل ثانٍ"));
        List<String> mine = events(orgA).stream().map(e -> e.get("event_id").toString()).toList();
        assertThat(mine).hasSize(2);

        // 1. the HTTP destination against a local test consumer: payload, idempotency key, sequence
        List<String> received = Collections.synchronizedList(new ArrayList<>());
        List<String> keys = Collections.synchronizedList(new ArrayList<>());
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/events", ex -> {
            JsonNode body = JSON.readTree(ex.getRequestBody());
            received.add(body.path("eventId").asText());
            keys.add(ex.getRequestHeaders().getFirst("Idempotency-Key"));
            ex.sendResponseHeaders(204, -1);
            ex.close();
        });
        server.start();
        try {
            var http = new HttpStationingDestination(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/events"), null, json);
            StationingEventSender sender = new StationingEventSender(outbox.ledger(), http);
            for (int i = 0; i < 10 && !delivered(mine); i++) {
                sender.process(Instant.now(), 50);
            }
        } finally {
            server.stop(0);
        }
        assertThat(received.stream().filter(mine::contains).toList()).containsExactlyElementsOf(mine);
        assertThat(keys.stream().filter(mine::contains).toList()).containsExactlyElementsOf(mine);
        assertThat(delivered(mine)).isTrue();

        // 2. retry with back-off; the unit's later event waits behind the undelivered earlier one
        corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", s1, "reason", "تسجيل ثالث"));
        corr.post("/stationing/corrections", Map.of("organizationId", orgA, "siteId", s2, "reason", "تسجيل رابع"));
        List<String> next = events(orgA).stream().map(e -> e.get("event_id").toString()).filter(e -> !mine.contains(e)).toList();
        List<String> attempted = Collections.synchronizedList(new ArrayList<>());
        StationingEventSender failing = new StationingEventSender(outbox.ledger(), e -> {
            attempted.add(e.eventId().toString());
            return mine.contains(e.eventId().toString()) || !next.contains(e.eventId().toString()) ? Result.ok() : Result.retry("HTTP 503");
        });
        failing.process(Instant.now(), 50);
        assertThat(attempted).contains(next.get(0)).doesNotContain(next.get(1));
        Map<String, Object> head = row(next.get(0));
        assertThat(head.get("state")).isEqualTo("PENDING");
        assertThat(((Number) head.get("attempts")).intValue()).isEqualTo(1);
        assertThat(head.get("last_error")).isEqualTo("HTTP 503");

        // 3. a permanent refusal parks the event as FAILED; only an operator with a reason replays it, audited
        StationingEventSender refusing = new StationingEventSender(outbox.ledger(), e ->
                next.contains(e.eventId().toString()) ? Result.refuse("HTTP 422") : Result.ok());
        refusing.process(Instant.now().plus(Duration.ofMinutes(10)), 50);
        assertThat(row(next.get(0)).get("state")).isEqualTo("FAILED");
        assertThat(row(next.get(1)).get("state")).isEqualTo("PENDING"); // still behind the failed one, never skipped

        String path = "/stationing/outbox/" + next.get(0) + "/replay";
        assertThat(login("corrA").post(path, Map.of("reason", "إعادة الإرسال بعد الإصلاح")).status()).isEqualTo(403);
        assertThat(login("operator").post(path, Map.of("reason", "")).status()).isEqualTo(400);
        Res replay = login("operator").post(path, Map.of("reason", "إعادة الإرسال بعد إصلاح المستهلك"));
        assertThat(replay.status()).as(replay.toString()).isEqualTo(200);
        assertThat(replay.body().path("state").asText()).isEqualTo("PENDING");
        assertThat(lastAudit("STATIONING_EVENT", "STATIONING_EVENT_REPLAYED").path("reason").asText())
                .isEqualTo("إعادة الإرسال بعد إصلاح المستهلك");
        assertThat(login("operator").get("/stationing/outbox?state=PENDING").status()).isEqualTo(200);
        assertThat(login("reqA").get("/stationing/outbox").status()).isEqualTo(403);
    }

    // ---- helpers -------------------------------------------------------------------------------------

    /** A 20 × 10 one-arc-second slope raster: cols 0–8 1.50 %, col 9 1.99 %, cols 10–14 2.00 %, cols 15–19 12 %, row 9 no data. */
    String dataset() {
        String version = "t-" + sfx + "-" + (int) (Math.random() * 1e6);
        UUID id = UUID.randomUUID();
        StringBuilder a = new StringBuilder("ARRAY[");
        for (int r = 0; r < 10; r++) {
            a.append(r == 0 ? "[" : ",[");
            for (int c = 0; c < 20; c++) {
                int v = r == 9 ? 65535 : c < 9 ? 150 : c == 9 ? 199 : c < 15 ? 200 : 1200;
                a.append(c == 0 ? "" : ",").append(v);
            }
            a.append("]");
        }
        a.append("]::double precision[][]");
        jdbc.sql("""
                insert into terrain_dataset(id, code, version, surface_model, slope_encoding, manifest, slope_sha256)
                values (:id, 'TEST_SLOPE', :v, 'DSM', 'SLOPE_PERCENT_X100_FLOOR_U16', '{"processingVersion": "test-synthetic"}', 'test')""")
                .param("id", id).param("v", version).update();
        jdbc.sql("insert into terrain_slope(dataset_id, rast) select :id, ST_SetValues(ST_AddBand(ST_MakeEmptyRaster(20, 10, :x, :y, :s, :ns, 0, 0, 4326), "
                        + "'16BUI'::text, 0, 65535), 1, 1, 1, " + a + ")")
                .param("id", id).param("x", ulx).param("y", uly).param("s", S).param("ns", -S).update();
        return version;
    }

    /** A rectangle in pixel coordinates of the test raster (x = column, y = row from the top). */
    Map<String, Object> rect(double x0, double y0, double x1, double y1) {
        double w = ulx + x0 * S, e = ulx + x1 * S, n = uly - y0 * S, s = uly - y1 * S;
        return Map.of("type", "Polygon", "coordinates", List.of(List.of(List.of(w, s), List.of(e, s), List.of(e, n), List.of(w, n), List.of(w, s))));
    }

    static long cells(JsonNode assessment, String code) {
        for (JsonNode s : assessment.path("shares")) {
            if (s.path("code").asText().equals(code)) {
                return s.path("cells").asLong();
            }
        }
        return -1;
    }

    static Map<String, Object> cls(String code, String label, double from, Double to) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("label", label);
        m.put("fromPct", from);
        m.put("toPct", to);
        return m;
    }

    static List<Map<String, Object>> classes() {
        return List.of(cls("FLAT", "مستوٍ / شبه مستوٍ", 0, 2.0), cls("UNDULATING", "متموّج", 2, 10.0), cls("ROLLING", "تضاريس متدرجة", 10, 15.0),
                cls("HILLY", "تلال", 15, 30.0), cls("MOUNTAINOUS", "جبلي / شديد التضرس", 30, null));
    }

    /** Test values only: in production every allowance is the administrator's. */
    static Map<String, Object> allowances() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("FLAT", 0);
        m.put("UNDULATING", 500);
        m.put("ROLLING", 1000);
        m.put("HILLY", 2000);
        m.put("MOUNTAINOUS", 3000);
        return m;
    }

    static Map<String, Object> policy(String datasetVersion, List<String> priority) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("maxFootprintAreaM2", 200_000);
        p.put("deploymentRequirement", "REQUIRED");
        p.put("primary", Map.of("minM", 5000, "maxM", 8000, "terrainApplies", true));
        p.put("alternative", Map.of("minM", 3000, "maxM", 5000, "terrainApplies", true));
        p.put("terrainSlopeClassification", Map.of("datasetCode", "TEST_SLOPE", "datasetVersion", datasetVersion, "classes", classes()));
        p.put("terrainAllowancesM", allowances());
        p.put("terrainClassPriority", priority);
        p.put("terrainAppliesTo", "MAX_ONLY");
        p.put("exception", Map.of("allowed", true, "maxExtraM", 1000));
        p.put("crossBranch", Map.of("allowed", false, "authorities", List.of("OTHER_UNIT"), "independent", false));
        p.put("routing", Map.of("startAt", "SELF", "levels", List.of(Map.of("level", 6, "approves", true, "label", "المعتمد النهائي",
                "finalStage", true, "dependsOn", List.of()))));
        return p;
    }

    Res publish(String who, Map<String, Object> values, Instant effectiveFrom) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("values", values);
        body.put("effectiveFrom", effectiveFrom == null ? null : effectiveFrom.toString());
        body.put("reason", "تحديث قيم السياسة للاختبار");
        body.put("reference", "قرار اختبار 1");
        return login(who).post("/stationing/policy/versions", body);
    }

    List<Map<String, Object>> events(UUID org) {
        return jdbc.sql("select event_id, event_type, payload::text as payload from stationing_outbox where organization_id = :o order by seq")
                .param("o", org).query().listOfRows();
    }

    Map<String, Object> row(String eventId) {
        return jdbc.sql("select state, attempts, last_error from stationing_outbox where event_id = cast(:id as uuid)").param("id", eventId)
                .query().singleRow();
    }

    boolean delivered(List<String> ids) {
        return ids.stream().allMatch(id -> "DELIVERED".equals(row(id).get("state")));
    }

    JsonNode lastAudit(String entityType, String action) {
        Map<String, Object> r = jdbc.sql("""
                select reason, detail::text as detail from audit_event where entity_type = :t and action = :a order by id desc limit 1""")
                .param("t", entityType).param("a", action).query().singleRow();
        var node = JSON.createObjectNode();
        node.put("reason", (String) r.get("reason"));
        node.set("detail", json.tree((String) r.get("detail")));
        return node;
    }
}
