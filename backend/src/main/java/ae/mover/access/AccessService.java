package ae.mover.access;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

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

    public AccessService(JdbcClient jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
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
        AccessContext ctx = load(actor, clock.instant());
        if (attrs != null) {
            attrs.setAttribute(CONTEXT_ATTRIBUTE, ctx, RequestAttributes.SCOPE_REQUEST);
        }
        return ctx;
    }

    /** Evaluates grants at a given instant without request caching (used by tests and background jobs). */
    public AccessContext load(Actor actor, Instant at) {
        List<Map<String, Object>> rows = jdbc.sql("""
                select m.id as membership_id, null::uuid as delegation_id, null as delegator_name,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id as org_id, o.name as org_name, s.id as site_id, s.name as site_name, m.valid_to
                from membership m
                join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id and o.status = 'ACTIVE'
                left join site s on s.id = m.site_scope_id
                join person p on p.id = m.person_id and p.status = 'ACTIVE'
                where m.person_id = :pid and m.valid_from <= :at and (m.valid_to is null or m.valid_to > :at)
                union all
                select m.id, d.id, dp.display_name,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id, o.name, s.id, s.name,
                       case when m.valid_to is null or d.valid_to < m.valid_to then d.valid_to else m.valid_to end
                from delegation d
                join membership m on m.id = d.membership_id
                join person dp on dp.id = d.delegator_id and dp.status = 'ACTIVE'
                join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id and o.status = 'ACTIVE'
                left join site s on s.id = m.site_scope_id
                where d.delegate_id = :pid and d.revoked_at is null
                  and d.valid_from <= :at and d.valid_to > :at
                  and m.valid_from <= :at and (m.valid_to is null or m.valid_to > :at)
                order by 2 nulls first, 4""")
                .param("pid", actor.personId()).param("at", Db.ts(at))
                .query().listOfRows();
        Map<UUID, Set<UUID>> orgTrees = new HashMap<>();
        Map<UUID, Set<UUID>> siteTrees = new HashMap<>();
        List<Grant> grants = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            UUID orgId = (UUID) row.get("org_id");
            UUID siteId = (UUID) row.get("site_id");
            String scope = (String) row.get("scope");
            Set<UUID> orgTree = scope.startsWith("ORGANIZATION") ? orgTrees.computeIfAbsent(orgId, this::orgSubtree) : Set.of();
            Set<UUID> siteTree = siteId != null && (scope.equals("SITE") || scope.equals("ORGANIZATION_AND_SITE"))
                    ? siteTrees.computeIfAbsent(siteId, this::siteSubtree) : Set.of();
            grants.add(new Grant((UUID) row.get("membership_id"), (UUID) row.get("delegation_id"),
                    (String) row.get("delegator_name"), (String) row.get("code"), (String) row.get("name"),
                    permissions(row.get("permissions")), scope, (Boolean) row.get("summary_only"),
                    orgId, (String) row.get("org_name"), siteId, (String) row.get("site_name"),
                    Db.toInstant(row.get("valid_to")), orgTree, siteTree));
        }
        return new AccessContext(actor, grants, at);
    }

    private static Set<Permission> permissions(Object value) {
        EnumSet<Permission> set = EnumSet.noneOf(Permission.class);
        try {
            Object[] items = (Object[]) ((java.sql.Array) value).getArray();
            for (Object item : items) {
                set.add(Permission.valueOf(String.valueOf(item)));
            }
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
        return set;
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
                (String) row.get("status"), (UUID) row.get("owner_org_id"), Set.of(), Set.of(), Set.of(), Set.of()));
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
        jdbc.sql("select request_id, organization_id, relation from request_participant where request_id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", ids).query((rs, n) -> {
                    UUID rid = Db.uuid(rs, "request_id");
                    (rs.getString("relation").equals("INFO") ? info : participants)
                            .computeIfAbsent(rid, k -> new LinkedHashSet<>()).add(Db.uuid(rs, "organization_id"));
                    return null;
                }).list();
        jdbc.sql("""
                select rr.request_id, res.site_id, sr.organization_id
                from request_resource rr join resource res on res.id = rr.resource_id
                left join site_responsibility sr on sr.site_id = res.site_id and sr.valid_to is null
                where rr.request_id = any(string_to_array(:ids, ',')::uuid[])""")
                .param("ids", ids).query((rs, n) -> {
                    UUID rid = Db.uuid(rs, "request_id");
                    sites.computeIfAbsent(rid, k -> new LinkedHashSet<>()).add(Db.uuid(rs, "site_id"));
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
                            sites.getOrDefault(rid, Set.of())));
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
            switch (g.scope()) {
                case "ALL" -> ors.add("r.status <> 'DRAFT'");
                case "ORGANIZATION" -> {
                    params.put(key + "o", Db.ids(g.orgSubtree()));
                    ors.add("(r.status <> 'DRAFT' and " + orgPredicate(key + "o") + ")");
                }
                case "SITE" -> {
                    params.put(key + "s", Db.ids(g.siteSubtree()));
                    ors.add("(r.status <> 'DRAFT' and " + sitePredicate(key + "s") + ")");
                }
                case "ORGANIZATION_AND_SITE" -> {
                    params.put(key + "o", Db.ids(g.orgSubtree()));
                    params.put(key + "s", Db.ids(g.siteSubtree()));
                    ors.add("(r.status <> 'DRAFT' and " + orgPredicate(key + "o") + " and " + sitePredicate(key + "s") + ")");
                }
                default -> {
                }
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

    private static String sitePredicate(String key) {
        return "exists (select 1 from request_resource rs join resource rres on rres.id = rs.resource_id"
                + " where rs.request_id = r.id and rres.site_id = any(string_to_array(:" + key + ", ',')::uuid[]))";
    }
}
