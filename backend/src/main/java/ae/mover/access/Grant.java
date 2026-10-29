package ae.mover.access;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * One effective capability of a person at a point in time: a role held through a dated membership, a delegation of
 * one (never wider than the source membership), or a responsibility seat. The scope is resolved to explicit sets:
 *
 * <ul>
 *   <li>{@code orgScope}: organisations reached (targets, with descendants where chosen); null = no organisation limit;</li>
 *   <li>{@code siteScope}: sites reached; null = no site limit; {@code resources}/{@code resourceSites}: resource targets
 *       and the sites that hold them;</li>
 *   <li>with both limits, {@code andCombine} intersects them (default) or unites them (explicit OR policy).</li>
 * </ul>
 *
 * A grant never borrows scope from another grant: every check below is evaluated within one grant.
 */
public record Grant(
        UUID grantId,
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
        boolean all,
        boolean andCombine,
        Set<UUID> orgScope,
        Set<UUID> siteScope,
        Set<UUID> resources,
        Set<UUID> resourceSites,
        List<GrantTarget> targets) {

    public boolean has(Permission p) {
        return permissions.contains(p);
    }

    /** Grants some view of request and site content (full or summary). */
    public boolean viewer() {
        return permissions.contains(Permission.VIEW) || permissions.contains(Permission.VIEW_SUMMARY);
    }

    /** Full view: VIEW without the legacy summary-only role flag. */
    public boolean fullViewer() {
        return permissions.contains(Permission.VIEW) && !summaryOnly;
    }

    public boolean isAll() {
        return all;
    }

    /** Organisations reached by the organisation limit (empty when the grant has none). */
    public Set<UUID> orgSubtree() {
        return orgScope == null ? Set.of() : orgScope;
    }

    /** Sites reached by the site limit (empty when the grant has none). */
    public Set<UUID> siteSubtree() {
        return siteScope == null ? Set.of() : siteScope;
    }

    public boolean hasOrgLimit() {
        return orgScope != null;
    }

    public boolean hasSiteLimit() {
        return siteScope != null;
    }

    /** True if this grant reaches a request (or a hypothetical one) relating to these organisations, sites, resources. */
    public boolean covers(Set<UUID> orgIds, Set<UUID> siteIds, Set<UUID> resourceIds) {
        if (all) {
            return true;
        }
        boolean org = orgScope != null && intersects(orgScope, orgIds);
        boolean site = siteScope != null && (intersects(siteScope, siteIds) || intersects(resources, resourceIds));
        return combine(org, site);
    }

    /** {@link #covers(Set, Set, Set)} without resources (organisation and site relations only). */
    public boolean covers(Set<UUID> orgIds, Set<UUID> siteIds) {
        return covers(orgIds, siteIds, Set.of());
    }

    public boolean coversRequest(RequestScope r) {
        return covers(r.relatedOrgs(), r.siteIds(), r.resourceIds());
    }

    /**
     * Site-level reach (the site record, its geometry and occupancy): through the site limit, the organisation that
     * administers the site, or a resource target located at the site.
     */
    public boolean coversSite(UUID siteId, UUID responsibleOrg) {
        if (all) {
            return true;
        }
        boolean org = orgScope != null && responsibleOrg != null && orgScope.contains(responsibleOrg);
        boolean site = siteScope != null && (siteScope.contains(siteId) || resourceSites.contains(siteId));
        return combine(org, site);
    }

    /** Acting for an organisation (create on its behalf, administer its access or facilities): the site limit is not applied. */
    public boolean actsFor(UUID orgId) {
        return all || (orgScope != null ? orgScope.contains(orgId) : orgId.equals(this.orgId));
    }

    private boolean combine(boolean org, boolean site) {
        if (orgScope != null && siteScope != null) {
            return andCombine ? org && site : org || site;
        }
        return orgScope != null ? org : site;
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
