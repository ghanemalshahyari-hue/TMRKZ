package ae.mover.access;

import java.time.Instant;
import java.util.Set;
import java.util.UUID;

/**
 * One effective capability of a person at a point in time: a role held through a dated membership, or the same
 * role received through an active delegation (never wider than the source membership).
 */
public record Grant(
        UUID membershipId,
        UUID delegationId,
        String delegatorName,
        String roleCode,
        String roleName,
        Set<Permission> permissions,
        String scope,
        boolean summaryOnly,
        UUID orgId,
        String orgName,
        UUID siteId,
        String siteName,
        Instant validTo,
        Set<UUID> orgSubtree,
        Set<UUID> siteSubtree) {

    public boolean has(Permission p) {
        return permissions.contains(p);
    }

    public boolean isAll() {
        return "ALL".equals(scope);
    }

    /** True if this grant's data scope reaches any of the given organisations / sites. */
    public boolean covers(Set<UUID> orgIds, Set<UUID> siteIds) {
        return switch (scope) {
            case "ALL" -> true;
            case "ORGANIZATION" -> intersects(orgSubtree, orgIds);
            case "SITE" -> intersects(siteSubtree, siteIds);
            case "ORGANIZATION_AND_SITE" -> intersects(orgSubtree, orgIds) && intersects(siteSubtree, siteIds);
            default -> false;
        };
    }

    private static boolean intersects(Set<UUID> a, Set<UUID> b) {
        if (a == null || b == null || a.isEmpty() || b.isEmpty()) {
            return false;
        }
        for (UUID id : b) {
            if (a.contains(id)) {
                return true;
            }
        }
        return false;
    }
}
