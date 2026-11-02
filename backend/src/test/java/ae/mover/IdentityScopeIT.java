package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Identity and directory scope (ADR-027, phase 2 of the remediation brief): an access manager sees and acts only on
 * people inside their authority — the unlinked sign-ins whose key belongs to such a person, a directory without
 * cross-organisation search, links and grants bounded by what the manager could grant, and no explanation of
 * outsiders. Cross-organisation work stays possible through an explicit grant on a site the manager administers.
 */
class IdentityScopeIT extends IntegrationTest {

    UUID root, orgA, orgA1, orgB, siteA, admin, mgr, pa1, papr, pb, pshared;
    String viewer, siteViewer, mgrRole, issuer;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgA1 = org("A1", orgA);
        orgB = org("B", root);
        siteA = site("SA", null, orgA);
        viewer = role("VIEWER", "ORGANIZATION", "VIEW");
        siteViewer = role("SITEVIEW", "SITE", "VIEW");
        mgrRole = role("ACCMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        jdbc.sql("update role_def set grantable_roles = string_to_array(:g, ',') where code = :c")
                .param("g", viewer + "," + siteViewer).param("c", mgrRole).update();
        admin = person("admin", "SYSTEM_ADMIN", root);
        mgr = person("mgr", mgrRole, orgA);
        pa1 = person("pa1", viewer, orgA1);
        papr = person("papr", "APPROVER", orgA1);
        pb = person("pb", viewer, orgB);
        // a person of B explicitly granted on a site that A administers (cross-organisation work)
        pshared = person("pshared", siteViewer, orgB, siteA);
        issuer = "https://idp.test/" + sfx;
    }

    private String emp(String user) {
        return "T-" + user + "-" + sfx;
    }

