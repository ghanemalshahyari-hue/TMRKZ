package ae.mover.access;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;

import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.security.Actor;

@Service
public class AccessService {

    private static final String CONTEXT_ATTRIBUTE = "mover.access";

    private final JdbcClient jdbc;
    private final Clock clock;
    private final GrantSource source;
    private final ObjectProvider<AccessContext.Confirmer> confirmer;

    public AccessService(JdbcClient jdbc, Clock clock, GrantSource source, ObjectProvider<AccessContext.Confirmer> confirmer) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.source = source;
        this.confirmer = confirmer;
    }

    /** Effective grants of the actor, evaluated now (cached for the current HTTP request only). */
    public AccessContext context(Actor actor) {
        RequestAttributes attrs = RequestContextHolder.getRequestAttributes();
        if (attrs != null) {
            Object cached = attrs.getAttribute(CONTEXT_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST);
            if (cached instanceof AccessContext ctx && ctx.actor().equals(actor)) {
                return ctx;
            }
        }
        // Actions taken by a person over HTTP are also decided by OpenFGA (ADR-018); background evaluations are not.
        AccessContext ctx = load(actor, clock.instant()).withConfirmer(confirmer.getIfAvailable());
        if (attrs != null) {
            attrs.setAttribute(CONTEXT_ATTRIBUTE, ctx, RequestAttributes.SCOPE_REQUEST);
        }
        return ctx;
    }

    /** Evaluates grants at a given instant without request caching (used by tests and background jobs). */
    public AccessContext load(Actor actor, Instant at) {
        return load(actor, at, Map.of());
    }

    /** Evaluates grants with some role definitions replaced (preview of a draft policy). */
    public AccessContext load(Actor actor, Instant at, Map<String, GrantSource.RoleOverride> roles) {
        List<RawGrant> raw = source.current(actor.personId(), at, roles);
        Map<UUID, Set<UUID>> orgTrees = new HashMap<>();
        Map<UUID, Set<UUID>> siteTrees = new HashMap<>();
        List<Grant> grants = new ArrayList<>();
        for (RawGrant g : raw) {
            grants.add(expand(g, orgTrees, siteTrees));
        }
        return new AccessContext(actor, grants, at);
    }

    /** Resolves a stored grant to the organisations, sites and resources it reaches. */
    public Grant expand(RawGrant g, Map<UUID, Set<UUID>> orgTrees, Map<UUID, Set<UUID>> siteTrees) {
        RawGrant.Spec spec = g.spec();
        Set<UUID> orgScope = null;
        Set<UUID> siteScope = null;
        Set<UUID> resources = Set.of();
        Set<UUID> resourceSites = Set.of();
        if (!spec.all()) {
            if (spec.orgConstraint()) {
                orgScope = new HashSet<>();
                for (GrantTarget t : spec.orgs()) {
                    if (t.includeDescendants()) {
                        orgScope.addAll(orgTrees.computeIfAbsent(t.id(), this::orgSubtree));
                    } else {
                        orgScope.add(t.id());
                    }
                }
            }
            if (spec.siteConstraint()) {
                siteScope = new HashSet<>();
                for (GrantTarget t : spec.sites()) {
                    if (t.includeDescendants()) {
                        siteScope.addAll(siteTrees.computeIfAbsent(t.id(), this::siteSubtree));
                    } else {
                        siteScope.add(t.id());
                    }
                }
                resources = Set.copyOf(spec.resources());
                resourceSites = resources.isEmpty() ? Set.of() : new HashSet<>(jdbc.sql(
                        "select distinct site_id from resource where id = any(string_to_array(:ids, ',')::uuid[])")
                        .param("ids", Db.ids(resources)).query(UUID.class).list());
            }
        }
        String scope = "CUSTOM".equals(g.scopeMode()) ? "CUSTOM" : g.roleScope();
        return new Grant(g.grantId(), g.membershipId(), g.delegationId(), g.delegatorName(), g.roleCode(), g.roleName(),
                g.permissions(), scope, g.summaryOnly(), g.orgId(), g.orgName(), g.siteId(), g.siteName(), g.validTo(),
                spec.all(), spec.and(), orgScope, siteScope, resources, resourceSites, g.targets());
    }

    public Set<UUID> orgSubtree(UUID root) {
        return new HashSet<>(jdbc.sql("""
                with recursive t(id) as (select id from organization where id = :root
                  union all select o.id from organization o join t on o.parent_id = t.id)
                select id from t""").param("root", root).query(UUID.class).list());
    }

    public Set<UUID> siteSubtree(UUID root) {
        return new HashSet<>(jdbc.sql("""
                with recursive t(id) as (select id from site where id = :root
                  union all select s.id from site s join t on s.parent_id = t.id)
                select id from t""").param("root", root).query(UUID.class).list());
    }

    // ---- request scope --------------------------------------------------------------------------------

    public RequestScope requestScope(UUID requestId) {
        Map<String, Object> row = jdbc.sql("select id, created_by, status, owner_org_id from request where id = :id")
                .param("id", requestId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        return scopes(List.of(requestId)).getOrDefault(requestId, new RequestScope(requestId, (UUID) row.get("created_by"),
                (String) row.get("status"), (UUID) row.get("owner_org_id"), Set.of(), Set.of(), Set.of(), Set.of(), Set.of()));
    }

    /** Batch-loads request scopes (owner, participants, info recipients, resource sites and their administrators). */
    public Map<UUID, RequestScope> scopes(List<UUID> requestIds) {
        Map<UUID, RequestScope> out = new HashMap<>();
        if (requestIds.isEmpty()) {
            return out;
        }
        String ids = Db.ids(requestIds);
        Map<UUID, Set<UUID>> participants = new HashMap<>();
        Map<UUID, Set<UUID>> info = new HashMap<>();
        Map<UUID, Set<UUID>> resourceOrgs = new HashMap<>();
        Map<UUID, Set<UUID>> sites = new HashMap<>();
        Map<UUID, Set<UUID>> resources = new HashMap<>();
        jdbc.sql("select request_id, organization_id, relation from request_participant where request_id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", ids).query((rs, n) -> {
                    UUID rid = Db.uuid(rs, "request_id");
                    (rs.getString("relation").equals("INFO") ? info : participants)
                            .computeIfAbsent(rid, k -> new LinkedHashSet<>()).add(Db.uuid(rs, "organization_id"));
                    return null;
                }).list();
        jdbc.sql("""
                select rr.request_id, rr.resource_id, res.site_id, sr.organization_id
                from request_resource rr join resource res on res.id = rr.resource_id
                left join site_responsibility sr on sr.site_id = res.site_id and sr.valid_to is null
                where rr.request_id = any(string_to_array(:ids, ',')::uuid[])""")
                .param("ids", ids).query((rs, n) -> {
                    UUID rid = Db.uuid(rs, "request_id");
                    sites.computeIfAbsent(rid, k -> new LinkedHashSet<>()).add(Db.uuid(rs, "site_id"));
                    resources.computeIfAbsent(rid, k -> new LinkedHashSet<>()).add(Db.uuid(rs, "resource_id"));
                    UUID org = Db.uuid(rs, "organization_id");
                    if (org != null) {
                        resourceOrgs.computeIfAbsent(rid, k -> new LinkedHashSet<>()).add(org);
                    }
                    return null;
                }).list();
        jdbc.sql("select id, created_by, status, owner_org_id from request where id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", ids).query((rs, n) -> {
                    UUID rid = Db.uuid(rs, "id");
                    out.put(rid, new RequestScope(rid, Db.uuid(rs, "created_by"), rs.getString("status"),
                            Db.uuid(rs, "owner_org_id"), participants.getOrDefault(rid, Set.of()),
                            info.getOrDefault(rid, Set.of()), resourceOrgs.getOrDefault(rid, Set.of()),
                            sites.getOrDefault(rid, Set.of()), resources.getOrDefault(rid, Set.of())));
                    return null;
                }).list();
        return out;
    }

    /** Loads scope and enforces at least the given view level; out-of-scope requests are reported as not found. */
    public ViewLevel requireView(AccessContext ctx, UUID requestId) {
        ViewLevel level = ctx.viewLevel(requestScope(requestId));
        if (level == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        return level;
    }

    /**
     * SQL predicate (over alias {@code r} = request) that matches exactly the requests the actor may see. The same
     * rule is used by lists, searches, counters, exports and reports so none of them can leak out-of-scope rows.
     */
    public String requestPredicate(AccessContext ctx, Map<String, Object> params) {
        List<String> ors = new ArrayList<>();
        params.put("scope_me", ctx.personId());
        ors.add("r.created_by = :scope_me");
        Set<UUID> infoOrgs = new HashSet<>();
        int i = 0;
        for (Grant g : ctx.grants()) {
            if (!g.viewer()) {
                continue;
            }
            if (g.orgId() != null) {
                infoOrgs.add(g.orgId());
            }
            String key = "scope_g" + (i++);
            if (g.isAll()) {
                ors.add("r.status <> 'DRAFT'");
                continue;
            }
            String org = null;
            String site = null;
            if (g.hasOrgLimit()) {
                params.put(key + "o", Db.ids(g.orgSubtree()));
                org = orgPredicate(key + "o");
            }
            if (g.hasSiteLimit()) {
                params.put(key + "s", Db.ids(g.siteSubtree()));
                params.put(key + "r", Db.ids(g.resources()));
                site = "(" + sitePredicate(key + "s") + " or " + resourcePredicate(key + "r") + ")";
            }
            String reach = org != null && site != null ? "(" + org + (g.andCombine() ? " and " : " or ") + site + ")"
                    : org != null ? org : site;
            if (reach != null) {
                ors.add("(r.status <> 'DRAFT' and " + reach + ")");
            }
        }
        params.put("scope_info", Db.ids(infoOrgs));
        ors.add("""
                (r.status in ('APPROVED','CLOSED') and exists (select 1 from request_participant ip
                  where ip.request_id = r.id and ip.relation = 'INFO'
                    and ip.organization_id = any(string_to_array(:scope_info, ',')::uuid[])))""");
        return "(" + String.join(" or ", ors) + ")";
    }

    private static String orgPredicate(String key) {
        String k = "string_to_array(:" + key + ", ',')::uuid[]";
        return "(r.owner_org_id = any(" + k + ")"
                + " or exists (select 1 from request_participant pp where pp.request_id = r.id and pp.relation = 'PARTICIPANT' and pp.organization_id = any(" + k + "))"
                + " or exists (select 1 from request_resource rr join resource res on res.id = rr.resource_id"
                + " join site_responsibility sr on sr.site_id = res.site_id and sr.valid_to is null"
                + " where rr.request_id = r.id and sr.organization_id = any(" + k + ")))";
    }

    private static String resourcePredicate(String key) {
        return "exists (select 1 from request_resource rq where rq.request_id = r.id"
                + " and rq.resource_id = any(string_to_array(:" + key + ", ',')::uuid[]))";
    }

    private static String sitePredicate(String key) {
        return "exists (select 1 from request_resource rs join resource rres on rres.id = rs.resource_id"
                + " where rs.request_id = r.id and rres.site_id = any(string_to_array(:" + key + ", ',')::uuid[]))";
    }
}
