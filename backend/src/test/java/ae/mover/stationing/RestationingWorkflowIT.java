package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.IntegrationTest;

/**
 * The re-stationing request workflow of Model V3 (ADR-033, migration V19) on the disposable PostgreSQL + PostGIS with
 * OpenFGA in the loop, with fictional HR-shaped units (levels L6–L10 in the published snapshot) and the server API:
 * route from the requesting unit, seat-exact decisions with separation of duties by the human, return with selective
 * re-approval, hierarchy-change pause and rebuild, independent activation (site, stationing, deployment areas,
 * outbox, links untouched), the temporary lifecycle, the occupied-geography and deployment checks, and visibility.
 */
class RestationingWorkflowIT extends RestationingTestBase {

    // ---- permanent journey ---------------------------------------------------------------------------------

    @Test
    @DisplayName("Permanent: route from the requesting unit, seat decisions, separation of duties, independent activation")
    void permanentJourney() {
        UUID link = UUID.randomUUID();
        jdbc.sql("insert into site_link(id, site_id, organization_id, valid_from, reason, created_by) values (:id, :s, :o, now(), 'ربط قائم للاختبار', :by)")
                .param("id", link).param("s", sOther).param("o", sec).param("by", personId("sysadmin")).update();
        String id = create("req", permanent(List.of(sec, team)));
        Res checks = login("req").get("/restationing-requests/" + id + "/checks");
        assertThat(checks.body().path("ok").asBoolean()).as(checks.toString()).isTrue();
        Res s = login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(s.status()).as(s.toString()).isEqualTo(200);
        assertThat(keys(s.body().path("route"))).containsExactly("H:" + sec, "H:" + dept, "H:" + top);
        assertThat(s.body().path("policyVersion").asInt()).isPositive();

        assertThat(decide("req", id, "APPROVE").code()).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(decide("apDept", id, "APPROVE").status()).as("not the current stage's seat").isEqualTo(403);
        assertThat(decide("apSec", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("apSec", id, "APPROVE").code()).as("one human decides one stage").isEqualTo("SEPARATION_OF_DUTIES");
        UUID alias = secondRecordOf("apSec", seatRole(), dept);
        assertThat(alias).isNotNull();
        assertThat(decide("aliasApSec", id, "APPROVE").code()).as("the same human's second record").isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(decide("apDept", id, "APPROVE").status()).isEqualTo(200);
        Res fin = decide("apTop", id, "APPROVE");
        assertThat(fin.body().path("state").asText()).isEqualTo("APPROVED_NOT_ACTIVATED");
        assertThat(fin.body().path("finalApprover").path("id").asText()).isEqualTo(personId("apTop").toString());

        assertThat(login("apTop").post("/restationing-requests/" + id + "/activate", Map.of()).code()).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(login("req").post("/restationing-requests/" + id + "/activate", Map.of()).code()).isEqualTo("SEPARATION_OF_DUTIES");
        Res act = login("activator").post("/restationing-requests/" + id + "/activate", Map.of("reason", "جاهز للتفعيل"));
        assertThat(act.status()).as(act.toString()).isEqualTo(200);
        assertThat(act.body().path("state").asText()).isEqualTo("ACTIVATED_PERMANENT");
        UUID site = UUID.fromString(act.body().path("activation").path("site").path("id").asText());

        for (UUID unit : List.of(sec, team)) {
            List<Map<String, Object>> rows = jdbc.sql("""
                    select site_id, origin, request_id, end_reason, valid_to is null as open from org_stationing
                     where organization_id = :o order by valid_from""").param("o", unit).query().listOfRows();
            assertThat(rows).hasSize(2);
            assertThat(rows.get(0).get("end_reason")).isEqualTo("SUPERSEDED");
            assertThat(rows.get(1).get("site_id")).isEqualTo(site);
            assertThat(rows.get(1).get("origin")).isEqualTo("REQUEST");
            assertThat(rows.get(1).get("open")).isEqualTo(true);
            List<Map<String, Object>> events = jdbc.sql("select event_type, payload::text as p from stationing_outbox where organization_id = :o")
                    .param("o", unit).query().listOfRows();
            assertThat(events).extracting(e -> e.get("event_type")).containsExactly("STATIONING_ACTIVATED");
            assertThat(events.get(0).get("p").toString()).contains("policy-").contains("/rev-1").contains("restationing:RS-");
        }
        assertThat(jdbc.sql("select count(*) from site_geometry_version where site_id = :s and version = 1").param("s", site).query(Long.class).single())
                .isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from deployment_area where site_id = :s and state = 'ACTIVE'").param("s", site).query(Long.class).single())
                .isEqualTo(2);
        assertThat(jdbc.sql("select valid_to is null from site_link where id = :id").param("id", link).query(Boolean.class).single())
                .as("activation never touches site links (O-14)").isTrue();
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action like 'RESTATIONING_%'").param("id", id)
                .query(Long.class).single()).isGreaterThanOrEqualTo(6);
    }

