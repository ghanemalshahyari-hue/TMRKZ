package ae.mover.stationing;

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
 * The complete request phase (ADR-045), on real PostgreSQL + PostGIS with OpenFGA in the loop: initial stationing, deployment
 * areas that belong to a unit, site registration, the configured stages after the hierarchy, FYI distribution and the
 * read-only operational posture. Fictional data only; holders and policy values here are test values, not defaults.
 */
class StationingNextIT extends RestationingTestBase {

    UUID fresh, fresh2, shared;

    @BeforeEach
    void next() {
        UUID snapshot = publishedSnapshot();
        fresh = hrOrg("FRESH", sec, 10, snapshot);
        fresh2 = hrOrg("FRESH2", sec, 10, snapshot);
        shared = siteWithBoundary("SHARED", lat0 + 0.05, lng0, top);
        person("rq", role("NXREQ", "ORGANIZATION", "VIEW", "CREATE_RESTATIONING", "CREATE_INITIAL_STATIONING", "CREATE_DEPLOYMENT_REQUEST", "REQUEST_SITE_REGISTRATION"), sec);
        person("ops", role("NXOPS", "ORGANIZATION", "VIEW", "DECIDE_UNIT_OPERATIONS"), top);
        person("fin", role("NXFIN", "ORGANIZATION", "VIEW", "FINAL_APPROVE_STATIONING"), top);
        person("fyi", role("NXFYI", "ORGANIZATION", "VIEW", "MANAGE_FYI_DISTRIBUTION"), top);
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

    /** Hierarchy, unit operations, final approval, FYI, activation: each by its own holder. */
    private JsonNode wholeRoute(String id) {
        Res s = login("rq").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(s.status()).as(s.toString()).isEqualTo(200);
        assertThat(decide("apSec", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("apDept", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("apTop", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("ops", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("fin", id, "APPROVE").body().path("state").asText()).isEqualTo("APPROVED_NOT_ACTIVATED");
        assertThat(login("fyi").post("/restationing-requests/" + id + "/fyi", Map.of("units", List.of())).status()).isEqualTo(200);
        Res act = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(act.status()).as(act.toString()).isEqualTo(200);
        return act.body();
    }

    private String areaOf(UUID unit, String role) {
        return jdbc.sql("select ST_AsText(geom) from deployment_area where organization_id = :o and role = :r and state = 'ACTIVE'")
                .param("o", unit).param("r", role).query(String.class).single();
    }

    @Test
    @DisplayName("Initial stationing: offered only to a unit stationed nowhere; the whole configured route, each stage only to its holder; FYI opens one request and grants nothing")
    void initialStationing() {
        JsonNode u = hubUnit("rq", fresh);
        assertThat(u.path("state").asText()).isEqualTo("NO_STATIONING");
        assertThat(allowed(u, "INITIAL_STATIONING")).isTrue();
        assertThat(allowed(u, "RESTATIONING")).as("a unit stationed nowhere has nothing to re-station").isFalse();
        assertThat(allowed(u, "DEPLOYMENT_AREAS")).isFalse();
        assertThat(allowed(hubUnit("rq", sec), "INITIAL_STATIONING")).as("a stationed unit does not start again").isFalse();
        assertThat(login("stranger").get("/request-hub").body().path("units")).as("no right, no unit").isEmpty();

        // a forged re-stationing for a unit stationed nowhere is refused by the server's checks
        Map<String, Object> forged = permanent(List.of(fresh));
        Res rs = login("rq").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "content", forged));
        assertThat(login("rq").post("/restationing-requests/" + rs.body().path("id").asText() + "/submit", Map.of()).status()).isEqualTo(400);

        assertThat(login("apSec").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "INITIAL_STATIONING", "content", initial(List.of(fresh)))).status())
                .as("its own right").isEqualTo(403);
        String id = request("INITIAL_STATIONING", initial(List.of(fresh)), sec);
        assertThat(login("rq").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "purpose", "INITIAL_STATIONING", "content", initial(List.of(fresh)))).status())
                .as("one open request per unit").isEqualTo(400);
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
        assertThat(decide("ops", id, "APPROVE").status()).isEqualTo(200);
        assertThat(login("fin").get("/restationing-requests/" + id).body().path("can").path("decideAs").asText()).isEqualTo("اعتماد نهائي");
        assertThat(decide("ops", id, "APPROVE").status()).as("one human decides one stage").isIn(403, 409);
        assertThat(decide("fin", id, "APPROVE").body().path("state").asText()).isEqualTo("APPROVED_NOT_ACTIVATED");

