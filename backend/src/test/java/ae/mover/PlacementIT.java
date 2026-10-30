package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Stationing proposal on the map (ADR-025): configurable distance rules, the interactive check (range and occupancy of
 * registered boundaries in the requested period, with occupant identity only for those who may see it), the
 * organisations a move covers, and the server re-check at submission and at approval. A proposal never changes the
 * site register. The rules created here are limited to this test's own organisation tree so they never reach other
 * tests sharing the database.
 */
class PlacementIT extends IntegrationTest {

    UUID root, orgA, sectionAt, sectionElsewhere, orgB, hq, hqRes, elsewhere, busy, busyRes, free, freeRes;
    final double lat0 = 10 + Math.random() * 20;
    final double lng0 = 40 + Math.random() * 20;
    final double kmLng = 1 / (111.32 * Math.cos(Math.toRadians(lat0)));
    final double kmLat = 1 / 110.57;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        sectionAt = org("A1", orgA);
        sectionElsewhere = org("A2", orgA);
        orgB = org("B", root);
        hq = siteAt("HQ", orgA, lat0, lng0);
        hqRes = resource("RHQ", hq, null, 0);
        elsewhere = siteAt("EL", orgA, lat0 - 9 * kmLat, lng0);
        // the first section works at the current premises, the second at another site
        reserve(hqRes, sectionAt, "2026-01-01T00:00:00Z", null);
        reserve(resource("REL", elsewhere, null, 0), sectionElsewhere, "2026-01-01T00:00:00Z", null);
        // a site of B three kilometres north, occupied by B until mid-2027, with a registered boundary
        busy = siteAt("BUSY", orgB, lat0 + 3 * kmLat, lng0);
        boundary(busy, lat0 + 3 * kmLat, lng0, 0.4);
        busyRes = resource("RBUSY", busy, null, 0);
        reserve(busyRes, orgB, "2026-01-01T00:00:00Z", "2027-07-01T00:00:00Z");
        // a free registered site of A four kilometres east
        free = siteAt("FREE", orgA, lat0, lng0 + 4 * kmLng);
        boundary(free, lat0, lng0 + 4 * kmLng, 0.3);
        freeRes = resource("RFREE", free, null, 0);
        person("req", "REQUESTER", orgA);
        person("reqb", "REQUESTER", orgB);
        person("apr", "APPROVER", root);
        person("cfg", role("CFG", "ALL", "CONFIGURE"), root);
    }

    UUID siteAt(String code, UUID org, double lat, double lng) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into site(id, code, name, kind, lat, lng) values (:id, :c, :n, 'مرفق', :lat, :lng)")
                .param("id", id).param("c", code + "-" + sfx).param("n", "موقع " + code + " " + sfx).param("lat", lat).param("lng", lng).update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("s", id).param("o", org).update();
        return id;
    }

    /** A square boundary of the given half-size (km) around a point, as the site's current registered version. */
    void boundary(UUID site, double lat, double lng, double halfKm) {
        double a = halfKm * kmLat, b = halfKm * kmLng;
        String gj = "{\"type\":\"Polygon\",\"coordinates\":[[[" + (lng - b) + "," + (lat - a) + "],[" + (lng + b) + "," + (lat - a) + "],["
                + (lng + b) + "," + (lat + a) + "],[" + (lng - b) + "," + (lat + a) + "],[" + (lng - b) + "," + (lat - a) + "]]]}";
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from)
                values (:id, :s, 1, cast(:g as jsonb), 'EPSG:4326', 'TEST', now())""")
                .param("id", UUID.randomUUID()).param("s", site).param("g", gj).update();
        jdbc.sql("update site set geometry_version = 1 where id = :s").param("s", site).update();
    }

    void reserve(UUID resource, UUID org, String start, String end) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into reservation(id, resource_id, organization_id, source, period_start, period_end, status)
                values (:id, :r, :o, 'SEED_IMPORT', cast(:a as timestamptz), cast(:b as timestamptz), 'ACTIVE')""")
                .param("id", id).param("r", resource).param("o", org).param("a", start).param("b", end).update();
        jdbc.sql("insert into reservation_lock(reservation_id, resource_id, kind, period) values (:id, :r, 'X', tstzrange(cast(:a as timestamptz), cast(:b as timestamptz), '[)'))")
                .param("id", id).param("r", resource).param("a", start).param("b", end).update();
    }

    void rule(double min, double max) {
        Res r = login("cfg").post("/placement/rules", Map.of("name", "قاعدة اختبار " + sfx, "action", "RELOCATE",
                "organizationId", root.toString(), "includeDescendants", true, "minM", min, "maxM", max, "measure", "CENTER",
                "reason", "إعداد قاعدة الاختبار"));
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
    }

    static Map<String, Object> point(double lat, double lng) {
        return Map.of("type", "Point", "coordinates", List.of(lng, lat));
    }

    Map<String, Object> check(double lat, double lng, String start, String end) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("action", "RELOCATE");
        b.put("organizationId", orgA.toString());
        b.put("fromSiteId", hq.toString());
        b.put("stationLevel", "BRANCH");
        b.put("geometry", point(lat, lng));
        b.put("start", start);
        b.put("end", end);
        return b;
    }

    @Test
    @DisplayName("Distance rules are configuration: only CONFIGURE saves them, with validation and audit")
    void rules() {
        Res denied = login("req").post("/placement/rules", Map.of("name", "x", "action", "RELOCATE", "minM", 0, "maxM", 10, "reason", "محاولة"));
        assertThat(denied.status()).isEqualTo(403);
        Res bad = login("cfg").post("/placement/rules", Map.of("name", "قاعدة خاطئة", "action", "RELOCATE", "minM", 5000, "maxM", 1000,
                "reason", "حدود مقلوبة"));
        assertThat(bad.status()).isEqualTo(400);
        rule(1000, 6000);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'PLACEMENT_RULE_SAVED' and entity_label = :n")
                .param("n", "قاعدة اختبار " + sfx).query(Integer.class).single()).isEqualTo(1);
        // map users read the active rules (policy, not request content)
        JsonNode list = login("req").get("/placement/rules").body();
        boolean found = false;
        for (JsonNode r : list) {
            found |= r.path("name").asText().equals("قاعدة اختبار " + sfx);
        }
        assertThat(found).isTrue();
    }

    @Test
    @DisplayName("The check measures against the configured range: too close, inside and too far")
    void range() {
        Api req = login("req");
        JsonNode none = req.post("/placement/check", check(lat0, lng0 + 3.5 * kmLng, day("2026-12-01"), null)).body();
        assertThat(none.path("range").asText()).isEqualTo("NO_RULE");
        rule(1000, 6000);
        JsonNode in = req.post("/placement/check", check(lat0, lng0 + 3.5 * kmLng, day("2026-12-01"), null)).body();
        assertThat(in.path("ok").asBoolean()).as(in.toString()).isTrue();
        assertThat(in.path("distanceM").asDouble()).isBetween(3400.0, 3600.0);
        JsonNode close = req.post("/placement/check", check(lat0, lng0 + 0.5 * kmLng, day("2026-12-01"), null)).body();
        assertThat(close.path("range").asText()).isEqualTo("TOO_CLOSE");
        assertThat(close.path("ok").asBoolean()).isFalse();
        JsonNode far = req.post("/placement/check", check(lat0, lng0 + 8 * kmLng, day("2026-12-01"), null)).body();
        assertThat(far.path("status").asText()).isEqualTo("OUT_OF_RANGE");
        assertThat(far.path("messages").get(0).asText()).contains("الحد الأقصى");
    }

    @Test
    @DisplayName("An occupied boundary refuses the point for an overlapping period; its user is named only to those who may see it")
    void occupancy() {
        rule(1000, 6000);
        double lat = lat0 + 3 * kmLat;
        JsonNode mine = login("req").post("/placement/check", check(lat, lng0 + 0.1 * kmLng, day("2026-12-01"), null)).body();
        assertThat(mine.path("status").asText()).as(mine.toString()).isEqualTo("OCCUPIED");
        JsonNode c = mine.path("conflicts").get(0);
        assertThat(c.path("blocking").asBoolean()).isTrue();
        assertThat(c.has("siteId")).isFalse();
        assertThat(c.has("occupants")).isFalse();
        assertThat(c.path("label").asText()).isEqualTo("منطقة مشغولة غير ظاهرة لك");
        // after the booking ends the same place is available (the period is checked, not only the place)
        JsonNode later = login("req").post("/placement/check", check(lat, lng0 + 0.1 * kmLng, day("2027-08-01"), day("2027-09-01"))).body();
        assertThat(later.path("ok").asBoolean()).as(later.toString()).isTrue();
        // someone who may see the site gets its name; the occupant is the organisation itself, so nothing blocks it
        Map<String, Object> asB = check(lat, lng0, day("2026-12-01"), null);
        asB.put("organizationId", orgB.toString());
        asB.put("fromSiteId", busy.toString());
        JsonNode b = login("reqb").post("/placement/check", asB).body();
        assertThat(b.path("conflicts").size()).as(b.toString()).isZero();
    }

    @Test
    @DisplayName("Covered organisations: branches at the current premises are marked, a branch elsewhere is listed with its site")
    void units() {
        JsonNode units = login("req").get("/placement/units?orgId=" + orgA + "&siteId=" + hq).body();
        Map<String, JsonNode> byId = new LinkedHashMap<>();
        units.forEach(u -> byId.put(u.path("id").asText(), u));
        assertThat(byId.get(sectionAt.toString()).path("atSite").asBoolean()).isTrue();
        assertThat(byId.get(sectionElsewhere.toString()).path("atSite").asBoolean()).isFalse();
        assertThat(byId.get(orgB.toString())).isNull();
    }

    @Test
    @DisplayName("Submission refuses an out-of-range proposal; approval refuses a site booked after submission; the register never changes")
    void serverRecheck() {
        rule(1000, 6000);
        String type = requestType("RELOCATION", finalOnly(), null);
        Api req = login("req");
        UUID id = req.draft(type, "MAP", orgA, List.of(hqRes), day("2026-12-01"), null, Map.of("reason", "مبرر اختبار كافٍ للطلب"));
        Map<String, Object> proposal = new LinkedHashMap<>();
        proposal.put("organizationId", orgA.toString());
        proposal.put("fromSiteId", hq.toString());
        proposal.put("proposedName", "المقر المقترح");
        proposal.put("geometry", point(lat0, lng0 + 8 * kmLng));
        proposal.put("action", "RELOCATE");
        proposal.put("stationLevel", "BRANCH");
        proposal.put("includedOrgIds", List.of(sectionAt.toString()));
        Res saved = req.put("/requests/" + id + "/relocation", proposal);
        assertThat(saved.status()).as(saved.toString()).isEqualTo(200);
        assertThat(saved.body().path("checkStatus").asText()).isEqualTo("OUT_OF_RANGE");
        Res refused = req.submit(id);
        assertThat(refused.status()).isEqualTo(400);
        assertThat(refused.toString()).contains("الحد الأقصى");

        // a branch outside the organisation is not accepted as covered
        proposal.put("includedOrgIds", List.of(orgB.toString()));
        assertThat(req.put("/requests/" + id + "/relocation", proposal).status()).isEqualTo(400);

        // the free registered site, inside the range
        proposal.put("includedOrgIds", List.of(sectionAt.toString()));
        proposal.put("geometry", point(lat0, lng0 + 4 * kmLng));
        proposal.put("targetSiteId", free.toString());
        proposal.put("temporary", true);
        proposal.put("temporaryEnd", day("2027-03-01"));
        Res ok = req.put("/requests/" + id + "/relocation", proposal);
        assertThat(ok.body().path("checkStatus").asText()).as(ok.toString()).isEqualTo("OK");
        assertThat(ok.body().path("includedOrgs").get(0).path("id").asText()).isEqualTo(sectionAt.toString());
        Res sent = req.submit(id);
        assertThat(sent.status()).as(sent.toString()).isEqualTo(200);
        // a temporary stationing carries its end into the submitted period
        assertThat(jdbc.sql("select period_end is not null from request where id = :id").param("id", id).query(Boolean.class).single()).isTrue();

        // the free site is booked by another organisation after submission: the decision is refused
        reserve(freeRes, orgB, "2026-11-01T00:00:00Z", "2027-12-31T00:00:00Z");
        Api apr = login("apr");
        Res decision = apr.approve(apr.taskFor(id), 1);
        assertThat(decision.status()).isEqualTo(400);
        assertThat(decision.toString()).contains("لا يمكن اعتماد الطلب الآن");
        assertThat(req.get("/requests/" + id).body().path("status").asText()).isEqualTo("SUBMITTED");
        // the current premises keep their marker
        assertThat(jdbc.sql("select lat from site where id = :id").param("id", hq).query(Double.class).single()).isEqualTo(lat0);
    }
}
