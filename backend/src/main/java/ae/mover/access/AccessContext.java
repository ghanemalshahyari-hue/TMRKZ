package ae.mover.access;

import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import ae.mover.common.ApiException;
import ae.mover.security.Actor;

/**
 * Effective authorisation of one actor, evaluated from the database at the start of each HTTP request. Nothing is
 * cached across requests, so ending a membership or revoking a delegation takes effect on the next call.
 */
public final class AccessContext {

    private final Actor actor;
    private final List<Grant> grants;
    private final Instant at;

    public AccessContext(Actor actor, List<Grant> grants, Instant at) {
        this.actor = actor;
        this.grants = List.copyOf(grants);
        this.at = at;
    }

    public Actor actor() {
        return actor;
    }

    public UUID personId() {
        return actor.personId();
    }

    public List<Grant> grants() {
        return grants;
    }

    public Instant at() {
        return at;
    }

    public boolean has(Permission p) {
        return grants.stream().anyMatch(g -> g.has(p));
    }

    public void require(Permission p) {
        if (!has(p)) {
            throw ApiException.forbidden();
        }
    }

    /** Requires at least one of the permissions (e.g. any kind of view, or facility management, for the map). */
    public void requireAny(Permission... ps) {
        for (Permission p : ps) {
            if (has(p)) {
                return;
            }
        }
        throw ApiException.forbidden();
    }

    /** Some view of content: VIEW or VIEW_SUMMARY. Configuration rights alone never give it. */
    public boolean viewer() {
        return grants.stream().anyMatch(Grant::viewer);
    }

    public Set<Permission> permissions() {
        EnumSet<Permission> all = EnumSet.noneOf(Permission.class);
        grants.forEach(g -> all.addAll(g.permissions()));
        return all;
    }

    public boolean summaryOnly() {
        List<Grant> viewers = grants.stream().filter(Grant::viewer).toList();
        return !viewers.isEmpty() && viewers.stream().noneMatch(Grant::fullViewer);
    }

    public Optional<Grant> primaryGrant() {
        return grants.stream().filter(g -> g.delegationId() == null).findFirst().or(() -> grants.stream().findFirst());
    }

    /** View level for a request: creator → full; VIEW grant covering it → full/summary; info recipient → summary. */
    public ViewLevel viewLevel(RequestScope r) {
        if (r.createdBy().equals(actor.personId())) {
            return ViewLevel.FULL;
        }
        if ("DRAFT".equals(r.status())) {
            return ViewLevel.NONE;
        }
        ViewLevel best = ViewLevel.NONE;
        for (Grant g : grants) {
            if (!g.viewer()) {
                continue;
            }
            if (g.covers(r.relatedOrgs(), r.siteIds())) {
                if (g.fullViewer()) {
                    return ViewLevel.FULL;
                }
                best = ViewLevel.SUMMARY;
            }
        }
        if (best == ViewLevel.NONE && r.decided()) {
            boolean infoRecipient = grants.stream()
                    .anyMatch(g -> g.viewer() && g.orgId() != null && r.infoOrgs().contains(g.orgId()));
            if (infoRecipient) {
                best = ViewLevel.SUMMARY;
            }
        }
        return best;
    }

    /**
     * Grant that lets this actor decide a review task: same role, REVIEW permission (APPROVE for the final stage),
     * and a data scope that reaches the task's target organisation (or the request when the task has no target).
     * The requester is held to exactly the same rule (owner decision 2026-10-29): holding the stage's permission over
     * its scope lets them decide; the decision is then recorded as taken by the requester.
     */
    public Optional<Grant> taskGrant(String roleCode, UUID targetOrgId, RequestScope r, boolean finalStage) {
        return grants.stream()
                .filter(g -> g.roleCode().equals(roleCode))
                .filter(g -> g.has(Permission.REVIEW) && (!finalStage || g.has(Permission.APPROVE)))
                .filter(g -> targetOrgId == null
                        ? g.covers(r.relatedOrgs(), r.siteIds())
                        : g.covers(Set.of(targetOrgId), r.siteIds()))
                .findFirst();
    }

    /** Grant that lets this actor complete an execution task (role + EXECUTE + scope over the target). */
    public Optional<Grant> executionGrant(String roleCode, UUID targetOrgId, RequestScope r) {
        return grants.stream()
                .filter(g -> g.roleCode().equals(roleCode) && g.has(Permission.EXECUTE))
                .filter(g -> targetOrgId == null
                        ? g.covers(r.relatedOrgs(), r.siteIds())
                        : g.covers(Set.of(targetOrgId), r.siteIds()))
                .findFirst();
    }

    /**
     * Site visibility over the site or its administering organisation: VIEW gives FULL, VIEW_SUMMARY gives SUMMARY,
     * and MANAGE_FACILITIES gives the full facility record (registry, geometry, occupancy) within its scope.
     */
    public ViewLevel siteView(UUID siteId, Set<UUID> siteAncestry, UUID responsibleOrgId) {
        ViewLevel best = ViewLevel.NONE;
        Set<UUID> orgs = responsibleOrgId == null ? Set.of() : Set.of(responsibleOrgId);
        for (Grant g : grants) {
            if (!g.viewer() && !g.has(Permission.MANAGE_FACILITIES)) {
                continue;
            }
            if (g.covers(orgs, siteAncestry.isEmpty() ? Set.of(siteId) : siteAncestry)) {
                if (g.fullViewer() || g.has(Permission.MANAGE_FACILITIES)) {
                    return ViewLevel.FULL;
                }
                best = ViewLevel.SUMMARY;
            }
        }
        return best;
    }

    /**
     * Whether the creator may change their request now: a never-submitted draft is still being created (CREATE or
     * EDIT), a returned request is being revised (EDIT only). Either right must still cover the owner organisation.
     */
    public boolean mayModify(UUID createdBy, UUID ownerOrgId, String status) {
        if (!actor.personId().equals(createdBy)) {
            return false;
        }
        if ("DRAFT".equals(status)) {
            return canFor(Permission.CREATE, ownerOrgId) || canFor(Permission.EDIT, ownerOrgId);
        }
        return "RETURNED".equals(status) && canFor(Permission.EDIT, ownerOrgId);
    }

    /** True if some grant with the permission covers the organisation (e.g. CREATE on behalf of an organisation). */
    public boolean canFor(Permission p, UUID orgId) {
        return grants.stream().anyMatch(g -> g.has(p) && (g.isAll()
                || ("ORGANIZATION".equals(g.scope()) || "ORGANIZATION_AND_SITE".equals(g.scope()))
                && g.orgSubtree().contains(orgId)
                || "SITE".equals(g.scope()) && g.orgId().equals(orgId)));
    }
}