        // FYI comes before activation here, because the policy version says so
        assertThat(login("activator").get("/restationing-requests/" + id).body().path("can").path("activate").asBoolean()).isFalse();
        assertThat(login("activator").post("/restationing-requests/" + id + "/activate", Map.of()).status()).isEqualTo(400);
        assertThat(login("activator").post("/restationing-requests/" + id + "/fyi", Map.of("units", List.of(other.toString()))).status()).as("needs its own right").isEqualTo(403);

        UUID reader = affiliated("reader", otherSec);
        Res sent = login("fyi").post("/restationing-requests/" + id + "/fyi", Map.of("units", List.of(otherSec.toString()), "note", "للاطلاع"));
        assertThat(sent.status()).as(sent.toString()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and title like 'للعلم:%'").param("p", reader).query(Long.class).single()).isEqualTo(1);
        Api readerApi = login("reader");
        assertThat(readerApi.get("/restationing-requests/" + id).status()).as("this one request").isEqualTo(200);
        assertThat(readerApi.get("/restationing-requests/" + rs.body().path("id").asText()).status()).as("not any other").isEqualTo(404);
        assertThat(readerApi.post("/restationing-requests/" + id + "/decision", Map.of("decision", "APPROVE")).status()).isIn(400, 403);
        assertThat(readerApi.post("/restationing-requests/" + id + "/activate", Map.of()).status()).isEqualTo(403);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", reader).query(Long.class).single()).as("no lasting right").isZero();

        UUID parentBefore = jdbc.sql("select parent_id from organization where id = :o").param("o", fresh).query(UUID.class).single();
        Res act = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(act.status()).as(act.toString()).isEqualTo(200);
        assertThat(act.body().path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");
        assertThat(jdbc.sql("select site_id from org_stationing where organization_id = :o and valid_to is null").param("o", fresh).query(UUID.class).single()).isEqualTo(shared);
        assertThat(jdbc.sql("select parent_id from organization where id = :o").param("o", fresh).query(UUID.class).single()).as("Oracle's hierarchy is untouched").isEqualTo(parentBefore);
        assertThat(jdbc.sql("select count(*) from org_stationing where organization_id = :o").param("o", fresh2).query(Long.class).single()).as("nobody else moves").isZero();
        assertThat(jdbc.sql("select count(*) from site where id = :s").param("s", shared).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'INITIAL_STATIONING_ACTIVATED'").param("id", id).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'RESTATIONING_FYI_DISTRIBUTED'").param("id", id).query(Long.class).single()).isEqualTo(1);

        JsonNode after = hubUnit("rq", fresh);
        assertThat(after.path("state").asText()).isEqualTo("DEPLOYMENT_MISSING");
        assertThat(allowed(after, "RESTATIONING")).isTrue();
        assertThat(allowed(after, "DEPLOYMENT_AREAS")).isTrue();
        assertThat(allowed(after, "INITIAL_STATIONING")).isFalse();
    }

