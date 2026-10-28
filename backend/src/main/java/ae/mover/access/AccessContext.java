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

    public Set<Permission> permissions() {
        EnumSet<Permission> all = EnumSet.noneOf(Permission.class);
        grants.forEach(g -> all.addAll(g.permissions()));
        return all;
    }

    public boolean summaryOnly() {
        List<Grant> viewers = grants.stream().filter(g -> g.has(Permission.VIEW)).toList();
        return !viewers.isEmpty() && viewers.stream().allMatch(Grant::summaryOnly);
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
            if (!g.has(Permission.VIEW)) {
                continue;
            }
            if (g.covers(r.relatedOrgs(), r.siteIds())) {
                if (!g.summaryOnly()) {
                    return ViewLevel.FULL;
                }
                best = ViewLevel.SUMMARY;
            }
        }
        if (best == ViewLevel.NONE && r.decided()) {
            boolean infoRecipient = grants.stream()
                    .anyMatch(g -> g.has(Permission.VIEW) && g.orgId() != null && r.infoOrgs().contains(g.orgId()));
            if (infoRecipient) {
                best = ViewLevel.SUMMARY;
            }
        }
        return best;
    }

    /**
     * Grant that lets this actor decide a review task: same role, REVIEW permission (APPROVE for the final stage),
     * and a data scope that reaches the task's target organisation (or the request when the task has no target).
     */
    public Optional<Grant> taskGrant(String roleCode, UUID targetOrgId, RequestScope r, boolean finalStage) {
        if (r.createdBy().equals(actor.personId())) {
            return Optional.empty(); // separation of duties: never decide on one's own request
        }
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

    /** Site visibility: FULL/SUMMARY according to VIEW grants over the site or its administering organisation. */
    public ViewLevel siteView(UUID siteId, Set<UUID> siteAncestry, UUID responsibleOrgId) {
        ViewLevel best = ViewLevel.NONE;
        Set<UUID> orgs = responsibleOrgId == null ? Set.of() : Set.of(responsibleOrgId);
        for (Grant g : grants) {
            if (!g.has(Permission.VIEW)) {
                continue;
            }
            if (g.covers(orgs, siteAncestry.isEmpty() ? Set.of(siteId) : siteAncestry)) {
                if (!g.summaryOnly()) {
                    return ViewLevel.FULL;
                }
                best = ViewLevel.SUMMARY;
            }
        }
        return best;
    }

    /** True if some grant with the permission covers the organisation (e.g. CREATE on behalf of an organisation). */
    public boolean canFor(Permission p, UUID orgId) {
        return grants.stream().anyMatch(g -> g.has(p) && (g.isAll()
                || ("ORGANIZATION".equals(g.scope()) || "ORGANIZATION_AND_SITE".equals(g.scope()))
                && g.orgSubtree().contains(orgId)
                || "SITE".equals(g.scope()) && g.orgId().equals(orgId)));
    }
}
