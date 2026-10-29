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

    public List<OrgNode> children(AccessContext ctx, UUID id) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_ACCESS, Permission.MANAGE_FACILITIES, Permission.CONFIGURE);
        Set<UUID> visible = visibleOrgs(ctx);
        return jdbc.sql("select id, code, name, parent_id, status from organization where parent_id = :id order by code")
                .param("id", id).query((rs, n) -> new OrgNode(rs.getString("id"), rs.getString("code"), rs.getString("name"),
                        rs.getString("parent_id"), rs.getString("status"), List.of(), 0, 0)).list()
                .stream().filter(o -> visible == null || visible.contains(UUID.fromString(o.id()))).toList();
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

    // ---- memberships --------------------------------------------------------------------------------

    public record MembershipInput(String personId, String organizationId, String roleCode, String positionTitle,
                                  String siteScopeId, String validFrom, String validTo) {
    }

    @Transactional
    public Map<String, Object> addMembership(AccessContext ctx, MembershipInput in) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (in == null || in.personId() == null || in.organizationId() == null || in.roleCode() == null) {
            throw ApiException.validation("حدد الشخص والجهة والدور.");
        }
        if (!ctx.canFor(Permission.MANAGE_ACCESS, UUID.fromString(in.organizationId()))) {
            throw ApiException.forbidden("لا تملك إدارة الصلاحيات على هذه الجهة.");
        }
        Instant from = in.validFrom() == null ? clock.instant() : Times.parse(in.validFrom(), "validFrom");
        Instant to = Times.parse(in.validTo(), "validTo");
        if (to != null && !to.isAfter(from)) {
            throw ApiException.validation("نهاية العضوية يجب أن تكون بعد بدايتها.");
        }
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("""
                    insert into membership(id, person_id, organization_id, role_code, position_title, site_scope_id, valid_from, valid_to)
                    values (:id, :p, :o, :r, :t, :s, :f, :to)""")
                    .param("id", id).param("p", UUID.fromString(in.personId())).param("o", UUID.fromString(in.organizationId()))
                    .param("r", in.roleCode()).param("t", in.positionTitle())
                    .param("s", in.siteScopeId() == null ? null : UUID.fromString(in.siteScopeId()))
                    .param("f", Db.ts(from)).param("to", Db.ts(to)).update();
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            throw ApiException.validation("الشخص أو الجهة أو الدور غير موجود.");
        }
        audit.recordAs(ctx.actor(), "MEMBERSHIP_CREATED", "PERSON", in.personId(), null,
                Map.of("organizationId", in.organizationId(), "role", in.roleCode()), null);
        return Map.of("id", id.toString());
    }

    /**
     * Ends a membership. Access derived from it (and delegations made from it) stops immediately because grants are
     * evaluated per request. Open tasks are role-pooled, so they remain with the other holders of the role; the
     * realignment is audited. Past decisions keep the capacity recorded at decision time.
     */
    @Transactional
    public Map<String, Object> endMembership(AccessContext ctx, UUID id, String endAt, String reason) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("اذكر سبب إنهاء العضوية.");
        }
        Map<String, Object> m = jdbc.sql("select person_id, organization_id, role_code, valid_from, valid_to from membership where id = :id for update")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        Instant end = endAt == null ? clock.instant() : Times.parse(endAt, "endAt");
        Instant from = Db.toInstant(m.get("valid_from"));
        if (!end.isAfter(from)) {
            end = from.plusMillis(1);
        }
        Instant currentEnd = Db.toInstant(m.get("valid_to"));
        if (currentEnd != null && !currentEnd.isAfter(end)) {
            throw ApiException.validation("العضوية منتهية بالفعل.");
        }
        jdbc.sql("update membership set valid_to = :e, ended_reason = :r where id = :id")
                .param("e", Db.ts(end)).param("r", reason).param("id", id).update();
        int pooled = jdbc.sql("""
                select count(*) from task_assignment where status = 'OPEN' and role_code = :role
                  and (target_org_id is null or target_org_id = :org)""")
                .param("role", m.get("role_code")).param("org", m.get("organization_id")).query(Integer.class).single();
        audit.recordAs(ctx.actor(), "MEMBERSHIP_ENDED", "PERSON", m.get("person_id").toString(), null,
                Map.of("membershipId", id.toString(), "endAt", end.toString()), reason);
        if (pooled > 0) {
            audit.recordAs(ctx.actor(), "TASKS_REALIGNED", "PERSON", m.get("person_id").toString(), null,
                    Map.of("openTasks", pooled, "rule", "المهام مسندة إلى الدور وتبقى لدى شاغليه الحاليين"), reason);
        }
        return Map.of("id", id.toString(), "validTo", end.toString(), "realignedTasks", pooled);
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
        Map<String, Object> d = jdbc.sql("select delegator_id, delegate_id, revoked_at from delegation where id = :id for update")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.personId().equals(d.get("delegator_id")) && !ctx.has(Permission.MANAGE_ACCESS)) {
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

    public record RoleDef(String code, String name, List<String> permissions, String scope, boolean summaryOnly, boolean system) {
    }

    public List<RoleDef> roles(AccessContext ctx) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_ACCESS, Permission.CONFIGURE);
        return jdbc.sql("select * from role_def order by sort_order, code")
                .query((rs, n) -> new RoleDef(rs.getString("code"), rs.getString("name"), Db.strings(rs, "permissions"),
                        rs.getString("scope"), rs.getBoolean("summary_only"), rs.getBoolean("system"))).list();
    }

    public record RoleInput(List<String> permissions, String scope, Boolean summaryOnly) {
    }

    @Transactional
    public RoleDef updateRole(AccessContext ctx, String code, RoleInput in) {
        ctx.require(Permission.MANAGE_ACCESS);
        Map<String, Object> row = jdbc.sql("select system, permissions, scope, summary_only from role_def where code = :c for update")
                .param("c", code).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if ((Boolean) row.get("system")) {
            throw ApiException.validation("دور مدير النظام محمي ولا يُعدل من هذه الشاشة.");
        }
        if (in == null || in.permissions() == null || in.scope() == null) {
            throw ApiException.validation("حدد الصلاحيات والنطاق.");
        }
        for (String p : in.permissions()) {
            try {
                Permission.valueOf(p);
            } catch (IllegalArgumentException e) {
                throw ApiException.validation("صلاحية غير معروفة: " + p);
            }
        }
        if (!List.of("ALL", "ORGANIZATION", "SITE", "ORGANIZATION_AND_SITE").contains(in.scope())) {
            throw ApiException.validation("نطاق البيانات غير معروف.");
        }
        jdbc.sql("update role_def set permissions = string_to_array(:p, ','), scope = :s, summary_only = :so, updated_at = :now where code = :c")
                .param("p", String.join(",", new java.util.LinkedHashSet<>(in.permissions()))).param("s", in.scope())
                .param("so", Boolean.TRUE.equals(in.summaryOnly())).param("now", Db.ts(clock.instant())).param("c", code).update();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("permissions", in.permissions());
        detail.put("scope", in.scope());
        detail.put("summaryOnly", Boolean.TRUE.equals(in.summaryOnly()));
        audit.recordAs(ctx.actor(), "ROLE_UPDATED", "ROLE", code, code, detail, null);
        return roles(ctx).stream().filter(r -> r.code().equals(code)).findFirst().orElseThrow();
    }
}
