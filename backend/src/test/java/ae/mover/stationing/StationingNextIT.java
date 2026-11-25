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
 * The complete request phase (ADR-045), on real PostgreSQL + PostGIS with OpenFGA in the loop: initial stationing, deployment
 * areas that belong to a unit, site registration, the configured stages after the hierarchy, FYI distribution and the
 * read-only operational posture. Fictional data only; holders and policy values here are test values, not defaults.
 */
class StationingNextIT extends RestationingTestBase {

    UUID fresh, fresh2, shared;

    @org.junit.jupiter.api.AfterEach
    void noPathsLeftBehind() {
        jdbc.sql("update restationing_request set route_version_id = null where route_version_id is not null").update();
        jdbc.sql("delete from stationing_route_version").update();
        // the organisation-wide FYI list (ADR-095 B2) is shared by every later activation in this database: leave none behind
        if (otherSec != null) {
            jdbc.sql("delete from fyi_designation where unit_id = :u").param("u", otherSec).update();
        }
    }

    /**
     * ADR-095 B2: «وحدات العلم» are configured once, organisation-wide, in {@code fyi_designation}, and every final approval
     * distributes to them inside its own transaction. The application has no endpoint writing this table yet (ADR-095 B3 —
     * see docs/evidence/regression-18/CLASSIFICATION.md), so the configuration is a fixture here.
     */
    private void designateFyi(UUID unit) {
        jdbc.sql("insert into fyi_designation(unit_id, include_descendants, set_by) values (:u, false, :by) on conflict do nothing")
                .param("u", unit).param("by", personId("sysadmin")).update();
    }

    @BeforeEach
    void next() {
        UUID snapshot = publishedSnapshot();
        fresh = hrOrg("FRESH", sec, 10, snapshot);
        fresh2 = hrOrg("FRESH2", sec, 10, snapshot);
        shared = siteWithBoundary("SHARED", lat0 + 0.05, lng0, top);
        // «مقدم الطلب» (ADR-078): one right for re-stationing and deployment areas, and site registration
        person("rq", role("NXREQ", "ORGANIZATION", "VIEW", "CREATE_RESTATIONING", "REQUEST_SITE_REGISTRATION"), sec);
        person("ops", role("NXOPS", "ORGANIZATION", "VIEW", "DECIDE_UNIT_OPERATIONS"), top);
        person("fin", role("NXFIN", "ORGANIZATION", "VIEW", "FINAL_APPROVE_STATIONING"), top);
        person("opsOther", role("NXOPS2", "ORGANIZATION", "VIEW", "DECIDE_UNIT_OPERATIONS"), other);
        person("viewer", role("NXPOST", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), sec);
        person("outsider", role("NXPOST2", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), other);
        Res policy = login("sysadmin").get("/stationing/policy");
        Map<String, Object> values = new LinkedHashMap<>(JSON.convertValue(policy.body().path("inForce").path("values"), Map.class));
        values.put("approvalStages", Map.of("unitOperations", true, "finalByPermission", true, "fyiBeforeActivation", true));
        Res published = login("sysadmin").post("/stationing/policy/versions", Map.of("values", values, "reason", "مراحل مهيأة للاختبار", "reference", "اختبار 2"));
        assertThat(published.status()).as(published.toString()).isEqualTo(200);
    }

    private JsonNode hubUnit(String who, UUID unit) {
        Res hub = login(who).get("/request-hub");
        for (JsonNode u : hub.body().path("units")) {
            if (unit.toString().equals(u.path("id").asText())) {
                return u;
            }
        }
        throw new AssertionError("not in the hub: " + unit + " " + hub);
    }

    private static boolean allowed(JsonNode unit, String action) {
        for (JsonNode a : unit.path("actions")) {
            if (action.equals(a.path("action").asText())) {
                return a.path("allowed").asBoolean();
            }
        }
        return false;
    }

    private String request(String purpose, Map<String, Object> content, UUID requesting) {
        Res r = login("rq").post("/restationing-requests", Map.of("requestingUnitId", requesting.toString(), "purpose", purpose, "content", content));
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        return r.body().path("id").asText();
    }

