package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Regression tests for the security findings of the enterprise acceptance audit (docs/audit/enterprise-launch,
 * 2 Nov 2026). Each test reproduces the exploit that worked at 6d07014 and also checks that the authorised path still
 * works, so a fix cannot pass by refusing everything. The hidden-site disclosure tests live in PlacementIT.
 */
class SecurityRemediationIT extends IntegrationTest {

    UUID root, orgA, orgA1, orgB, admin, mgr, pa1, pb;
    String viewer, mgrRole;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgA1 = org("A1", orgA);
        orgB = org("B", root);
        viewer = role("VIEWER", "ORGANIZATION", "VIEW");
        // a scoped access manager of A who may hand out the viewer role only (like ORG_ACCESS_MANAGER)
        mgrRole = role("ACCMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        jdbc.sql("update role_def set grantable_roles = string_to_array(:g, ',') where code = :c")
                .param("g", viewer).param("c", mgrRole).update();
        admin = person("admin", "SYSTEM_ADMIN", root);
        mgr = person("mgr", mgrRole, orgA);
        pa1 = person("pa1", viewer, orgA1);
        pb = person("pb", viewer, orgB);
    }

    private Map<String, Object> seat(UUID org, String position, String role) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("organizationId", org.toString());
        s.put("positionId", position + "-" + sfx);
        s.put("name", "مقعد " + position);
        s.put("roleCode", role);
        return s;
    }

    private Map<String, Object> grant(UUID person, UUID org, String role) {
        Map<String, Object> g = new LinkedHashMap<>();
        g.put("personId", person.toString());
        g.put("organizationId", org.toString());
        g.put("roleCode", role);
        return g;
    }

    @Test
    @DisplayName("P0-1: a scoped access manager cannot hand out a role through an HR position seat beyond their authority")
    void seatEscalation() {
        Api m = login("mgr");
        Res escalate = m.post("/position-seats", seat(orgA, "POS-ADMIN", "SYSTEM_ADMIN"));
        assertThat(escalate.status()).as("SYSTEM_ADMIN through a seat: " + escalate).isEqualTo(403);
        assertThat(m.post("/position-seats", seat(orgA, "POS-APR", "APPROVER")).status()).as("APPROVER (ALL scope)").isEqualTo(403);
        assertThat(m.post("/position-seats", seat(orgA, "POS-OWN", mgrRole)).status()).as("a role not grantable").isEqualTo(403);
        assertThat(m.post("/position-seats", seat(orgB, "POS-B", viewer)).status()).as("an organisation outside").isEqualTo(403);
        assertThat(jdbc.sql("select count(*) from position_seat where role_code in ('SYSTEM_ADMIN', 'APPROVER') and created_by = :p")
                .param("p", mgr).query(Integer.class).single()).isZero();
        // authorised: a grantable role inside the manager's organisation, and a global administrator
        assertThat(m.post("/position-seats", seat(orgA1, "POS-VIEW", viewer)).status()).as("grantable role in scope").isEqualTo(200);
        assertThat(login("admin").post("/position-seats", seat(root, "POS-SYS", "SYSTEM_ADMIN")).status()).as("global admin").isEqualTo(200);

        // withdrawing a seat needs the same authority: the scoped manager cannot remove an administrator seat in A
        Res adminSeatInA = login("admin").post("/position-seats", seat(orgA, "POS-SYS-A", "SYSTEM_ADMIN"));
        assertThat(adminSeatInA.status()).isEqualTo(200);
        String seatId = adminSeatInA.body().path("id").asText();
        assertThat(m.post("/position-seats/" + seatId + "/deactivate", Map.of("reason", "محاولة إزالة")).status())
                .as("withdraw a seat of a role not grantable").isEqualTo(403);
        assertThat(login("admin").post("/position-seats/" + seatId + "/deactivate", Map.of("reason", "تنظيف الاختبار")).status())
                .isEqualTo(204);
    }

    @Test
    @DisplayName("P0-1: nobody creates a seat for an HR position they hold themselves (an indirect self-grant)")
    void seatSelfGrant() {
        String position = "POS-HELD-" + sfx;
        jdbc.sql("""
                insert into affiliation(id, person_id, organization_id, position_id, position_title, valid_from)
                values (:id, :p, :o, :pos, 'منصب اختبار', '2026-01-01T00:00:00Z')""")
                .param("id", UUID.randomUUID()).param("p", admin).param("o", root).param("pos", position).update();
        Map<String, Object> own = new LinkedHashMap<>();
        own.put("organizationId", root.toString());
        own.put("positionId", position);
        own.put("name", "مقعد منصبي");
        own.put("roleCode", "APPROVER");
        assertThat(login("admin").post("/position-seats", own).status()).as("seat for the actor's own position").isEqualTo(403);
    }

    @Test
    @DisplayName("P0-2: no one grants a role to themselves, and the temporary first administrator cannot be made permanent")
    void selfGrant() {
        Api a = login("admin");
        Res self = a.post("/memberships", grant(admin, root, "SYSTEM_ADMIN"));
        assertThat(self.status()).as("self-grant: " + self).isEqualTo(403);
        assertThat(a.post("/memberships", grant(admin, root, "APPROVER")).status()).as("any role to oneself").isEqualTo(403);

        // the identity created by ops/bootstrap-admin.sh: its only grant is the 72-hour one
        UUID boot = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username, source, bootstrap) values (:id, :e, 'مدير مؤقت', :u, 'LOCAL', true)")
                .param("id", boot).param("e", "BOOTSTRAP-boot-" + sfx).param("u", "boot-" + sfx).update();
        jdbc.sql("""
                insert into membership(id, person_id, organization_id, role_code, valid_from, valid_to, follows_affiliation)
                values (:id, :p, :o, 'SYSTEM_ADMIN', now() - interval '1 hour', now() + interval '71 hours', false)""")
                .param("id", UUID.randomUUID()).param("p", boot).param("o", root).update();
        Res permanent = login("boot").post("/memberships", grant(boot, root, "SYSTEM_ADMIN"));
        assertThat(permanent.status()).as("bootstrap admin making itself permanent: " + permanent).isEqualTo(403);
        assertThat(a.post("/memberships", grant(boot, root, "SYSTEM_ADMIN")).status()).as("another admin extending the bootstrap identity")
                .isEqualTo(403);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p and valid_to is null").param("p", boot)
                .query(Integer.class).single()).isZero();

        // authorised: an administrator grants a role to someone else
        assertThat(a.post("/memberships", grant(pa1, orgA1, "APPROVER")).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("P0-4: a scoped access manager lists only people and delegations inside their authority")
    void scopedListings() {
        Api m = login("mgr");
        JsonNode people = m.get("/people?q=" + sfx + "&size=50").body();
        String listed = people.toString();
        assertThat(listed).as("own subtree").contains("pa1-" + sfx);
        assertThat(listed).as("another organisation's people").doesNotContain("pb-" + sfx).doesNotContain("admin-" + sfx);
        // neither browsing nor any search reaches outside the manager's authority (ADR-027 withdrew the name search)
        assertThat(m.get("/people?size=200").body().toString()).doesNotContain("شخص pb");
        assertThat(m.get("/people?q=pb&size=50").body().toString()).doesNotContain("شخص pb");
        JsonNode outside = m.get("/people?q=" + java.net.URLEncoder.encode("شخص pb", java.nio.charset.StandardCharsets.UTF_8) + "&size=50").body();
        assertThat(outside.toString()).as("name search outside").doesNotContain("شخص pb");
        assertThat(m.get("/people?q=pb-" + sfx).body().toString()).as("exact account").doesNotContain("شخص pb");
        // the global administrator keeps the full directory
        String all = login("admin").get("/people?q=" + sfx + "&size=50").body().toString();
        assertThat(all).contains("pa1-" + sfx).contains("pb-" + sfx);

        // a delegation between two people of B
        UUID pb2 = person("pb2", viewer, orgB);
        UUID membershipB = jdbc.sql("select id from membership where person_id = :p").param("p", pb).query(UUID.class).single();
        UUID delegation = UUID.randomUUID();
        jdbc.sql("""
                insert into delegation(id, delegator_id, delegate_id, membership_id, valid_from, valid_to, reason)
                values (:id, :a, :b, :m, now(), now() + interval '1 day', 'تفويض اختبار')""")
                .param("id", delegation).param("a", pb).param("b", pb2).param("m", membershipB).update();
        assertThat(m.get("/delegations").body().toString()).as("scoped manager of A").doesNotContain(delegation.toString());
        assertThat(login("admin").get("/delegations").body().toString()).as("global administrator").contains(delegation.toString());
        assertThat(login("pb").get("/delegations").body().toString()).as("the delegator").contains(delegation.toString());
    }
}
