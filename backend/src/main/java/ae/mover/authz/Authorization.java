package ae.mover.authz;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.access.RequestScope;
import ae.mover.access.ViewLevel;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;

/**
 * OpenFGA as the second decider (ADR-018). Every action the grants allow for a person acting over HTTP is checked
 * again in OpenFGA with the pinned model at higher consistency. Before the first check of a request, changes that
 * concern the actor are applied; if they cannot be applied, or OpenFGA does not answer, the action is refused —
 * there is no path that allows when the decision service is unavailable.
 */
@Component
public class Authorization implements AccessContext.Confirmer {

    private static final Logger log = LoggerFactory.getLogger(Authorization.class);
    private static final int MAX_CONTEXTUAL = 100;

    private final AuthzSync sync;
    private final FgaClient fga;
    private final JdbcClient jdbc;

    public Authorization(AuthzSync sync, FgaClient fga, JdbcClient jdbc) {
        this.sync = sync;
        this.fga = fga;
        this.jdbc = jdbc;
    }

    public static ApiException unavailable() {
        return new ApiException(ErrorCode.AUTHZ_UNAVAILABLE,
                "خدمة قرارات الصلاحيات غير متاحة حالياً، ولم يُنفذ الإجراء. أعد المحاولة لاحقاً أو أبلغ مدير النظام.");
    }

    public static ApiException syncPending() {
        return new ApiException(ErrorCode.AUTHZ_SYNC_PENDING,
                "تحديث صلاحياتك لم يكتمل بعد في خدمة القرارات، ولم يُنفذ الإجراء. أعد المحاولة بعد لحظات.");
    }

    private static ApiException refused() {
        return ApiException.forbidden("رفضت خدمة قرارات الصلاحيات هذا الإجراء.");
    }

    // ---- Confirmer (require / requireAny / canFor) ----------------------------------------------------------------

    @Override
    public boolean anywhere(AccessContext ctx, Permission p) {
        // "held somewhere": the grant's validity and role apply, its scope limits do not (no target is involved)
        return ctx.remember("any:" + p, () -> decide(ctx, AuthzModel.SYSTEM, AuthzModel.rel(p) + "_any", List.of(), unscoped(ctx)));
    }

    @Override
    public boolean forOrganization(AccessContext ctx, Permission p, UUID orgId) {
        return ctx.remember("org:" + p + ":" + orgId, () -> {
            Map<String, Object> c = base(ctx);
            c.put("org_level", true);
            String object = "organization:" + orgId;
            return decide(ctx, object, AuthzModel.rel(p), List.of(systemOf(object)), c);
        });
    }

    /** Explicit ALL scope for the action. */
    @Override
    public boolean everywhere(AccessContext ctx, Permission p) {
        return ctx.remember("all:" + p, () -> decide(ctx, AuthzModel.SYSTEM, AuthzModel.rel(p), List.of(), unscoped(ctx)));
    }

    // ---- targeted confirmations -----------------------------------------------------------------------------------

    /** The site record (and its geometry) for an action allowed on it by the grants. */
    public void confirmSite(AccessContext ctx, Permission p, UUID siteId) {
        if (!ctx.confirmed()) {
            return;
        }
        boolean ok = ctx.remember("site:" + p + ":" + siteId, () -> {
            Map<String, Object> c = base(ctx);
            c.put("site_check", true);
            c.put("target_sites", List.of(siteId.toString()));
            c.put("target_site_path", sitePath(Set.of(siteId)));
            String object = "site:" + siteId;
            return decide(ctx, object, AuthzModel.rel(p), List.of(systemOf(object)), c);
        });
        if (!ok) {
            throw refused();
        }
    }

