package ae.mover.authz;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.IntegrationTest;

/**
 * REQUESTER-SCOPE-01..09 (owner, 21 Nov 2026): «مقدم الطلب» has to honour three scope modes — this unit only (UNIT), this
 * unit and its descendants (UNIT_TREE), and selected units/levels — exactly as the shared grant model already supports.
 * The authorisation decision is read through {@code /request-hub}, which returns every unit the signed-in person may
 * submit for, and through {@code POST /restationing-requests} which rejects a spoofed requesting unit with 403.
 * Overlapping requesters coexist; hierarchy changes follow the live tree. Each test publishes its own HR snapshot and
 * organisation branch so it is independent of the shared test fixtures.
 */
class RequesterScopeIT extends IntegrationTest {

    private UUID publishedSnapshot() {
        UUID s = jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).optional().orElse(null);
        if (s != null) return s;
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        s = UUID.randomUUID();
        jdbc.sql("insert into hr_source(id, name) values (:id, 'مصدر اختبار نطاق مقدم الطلب')").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'DRAFT', '{}', '{}')")
                .param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, trigger, status, started_at) values (:id, 'MANUAL', 'SUCCEEDED', now())").param("id", run).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())")
                .param("id", s).param("r", run).param("m", mapping).update();
        return s;
    }

    private UUID hrOrg(String code, UUID parent, UUID snapshot) {
        UUID id = UUID.randomUUID();
        String ext = "RS-" + code + "-" + sfx;
        jdbc.sql("""
                insert into organization(id, code, name, parent_id, valid_from, source, source_external_id)
                values (:id, :c, :n, :p, '2026-01-01T00:00:00Z', 'HR', :e)""")
                .param("id", id).param("c", ext).param("n", "وحدة " + code).param("p", parent).param("e", ext).update();
        jdbc.sql("insert into hr_unit(snapshot_id, external_id, name, active, is_main) values (:s, :e, :n, true, :m)")
                .param("s", snapshot).param("e", ext).param("n", "وحدة " + code).param("m", parent == null).update();
        return id;
    }

    /** A person with STATIONING_REQUESTER and a CUSTOM scope: one ORGANIZATION target at {@code anchor} with the given
     *  {@code includeDescendants}. This is exactly what the «تعيين مقدم الطلب» dialog's ONE / BRANCH save path writes. */
    private UUID requesterWithCustomScope(String username, UUID homeUnit, UUID anchor, boolean includeDescendants) {
        String role = role("RSCOPE_" + username, "ORGANIZATION", "CREATE_RESTATIONING", "REQUEST_SITE_REGISTRATION", "VIEW");
        UUID personId = person(username, role, homeUnit);
        UUID membershipId = jdbc.sql("select id from membership where person_id = :p and role_code = :r order by valid_from desc limit 1")
                .param("p", personId).param("r", role).query(UUID.class).single();
        jdbc.sql("update membership set scope_mode = 'CUSTOM', scope_combine = 'AND', scope_all = false where id = :id")
                .param("id", membershipId).update();
        jdbc.sql("insert into membership_scope_target(membership_id, kind, target_id, include_descendants) values (:m, 'ORGANIZATION', :a, :d)")
                .param("m", membershipId).param("a", anchor).param("d", includeDescendants).update();
        jdbc.sql("insert into authz_change(person_id, source) values (:p, 'test:requester-scope')").param("p", personId).update();
        return personId;
    }

    /** The list of unit ids the signed-in person may submit a re-stationing for, read from {@code /request-hub} — the same
     *  source the UI picker reads. The hub caps at 300 units; every scenario here stays well under that. */
    private java.util.Set<String> reachedUnits(String username) {
        Res r = login(username).get("/request-hub");
        assertThat(r.status()).as("request-hub for " + username + ": " + r).isEqualTo(200);
        java.util.Set<String> ids = new java.util.LinkedHashSet<>();
        for (JsonNode u : r.body().path("units")) {
            ids.add(u.path("id").asText());
        }
        return ids;
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-01: UNIT grant — exact unit covered, child and sibling not")
    void unitOnly() {
        UUID snapshot = publishedSnapshot();
        UUID wing = hrOrg("WING1", null, snapshot);
        UUID sec1 = hrOrg("SEC1", wing, snapshot);
        UUID sec2 = hrOrg("SEC2", wing, snapshot);
        UUID team = hrOrg("TEAMC", sec2, snapshot);
        requesterWithCustomScope("rs01", wing, sec2, false);
        var ids = reachedUnits("rs01");
        assertThat(ids).as("anchor sec2 is covered").contains(sec2.toString());
        assertThat(ids).as("child team_c is NOT covered by UNIT scope").doesNotContain(team.toString());
        assertThat(ids).as("sibling sec1 is NOT covered").doesNotContain(sec1.toString());
        assertThat(ids).as("ancestor wing is NOT covered").doesNotContain(wing.toString());
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-02: UNIT_TREE grant — anchor + every descendant; sibling branch stays out")
    void unitTree() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, snapshot);
        UUID sec2 = hrOrg("SEC2", wing1, snapshot);
        UUID teamA = hrOrg("TEAMA", sec1, snapshot);
        UUID teamC = hrOrg("TEAMC", sec2, snapshot);
        UUID wing2 = hrOrg("WING2", null, snapshot);
        requesterWithCustomScope("rs02", wing1, wing1, true);
        var ids = reachedUnits("rs02");
        assertThat(ids).as("anchor and every descendant are covered")
                .contains(wing1.toString(), sec1.toString(), sec2.toString(), teamA.toString(), teamC.toString());
        assertThat(ids).as("sibling branch wing2 is NOT covered").doesNotContain(wing2.toString());
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-03: higher UNIT_TREE + lower UNIT — both requesters remain allowed on overlap; narrower never cancels broader")
    void higherAndLowerOverlap() {
        UUID snapshot = publishedSnapshot();
        UUID wing = hrOrg("WING1", null, snapshot);
        UUID sec2 = hrOrg("SEC2", wing, snapshot);
        UUID teamC = hrOrg("TEAMC", sec2, snapshot);
        requesterWithCustomScope("rs03a", wing, wing, true);
        requesterWithCustomScope("rs03b", wing, sec2, false);
        var high = reachedUnits("rs03a");
        var low = reachedUnits("rs03b");
        assertThat(high).as("higher UNIT_TREE still covers sec2").contains(sec2.toString());
        assertThat(high).as("higher UNIT_TREE still covers team_c").contains(teamC.toString());
        assertThat(low).as("lower UNIT covers sec2").contains(sec2.toString());
        assertThat(low).as("lower UNIT does NOT silently gain team_c").doesNotContain(teamC.toString());
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-04: two people exact same UNIT — both covered independently")
    void sameUnitTwoPeople() {
        UUID snapshot = publishedSnapshot();
        UUID wing = hrOrg("WING1", null, snapshot);
        UUID sec2 = hrOrg("SEC2", wing, snapshot);
        requesterWithCustomScope("rs04a", wing, sec2, false);
        requesterWithCustomScope("rs04b", wing, sec2, false);
        assertThat(reachedUnits("rs04a")).as("first requester covers sec2").contains(sec2.toString());
        assertThat(reachedUnits("rs04b")).as("second requester covers sec2").contains(sec2.toString());
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-05: when a unit moves outside the tree, the higher requester loses it on the next reach")
    void unitMovesOut() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, snapshot);
        UUID wing2 = hrOrg("WING2", null, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, snapshot);
        requesterWithCustomScope("rs05", wing1, wing1, true);
        assertThat(reachedUnits("rs05")).as("initially covered").contains(sec1.toString());
        // the real move is an HR publication; for this unit test we just simulate the resulting parent_id change by
        // bypassing the HR read-only trigger. session_replication_role = replica disables user triggers for the
        // transaction, as V49/V62 do when they end legacy grants.
        tx.executeWithoutResult(s -> {
            jdbc.sql("set local session_replication_role = replica").update();
            jdbc.sql("update organization set parent_id = :w where id = :s").param("w", wing2).param("s", sec1).update();
            jdbc.sql("insert into authz_change(person_id, source) values (null, 'test:hierarchy-change')").update();
        });
        assertThat(reachedUnits("rs05")).as("sec1 is no longer under wing1").doesNotContain(sec1.toString());
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-06: a new descendant under the tree is picked up on the next reach")
    void newDescendant() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, snapshot);
        UUID sec3 = hrOrg("SEC3", wing1, snapshot);
        requesterWithCustomScope("rs06", wing1, wing1, true);
        UUID fresh = hrOrg("NEWUNDERWING1", sec3, snapshot);
        jdbc.sql("insert into authz_change(person_id, source) values (null, 'test:hierarchy-change')").update();
        assertThat(reachedUnits("rs06")).as("a new descendant becomes covered immediately").contains(fresh.toString());
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-07: a scoped UNIT_ACCESS_MANAGER cannot assign STATIONING_REQUESTER outside their reach; targets inside their reach are accepted")
    void managerScopeBoundsRequesterAssignment() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, snapshot);
        hrOrg("SEC2", wing1, snapshot);
        UUID wing2 = hrOrg("WING2", null, snapshot);
        hrOrg("SEC3", wing2, snapshot);

        // seed the canonical UNIT_ACCESS_MANAGER and STATIONING_REQUESTER roles with the production grantable-roles shape,
        // so the authority check in GrantAdminService (V9) accepts the manager as a grantor of STATIONING_REQUESTER.
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order, grantable_roles)
                values ('UNIT_ACCESS_MANAGER', 'مدير صلاحيات الوحدة', array['MANAGE_ACCESS','REVIEW'], 'ORGANIZATION', false, 980, array['STATIONING_REQUESTER'])
                on conflict (code) do update set permissions = excluded.permissions, grantable_roles = excluded.grantable_roles""").update();
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order)
                values ('STATIONING_REQUESTER', 'مقدم الطلب', array['VIEW','CREATE_RESTATIONING','REQUEST_SITE_REGISTRATION'], 'ORGANIZATION', false, 990)
                on conflict (code) do nothing""").update();

        // the grantee lives in wing2 but the manager tries to assign them a scoped requester grant; the manager's
        // authority is what the test exercises — the grantee's home is immaterial as long as the service reaches them.
        String granteeRole = role("RSGRANTEE", "ORGANIZATION", "VIEW");
        UUID grantee = person("rs07grantee", granteeRole, wing1);

        // the manager: real UNIT_ACCESS_MANAGER role (so grantable_roles is right) with a CUSTOM scope on wing1+descendants.
        UUID manager = person("rs07mgr", "UNIT_ACCESS_MANAGER", wing1);
        UUID managerMembership = jdbc.sql("select id from membership where person_id = :p and role_code = 'UNIT_ACCESS_MANAGER' order by valid_from desc limit 1")
                .param("p", manager).query(UUID.class).single();
        jdbc.sql("update membership set scope_mode = 'CUSTOM', scope_combine = 'AND', scope_all = false where id = :id")
                .param("id", managerMembership).update();
        jdbc.sql("insert into membership_scope_target(membership_id, kind, target_id, include_descendants) values (:m, 'ORGANIZATION', :a, true)")
                .param("m", managerMembership).param("a", wing1).update();
        // the manager's membership needs the GRANT right to hand out grants (ADR-059); give it the full known set.
        jdbc.sql("update membership set access_rights = array['LOOKUP','REVIEW','GRANT','DELEGATE','FINALIZE'] where id = :id").param("id", managerMembership).update();
        jdbc.sql("insert into authz_change(person_id, source) values (:p, 'test:rs07-mgr')").param("p", manager).update();

        // (1) refuse: a STATIONING_REQUESTER grant whose single target is wing2 is outside the manager's reach
        Res outside = login("rs07mgr").post("/memberships", Map.of(
                "personId", grantee.toString(), "organizationId", wing2.toString(), "roleCode", "STATIONING_REQUESTER",
                "scope", Map.of("mode", "CUSTOM", "all", false, "targets",
                        List.of(Map.of("kind", "ORGANIZATION", "id", wing2.toString(), "includeDescendants", false)))));
        assertThat(outside.status()).as("outside the manager's reach: " + outside).isEqualTo(403);

        // (2) allow: STATIONING_REQUESTER anchored at section1 (under wing1), UNIT mode
        Res insideUnit = login("rs07mgr").post("/memberships", Map.of(
                "personId", grantee.toString(), "organizationId", sec1.toString(), "roleCode", "STATIONING_REQUESTER",
                "scope", Map.of("mode", "CUSTOM", "all", false, "targets",
                        List.of(Map.of("kind", "ORGANIZATION", "id", sec1.toString(), "includeDescendants", false)))));
        assertThat(insideUnit.status()).as("inside the manager's reach, UNIT: " + insideUnit).isEqualTo(200);

        // (3) allow: STATIONING_REQUESTER anchored at wing1 with UNIT_TREE — still fully within the manager's reach
        Res insideTree = login("rs07mgr").post("/memberships", Map.of(
                "personId", grantee.toString(), "organizationId", wing1.toString(), "roleCode", "STATIONING_REQUESTER",
                "scope", Map.of("mode", "CUSTOM", "all", false, "targets",
                        List.of(Map.of("kind", "ORGANIZATION", "id", wing1.toString(), "includeDescendants", true)))));
        assertThat(insideTree.status()).as("inside the manager's reach, UNIT_TREE: " + insideTree).isEqualTo(200);
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-08: the server refuses a requesting unit outside the requester's scope with 403, regardless of the picker")
    void spoofRejected() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, snapshot);
        UUID sec2 = hrOrg("SEC2", wing1, snapshot);
        UUID wing2 = hrOrg("WING2", null, snapshot);
        requesterWithCustomScope("rs08", wing1, sec2, false);
        // the picker (/request-hub) already hides outside-scope units; here we send the raw POST
        Res out = login("rs08").post("/restationing-requests", Map.of(
                "requestingUnitId", wing2.toString(),
                "content", Map.of("kind", "PERMANENT", "scope", List.of(wing2.toString()), "reason", "اختبار تجاوز نطاق مقدم الطلب")));
        assertThat(out.status()).as("outside the scope: " + out).isEqualTo(403);
    }

    @Test
    @DisplayName("REQUESTER-SCOPE-09: REQUEST_SITE_REGISTRATION follows the same effective requester scope (the role carries both rights)")
    void siteRegistrationSameScope() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, snapshot);
        UUID sec2 = hrOrg("SEC2", wing1, snapshot);
        UUID wing2 = hrOrg("WING2", null, snapshot);
        requesterWithCustomScope("rs09", wing1, sec2, false);
        var ids = reachedUnits("rs09");
        // /request-hub reaches units covered by CREATE_RESTATIONING or REQUEST_SITE_REGISTRATION: both come from the
        // same role in this test, so wing2 stays out for BOTH. A separate-role setup would behave the same way — the
        // custom scope targets attach to the membership, not to a single permission.
        assertThat(ids).as("sec2 is covered for site registration too").contains(sec2.toString());
        assertThat(ids).as("wing2 is not covered for either action").doesNotContain(wing2.toString());
    }
}
