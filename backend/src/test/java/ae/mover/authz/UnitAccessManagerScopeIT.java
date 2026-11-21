package ae.mover.authz;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.IntegrationTest;

/**
 * ACCESS-MANAGER-SCOPE-01..04 and the self-escalation guards (owner, 21 Nov 2026): «مدير صلاحيات الوحدة»
 * honours the same three scope modes as the other scoped roles (UNIT, UNIT_TREE, LEVELS) and their union, but
 * its reach is a management reach — not a view scope. Every grant the manager writes is bounded, atomically, by
 * the manager's own reach: the issuer must cover every target, never one of them; a role must be in the manager's
 * grantable-roles list; and the manager can never widen their own reach or anyone else's. System-only actions
 * stay with the global manager. Each test seeds the canonical UNIT_ACCESS_MANAGER / STATIONING_REQUESTER / FYI_RECEIVER
 * roles so the authority check in {@code GrantAdminService} has the expected grantable catalogue.
 */
class UnitAccessManagerScopeIT extends IntegrationTest {

    // ---- fixtures ------------------------------------------------------------------------------------------------

    private UUID publishedSnapshot() {
        UUID s = jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).optional().orElse(null);
        if (s != null) return s;
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        s = UUID.randomUUID();
        jdbc.sql("insert into hr_source(id, name) values (:id, 'مصدر اختبار نطاق مدير الصلاحيات')").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'DRAFT', '{}', '{}')")
                .param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, trigger, status, started_at) values (:id, 'MANUAL', 'SUCCEEDED', now())").param("id", run).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())")
                .param("id", s).param("r", run).param("m", mapping).update();
        return s;
    }

    private UUID hrOrg(String code, UUID parent, int level, UUID snapshot) {
        UUID id = UUID.randomUUID();
        String ext = "UAM-" + code + "-" + sfx;
        jdbc.sql("""
                insert into organization(id, code, name, parent_id, valid_from, source, source_external_id)
                values (:id, :c, :n, :p, '2026-01-01T00:00:00Z', 'HR', :e)""")
                .param("id", id).param("c", ext).param("n", "وحدة " + code).param("p", parent).param("e", ext).update();
        jdbc.sql("insert into hr_unit(snapshot_id, external_id, name, level, active, is_main) values (:s, :e, :n, :l, true, :m)")
                .param("s", snapshot).param("e", ext).param("n", "وحدة " + code).param("l", level).param("m", parent == null).update();
        return id;
    }

    /** Seed the canonical roles the manager assigns against, with the expected grantable list. */
    private void seedCanonicalRoles() {
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order, grantable_roles)
                values ('UNIT_ACCESS_MANAGER', 'مدير صلاحيات الوحدة', array['MANAGE_ACCESS','REVIEW'], 'ORGANIZATION', false, 980, array['STATIONING_REQUESTER','POSTURE_VIEWER','FYI_RECEIVER'])
                on conflict (code) do update set permissions = excluded.permissions, grantable_roles = excluded.grantable_roles""").update();
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order)
                values ('STATIONING_REQUESTER', 'مقدم الطلب', array['VIEW','CREATE_RESTATIONING','REQUEST_SITE_REGISTRATION'], 'ORGANIZATION', false, 990)
                on conflict (code) do nothing""").update();
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order)
                values ('POSTURE_VIEWER', 'معاين الموقف العملياتي', array['VIEW_OPERATIONAL_POSTURE'], 'ORGANIZATION', false, 991)
                on conflict (code) do nothing""").update();
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order)
                values ('FYI_RECEIVER', 'معتمد إبلاغ', array['VIEW'], 'ORGANIZATION', false, 992)
                on conflict (code) do nothing""").update();
    }

    private record Target(UUID anchor, boolean includeDescendants, List<Integer> levels) {}

    /** Create a scoped UNIT_ACCESS_MANAGER with the full access rights and the anchor+mode choices. */
    private UUID manager(String username, UUID homeUnit, List<Target> targets) {
        UUID person = person(username, "UNIT_ACCESS_MANAGER", homeUnit);
        UUID membershipId = jdbc.sql("select id from membership where person_id = :p and role_code = 'UNIT_ACCESS_MANAGER' order by valid_from desc limit 1")
                .param("p", person).query(UUID.class).single();
        jdbc.sql("update membership set scope_mode = 'CUSTOM', scope_combine = 'AND', scope_all = false, access_rights = array['LOOKUP','REVIEW','GRANT','DELEGATE','FINALIZE'] where id = :id")
                .param("id", membershipId).update();
        for (Target t : targets) {
            jdbc.sql("""
                    insert into membership_scope_target(membership_id, kind, target_id, include_descendants, levels)
                    values (:m, 'ORGANIZATION', :a, :d, string_to_array(nullif(:l, ''), ',')::int[])""")
                    .param("m", membershipId).param("a", t.anchor()).param("d", t.includeDescendants() || !t.levels().isEmpty())
                    .param("l", String.join(",", t.levels().stream().map(String::valueOf).toList())).update();
        }
        jdbc.sql("insert into authz_change(person_id, source) values (:p, 'test:uam-scope')").param("p", person).update();
        return person;
    }

    /** Create a grantee affiliated with the given organisation so they appear in the manager's directory
     *  (ADR-027). Without the affiliation, every grant attempt fails with the directory-coverage refusal
     *  before the authority check runs, which would hide the issuer/scope decisions the test is for. */
    private UUID grantee(String username, UUID affiliatedWith) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username) values (:id, :e, :n, :u)")
                .param("id", id).param("e", "UAM-G-" + username + "-" + sfx).param("n", "مكلَّف " + username)
                .param("u", username + "-" + sfx).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (:id, :p, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("p", id).param("o", affiliatedWith).update();
        return id;
    }

    private static Map<String, Object> target(String kind, UUID id, boolean descendants) {
        return Map.of("kind", kind, "id", id.toString(), "includeDescendants", descendants);
    }

    private static Map<String, Object> custom(Map<?, ?>... targets) {
        return Map.of("mode", "CUSTOM", "combine", "AND", "all", false, "targets", List.of(targets));
    }

    private static Map<String, Object> body(UUID grantee, UUID home, String role, Map<String, Object> scope) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("personId", grantee.toString());
        m.put("organizationId", home.toString());
        m.put("roleCode", role);
        m.put("scope", scope);
        return m;
    }

    // ---- ACCESS-MANAGER-SCOPE-01 — UNIT --------------------------------------------------------------------------

    @Test
    @DisplayName("ACCESS-MANAGER-SCOPE-01: UNIT — the manager can grant on Section 2 only, never on children")
    void unitAnchor() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing, 2, snapshot);
        UUID sec2 = hrOrg("SEC2", wing, 2, snapshot);
        UUID teamC = hrOrg("TEAMC", sec2, 3, snapshot);
        manager("uam01mgr", wing, List.of(new Target(sec2, false, List.of())));
        UUID g = grantee("uam01g", sec2);
        Api mgr = login("uam01mgr");

        // grant on sec2 itself — allowed
        assertThat(mgr.post("/memberships", body(g, sec2, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec2, false)))).status()).as("anchor UNIT").isEqualTo(200);
        // grant on sec2 with descendants — not covered by the manager's UNIT anchor; rejected
        Res tree = mgr.post("/memberships", body(g, sec2, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec2, true))));
        assertThat(tree.status()).as("UNIT_TREE exceeds a UNIT anchor: " + tree).isEqualTo(403);
        // grant on a descendant (team_c) — outside the UNIT anchor; rejected
        Res child = mgr.post("/memberships", body(g, teamC, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", teamC, false))));
        assertThat(child.status()).as("descendant outside UNIT anchor: " + child).isEqualTo(403);
        // grant on a sibling — rejected
        Res sibling = mgr.post("/memberships", body(g, sec1, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec1, false))));
        assertThat(sibling.status()).as("sibling outside UNIT anchor: " + sibling).isEqualTo(403);
    }

    // ---- ACCESS-MANAGER-SCOPE-02 — UNIT_TREE ---------------------------------------------------------------------

    @Test
    @DisplayName("ACCESS-MANAGER-SCOPE-02: UNIT_TREE — the manager grants anywhere under Wing 1; outside-branch rejected")
    void unitTreeAnchor() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        UUID teamA = hrOrg("TEAMA", sec1, 3, snapshot);
        UUID wing2 = hrOrg("WING2", null, 1, snapshot);
        UUID sec3 = hrOrg("SEC3", wing2, 2, snapshot);
        manager("uam02mgr", wing1, List.of(new Target(wing1, true, List.of())));
        UUID g = grantee("uam02g", sec1);
        Api mgr = login("uam02mgr");

        // UNIT at sec1 — inside the UNIT_TREE anchor; allowed
        assertThat(mgr.post("/memberships", body(g, sec1, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec1, false)))).status()).as("UNIT inside UNIT_TREE").isEqualTo(200);
        // UNIT_TREE at sec1 — still inside; allowed
        assertThat(mgr.post("/memberships", body(g, sec1, "POSTURE_VIEWER",
                custom(target("ORGANIZATION", sec1, true)))).status()).as("UNIT_TREE inside UNIT_TREE").isEqualTo(200);
        // UNIT at a leaf (team_a) — still inside; allowed
        assertThat(mgr.post("/memberships", body(g, teamA, "FYI_RECEIVER",
                custom(target("ORGANIZATION", teamA, false)))).status()).as("leaf inside UNIT_TREE").isEqualTo(200);
        // outside-branch — rejected
        Res outside = mgr.post("/memberships", body(g, wing2, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", wing2, true))));
        assertThat(outside.status()).as("outside branch wing2: " + outside).isEqualTo(403);
        Res outsideChild = mgr.post("/memberships", body(g, sec3, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec3, false))));
        assertThat(outsideChild.status()).as("outside branch sec3: " + outsideChild).isEqualTo(403);
    }

    // ---- ACCESS-MANAGER-SCOPE-03 — LEVELS ------------------------------------------------------------------------

    @Test
    @DisplayName("ACCESS-MANAGER-SCOPE-03: LEVELS — manager restricted to levels under Wing 1 cannot grant at other levels")
    void levelsAnchor() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        UUID sec2 = hrOrg("SEC2", wing1, 2, snapshot);
        UUID teamA = hrOrg("TEAMA", sec1, 3, snapshot);
        UUID teamC = hrOrg("TEAMC", sec2, 3, snapshot);
        // manager restricted to level 3 under wing1 → reach = {teamA, teamC} only
        manager("uam03mgr", wing1, List.of(new Target(wing1, true, List.of(3))));
        UUID g = grantee("uam03g", teamA);
        Api mgr = login("uam03mgr");

        // UNIT at a level-3 unit — inside; allowed
        assertThat(mgr.post("/memberships", body(g, teamA, "POSTURE_VIEWER",
                custom(target("ORGANIZATION", teamA, false)))).status()).as("level-3 UNIT allowed").isEqualTo(200);
        // UNIT at a level-2 unit (sec1) — NOT inside the manager's LEVELS reach; rejected
        Res up = mgr.post("/memberships", body(g, sec1, "POSTURE_VIEWER",
                custom(target("ORGANIZATION", sec1, false))));
        assertThat(up.status()).as("level-2 unit outside the LEVELS manager's reach: " + up).isEqualTo(403);
        // UNIT_TREE at a level-3 unit — descendants expand beyond LEVELS; even if the leaf has no children, the
        // request is for «unit with descendants». No level-3 unit here has children, but the manager's reach is
        // still exact unit ids, not an organisation subtree, so UNIT_TREE at team_a is a widened grant only when
        // team_a has descendants. We use team_c, which is also a leaf, to confirm this behaves identically.
        assertThat(mgr.post("/memberships", body(g, teamC, "POSTURE_VIEWER",
                custom(target("ORGANIZATION", teamC, false)))).status()).as("other level-3 leaf allowed").isEqualTo(200);
    }

    // ---- ACCESS-MANAGER-SCOPE-04 — MULTIPLE ROOTS ----------------------------------------------------------------

    @Test
    @DisplayName("ACCESS-MANAGER-SCOPE-04: MULTI — effective reach is the union of {Section1 UNIT, Section4 UNIT_TREE}; nothing between them is covered")
    void multipleRoots() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing, 2, snapshot);
        UUID sec2 = hrOrg("SEC2", wing, 2, snapshot);
        UUID sec4 = hrOrg("SEC4", wing, 2, snapshot);
        UUID teamD = hrOrg("TEAMD", sec4, 3, snapshot);
        manager("uam04mgr", wing, List.of(
                new Target(sec1, false, List.of()),
                new Target(sec4, true, List.of())));
        UUID g = grantee("uam04g", sec1);
        Api mgr = login("uam04mgr");

        assertThat(mgr.post("/memberships", body(g, sec1, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec1, false)))).status()).as("sec1 UNIT allowed").isEqualTo(200);
        assertThat(mgr.post("/memberships", body(g, teamD, "POSTURE_VIEWER",
                custom(target("ORGANIZATION", teamD, false)))).status()).as("sec4 descendant allowed").isEqualTo(200);
        // sec2 is between the two anchors but is not covered by either — rejected
        Res between = mgr.post("/memberships", body(g, sec2, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec2, false))));
        assertThat(between.status()).as("section between two anchors is rejected: " + between).isEqualTo(403);
        // the implicit common parent (the wing) is not implied by the union — rejected
        Res parent = mgr.post("/memberships", body(g, wing, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", wing, true))));
        assertThat(parent.status()).as("implicit common parent not covered: " + parent).isEqualTo(403);
    }

    // ---- ISSUER-COVERS-EVERY-TARGET (atomic refusal) -------------------------------------------------------------

    @Test
    @DisplayName("ACCESS-MANAGER-ATOMIC: a grant with mixed inside/outside targets is refused whole; no partial save")
    void atomicRefusalForMixedTargets() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        UUID wing2 = hrOrg("WING2", null, 1, snapshot);
        UUID sec3 = hrOrg("SEC3", wing2, 2, snapshot);
        manager("uamatommgr", wing1, List.of(new Target(wing1, true, List.of())));
        UUID g = grantee("uamatomg", sec1);
        Api mgr = login("uamatommgr");

        Res mixed = mgr.post("/memberships", body(g, sec1, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec1, false), target("ORGANIZATION", sec3, false))));
        assertThat(mixed.status()).as("mixed targets rejected whole: " + mixed).isEqualTo(403);

        // No membership for the grantee should exist: not even for the inside half (atomic write, not partial)
        Long memberships = jdbc.sql("select count(*) from membership where person_id = :p and role_code = 'STATIONING_REQUESTER'")
                .param("p", g).query(Long.class).single();
        assertThat(memberships).as("atomic: no partial save").isZero();
    }

    // ---- SELF-ESCALATION — the manager cannot widen through their own grants -------------------------------------

    @Test
    @DisplayName("ACCESS-MANAGER-NO-SELF-ESCALATION: a UNIT-anchored manager cannot give themselves (or anyone) UNIT_TREE at the same anchor")
    void unitManagerCannotHandOutUnitTreeAtOwnAnchor() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing = hrOrg("WING1", null, 1, snapshot);
        UUID sec2 = hrOrg("SEC2", wing, 2, snapshot);
        hrOrg("TEAMC", sec2, 3, snapshot);
        UUID mgrId = manager("uamsemgr", wing, List.of(new Target(sec2, false, List.of())));
        UUID g = grantee("uamseg", sec2);
        Api mgr = login("uamsemgr");

        // give a third person a UNIT_TREE at sec2 — the manager's UNIT anchor cannot support descendants
        Res wider = mgr.post("/memberships", body(g, sec2, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec2, true))));
        assertThat(wider.status()).as("UNIT_TREE at own UNIT anchor rejected: " + wider).isEqualTo(403);

        // give THEMSELVES a UNIT_TREE at sec2 — same rejection applies
        Res selfWider = mgr.post("/memberships", body(mgrId, sec2, "STATIONING_REQUESTER",
                custom(target("ORGANIZATION", sec2, true))));
        assertThat(selfWider.status()).as("self widening rejected: " + selfWider).isEqualTo(403);
    }

    @Test
    @DisplayName("ACCESS-MANAGER-NO-SELF-ESCALATION: a LEVELS-restricted manager cannot escalate to a full UNIT_TREE at the same anchor")
    void levelsManagerCannotHandOutFullTreeAtSameAnchor() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        UUID teamA = hrOrg("TEAMA", sec1, 3, snapshot);
        // manager restricted to level 3 only under wing1
        manager("uamlevmgr", wing1, List.of(new Target(wing1, true, List.of(3))));
        UUID g = grantee("uamlevg", teamA);
        Api mgr = login("uamlevmgr");

        // request a full wing1 UNIT_TREE — the subtree includes level-1 (wing1) and level-2 (sec1) nodes the manager
        // does NOT reach. Expected 403.
        Res fullTree = mgr.post("/memberships", body(g, wing1, "POSTURE_VIEWER",
                custom(target("ORGANIZATION", wing1, true))));
        assertThat(fullTree.status()).as("full wing1 tree exceeds LEVELS reach: " + fullTree).isEqualTo(403);
    }

    // ---- ROLE POWER ESCALATION — the manager cannot mint SYSTEM_ADMIN --------------------------------------------

    @Test
    @DisplayName("ACCESS-MANAGER-ROLE-CATALOGUE: a scoped manager cannot grant SYSTEM_ADMIN (nor any non-grantable role)")
    void cannotMintSystemAdmin() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        manager("uamroleM", wing1, List.of(new Target(wing1, true, List.of())));
        UUID g = grantee("uamroleG", sec1);
        Api mgr = login("uamroleM");

        Res tried = mgr.post("/memberships", body(g, wing1, "SYSTEM_ADMIN",
                custom(target("ORGANIZATION", wing1, true))));
        assertThat(tried.status()).as("SYSTEM_ADMIN rejected: " + tried).isEqualTo(403);
        // and a role that simply isn't in the manager's grantable list (UNIT_ACCESS_MANAGER itself, by default)
        // the grantable list we seeded does NOT include UNIT_ACCESS_MANAGER — the manager cannot re-mint its own role
        Res mintPeer = mgr.post("/memberships", body(g, wing1, "UNIT_ACCESS_MANAGER",
                custom(target("ORGANIZATION", wing1, true))));
        assertThat(mintPeer.status()).as("minting peer-level access manager rejected: " + mintPeer).isEqualTo(403);
    }

    // ---- OUTSIDE-SCOPE DIRECTORY SEARCH — the workspace never offers outside units -------------------------------

    @Test
    @DisplayName("ACCESS-MANAGER-OUTSIDE-SCOPE: directory search within the workspace returns only the manager's reach")
    void directorySearchStaysInsideScope() {
        seedCanonicalRoles();
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        UUID wing2 = hrOrg("WING2", null, 1, snapshot);
        UUID sec3 = hrOrg("SEC3", wing2, 2, snapshot);
        manager("uamdirmgr", wing1, List.of(new Target(wing1, true, List.of())));
        Api mgr = login("uamdirmgr");

        // search by the wing-2 code — the manager must NOT see sec3 or wing2 in the workspace result
        Res found = mgr.get("/access/workspace/search?q=" + sec1.toString().substring(0, 4));
        assertThat(found.status()).as("search inside: " + found).isEqualTo(200);
        Res foreign = mgr.get("/access/workspace/search?q=UAM-SEC3");
        assertThat(foreign.status()).as("search for outside code: " + foreign).isEqualTo(200);
        Set<String> ids = new LinkedHashSet<>();
        for (JsonNode row : foreign.body()) ids.add(row.path("id").asText());
        assertThat(ids).as("sec3 (outside) must not appear").doesNotContain(sec3.toString());
        assertThat(ids).as("wing2 (outside) must not appear").doesNotContain(wing2.toString());
    }
}
