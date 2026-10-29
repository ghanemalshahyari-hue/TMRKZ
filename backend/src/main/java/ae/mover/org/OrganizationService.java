package ae.mover.org;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Grant;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.PageResult;
import ae.mover.common.Ref;
import ae.mover.common.Times;
import ae.mover.facilities.SiteService;

/**
 * Organisation tree, people, dated memberships, delegations and role definitions. Organisation and site are
 * independent records: moving an organisation's use of a facility never changes its place in the hierarchy.
 */
@Service
public class OrganizationService {

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AuditService audit;
    private final SiteService sites;

    public OrganizationService(JdbcClient jdbc, Clock clock, AuditService audit, SiteService sites) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.audit = audit;
        this.sites = sites;
    }

    public record OrgNode(String id, String code, String name, String parentId, String status, List<OrgNode> children,
                          int siteCount, int memberCount) {
    }

    public record Member(String membershipId, Map<String, String> person, Map<String, String> role, String positionTitle,
                         Ref site, String validFrom, String validTo, boolean active) {
    }

    public record OrgDetail(OrgNode org, List<Member> members, List<SiteService.SiteView> sites) {
    }

    /** Grants that read the organisation structure: content views and the administration of access or facilities. */
    private static boolean orgReader(Grant g) {
        return g.viewer() || g.has(Permission.MANAGE_ACCESS) || g.has(Permission.MANAGE_FACILITIES);
    }

    /** Organisations visible to the actor: whole tree for ALL scope, otherwise their subtrees plus ancestors. */
    private Set<UUID> visibleOrgs(AccessContext ctx) {
        if (ctx.grants().stream().anyMatch(g -> g.isAll() && orgReader(g)) || ctx.has(Permission.CONFIGURE)) {
            return null;
        }
        Set<UUID> out = new java.util.HashSet<>();
        for (Grant g : ctx.grants()) {
            if (orgReader(g) && g.orgId() != null) {
                out.addAll(g.orgSubtree().isEmpty() ? Set.of(g.orgId()) : g.orgSubtree());
                out.addAll(jdbc.sql("""
                        with recursive up(id, parent_id) as (select id, parent_id from organization where id = :id
                          union all select o.id, o.parent_id from organization o join up on o.id = up.parent_id)
                        select id from up""").param("id", g.orgId()).query(UUID.class).list());
            }
        }
        return out;
    }

    public List<OrgNode> tree(AccessContext ctx) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_ACCESS, Permission.MANAGE_FACILITIES, Permission.CONFIGURE);
        Set<UUID> visible = visibleOrgs(ctx);
        Map<UUID, Integer> siteCounts = new HashMap<>();
        jdbc.sql("select organization_id, count(*) as n from site_responsibility where valid_to is null group by organization_id")
                .query((rs, n) -> siteCounts.put(Db.uuid(rs, "organization_id"), rs.getInt("n"))).list();
        Map<UUID, Integer> memberCounts = new HashMap<>();
        jdbc.sql("""
                select organization_id, count(distinct person_id) as n from membership
                where valid_from <= now() and (valid_to is null or valid_to > now()) group by organization_id""")
                .query((rs, n) -> memberCounts.put(Db.uuid(rs, "organization_id"), rs.getInt("n"))).list();
        Map<UUID, List<OrgNode>> children = new LinkedHashMap<>();
        Map<UUID, Map<String, Object>> rows = new LinkedHashMap<>();
        jdbc.sql("select id, code, name, parent_id, status from organization order by code").query().listOfRows()
                .forEach(r -> rows.put((UUID) r.get("id"), r));
        List<UUID> order = new ArrayList<>(rows.keySet());
        java.util.Collections.reverse(order);
        Map<UUID, OrgNode> built = new HashMap<>();
        // Build bottom-up so each node carries its children.
        for (UUID id : topological(rows)) {
            Map<String, Object> r = rows.get(id);
            if (visible != null && !visible.contains(id)) {
                continue;
            }
            OrgNode node = new OrgNode(id.toString(), (String) r.get("code"), (String) r.get("name"),
                    r.get("parent_id") == null ? null : r.get("parent_id").toString(), (String) r.get("status"),
                    children.getOrDefault(id, List.of()), siteCounts.getOrDefault(id, 0), memberCounts.getOrDefault(id, 0));
            built.put(id, node);
            UUID parent = (UUID) r.get("parent_id");
            if (parent != null) {
                children.computeIfAbsent(parent, k -> new ArrayList<>()).add(node);
            }
        }
        List<OrgNode> roots = new ArrayList<>();
        for (Map.Entry<UUID, OrgNode> e : built.entrySet()) {
            UUID parent = (UUID) rows.get(e.getKey()).get("parent_id");
            if (parent == null || !built.containsKey(parent)) {
                roots.add(rebuild(e.getValue(), children));
            }
        }
        roots.sort(java.util.Comparator.comparing(OrgNode::code));
        return roots;
    }

    private OrgNode rebuild(OrgNode n, Map<UUID, List<OrgNode>> children) {
        List<OrgNode> kids = children.getOrDefault(UUID.fromString(n.id()), List.of()).stream()
                .map(c -> rebuild(c, children)).sorted(java.util.Comparator.comparing(OrgNode::code)).toList();
        return new OrgNode(n.id(), n.code(), n.name(), n.parentId(), n.status(), kids, n.siteCount(), n.memberCount());
    }

    private static List<UUID> topological(Map<UUID, Map<String, Object>> rows) {
        Map<UUID, Integer> depth = new HashMap<>();
        for (UUID id : rows.keySet()) {
            int d = 0;
            UUID p = (UUID) rows.get(id).get("parent_id");
            while (p != null && d < 1000) {
                d++;
                p = rows.containsKey(p) ? (UUID) rows.get(p).get("parent_id") : null;
            }
            depth.put(id, d);
        }
        List<UUID> ids = new ArrayList<>(rows.keySet());
        ids.sort((a, b) -> depth.get(b) - depth.get(a));
        return ids;
    }

    // ---- lazy tree for the map workspace ----------------------------------------------------------------------

    /** One node of the lazily loaded organisation tree: no members, no people, only counts and the path. */
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public record OrgBranch(String id, String code, String name, String parentId, int childCount, int siteCount, List<Ref> path) {
    }

    private static void requireOrgReader(AccessContext ctx) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_ACCESS, Permission.MANAGE_FACILITIES, Permission.CONFIGURE);
    }

    /** Top of the visible tree: organisations whose parent is not visible to the actor. */
    public List<OrgBranch> roots(AccessContext ctx) {
        requireOrgReader(ctx);
        Set<UUID> visible = visibleOrgs(ctx);
        List<Map<String, Object>> rows = jdbc.sql("""
                select o.id, o.code, o.name, o.parent_id from organization o where o.status = 'ACTIVE'
                  and (o.parent_id is null or :all or o.id = any(string_to_array(:ids, ',')::uuid[]))
                order by o.code""").param("all", visible == null).param("ids", visible == null ? "" : Db.ids(visible))
                .query().listOfRows();
        List<UUID> roots = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            UUID id = (UUID) r.get("id");
            UUID parent = (UUID) r.get("parent_id");
            boolean visibleSelf = visible == null || visible.contains(id);
            boolean parentVisible = parent != null && (visible == null || visible.contains(parent));
            if (visibleSelf && !parentVisible && (visible != null || parent == null)) {
                roots.add(id);
            }
        }
        return branches(roots, visible, false);
    }

    /** Children of one visible organisation (lazy), with child and site counts. */
    public List<OrgBranch> branchChildren(AccessContext ctx, UUID id) {
        requireOrgReader(ctx);
        Set<UUID> visible = visibleOrgs(ctx);
        if (visible != null && !visible.contains(id)) {
            throw ApiException.notFound();
        }
        List<UUID> kids = jdbc.sql("select id from organization where parent_id = :id and status = 'ACTIVE' order by code")
                .param("id", id).query(UUID.class).list().stream().filter(k -> visible == null || visible.contains(k)).toList();
        return branches(kids, visible, false);
    }

    /** Search across the whole permitted tree (not only expanded branches); each match carries its path. */
    public List<OrgBranch> search(AccessContext ctx, String q) {
        requireOrgReader(ctx);
        String term = q == null ? "" : q.trim();
        if (term.length() < 2) {
            return List.of();
        }
        Set<UUID> visible = visibleOrgs(ctx);
        List<UUID> hits = jdbc.sql("""
                select id from organization where status = 'ACTIVE' and (name ilike :t or code ilike :t)
                  and (:all or id = any(string_to_array(:ids, ',')::uuid[]))
                order by length(name), name limit 30""")
                .param("t", "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
                .param("all", visible == null).param("ids", visible == null ? "" : Db.ids(visible)).query(UUID.class).list();
        return branches(hits, visible, true);
    }

    /**
     * The organisation and, when asked, its visible descendants — for filtering facilities by responsibility or use.
     * An organisation outside the actor's tree gives the same answer as one that does not exist.
     */
    public Set<UUID> requireVisibleBranch(AccessContext ctx, UUID id, boolean includeDescendants) {
        Set<UUID> visible = visibleOrgs(ctx);
        boolean exists = jdbc.sql("select count(*) from organization where id = :id").param("id", id).query(Integer.class).single() > 0;
        if (!exists || (visible != null && !visible.contains(id))) {
            throw ApiException.notFound();
        }
        if (!includeDescendants) {
            return Set.of(id);
        }
        Set<UUID> out = new java.util.HashSet<>(jdbc.sql("""
                with recursive down(id) as (select id from organization where id = :id
                  union all select o.id from organization o join down on o.parent_id = down.id)
                select id from down""").param("id", id).query(UUID.class).list());
        if (visible != null) {
            out.retainAll(visible);
        }
        return out;
    }

    private List<OrgBranch> branches(List<UUID> ids, Set<UUID> visible, boolean withPath) {
        if (ids.isEmpty()) {
            return List.of();
        }
        String csv = Db.ids(ids);
        Map<UUID, Integer> kids = new HashMap<>();
        jdbc.sql("""
                select parent_id, id from organization where status = 'ACTIVE' and parent_id = any(string_to_array(:ids, ',')::uuid[])""")
                .param("ids", csv).query((rs, n) -> {
                    UUID child = Db.uuid(rs, "id");
                    if (visible == null || visible.contains(child)) {
                        kids.merge(Db.uuid(rs, "parent_id"), 1, Integer::sum);
                    }
                    return null;
                }).list();
        Map<UUID, Integer> sitesBy = new HashMap<>();
        jdbc.sql("""
                select organization_id, count(*) as n from site_responsibility
                where valid_to is null and organization_id = any(string_to_array(:ids, ',')::uuid[]) group by organization_id""")
                .param("ids", csv).query((rs, n) -> sitesBy.put(Db.uuid(rs, "organization_id"), rs.getInt("n"))).list();
        Map<UUID, Map<String, Object>> rows = new HashMap<>();
        jdbc.sql("select id, code, name, parent_id from organization where id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", csv).query().listOfRows().forEach(r -> rows.put((UUID) r.get("id"), r));
        List<OrgBranch> out = new ArrayList<>();
        for (UUID id : ids) {
            Map<String, Object> r = rows.get(id);
            List<Ref> path = null;
            if (withPath) {
                path = new ArrayList<>();
                for (Map<String, Object> a : jdbc.sql("""
                        with recursive up(id, name, parent_id, depth) as (
                          select id, name, parent_id, 0 from organization where id = :id
                          union all select o.id, o.name, o.parent_id, up.depth + 1 from organization o join up on o.id = up.parent_id)
                        select id, name from up where depth > 0 order by depth desc""").param("id", id).query().listOfRows()) {
                    if (visible == null || visible.contains((UUID) a.get("id"))) {
                        path.add(Ref.of((UUID) a.get("id"), (String) a.get("name")));
                    }
                }
            }
            out.add(new OrgBranch(id.toString(), (String) r.get("code"), (String) r.get("name"),
                    r.get("parent_id") == null ? null : r.get("parent_id").toString(), kids.getOrDefault(id, 0),
                    sitesBy.getOrDefault(id, 0), path));
        }
        return out;
    }

    public OrgDetail detail(AccessContext ctx, UUID id) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_ACCESS, Permission.MANAGE_FACILITIES, Permission.CONFIGURE);
        Set<UUID> visible = visibleOrgs(ctx);
        if (visible != null && !visible.contains(id)) {
            throw ApiException.notFound();
        }
        OrgNode org = jdbc.sql("select id, code, name, parent_id, status from organization where id = :id").param("id", id)
                .query((rs, n) -> new OrgNode(rs.getString("id"), rs.getString("code"), rs.getString("name"),
                        rs.getString("parent_id"), rs.getString("status"), List.of(), 0, 0))
                .optional().orElseThrow(ApiException::notFound);
        boolean summary = ctx.summaryOnly();
        List<Member> members = summary ? List.of() : jdbc.sql("""
                select m.id, p.id as person_id, p.display_name, p.employee_no, r.code as role_code, r.name as role_name,
                       m.position_title, s.id as site_id, s.name as site_name, m.valid_from, m.valid_to,
                       (m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) as active
                from membership m join person p on p.id = m.person_id join role_def r on r.code = m.role_code
                left join site s on s.id = m.site_scope_id
                where m.organization_id = :id order by active desc, r.sort_order, p.display_name limit 500""")
                .param("id", id).query((rs, n) -> new Member(rs.getString("id"),
                        Map.of("id", rs.getString("person_id"), "displayName", rs.getString("display_name"),
                                "employeeNo", rs.getString("employee_no")),
                        Map.of("code", rs.getString("role_code"), "name", rs.getString("role_name")),
                        rs.getString("position_title"), Ref.of(Db.uuid(rs, "site_id"), rs.getString("site_name")),
                        Db.iso(rs, "valid_from"), Db.iso(rs, "valid_to"), rs.getBoolean("active"))).list();
        List<SiteService.SiteView> orgSites = sites.list(ctx).stream()
                .filter(s -> s.responsibleOrg() != null && s.responsibleOrg().id().equals(id.toString())).toList();
        return new OrgDetail(org, members, orgSites);
    }

    public PageResult<Map<String, Object>> people(AccessContext ctx, String q, Integer page, Integer size) {
        ctx.require(Permission.MANAGE_ACCESS);
        int p = PageResult.page(page);
        int s = PageResult.size(size);
        String like = q == null || q.isBlank() ? "%" : "%" + q.trim().replace("%", "") + "%";
        long total = jdbc.sql("select count(*) from person where display_name ilike :q or employee_no ilike :q or coalesce(username,'') ilike :q")
                .param("q", like).query(Long.class).single();
        List<Map<String, Object>> items = jdbc.sql("""
                select id, display_name, employee_no, username, status from person
                where display_name ilike :q or employee_no ilike :q or coalesce(username,'') ilike :q
                order by display_name limit :l offset :o""")
                .param("q", like).param("l", s).param("o", p * s)
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("displayName", rs.getString("display_name"));
                    m.put("employeeNo", rs.getString("employee_no"));
                    m.put("username", rs.getString("username"));
                    m.put("status", rs.getString("status"));
                    return m;
                }).list();
        return new PageResult<>(items, p, s, total);
    }

    // ---- delegations --------------------------------------------------------------------------------

    public record DelegationView(String id, Ref delegator, Ref delegate, Map<String, String> role, Ref organization,
                                 String validFrom, String validTo, String reason, String revokedAt, boolean active) {
    }

    public List<DelegationView> delegations(AccessContext ctx) {
        boolean all = ctx.has(Permission.MANAGE_ACCESS);
        return jdbc.sql("""
                select d.*, a.display_name as delegator_name, b.display_name as delegate_name, r.code as role_code,
                       r.name as role_name, o.id as org_id, o.name as org_name,
                       (d.revoked_at is null and d.valid_from <= now() and d.valid_to > now()) as active
                from delegation d join person a on a.id = d.delegator_id join person b on b.id = d.delegate_id
                join membership m on m.id = d.membership_id join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id
                where :all or d.delegator_id = :me or d.delegate_id = :me order by d.created_at desc limit 300""")
                .param("all", all).param("me", ctx.personId())
                .query((rs, n) -> new DelegationView(rs.getString("id"), Ref.of(Db.uuid(rs, "delegator_id"), rs.getString("delegator_name")),
                        Ref.of(Db.uuid(rs, "delegate_id"), rs.getString("delegate_name")),
                        Map.of("code", rs.getString("role_code"), "name", rs.getString("role_name")),
                        Ref.of(Db.uuid(rs, "org_id"), rs.getString("org_name")), Db.iso(rs, "valid_from"), Db.iso(rs, "valid_to"),
                        rs.getString("reason"), Db.iso(rs, "revoked_at"), rs.getBoolean("active"))).list();
    }

    public record DelegationInput(String delegateId, String membershipId, String validFrom, String validTo, String reason) {
    }

    /** A person delegates one of their own active memberships; the delegate receives exactly that role and scope. */
    @Transactional
    public Map<String, Object> delegate(AccessContext ctx, DelegationInput in) {
        if (in == null || in.delegateId() == null || in.membershipId() == null || in.reason() == null || in.reason().isBlank()) {
            throw ApiException.validation("حدد المفوض إليه والعضوية والسبب.");
        }
        UUID membership = UUID.fromString(in.membershipId());
        boolean own = ctx.grants().stream().anyMatch(g -> membership.equals(g.membershipId()) && g.delegationId() == null);
        if (!own) {
            throw ApiException.forbidden("يمكن تفويض عضوية نشطة تملكها فقط.");
        }
        Instant from = in.validFrom() == null ? clock.instant() : Times.parse(in.validFrom(), "validFrom");
        Instant to = Times.parse(in.validTo(), "validTo");
        if (to == null || !to.isAfter(from)) {
            throw ApiException.validation("حدد نهاية للتفويض بعد بدايته.");
        }
        UUID delegate = UUID.fromString(in.delegateId());
        if (delegate.equals(ctx.personId())) {
            throw ApiException.validation("لا يجوز التفويض للنفس.");
        }
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into delegation(id, delegator_id, delegate_id, membership_id, valid_from, valid_to, reason)
                values (:id, :a, :b, :m, :f, :t, :r)""")
                .param("id", id).param("a", ctx.personId()).param("b", delegate).param("m", membership)
                .param("f", Db.ts(from)).param("t", Db.ts(to)).param("r", in.reason()).update();
        audit.recordAs(ctx.actor(), "DELEGATION_CREATED", "PERSON", delegate.toString(), null,
                Map.of("delegationId", id.toString(), "validTo", to.toString()), in.reason());
        return Map.of("id", id.toString());
    }

    @Transactional
    public void revokeDelegation(AccessContext ctx, UUID id, String reason) {
        Map<String, Object> d = jdbc.sql("""
                select d.delegator_id, d.delegate_id, d.revoked_at, m.organization_id from delegation d
                join membership m on m.id = d.membership_id where d.id = :id for update of d""")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.personId().equals(d.get("delegator_id")) && !ctx.canFor(Permission.MANAGE_ACCESS, (UUID) d.get("organization_id"))) {
            throw ApiException.forbidden();
        }
        if (d.get("revoked_at") != null) {
            throw ApiException.validation("التفويض ملغى بالفعل.");
        }
        jdbc.sql("update delegation set revoked_at = :now, revoked_by = :by, revoke_reason = :r where id = :id")
                .param("now", Db.ts(clock.instant())).param("by", ctx.personId()).param("r", reason).param("id", id).update();
        audit.recordAs(ctx.actor(), "DELEGATION_REVOKED", "PERSON", d.get("delegate_id").toString(), null,
                Map.of("delegationId", id.toString()), reason);
    }

    // ---- roles --------------------------------------------------------------------------------------

    public record RoleDef(String code, String name, List<String> permissions, String scope, boolean summaryOnly, boolean system,
                          List<String> grantableRoles, Integer policyVersion) {
    }

    public List<RoleDef> roles(AccessContext ctx) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_ACCESS, Permission.CONFIGURE);
        return jdbc.sql("select * from role_def order by sort_order, code")
                .query((rs, n) -> new RoleDef(rs.getString("code"), rs.getString("name"), Db.strings(rs, "permissions"),
                        rs.getString("scope"), rs.getBoolean("summary_only"), rs.getBoolean("system"),
                        Db.strings(rs, "grantable_roles"), (Integer) rs.getObject("policy_version"))).list();
    }


}