    private UUID issue(String claimedKey, String reason) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into identity_link_issue(id, issuer, subject, claimed_key, display_name, reason)
                values (:id, :i, :s, :k, :n, :r)""")
                .param("id", id).param("i", issuer).param("s", "sub-" + id).param("k", claimedKey)
                .param("n", "حساب " + (claimedKey == null ? "دون مفتاح" : claimedKey)).param("r", reason).update();
        return id;
    }

    private Res resolve(Api a, UUID issue, UUID person) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("personId", person == null ? null : person.toString());
        body.put("reason", "قرار ربط في الاختبار");
        return a.post("/identity-issues/" + issue + "/resolve", body);
    }

    @Test
    @DisplayName("ID-1: an access manager sees only unlinked sign-ins whose key belongs to someone inside their authority")
    void issuesScoped() {
        UUID iA1 = issue(emp("pa1"), "STALE_SOURCE");
        UUID iB = issue(emp("pb"), "STALE_SOURCE");
        UUID iNone = issue(null, "NO_KEY");
        UUID iUnknown = issue("UNKNOWN-" + sfx, "NO_MATCH");
        Api m = login("mgr");
        String seen = m.get("/identity-issues").body().toString();
        assertThat(seen).contains(iA1.toString()).doesNotContain(iB.toString()).doesNotContain(iNone.toString())
                .doesNotContain(iUnknown.toString());
        assertThat(resolve(m, iB, null).status()).as("dismiss outside").isEqualTo(404);
        assertThat(resolve(m, iNone, pa1).status()).as("link a key-less sign-in").isEqualTo(404);
        String all = login("admin").get("/identity-issues").body().toString();
        assertThat(all).contains(iA1.toString()).contains(iB.toString()).contains(iNone.toString()).contains(iUnknown.toString());
    }

    @Test
    @DisplayName("ID-2: linking a sign-in is a grant of the person's roles: bounded by the linker's authority, never to oneself")
    void linkBounded() {
        Api m = login("mgr");
        UUID iApr = issue(emp("papr"), "STALE_SOURCE");
        Res beyond = resolve(m, iApr, papr);
        assertThat(beyond.status()).as("person holding APPROVER: " + beyond).isEqualTo(403);
        assertThat(jdbc.sql("select count(*) from identity_link where person_id = :p and issuer = :i").param("p", papr)
                .param("i", issuer).query(Integer.class).single()).isZero();
        // a sign-in that claims one person is never linked to another
        UUID iA1 = issue(emp("pa1"), "STALE_SOURCE");
        Res wrong = resolve(login("admin"), iA1, papr);
        assertThat(wrong.status()).as("claims pa1, linked to papr: " + wrong).isIn(400, 403);
        // nobody links a sign-in to themselves
        assertThat(resolve(m, issue(emp("mgr"), "STALE_SOURCE"), mgr).status()).as("self, scoped").isEqualTo(403);
        assertThat(resolve(login("admin"), issue(emp("admin"), "STALE_SOURCE"), admin).status()).as("self, global").isEqualTo(403);
        // the temporary first administrator is never a link target
        UUID boot = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, source, bootstrap) values (:id, :e, 'مدير مؤقت', 'LOCAL', true)")
                .param("id", boot).param("e", "BOOTSTRAP-x-" + sfx).update();
        assertThat(resolve(login("admin"), issue(null, "NO_KEY"), boot).status()).as("bootstrap target").isEqualTo(403);

        // authorised: the scoped manager links a grantable-only person; the global manager links the approver
        assertThat(resolve(m, iA1, pa1).status()).isEqualTo(204);
        assertThat(resolve(login("admin"), iApr, papr).status()).isEqualTo(204);
    }

    @Test
    @DisplayName("ID-3: the directory has no cross-organisation search; an explicit site grant is the only bridge, with minimal detail")
    void directoryStrict() {
        Api m = login("mgr");
        String inside = m.get("/people?q=" + sfx + "&size=50").body().toString();
        assertThat(inside).contains("pa1-" + sfx).contains("papr-" + sfx).doesNotContain("pb-" + sfx).doesNotContain("admin-" + sfx);
        String byName = m.get("/people?q=" + URLEncoder.encode("شخص pb", StandardCharsets.UTF_8) + "&size=50").body().toString();
        assertThat(byName).as("outsider by name").doesNotContain("شخص pb");
        assertThat(m.get("/people?q=" + emp("pb")).body().toString()).as("outsider by exact employee number").doesNotContain("شخص pb");
        assertThat(m.get("/people?q=pb-" + sfx).body().toString()).as("outsider by exact account").doesNotContain("شخص pb");

        JsonNode bridge = m.get("/people?q=pshared&size=50").body().path("items");
        assertThat(bridge.size()).as("explicit site grant").isEqualTo(1);
        assertThat(bridge.get(0).has("employeeNo")).isFalse();
        assertThat(bridge.get(0).has("username")).isFalse();

        assertThat(login("admin").get("/people?q=" + sfx + "&size=50").body().toString()).contains("pb-" + sfx).contains("pa1-" + sfx);
    }

    @Test
    @DisplayName("ID-4: a scoped manager grants only to people inside their authority and ends only grants they could give")
    void grantsBounded() {
        Api m = login("mgr");
        Map<String, Object> g = new LinkedHashMap<>();
        g.put("organizationId", orgA.toString());
        g.put("roleCode", viewer);
        g.put("personId", pb.toString());
        assertThat(m.post("/memberships", g).status()).as("outsider by identifier").isEqualTo(403);
        g.put("personId", pshared.toString());
        assertThat(m.post("/memberships", g).status()).as("explicit site bridge").isEqualTo(200);
        g.put("personId", pa1.toString());
        Res granted = m.post("/memberships", g);
        assertThat(granted.status()).isEqualTo(200);

        UUID approverGrant = jdbc.sql("select id from membership where person_id = :p and role_code = 'APPROVER'").param("p", papr)
                .query(UUID.class).single();
        assertThat(m.post("/memberships/" + approverGrant + "/end", Map.of("reason", "إنهاء دور يتجاوز الصلاحية")).status())
                .as("end a grant beyond authority").isEqualTo(403);
        assertThat(m.post("/memberships/" + granted.body().path("id").asText() + "/end", Map.of("reason", "إنهاء منحة الاختبار"))
                .status()).isEqualTo(200);
    }

    @Test
    @DisplayName("ID-6 (independent review): no roster of an organisation shown as context; no explanation of a bridge")
    void rosterAndExplainBounded() {
        Api m = login("mgr");
        JsonNode rootDetail = m.get("/organizations/" + root).body();
        assertThat(rootDetail.path("members").size()).as("ancestor shown as context").isZero();
        assertThat(rootDetail.toString()).doesNotContain(emp("admin"));
        assertThat(m.get("/organizations/" + orgA1).body().toString()).as("own subtree").contains(emp("pa1"));
        assertThat(m.get("/access/explain?personId=" + pshared).status()).as("bridge").isEqualTo(404);
        assertThat(m.get("/people?q=" + emp("pshared")).body().path("items").size()).as("bridge by employee number").isZero();
    }

    @Test
    @DisplayName("ID-7 (independent review): another record of oneself is oneself; delegations hand out no administration")
    void aliasesAndDelegations() {
        // a second record sharing the manager's key (here through a linked sign-in that claimed it)
        UUID alias = person("alias", viewer, orgA1);
        jdbc.sql("""
                insert into identity_link_issue(id, issuer, subject, claimed_key, display_name, reason, resolved_at, resolved_person_id, resolution)
                values (:id, :i, :s, :k, 'حساب بديل', 'ALREADY_LINKED', now(), :p, 'LINKED')""")
                .param("id", UUID.randomUUID()).param("i", issuer).param("s", "alias-" + sfx).param("k", emp("mgr")).param("p", alias).update();
        Api m = login("mgr");
        Map<String, Object> g = new LinkedHashMap<>();
        g.put("personId", alias.toString());
        g.put("organizationId", orgA.toString());
        g.put("roleCode", viewer);
        assertThat(m.post("/memberships", g).status()).as("grant to one's own other record").isEqualTo(403);

        UUID mgrAccess = jdbc.sql("select id from membership where person_id = :p").param("p", mgr).query(UUID.class).single();
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("delegateId", pa1.toString());
        d.put("membershipId", mgrAccess.toString());
        d.put("validTo", java.time.Instant.now().plusSeconds(3600).toString());
        d.put("reason", "تفويض صلاحيات الإدارة");
        assertThat(m.post("/delegations", d).status()).as("delegating access administration").isEqualTo(403);
        UUID boot = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, source, bootstrap) values (:id, :e, 'مدير مؤقت', 'LOCAL', true)")
                .param("id", boot).param("e", "BOOTSTRAP-d-" + sfx).update();
        UUID viewerGrant = jdbc.sql("select id from membership where person_id = :p").param("p", pa1).query(UUID.class).single();
        Map<String, Object> toBoot = new LinkedHashMap<>(d);
        toBoot.put("delegateId", boot.toString());
        toBoot.put("membershipId", viewerGrant.toString());
        assertThat(login("pa1").post("/delegations", toBoot).status()).as("to the bootstrap identity").isEqualTo(403);
        Map<String, Object> ordinary = new LinkedHashMap<>(toBoot);
        ordinary.put("delegateId", pb.toString());
        assertThat(login("pa1").post("/delegations", ordinary).status()).as("an ordinary delegation").isEqualTo(200);
    }

    @Test
    @DisplayName("ID-8 (independent review): a site cannot be saved with NaN coordinates")
    void nanCoordinates() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", "NAN-" + sfx);
        body.put("name", "موقع غير صالح");
        body.put("kind", "مرفق");
        body.put("responsibleOrgId", orgA.toString());
        body.put("location", Map.of("lat", "NaN", "lng", "NaN"));
        Res r = login("admin").post("/sites", body);
        assertThat(r.status()).as(r.toString()).isEqualTo(400);
        assertThat(jdbc.sql("select count(*) from site where code = :c").param("c", "NAN-" + sfx).query(Integer.class).single()).isZero();
    }

    @Test
    @DisplayName("ID-5: an ended grant does not let a scoped manager inspect an outsider's access")
    void explainScoped() {
        UUID old = membership(pb, viewer, orgA, null);
        jdbc.sql("update membership set valid_to = '2026-02-01T00:00:00Z' where id = :id").param("id", old).update();
        Api m = login("mgr");
        assertThat(m.get("/access/explain?personId=" + pb).status()).as("outsider with an ended grant in A").isEqualTo(404);
        assertThat(m.get("/access/explain?personId=" + pa1).status()).isEqualTo(200);
    }
}
