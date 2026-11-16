package ae.mover.authz;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.DirectoryScope;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.stationing.OrgHierarchy;
import ae.mover.stationing.OrgUnit;

/**
 * «إدارة الصلاحيات والوحدات», TNQL's access workspace (owner, 11 Nov 2026; ADR-058): search first, then work inside one unit.
 * The units and people of the manager's reach with counts, one unit's file, its matrix with the state of every cell (direct,
 * inherited from the unit, temporary, locked and why), roles given to the whole unit, and a staged save: the page sends the
 * ticked changes for review, gets a fingerprint of the cells they touch, and applies them together — all or nothing, refused
 * when anything changed since the review — under one audit reference.
 */
@Service
public class AccessWorkspaceService {

    public static final int PAGE = 25;
    public static final int MAX_BATCH = 60;

    /** The roles of a request's journey come first, in its order (as in the matrix of the movement programme). */
    private static final List<String> FIRST = List.of("REQUESTER", "CHAIN_APPROVER", "UNIT_OPERATIONS_APPROVER", "FINAL_APPROVER", "FYI_RECEIVER");

    /**
     * What a role given to a whole unit may contain: requesting, reading and the requester's own steps on a request (EXECUTE:
     * confirming receipt; CLOSE), never deciding or managing (ADR-058).
     */
    private static final Set<Permission> UNIT_SAFE = EnumSet.of(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.CREATE, Permission.EDIT,
            Permission.EXECUTE, Permission.CLOSE, Permission.CREATE_RESTATIONING, Permission.CREATE_DEPLOYMENT_REQUEST, Permission.REQUEST_SITE_REGISTRATION,
            Permission.CREATE_INITIAL_STATIONING);

    public record Op(String personId, String roleCode, String action) {
    }

    /** {@code wholeUnit}: the manager confirms a change that reaches every member of the unit (TNQL). */
    public record Batch(List<Op> ops, String fingerprint, String reason, Boolean wholeUnit) {
    }

    public record UnitGrantInput(String roleCode, Boolean on, String reason) {
    }

    record Role(String code, String name, Set<Permission> permissions, String scope, boolean system, int sort) {

        /**
         * How its cell works: AVAIL, the departments of «معتمد التوفر» as chips in one column; ADMIN, «مسؤول إدارة الوصول
         * والصلاحيات» with its separate rights; ASSIGN, a «تعيين» over chosen units; CHECK, a tick saved with the batch. All but
         * CHECK save at once, as TNQL's.
         */
        String mode() {
            if (code.startsWith(AccessAdminService.AVAILABILITY_PREFIX)) {
                return "AVAIL";
            }
            if (permissions.contains(Permission.MANAGE_ACCESS)) {
                return "ADMIN";
            }
            return assign() ? "ASSIGN" : "CHECK";
        }

        boolean assign() {
            // «معتمد السلسلة الهرمية» too since 16 Nov 2026 (ADR-061): a «تعيين» cell with its levels, saved at once, as TNQL's
            return permissions.contains(Permission.REVIEW) || permissions.contains(Permission.APPROVE) || "FYI_RECEIVER".equals(code);
        }

        boolean unitGrantable() {
            return !system && "CHECK".equals(mode()) && !"CHAIN_APPROVER".equals(code) && UNIT_SAFE.containsAll(permissions);
        }
    }

    private final JdbcClient jdbc;
    private final Clock clock;
    private final GrantAdminService grants;
    private final DirectoryScope directory;
    private final OrgHierarchy hierarchy;
    private final AuditService audit;
    private final ae.mover.access.AccessRights rights;

    public AccessWorkspaceService(JdbcClient jdbc, Clock clock, GrantAdminService grants, DirectoryScope directory, OrgHierarchy hierarchy,
                                  AuditService audit, ae.mover.access.AccessRights rights) {
        this.rights = rights;
        this.jdbc = jdbc;
        this.clock = clock;
        this.grants = grants;
        this.directory = directory;
        this.hierarchy = hierarchy;
        this.audit = audit;
    }

    // ---- reach ----------------------------------------------------------------------------------------------------

    private DirectoryScope.Reach reach(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        return directory.reach(ctx);
    }

    private static String orgFilter(DirectoryScope.Reach r, String column) {
        return r.global() ? "" : " and " + column + " = any(string_to_array(:reach, ',')::uuid[])";
    }