    // ---- return for changes ---------------------------------------------------------------------------------

    @Test
    @DisplayName("Return: same request; only decisions resting on a changed fact are taken again (others carried)")
    void returnAndSelectiveReapproval() {
        Instant start = Instant.now().plus(Duration.ofDays(3));
        Map<String, Object> c = temporary(List.of(sec), start, start.plus(Duration.ofDays(20)));
        String id = create("req", c);
        assertThat(login("req").post("/restationing-requests/" + id + "/submit", Map.of()).status()).isEqualTo(200);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        Res ret = login("apTop").post("/restationing-requests/" + id + "/decision", Map.of("decision", "RETURN", "reason", "عدّل نهاية المدة"));
        assertThat(ret.body().path("state").asText()).isEqualTo("RETURNED_FOR_CHANGES");
        assertThat(ret.body().path("returned").path("reason").asText()).isEqualTo("عدّل نهاية المدة");

        Map<String, Object> changed = new LinkedHashMap<>(c);
        changed.put("end", start.plus(Duration.ofDays(15)).toString());
        assertThat(login("req").put("/restationing-requests/" + id + "/content", changed).status()).isEqualTo(200);
        assertThat(login("req").post("/restationing-requests/" + id + "/submit", Map.of()).status()).as("resubmission needs a reason").isEqualTo(400);
        Res re = login("req").post("/restationing-requests/" + id + "/submit", Map.of("reason", "قصّرت المدة كما طُلب"));
        assertThat(re.status()).as(re.toString()).isEqualTo(200);
        JsonNode route = re.body().path("route");
        // L8 rests on DURATION → taken again; L7 rests on SCOPE only → carried; the final stage was never decided
        assertThat(marks(route)).containsExactly("null", "CARRIED", "null");
        JsonNode rev = re.body().path("revisions").get(1);
        assertThat(texts(rev.path("changed"))).containsExactly("DURATION", "AVAILABILITY");
        assertThat(rev.path("invalidated")).hasSize(1);
        assertThat(texts(rev.path("carried"))).containsExactly("H:" + dept);
        decide("apSec", id, "APPROVE");
        Res done = decide("apTop", id, "APPROVE");
        assertThat(done.body().path("state").asText()).as("the carried stage is not decided again").isEqualTo("APPROVED_NOT_ACTIVATED");
    }

    // ---- hierarchy change -----------------------------------------------------------------------------------