    /** Reading a request at the level the grants gave (full, or summary including information copies). */
    @Override
    public void view(AccessContext ctx, RequestScope r, ViewLevel level) {
        if (!ctx.confirmed() || level == ViewLevel.NONE) {
            return;
        }
        boolean ok = ctx.remember("view:" + level + ":" + r.requestId(), () -> {
            if (level == ViewLevel.FULL) {
                return checkRequest(ctx, r, null, "view_full", "");
            }
            if (checkRequest(ctx, r, null, "view_any", "")) {
                return true;
            }
            if (!r.decided() || r.infoOrgs().isEmpty()) {
                return false;
            }
            Map<String, Object> c = base(ctx);
            c.put("org_level", true);
            String object = "request:" + r.requestId();
            List<FgaClient.Tuple> tuples = new ArrayList<>();
            r.infoOrgs().forEach(o -> tuples.add(new FgaClient.Tuple(object, "info_org", "organization:" + o, null)));
            return decide(ctx, object, "info_view", tuples, c);
        });
        if (!ok) {
            throw refused();
        }
    }

    /** An action on a request (export, attachment, ...) through the request's relations. */
    public void confirmRequest(AccessContext ctx, Permission p, RequestScope r) {
        if (!ctx.confirmed()) {
            return;
        }
        if (!ctx.remember("req:" + p + ":" + r.requestId(), () -> checkRequest(ctx, r, null, AuthzModel.rel(p), ""))) {
            throw refused();
        }
    }

    /** A task decision or execution: the role of the task, each action, and the task's target organisation. */
    @Override
    public void task(AccessContext ctx, String roleCode, UUID targetOrgId, RequestScope r, Permission... actions) {
        if (!ctx.confirmed()) {
            return;
        }
        for (Permission p : actions) {
            String relation = AuthzModel.rel(p) + (targetOrgId == null ? "" : "_task");
            boolean ok = ctx.remember("task:" + p + ":" + roleCode + ":" + targetOrgId + ":" + r.requestId(),
                    () -> checkRequest(ctx, r, targetOrgId, relation, roleCode));
            if (!ok) {
                throw refused();
            }
        }
    }

    private boolean checkRequest(AccessContext ctx, RequestScope r, UUID targetOrgId, String relation, String role) {
        String object = "request:" + r.requestId();
        List<FgaClient.Tuple> tuples = new ArrayList<>();
        tuples.add(new FgaClient.Tuple(object, "creator", "user:" + r.createdBy(), null));
        Map<String, Object> c = base(ctx);
        c.put("required_role", role == null ? "" : role);
        if (!"DRAFT".equals(r.status())) {
            Set<UUID> orgs = targetOrgId == null ? r.relatedOrgs() : Set.of(targetOrgId);
            orgs.stream().filter(java.util.Objects::nonNull)
                    .forEach(o -> tuples.add(new FgaClient.Tuple(object, "related_org", "organization:" + o, null)));
            r.siteIds().forEach(s -> tuples.add(new FgaClient.Tuple(object, "site", "site:" + s, null)));
            r.resourceIds().forEach(x -> tuples.add(new FgaClient.Tuple(object, "resource", "resource:" + x, null)));
            tuples.add(systemOf(object));
            c.put("target_sites", r.siteIds().stream().map(UUID::toString).toList());
            c.put("target_site_path", sitePath(r.siteIds()));
            c.put("target_resources", r.resourceIds().stream().map(UUID::toString).toList());
        }
        return decide(ctx, object, relation, tuples, c);
    }

    // ---- previews (studio): a person's verdict without refusing --------------------------------------------------

    /** OpenFGA's answer for another person (preview), or null if it cannot answer. */
    public Boolean preview(UUID personId, java.time.Instant at, Permission p, UUID orgId, UUID siteId, UUID resourceId,
                           UUID responsibleOrg) {
        try {
            Map<String, Object> c = new LinkedHashMap<>(baseAt(at));
            String user = "user:" + personId;
            if (siteId == null && resourceId == null) {
                c.put("org_level", true);
                if (orgId == null) {
                    return check(user, AuthzModel.SYSTEM, AuthzModel.rel(p) + "_any", List.of(), c);
                }
                String object = "organization:" + orgId;
                return check(user, object, AuthzModel.rel(p), List.of(systemOf(object)), c);
            }
            String object = "request:preview-" + UUID.randomUUID();
            List<FgaClient.Tuple> tuples = new ArrayList<>();
            Set<UUID> orgs = new LinkedHashSet<>();
            if (orgId != null) {
                orgs.add(orgId);
            }
            if (responsibleOrg != null) {
                orgs.add(responsibleOrg);
            }
            orgs.forEach(o -> tuples.add(new FgaClient.Tuple(object, "related_org", "organization:" + o, null)));
            if (siteId != null) {
                tuples.add(new FgaClient.Tuple(object, "site", "site:" + siteId, null));
                c.put("target_sites", List.of(siteId.toString()));
                c.put("target_site_path", sitePath(Set.of(siteId)));
            }
            if (resourceId != null) {
                tuples.add(new FgaClient.Tuple(object, "resource", "resource:" + resourceId, null));
                c.put("target_resources", List.of(resourceId.toString()));
            }
            tuples.add(systemOf(object));
            return check(user, object, AuthzModel.rel(p), tuples, c);
        } catch (FgaClient.FgaException | ApiException e) {
            return null;
        }
    }

