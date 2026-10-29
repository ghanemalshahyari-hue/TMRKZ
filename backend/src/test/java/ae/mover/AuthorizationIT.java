package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.ViewLevel;
import ae.mover.authz.Authorization;
import ae.mover.authz.AuthzModel;
import ae.mover.authz.AuthzSync;
import ae.mover.authz.FgaClient;
import ae.mover.common.ApiException;
import ae.mover.security.Actor;

/**
 * OpenFGA as co-decider, scoped grants and the permissions studio (ADR-018; PA-08, PA-10, PA-11). Every allowed read in
 * these tests passes the business-database evaluation and OpenFGA; refusals are checked in both.
 */
class AuthorizationIT extends IntegrationTest {

    @Autowired
    AuthzSync sync;
    @Autowired
    FgaClient fga;
    @Autowired
    Authorization authorization;
    @Autowired
    AccessService access;

    UUID root, orgA, orgA1, orgB, orgB1, orgC, siteS, siteS1, siteT, siteU, siteA0, rS, rS1, rS2, rT, rU;
    String viewer, type;
    Map<String, UUID> requests = new LinkedHashMap<>();

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgA1 = org("A1", orgA);
        orgB = org("B", root);
        orgB1 = org("B1", orgB);
        orgC = org("C", root);
        // every requested site is administered by C, so the organisation side of a scope depends on the owner only
        siteS = site("S", null, orgC);
        siteS1 = site("S1", siteS, orgC);
        siteT = site("T", null, orgC);
        siteU = site("U", null, orgC);
        siteA0 = site("A0", null, orgA);
        rS = resource("RS", siteS, null, 0);
        rS2 = resource("RS2", siteS, null, 0);
        rS1 = resource("RS1", siteS1, null, 0);
        rT = resource("RT", siteT, null, 0);
        rU = resource("RU", siteU, null, 0);
        person("admin", "SYSTEM_ADMIN", root);
        // requesters of the fixtures see every facility (they are not the subject of these tests)
        String requester = role("REQALL", "ALL", "VIEW", "CREATE", "EDIT");
        person("reqA1", requester, orgA1);
        person("reqB", requester, orgB);
        person("reqB1", requester, orgB1);
        person("reqC", requester, orgC);
        viewer = role("VIEWER", "ORGANIZATION", "VIEW");
        type = requestType("NEW_RESERVATION", finalOnly(), null);
        requests.put("A1@U", login("reqA1").submitted(type, orgA1, List.of(rU), day("2029-01-01"), day("2029-01-02")));
        requests.put("B@U", login("reqB").submitted(type, orgB, List.of(rU), day("2029-01-01"), day("2029-01-02")));
        requests.put("B1@U", login("reqB1").submitted(type, orgB1, List.of(rU), day("2029-01-01"), day("2029-01-02")));
        requests.put("C@U", login("reqC").submitted(type, orgC, List.of(rU), day("2029-01-01"), day("2029-01-02")));
        requests.put("A1@S1", login("reqA1").submitted(type, orgA1, List.of(rS1), day("2029-01-01"), day("2029-01-02")));
        requests.put("A1@T", login("reqA1").submitted(type, orgA1, List.of(rT), day("2029-01-01"), day("2029-01-02")));
        requests.put("C@S", login("reqC").submitted(type, orgC, List.of(rS), day("2029-01-01"), day("2029-01-02")));
        requests.put("C@S2", login("reqC").submitted(type, orgC, List.of(rS2), day("2029-01-01"), day("2029-01-02")));
    }

    /** Creates a person and a grant through the API as the global access manager. */
    private UUID grantee(String username, UUID home, Map<String, Object> scope) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username) values (:id, :e, :n, :u)")
                .param("id", id).param("e", "T-" + username + "-" + sfx).param("n", "شخص " + username)
                .param("u", username + "-" + sfx).update();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("personId", id.toString());
        body.put("organizationId", home.toString());
        body.put("roleCode", viewer);
        if (scope != null) {
            body.put("scope", scope);
        }
        Res r = login("admin").post("/memberships", body);
        assertThat(r.status()).as(String.valueOf(r.body())).isEqualTo(200);
        return id;
    }

    private static Map<String, Object> target(String kind, UUID id, boolean descendants) {
        return Map.of("kind", kind, "id", id.toString(), "includeDescendants", descendants);
    }

    private static Map<String, Object> custom(String combine, Map<?, ?>... targets) {
        return Map.of("mode", "CUSTOM", "combine", combine, "targets", List.of(targets));
    }

    /** Each named request is readable exactly when expected; list, detail and OpenFGA agree. */
    private void assertVisible(String username, UUID person, Set<String> visible) {
        Api api = login(username);
        Set<String> listed = new HashSet<>();
        for (JsonNode item : api.get("/requests?size=200").body().path("items")) {
            listed.add(item.path("id").asText());
        }
        AccessContext fgaOnly = access.load(new Actor(person, null, null, null), Instant.now()).withConfirmer(authorization);
        for (Map.Entry<String, UUID> e : requests.entrySet()) {
            boolean expected = visible.contains(e.getKey());
            assertThat(api.get("/requests/" + e.getValue()).status()).as("detail " + e.getKey()).isEqualTo(expected ? 200 : 404);
            assertThat(listed.contains(e.getValue().toString())).as("list " + e.getKey()).isEqualTo(expected);
            if (!expected) {
                // asked directly, OpenFGA refuses too: the denial does not rest on the database evaluation alone
                assertThatThrownBy(() -> fgaOnly.confirmView(access.requestScope(e.getValue()), ViewLevel.FULL))
                        .as("OpenFGA " + e.getKey()).isInstanceOf(ApiException.class);
            }
        }
    }

    @Test
    @DisplayName("PA-11: explicit organisation set with per-organisation descendants")
    void explicitOrganisationSet() {
        UUID p = grantee("set", orgA, custom("AND", target("ORGANIZATION", orgA, true), target("ORGANIZATION", orgB, false)));
        assertVisible("set", p, Set.of("A1@U", "B@U", "A1@S1", "A1@T"));
    }

    @Test
    @DisplayName("PA-11: one grant limited by organisation AND site is an intersection, never completed by another grant")
    void organisationAndSiteIntersection() {
        UUID p = grantee("and", orgA, custom("AND", target("ORGANIZATION", orgA, true), target("SITE", siteS, true)));
        assertVisible("and", p, Set.of("A1@S1"));
        // a second, separate grant (B1 ∩ T) must not lend its site to the first grant's organisation (A1 at T stays hidden)
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("personId", p.toString());
        body.put("organizationId", orgB1.toString());
        body.put("roleCode", viewer);
        body.put("scope", custom("AND", target("ORGANIZATION", orgB1, false), target("SITE", siteT, false)));
        assertThat(login("admin").post("/memberships", body).status()).isEqualTo(200);
        assertVisible("and", p, Set.of("A1@S1"));
    }

    @Test
    @DisplayName("PA-11: an explicit OR policy reaches the organisation or the site")
    void organisationOrSite() {
        UUID p = grantee("or", orgB, custom("OR", target("ORGANIZATION", orgB, false), target("SITE", siteT, false)));
        assertVisible("or", p, Set.of("B@U", "A1@T"));
    }

    @Test
    @DisplayName("PA-11: a resource grant reaches requests for that resource only")
    void resourceGrant() {
        UUID p = grantee("res", orgC, custom("AND", target("RESOURCE", rS, false)));
        assertVisible("res", p, Set.of("C@S"));
        // the site holding the resource is visible as a facility; its sibling resource's requests are not
        assertThat(login("res").get("/sites/" + siteS).status()).isEqualTo(200);
        assertThat(login("res").get("/sites/" + siteT).status()).isEqualTo(404);
    }

    @Test
    @DisplayName("PA-11: an access manager cannot grant roles or scopes beyond their own authority")
    void grantAuthorityBounds() {
        String mgrRole = role("ACCMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        String auditor = role("AUD", "ORGANIZATION", "AUDIT", "VIEW");
        jdbc.sql("update role_def set grantable_roles = string_to_array(:g, ',') where code = :c")
                .param("g", viewer).param("c", mgrRole).update();
        person("mgr", mgrRole, orgA);
        Api mgr = login("mgr");
        UUID target = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username) values (:id, :e, 'شخص هدف', :u)")
                .param("id", target).param("e", "T-target-" + sfx).param("u", "target-" + sfx).update();
        Map<String, Object> base = new LinkedHashMap<>();
        base.put("personId", target.toString());
        base.put("organizationId", orgA1.toString());
        base.put("roleCode", viewer);
        assertThat(mgr.post("/memberships", base).status()).as("role scope inside the subtree").isEqualTo(200);

        Map<String, Object> outside = new LinkedHashMap<>(base);
        outside.put("scope", custom("AND", target("ORGANIZATION", orgB, true)));
        assertThat(mgr.post("/memberships", outside).status()).as("organisation outside").isEqualTo(403);

        Map<String, Object> all = new LinkedHashMap<>(base);
        all.put("scope", Map.of("mode", "CUSTOM", "all", true));
        assertThat(mgr.post("/memberships", all).status()).as("explicit ALL").isEqualTo(403);

        Map<String, Object> notGrantable = new LinkedHashMap<>(base);
        notGrantable.put("roleCode", auditor);
        assertThat(mgr.post("/memberships", notGrantable).status()).as("role not grantable").isEqualTo(403);

        Map<String, Object> otherHome = new LinkedHashMap<>(base);
        otherHome.put("organizationId", orgB.toString());
        assertThat(mgr.post("/memberships", otherHome).status()).as("home organisation outside").isEqualTo(403);

        Map<String, Object> foreignSite = new LinkedHashMap<>(base);
        foreignSite.put("scope", custom("AND", target("SITE", siteS, true)));
        assertThat(mgr.post("/memberships", foreignSite).status()).as("site administered by C").isEqualTo(403);

        Map<String, Object> ownSite = new LinkedHashMap<>(base);
        ownSite.put("scope", custom("AND", target("SITE", siteA0, false)));
        assertThat(mgr.post("/memberships", ownSite).status()).as("site administered by A").isEqualTo(200);

        UUID foreign = membership(target, viewer, orgB, null);
        assertThat(mgr.post("/memberships/" + foreign + "/end", Map.of("reason", "خارج النطاق")).status()).isEqualTo(404);
    }

    @Test
    @DisplayName("PA-08: an ended grant stops the next read in the same session, in the database and in OpenFGA")
    void revocationInSession() {
        UUID p = grantee("rev", orgA, null);
        Api rev = login("rev");
        UUID id = requests.get("A1@U");
        assertThat(rev.get("/requests/" + id).status()).isEqualTo(200);
        UUID membership = jdbc.sql("select id from membership where person_id = :p").param("p", p).query(UUID.class).single();
        assertThat(login("admin").post("/memberships/" + membership + "/end", Map.of("reason", "نقل إلى جهة أخرى")).status()).isEqualTo(200);
        assertThat(rev.get("/requests/" + id).status()).isEqualTo(404);
        sync.run(false);
        assertThat(jdbc.sql("select count(*) from authz_tuple where person_id = :p").param("p", p).query(Integer.class).single()).isZero();
        AccessContext fgaOnly = access.load(new Actor(p, null, null, null), Instant.now()).withConfirmer(authorization);
        assertThatThrownBy(() -> fgaOnly.confirmView(access.requestScope(id), ViewLevel.FULL)).isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("OpenFGA decides too: a missing tuple refuses an allowed action; an unreachable store refuses; rebuild repairs")
    void openFgaCoDecidesAndFailsClosed() throws Exception {
        UUID p = grantee("co", orgA, null);
        Api co = login("co");
        UUID id = requests.get("A1@U");
        assertThat(co.get("/requests/" + id).status()).isEqualTo(200);

        // remove the grant's holder tuple in OpenFGA only (the database still allows)
        String holder = jdbc.sql("select object from authz_tuple where person_id = :p and relation = 'holder'")
                .param("p", p).query(String.class).single();
        AuthzSync.Ready ready = sync.ready();
        fga.write(ready.storeId(), ready.modelId(), List.of(), List.of(new FgaClient.Tuple(holder, "holder", "user:" + p, null)));
        Res refused = login("co").get("/requests/" + id);
        assertThat(refused.status()).isEqualTo(403);
        assertThat(refused.body().path("message").asText()).contains("خدمة قرارات الصلاحيات");

        // a rebuild from the database repairs OpenFGA in a new store and switches to it
        Res rebuilt = login("admin").post("/access/rebuild", Map.of());
        assertThat(rebuilt.status()).as(String.valueOf(rebuilt.body())).isEqualTo(200);
        assertThat(rebuilt.body().path("storeId").asText()).isNotEqualTo(ready.storeId());
        assertThat(login("co").get("/requests/" + id).status()).isEqualTo(200);

        // decision service unreachable (fault injected on the store in use): refused with a service error, never allowed
        var field = AuthzSync.class.getDeclaredField("ready");
        field.setAccessible(true);
        Object current = field.get(sync);
        field.set(sync, new AuthzSync.Ready("01JAAAAAAAAAAAAAAAAAAAAAAA", sync.ready().modelId()));
        try {
            Res down = login("co").get("/requests/" + id);
            assertThat(down.status()).isEqualTo(503);
            assertThat(down.body().path("code").asText()).isEqualTo("AUTHZ_UNAVAILABLE");
        } finally {
            field.set(sync, current);
        }
        assertThat(login("co").get("/requests/" + id).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("Studio: draft, impact, publish with pinned model, refusal for non-global managers, recorded rollback")
    void policyVersions() {
        String exporter = role("EXPORTER", "ORGANIZATION", "VIEW", "EXPORT");
        String dummy = role("DUMMY", "ORGANIZATION", "VIEW");
        person("exp", exporter, orgA);
        Api admin = login("admin");
        assertThat(login("exp").post("/exports", Map.of("kind", "REQUESTS_CSV")).status()).isEqualTo(200);

        // version with EXPORT still granted (a harmless rename makes it publishable)
        assertThat(admin.post("/access/policy/draft", Map.of("note", "اختبار")).status()).isEqualTo(200);
        assertThat(admin.put("/access/policy/draft/roles", Map.of("code", dummy, "name", "دور اختبار معاد تسميته",
                "permissions", List.of("VIEW"), "scope", "ORGANIZATION")).status()).isEqualTo(200);
        Res first = admin.post("/access/policy/draft/publish", Map.of("note", "تسمية دور الاختبار"));
        assertThat(first.status()).as(String.valueOf(first.body())).isEqualTo(200);
        String firstId = first.body().path("id").asText();
        assertThat(first.body().path("fgaModelId").asText()).isEqualTo(admin.get("/access/status").body().path("modelId").asText());

        // remove EXPORT: impact names the holders, publication withdraws the right on the next call
        admin.post("/access/policy/draft", Map.of());
        assertThat(admin.put("/access/policy/draft/roles", Map.of("code", exporter, "name", "مصدّر",
                "permissions", List.of("VIEW"), "scope", "ORGANIZATION")).status()).isEqualTo(200);
        JsonNode impact = admin.get("/access/policy/draft/impact").body();
        JsonNode changed = null;
        for (JsonNode r : impact.path("roles")) {
            if (r.path("code").asText().equals(exporter)) {
                changed = r;
            }
        }
        assertThat(changed).isNotNull();
        assertThat(changed.path("change").asText()).isEqualTo("CHANGED");
        assertThat(changed.path("removed").toString()).contains("EXPORT");
        assertThat(changed.path("persons").asInt()).isEqualTo(1);
        assertThat(impact.path("publishable").asBoolean()).isTrue();
        assertThat(admin.post("/access/policy/draft/publish", Map.of()).status()).as("note required").isEqualTo(400);
        assertThat(admin.post("/access/policy/draft/publish", Map.of("note", "سحب التصدير")).status()).isEqualTo(200);
        assertThat(login("exp").post("/exports", Map.of("kind", "REQUESTS_CSV")).status()).isEqualTo(403);

        // a manager below the global level cannot change the policy
        String mgrRole = role("LOCALMGR", "ORGANIZATION", "MANAGE_ACCESS");
        person("local", mgrRole, orgA);
        assertThat(login("local").post("/access/policy/draft", Map.of()).status()).isEqualTo(403);

        // rollback = a new published version copied from the earlier one, recorded with its origin
        Res restored = admin.post("/access/policy/versions/" + firstId + "/restore", Map.of("note", "إعادة التصدير"));
        assertThat(restored.status()).as(String.valueOf(restored.body())).isEqualTo(200);
        assertThat(restored.body().path("status").asText()).isEqualTo("PUBLISHED");
        assertThat(restored.body().path("restoredFromVersion").asInt()).isEqualTo(first.body().path("version").asInt());
        assertThat(login("exp").post("/exports", Map.of("kind", "REQUESTS_CSV")).status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'POLICY_RESTORED' and entity_id = :id")
                .param("id", restored.body().path("id").asText()).query(Integer.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("Studio: explanation per action with reasons, and OpenFGA's answer equal to the grants' answer")
    void explain() {
        UUID p = grantee("why", orgA, custom("AND", target("ORGANIZATION", orgA, true), target("SITE", siteS, true)));
        Api admin = login("admin");
        JsonNode in = admin.get("/access/explain?personId=" + p + "&organizationId=" + orgA1 + "&siteId=" + siteS1).body();
        JsonNode out = admin.get("/access/explain?personId=" + p + "&organizationId=" + orgA1 + "&siteId=" + siteT).body();
        for (JsonNode a : in.path("actions")) {
            boolean allowed = a.path("published").path("allowed").asBoolean();
            assertThat(a.path("action").asText().equals("VIEW")).as(a.toString()).isEqualTo(allowed);
            assertThat(a.path("openfga").asBoolean()).as("OpenFGA " + a.path("action").asText()).isEqualTo(allowed);
        }
        JsonNode view = in.path("actions").get(0);
        assertThat(view.path("published").path("reasons").get(0).path("scope").asText()).contains("بشرط");
        for (JsonNode a : out.path("actions")) {
            assertThat(a.path("published").path("allowed").asBoolean()).isFalse();
            assertThat(a.path("openfga").asBoolean()).isFalse();
        }
    }

    @Test
    @DisplayName("The published OpenFGA model matches the generator and the reviewed copy in docs/authz/model.fga")
    void modelPublished() throws Exception {
        String doc = Files.readString(Path.of("..", "docs", "authz", "model.fga")).replace("\r\n", "\n");
        assertThat(doc).isEqualTo(AuthzModel.dsl());
        JsonNode status = login("admin").get("/access/status").body();
        assertThat(status.path("configured").asBoolean()).isTrue();
        assertThat(status.path("reachable").asBoolean()).isTrue();
        assertThat(status.path("modelId").asText()).isNotBlank();
        assertThat(status.path("modelHash").asText()).isEqualTo(AuthzModel.hash());
        assertThat(login("reqC").get("/access/status").status()).isEqualTo(403);
    }
}
