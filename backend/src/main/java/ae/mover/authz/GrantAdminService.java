package ae.mover.authz;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Grant;
import ae.mover.access.GrantSource;
import ae.mover.access.GrantTarget;
import ae.mover.access.Permission;
import ae.mover.access.RawGrant;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Ref;
import ae.mover.common.Times;

/**
 * Scoped grants (memberships): creation within the granter's own authority, ending, listing and an Arabic description
 * of each scope. A grant's targets are fixed once created; a different scope is a new grant.
 */
@Service
public class GrantAdminService {

    /** Actions only a global access manager may hand out, whatever the role's grantable list says. */
    private static final Set<Permission> SYSTEM_ACTIONS = EnumSet.of(Permission.CONFIGURE, Permission.VIEW_SOURCE_IDENTIFIERS);

    public record TargetInput(String kind, String id, Boolean includeDescendants) {
    }

    public record ScopeInput(String mode, Boolean all, String combine, List<TargetInput> targets) {
    }

    public record GrantInput(String personId, String organizationId, String roleCode, String positionTitle,
                             String siteScopeId, String validFrom, String validTo, ScopeInput scope) {
    }

    public record TargetView(String kind, String id, String name, boolean includeDescendants) {
    }

    public record GrantView(String id, Map<String, String> person, Map<String, String> role, Ref organization,
                            String positionTitle, String scopeMode, boolean all, String combine, List<TargetView> targets,
                            String scopeText, String validFrom, String validTo, boolean active, Ref grantedBy,
                            String endedReason) {
    }

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AccessService access;
    private final AuditService audit;
    private final GrantSource source;

