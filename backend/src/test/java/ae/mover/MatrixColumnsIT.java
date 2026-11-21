package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Current invariant (ADR-095, updated from ADR-094 §22): the unit access matrix must expose EXACTLY the 8
 * canonical roles the owner approved, in this order:
 * <ol>
 *     <li>STATIONING_REQUESTER</li>
 *     <li>CHAIN_APPROVER</li>
 *     <li>UNIT_OPERATIONS_APPROVER</li>
 *     <li>FINAL_APPROVER</li>
 *     <li>FYI_RECEIVER</li>
 *     <li>POSTURE_VIEWER</li>
 *     <li>UNIT_ACCESS_MANAGER</li>
 *     <li>ACCESS_FINAL_APPROVER</li>
 * </ol>
 *
 * This test exists to prevent the obsolete stationing roles (RESTATIONING_REQUESTER,
 * STATIONING_REGISTER_OFFICER, STATIONING_UNIT_APPROVER, STATIONING_OPS_APPROVER, STATIONING_FINAL_APPROVER,
 * DEPLOYMENT_REQUESTER, SITE_REGISTRATION_REQUESTER, SITE_LINK_MANAGER, STATIONING_ACTIVATOR_NEXT,
 * FYI_DISTRIBUTOR, STATIONING_ACTIVATOR) from ever creeping back into the matrix — by code, by a restored
 * policy version or by a seed.
 */
@TestPropertySource(properties = {
        // Mirror production — the legacy MOVER facility roles are off. The base IntegrationTest turns them on
        // for tests that exercise the facilities reservation engine; those roles are not banned by ADR-094/095,
        // but they ARE additional matrix columns in the test env that would make the brief's "exactly 8"
        // invariant fail even though production has exactly 8. This override gives the matrix the production
        // shape for this one test.
        "tmrkz.access.legacy-facility-roles=false"})
class MatrixColumnsIT extends IntegrationTest {

    private static final List<String> CANONICAL = List.of(
            "STATIONING_REQUESTER",
            "CHAIN_APPROVER",
            "UNIT_OPERATIONS_APPROVER",
            "FINAL_APPROVER",
            "FYI_RECEIVER",
            "POSTURE_VIEWER",
            "UNIT_ACCESS_MANAGER",
            "ACCESS_FINAL_APPROVER");

    private static final List<String> BANNED = List.of(
            "RESTATIONING_REQUESTER",
            "STATIONING_REGISTER_OFFICER",
            "STATIONING_UNIT_APPROVER",
            "STATIONING_OPS_APPROVER",
            "STATIONING_FINAL_APPROVER",
            "DEPLOYMENT_REQUESTER",
            "SITE_REGISTRATION_REQUESTER",
            "SITE_LINK_MANAGER",
            "STATIONING_ACTIVATOR_NEXT",
            "FYI_DISTRIBUTOR",
            "STATIONING_ACTIVATOR");

    @Test
    @DisplayName("The unit access matrix exposes exactly the 8 canonical roles, in order; no banned code can appear")
    void exactly8Columns() {
        // Seed the 8 canonical roles so the matrix has something to list even in a bare test fixture.
        // In production they are seeded via ops/test-env/owner-review-seed.sql / Bootstrap on install; here we
        // make the test self-contained.
        for (int i = 0; i < CANONICAL.size(); i++) {
            String code = CANONICAL.get(i);
            String permissions = switch (code) {
                case "STATIONING_REQUESTER" -> "VIEW,CREATE_RESTATIONING,REQUEST_SITE_REGISTRATION";
                case "CHAIN_APPROVER" -> "VIEW,APPROVE_HIERARCHY";
                case "UNIT_OPERATIONS_APPROVER" -> "VIEW,DECIDE_UNIT_OPERATIONS,MANAGE_FACILITIES,MANAGE_SITE_LINKS";
                case "FINAL_APPROVER" -> "VIEW,FINAL_APPROVE_STATIONING";
                case "FYI_RECEIVER" -> "VIEW";
                case "POSTURE_VIEWER" -> "VIEW_OPERATIONAL_POSTURE";
                case "UNIT_ACCESS_MANAGER" -> "MANAGE_ACCESS,REVIEW";
                case "ACCESS_FINAL_APPROVER" -> "REVIEW,APPROVE";
                default -> throw new IllegalStateException(code);
            };
            String scope = "ACCESS_FINAL_APPROVER".equals(code) ? "ALL" : "ORGANIZATION";
            jdbc.sql("""
                    insert into role_def(code, name, permissions, scope, summary_only, system, sort_order, grantable_roles)
                    values (:c, :n, string_to_array(:p, ','), :s, false, false, :o, '{}')
                    on conflict (code) do update set permissions = excluded.permissions, scope = excluded.scope,
                                                     sort_order = excluded.sort_order, summary_only = excluded.summary_only""")
                    .param("c", code).param("n", code).param("p", permissions).param("s", scope).param("o", 100 + i).update();
        }

        UUID org = org("MATRIX", null);
        UUID person = person("matrix-mgr", "UNIT_ACCESS_MANAGER", org);
        jdbc.sql("""
                insert into unit_member(id, person_id, organization_id, added_by, added_at)
                values (gen_random_uuid(), :p, :o, :p, now())
                on conflict do nothing""").param("p", person).param("o", org).update();

        Api api = login("matrix-mgr");
        Res r = api.get("/access/workspace/units/" + org + "/matrix");
        assertThat(r.status()).as("manager can read their unit's matrix").isEqualTo(200);
        JsonNode cols = r.body().path("columns");
        assertThat(cols.isArray()).as("matrix returns a columns array").isTrue();

        List<String> codes = new ArrayList<>();
        for (JsonNode c : cols) codes.add(c.path("code").asText());

        // Exactly the 8 canonical codes, in order.
        assertThat(codes).as("matrix exposes exactly the 8 canonical roles in the brief's order (ADR-095)").isEqualTo(CANONICAL);

        // No banned code may appear anywhere in the response.
        for (String banned : BANNED) {
            assertThat(codes).as("banned role code must not appear as a matrix column: " + banned).doesNotContain(banned);
        }
    }

    @Test
    @DisplayName("role_def must not contain any banned obsolete stationing role code (ADR-095)")
    void noBannedRolesInRoleDef() {
        for (String banned : BANNED) {
            Long count = jdbc.sql("select count(*) from role_def where code = :c")
                    .param("c", banned).query(Long.class).single();
            assertThat(count).as("role_def row for banned code should not exist: " + banned).isZero();
        }
    }
}