    @Test
    @DisplayName("Hierarchy change: paused, decisions refused, confirmation rebuilds the route and restarts every stage")
    void hierarchyChangePausesAndRebuilds() {
        String id = create("req", permanent(List.of(sec)));
        login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        decide("apSec", id, "APPROVE");
        moveUnder(sec, other);
        Res refused = decide("apDept", id, "APPROVE");
        assertThat(refused.status()).isEqualTo(400);
        assertThat(refused.body().path("message").asText()).contains(HierarchyDrift.MESSAGE);
        Res view = login("req").get("/restationing-requests/" + id);
        assertThat(view.body().path("state").asText()).isEqualTo("PAUSED_HIERARCHY_CHANGED");
        assertThat(view.body().path("paused").path("reason").asText()).isEqualTo(HierarchyDrift.MESSAGE);
        assertThat(login("req").post("/restationing-requests/" + id + "/submit", Map.of()).status()).as("confirmation needs a reason").isEqualTo(400);
        Res rebuilt = login("req").post("/restationing-requests/" + id + "/submit", Map.of("reason", "أؤكد الطلب بالهيكل الجديد"));
        assertThat(rebuilt.status()).as(rebuilt.toString()).isEqualTo(200);
        assertThat(rebuilt.body().path("routeNo").asInt()).isEqualTo(2);
        assertThat(keys(rebuilt.body().path("route"))).containsExactly("H:" + sec, "H:" + other, "H:" + top);
        assertThat(marks(rebuilt.body().path("route"))).containsOnly("null");
        JsonNode previous = rebuilt.body().path("previousRoutes").get(0).path("stages");
        assertThat(previous.get(0).path("mark").asText()).as("the earlier route keeps its decisions").isEqualTo("APPROVED");
        assertThat(decide("apSec", id, "APPROVE").status()).as("every stage is decided again (O-10b)").isEqualTo(200);
        assertThat(decide("apOther", id, "APPROVE").status()).isEqualTo(200);
    }

    @Test
    @DisplayName("Activation on a drifted hierarchy is refused and the request paused (O-16)")
    void activationRefusedOnDrift() {
        String id = approvedPermanent(List.of(team));
        moveUnder(sec, other);
        Res act = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(act.status()).isEqualTo(400);
        assertThat(act.body().path("message").asText()).contains(HierarchyDrift.MESSAGE);
        assertThat(login("req").get("/restationing-requests/" + id).body().path("state").asText()).isEqualTo("PAUSED_HIERARCHY_CHANGED");
        assertThat(jdbc.sql("select count(*) from org_stationing where organization_id = :o and origin = 'REQUEST'").param("o", team)
                .query(Long.class).single()).isZero();
    }

    @Test
    @DisplayName("Activation re-checks the geography: ground occupied since approval refuses it")
    void activationRefusedWhenGroundTakenSinceApproval() {
        String id = approvedPermanent(List.of(sec, team));
        // after the approval another unit is stationed on a site lying under the proposed site
        UUID late = siteWithBoundary("LATE", lat0 - 0.01, lng0, other);
        stationed(otherSec, late, true);
        Res act = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(act.status()).isEqualTo(400);
        assertThat(act.body().path("message").asText()).contains("تغيّر إشغال الأرض");
    }

    // ---- temporary --------------------------------------------------------------------------------------------

    @Test
    @DisplayName("Temporary: scheduled on activation, starts at its start, returns automatically to the preserved base")
    void temporaryLifecycle() {
        Instant start = Instant.now().plus(Duration.ofHours(1));
        Instant end = start.plus(Duration.ofHours(2));
        String id = create("req", temporary(List.of(team), start, end));
        login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        decide("apTop", id, "APPROVE");
        Res act = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(act.body().path("state").asText()).as(act.toString()).isEqualTo("TEMPORARY_SCHEDULED");
        UUID base = jdbc.sql("select id from org_stationing where organization_id = :o and kind = 'PERMANENT' and valid_to is null")
                .param("o", team).query(UUID.class).single();
        assertThat(jdbc.sql("select base_id from org_stationing where organization_id = :o and kind = 'TEMPORARY'").param("o", team)
                .query(UUID.class).single()).isEqualTo(base);
        assertThat(service.runTemporaryLifecycle(start.plus(Duration.ofMinutes(5)))[0]).isGreaterThanOrEqualTo(1);
        assertThat(login("req").get("/restationing-requests/" + id).body().path("state").asText()).isEqualTo("ACTIVE_TEMPORARY");
        assertThat(service.runTemporaryLifecycle(end.plus(Duration.ofMinutes(5)))[1]).isGreaterThanOrEqualTo(1);
        assertThat(login("req").get("/restationing-requests/" + id).body().path("state").asText()).isEqualTo("TEMPORARY_RETURNED");
        Map<String, Object> temp = jdbc.sql("select end_reason, valid_to from org_stationing where organization_id = :o and kind = 'TEMPORARY'")
                .param("o", team).query().singleRow();
        assertThat(temp.get("end_reason")).isEqualTo("RETURNED");
        assertThat(jdbc.sql("select valid_to is null from org_stationing where id = :id").param("id", base).query(Boolean.class).single())
                .as("the permanent base is preserved").isTrue();
        assertThat(jdbc.sql("select event_type from stationing_outbox where organization_id = :o order by seq").param("o", team).query(String.class).list())
                .containsExactly("TEMPORARY_STATIONING_SCHEDULED", "TEMPORARY_STATIONING_STARTED", "TEMPORARY_STATIONING_ENDED");
        assertThat(jdbc.sql("select count(*) from deployment_area where request_id = cast(:id as uuid) and state = 'RETIRED'").param("id", id)
                .query(Long.class).single()).isEqualTo(2);
    }