    @Test
    @DisplayName("FYI: a person with no permission reads the one request; nothing else, nobody else in the branch; no mutation; it ends as designed; audited")
    void fyiReadsOneRequestOnly() {
        stationed(fresh, shared);
        String id = request("DEPLOYMENT_AREAS", deployment(fresh, 0), sec);
        Res s = login("rq").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(s.status()).as(s.toString()).isEqualTo(200);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        decide("apTop", id, "APPROVE");
        decide("ops", id, "APPROVE");
        assertThat(decide("fin", id, "APPROVE").body().path("state").asText()).isEqualTo("APPROVED_NOT_ACTIVATED");
        String unrelated = request("DEPLOYMENT_AREAS", deployment(fresh2, 0.01), sec);

        UUID reader = affiliated("fyiReader", otherSec);
        UUID parentMember = affiliated("fyiParent", other);
        UUID siblingMember = affiliated("fyiSibling", dept);
        Api fyi = login("fyi");
        Res sent = fyi.post("/restationing-requests/" + id + "/fyi", Map.of("units", List.of(otherSec.toString()), "note", "للاطلاع"));
        assertThat(sent.status()).as(sent.toString()).isEqualTo(200);
        Api readerApi = login("fyiReader");

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
        // 4. forged mutations are refused
        assertThat(readerApi.post("/restationing-requests/" + id + "/decision", Map.of("decision", "APPROVE")).status()).isIn(400, 403);
        assertThat(readerApi.post("/restationing-requests/" + id + "/activate", Map.of()).status()).isEqualTo(403);
        assertThat(readerApi.post("/restationing-requests/" + id + "/fyi", Map.of("units", List.of())).status()).isEqualTo(403);
        assertThat(readerApi.put("/restationing-requests/" + id + "/content", deployment(fresh, 0.02)).status()).isEqualTo(403);
        assertThat(readerApi.post("/restationing-requests/" + id + "/fyi/" + otherSec + "/end", Map.of("reason", "محاولة مصنوعة")).status()).isEqualTo(403);
        assertThat(readerApi.post("/restationing-requests", Map.of("requestingUnitId", otherSec.toString(), "purpose", "DEPLOYMENT_AREAS", "content", deployment(otherSec, 0))).status()).isEqualTo(403);

        // no lasting right and no wider view
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", reader).query(Long.class).single()).isZero();
        assertThat(readerApi.get("/me").body().path("permissions")).isEmpty();
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

        // 5. it ends as designed: by its holder with a reason, and a new choice opens it again
        assertThat(fyi.post("/restationing-requests/" + id + "/fyi/" + otherSec + "/end", Map.of("reason", "x")).status()).as("a reason").isEqualTo(400);
        assertThat(fyi.post("/restationing-requests/" + id + "/fyi/" + otherSec + "/end", Map.of("reason", "انتهت الحاجة للاطلاع")).status()).isEqualTo(200);
        assertThat(readerApi.get("/restationing-requests/" + id).status()).isEqualTo(404);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'RESTATIONING_FYI_ACCESS_ENDED'").param("id", id).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from restationing_fyi where request_id = cast(:id as uuid) and ended_at is not null").param("id", id).query(Long.class).single()).as("the record stays").isEqualTo(1);
        assertThat(fyi.post("/restationing-requests/" + id + "/fyi", Map.of("units", List.of(otherSec.toString()))).status()).isEqualTo(200);
        assertThat(readerApi.get("/restationing-requests/" + id).status()).isEqualTo(200);

        // leaving the unit in HR ends it; so does the request being cancelled before activation
        jdbc.sql("update affiliation set valid_to = now() where person_id = :p").param("p", reader).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (gen_random_uuid(), :p, :o, now())").param("p", reader).param("o", dept).update();
        assertThat(login("fyiReader").get("/restationing-requests/" + id).status()).as("moved in HR").isEqualTo(404);
        UUID second = affiliated("fyiSecond", otherSec);
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

        JsonNode posture = login("viewer").get("/operational-posture").body();
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
        JsonNode again = login("viewer").get("/operational-posture").body();
        assertThat(again.toString()).doesNotContain("وحدة OTHER");
        again.path("units").forEach(n -> {
            if (fresh.toString().equals(n.path("id").asText())) {
                assertThat(n.path("otherUnitsAtSite").asLong()).isEqualTo(1);
            }
        });
        JsonNode outside = login("outsider").get("/operational-posture").body();
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
