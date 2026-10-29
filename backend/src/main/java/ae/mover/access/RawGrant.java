package ae.mover.access;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * A grant as stored: a dated membership, a delegation of one, or a responsibility seat followed by the current holder
 * of an HR position. Both the in-process evaluation ({@link AccessService}) and the OpenFGA tuples
 * ({@code ae.mover.authz.AuthzTuples}) are derived from this one record, so the two cannot read grants differently.
 *
 * @param grantId     identity of the grant as an OpenFGA object: membership id, delegation id, or a stable id per
 *                    (seat, holder)
 * @param roleScope   the role's scope, applied to the home organisation / site when {@code scopeMode} is ROLE
 * @param scopeMode   ROLE or CUSTOM (explicit {@code targets}, {@code andCombine}, {@code scopeAll})
 */
public record RawGrant(
        UUID grantId,
        UUID personId,
        UUID membershipId,
        UUID delegationId,
        String delegatorName,
        String roleCode,
        String roleName,
        Set<Permission> permissions,
        String roleScope,
        boolean summaryOnly,
        UUID orgId,
        String orgName,
        UUID siteId,
        String siteName,
        String scopeMode,
        boolean andCombine,
        boolean scopeAll,
        Instant validFrom,
        Instant validTo,
        List<GrantTarget> targets) {

    /** The grant's scope resolved to explicit targets; legacy role scopes become the equivalent targets. */
    public Spec spec() {
        if ("CUSTOM".equals(scopeMode)) {
            if (scopeAll) {
                return new Spec(true, true, List.of(), List.of(), List.of(), false, false);
            }
            List<GrantTarget> orgs = new ArrayList<>();
            List<GrantTarget> sites = new ArrayList<>();
            List<UUID> resources = new ArrayList<>();
            for (GrantTarget t : targets) {
                switch (t.kind()) {
                    case GrantTarget.ORGANIZATION -> orgs.add(t);
                    case GrantTarget.SITE -> sites.add(t);
                    default -> resources.add(t.id());
                }
            }
            return new Spec(false, andCombine, orgs, sites, resources, !orgs.isEmpty(), !sites.isEmpty() || !resources.isEmpty());
        }
        return switch (roleScope) {
            case "ALL" -> new Spec(true, true, List.of(), List.of(), List.of(), false, false);
            case "ORGANIZATION" -> new Spec(false, true, List.of(new GrantTarget(GrantTarget.ORGANIZATION, orgId, true)),
                    List.of(), List.of(), true, false);
            case "SITE" -> new Spec(false, true, List.of(),
                    siteId == null ? List.of() : List.of(new GrantTarget(GrantTarget.SITE, siteId, true)), List.of(), false, true);
            case "ORGANIZATION_AND_SITE" -> new Spec(false, true, List.of(new GrantTarget(GrantTarget.ORGANIZATION, orgId, true)),
                    siteId == null ? List.of() : List.of(new GrantTarget(GrantTarget.SITE, siteId, true)), List.of(), true, true);
            default -> new Spec(false, true, List.of(), List.of(), List.of(), false, false);
        };
    }

    /** Actions as decided: a summary-only role's VIEW is VIEW_SUMMARY. */
    public Set<Permission> effectivePermissions() {
        if (!summaryOnly || !permissions.contains(Permission.VIEW)) {
            return permissions;
        }
        java.util.EnumSet<Permission> out = java.util.EnumSet.copyOf(permissions);
        out.remove(Permission.VIEW);
        out.add(Permission.VIEW_SUMMARY);
        return out;
    }

    /**
     * Resolved scope. {@code orgConstraint}/{@code siteConstraint} say whether the grant limits by organisation and by
     * site or resource; a constraint can be present with no targets (a site-scoped role without a site), which then
     * matches nothing. With both constraints, {@code and} intersects them (default) or unites them (explicit OR).
     */
    public record Spec(boolean all, boolean and, List<GrantTarget> orgs, List<GrantTarget> sites, List<UUID> resources,
                       boolean orgConstraint, boolean siteConstraint) {

        /** The site side is checked as a condition of the grant rather than placed on site objects. */
        public boolean siteLimited() {
            return siteConstraint && (and || !orgConstraint);
        }
    }
}
