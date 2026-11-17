package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Deleting a site (owner decisions, 17 Nov 2026; ADR-086): the setup administrator erases a site completely, with its
 * inside sites and the stationing of the units there (each unit then stationed nowhere, an event says so); whoever else
 * manages the site asks, and the administrator approves or refuses; what a request, a booking or a permission still
 * refers to stops it, writing nothing. Fictional data only.
 */
class SiteDeletionIT extends RestationingTestBase {

    UUID fresh, fresh2, facMgr;
    double siteLat;

    @BeforeEach
    void deletionFixtures() {
        UUID snapshot = publishedSnapshot();
        fresh = hrOrg("SDA", sec, 10, snapshot);
        fresh2 = hrOrg("SDB", sec, 10, snapshot);
        siteLat = lat0 + 0.09;
        person("setup", role("SDADM", "ALL", "VIEW", "MANAGE_FACILITIES", "MANAGE_SITE_LINKS", "CORRECT_STATIONING"), top);
        facMgr = person("facMgr", role("SDFAC", "ORGANIZATION", "VIEW", "MANAGE_FACILITIES"), sec);
        person("nobody", role("SDVIEW", "ORGANIZATION", "VIEW"), other);
    }

    private String name(String tag) {
        return "موقع حذف " + tag + " " + sfx;
    }

    /** A site with its unit's initial stationing (no areas), the site responsible to {@code sec}, at {@code dLat} north. */
    private UUID setUp(String tag, UUID unit, double dLat) {
        Map<String, Object> site = new LinkedHashMap<>();
        site.put("code", "");
        site.put("name", name(tag));
        site.put("kind", "معسكر");
        site.put("responsibleOrgId", sec.toString());
        site.put("location", Map.of("lat", siteLat + dLat, "lng", lng0));
        Map<String, Object> boundary = new LinkedHashMap<>();
        boundary.put("geometry", square(siteLat + dLat, lng0, 0.0008));
        boundary.put("crs", "EPSG:4326");
        boundary.put("expectedVersion", 0);
        boundary.put("method", "DRAWN");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("site", site);
        body.put("boundary", boundary);
        body.put("units", List.of(Map.of("organizationId", unit.toString())));
        body.put("reason", "تهيئة موقع للاختبار");
        Res r = login("setup").post("/site-setup", body);
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        return UUID.fromString(r.body().path("site").path("id").asText());
    }