    private Map<String, Object> initial(List<UUID> units) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("kind", "PERMANENT");
        c.put("scope", units.stream().map(UUID::toString).toList());
        c.put("existingSite", shared.toString());
        c.put("reason", "تمركز أولي للاختبار");
        return c;
    }

    /** Both areas of one unit, with its own distances from the shared site; {@code north} moves the pair so two units differ. */
    private Map<String, Object> deployment(UUID unit, double north) {
        double lat = lat0 + 0.05 + north;
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("kind", "PERMANENT");
        c.put("scope", List.of(unit.toString()));
        c.put("primary", square(lat, lng0 + offsetLng(6_000), 0.002));
        c.put("alternative", square(lat + offsetLat(4_000), lng0 + offsetLng(6_000), 0.002));
        c.put("reason", "مناطق انتشار للاختبار");
        return c;
    }

    /**
     * Hierarchy, unit operations, final approval: each by its own holder. Since ADR-095 the final approval activates and
     * distributes FYI in the same transaction — there is no separate FYI or activation step.
     */
    private JsonNode wholeRoute(String id) {
        Res s = login("rq").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(s.status()).as(s.toString()).isEqualTo(200);
        assertThat(decide("apSec", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("apDept", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("apTop", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("ops", id, "APPROVE").status()).isEqualTo(200);
        Res fin = decide("fin", id, "APPROVE");
        assertThat(fin.status()).as(fin.toString()).isEqualTo(200);
        assertThat(fin.body().path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");
        assertThat(fin.body().path("activation").path("by").path("id").asText()).as("the final approver activates").isEqualTo(personId("fin").toString());
        assertThat(jdbc.sql("select fyi_done_at is not null from restationing_request where id = cast(:id as uuid)").param("id", id)
                .query(Boolean.class).single()).as("FYI handled within the final approval").isTrue();
        return fin.body();
    }

    private String areaOf(UUID unit, String role) {
        return jdbc.sql("select ST_AsText(geom) from deployment_area where organization_id = :o and role = :r and state = 'ACTIVE'")
                .param("o", unit).param("r", role).query(String.class).single();
    }

    @Test
    @DisplayName("ADR-078: initial stationing is site setup only — no request, no card; once set up, the unit's deployment request takes the whole configured route, each stage only to its holder; FYI opens one request and grants nothing")
    void initialStationingIsSiteSetup() {
        JsonNode u = hubUnit("rq", fresh);
        assertThat(u.path("state").asText()).isEqualTo("NO_STATIONING");
        assertThat(allowed(u, "INITIAL_STATIONING")).as("no initial-stationing request any more").isFalse();
        assertThat(u.path("actions").toString()).doesNotContain("INITIAL_STATIONING");
        assertThat(allowed(u, "RESTATIONING")).as("a unit stationed nowhere has nothing to re-station").isFalse();
        assertThat(allowed(u, "DEPLOYMENT_AREAS")).isFalse();
        for (JsonNode a : u.path("actions")) {
            if (!a.path("allowed").asBoolean()) {
                assertThat(a.path("reason").asText()).as("the reason points to site setup").contains("تهيئة المواقع");
            }
        }
        for (JsonNode card : login("rq").get("/request-hub").body().path("actions")) {
            assertThat(card.path("action").asText()).as("no card for it").isNotEqualTo("INITIAL_STATIONING");
        }
        assertThat(login("stranger").get("/request-hub").body().path("units")).as("no right, no unit").isEmpty();

        // a forged re-stationing for a unit stationed nowhere is refused by the server's checks
        Map<String, Object> forged = permanent(List.of(fresh));
        Res rs = login("rq").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "content", forged));
        Res forgedSent = login("rq").post("/restationing-requests/" + rs.body().path("id").asText() + "/submit", Map.of());
        assertThat(forgedSent.status()).isEqualTo(400);
        assertThat(forgedSent.body().toString()).contains("تهيئة المواقع");

        // the purpose can no longer be created, by anyone
        person("platformAdminInit", "SYSTEM_ADMIN", top);
        for (String who : List.of("rq", "apSec", "platformAdminInit")) {
            Res refused = login(who).post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "INITIAL_STATIONING",
                    "content", initial(List.of(fresh))));
            assertThat(refused.status()).as(who + " " + refused).isEqualTo(400);
            assertThat(refused.body().path("message").asText()).contains("تهيئة المواقع");
        }
        assertThat(jdbc.sql("select count(*) from restationing_request where purpose = 'INITIAL_STATIONING' and jsonb_exists(content->'scope', :u)")
                .param("u", fresh.toString()).query(Long.class).single()).isZero();

        // initial stationing is recorded by site setup («تثبيت» on the site's card, ADR-076)
        person("setupAdmin", role("NXSETUP", "ALL", "MANAGE_FACILITIES", "MANAGE_SITE_LINKS", "CORRECT_STATIONING"), top);
        assertThat(login("rq").post("/stationing/corrections", Map.of("organizationId", fresh.toString(), "siteId", shared.toString(),
                "reason", "تمركز أولي من التهيئة")).status()).as("never a requester's").isEqualTo(403);
        Res setUp = login("setupAdmin").post("/stationing/corrections", Map.of("organizationId", fresh.toString(), "siteId", shared.toString(),
                "reason", "تمركز أولي من التهيئة"));
        assertThat(setUp.status()).as(setUp.toString()).isEqualTo(200);
        JsonNode stationed = hubUnit("rq", fresh);
        assertThat(stationed.path("state").asText()).isEqualTo("DEPLOYMENT_MISSING");
        assertThat(allowed(stationed, "DEPLOYMENT_AREAS")).as("«طلب إعادة التمركز ومناطق الانتشار» opens it").isTrue();
        assertThat(allowed(stationed, "RESTATIONING")).isTrue();

        assertThat(login("apSec").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "DEPLOYMENT_AREAS",
                "content", deployment(fresh, 0))).status()).as("its own right").isEqualTo(403);
        String id = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        assertThat(login("rq").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "DEPLOYMENT_AREAS",
                "content", deployment(fresh, 0.1))).status()).as("one open request per unit").isEqualTo(400);
        Res s = login("rq").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(s.status()).as(s.toString()).isEqualTo(200);
        assertThat(keys(s.body().path("route"))).containsExactly("H:" + sec, "H:" + dept, "H:" + top, "O:operations", "F:final");
        assertThat(s.body().path("route").get(2).path("final").asBoolean()).as("the hierarchy no longer closes the route").isFalse();

        assertThat(login("apSec").get("/restationing-requests/" + id).body().path("can").path("decide").asBoolean()).isTrue();
        assertThat(login("apSec").get("/restationing-requests/" + id).body().path("can").path("decideAs").asText()).isEqualTo("اعتماد");
        assertThat(decide("ops", id, "APPROVE").status()).as("not yet its stage").isEqualTo(403);
        assertThat(decide("rq", id, "APPROVE").code()).isEqualTo("SEPARATION_OF_DUTIES");
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        decide("apTop", id, "APPROVE");

        assertThat(login("apTop").get("/restationing-requests/" + id).body().path("can").path("decide").asBoolean()).as("a hierarchy approver holds no operations stage").isFalse();
        assertThat(decide("apDept", id, "APPROVE").status()).isIn(403, 409, 400);
        assertThat(decide("opsOther", id, "APPROVE").status()).as("outside the holder's scope").isIn(403, 404);
        assertThat(decide("fin", id, "APPROVE").status()).as("final holder before its stage").isEqualTo(403);
        JsonNode atOps = login("ops").get("/restationing-requests/" + id).body();
        assertThat(atOps.path("can").path("decide").asBoolean()).isTrue();
        assertThat(atOps.path("can").path("decideAs").asText()).isEqualTo("اعتماد عمليات الوحدة");
        // the stamps (ADR-055): none before the stage is approved
        JsonNode noStamp = login("rq").get("/restationing-requests/" + id + "/stamps").body();
        assertThat(noStamp.path("unitOperations").isNull()).isTrue();
        assertThat(noStamp.path("final").isNull()).isTrue();
        assertThat(decide("ops", id, "APPROVE").status()).isEqualTo(200);
        JsonNode opsStamp = login("rq").get("/restationing-requests/" + id + "/stamps").body();
        assertThat(opsStamp.path("unitOperations").path("name").asText()).as("the approver as recorded").isEqualTo("شخص ops");
        assertThat(opsStamp.path("unitOperations").path("at").asText()).isNotBlank();
        assertThat(opsStamp.path("final").isNull()).isTrue();
        assertThat(login("fin").get("/restationing-requests/" + id).body().path("can").path("decideAs").asText()).isEqualTo("اعتماد نهائي");
        assertThat(decide("ops", id, "APPROVE").status()).as("one human decides one stage").isIn(403, 409);

        // ADR-095: FYI is configured once (B2) and the final approval distributes it while it activates; the recipient
        // holds some permission — none at all opens nothing (owner, 16 Nov 2026)
        UUID reader = holding("reader", otherSec);
        designateFyi(otherSec);
        UUID parentBefore = jdbc.sql("select parent_id from organization where id = :o").param("o", fresh).query(UUID.class).single();
        Res act = decide("fin", id, "APPROVE");
        assertThat(act.status()).as(act.toString()).isEqualTo(200);
        assertThat(act.body().path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");
        JsonNode both = login("rq").get("/restationing-requests/" + id + "/stamps").body();
        assertThat(both.path("final").path("name").asText()).isEqualTo("شخص fin");
        assertThat(both.path("number").asText()).isEqualTo(login("rq").get("/restationing-requests/" + id).body().path("number").asText());
        assertThat(both.path("mainUnit").asText()).isNotBlank();
        assertThat(login("stranger").get("/restationing-requests/" + id + "/stamps").status()).as("only on a request one may see").isEqualTo(404);

        // no separate activation or FYI action remains: activation is offered to nobody, the per-request FYI endpoint is gone
        assertThat(login("activator").get("/restationing-requests/" + id).body().path("can").path("activate").asBoolean()).isFalse();
        assertThat(login("activator").post("/restationing-requests/" + id + "/fyi", Map.of("units", List.of(other.toString()))).status())
                .as("ADR-095 removed the per-request FYI endpoint").isIn(404, 405);

        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and title like 'للعلم:%'").param("p", reader).query(Long.class).single()).isEqualTo(1);
        Api readerApi = login("reader");
        assertThat(readerApi.get("/restationing-requests/" + id).status()).as("this one request").isEqualTo(200);
        assertThat(readerApi.get("/restationing-requests/" + rs.body().path("id").asText()).status()).as("not any other").isEqualTo(404);
        assertThat(readerApi.post("/restationing-requests/" + id + "/decision", Map.of("decision", "APPROVE")).status()).isIn(400, 403);
        long recordsBefore = jdbc.sql("select count(*) from org_stationing where request_id = cast(:id as uuid)").param("id", id).query(Long.class).single();
        Res readerActivate = readerApi.post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(readerActivate.status()).as("the retained endpoint is a no-op returning the view it may read (ADR-095): " + readerActivate).isEqualTo(200);
        assertThat(readerActivate.body().path("readOnlyFyi").asBoolean()).isTrue();
        assertThat(readerActivate.body().path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");
        assertThat(jdbc.sql("select count(*) from org_stationing where request_id = cast(:id as uuid)").param("id", id).query(Long.class).single())
                .as("a reader's call changes nothing").isEqualTo(recordsBefore);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", reader).query(Long.class).single()).as("no lasting right beyond its own").isEqualTo(1);

        assertThat(jdbc.sql("select site_id from org_stationing where organization_id = :o and valid_to is null").param("o", fresh).query(UUID.class).single()).isEqualTo(shared);
        assertThat(jdbc.sql("select count(*) from deployment_area where organization_id = :o and state = 'ACTIVE'").param("o", fresh).query(Long.class).single()).isEqualTo(2);
        assertThat(jdbc.sql("select parent_id from organization where id = :o").param("o", fresh).query(UUID.class).single()).as("Oracle's hierarchy is untouched").isEqualTo(parentBefore);
        assertThat(jdbc.sql("select count(*) from org_stationing where organization_id = :o").param("o", fresh2).query(Long.class).single()).as("nobody else moves").isZero();
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'DEPLOYMENT_AREAS_ACTIVATED'").param("id", id).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'RESTATIONING_FYI_DISTRIBUTED'").param("id", id).query(Long.class).single()).isEqualTo(1);

        JsonNode after = hubUnit("rq", fresh);
        assertThat(after.path("state").asText()).isEqualTo("DEPLOYMENT_COMPLETE");
        assertThat(allowed(after, "RESTATIONING")).isTrue();
        assertThat(allowed(after, "DEPLOYMENT_AREAS")).isFalse();
    }

    @Test
    @DisplayName("ADR-078: an initial-stationing request from before the decision can still be read and cancelled, never edited or sent again")
    void oldInitialStationingRequestStaysReadable() {
        // as written before ADR-078: a draft for a unit stationed nowhere, inserted directly (it can no longer be created)
        UUID old = UUID.randomUUID();
        jdbc.sql("""
                insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind, start_at, reason, content, created_at, updated_at, purpose)
                values (:id, :n, :by, :unit, 'DRAFT', 'PERMANENT', now(), 'تمركز أولي قديم', cast(:c as jsonb), now(), now(), 'INITIAL_STATIONING')""")
                .param("id", old).param("n", "RS-OLD-" + sfx).param("by", personId("rq")).param("unit", sec)
                .param("c", write(Map.of("kind", "PERMANENT", "scope", List.of(fresh.toString()), "existingSite", shared.toString(),
                        "reason", "تمركز أولي قديم", "occupants", Map.of(), "exceptions", Map.of())))
                .update();
        Res seen = login("rq").get("/restationing-requests/" + old);
        assertThat(seen.status()).as(seen.toString()).isEqualTo(200);
        assertThat(seen.body().path("purpose").asText()).isEqualTo("INITIAL_STATIONING");
        assertThat(seen.body().path("can").path("edit").asBoolean()).isFalse();
        assertThat(seen.body().path("can").path("submit").asBoolean()).isFalse();
        assertThat(login("rq").get("/restationing-requests/" + old + "/checks").status()).as("its checks still read").isEqualTo(200);
        Res sent = login("rq").post("/restationing-requests/" + old + "/submit", Map.of());
        assertThat(sent.status()).isEqualTo(400);
        assertThat(sent.body().path("message").asText()).contains("تهيئة المواقع");
        assertThat(login("rq").put("/restationing-requests/" + old + "/content", initial(List.of(fresh))).status()).isEqualTo(400);
        assertThat(login("rq").get("/restationing-requests").body().findValuesAsText("id")).contains(old.toString());
    }

    @Test
    @DisplayName("ADR-062 in the stationing engine: levels with no approver, own or inherited, are skipped and recorded; the request goes on to unit operations, then final; never approved by nobody")
    void hierarchyLevelsWithNobodyAreSkipped() {
        // the department and the top have no approver now, neither of their own nor from above
        for (String who : List.of("apDept", "apTop")) {
            jdbc.sql("update membership set valid_to = now() where person_id = (select id from person where username = :u)").param("u", who + "-" + sfx).update();
        }
        stationed(fresh, shared);
        String id = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        Res s = login("rq").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(s.status()).as(s.toString()).isEqualTo(200);
        JsonNode route = s.body().path("route");
        assertThat(keys(route)).containsExactly("H:" + sec, "H:" + dept, "H:" + top, "O:operations", "F:final");
        List<String> marks = new java.util.ArrayList<>();
        route.forEach(x -> marks.add(x.path("mark").asText("-")));
        assertThat(marks).as("the section waits for its own approver; the two empty levels are passed").containsExactly("-", "SKIPPED", "SKIPPED", "-", "-");
        assertThat(route.get(1).path("skipReasonCode").asText()).isEqualTo("NO_HIERARCHY_APPROVER");
        assertThat(route.get(1).path("decidedBy").isNull()).as("nobody approved it").isTrue();
        List<java.util.Map<String, Object>> skips = jdbc.sql("""
                select organization_id, organization_name, hierarchy_order, reason_code, revision from restationing_route_skip
                 where request_id = cast(:id as uuid) order by hierarchy_order""").param("id", id).query().listOfRows();
        assertThat(skips).extracting(m -> m.get("organization_id")).containsExactly(dept, top);
        assertThat(skips).allSatisfy(m -> {
            assertThat(m.get("reason_code")).isEqualTo("NO_HIERARCHY_APPROVER");
            assertThat(((Number) m.get("revision")).intValue()).isEqualTo(1);
        });
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'HIERARCHY_LEVEL_SKIPPED'").param("id", id).query(Long.class).single()).isEqualTo(1);

        assertThat(decide("ops", id, "APPROVE").status()).as("unit operations waits for the hierarchy").isEqualTo(403);
        assertThat(decide("apSec", id, "APPROVE").status()).isEqualTo(200);
        JsonNode atOps = login("ops").get("/restationing-requests/" + id).body();
        assertThat(atOps.path("can").path("decideAs").asText()).as("straight to unit operations after the section").isEqualTo("اعتماد عمليات الوحدة");
        assertThat(decide("ops", id, "APPROVE").status()).isEqualTo(200);
        Res fin = decide("fin", id, "APPROVE");
        assertThat(fin.body().path("state").asText()).as("the final approval is never skipped; it activates (ADR-095)").isEqualTo("ACTIVATED_PERMANENT");
        assertThat(fin.body().path("finalApprover").path("id").asText()).as("approved by a person, never by nobody").isEqualTo(personId("fin").toString());
    }

    @Test
    @DisplayName("A new site and its boundary are one act: a boundary that overlaps a registered site leaves no site, and the code stays free")
    void aRefusedBoundaryLeavesNoSite() {
        double lat = lat0 + 0.05;
        double lng = lng0;
        Map<String, Object> overlapping = Map.of("type", "Polygon", "coordinates", List.of(List.of(List.of(lng - 0.001, lat - 0.001), List.of(lng + 0.001, lat - 0.001), List.of(lng + 0.001, lat + 0.001), List.of(lng - 0.001, lat + 0.001), List.of(lng - 0.001, lat - 0.001))));
        Map<String, Object> site = new LinkedHashMap<>();
        site.put("code", "ATOMIC-1");
        site.put("name", "موقع يُرفض");
        site.put("kind", "موقع");
        site.put("location", Map.of("lat", lat, "lng", lng));
        site.put("reason", "تسجيل موقع للاختبار");
        site.put("responsibleOrgId", top.toString());
        Map<String, Object> boundary = Map.of("geometry", overlapping, "crs", "EPSG:4326", "expectedVersion", 0, "reason", "حدود للاختبار", "method", "DRAWN");
        person("sites", role("NXSITES", "ORGANIZATION", "VIEW", "MANAGE_FACILITIES"), top);
        Api admin = login("sites");
        Res refused = admin.post("/sites/with-boundary", Map.of("site", site, "boundary", boundary));
        assertThat(refused.status()).as(refused.toString()).isEqualTo(400);
        assertThat(jdbc.sql("select count(*) from site where code = 'ATOMIC-1'").query(Long.class).single()).as("no site left behind").isZero();
        assertThat(login("rq").post("/sites/with-boundary", Map.of("site", site, "boundary", boundary)).status()).as("the same right as creating a site").isEqualTo(403);

        double far = lng + 0.2;
        Map<String, Object> free = Map.of("type", "Polygon", "coordinates", List.of(List.of(List.of(far - 0.001, lat - 0.001), List.of(far + 0.001, lat - 0.001), List.of(far + 0.001, lat + 0.001), List.of(far - 0.001, lat + 0.001), List.of(far - 0.001, lat - 0.001))));
        site.put("location", Map.of("lat", lat, "lng", far));
        Res saved = admin.post("/sites/with-boundary", Map.of("site", site, "boundary", Map.of("geometry", free, "crs", "EPSG:4326", "expectedVersion", 0, "reason", "حدود للاختبار", "method", "DRAWN")));
        assertThat(saved.status()).as(saved.toString()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from site_geometry_version g join site s on s.id = g.site_id where s.code = 'ATOMIC-1'").query(Long.class).single()).isEqualTo(1L);
    }

    private Map<String, Object> level(int level, boolean approves, String label, boolean last) {
        return Map.of("level", level, "approves", approves, "label", label, "finalStage", last, "dependsOn", List.of("SCOPE", "SITE", "DEPLOYMENT"));
    }

    @Test
    @DisplayName("The path of one request type: draft does nothing; activated it decides that type alone; a sent request stays on its version; only an administrator")
    void aPathForEachType() {
        Map<String, Object> onlyDept = Map.of("routing", Map.of("startAt", "SELF", "levels", List.of(level(8, false, "القسم", false), level(7, true, "اعتماد الإدارة", true))),
                "stages", Map.of("unitOperations", false, "finalByPermission", false, "fyiBeforeActivation", false));
        Api admin = login("sysadmin");
        assertThat(login("rq").put("/stationing/routes/SITE_REGISTRATION/draft", onlyDept).status()).as("an administrator's").isEqualTo(403);
        assertThat(admin.put("/stationing/routes/NOT_A_TYPE/draft", onlyDept).status()).isEqualTo(400);
        assertThat(admin.put("/stationing/routes/INITIAL_STATIONING/draft", onlyDept).status()).as("no longer a request type (ADR-078)").isEqualTo(400);
        assertThat(admin.put("/stationing/routes/DEPLOYMENT_AREAS/draft", Map.of("routing", Map.of("startAt", "SELF", "levels", List.of(level(8, true, "القسم", false))), "stages", Map.of("unitOperations", false, "finalByPermission", false, "fyiBeforeActivation", false))).status())
                .as("a path needs a last level").isEqualTo(400);
        assertThat(admin.post("/stationing/routes/DEPLOYMENT_AREAS/publish", Map.of("reason", "لا مسودة له")).status()).as("nothing saved").isEqualTo(400);
        assertThat(admin.put("/stationing/routes/DEPLOYMENT_AREAS/draft", onlyDept).status()).isEqualTo(200);

        // a draft decides nothing
        stationed(fresh, shared);
        stationed(fresh2, shared);
        String sentBefore = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        Res s1 = login("rq").post("/restationing-requests/" + sentBefore + "/submit", Map.of());
        assertThat(keys(s1.body().path("route"))).as("the policy's route").contains("O:operations", "F:final");

        // it tries, writes nothing, and says who holds what
        JsonNode tried = admin.post("/stationing/routes/DEPLOYMENT_AREAS/simulate", new java.util.LinkedHashMap<>(Map.of("routing", onlyDept.get("routing"), "stages", onlyDept.get("stages"), "orgId", sec.toString()))).body();
        assertThat(tried.path("complete").asBoolean()).isTrue();
        assertThat(tried.path("stages")).hasSize(1);
        assertThat(tried.path("stages").get(0).path("unit").asText()).isEqualTo("وحدة DEPT");
        assertThat(tried.path("stages").get(0).path("holders").asLong()).isPositive();

        assertThat(admin.post("/stationing/routes/DEPLOYMENT_AREAS/publish", Map.of("reason", "x")).status()).as("a reason").isEqualTo(400);
        assertThat(admin.post("/stationing/routes/DEPLOYMENT_AREAS/publish", Map.of("reason", "مسار للاختبار")).status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'STATIONING_ROUTE_PUBLISHED' and entity_id = 'DEPLOYMENT_AREAS'").query(Long.class).single()).isPositive();

        // activated: this type follows it, another type does not, and the request already sent keeps its route
        String after = request("DEPLOYMENT_AREAS", deployment(fresh2, 0.01), sec);
        Res s2 = login("rq").post("/restationing-requests/" + after + "/submit", Map.of());
        assertThat(s2.status()).as(s2.toString()).isEqualTo(200);
        assertThat(keys(s2.body().path("route"))).containsExactly("H:" + dept);
        assertThat(s2.body().path("route").get(0).path("final").asBoolean()).isTrue();
        assertThat(keys(login("rq").get("/restationing-requests/" + sentBefore).body().path("route"))).contains("O:operations", "F:final");
        String other = create("rq", permanent(List.of(team)));
        assertThat(keys(login("rq").post("/restationing-requests/" + other + "/submit", Map.of()).body().path("route"))).as("another type").contains("O:operations", "F:final");

        // a later version leaves a sent request on the one it started with, even when it is returned and sent again
        Map<String, Object> onlyTop = Map.of("routing", Map.of("startAt", "SELF", "levels", List.of(level(8, false, "القسم", false), level(7, false, "الإدارة", false), level(6, true, "اعتماد الأعلى", true))),
                "stages", Map.of("unitOperations", false, "finalByPermission", false, "fyiBeforeActivation", false));
        assertThat(admin.put("/stationing/routes/DEPLOYMENT_AREAS/draft", onlyTop).status()).isEqualTo(200);
        assertThat(admin.post("/stationing/routes/DEPLOYMENT_AREAS/publish", Map.of("reason", "مسار ثان للاختبار")).status()).isEqualTo(200);
        assertThat(login("apDept").post("/restationing-requests/" + after + "/decision", Map.of("decision", "RETURN", "reason", "عدّل السبب")).status()).isEqualTo(200);
        Res again = login("rq").post("/restationing-requests/" + after + "/submit", Map.of("reason", "عدلت الطلب"));
        assertThat(again.status()).as(again.toString()).isEqualTo(200);
        assertThat(keys(again.body().path("route"))).as("the version it was sent on").containsExactly("H:" + dept);
        assertThat(decide("apDept", after, "APPROVE").body().path("state").asText()).as("its last level is final and activates (ADR-095)").isEqualTo("ACTIVATED_PERMANENT");
        JsonNode listed = admin.get("/stationing/routes").body();
        assertThat(listed.path("routes")).as("the three types that can be asked for").hasSize(3);
        assertThat(listed.path("routes").toString()).doesNotContain("INITIAL_STATIONING");
        assertThat(listed.path("policyInForce").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("Unit operations and final approval: the nearest scope covering the requesting unit decides; a wider holder has no turn (owner, 16 Nov 2026)")
    void nearestScopeDecides() {
        stationed(fresh, shared);
        person("opsNear", role("NXOPSN", "ORGANIZATION", "VIEW", "DECIDE_UNIT_OPERATIONS"), sec);
        person("finNear", role("NXFINN", "ORGANIZATION", "VIEW", "FINAL_APPROVE_STATIONING"), dept);
        String id = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        Res s = login("rq").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(s.status()).as(s.toString()).isEqualTo(200);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        decide("apTop", id, "APPROVE");
        assertThat(login("ops").get("/restationing-requests/" + id).body().path("can").path("decide").asBoolean()).as("the holder over the top unit waits for nobody").isFalse();
        assertThat(decide("ops", id, "APPROVE").status()).as("a wider scope is not the decider").isEqualTo(403);
        assertThat(login("opsNear").get("/restationing-requests/" + id).body().path("can").path("decide").asBoolean()).isTrue();
        assertThat(decide("opsNear", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("fin", id, "APPROVE").status()).as("the final holder over the top unit").isEqualTo(403);
        Res fin = decide("finNear", id, "APPROVE");
        assertThat(fin.body().path("state").asText()).as("the nearest final holder; its approval activates (ADR-095)").isEqualTo("ACTIVATED_PERMANENT");
        assertThat(fin.body().path("finalApprover").path("id").asText()).isEqualTo(personId("finNear").toString());
    }

    @Test
    @DisplayName("SEAT-01…04: «اعتماد عمليات الوحدة» belongs to the unit: the holder's grant ends, the same step waits for the next holder, who decides it; the history keeps the human who decided")
    void seatSurvivesHolderChange() {
        stationed(fresh, shared);
        String seat = role("NXSEAT", "ORGANIZATION", "VIEW", "DECIDE_UNIT_OPERATIONS");
        UUID holderA = person("seatA", seat, sec);
        person("seatAdmin", "SYSTEM_ADMIN", top);
        String id = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        assertThat(login("rq").post("/restationing-requests/" + id + "/submit", Map.of()).status()).isEqualTo(200);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        decide("apTop", id, "APPROVE");
        String stage = jdbc.sql("select id::text from restationing_stage where request_id = cast(:r as uuid) and permission = 'DECIDE_UNIT_OPERATIONS'")
                .param("r", id).query(String.class).single();
        // SEAT-01: the current holder (nearest the requesting unit) has the step
        assertThat(login("seatA").get("/restationing-requests/" + id).body().path("can").path("decide").asBoolean()).isTrue();

        // the holder leaves: the grant ends; the responsibility stays with the unit
        String grantA = jdbc.sql("select id::text from membership where person_id = :p").param("p", holderA).query(String.class).single();
        Res ended = login("seatAdmin").post("/memberships/" + grantA + "/end", Map.of("reason", "انتقل من الوحدة"));
        assertThat(ended.status()).as(ended.toString()).isEqualTo(200);
        // SEAT-02: the old holder loses the pending step
        assertThat(login("seatA").get("/restationing-requests/" + id).body().path("can").path("decide").asBoolean()).as("A no longer holds it").isFalse();
        assertThat(decide("seatA", id, "APPROVE").status()).isIn(403, 404);

        // SEAT-03: the next holder of the same responsibility sees the SAME step — no new request, no new stage
        person("seatB", seat, sec);
        assertThat(login("seatB").get("/restationing-requests/" + id).body().path("can").path("decide").asBoolean()).isTrue();
        assertThat(jdbc.sql("select count(*) from restationing_stage where request_id = cast(:r as uuid) and permission = 'DECIDE_UNIT_OPERATIONS'")
                .param("r", id).query(Long.class).single()).as("the same stage").isEqualTo(1);
        assertThat(decide("seatB", id, "APPROVE").status()).isEqualTo(200);
        // SEAT-04: the decision records the human who actually decided; the earlier stages keep theirs
        assertThat(jdbc.sql("select p.display_name from restationing_stage s join person p on p.id = s.decided_by where s.id = cast(:s as uuid)")
                .param("s", stage).query(String.class).single()).isEqualTo("شخص seatB");
        assertThat(jdbc.sql("select count(*) from restationing_stage where request_id = cast(:r as uuid) and mark = 'APPROVED' and decided_by is not null")
                .param("r", id).query(Long.class).single()).as("history intact").isEqualTo(4);
        assertThat(decide("fin", id, "APPROVE").body().path("state").asText()).as("the workflow continues to activation (ADR-095)").isEqualTo("ACTIVATED_PERMANENT");
    }

    @Test
    @DisplayName("OWN-01: the request belongs to the requesting unit: another requester of the unit edits and sends it; no requester decides it")
    void requestBelongsToTheUnit() {
        stationed(fresh, shared);
        String id = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        person("rq2", role("NXREQ2", "ORGANIZATION", "VIEW", "CREATE_RESTATIONING", "APPROVE_HIERARCHY"), sec);
        Api rq2 = login("rq2");
        assertThat(rq2.get("/restationing-requests/" + id).body().path("can").path("submit").asBoolean()).as("another requester of the unit").isTrue();
        Res edited = rq2.put("/restationing-requests/" + id + "/content", deployment(fresh, 0));
        assertThat(edited.status()).as(edited.toString()).isEqualTo(200);
        Res sent = rq2.post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(sent.status()).as(sent.toString()).isEqualTo(200);
        assertThat(login("rq").get("/restationing-requests/" + id).body().path("requester").path("name").asText()).as("who started it stays recorded").isEqualTo("شخص rq");
        Res own = decide("rq2", id, "APPROVE");
        assertThat(own.status()).as("whoever sent it never decides it").isEqualTo(403);
        assertThat(own.body().path("code").asText()).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(decide("apSec", id, "APPROVE").status()).isEqualTo(200);
    }

    @Test
    @DisplayName("ADR-073/078: «مدير النظام» submits «طلب إعادة تمركز» (and so a deployment-area request) for any unit; the request is that unit's, goes through the approvals and is never decided by the administrator; initial stationing is site setup, site registration stays with its role")
    void systemAdministratorRequestsRestationing() {
        UUID adminId = person("platformAdmin", "SYSTEM_ADMIN", top);
        Api admin = login("platformAdmin");
        String perms = admin.get("/me").body().path("permissions").toString();
        assertThat(perms).as("one request right, no reading or deciding; re-sending failed events")
                .contains("CREATE_RESTATIONING", "CONFIGURE", "MANAGE_ACCESS", "REPLAY_STATIONING_EVENTS")
                .doesNotContain("\"VIEW\"", "APPROVE", "REQUEST_SITE_REGISTRATION");
        Res units = admin.get("/restationing-requests/units");
        assertThat(units.status()).as(units.toString()).isEqualTo(200);
        assertThat(units.body().toString()).as("every unit, in every branch").contains(sec.toString(), team.toString(), otherSec.toString());
        JsonNode restationCard = null;
        for (JsonNode c : admin.get("/request-hub").body().path("actions")) {
            if ("RESTATIONING".equals(c.path("action").asText())) {
                restationCard = c;
            }
        }
        assertThat(restationCard).as("«طلب إعادة تمركز» card in «طلب جديد»").isNotNull();
        assertThat(restationCard.path("allowed").asBoolean()).as("a stationed unit is in reach, even beyond the listed units: " + restationCard).isTrue();

        Res made = admin.post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "content", permanent(List.of(sec))));
        assertThat(made.status()).as(made.toString()).isEqualTo(200);
        String id = made.body().path("id").asText();
        assertThat(made.body().path("can").path("submit").asBoolean()).isTrue();
        Map<String, Object> row = jdbc.sql("select requesting_unit_id, requester_id from restationing_request where id = :id")
                .param("id", UUID.fromString(id)).query().singleRow();
        assertThat(row.get("requesting_unit_id")).as("the request belongs to the unit it is made for").isEqualTo(sec);
        assertThat(row.get("requester_id")).as("the administrator is its submitter").isEqualTo(adminId);

        Res sent = admin.post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(sent.status()).as(sent.toString()).isEqualTo(200);
        Res own = decide("platformAdmin", id, "APPROVE");
        assertThat(own.status()).as("the administrator never decides it: " + own).isEqualTo(403);
        assertThat(login("req").get("/restationing-requests/" + id).status()).as("the unit's own requester follows it").isEqualTo(200);
        assertThat(decide("apSec", id, "APPROVE").status()).as("the hierarchy decides it as anyone's").isEqualTo(200);

        Res initialByAdmin = admin.post("/restationing-requests", Map.of("requestingUnitId", fresh.toString(), "purpose", "INITIAL_STATIONING",
                "content", initial(List.of(fresh))));
        assertThat(initialByAdmin.status()).as("initial stationing is site setup, never a request: " + initialByAdmin).isEqualTo(400);
        Res areasByAdmin = admin.post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "DEPLOYMENT_AREAS",
                "content", deployment(sec, 0)));
        assertThat(areasByAdmin.status()).as("one right with re-stationing (ADR-078): " + areasByAdmin).isEqualTo(200);
        Res siteByAdmin = admin.post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "SITE_REGISTRATION",
                "content", Map.of("kind", "PERMANENT", "scope", List.of(sec.toString()), "reason", "تسجيل موقع")));
        assertThat(siteByAdmin.status()).as("site registration stays with its own role: " + siteByAdmin).isEqualTo(403);
    }

    @Test
    @DisplayName("FYI: a recipient reads the one request; nothing else, nobody else in the branch; no mutation; it ends as designed; audited; a person with no permission at all is refused")
    void fyiReadsOneRequestOnly() {
        stationed(fresh, shared);
        String id = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        Res s = login("rq").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(s.status()).as(s.toString()).isEqualTo(200);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        decide("apTop", id, "APPROVE");
        decide("ops", id, "APPROVE");

        // the recipients hold some unrelated permission: a person with none reaches only «طلب صلاحية» and support (owner, 16 Nov 2026)
        UUID reader = holding("fyiReader", otherSec);
        UUID parentMember = holding("fyiParent", other);
        UUID siblingMember = holding("fyiSibling", dept);
        affiliated("fyiBare", otherSec);
        // ADR-095: the unit is configured for information once (B2); the final approval distributes to it while it activates
        designateFyi(otherSec);
        assertThat(decide("fin", id, "APPROVE").body().path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");
        String unrelated = request("DEPLOYMENT_AREAS", deployment(fresh2, 0.01), sec);
        assertThat(jdbc.sql("select count(*) from restationing_fyi where request_id = cast(:id as uuid) and organization_id = :o and ended_at is null")
                .param("id", id).param("o", otherSec).query(Long.class).single()).as("the configured unit, recorded for this request").isEqualTo(1);
        Api readerApi = login("fyiReader");
        Res bare = login("fyiBare").get("/restationing-requests/" + id);
        assertThat(bare.status()).as("no permission at all: not even a request sent «للعلم»").isEqualTo(403);
        assertThat(bare.body().path("code").asText()).isEqualTo("NO_EFFECTIVE_ACCESS");
        assertThat(login("fyiBare").get("/access-requests/mine").status()).as("the access-request page stays open").isEqualTo(200);
        assertThat(login("fyiBare").get("/support/cases").status()).as("and support").isEqualTo(200);
        assertThat(login("fyiBare").post("/assistant/ask", Map.of("question", "ما صلاحياتي؟")).status()).as("the assistant is closed").isEqualTo(403);

        // 1. the one request opens, read only; 2. another does not
        Res opened = readerApi.get("/restationing-requests/" + id);
        assertThat(opened.status()).as(opened.toString()).isEqualTo(200);
        assertThat(opened.body().path("readOnlyFyi").asBoolean()).isTrue();
        assertThat(readerApi.get("/restationing-requests/" + unrelated).status()).isEqualTo(404);
        assertThat(readerApi.get("/restationing-requests").body()).as("its list holds this one").hasSize(1);
        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and title like 'للعلم:%' and body like :b").param("p", reader).param("b", "#restationing/" + id + "%").query(Long.class).single()).isEqualTo(1);

        // 3. no action is offered
        JsonNode can = opened.body().path("can");
        for (String action : List.of("edit", "submit", "decide", "activate", "fyi")) {
            assertThat(can.path(action).asBoolean()).as(action).isFalse();
        }
        // 4. forged mutations are refused; the retained /activate is a no-op (ADR-095) and the per-request FYI endpoints are gone
        long auditBefore = jdbc.sql("select count(*) from audit_event where entity_id = :id").param("id", id).query(Long.class).single();
        assertThat(readerApi.post("/restationing-requests/" + id + "/decision", Map.of("decision", "APPROVE")).status()).isIn(400, 403);
        Res noOp = readerApi.post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(noOp.status()).as(noOp.toString()).isEqualTo(200);
        assertThat(noOp.body().path("readOnlyFyi").asBoolean()).isTrue();
        assertThat(readerApi.post("/restationing-requests/" + id + "/fyi", Map.of("units", List.of())).status()).isIn(404, 405);
        assertThat(readerApi.put("/restationing-requests/" + id + "/content", deployment(fresh, 0.02)).status()).isEqualTo(403);
        assertThat(readerApi.post("/restationing-requests/" + id + "/fyi/" + otherSec + "/end", Map.of("reason", "محاولة مصنوعة")).status()).isIn(404, 405);
        assertThat(readerApi.post("/restationing-requests", Map.of("requestingUnitId", otherSec.toString(), "purpose", "DEPLOYMENT_AREAS", "content", deployment(otherSec, 0))).status()).isEqualTo(403);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id").param("id", id).query(Long.class).single())
                .as("nothing the reader tried changed the request").isEqualTo(auditBefore);
        assertThat(login("req").get("/restationing-requests/" + id).body().path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");

        // no lasting right and no wider view
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", reader).query(Long.class).single()).as("only its own").isEqualTo(1);
        assertThat(readerApi.get("/me").body().path("permissions").toString()).isEqualTo("[\"VIEW_SUMMARY\"]");
        assertThat(readerApi.get("/sites/" + shared).status()).isIn(403, 404);
        assertThat(readerApi.get("/stationing/current").status() == 200 ? readerApi.get("/stationing/current").body().size() : 0).as("no register").isZero();
        assertThat(readerApi.get("/operational-posture").status()).isEqualTo(403);

        // 6. the unit chosen, and only it: its parent and another branch inherit nothing
        assertThat(login("fyiParent").get("/restationing-requests/" + id).status()).isEqualTo(404);
        assertThat(login("fyiSibling").get("/restationing-requests/" + id).status()).isEqualTo(404);
        assertThat(jdbc.sql("select count(*) from notification where person_id in (:a, :b)").param("a", parentMember).param("b", siblingMember).query(Long.class).single()).isZero();

        // audit: who, when, which request, which units and people
        String audited = jdbc.sql("select detail::text from audit_event where entity_id = :id and action = 'RESTATIONING_FYI_DISTRIBUTED'").param("id", id).query(String.class).single();
        assertThat(audited).contains(otherSec.toString()).contains(reader.toString());

        // 5. it ends as designed. ADR-095 removed the per-request «end» by a holder (the three FYI endpoints are gone, checked
        // above); the record stays and the access ends with the person's unit or the request, below
        assertThat(jdbc.sql("select count(*) from restationing_fyi where request_id = cast(:id as uuid) and ended_at is null").param("id", id).query(Long.class).single())
                .as("the record stays").isEqualTo(1);

        // leaving the unit in HR ends it; so does the request being cancelled before activation
        jdbc.sql("update affiliation set valid_to = now() where person_id = :p").param("p", reader).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (gen_random_uuid(), :p, :o, now())").param("p", reader).param("o", dept).update();
        assertThat(login("fyiReader").get("/restationing-requests/" + id).status()).as("moved in HR").isEqualTo(404);
        UUID second = holding("fyiSecond", otherSec);
        assertThat(login("fyiSecond").get("/restationing-requests/" + id).status()).as("whoever belongs to the unit now").isEqualTo(200);
        assertThat(second).isNotNull();
        jdbc.sql("update restationing_request set state = 'CANCELLED_BEFORE_ACTIVATION' where id = cast(:id as uuid)").param("id", id).update();
        assertThat(login("fyiSecond").get("/restationing-requests/" + id).status()).as("cancelled before activation").isEqualTo(404);
    }

    @Test
    @DisplayName("Deployment areas belong to a unit: two units on one site keep their own; a duplicate is refused; a posture viewer reads its branch and changes nothing")
    void deploymentAndPosture() {
        stationed(fresh, shared);
        stationed(fresh2, shared);
        assertThat(hubUnit("rq", fresh).path("state").asText()).isEqualTo("DEPLOYMENT_MISSING");
        String first = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        assertThat(hubUnit("rq", fresh).path("state").asText()).isEqualTo("DEPLOYMENT_REQUEST_PENDING");
        assertThat(login("rq").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "DEPLOYMENT_AREAS", "content", deployment(fresh, 0.1))).status())
                .as("one open request").isEqualTo(400);
        wholeRoute(first);
        assertThat(hubUnit("rq", fresh).path("state").asText()).isEqualTo("DEPLOYMENT_COMPLETE");
        assertThat(allowed(hubUnit("rq", fresh), "DEPLOYMENT_AREAS")).isFalse();
        String firstPrimary = areaOf(fresh, "PRIMARY");

        String second = request("DEPLOYMENT_AREAS", deployment(fresh2, 0.01), sec);
        wholeRoute(second);
        assertThat(areaOf(fresh, "PRIMARY")).as("another unit's approval does not touch these").isEqualTo(firstPrimary);
        assertThat(areaOf(fresh2, "PRIMARY")).isNotEqualTo(firstPrimary);
        assertThat(jdbc.sql("select count(*) from org_stationing where organization_id = :o and valid_to is null").param("o", fresh).query(Long.class).single())
                .as("a deployment request changes no stationing").isEqualTo(1);
        assertThat(login("rq").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "DEPLOYMENT_AREAS", "content", deployment(fresh, 0.02))).status())
                .as("a complete unit may hold a draft, never send it").isEqualTo(200);
        String extra = jdbc.sql("select id::text from restationing_request where purpose = 'DEPLOYMENT_AREAS' and state = 'DRAFT' and jsonb_exists(content->'scope', :u)").param("u", fresh.toString()).query(String.class).single();
        assertThat(login("rq").post("/restationing-requests/" + extra + "/submit", Map.of()).status()).isEqualTo(400);

        // the default /operational-posture is now the compact Site-Hub summary (ADR-094 Gate 2 §C, 7df000b); the per-unit
        // records these POSTURE checks read are the ?view=UNITS shape (docs/PERFORMANCE_HARDENING.md §3, item 3)
        JsonNode posture = login("viewer").get("/operational-posture?view=UNITS").body();
        Map<String, JsonNode> seen = new LinkedHashMap<>();
        posture.path("units").forEach(n -> seen.put(n.path("id").asText(), n));
        assertThat(seen).containsKeys(fresh.toString(), fresh2.toString(), sec.toString());
        assertThat(seen).doesNotContainKeys(otherSec.toString(), other.toString(), top.toString());
        JsonNode one = seen.get(fresh.toString());
        assertThat(one.path("site").path("id").asText()).isEqualTo(shared.toString());
        assertThat(one.path("kind").asText()).isEqualTo("PERMANENT");
        assertThat(one.path("primary").path("type").asText()).isEqualTo("Polygon");
        assertThat(one.path("alternative").path("type").asText()).isEqualTo("Polygon");
        assertThat(one.path("otherUnitsAtSite").asLong()).as("nothing shares this site from outside the branch yet").isZero();

        // a unit of another branch at the same site: the viewer learns it is there, never which
        stationed(otherSec, sOther, true);
        stationed(other, shared);
        JsonNode again = login("viewer").get("/operational-posture?view=UNITS").body();
        assertThat(again.toString()).doesNotContain("وحدة OTHER");
        again.path("units").forEach(n -> {
            if (fresh.toString().equals(n.path("id").asText())) {
                assertThat(n.path("otherUnitsAtSite").asLong()).isEqualTo(1);
            }
        });
        JsonNode outside = login("outsider").get("/operational-posture?view=UNITS").body();
        assertThat(outside.toString()).doesNotContain(fresh.toString()).doesNotContain(firstPrimary);

        // read only, on the server
        Api viewer = login("viewer");
        assertThat(viewer.post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "RESTATIONING", "content", permanent(List.of(sec)))).status()).isEqualTo(403);
        assertThat(viewer.post("/restationing-requests/" + first + "/decision", Map.of("decision", "APPROVE")).status()).isIn(403, 404);
        assertThat(viewer.post("/restationing-requests/" + first + "/activate", Map.of()).status()).isIn(403, 404);
        assertThat(viewer.post("/site-links", Map.of("siteId", shared.toString(), "organizationId", sec.toString(), "reason", "محاولة ربط")).status()).isEqualTo(403);
        assertThat(viewer.get("/restationing-requests").body()).as("no request is open to it").isEmpty();
        assertThat(login("stranger").get("/operational-posture").status()).as("the right is its own").isEqualTo(403);

        // a permanent move retires the unit's areas with the stationing they belonged to
        Map<String, Object> move = permanent(List.of(fresh));
        String moved = create("rq", move);
        wholeRoute(moved);
        assertThat(jdbc.sql("select count(*) from deployment_area where organization_id = :o and state = 'ACTIVE' and request_id = :r").param("o", fresh).param("r", UUID.fromString(first)).query(Long.class).single()).isZero();
        assertThat(areaOf(fresh2, "PRIMARY")).as("the unit that stayed keeps its own").isNotNull();
    }

    @Test
    @DisplayName("POSTURE-PENDING: the operational-posture pending array returns only requests the operator may see; identity never leaks for proposals of another branch; excluded states (DRAFT/REJECTED) are omitted; VIEW_OPERATIONAL_POSTURE alone does not reveal every proposal")
    void operationalPosturePending() {
        // One request this viewer MAY read (it belongs to this branch): submit it so it reaches UNDER_REVIEW.
        stationed(fresh, shared);
        Map<String, Object> visibleContent = deployment(fresh, 0);
        String visible = request("DEPLOYMENT_AREAS", visibleContent, sec);
        assertThat(login("rq").post("/restationing-requests/" + visible + "/submit", Map.of()).status()).isEqualTo(200);

        // One DRAFT: the brief excludes DRAFT from the pending set (never shown).
        String draft = request("DEPLOYMENT_AREAS", deployment(fresh2, 0.01), sec);
        assertThat(jdbc.sql("select state from restationing_request where id = :id").param("id", UUID.fromString(draft))
                .query(String.class).single()).isEqualTo("DRAFT");

        // One request this viewer MAY NOT read — of another branch — also submitted so it reaches UNDER_REVIEW.
        stationed(otherSec, sOther, true);
        person("otherReq", role("NXOREQ", "ORGANIZATION", "VIEW", "CREATE_RESTATIONING", "APPROVE_HIERARCHY"), otherSec);
        Res made = login("otherReq").post("/restationing-requests", Map.of("requestingUnitId", otherSec.toString(), "purpose", "DEPLOYMENT_AREAS",
                "content", deployment(otherSec, 0)));
        assertThat(made.status()).as("other-branch requester starts their own: " + made).isEqualTo(200);
        String outOfScope = made.body().path("id").asText();
        assertThat(login("otherReq").post("/restationing-requests/" + outOfScope + "/submit", Map.of()).status()).isEqualTo(200);

        String visibleNumber = jdbc.sql("select number from restationing_request where id = :id").param("id", UUID.fromString(visible)).query(String.class).single();
        String outOfScopeNumber = jdbc.sql("select number from restationing_request where id = :id").param("id", UUID.fromString(outOfScope)).query(String.class).single();
        String draftNumber = jdbc.sql("select number from restationing_request where id = :id").param("id", UUID.fromString(draft)).query(String.class).single();

        // 1. VIEW_OPERATIONAL_POSTURE ALONE does NOT grant visibility into proposals (brief §13). The pending[] array lives in
        //    the per-unit ?view=UNITS shape; the default is the Site-Hub summary with counts only (ADR-094 Gate 2 §C).
        person("postureOnly", role("NXPOST3", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), sec);
        JsonNode postureOnly = login("postureOnly").get("/operational-posture?view=UNITS").body();
        assertThat(postureOnly.has("pending")).as("the payload carries the pending array").isTrue();
        List<String> postureOnlyNumbers = new ArrayList<>();
        postureOnly.path("pending").forEach(p -> postureOnlyNumbers.add(p.path("requestNumber").asText()));
        assertThat(postureOnlyNumbers).as("VIEW_OPERATIONAL_POSTURE alone is not a free pass into proposals")
                .doesNotContain(visibleNumber).doesNotContain(outOfScopeNumber);
        assertThat(postureOnly.toString()).as("no out-of-scope unit identity leaks through the pending array").doesNotContain(outOfScopeNumber);

        // 2. A real operator (VIEW + VIEW_OPERATIONAL_POSTURE on the branch) SEES their branch's proposal and the
        //    projection carries only operational-map fields (brief §12). The other-branch proposal remains hidden.
        person("postureOps", role("NXPOST5", "ORGANIZATION", "VIEW", "VIEW_OPERATIONAL_POSTURE"), sec);
        JsonNode postureOps = login("postureOps").get("/operational-posture?view=UNITS").body();
        JsonNode pending = postureOps.path("pending");
        List<String> numbers = new ArrayList<>();
        pending.forEach(p -> numbers.add(p.path("requestNumber").asText()));
        assertThat(numbers).as("this branch's proposal is included for an operator who already has VIEW").contains(visibleNumber);
        assertThat(numbers).as("another branch's proposal is NOT included — identity never leaks").doesNotContain(outOfScopeNumber);
        assertThat(numbers).as("DRAFT is excluded").doesNotContain(draftNumber);
        assertThat(postureOps.toString()).as("no out-of-scope unit identity leaks through the pending array").doesNotContain(outOfScopeNumber);
        JsonNode row = pending.get(0);
        for (String f : List.of("requestId", "requestNumber", "purpose", "state", "currentStage", "unitId", "unitCode", "unitName", "currentSiteId", "proposedSite", "proposedPrimary", "proposedSub")) {
            assertThat(row.has(f)).as("pending row has field " + f).isTrue();
        }

        // 3. The other branch's operator DOES see their own proposal (visible(ctx,r) is theirs).
        person("other-posture", role("NXPOST4", "ORGANIZATION", "VIEW", "VIEW_OPERATIONAL_POSTURE"), otherSec);
        JsonNode otherPosture = login("other-posture").get("/operational-posture?view=UNITS").body();
        List<String> otherNumbers = new ArrayList<>();
        otherPosture.path("pending").forEach(p -> otherNumbers.add(p.path("requestNumber").asText()));
        assertThat(otherNumbers).as("the other branch's operator sees their own proposal").contains(outOfScopeNumber);
        assertThat(otherNumbers).as("the other branch's operator does not see this branch's proposal").doesNotContain(visibleNumber);
    }

    @Test
    @DisplayName("Site registration: nothing is registered before activation; an overlap is reported and blocked; one site, one link, no stationing; a parent is allowed to contain it")
    void siteRegistration() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("kind", "PERMANENT");
        c.put("scope", List.of(sec.toString()));
        c.put("reason", "تسجيل موقع للاختبار");
        c.put("site", Map.of("geometry", square(lat0 + 0.05, lng0, 0.0002), "shape", "DRAWN"));
        c.put("siteInfo", Map.of("name", "موقع فرعي للاختبار", "code", "SR-" + sfx, "kind", "موقع فرعي"));
        String overlap = request("SITE_REGISTRATION", c, sec);
        assertThat(login("rq").get("/restationing-requests/" + overlap + "/checks").body().path("problems").toString()).contains("يتداخل مع موقع مسجل");
        assertThat(login("rq").post("/restationing-requests/" + overlap + "/submit", Map.of()).status()).isEqualTo(400);

        c.put("siteInfo", Map.of("name", "موقع فرعي للاختبار", "code", "SR-" + sfx, "kind", "موقع فرعي", "parentId", shared.toString()));
        assertThat(login("rq").put("/restationing-requests/" + overlap + "/content", c).status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from site where code = :c").param("c", "SR-" + sfx).query(Long.class).single()).as("nothing before activation").isZero();
        JsonNode done = wholeRoute(overlap);
        assertThat(done.path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");
        Map<String, Object> site = jdbc.sql("select id, parent_id, geometry_version from site where code = :c").param("c", "SR-" + sfx).query().singleRow();
        assertThat(site.get("parent_id")).isEqualTo(shared);
        assertThat(site.get("geometry_version")).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from org_stationing where site_id = :s").param("s", site.get("id")).query(Long.class).single()).as("a link is not stationing").isZero();
        assertThat(jdbc.sql("select count(*) from site_link where site_id = :s and organization_id = :o").param("s", site.get("id")).param("o", sec).query(Long.class).single()).isEqualTo(1);

        // a point registers its marker; the same place again is refused
        Map<String, Object> point = new LinkedHashMap<>(c);
        point.put("site", Map.of("geometry", Map.of("type", "Point", "coordinates", List.of(lng0 + 0.4, lat0 + 0.05)), "shape", "DRAWN"));
        point.put("siteInfo", Map.of("name", "نقطة للاختبار", "code", "SP-" + sfx, "kind", "نقطة"));
        wholeRoute(request("SITE_REGISTRATION", point, sec));
        Map<String, Object> marker = jdbc.sql("select geometry_version, lat from site where code = :c").param("c", "SP-" + sfx).query().singleRow();
        assertThat(marker.get("geometry_version")).isNull();
        assertThat(marker.get("lat")).isNotNull();
    }

    @Test
    @DisplayName("Shared site: occupants told apart from links; units a person may not read are counted, never named; one site, four branches, no hierarchy change")
    void sharedSite() {
        stationed(sec, shared, true);
        stationed(other, shared);
        UUID parent = jdbc.sql("select parent_id from organization where id = :o").param("o", other).query(UUID.class).single();
        jdbc.sql("insert into site_link(id, site_id, organization_id, valid_from, reason, created_by) values (gen_random_uuid(), :s, :o, now(), 'ربط للاختبار', :by)")
                .param("s", shared).param("o", dept).param("by", personId("sysadmin")).update();
        person("wide", role("NXWIDE", "ORGANIZATION", "VIEW"), top);
        JsonNode all = login("wide").get("/sites/" + shared + "/occupants").body();
        assertThat(all.path("stationed")).hasSize(2);
        assertThat(all.path("linked")).hasSize(1);
        assertThat(all.path("otherStationed").asLong()).isZero();
        JsonNode one = login("req").get("/sites/" + shared + "/occupants").body();
        assertThat(one.toString()).doesNotContain("وحدة OTHER");
        assertThat(one.path("otherStationed").asLong()).isEqualTo(1);
        assertThat(jdbc.sql("select parent_id from organization where id = :o").param("o", other).query(UUID.class).single()).isEqualTo(parent);
    }

    /** Affiliated in HR with the unit and holding one unrelated permission (a summary view of that unit only). */
    private UUID holding(String username, UUID unit) {
        UUID p = person(username, role("NXVS" + username, "ORGANIZATION", "VIEW_SUMMARY"), unit);
        if (jdbc.sql("select count(*) from affiliation where person_id = :p and valid_to is null").param("p", p).query(Long.class).single() == 0) {
            jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (gen_random_uuid(), :p, :o, now() - interval '1 day')")
                    .param("p", p).param("o", unit).update();
        }
        return p;
    }

    private UUID affiliated(String username, UUID unit) {
        String none = role("NXNONE" + username, "ORGANIZATION", "VIEW_SUMMARY");
        UUID p = person(username, none, unit);
        jdbc.sql("update membership set valid_to = now() where person_id = :p").param("p", p).update();
        jdbc.sql("delete from membership_scope_target where membership_id in (select id from membership where person_id = :p)").param("p", p).update();
        jdbc.sql("delete from membership where person_id = :p").param("p", p).update();
        if (jdbc.sql("select count(*) from affiliation where person_id = :p and valid_to is null").param("p", p).query(Long.class).single() == 0) {
            jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (gen_random_uuid(), :p, :o, now() - interval '1 day')")
                    .param("p", p).param("o", unit).update();
        }
        return p;
    }
}