    // ---- checks -----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("Checks: occupied ground blocks, a vacated site does not, footprint, deployment pair, range and exception")
    void checks() {
        // the proposed site over the other branch's site: occupied ground
        Map<String, Object> onOther = permanent(List.of(sec, team));
        onOther.put("site", Map.of("geometry", square(lat0, lng0 + 0.02, 0.0008), "shape", "COPY"));
        assertThat(problems(create("req", onOther))).anyMatch(p -> p.contains("يتداخل"));
        // over the requesting units' own site when every unit there moves: vacated, not a conflict
        Map<String, Object> onOwn = permanent(List.of(sec, team));
        onOwn.put("site", Map.of("geometry", square(lat0, lng0 + 0.0003, 0.0008), "shape", "COPY"));
        assertThat(problems(create("req", onOwn))).noneMatch(p -> p.contains("يتداخل"));
        // …but if a unit stays there, the site is occupied
        Map<String, Object> partial = new LinkedHashMap<>(onOwn);
        partial.put("scope", List.of(team.toString()));
        assertThat(problems(create("req", partial))).anyMatch(p -> p.contains("يتداخل"));
        // footprint beyond the policy maximum
        Map<String, Object> big = permanent(List.of(sec));
        big.put("site", Map.of("geometry", square(lat0 - 0.03, lng0, 0.004), "shape", "DRAWN"));
        assertThat(problems(create("req", big))).anyMatch(p -> p.contains("الحد الأقصى"));
        // one deployment area alone, with the policy requiring both
        Map<String, Object> one = permanent(List.of(sec));
        one.put("alternative", null);
        assertThat(problems(create("req", one))).anyMatch(p -> p.contains("مطلوبتان"));
        // out of range, and within the exception margin without a written reason
        Map<String, Object> far = permanent(List.of(sec));
        far.put("primary", square(lat0 - 0.01, lng0 + offsetLng(12_000), 0.002));
        assertThat(problems(create("req", far))).anyMatch(p -> p.contains("خارج النطاق"));
        Map<String, Object> margin = permanent(List.of(sec));
        margin.put("primary", square(lat0 - 0.01, lng0 + offsetLng(8_500), 0.002));
        margin.put("alternative", square(lat0 - 0.01 + offsetLat(4_000), lng0 + offsetLng(8_500), 0.002));
        String mid = create("req", margin);
        assertThat(problems(mid)).anyMatch(p -> p.contains("استثناء"));
        margin.put("exceptions", Map.of("primary", "طريق الوصول الوحيد يمر من هناك"));
        login("req").put("/restationing-requests/" + mid + "/content", margin);
        assertThat(problems(mid)).isEmpty();
        Res s = login("req").post("/restationing-requests/" + mid + "/submit", Map.of());
        assertThat(keys(s.body().path("route"))).as("the exception stage comes before the final stage").containsExactly("H:" + sec, "H:" + dept,
                "X:distance", "H:" + top);
        assertThat(jdbc.sql("select detail::text from audit_event where entity_id = :id and action = 'RESTATIONING_SUBMITTED'").param("id", mid)
                .query(String.class).single()).as("O-17: the written reason is audited with the submission").contains("طريق الوصول الوحيد");
        decide("apSec", mid, "APPROVE");
        decide("apDept", mid, "APPROVE");
        assertThat(decide("apTop", mid, "APPROVE").status()).as("a seat does not decide the exception").isEqualTo(403);
        assertThat(decide("exc", mid, "APPROVE").status()).isEqualTo(200);
    }