    private UUID inside(UUID parent, String tag, double dLat) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("code", "");
        s.put("name", name(tag));
        s.put("kind", "موقع");
        s.put("parentId", parent.toString());
        s.put("responsibleOrgId", sec.toString());
        s.put("location", Map.of("lat", siteLat + dLat, "lng", lng0));
        s.put("reason", "موقع داخلي للاختبار");
        Res r = login("setup").post("/sites", s);
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        return UUID.fromString(r.body().path("id").asText());
    }

    private long count(String sql, Object... params) {
        var q = jdbc.sql(sql);
        for (int i = 0; i < params.length; i++) {
            q = q.param("p" + i, params[i]);
        }
        return q.query(Long.class).single();
    }

    @Test
    @DisplayName("DEL-01 the setup administrator erases a site with its inside site and its unit's stationing; the unit is stationed nowhere, an event and one audit line say so")
    void erasesCompletely() {
        UUID site = setUp("A", fresh, 0);
        UUID kid = inside(site, "A-in", 0.0004);
        Res impact = login("setup").get("/sites/" + site + "/deletion");
        assertThat(impact.status()).as(impact.toString()).isEqualTo(200);
        assertThat(impact.body().path("inside")).hasSize(1);
        assertThat(impact.body().path("stationed")).hasSize(1);
        assertThat(impact.body().path("blockers")).isEmpty();
        assertThat(impact.body().path("canDelete").asBoolean()).isTrue();

        Res bad = login("setup").post("/sites/" + site + "/deletion", Map.of("reason", "قص"));
        assertThat(bad.status()).as("a reason is required").isEqualTo(400);
        Res done = login("setup").post("/sites/" + site + "/deletion", Map.of("reason", "موقع أُنشئ بالخطأ أثناء التهيئة"));
        assertThat(done.status()).as(done.toString()).isEqualTo(200);
        assertThat(done.body().path("deleted")).hasSize(2);

        assertThat(count("select count(*) from site where id in (:p0, :p1)", site, kid)).as("both sites are gone").isZero();
        assertThat(count("select count(*) from org_stationing where organization_id = :p0", fresh)).as("the unit is stationed nowhere").isZero();
        assertThat(count("select count(*) from site_geometry_version where site_id = :p0", site)).isZero();
        assertThat(count("select count(*) from stationing_outbox where organization_id = :p0 and event_type = 'STATIONING_REMOVED'", fresh)).isEqualTo(1);
        assertThat(count("select count(*) from audit_event where action = 'SITE_DELETED' and entity_id = :p0", site.toString())).isEqualTo(1);
        // the unit can be set up again
        setUp("A2", fresh, 0.02);
    }

    @Test
    @DisplayName("DEL-02 whoever manages the site asks; the administrator refuses (the site stays) or approves (erased); one open request per site; others are refused")
    void requestThenDecide() {
        UUID site = setUp("B", fresh2, 0);
        Res seen = login("facMgr").get("/sites/" + site + "/deletion");
        assertThat(seen.status()).as(seen.toString()).isEqualTo(200);
        assertThat(seen.body().path("canDelete").asBoolean()).isFalse();
        assertThat(seen.body().path("canRequest").asBoolean()).isTrue();
        assertThat(login("facMgr").post("/sites/" + site + "/deletion", Map.of("reason", "لم يعد مستخدماً")).status()).as("only the administrator deletes").isEqualTo(403);
        assertThat(login("nobody").get("/sites/" + site + "/deletion").status()).isEqualTo(403);

        Res asked = login("facMgr").post("/sites/" + site + "/deletion-requests", Map.of("reason", "لم يعد مستخدماً"));
        assertThat(asked.status()).as(asked.toString()).isEqualTo(200);
        String rq = asked.body().path("id").asText();
        assertThat(login("facMgr").post("/sites/" + site + "/deletion-requests", Map.of("reason", "مرة ثانية للاختبار")).status()).as("one open request").isEqualTo(400);
        Res list = login("setup").get("/site-deletion-requests");
        assertThat(list.status()).as(list.toString()).isEqualTo(200);
        assertThat(list.body().findValuesAsText("id")).as(list.toString()).contains(rq);
        assertThat(count("select count(*) from notification where kind = 'SITE_DELETION' and body like :p0", "%" + name("B") + "%")).as("the administrators are told").isPositive();

        Res refused = login("setup").post("/site-deletion-requests/" + rq + "/decision", Map.of("decision", "REFUSE", "reason", "الموقع ما زال مستخدماً"));
        assertThat(refused.status()).as(refused.toString()).isEqualTo(200);
        assertThat(count("select count(*) from site where id = :p0", site)).as("refused: the site stays").isEqualTo(1);
        assertThat(count("select count(*) from notification where person_id = :p0 and kind = 'SITE_DELETION'", facMgr)).as("the requester is told").isEqualTo(1);

        String rq2 = login("facMgr").post("/sites/" + site + "/deletion-requests", Map.of("reason", "أُخلي الموقع")).body().path("id").asText();
        Res approved = login("setup").post("/site-deletion-requests/" + rq2 + "/decision", Map.of("decision", "APPROVE", "reason", "أُخلي الموقع فعلاً"));
        assertThat(approved.status()).as(approved.toString()).isEqualTo(200);
        assertThat(count("select count(*) from site where id = :p0", site)).isZero();
        assertThat(jdbc.sql("select state from site_deletion_request where id = cast(:id as uuid)").param("id", rq2).query(String.class).single()).isEqualTo("APPROVED");
    }

    @Test
    @DisplayName("DEL-03 a permission scoped to the site (or its inside site) stops the deletion, naming the reason; nothing is written")
    void blocked() {
        UUID site = setUp("C", fresh, 0);
        UUID kid = inside(site, "C-in", 0.0004);
        person("scoped", role("SDSCOPE", "ORGANIZATION", "VIEW"), sec, kid);
        Res impact = login("setup").get("/sites/" + site + "/deletion");
        assertThat(impact.body().path("blockers").toString()).contains("مقيدة");
        Res r = login("setup").post("/sites/" + site + "/deletion", Map.of("reason", "موقع أُنشئ بالخطأ"));
        assertThat(r.status()).isEqualTo(400);
        assertThat(count("select count(*) from site where id in (:p0, :p1)", site, kid)).as("nothing is written").isEqualTo(2);
        assertThat(count("select count(*) from org_stationing where organization_id = :p0", fresh)).isEqualTo(1);
    }
}