    public GrantAdminService(JdbcClient jdbc, Clock clock, AccessService access, AuditService audit, GrantSource source) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.access = access;
        this.audit = audit;
        this.source = source;
    }

    // ---- create -------------------------------------------------------------------------------------------------

    @Transactional
    public Map<String, Object> create(AccessContext ctx, GrantInput in) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (in == null || in.personId() == null || in.organizationId() == null || in.roleCode() == null) {
            throw ApiException.validation("حدد الشخص والجهة والدور.");
        }
        UUID person = uuid(in.personId(), "الشخص");
        UUID home = uuid(in.organizationId(), "الجهة");
        Map<String, Object> role = jdbc.sql("select code, name, permissions, scope from role_def where code = :c")
                .param("c", in.roleCode()).query().listOfRows().stream().findFirst()
                .orElseThrow(() -> ApiException.validation("الدور غير موجود في السياسة المنشورة."));
        Set<Permission> perms = permissions(role.get("permissions"));
        String roleScope = (String) role.get("scope");
        ScopeInput scope = in.scope() == null ? new ScopeInput("ROLE", false, "AND", List.of()) : in.scope();
        String mode = scope.mode() == null ? "ROLE" : scope.mode();
        if (!List.of("ROLE", "CUSTOM").contains(mode)) {
            throw ApiException.validation("نوع النطاق غير معروف.");
        }
        boolean all = "CUSTOM".equals(mode) && Boolean.TRUE.equals(scope.all());
        String combine = scope.combine() == null ? "AND" : scope.combine();
        if (!List.of("AND", "OR").contains(combine)) {
            throw ApiException.validation("طريقة الجمع بين الجهة والموقع غير معروفة.");
        }
        UUID siteScope = in.siteScopeId() == null || in.siteScopeId().isBlank() ? null : uuid(in.siteScopeId(), "الموقع");
        List<GrantTarget> targets = new ArrayList<>();
        if ("CUSTOM".equals(mode) && !all) {
            for (TargetInput t : scope.targets() == null ? List.<TargetInput>of() : scope.targets()) {
                if (t == null || t.kind() == null || t.id() == null) {
                    throw ApiException.validation("هدف نطاق غير مكتمل.");
                }
                if (!List.of(GrantTarget.ORGANIZATION, GrantTarget.SITE, GrantTarget.RESOURCE).contains(t.kind())) {
                    throw ApiException.validation("نوع هدف النطاق غير معروف: " + t.kind());
                }
                boolean desc = !GrantTarget.RESOURCE.equals(t.kind()) && !Boolean.FALSE.equals(t.includeDescendants());
                GrantTarget target = new GrantTarget(t.kind(), uuid(t.id(), "هدف النطاق"), desc);
                if (targets.stream().noneMatch(x -> x.kind().equals(target.kind()) && x.id().equals(target.id()))) {
                    targets.add(target);
                }
            }
            if (targets.isEmpty()) {
                throw ApiException.validation("اختر جهة أو موقعاً أو مورداً واحداً على الأقل، أو نطاقاً شاملاً صريحاً.");
            }
            requireExisting(targets);
        }
        Instant from = in.validFrom() == null || in.validFrom().isBlank() ? clock.instant() : Times.parse(in.validFrom(), "validFrom");
        Instant to = in.validTo() == null || in.validTo().isBlank() ? null : Times.parse(in.validTo(), "validTo");
        if (to != null && !to.isAfter(from)) {
            throw ApiException.validation("نهاية المنحة يجب أن تكون بعد بدايتها.");
        }
        RawGrant proposed = new RawGrant(null, person, null, null, null, in.roleCode(), (String) role.get("name"), perms,
                roleScope, false, home, null, siteScope, null, mode, "AND".equals(combine), all, from, to, targets);
        requireAuthority(ctx, proposed);
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("""
                    insert into membership(id, person_id, organization_id, role_code, position_title, site_scope_id, valid_from, valid_to,
                                           scope_mode, scope_combine, scope_all, granted_by)
                    values (:id, :p, :o, :r, :t, :s, :f, :to, :m, :c, :a, :by)""")
                    .param("id", id).param("p", person).param("o", home).param("r", in.roleCode()).param("t", in.positionTitle())
                    .param("s", siteScope).param("f", Db.ts(from)).param("to", Db.ts(to)).param("m", mode).param("c", combine)
                    .param("a", all).param("by", ctx.personId()).update();
            for (GrantTarget t : targets) {
                jdbc.sql("insert into membership_scope_target(membership_id, kind, target_id, include_descendants) values (:m, :k, :t, :d)")
                        .param("m", id).param("k", t.kind()).param("t", t.id()).param("d", t.includeDescendants()).update();
            }
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            throw ApiException.validation("الشخص أو الجهة أو الدور غير موجود.");
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("organizationId", home.toString());
        detail.put("role", in.roleCode());
        detail.put("scope", describe(proposed));
        audit.recordAs(ctx.actor(), "MEMBERSHIP_CREATED", "PERSON", person.toString(), null, detail, null);
        return Map.of("id", id.toString(), "scopeText", describe(proposed));
    }

    /**
     * The granter's authority bounds the grant (owner brief §7): one of the granter's own MANAGE_ACCESS grants must
     * list the role as grantable and reach the grant's organisation and every target. The explicit ALL scope and
     * system actions are reserved to global access managers. A role from one grant and a scope from another are never
     * combined to widen what may be handed out.
     */
    void requireAuthority(AccessContext ctx, RawGrant proposed) {
        if (ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            return;
        }
        RawGrant.Spec spec = proposed.spec();
        if (spec.all()) {
            throw ApiException.forbidden("النطاق الشامل يمنحه مدير صلاحيات عام فقط.");
        }
        if (proposed.permissions().stream().anyMatch(SYSTEM_ACTIONS::contains)) {
            throw ApiException.forbidden("دور يتضمن التهيئة أو معرفات المصدر يمنحه مدير صلاحيات عام فقط.");
        }
        Map<String, List<String>> grantable = new HashMap<>();
        jdbc.sql("select code, grantable_roles from role_def").query((rs, n) -> grantable.put(rs.getString("code"),
                Db.strings(rs, "grantable_roles"))).list();
        Map<UUID, Set<UUID>> trees = new HashMap<>();
        Map<UUID, UUID> responsible = new HashMap<>();
        for (Grant g : ctx.grants()) {
            if (!g.has(Permission.MANAGE_ACCESS) || !grantable.getOrDefault(g.roleCode(), List.of()).contains(proposed.roleCode())) {
                continue;
            }
            if (!g.actsFor(proposed.orgId())) {
                continue;
            }
            boolean reaches = true;
            for (GrantTarget t : spec.orgs()) {
                Set<UUID> wanted = t.includeDescendants() ? trees.computeIfAbsent(t.id(), access::orgSubtree) : Set.of(t.id());
                reaches &= g.hasOrgLimit() && g.orgSubtree().containsAll(wanted);
            }
            for (GrantTarget t : spec.sites()) {
                Set<UUID> wanted = t.includeDescendants() ? trees.computeIfAbsent(t.id(), access::siteSubtree) : Set.of(t.id());
                reaches &= wanted.stream().allMatch(s -> siteWithin(g, s, responsible));
            }
            for (UUID r : spec.resources()) {
                UUID site = jdbc.sql("select site_id from resource where id = :id").param("id", r).query(UUID.class).single();
                reaches &= g.resources().contains(r) || siteWithin(g, site, responsible);
            }
            if (reaches && ctx.canFor(Permission.MANAGE_ACCESS, proposed.orgId())) {
                return;
            }
        }
        throw ApiException.forbidden("لا يمكنك منح هذا الدور أو هذا النطاق: يتجاوز ما تملك إدارته من الصلاحيات.");
    }

    private boolean siteWithin(Grant g, UUID site, Map<UUID, UUID> responsible) {
        if (g.hasSiteLimit() && g.siteSubtree().contains(site)) {
            return true;
        }
        if (!g.hasOrgLimit()) {
            return false;
        }
        UUID org = responsible.computeIfAbsent(site, s -> jdbc.sql(
                "select organization_id from site_responsibility where site_id = :s and valid_to is null")
                .param("s", s).query(UUID.class).optional().orElse(null));
        return org != null && g.orgSubtree().contains(org) && (!g.hasSiteLimit() || !g.andCombine());
    }

    private void requireExisting(List<GrantTarget> targets) {
        for (GrantTarget t : targets) {
            String table = switch (t.kind()) {
                case GrantTarget.ORGANIZATION -> "organization";
                case GrantTarget.SITE -> "site";
                default -> "resource";
            };
            int n = jdbc.sql("select count(*) from " + table + " where id = :id").param("id", t.id()).query(Integer.class).single();
            if (n == 0) {
                throw ApiException.validation("هدف النطاق غير موجود.");
            }
        }
    }

    // ---- end ----------------------------------------------------------------------------------------------------

    @Transactional
    public Map<String, Object> end(AccessContext ctx, UUID id, String endAt, String reason) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("اذكر سبب إنهاء العضوية.");
        }
        Map<String, Object> m = jdbc.sql("select person_id, organization_id, role_code, valid_from, valid_to from membership where id = :id for update")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.canFor(Permission.MANAGE_ACCESS, (UUID) m.get("organization_id"))) {
            throw ApiException.notFound();
        }
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

    // ---- list ---------------------------------------------------------------------------------------------------

    public List<GrantView> list(AccessContext ctx, UUID orgId, UUID personId, boolean includeEnded) {
        ctx.require(Permission.MANAGE_ACCESS);
        boolean global = ctx.canEverywhere(Permission.MANAGE_ACCESS);
        if (orgId == null && !global) {
            throw ApiException.validation("اختر جهة لعرض منحها.");
        }
        if (orgId != null && !ctx.canFor(Permission.MANAGE_ACCESS, orgId)) {
            throw ApiException.notFound();
        }
        List<Map<String, Object>> rows = jdbc.sql("""
                select m.*, p.display_name, p.employee_no, r.name as role_name, r.permissions, r.scope as role_scope, r.summary_only,
                       o.name as org_name, s.name as site_name, g.display_name as granted_by_name,
                       (m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) as active
                from membership m join person p on p.id = m.person_id join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id left join site s on s.id = m.site_scope_id
                left join person g on g.id = m.granted_by
                where (cast(:org as uuid) is null or m.organization_id = :org)
                  and (cast(:person as uuid) is null or m.person_id = :person)
                  and (:ended or m.valid_to is null or m.valid_to > now())
                order by active desc, r.sort_order, p.display_name limit 500""")
                .param("org", orgId).param("person", personId).param("ended", includeEnded).query().listOfRows();
        Map<UUID, List<GrantTarget>> targets = source.targets(rows.stream().map(r -> (UUID) r.get("id")).toList());
        List<RawGrant> raws = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            UUID id = (UUID) r.get("id");
            raws.add(new RawGrant(id, (UUID) r.get("person_id"), id, null, null, null, (String) r.get("role_name"),
                    permissions(r.get("permissions")), (String) r.get("role_scope"), (Boolean) r.get("summary_only"),
                    (UUID) r.get("organization_id"), (String) r.get("org_name"), (UUID) r.get("site_scope_id"),
                    (String) r.get("site_name"), (String) r.get("scope_mode"), "AND".equals(r.get("scope_combine")),
                    (Boolean) r.get("scope_all"), Db.toInstant(r.get("valid_from")), Db.toInstant(r.get("valid_to")),
                    targets.getOrDefault(id, List.of())));
        }
        Names names = names(raws);
        List<GrantView> out = new ArrayList<>();
        for (int i = 0; i < rows.size(); i++) {
            Map<String, Object> r = rows.get(i);
            RawGrant g = raws.get(i);
            List<TargetView> tv = g.targets().stream()
                    .map(t -> new TargetView(t.kind(), t.id().toString(), names.of(t), t.includeDescendants())).toList();
            out.add(new GrantView(g.grantId().toString(),
                    Map.of("id", r.get("person_id").toString(), "displayName", (String) r.get("display_name"),
                            "employeeNo", (String) r.get("employee_no")),
                    Map.of("code", (String) r.get("role_code"), "name", (String) r.get("role_name")),
                    Ref.of(g.orgId(), g.orgName()), (String) r.get("position_title"), g.scopeMode(), g.scopeAll(),
                    (String) r.get("scope_combine"), tv, describe(g, names),
                    Db.toInstant(r.get("valid_from")).toString(), g.validTo() == null ? null : g.validTo().toString(),
                    (Boolean) r.get("active"), Ref.of((UUID) r.get("granted_by"), (String) r.get("granted_by_name")),
                    (String) r.get("ended_reason")));
        }
        return out;
    }

    // ---- wording ------------------------------------------------------------------------------------------------

    /** Names of every organisation, site and resource a set of grants refers to. */
    public record Names(Map<UUID, String> orgs, Map<UUID, String> sites, Map<UUID, String> resources) {

        String of(GrantTarget t) {
            Map<UUID, String> m = GrantTarget.ORGANIZATION.equals(t.kind()) ? orgs : GrantTarget.SITE.equals(t.kind()) ? sites : resources;
            return m.getOrDefault(t.id(), t.id().toString().substring(0, 8));
        }
    }

    public Names names(List<RawGrant> grants) {
        Set<UUID> orgs = new HashSet<>();
        Set<UUID> sites = new HashSet<>();
        Set<UUID> resources = new HashSet<>();
        for (RawGrant g : grants) {
            RawGrant.Spec s = g.spec();
            s.orgs().forEach(t -> orgs.add(t.id()));
            s.sites().forEach(t -> sites.add(t.id()));
            resources.addAll(s.resources());
        }
        return new Names(lookup("organization", orgs), lookup("site", sites), lookup("resource", resources));
    }

    private Map<UUID, String> lookup(String table, Set<UUID> ids) {
        Map<UUID, String> out = new HashMap<>();
        if (!ids.isEmpty()) {
            jdbc.sql("select id, name from " + table + " where id = any(string_to_array(:ids, ',')::uuid[])")
                    .param("ids", Db.ids(ids)).query((rs, n) -> out.put(Db.uuid(rs, "id"), rs.getString("name"))).list();
        }
        return out;
    }

    public String describe(RawGrant g) {
        return describe(g, names(List.of(g)));
    }

    /** The scope in plain Arabic, e.g. «الجهة «أ» وفروعها — بشرط أن يكون الموقع ضمن «م» ومرافقه». */
    public static String describe(RawGrant g, Names names) {
        RawGrant.Spec s = g.spec();
        if (s.all()) {
            return "نطاق شامل: جميع الجهات والمواقع (ممنوح صراحة)";
        }
        List<String> orgParts = new ArrayList<>();
        for (GrantTarget t : s.orgs()) {
            orgParts.add("«" + names.of(t) + "»" + (t.includeDescendants() ? " وفروعها" : " وحدها"));
        }
        List<String> siteParts = new ArrayList<>();
        for (GrantTarget t : s.sites()) {
            siteParts.add("«" + names.of(t) + "»" + (t.includeDescendants() ? " ومرافقه الفرعية" : " وحده"));
        }
        for (UUID r : s.resources()) {
            siteParts.add("المورد «" + names.of(new GrantTarget(GrantTarget.RESOURCE, r, false)) + "»");
        }
        String org = orgParts.isEmpty() ? null : (orgParts.size() == 1 ? "الجهة " : "الجهات: ") + String.join("، ", orgParts);
        String site = siteParts.isEmpty() ? null : (s.sites().size() + s.resources().size() == 1 && s.resources().isEmpty() ? "الموقع " : "")
                + String.join("، ", siteParts);
        if (s.orgConstraint() && s.siteConstraint()) {
            if (site == null) {
                return org + " — بشرط موقع لم يُحدد، فلا يشمل أي طلب أو مرفق";
            }
            return s.and() ? org + " — بشرط أن يكون الموقع أو المورد ضمن: " + site : org + "، أو " + site + " (سياسة «أو» صريحة)";
        }
        if (s.orgConstraint()) {
            return org;
        }
        if (s.siteConstraint()) {
            return site == null ? "موقع لم يُحدد: لا يشمل أي طلب أو مرفق (يعمل باسم الجهة «" + g.orgName() + "» فقط)"
                    : site + " (يعمل باسم الجهة «" + g.orgName() + "»)";
        }
        return "لا نطاق";
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private static UUID uuid(String value, String label) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw ApiException.validation("معرف " + label + " غير صحيح.");
        }
    }

    static Set<Permission> permissions(Object value) {
        EnumSet<Permission> set = EnumSet.noneOf(Permission.class);
        try {
            for (Object item : (Object[]) ((java.sql.Array) value).getArray()) {
                set.add(Permission.valueOf(String.valueOf(item)));
            }
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
        return set;
    }
}
