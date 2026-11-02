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
import ae.mover.access.DirectoryScope;
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

    private final DirectoryScope directory;
    private final ae.mover.access.PersonKeys keys;

    public OrganizationService(JdbcClient jdbc, Clock clock, AuditService audit, SiteService sites, DirectoryScope directory,
                               ae.mover.access.PersonKeys keys) {
        this.keys = keys;
        this.jdbc = jdbc;
        this.clock = clock;
        this.audit = audit;
        this.sites = sites;
        this.directory = directory;
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

    /** The given organisations that the actor may see, in the given order (unknown ids are dropped). */
    public List<UUID> visibleAmong(AccessContext ctx, java.util.Collection<UUID> ids) {
        requireOrgReader(ctx);
        Set<UUID> visible = visibleOrgs(ctx);
        Set<UUID> existing = new java.util.HashSet<>(ids.isEmpty() ? List.of() : jdbc.sql("select id from organization where id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", ids.stream().map(UUID::toString).collect(java.util.stream.Collectors.joining(","))).query(UUID.class).list());
        return ids.stream().distinct().filter(existing::contains).filter(id -> visible == null || visible.contains(id)).toList();
    }

    public static void requireOrgReader(AccessContext ctx) {
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
        // the roster only inside the reader's own scope, never for an organisation shown as context (an ancestor), and a
        // grant's site only when the reader may see that site (ADR-027, independent review)
        boolean roster = !ctx.summaryOnly() && (ctx.canFor(Permission.VIEW, id) || ctx.canFor(Permission.MANAGE_ACCESS, id));
        List<Member> members = !roster ? List.of() : jdbc.sql("""
                select m.id, p.id as person_id, p.display_name, p.employee_no, r.code as role_code, r.name as role_name,
                       m.position_title, s.id as site_id, s.name as site_name, sr.organization_id as site_org, m.valid_from, m.valid_to,
                       (m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) as active
                from membership m join person p on p.id = m.person_id join role_def r on r.code = m.role_code
                left join site s on s.id = m.site_scope_id
                left join site_responsibility sr on sr.site_id = s.id and sr.valid_to is null
                where m.organization_id = :id order by active desc, r.sort_order, p.display_name limit 500""")
                .param("id", id).query((rs, n) -> {
                    UUID site = Db.uuid(rs, "site_id");
                    boolean siteVisible = site != null
                            && ctx.siteView(site, Set.of(), Db.uuid(rs, "site_org")) != ae.mover.access.ViewLevel.NONE;
                    return new Member(rs.getString("id"),
                            Map.of("id", rs.getString("person_id"), "displayName", rs.getString("display_name"),
                                    "employeeNo", rs.getString("employee_no")),
                            Map.of("code", rs.getString("role_code"), "name", rs.getString("role_name")),
                            rs.getString("position_title"), siteVisible ? Ref.of(site, rs.getString("site_name")) : null,
                            Db.iso(rs, "valid_from"), Db.iso(rs, "valid_to"), rs.getBoolean("active"));
                }).list();
        List<SiteService.SiteView> orgSites = sites.list(ctx).stream()
                .filter(s -> s.responsibleOrg() != null && s.responsibleOrg().id().equals(id.toString())).toList();
        return new OrgDetail(org, members, orgSites);
    }

    /**
     * Organisations inside the actor's MANAGE_ACCESS authority (every org-limited access grant's subtree). Global access
     * managers are handled by the callers; an access grant limited to sites only reaches no organisation here.
     */
    private static Set<UUID> manageAccessOrgs(AccessContext ctx) {
        Set<UUID> out = new java.util.HashSet<>();
        for (Grant g : ctx.grants()) {
            if (g.has(Permission.MANAGE_ACCESS) && g.hasOrgLimit()) {
                out.addAll(g.orgSubtree());
            }
        }
        return out;
    }

    /**
     * The directory for granting and delegating (audit P0-4; ADR-027 withdrew the cross-organisation search). A global
     * access manager searches everyone. A scoped one searches only the people inside their authority
     * ({@link DirectoryScope}): members with employee number, account and status, bridges — a current grant on a site the
     * manager administers — by name and organisation only. Nobody outside is found, by name or by identifier.
     */
    public PageResult<Map<String, Object>> people(AccessContext ctx, String q, Integer page, Integer size) {
        ctx.require(Permission.MANAGE_ACCESS);
        int p = PageResult.page(page);
        int s = PageResult.size(size);
        String term = q == null ? "" : q.trim().replace("%", "");
        String like = term.isEmpty() ? "%" : "%" + term + "%";
        DirectoryScope.Reach reach = directory.reach(ctx);
        String reached = reach.global() ? "(select true as member) reach" : """
                (select id, bool_or(member) as member from (
                   select a.person_id as id, true as member from affiliation a
                   where a.valid_to is null and a.organization_id = any(string_to_array(:dir_orgs, ',')::uuid[])
                   union all
                   select m.person_id, true from membership m
                   where (m.valid_to is null or m.valid_to > now()) and m.organization_id = any(string_to_array(:dir_orgs, ',')::uuid[])
                   union all
                   select m.person_id, false from membership m
                   where (m.valid_to is null or m.valid_to > now())
                     and (m.site_scope_id = any(string_to_array(:dir_sites, ',')::uuid[])
                          or exists (select 1 from membership_scope_target t left join resource r on t.kind = 'RESOURCE' and r.id = t.target_id
                                     where t.membership_id = m.id
                                       and ((t.kind = 'SITE' and t.target_id = any(string_to_array(:dir_sites, ',')::uuid[]))
                                            or r.site_id = any(string_to_array(:dir_sites, ',')::uuid[]))))) c
                 group by id) reach""";
        String from = " from person " + (reach.global() ? "cross join " + reached : "join " + reached + " on reach.id = person.id")
                // a bridge is found by name only: matching its identifiers would let them be rebuilt one character at a time
                + " where (person.display_name ilike :q or (reach.member"
                + " and (person.employee_no ilike :q or coalesce(person.username, '') ilike :q)))";
        String orgs = Db.ids(reach.orgs());
        String siteIds = Db.ids(reach.sites());
        long total = jdbc.sql("select count(*)" + from).param("q", like).param("dir_orgs", orgs).param("dir_sites", siteIds)
                .query(Long.class).single();
        List<Map<String, Object>> items = jdbc.sql("""
                select person.id, person.display_name, person.employee_no, person.username, person.status, reach.member,
                       coalesce((select o.name from affiliation a join organization o on o.id = a.organization_id
                                 where a.person_id = person.id and a.valid_to is null limit 1),
                                (select o.name from membership m join organization o on o.id = m.organization_id
                                 where m.person_id = person.id and (m.valid_to is null or m.valid_to > now()) order by m.valid_from limit 1))
                         as org_name""" + from + " order by reach.member desc, person.display_name limit :l offset :o")
                .param("q", like).param("dir_orgs", orgs).param("dir_sites", siteIds).param("l", s).param("o", p * s)
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("displayName", rs.getString("display_name"));
                    if (rs.getBoolean("member")) {
                        m.put("employeeNo", rs.getString("employee_no"));
                        m.put("username", rs.getString("username"));
                        m.put("status", rs.getString("status"));
                    }
                    m.put("organization", rs.getString("org_name"));
                    return m;
                }).list();
        return new PageResult<>(items, p, s, total);
    }

    // ---- delegations --------------------------------------------------------------------------------

    public record DelegationView(String id, Ref delegator, Ref delegate, Map<String, String> role, Ref organization,
                                 String validFrom, String validTo, String reason, String revokedAt, boolean active) {
    }

    /**
     * Delegations the actor may see: their own (as delegator or delegate), every one for a global access manager, and
     * for a scoped access manager those on grants inside their authority (audit P0-4).
     */
    public List<DelegationView> delegations(AccessContext ctx) {
        boolean all = ctx.canEverywhere(Permission.MANAGE_ACCESS);
        String orgs = all || !ctx.has(Permission.MANAGE_ACCESS) ? "" : Db.ids(manageAccessOrgs(ctx));
        return jdbc.sql("""
                select d.*, a.display_name as delegator_name, b.display_name as delegate_name, r.code as role_code,
                       r.name as role_name, o.id as org_id, o.name as org_name,
                       (d.revoked_at is null and d.valid_from <= now() and d.valid_to > now()) as active
                from delegation d join person a on a.id = d.delegator_id join person b on b.id = d.delegate_id
                join membership m on m.id = d.membership_id join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id
                where :all or d.delegator_id = :me or d.delegate_id = :me
                   or m.organization_id = any(string_to_array(:orgs, ',')::uuid[])
                order by d.created_at desc limit 300""")
                .param("all", all).param("me", ctx.personId()).param("orgs", orgs)
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
        if (keys.same(ctx.personId(), delegate)) {
            throw ApiException.validation("لا يجوز التفويض للنفس.");
        }
        // a delegation is a grant the delegator makes without an access manager (ADR-027, independent review): never to
        // the temporary first administrator, and never of administration rights, which only an access manager grants
        boolean bootstrap = jdbc.sql("select coalesce(bootstrap, false) from person where id = :p").param("p", delegate)
                .query(Boolean.class).optional().orElseThrow(() -> ApiException.validation("المفوض إليه غير موجود."));
        if (bootstrap) {
            throw ApiException.forbidden("هوية التهيئة الأولى مؤقتة ولا يُفوض إليها.");
        }
        Grant delegated = ctx.grants().stream().filter(g -> membership.equals(g.membershipId()) && g.delegationId() == null)
                .findFirst().orElseThrow();
        if (delegated.has(Permission.MANAGE_ACCESS) || delegated.has(Permission.CONFIGURE)
                || delegated.has(Permission.VIEW_SOURCE_IDENTIFIERS)) {
            throw ApiException.forbidden("لا تُفوض صلاحيات الإدارة (الصلاحيات أو التهيئة أو معرفات المصدر)؛ يمنحها مدير صلاحيات.");
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