    // ---- core -----------------------------------------------------------------------------------------------------

    private boolean decide(AccessContext ctx, String object, String relation, List<FgaClient.Tuple> contextual,
                           Map<String, Object> context) {
        fresh(ctx);
        String user = "user:" + ctx.personId();
        boolean allowed = check(user, object, relation, contextual, context);
        if (!allowed) {
            // a shared change (structure, roles) may have landed after the freshness check: apply and ask once more
            try {
                sync.run(false);
            } catch (RuntimeException e) {
                throw unavailable();
            }
            allowed = check(user, object, relation, contextual, context);
            if (!allowed) {
                log.warn("OpenFGA refused {} {} for {} although the grants allow it", relation, object, ctx.personId());
            }
        }
        return allowed;
    }

    private boolean check(String user, String object, String relation, List<FgaClient.Tuple> contextual,
                          Map<String, Object> context) {
        if (contextual.size() > MAX_CONTEXTUAL) {
            throw ApiException.validation("الطلب مرتبط بعدد كبير من الجهات والمواقع يتجاوز حد التحقق في خدمة الصلاحيات.");
        }
        try {
            AuthzSync.Ready r = sync.ready();
            return fga.check(r.storeId(), r.modelId(), user, relation, object, contextual, context);
        } catch (FgaClient.FgaException e) {
            log.warn("OpenFGA check failed: {}", e.getMessage());
            throw unavailable();
        }
    }

    /** Applies pending changes concerning the actor once per HTTP request; refuses if they cannot be applied. */
    private void fresh(AccessContext ctx) {
        ctx.remember("fresh", () -> {
            try {
                for (int attempt = 0; attempt < 3 && sync.pending(ctx.personId()); attempt++) {
                    sync.run(false);
                }
            } catch (FgaClient.FgaException e) {
                throw unavailable();
            }
            if (sync.pending(ctx.personId())) {
                throw syncPending();
            }
            return true;
        });
    }

    private static FgaClient.Tuple systemOf(String object) {
        return new FgaClient.Tuple(object, "system", AuthzModel.SYSTEM, null);
    }

    private static Map<String, Object> base(AccessContext ctx) {
        return baseAt(ctx.at());
    }

    private static Map<String, Object> unscoped(AccessContext ctx) {
        Map<String, Object> c = baseAt(ctx.at());
        c.put("org_level", true);
        return c;
    }

    private static Map<String, Object> baseAt(java.time.Instant at) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("now", at.toString());
        c.put("required_role", "");
        c.put("org_level", false);
        c.put("site_check", false);
        c.put("target_resources", List.of());
        c.put("target_sites", List.of());
        c.put("target_site_path", List.of());
        return c;
    }

    /** The sites and every ancestor, for "with descendants" site limits. */
    private List<String> sitePath(Set<UUID> sites) {
        if (sites.isEmpty()) {
            return List.of();
        }
        return jdbc.sql("""
                with recursive up(id, parent_id) as (
                  select id, parent_id from site where id = any(string_to_array(:ids, ',')::uuid[])
                  union select s.id, s.parent_id from site s join up on s.id = up.parent_id)
                select id::text from up""").param("ids", Db.ids(sites)).query(String.class).list();
    }
}
