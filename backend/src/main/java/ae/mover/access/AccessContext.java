package ae.mover.access;

import java.time.Instant;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import ae.mover.common.ApiException;
import ae.mover.security.Actor;

/**
 * Effective authorisation of one actor, evaluated from the database at the start of each HTTP request. Nothing is
 * cached across requests, so ending a membership or revoking a delegation takes effect on the next call.
 *
 * <p>For a person acting over HTTP the context carries a {@link Confirmer}: whenever the business-database evaluation
 * allows {@link #require}, {@link #requireAny} or {@link #canFor}, OpenFGA must allow too (ADR-018). OpenFGA can only
 * narrow a decision; if it cannot decide, the action is refused.
 */
public final class AccessContext {

    /** Second decision for actions allowed by the grants; throws when the decision service cannot answer. */
    public interface Confirmer {

        boolean anywhere(AccessContext ctx, Permission p);

        boolean forOrganization(AccessContext ctx, Permission p, UUID orgId);

        boolean everywhere(AccessContext ctx, Permission p);

        /** Refuses reading a request at this level unless OpenFGA agrees. */
        void view(AccessContext ctx, RequestScope r, ViewLevel level);

        /** Refuses a task decision or execution unless OpenFGA agrees for the task's role, actions and target. */
        void task(AccessContext ctx, String roleCode, UUID targetOrgId, RequestScope r, Permission... actions);
    }

    private final Actor actor;
    private final List<Grant> grants;
    private final Instant at;
    private final Confirmer confirmer;
    private final Map<String, Boolean> confirmed = new HashMap<>();

    public AccessContext(Actor actor, List<Grant> grants, Instant at) {
        this(actor, grants, at, null);
    }

    private AccessContext(Actor actor, List<Grant> grants, Instant at, Confirmer confirmer) {
        this.actor = actor;
        this.grants = List.copyOf(grants);
        this.at = at;
        this.confirmer = confirmer;
    }

    public AccessContext withConfirmer(Confirmer c) {
        return new AccessContext(actor, grants, at, c);
    }

    public boolean confirmed() {
        return confirmer != null;
    }

    /** Memoises second decisions for the duration of this context (one HTTP request). */
    public boolean remember(String key, java.util.function.BooleanSupplier decision) {
        Boolean known = confirmed.get(key);
        if (known == null) {
            known = decision.getAsBoolean();
            confirmed.put(key, known);
        }
        return known;
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
        if (!has(p) || confirmer != null && !confirmer.anywhere(this, p)) {
            throw ApiException.forbidden();
        }
    }

    /** Requires at least one of the permissions (e.g. any kind of view, or facility management, for the map). */
    public void requireAny(Permission... ps) {
        for (Permission p : ps) {
            if (has(p) && (confirmer == null || confirmer.anywhere(this, p))) {
                return;
            }
        }
        throw ApiException.forbidden();
    }

    /** Second decision for reading a request the grants let this actor read (no-op for background contexts). */
    public void confirmView(RequestScope r, ViewLevel level) {
        if (confirmer != null) {
            confirmer.view(this, r, level);
        }
    }

    /** Second decision for a task the grants let this actor decide or execute. */
    public void confirmTask(String roleCode, UUID targetOrgId, RequestScope r, Permission... actions) {
        if (confirmer != null) {
            confirmer.task(this, roleCode, targetOrgId, r, actions);
        }
    }

    /** The action through an explicit ALL scope (e.g. administering every facility or every access grant). */
    public boolean canEverywhere(Permission p) {
        if (grants.stream().noneMatch(g -> g.has(p) && g.isAll())) {
            return false;
        }
        return confirmer == null || confirmer.everywhere(this, p);
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
            if (g.coversRequest(r)) {
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
                        ? g.coversRequest(r)
                        : g.covers(Set.of(targetOrgId), r.siteIds(), r.resourceIds()))
                .findFirst();
    }

    /**
     * A task assigned to a person is theirs alone; a task waiting for the access manager's choice belongs to nobody until
     * then. Combined with {@link #taskGrant} / {@link #executionGrant}, which still require the role and scope.
     */
    public boolean assignedToMe(UUID assignedPersonId, boolean awaitingAssignment) {
        return !awaitingAssignment && (assignedPersonId == null || assignedPersonId.equals(actor.personId()));
    }

    /** Grant that lets this actor complete an execution task (role + EXECUTE + scope over the target). */
    public Optional<Grant> executionGrant(String roleCode, UUID targetOrgId, RequestScope r) {
        return grants.stream()
                .filter(g -> g.roleCode().equals(roleCode) && g.has(Permission.EXECUTE))
                .filter(g -> targetOrgId == null
                        ? g.coversRequest(r)
                        : g.covers(Set.of(targetOrgId), r.siteIds(), r.resourceIds()))
                .findFirst();
    }

    /**
     * Site visibility over the site or its administering organisation: VIEW gives FULL, VIEW_SUMMARY gives SUMMARY,
     * and MANAGE_FACILITIES gives the full facility record (registry, geometry, occupancy) within its scope.
     */
    public ViewLevel siteView(UUID siteId, Set<UUID> siteAncestry, UUID responsibleOrgId) {
        ViewLevel best = ViewLevel.NONE;
        for (Grant g : grants) {
            if (!g.viewer() && !g.has(Permission.MANAGE_FACILITIES)) {
                continue;
            }
            if (g.coversSite(siteId, responsibleOrgId)) {
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

    /**
     * True if some grant with the permission acts for the organisation (e.g. CREATE on its behalf): it is inside the
     * grant's organisation limit, or it is the grant's own organisation when the grant is limited by site only.
     */
    public boolean canFor(Permission p, UUID orgId) {
        if (orgId == null || grants.stream().noneMatch(g -> g.has(p) && g.actsFor(orgId))) {
            return false;
        }
        return confirmer == null || confirmer.forOrganization(this, p, orgId);
    }
}