    @Test
    @DisplayName("Cross-branch (O-03, O-03b): never moved implicitly; an explicit inclusion adds the other unit's approval")
    void crossBranchInclusion() {
        person("apOsec", seatRole(), otherSec);
        Map<String, Object> c = permanent(List.of(sec, otherSec));
        String id = create("req", c);
        assertThat(problems(id)).as("another branch's unit is never in scope without a decision").anyMatch(p -> p.contains("خارج فرع"));
        c.put("occupants", Map.of(otherSec.toString(), "INCLUDED"));
        login("req").put("/restationing-requests/" + id + "/content", c);
        assertThat(problems(id)).isEmpty();
        Res s = login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        JsonNode route = s.body().path("route");
        assertThat(keys(route)).as("the inclusion is decided before the final stage").containsExactly("H:" + sec, "H:" + dept,
                "C:OTHER_UNIT:" + otherSec + ":" + otherSec, "H:" + top);
        assertThat(texts(route.get(2).path("satisfies"))).anyMatch(t -> t.contains("وحدة OSEC"));
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        assertThat(decide("apTop", id, "APPROVE").status()).as("the other unit decides first").isEqualTo(403);
        assertThat(decide("apOsec", id, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("apTop", id, "APPROVE").body().path("state").asText()).isEqualTo("APPROVED_NOT_ACTIVATED");
    }

    @Test
    @DisplayName("Policy version locking: a submitted request keeps the version it was submitted under")
    void policyVersionLocked() {
        String id = create("req", permanent(List.of(sec)));
        int pinned = login("req").post("/restationing-requests/" + id + "/submit", Map.of()).body().path("policyVersion").asInt();
        // a later version with a smaller footprint maximum does not reach the submitted request
        Map<String, Object> body = new LinkedHashMap<>();
        Map<String, Object> values = new LinkedHashMap<>(json(pinned));
        values.put("maxFootprintAreaM2", 1000);
        body.put("values", values);
        body.put("reason", "تشديد حد المساحة");
        body.put("reference", "اختبار 2");
        assertThat(login("sysadmin").post("/stationing/policy/versions", body).status()).isEqualTo(200);
        JsonNode checks = login("req").get("/restationing-requests/" + id + "/checks").body();
        assertThat(checks.path("policyVersion").asInt()).isEqualTo(pinned);
        assertThat(checks.path("ok").asBoolean()).isTrue();
        String fresh = create("req", permanent(List.of(sec)));
        JsonNode draft = login("req").get("/restationing-requests/" + fresh + "/checks").body();
        assertThat(draft.path("policyVersion").asInt()).as("a draft is checked against the version in force").isGreaterThan(pinned);
        assertThat(texts(draft.path("problems"))).anyMatch(p -> p.contains("الحد الأقصى"));
    }

    @SuppressWarnings("unchecked")
    Map<String, Object> json(int version) {
        try {
            return JSON.readValue(jdbc.sql("select policy_values::text from stationing_policy_version where version = :v").param("v", version)
                    .query(String.class).single(), Map.class);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    @DisplayName("Policy studio: dry-run validation for the System Administrator only; the levels Oracle sends")
    void policyStudioEndpoints() {
        Map<String, Object> values = new LinkedHashMap<>(json(latestVersion()));
        assertThat(login("sysadmin").post("/stationing/policy/validate", Map.of("values", values)).body().path("ok").asBoolean()).isTrue();
        values.put("terrainClassPriority", List.of("UNKNOWN_CLASS"));
        JsonNode bad = login("sysadmin").post("/stationing/policy/validate", Map.of("values", values)).body();
        assertThat(bad.path("ok").asBoolean()).isFalse();
        assertThat(texts(bad.path("problems"))).anyMatch(p -> p.contains("UNKNOWN_CLASS"));
        assertThat(login("req").post("/stationing/policy/validate", Map.of("values", values)).status()).isEqualTo(403);
        int versions = jdbc.sql("select count(*) from stationing_policy_version").query(Integer.class).single();
        assertThat(versions).as("a dry run writes nothing").isEqualTo(latestVersion());
        JsonNode levels = login("sysadmin").get("/stationing/hierarchy-levels").body();
        List<Integer> seen = new ArrayList<>();
        levels.forEach(l -> seen.add(l.path("level").asInt()));
        assertThat(seen).contains(6, 7, 8, 10);
    }

    int latestVersion() {
        return jdbc.sql("select max(version) from stationing_policy_version").query(Integer.class).single();
    }

    @Test
    @DisplayName("Requestable units: exactly where «طلب إعادة التمركز» acts, depth-ordered; enough to create without a view right")
    void requestableUnits() {
        person("reqOnly", role("RSONLY", "ORGANIZATION", "CREATE_RESTATIONING"), sec);
        JsonNode units = login("reqOnly").get("/restationing-requests/units").body();
        assertThat(units.size()).isEqualTo(2);
        assertThat(units.get(0).path("id").asText()).isEqualTo(sec.toString());
        assertThat(units.get(0).path("depth").asInt()).isZero();
        assertThat(units.get(1).path("id").asText()).isEqualTo(team.toString());
        assertThat(units.get(1).path("depth").asInt()).isEqualTo(1);
        assertThat(login("apSec").get("/restationing-requests/units").body().size()).as("a seat alone requests nothing").isZero();
        assertThat(login("reqOnly").get("/organizations/tree").status()).as("the general tree stays a view right").isEqualTo(403);
        Res created = login("reqOnly").post("/restationing-requests", Map.of("requestingUnitId", sec.toString(), "content", permanent(List.of(team))));
        assertThat(created.status()).as(created.toString()).isEqualTo(200);
    }

    // ---- the proposed site geometry (owner, 4 Nov 2026) -----------------------------------------------------

    @Autowired
    RestationingChecks checks;

    @Test
    @DisplayName("Site geometry parity: PostGIS gives the client's verdict on every shared case (siteGeometryCases.json)")
    void siteGeometryParity() throws Exception {
        JsonNode cases = JSON.readTree(java.nio.file.Files.readString(java.nio.file.Path.of("..", "frontend", "src", "lib", "siteGeometryCases.json")))
                .path("cases");
        assertThat(cases.size()).isGreaterThanOrEqualTo(10);
        for (JsonNode c : cases) {
            String problem = checks.siteProblem(JSON.writeValueAsString(c.path("geometry")));
            assertThat(problem == null).as(c.path("name").asText() + ": " + problem).isEqualTo(c.path("valid").asBoolean());
            if (c.has("serverAreaM2")) {
                double area = jdbc.sql("select ST_Area(ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326)::geography)").param("g", JSON.writeValueAsString(c.path("geometry")))
                        .query(Double.class).single();
                assertThat(area).as("the area the client is held to: " + c.path("name").asText()).isCloseTo(c.path("serverAreaM2").asDouble(), org.assertj.core.data.Offset.offset(0.01));
            }
        }
    }

    @Test
    @DisplayName("A site of several parts: submitted, approved and activated as the same MultiPolygon; audited with its parts and area")
    void multiPolygonSite() throws Exception {
        Map<String, Object> c = permanent(List.of(team));
        double lat = lat0 - 0.01;
        c.put("site", Map.of("geometry", multi(lat, lng0), "shape", "COPY"));
        String id = create("req", c);
        Res sub = login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(sub.status()).as(sub.toString()).isEqualTo(200);
        assertThat(sub.body().path("content").path("site").path("geometry").path("coordinates").size()).isEqualTo(3);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        decide("apTop", id, "APPROVE");
        Res act = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(act.status()).as(act.toString()).isEqualTo(200);
        Map<String, Object> g = jdbc.sql("""
                select v.geometry_type, ST_NumGeometries(v.geom) as parts, ST_Area(v.geom::geography) as area
                  from restationing_request r join site_geometry_version v on v.site_id = r.site_id where r.id = cast(:id as uuid)""")
                .param("id", id).query().singleRow();
        assertThat(g.get("geometry_type")).as("the activated site is the submitted geometry, not a regenerated one").isEqualTo("MultiPolygon");
        assertThat(((Number) g.get("parts")).intValue()).isEqualTo(3);
        JsonNode submitted = JSON.readTree(jdbc.sql("select detail::text from audit_event where entity_id = :id and action = 'RESTATIONING_SUBMITTED'")
                .param("id", id).query(String.class).single()).path("site");
        assertThat(submitted.path("type").asText()).isEqualTo("MultiPolygon");
        assertThat(submitted.path("parts").asInt()).isEqualTo(3);
        assertThat(submitted.path("sha256").asText()).hasSize(64);
        assertThat(Math.abs(submitted.path("areaM2").asDouble() - ((Number) g.get("area")).doubleValue())).isLessThan(2.0);
        assertThat(jdbc.sql("select content -> 'site' -> 'geometry' ->> 'type' from restationing_revision where request_id = cast(:id as uuid)")
                .param("id", id).query(String.class).single()).as("the submitted revision keeps the geometry").isEqualTo("MultiPolygon");
    }

    @Test
    @DisplayName("An invalid site of several parts (two overlapping parts) is refused by the checks and at submission")
    void invalidMultiPolygonSite() {
        Map<String, Object> c = permanent(List.of(team));
        double lat = lat0 - 0.01;
        c.put("site", Map.of("geometry", Map.of("type", "MultiPolygon", "coordinates", List.of(
                List.of(ring(lat, lng0, 0.0008)), List.of(ring(lat + 0.0004, lng0 + 0.0004, 0.0008)))), "shape", "EDITED"));
        String id = create("req", c);
        assertThat(problems(id)).anyMatch(x -> x.startsWith("حدود الموقع المقترح"));
        assertThat(login("req").post("/restationing-requests/" + id + "/submit", Map.of()).status()).isEqualTo(400);
    }

    /** Three square parts around (lat, lng), far enough apart to be one valid MultiPolygon. */
    static Map<String, Object> multi(double lat, double lng) {
        return Map.of("type", "MultiPolygon", "coordinates", List.of(List.of(ring(lat, lng, 0.0006)), List.of(ring(lat, lng + 0.003, 0.0004)),
                List.of(ring(lat + 0.003, lng, 0.0004))));
    }

    static List<List<Double>> ring(double lat, double lng, double h) {
        return List.of(List.of(lng - h, lat - h), List.of(lng + h, lat - h), List.of(lng + h, lat + h), List.of(lng - h, lat + h), List.of(lng - h, lat - h));
    }

    @Test
    @DisplayName("Visibility: the requester, viewers of the units and the deciders see a request; others get 404")
    void visibility() {
        String id = create("req", permanent(List.of(sec)));
        login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        assertThat(login("apSec").get("/restationing-requests/" + id).status()).isEqualTo(200);
        assertThat(login("stranger").get("/restationing-requests/" + id).status()).isEqualTo(404);
        assertThat(login("stranger").get("/restationing-requests").body().findValuesAsText("id")).doesNotContain(id);
        assertThat(login("apOther").post("/restationing-requests/" + id + "/decision", Map.of("decision", "APPROVE")).status()).isEqualTo(404);
    }

}