    private void requireUnit(AccessContext ctx, UUID org) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (!ctx.canFor(Permission.MANAGE_ACCESS, org)) {
            throw ApiException.notFound();
        }
    }

    /**
     * «مستخدمو الوحدة» as TNQL's (owner, 16 Nov 2026: «لا تضيف بشكل آلي — تم إضافتهم من خلال طلب الصلاحيات أو البحث»): a person
     * added to the unit — from «إضافة مستخدم» or an approved access request ({@code unit_member}) — or holding a grant made at it.
     * An HR posting, an HR position (a responsibility seat) or a sign-in alone never makes a user; those people still hold what
     * HR gives them (GrantSource), they are only not listed or counted here.
     */
    static final String USERS = """
            (select person_id, organization_id from unit_member where ended_at is null
             union select person_id, organization_id from membership where valid_to is null or valid_to > now())""";

    /** The platform and first-setup accounts are listed only for a manager over everything, as TNQL hides them from a scoped one. */
    private static String platformFilter(DirectoryScope.Reach r, String person) {
        return r.global() ? "" : " and not (coalesce(" + person + ".bootstrap, false) or (" + person + ".source = 'LOCAL' and "
                + person + ".employee_no like 'PLATFORM-%'))";
    }

    /** The four counters of the page: units in reach, their people, the active among them, and the rows a page shows. */
    public Map<String, Object> summary(AccessContext ctx) {
        DirectoryScope.Reach r = reach(ctx);
        String reachIds = Db.ids(r.orgs());
        long units = jdbc.sql("select count(*) from organization o where o.status = 'ACTIVE'" + orgFilter(r, "o.id"))
                .param("reach", reachIds).query(Long.class).single();
        Map<String, Object> people = jdbc.sql("select count(distinct p.id) as total, count(distinct p.id) filter (where p.status = 'ACTIVE' and not p.access_disabled) as active from "
                        + USERS + " mem join person p on p.id = mem.person_id where true" + orgFilter(r, "mem.organization_id") + platformFilter(r, "p"))
                .param("reach", reachIds).query().singleRow();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("units", units);
        out.put("people", ((Number) people.get("total")).longValue());
        out.put("active", ((Number) people.get("active")).longValue());
        out.put("pageSize", PAGE);
        out.put("global", r.global());
        return out;
    }

    /** One level of the unit tree, with each unit's sub-units and people: the top of the reach, or the children of a unit. */
    public List<Map<String, Object>> tree(AccessContext ctx, UUID parent) {
        DirectoryScope.Reach r = reach(ctx);
        String where;
        if (parent != null) {
            requireUnit(ctx, parent);
            where = "o.parent_id = :parent";
        } else if (r.global()) {
            where = "o.parent_id is null";
        } else {
            // the top of a scoped manager's reach: units in it whose parent is not
            where = "o.id = any(string_to_array(:reach, ',')::uuid[]) and (o.parent_id is null or not o.parent_id = any(string_to_array(:reach, ',')::uuid[]))";
        }
        return jdbc.sql("""
                select o.id, o.name, o.code, coalesce(h.is_main, false) as main,
                       (select count(*) from organization c where c.parent_id = o.id and c.status = 'ACTIVE') as children,
                       (select count(distinct mem.person_id) from """ + USERS + """
                         mem join person p on p.id = mem.person_id where mem.organization_id = o.id""" + platformFilter(r, "p") + """
                       ) as people
                from organization o
                left join hr_unit h on h.external_id = o.source_external_id and h.snapshot_id = (select s.id from hr_snapshot s where s.status = 'PUBLISHED')
                where o.status = 'ACTIVE'""" + " and " + where + " order by o.name limit 500")
                .param("parent", parent).param("reach", Db.ids(r.orgs())).query().listOfRows().stream().map(row -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", row.get("id").toString());
                    m.put("name", row.get("name"));
                    m.put("code", row.get("code"));
                    m.put("main", row.get("main"));
                    m.put("childCount", ((Number) row.get("children")).intValue());
                    m.put("peopleCount", ((Number) row.get("people")).intValue());
                    return m;
                }).toList();
    }

    private String path(UUID org) {
        List<OrgUnit> p = new ArrayList<>(hierarchy.path(org));
        java.util.Collections.reverse(p);
        return String.join(" / ", p.stream().map(OrgUnit::name).toList());
    }

    /** The unit's ancestors as ids, the top first, without the unit: the tree opens them to show it (MOVER's revealUnit). */
    private List<String> trail(UUID org) {
        List<OrgUnit> p = new ArrayList<>(hierarchy.path(org));
        java.util.Collections.reverse(p);
        return p.stream().filter(u -> !u.id().equals(org)).map(u -> u.id().toString()).toList();
    }

    /** «ابحث أولاً»: units by name or code, or people by name, employee number or login — inside the reach, each with its path. */
    public List<Map<String, Object>> search(AccessContext ctx, String q, String kind) {
        DirectoryScope.Reach r = reach(ctx);
        if (q == null || q.isBlank()) {
            return List.of();
        }
        String like = "%" + q.trim() + "%";
        String reachIds = Db.ids(r.orgs());
        List<Map<String, Object>> out = new ArrayList<>();
        if ("PEOPLE".equalsIgnoreCase(kind)) {
            if (!rights.can(ctx, ae.mover.access.AccessRights.Right.LOOKUP, null)) {
                throw ApiException.forbidden("البحث عن الموظفين يحتاج حق «البحث عن الموظفين».");
            }
            for (Map<String, Object> row : jdbc.sql("""
                    select distinct on (p.id) p.id, p.display_name, p.employee_no, p.username, p.status, o.id as org_id, o.name as org_name
                    from person p join """ + USERS + """
                     mem on mem.person_id = p.id join organization o on o.id = mem.organization_id and o.status = 'ACTIVE'
                    where (p.display_name ilike :q or p.employee_no ilike :q or coalesce(p.username, '') ilike :q)""" + orgFilter(r, "mem.organization_id") + platformFilter(r, "p") + """
                     order by p.id limit 25""").param("q", like).param("reach", reachIds).query().listOfRows()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", row.get("id").toString());
                m.put("displayName", row.get("display_name"));
                m.put("employeeNo", shownNumber((String) row.get("employee_no"), (String) row.get("username")));
                m.put("active", "ACTIVE".equals(row.get("status")));
                m.put("unit", Map.of("id", row.get("org_id").toString(), "name", row.get("org_name")));
                m.put("path", path((UUID) row.get("org_id")));
                out.add(m);
            }
            out.sort(java.util.Comparator.comparing(m -> (String) m.get("displayName")));
            return out;
        }
        for (Map<String, Object> row : jdbc.sql("select o.id, o.name, o.code from organization o where o.status = 'ACTIVE' and (o.name ilike :q or coalesce(o.code, '') ilike :q)"
                + orgFilter(r, "o.id") + " order by o.name limit 25").param("q", like).param("reach", reachIds).query().listOfRows()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", row.get("id").toString());
            m.put("name", row.get("name"));
            m.put("code", row.get("code"));
            m.put("path", path((UUID) row.get("id")));
            out.add(m);
        }
        return out;
    }

    private static String shownNumber(String employeeNo, String username) {
        // a User ID added without HR is shown by its login, not its internal key
        return employeeNo != null && employeeNo.startsWith(UnitMemberService.LOCAL_USER_PREFIX) && username != null ? username : employeeNo;
    }

    // ---- roles ----------------------------------------------------------------------------------------------------

    List<Role> roles() {
        List<Role> out = new ArrayList<>(jdbc.sql("select code, name, permissions, scope, system, sort_order from role_def")
                .query((rs, n) -> new Role(rs.getString("code"), rs.getString("name"), GrantAdminService.permissions(rs.getArray("permissions")),
                        rs.getString("scope"), rs.getBoolean("system"), rs.getInt("sort_order"))).list());
        out.sort(java.util.Comparator.comparingInt((Role r) -> FIRST.contains(r.code()) ? FIRST.indexOf(r.code()) : FIRST.size())
                .thenComparingInt(Role::sort).thenComparing(Role::name));
        return out;
    }

    /** Why this manager may not give this role at this unit, or null when they may. */
    private String roleLock(AccessContext ctx, UUID org, Role role) {
        if (role.system()) {
            return "دور نظام يمنحه مدير المنصة";
        }
        try {
            grants.requireAuthorityForRole(ctx, org, role.code(), null);
            return null;
        } catch (ApiException e) {
            return GrantAdminService.FINAL_ROLES.contains(role.code()) ? "يمنحها مدير الصلاحيات العام فقط"
                    : "يمنحها مدير صلاحيات يشمل نطاقه هذه الوحدة ويُخوَّل منح هذا الدور";
        }
    }

    // ---- the unit file ---------------------------------------------------------------------------------------------

    /** «ملف الوحدة» (read only): name, level, parent, manager, people, active people, sub-units, and its roles given to all. */
    public Map<String, Object> unit(AccessContext ctx, UUID org) {
        requireUnit(ctx, org);
        Map<String, Object> u = jdbc.sql("""
                select o.id, o.name, o.code, o.parent_id, po.name as parent_name, h.level, coalesce(h.is_main, false) as main,
                       (select count(*) from organization c where c.parent_id = o.id and c.status = 'ACTIVE') as children
                from organization o left join organization po on po.id = o.parent_id
                left join hr_unit h on h.external_id = o.source_external_id and h.snapshot_id = (select s.id from hr_snapshot s where s.status = 'PUBLISHED')
                where o.id = :o""").param("o", org).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        Map<String, Object> people = jdbc.sql("select count(distinct p.id) as total, count(distinct p.id) filter (where p.status = 'ACTIVE' and not p.access_disabled) as active from "
                + USERS + " mem join person p on p.id = mem.person_id where mem.organization_id = :o" + platformFilter(directory.reach(ctx), "p"))
                .param("o", org).query().singleRow();
        List<String> managers = jdbc.sql("""
                select distinct p.display_name from membership m join role_def r on r.code = m.role_code join person p on p.id = m.person_id
                where m.organization_id = :o and 'MANAGE_ACCESS' = any(r.permissions) and not r.system and p.status = 'ACTIVE'
                  and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()) order by 1""").param("o", org).query(String.class).list();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", org.toString());
        out.put("name", u.get("name"));
        out.put("code", u.get("code"));
        out.put("level", u.get("level"));
        out.put("main", u.get("main"));
        out.put("parent", u.get("parent_id") == null ? null : Map.of("id", u.get("parent_id").toString(), "name", u.get("parent_name")));
        out.put("managers", managers);
        out.put("people", ((Number) people.get("total")).longValue());
        out.put("active", ((Number) people.get("active")).longValue());
        out.put("children", ((Number) u.get("children")).intValue());
        out.put("path", path(org));
        out.put("trail", trail(org));
        Map<String, Map<String, Object>> given = new HashMap<>();
        jdbc.sql("""
                select ug.id, ug.role_code, ug.valid_from, g.display_name from unit_grant ug left join person g on g.id = ug.granted_by
                where ug.organization_id = :o and ug.valid_to is null""").param("o", org).query().listOfRows()
                .forEach(row -> given.put((String) row.get("role_code"), row));
        List<Map<String, Object>> inherited = new ArrayList<>();
        List<Map<String, Object>> offer = new ArrayList<>();
        for (Role role : roles()) {
            Map<String, Object> g = given.get(role.code());
            if (g != null) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("code", role.code());
                m.put("name", role.name());
                m.put("scope", role.scope());
                m.put("since", Db.toInstant(g.get("valid_from")).toString());
                m.put("grantedBy", g.get("display_name"));
                inherited.add(m);
            }
            if (role.unitGrantable()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("code", role.code());
                m.put("name", role.name());
                m.put("on", g != null);
                m.put("lock", roleLock(ctx, org, role));
                offer.add(m);
            }
        }
        out.put("inherited", inherited);
        out.put("unitRoles", offer);
        out.put("providers", jdbc.sql("select role_code from provider_unit where organization_id = :o order by 1").param("o", org).query(String.class).list());
        // what this manager may do here, to show the page's controls; the server checks each call again (ADR-059)
        out.put("myRights", java.util.Arrays.stream(ae.mover.access.AccessRights.Right.values())
                .filter(r -> rights.can(ctx, r, org)).map(Enum::name).toList());
        return out;
    }

    /** Gives a role to the whole unit, or ends it: every member inherits it while both last (V36). */
    @Transactional
    public Map<String, Object> setUnitGrant(AccessContext ctx, UUID org, UnitGrantInput in) {
        requireUnit(ctx, org);
        Role role = roles().stream().filter(r -> in != null && r.code().equals(in.roleCode())).findFirst()
                .orElseThrow(() -> ApiException.validation("الدور غير موجود في السياسة المنشورة."));
        if (!role.unitGrantable()) {
            throw ApiException.validation("هذا الدور يُمنح لشخص بعينه، ولا يُمنح لكل أعضاء الوحدة.");
        }
        grants.requireAuthorityForRole(ctx, org, role.code(), null);
        UUID current = jdbc.sql("select id from unit_grant where organization_id = :o and role_code = :r and valid_to is null for update")
                .param("o", org).param("r", role.code()).query(UUID.class).optional().orElse(null);
        if (Boolean.TRUE.equals(in.on())) {
            if (current == null) {
                UUID id = UUID.randomUUID();
                jdbc.sql("insert into unit_grant(id, organization_id, role_code, valid_from, granted_by) values (:id, :o, :r, :f, :by)")
                        .param("id", id).param("o", org).param("r", role.code()).param("f", Db.ts(clock.instant())).param("by", ctx.personId()).update();
                audit.recordAs(ctx.actor(), "UNIT_GRANT_ADDED", "ORGANIZATION", org.toString(), null,
                        Map.of("organizationId", org.toString(), "role", role.code(), "unitGrantId", id.toString()), in.reason());
            }
        } else if (current != null) {
            if (in.reason() == null || in.reason().isBlank()) {
                throw ApiException.validation("اذكر سبب سحب الصلاحية من أعضاء الوحدة.");
            }
            jdbc.sql("update unit_grant set valid_to = :t, ended_by = :by, ended_reason = :why where id = :id")
                    .param("t", Db.ts(clock.instant())).param("by", ctx.personId()).param("why", in.reason().trim()).param("id", current).update();
            audit.recordAs(ctx.actor(), "UNIT_GRANT_ENDED", "ORGANIZATION", org.toString(), null,
                    Map.of("organizationId", org.toString(), "role", role.code(), "unitGrantId", current.toString()), in.reason().trim());
        }
        return unit(ctx, org);
    }

    // ---- the matrix ------------------------------------------------------------------------------------------------

    /**
     * One unit's people, 25 a page, and every role's cell for each: {@code direct} (a grant made at this unit, editable),
     * {@code inherited} ({@code UNIT}: given to the unit; {@code SEAT}: the person's HR position), {@code temporary} (a direct
     * grant with an end, or a delegation received for this unit), and why a cell is locked.
     */
    public Map<String, Object> matrix(AccessContext ctx, UUID org, String q, Integer page, String roleFilter) {
        requireUnit(ctx, org);
        String like = q == null || q.isBlank() ? null : "%" + q.trim() + "%";
        String role = roleFilter == null || roleFilter.isBlank() ? null : roleFilter;
        String hide = platformFilter(directory.reach(ctx), "p");
        String people = """
                from person p left join unit_member um on um.person_id = p.id and um.organization_id = :o and um.ended_at is null
                where (um.id is not null
                    or exists (select 1 from membership m where m.person_id = p.id and m.organization_id = :o and (m.valid_to is null or m.valid_to > now())))
                  and (cast(:q as text) is null or p.display_name ilike :q or p.employee_no ilike :q or coalesce(p.username, '') ilike :q)
                  and (cast(:role as text) is null
                    or exists (select 1 from membership m where m.person_id = p.id and m.organization_id = :o and m.role_code = :role
                                 and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
                    or exists (select 1 from unit_grant ug where ug.organization_id = :o and ug.role_code = :role and ug.valid_to is null
                                 and (um.id is not null or exists (select 1 from affiliation a where a.person_id = p.id and a.organization_id = :o and a.valid_to is null))))""" + hide;
        long total = jdbc.sql("select count(*) " + people).param("o", org).param("q", like).param("role", role).query(Long.class).single();
        int pageNo = Math.max(0, page == null ? 0 : page);
        List<Map<String, Object>> rows = jdbc.sql("""
                select p.id, p.display_name, p.employee_no, p.username, p.status, coalesce(p.bootstrap, false) as bootstrap,
                       p.hr_unavailable, p.access_disabled,
                       um.id is not null as added, coalesce(um.acting, false) as acting,
                       exists (select 1 from affiliation a where a.person_id = p.id and a.organization_id = :o and a.valid_to is null) as posted,
                       exists (select 1 from identity_link l where l.person_id = p.id and l.method = 'PLATFORM') as platform
                """ + people + " order by p.display_name limit " + PAGE + " offset :from")
                .param("o", org).param("q", like).param("role", role).param("from", pageNo * PAGE).query().listOfRows();
        List<Role> roles = roles().stream().filter(r -> !r.system()).toList();
        List<Map<String, Object>> columns = new ArrayList<>();
        for (Role r : roles) {
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("code", r.code());
            c.put("name", r.name());
            c.put("mode", r.mode());
            c.put("finalOnly", GrantAdminService.FINAL_ROLES.contains(r.code()));
            c.put("lock", roleLock(ctx, org, r));
            columns.add(c);
        }
        Set<String> unitRoles = new java.util.HashSet<>(jdbc.sql("select role_code from unit_grant where organization_id = :o and valid_to is null")
                .param("o", org).query(String.class).list());
        List<UUID> ids = rows.stream().map(r -> (UUID) r.get("id")).toList();
        Map<UUID, Set<String>> seats = new HashMap<>();
        Map<UUID, Set<String>> delegated = new HashMap<>();
        // TNQL's separate columns (owner, 16 Nov 2026): rank and position from the published HR record, the position falling
        // back to the person's current affiliation (this unit's first); one query for the page, by primary key
        Map<UUID, String[]> hr = new HashMap<>();
        if (!ids.isEmpty()) {
            jdbc.sql("""
                    select p.id, h.rank_name,
                           coalesce(h.position_title, (select a.position_title from affiliation a where a.person_id = p.id and a.valid_to is null
                                                        order by (a.organization_id = :o) desc, a.valid_from desc limit 1)) as position
                    from person p
                    left join hr_person h on p.source = 'HR' and h.external_id = p.source_external_id
                                         and h.snapshot_id in (select id from hr_snapshot where status = 'PUBLISHED')
                    where p.id = any(string_to_array(:ids, ',')::uuid[])""")
                    .param("o", org).param("ids", Db.ids(ids))
                    .query((rs, n) -> hr.put(Db.uuid(rs, "id"), new String[] {rs.getString("rank_name"), rs.getString("position")})).list();
        }
        if (!ids.isEmpty()) {
            jdbc.sql("""
                    select a.person_id, ps.role_code from affiliation a
                    join position_seat ps on ps.organization_id = a.organization_id and ps.position_id = a.position_id and ps.active
                    where a.organization_id = :o and a.valid_to is null and a.person_id = any(string_to_array(:ids, ',')::uuid[])""")
                    .param("o", org).param("ids", Db.ids(ids))
                    .query((rs, n) -> seats.computeIfAbsent(Db.uuid(rs, "person_id"), k -> new java.util.HashSet<>()).add(rs.getString("role_code"))).list();
            jdbc.sql("""
                    select d.delegate_id, m.role_code from delegation d join membership m on m.id = d.membership_id
                    where m.organization_id = :o and d.revoked_at is null and d.valid_from <= now() and d.valid_to > now()
                      and d.delegate_id = any(string_to_array(:ids, ',')::uuid[])""")
                    .param("o", org).param("ids", Db.ids(ids))
                    .query((rs, n) -> delegated.computeIfAbsent(Db.uuid(rs, "delegate_id"), k -> new java.util.HashSet<>()).add(rs.getString("role_code"))).list();
            // an activated duty permit in its window is temporary too (ADR-059)
            jdbc.sql("""
                    select person_id, role_code from duty_permit where organization_id = :o and activated_at is not null and ended_at is null
                      and valid_from <= now() and valid_to > now() and person_id = any(string_to_array(:ids, ',')::uuid[])""")
                    .param("o", org).param("ids", Db.ids(ids))
                    .query((rs, n) -> delegated.computeIfAbsent(Db.uuid(rs, "person_id"), k -> new java.util.HashSet<>()).add(rs.getString("role_code"))).list();
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> p : rows) {
            UUID id = (UUID) p.get("id");
            List<GrantAdminService.GrantView> held = grants.list(ctx, org, id, false).stream().filter(GrantAdminService.GrantView::active).toList();
            boolean member = (Boolean) p.get("posted") || (Boolean) p.get("added");
            String no = (String) p.get("employee_no");
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", id.toString());
            row.put("displayName", p.get("display_name"));
            row.put("employeeNo", shownNumber(no, (String) p.get("username")));
            String[] hrInfo = hr.getOrDefault(id, new String[2]);
            row.put("rank", hrInfo[0]);
            row.put("position", hrInfo[1]);
            row.put("username", p.get("username"));
            row.put("active", "ACTIVE".equals(p.get("status")));
            row.put("added", p.get("added"));
            row.put("acting", p.get("acting"));
            row.put("withoutHr", no != null && no.startsWith(UnitMemberService.LOCAL_USER_PREFIX));
            row.put("lock", personLock(ctx, id, (Boolean) p.get("bootstrap"), (Boolean) p.get("platform")));
            row.put("hrUnavailable", p.get("hr_unavailable"));
            row.put("accessDisabled", p.get("access_disabled"));
            Map<String, Object> cells = new LinkedHashMap<>();
            int effective = 0;
            for (Role r : roles) {
                GrantAdminService.GrantView direct = held.stream().filter(g -> g.role().get("code").equals(r.code())).findFirst().orElse(null);
                String inherited = member && unitRoles.contains(r.code()) ? "UNIT" : seats.getOrDefault(id, Set.of()).contains(r.code()) ? "SEAT" : null;
                boolean temporary = (direct != null && direct.validTo() != null) || delegated.getOrDefault(id, Set.of()).contains(r.code());
                Map<String, Object> cell = new LinkedHashMap<>();
                cell.put("direct", direct == null ? null : Map.of("id", direct.id(), "scopeText", direct.scopeText(),
                        "validTo", direct.validTo() == null ? "" : direct.validTo(), "all", direct.all(),
                        "units", direct.targets().stream().filter(t -> "ORGANIZATION".equals(t.kind())).count()));
                cell.put("inherited", inherited);
                cell.put("temporary", temporary);
                if (direct != null || inherited != null || temporary) {
                    effective++;
                }
                cells.put(r.code(), cell);
            }
            row.put("cells", cells);
            row.put("effective", effective);
            row.put("grants", held);
            out.add(row);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("total", total);
        result.put("page", pageNo);
        result.put("pageSize", PAGE);
        result.put("columns", columns);
        result.put("people", out);
        result.put("providers", jdbc.sql("select role_code from provider_unit where organization_id = :o order by 1").param("o", org).query(String.class).list());
        return result;
    }

    private String personLock(AccessContext ctx, UUID person, boolean bootstrap, boolean platform) {
        if (grants.keys().same(ctx.personId(), person)) {
            return "صلاحياتك يعدّلها مدير صلاحيات آخر";
        }
        if (bootstrap || platform) {
            return "حساب نظام؛ لا تُعدَّل صلاحياته من هنا";
        }
        return null;
    }

    // ---- the staged save -------------------------------------------------------------------------------------------

    private record Checked(Op op, UUID person, Role role, boolean grant, UUID grantId, String problem) {
    }

    private List<Checked> check(AccessContext ctx, UUID org, List<Op> ops) {
        if (ops == null || ops.isEmpty()) {
            throw ApiException.validation("لا توجد تعديلات معلّقة.");
        }
        if (ops.size() > MAX_BATCH) {
            throw ApiException.validation("الحفظة الواحدة حتى " + MAX_BATCH + " تعديلاً؛ احفظ على دفعات.");
        }
        Map<String, Role> roles = new HashMap<>();
        roles().forEach(r -> roles.put(r.code(), r));
        Set<String> seen = new java.util.HashSet<>();
        List<Checked> out = new ArrayList<>();
        for (Op op : ops) {
            if (op == null || op.personId() == null || op.roleCode() == null || !List.of("GRANT", "REVOKE").contains(op.action())) {
                throw ApiException.validation("تعديل غير مكتمل.");
            }
            UUID person;
            try {
                person = UUID.fromString(op.personId());
            } catch (IllegalArgumentException e) {
                throw ApiException.validation("معرف الشخص غير صحيح.");
            }
            if (!seen.add(person + "|" + op.roleCode())) {
                throw ApiException.validation("الخلية نفسها مكررة في الحفظة.");
            }
            Role role = roles.get(op.roleCode());
            boolean grant = "GRANT".equals(op.action());
            UUID held = jdbc.sql("""
                    select id from membership where person_id = :p and organization_id = :o and role_code = :r
                      and valid_from <= now() and (valid_to is null or valid_to > now()) order by valid_from limit 1""")
                    .param("p", person).param("o", org).param("r", op.roleCode()).query(UUID.class).optional().orElse(null);
            String problem = null;
            if (role == null || role.system()) {
                problem = "الدور غير موجود في السياسة المنشورة";
            } else if (!"CHECK".equals(role.mode())) {
                problem = "تُعيَّن هذه الصلاحية من خليتها وتُحفظ فوراً";
            } else if (grant && held != null) {
                problem = "ممنوحة بالفعل";
            } else if (!grant && held == null) {
                problem = "ليست ممنوحة مباشرة في هذه الوحدة";
            } else {
                try {
                    if (grant) {
                        grants.requireGrantee(ctx, person);
                    } else if (grants.keys().same(ctx.personId(), person)) {
                        throw ApiException.forbidden("صلاحياتك يعدّلها مدير صلاحيات آخر");
                    }
                    grants.requireAuthorityForRole(ctx, org, role.code(), null);
                } catch (ApiException e) {
                    problem = e.getMessage();
                }
            }
            out.add(new Checked(op, person, role, grant, held, problem));
        }
        return out;
    }

    /** The cells a batch touches, as they are now: the grants made at this unit for each person and role. */
    private String fingerprint(UUID org, List<Checked> checked) {
        TreeSet<String> lines = new TreeSet<>();
        for (Checked c : checked) {
            List<String> ids = jdbc.sql("""
                    select id::text from membership where person_id = :p and organization_id = :o and role_code = :r
                      and valid_from <= now() and (valid_to is null or valid_to > now()) order by 1""")
                    .param("p", c.person()).param("o", org).param("r", c.op().roleCode()).query(String.class).list();
            lines.add(c.person() + "|" + c.op().roleCode() + "|" + String.join(",", ids));
        }
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(String.join("\n", lines).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(h).substring(0, 24);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Reviews a batch without saving: each change with its refusal if any, the counts, and the fingerprint to apply with. */
    public Map<String, Object> preview(AccessContext ctx, UUID org, Batch batch) {
        requireUnit(ctx, org);
        List<Checked> checked = check(ctx, org, batch == null ? null : batch.ops());
        Map<UUID, String> names = names(checked);
        List<Map<String, Object>> lines = new ArrayList<>();
        for (Checked c : checked) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("personId", c.person().toString());
            m.put("person", names.getOrDefault(c.person(), ""));
            m.put("roleCode", c.op().roleCode());
            m.put("role", c.role() == null ? c.op().roleCode() : c.role().name());
            m.put("action", c.op().action());
            m.put("problem", c.problem());
            lines.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("fingerprint", fingerprint(org, checked));
        out.put("grants", checked.stream().filter(Checked::grant).count());
        out.put("revokes", checked.stream().filter(c -> !c.grant()).count());
        out.put("people", checked.stream().map(Checked::person).distinct().count());
        out.put("ok", checked.stream().allMatch(c -> c.problem() == null));
        out.put("wholeUnit", wholeUnit(org, checked));
        out.put("lines", lines);
        return out;
    }

    /**
     * Applies a reviewed batch together, or nothing: refused when a cell changed since the review (the fingerprint differs),
     * or when any change is refused. Every grant made or ended carries the batch's one audit reference.
     */
    @Transactional
    public Map<String, Object> apply(AccessContext ctx, UUID org, Batch batch) {
        requireUnit(ctx, org);
        if (batch == null || batch.fingerprint() == null) {
            throw ApiException.validation("راجع التعديلات قبل حفظها.");
        }
        // one batch at a time per unit, so two managers saving the same cells cannot both pass the fingerprint
        jdbc.sql("select id from organization where id = :o for update").param("o", org).query(UUID.class).single();
        List<Checked> checked = check(ctx, org, batch.ops());
        if (!fingerprint(org, checked).equals(batch.fingerprint())) {
            throw new ApiException(ErrorCode.STALE_REVISION, "تغيّرت هذه الصلاحيات منذ المراجعة؛ أعد المراجعة ثم احفظ.");
        }
        for (Checked c : checked) {
            if (c.problem() != null) {
                throw ApiException.validation("لم يُحفظ شيء: " + c.problem() + ".", Map.of("personId", c.person().toString(), "roleCode", c.op().roleCode()));
            }
        }
        if (wholeUnit(org, checked) && !Boolean.TRUE.equals(batch.wholeUnit())) {
            throw ApiException.validation("هذا التعديل يشمل كل مستخدمي الوحدة؛ أكّد ذلك صراحة قبل الحفظ.");
        }
        String reference = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String reason = batch.reason() == null || batch.reason().isBlank() ? "حفظ التعديلات من إدارة الصلاحيات والوحدات" : batch.reason().trim();
        String today = clock.instant().toString();
        for (Checked c : checked) {
            if (c.grant()) {
                grants.create(ctx, new GrantAdminService.GrantInput(c.person().toString(), org.toString(), c.role().code(), null, null, today, null,
                        new GrantAdminService.ScopeInput("ROLE", false, "AND", List.of())), reference);
            } else {
                grants.end(ctx, c.grantId(), null, reason, reference);
            }
        }
        Set<UUID> affected = new LinkedHashSet<>();
        checked.forEach(c -> affected.add(c.person()));
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("reference", reference);
        detail.put("organizationId", org.toString());
        detail.put("grants", checked.stream().filter(Checked::grant).count());
        detail.put("revokes", checked.stream().filter(c -> !c.grant()).count());
        detail.put("people", affected.size());
        audit.recordAs(ctx.actor(), "ACCESS_BATCH_SAVED", "ORGANIZATION", org.toString(), null, detail, reason);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("reference", reference);
        out.put("applied", checked.size());
        out.put("affected", affected.size());
        return out;
    }

    /** Whether one change (a role, granted or removed) reaches every member of the unit, more than one (TNQL's acknowledgement). */
    private boolean wholeUnit(UUID org, List<Checked> checked) {
        long members = jdbc.sql("select count(distinct person_id) from " + USERS + " mem where mem.organization_id = :o").param("o", org).query(Long.class).single();
        if (members < 2) {
            return false;
        }
        Map<String, Set<UUID>> groups = new HashMap<>();
        checked.forEach(c -> groups.computeIfAbsent(c.op().roleCode() + "|" + c.op().action(), k -> new java.util.HashSet<>()).add(c.person()));
        return groups.values().stream().anyMatch(g -> g.size() >= members);
    }

    private Map<UUID, String> names(List<Checked> checked) {
        Map<UUID, String> out = new HashMap<>();
        if (!checked.isEmpty()) {
            jdbc.sql("select id, display_name from person where id = any(string_to_array(:ids, ',')::uuid[])")
                    .param("ids", Db.ids(checked.stream().map(Checked::person).distinct().toList()))
                    .query((rs, n) -> out.put(Db.uuid(rs, "id"), rs.getString("display_name"))).list();
        }
        return out;
    }

    // ---- the audit tab ---------------------------------------------------------------------------------------------

    /** «مصفوفة التدقيق»: every change of this unit's permissions, newest first, with who made it, why, and the batch reference. */
    public Map<String, Object> history(AccessContext ctx, UUID org, Integer page) {
        requireUnit(ctx, org);
        int pageNo = Math.max(0, page == null ? 0 : page);
        String where = """
                from audit_event e left join person p on e.entity_type = 'PERSON' and p.id::text = e.entity_id
                left join role_def r on r.code = e.detail->>'role'
                where e.action in ('MEMBERSHIP_CREATED', 'MEMBERSHIP_ENDED', 'UNIT_GRANT_ADDED', 'UNIT_GRANT_ENDED', 'ACCESS_BATCH_SAVED',
                                   'UNIT_MEMBER_ADDED', 'UNIT_MEMBER_ENDED')
                  and (e.detail->>'organizationId' = :o or (e.entity_type = 'ORGANIZATION' and e.entity_id = :o))""";
        long total = jdbc.sql("select count(*) " + where).param("o", org.toString()).query(Long.class).single();
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> e : jdbc.sql("""
                select e.id, e.occurred_at, e.action, e.actor_name, e.reason, p.display_name as person, p.employee_no,
                       coalesce(r.name, e.detail->>'role') as role, coalesce(e.detail->>'batch', e.detail->>'reference') as reference,
                       e.detail->>'grants' as grants, e.detail->>'revokes' as revokes
                """ + where + " order by e.id desc limit " + PAGE + " offset :from")
                .param("o", org.toString()).param("from", pageNo * PAGE).query().listOfRows()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", ((Number) e.get("id")).longValue());
            m.put("at", Db.toInstant(e.get("occurred_at")).toString());
            m.put("action", e.get("action"));
            m.put("by", e.get("actor_name"));
            m.put("person", e.get("person"));
            m.put("employeeNo", e.get("employee_no"));
            m.put("role", e.get("role"));
            m.put("reference", e.get("reference"));
            m.put("reason", e.get("reason"));
            m.put("grants", e.get("grants"));
            m.put("revokes", e.get("revokes"));
            rows.add(m);
        }
        return Map.of("total", total, "page", pageNo, "rows", rows);
    }
}
