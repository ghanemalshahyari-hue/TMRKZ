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
import ae.mover.access.AccessRights;
import ae.mover.access.AccessRights.Right;
import ae.mover.access.AccessService;
import ae.mover.access.DirectoryScope;
import ae.mover.access.Grant;
import ae.mover.access.GrantSource;
import ae.mover.access.GrantTarget;
import ae.mover.access.Permission;
import ae.mover.access.PersonKeys;
import ae.mover.access.RawGrant;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
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

    /** Final approval is given and taken by a global access manager only, as in the movement programme (ADR-058). */
    public static final Set<String> FINAL_ROLES = Set.of("FINAL_APPROVER", "ACCESS_FINAL_APPROVER", "STATIONING_FINAL_APPROVER");

    public record TargetInput(String kind, String id, Boolean includeDescendants, List<Integer> levels) {
    }

    public record ScopeInput(String mode, Boolean all, String combine, List<TargetInput> targets) {
    }

    /** {@code rights}: for a role that manages access, the separate rights of the grant (ADR-059); null: every right. */
    public record GrantInput(String personId, String organizationId, String roleCode, String positionTitle,
                             String siteScopeId, String validFrom, String validTo, ScopeInput scope, List<String> rights) {

        public GrantInput(String personId, String organizationId, String roleCode, String positionTitle,
                          String siteScopeId, String validFrom, String validTo, ScopeInput scope) {
            this(personId, organizationId, roleCode, positionTitle, siteScopeId, validFrom, validTo, scope, null);
        }
    }

    public record TargetView(String kind, String id, String name, boolean includeDescendants, List<Integer> levels) {
    }

    public record GrantView(String id, Map<String, String> person, Map<String, String> role, Ref organization,
                            String positionTitle, String scopeMode, boolean all, String combine, List<TargetView> targets,
                            String scopeText, String validFrom, String validTo, boolean active, Ref grantedBy,
                            String endedReason, List<String> rights, boolean delegated) {
    }

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AccessService access;
    private final AuditService audit;
    private final GrantSource source;
    private final DirectoryScope directory;
    private final PersonKeys keys;
    private final Json json;
    private final AccessRights rightsOf;

    private final org.springframework.beans.factory.ObjectProvider<ae.mover.hr.TaskRealignment> realignment;

    public GrantAdminService(JdbcClient jdbc, Clock clock, AccessService access, AuditService audit, GrantSource source,
                             DirectoryScope directory, PersonKeys keys, Json json, AccessRights rightsOf,
                             org.springframework.beans.factory.ObjectProvider<ae.mover.hr.TaskRealignment> realignment) {
        this.realignment = realignment;
        this.rightsOf = rightsOf;
        this.keys = keys;
        this.json = json;
        this.jdbc = jdbc;
        this.clock = clock;
        this.access = access;
        this.audit = audit;
        this.source = source;
        this.directory = directory;
    }

    PersonKeys keys() {
        return keys;
    }

    // ---- create -------------------------------------------------------------------------------------------------

    @Transactional
    public Map<String, Object> create(AccessContext ctx, GrantInput in) {
        return create(ctx, in, null);
    }

    /** {@code batch}: the audit reference of a saved batch of the access workspace (ADR-058), written on each entry. */
    Map<String, Object> create(AccessContext ctx, GrantInput in, String batch) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (in == null || in.personId() == null || in.organizationId() == null || in.roleCode() == null) {
            throw ApiException.validation("حدد الشخص والجهة والدور.");
        }
        UUID person = uuid(in.personId(), "الشخص");
        UUID home = uuid(in.organizationId(), "الجهة");
        requireGrantee(ctx, person);
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
                UUID targetId = uuid(t.id(), "هدف النطاق");
                GrantTarget target = new GrantTarget(t.kind(), targetId, desc);
                if (t.levels() != null && !t.levels().isEmpty()) {
                    if (!GrantTarget.ORGANIZATION.equals(t.kind()) || !desc) {
                        throw ApiException.validation("المستويات تُختار لجهة مع فروعها فقط.");
                    }
                    List<Integer> levels = t.levels().stream().distinct().sorted().toList();
                    Set<UUID> reached = source.reach(targetId, levels);
                    if (reached.isEmpty()) {
                        throw ApiException.validation("لا توجد وحدات في هذه المستويات تحت الجهة المختارة.");
                    }
                    target = new GrantTarget(t.kind(), targetId, true, levels, reached);
                }
                GrantTarget chosen = target;
                if (targets.stream().noneMatch(x -> x.kind().equals(chosen.kind()) && x.id().equals(chosen.id()))) {
                    targets.add(chosen);
                }
            }
            if (targets.isEmpty()) {
                throw ApiException.validation("اختر جهة أو موقعاً أو مورداً واحداً على الأقل، أو نطاقاً شاملاً صريحاً.");
            }
            requireExisting(targets);
        }
        if (CHAIN_APPROVER.equals(in.roleCode())) {
            // «معتمد السلسلة الهرمية» as TNQL's (ADR-061): one level — «هذا المستوى فقط» — or a level with every unit below it
            // that has no direct approver; no scope means the home unit only, never every unit, levels or sites; never a main unit
            if (!"CUSTOM".equals(mode)) {
                mode = "CUSTOM";
                targets.clear();
                targets.add(new GrantTarget(GrantTarget.ORGANIZATION, home, false));
            }
            if (all || targets.stream().anyMatch(t -> !GrantTarget.ORGANIZATION.equals(t.kind()) || !t.levels().isEmpty())) {
                throw ApiException.validation("معتمد السلسلة الهرمية يُعيَّن على مستوى بعينه: «هذا المستوى فقط» أو «هذا المستوى ومع جميع الوحدات التابعة».");
            }
            for (GrantTarget t : targets) {
                if (mainUnit(t.id())) {
                    throw ApiException.validation("الوحدة الرئيسية ليست مستوى في السلسلة الهرمية — اختر مستوى تحتها");
                }
            }
        }
        Instant from = in.validFrom() == null || in.validFrom().isBlank() ? clock.instant() : Times.parse(in.validFrom(), "validFrom");
        Instant to = in.validTo() == null || in.validTo().isBlank() ? null : Times.parse(in.validTo(), "validTo");
        if (to != null && !to.isAfter(from)) {
            throw ApiException.validation("نهاية المنحة يجب أن تكون بعد بدايتها.");
        }
        RawGrant proposed = new RawGrant(null, person, null, null, null, in.roleCode(), (String) role.get("name"), perms,
                roleScope, false, home, null, siteScope, null, mode, "AND".equals(combine), all, from, to, targets);
        boolean manages = perms.contains(Permission.MANAGE_ACCESS);
        Set<Right> rights = manages ? AccessRights.parse(in.rights()) : null;
        UUID sponsor = authority(ctx, proposed, rights);
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("""
                    insert into membership(id, person_id, organization_id, role_code, position_title, site_scope_id, valid_from, valid_to,
                                           scope_mode, scope_combine, scope_all, granted_by, access_rights, sponsor_id)
                    values (:id, :p, :o, :r, :t, :s, :f, :to, :m, :c, :a, :by, string_to_array(:rights, ',')::text[], :sponsor)""")
                    .param("id", id).param("p", person).param("o", home).param("r", in.roleCode()).param("t", in.positionTitle())
                    .param("s", siteScope).param("f", Db.ts(from)).param("to", Db.ts(to)).param("m", mode).param("c", combine)
                    .param("a", all).param("by", ctx.personId())
                    .param("rights", rights == null ? null : String.join(",", rights.stream().map(Enum::name).toList()))
                    .param("sponsor", sponsor).update();
            for (GrantTarget t : targets) {
                jdbc.sql("""
                        insert into membership_scope_target(membership_id, kind, target_id, include_descendants, levels)
                        values (:m, :k, :t, :d, string_to_array(nullif(:l, ''), ',')::int[])""")
                        .param("m", id).param("k", t.kind()).param("t", t.id()).param("d", t.includeDescendants())
                        .param("l", String.join(",", t.levels().stream().map(String::valueOf).toList())).update();
            }
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            throw ApiException.validation("الشخص أو الجهة أو الدور غير موجود.");
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("organizationId", home.toString());
        detail.put("role", in.roleCode());
        detail.put("scope", describe(proposed));
        if (batch != null) {
            detail.put("batch", batch);
        }
        if (rights != null) {
            detail.put("rights", rights.stream().map(Enum::name).toList());
        }
        if (sponsor != null) {
            detail.put("delegatedFrom", sponsor.toString());
        }
        audit.recordAs(ctx.actor(), "MEMBERSHIP_CREATED", "PERSON", person.toString(), null, detail, null);
        if (rights != null && rights.contains(Right.FINALIZE)) {
            finalCompanion(ctx, id, person, home, targets, all, from, to);
        }
        return Map.of("id", id.toString(), "scopeText", describe(proposed));
    }

    /**
     * «اعتماد نهائي لطلبات الصلاحيات» (FINALIZE): the access manager also takes the final step of permission requests over the
     * same units, as a grant of «معتمد طلبات الصلاحية» tied to the access manager's grant: made and ended with it, never alone.
     */
    private void finalCompanion(AccessContext ctx, UUID sponsor, UUID person, UUID home, List<GrantTarget> targets, boolean all, Instant from, Instant to) {
        if (jdbc.sql("select count(*) from role_def where code = 'ACCESS_FINAL_APPROVER'").query(Long.class).single() == 0) {
            return;
        }
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into membership(id, person_id, organization_id, role_code, valid_from, valid_to, scope_mode, scope_combine, scope_all,
                                       granted_by, sponsor_id)
                values (:id, :p, :o, 'ACCESS_FINAL_APPROVER', :f, :to, 'CUSTOM', 'AND', :a, :by, :sponsor)""")
                .param("id", id).param("p", person).param("o", home).param("f", Db.ts(from)).param("to", Db.ts(to)).param("a", all)
                .param("by", ctx.personId()).param("sponsor", sponsor).update();
        List<GrantTarget> units = targets.stream().filter(t -> GrantTarget.ORGANIZATION.equals(t.kind())).toList();
        if (!all) {
            for (GrantTarget t : units.isEmpty() ? List.of(new GrantTarget(GrantTarget.ORGANIZATION, home, true)) : units) {
                jdbc.sql("""
                        insert into membership_scope_target(membership_id, kind, target_id, include_descendants, levels)
                        values (:m, 'ORGANIZATION', :t, :d, string_to_array(nullif(:l, ''), ',')::int[])""")
                        .param("m", id).param("t", t.id()).param("d", t.includeDescendants())
                        .param("l", String.join(",", t.levels().stream().map(String::valueOf).toList())).update();
            }
        }
        audit.recordAs(ctx.actor(), "MEMBERSHIP_CREATED", "PERSON", person.toString(), null,
                Map.of("organizationId", home.toString(), "role", "ACCESS_FINAL_APPROVER", "companionOf", sponsor.toString()), null);
    }

    /**
     * Separation of duties (owner decision of 2 Nov 2026; audit P0-2): nobody grants a role to themselves, and the
     * time-boxed identity created by ops/bootstrap-admin.sh never receives a grant beyond its own 72-hour one — the
     * lasting administrator is the person's HR record, granted by an administrator. A scoped manager grants only to
     * people inside their directory (ADR-027): a person of another organisation is first related to the manager's
     * authority by someone whose authority covers that person (a global manager, or a grant on a shared site).
     */
    void requireGrantee(AccessContext ctx, UUID person) {
        // another record of the same human (a duplicate HR record, a linked sign-in) is oneself too
        if (keys.same(ctx.personId(), person)) {
            throw ApiException.forbidden("لا يجوز منح دور لنفسك؛ يمنحه لك مدير صلاحيات آخر.");
        }
        boolean bootstrap = jdbc.sql("select coalesce(bootstrap, false) from person where id = :p").param("p", person)
                .query(Boolean.class).optional().orElse(false);
        if (bootstrap) {
            throw ApiException.forbidden("هوية التهيئة الأولى مؤقتة ولا تُمنح أدواراً إضافية؛ امنح الدور لسجل الشخص في الموارد البشرية.");
        }
        if (!directory.covers(ctx, person)) {
            throw ApiException.forbidden("الشخص خارج نطاق إدارتك للصلاحيات؛ يمنحه مدير صلاحيات يشمل نطاقه جهة الشخص.");
        }
    }

    /**
     * The same authority bound for a role handed out through an HR position seat (audit P0-1): a seat gives the role
     * to whoever holds the position, so it is a grant and is limited exactly like one.
     */
    public void requireAuthorityForRole(AccessContext ctx, UUID orgId, String roleCode, UUID siteScope) {
        requireAuthorityForRole(ctx, orgId, roleCode, siteScope, null);
    }

    /** The same bound with another right than «منح الصلاحيات», e.g. «إدارة صلاحية المناوبة» for a duty permit. */
    public void requireAuthorityForRole(AccessContext ctx, UUID orgId, String roleCode, UUID siteScope, Right instead) {
        Map<String, Object> role = jdbc.sql("select code, name, permissions, scope from role_def where code = :c")
                .param("c", roleCode).query().listOfRows().stream().findFirst()
                .orElseThrow(() -> ApiException.validation("الدور غير موجود في السياسة المنشورة."));
        RawGrant proposed = new RawGrant(null, null, null, null, null, roleCode, (String) role.get("name"),
                permissions(role.get("permissions")), (String) role.get("scope"), false, orgId, null, siteScope, null, "ROLE", true,
                false, clock.instant(), null, List.of());
        authority(ctx, proposed, null, instead);
    }

    /**
     * The granter's authority bounds the grant (owner brief §7): one of the granter's own MANAGE_ACCESS grants must
     * list the role as grantable and reach the grant's organisation and every target. The explicit ALL scope and
     * system actions are reserved to global access managers. A role from one grant and a scope from another are never
     * combined to widen what may be handed out.
     */
    public void requireAuthority(AccessContext ctx, RawGrant proposed) {
        authority(ctx, proposed, null);
    }

    /**
     * {@link #requireAuthority} with the separate rights of ADR-059: giving or ending a role needs «منح الصلاحيات» (GRANT) on the
     * grant used; a role that manages access is delegated, needing «تفويض إدارة الصلاحيات» (DELEGATE) on a grant whose rights
     * include every right handed on ({@code rights}, null = all) and whose end is not before the new one's. Returns that grant
     * (the sponsor of a delegation), or null for a global manager.
     */
    UUID authority(AccessContext ctx, RawGrant proposed, Set<Right> rights) {
        return authority(ctx, proposed, rights, null);
    }

    UUID authority(AccessContext ctx, RawGrant proposed, Set<Right> rights, Right instead) {
        if (ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            return null;
        }
        if (FINAL_ROLES.contains(proposed.roleCode())) {
            throw ApiException.forbidden("الاعتماد النهائي يمنحه ويسحبه مدير الصلاحيات العام فقط.");
        }
        // «معتمد التوفر» at a unit that does not provide the department is a standby only a global manager gives (TNQL)
        if (proposed.roleCode().startsWith("AVAILABILITY_") && jdbc.sql("select count(*) from provider_unit where organization_id = :o and role_code = :r")
                .param("o", proposed.orgId()).param("r", proposed.roleCode()).query(Long.class).single() == 0) {
            throw ApiException.forbidden("هذه الوحدة ليست مزوّدة لهذه الإدارة؛ يمنحها احتياطياً مدير الصلاحيات العام.");
        }
        boolean manages = proposed.permissions().contains(Permission.MANAGE_ACCESS);
        boolean delegating = manages && instead == null;
        Right needed = instead != null ? instead : manages ? Right.DELEGATE : Right.GRANT;
        Map<UUID, Set<Right>> known = rightsOf.of(ctx.grants().stream().map(Grant::membershipId).toList());
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
        boolean rightMissing = false;
        for (Grant g : ctx.grants()) {
            if (!g.has(Permission.MANAGE_ACCESS) || !grantable.getOrDefault(g.roleCode(), List.of()).contains(proposed.roleCode())) {
                continue;
            }
            Set<Right> held = rightsOf.of(g, known);
            boolean wider = delegating && !held.containsAll(rights == null ? AccessRights.ALL : rights);
            boolean longer = delegating && g.validTo() != null && (proposed.validTo() == null || proposed.validTo().isAfter(g.validTo()));
            if (!held.contains(needed) || wider || longer) {
                rightMissing = true;
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
                return g.membershipId();
            }
        }
        if (rightMissing) {
            throw ApiException.forbidden(delegating
                    ? "التفويض لا يتجاوز ما فُوِّض لك: يلزم حق «تفويض إدارة الصلاحيات»، والحقوق نفسها أو أقل، وحتى نهاية منحتك."
                    : "لا تملك حق «" + needed.label + "» على هذه المنحة؛ يمنحه لك من فوّضك أو مدير الصلاحيات العام.");
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
        return end(ctx, id, endAt, reason, null);
    }

    Map<String, Object> end(AccessContext ctx, UUID id, String endAt, String reason, String batch) {
        return end(ctx, id, endAt, reason, batch, true);
    }

    /** {@code cascade}: also end what was delegated from it and its tied final step (not when it is being replaced). */
    private Map<String, Object> end(AccessContext ctx, UUID id, String endAt, String reason, String batch, boolean cascade) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("اذكر سبب إنهاء العضوية.");
        }
        Map<String, Object> m = jdbc.sql("""
                select m.person_id, m.organization_id, m.role_code, m.valid_from, m.valid_to, m.site_scope_id, m.scope_mode,
                       m.scope_combine, m.scope_all, r.name as role_name, r.permissions, r.scope as role_scope, m.granted_by,
                       array_to_string(m.access_rights, ',') as access_rights, m.sponsor_id
                from membership m join role_def r on r.code = m.role_code where m.id = :id for update of m""")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.canFor(Permission.MANAGE_ACCESS, (UUID) m.get("organization_id"))) {
            throw ApiException.notFound();
        }
        boolean manages = permissions(m.get("permissions")).contains(Permission.MANAGE_ACCESS);
        // a delegated access manager's grant is edited or ended only by its issuer or a global manager (TNQL)
        if (manages && !ctx.canEverywhere(Permission.MANAGE_ACCESS) && !ctx.personId().equals(m.get("granted_by"))) {
            throw ApiException.forbidden("منحة مسؤول الصلاحيات يعدّلها أو يسحبها من أصدرها أو مدير الصلاحيات العام.");
        }
        // the final step tied to an access manager's grant goes with it; it is changed through that grant's rights
        if (m.get("sponsor_id") != null && "ACCESS_FINAL_APPROVER".equals(m.get("role_code")) && !ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("هذه المنحة مرتبطة بحق «اعتماد نهائي لطلبات الصلاحيات» لمسؤول الصلاحيات؛ عدّل حقوقه بدلاً منها.");
        }
        String stored = (String) m.get("access_rights");
        Set<Right> endedRights = stored == null ? null : stored.isEmpty() ? java.util.EnumSet.noneOf(Right.class) : AccessRights.parse(List.of(stored.split(",")));
        // ending a grant needs the authority to give it (ADR-027), as for a position seat (audit P0-1)
        authority(ctx, new RawGrant(id, (UUID) m.get("person_id"), id, null, null, (String) m.get("role_code"),
                (String) m.get("role_name"), permissions(m.get("permissions")), (String) m.get("role_scope"), false,
                (UUID) m.get("organization_id"), null, (UUID) m.get("site_scope_id"), null, (String) m.get("scope_mode"),
                "AND".equals(m.get("scope_combine")), (Boolean) m.get("scope_all"), Db.toInstant(m.get("valid_from")),
                Db.toInstant(m.get("valid_to")), source.targets(List.of(id)).getOrDefault(id, List.of())), manages ? endedRights : null);
        Instant end = endAt == null ? clock.instant() : Times.parse(endAt, "endAt");
        Instant from = Db.toInstant(m.get("valid_from"));
        if (!end.isAfter(from)) {
            end = from.plusMillis(1);
        }
        Instant currentEnd = Db.toInstant(m.get("valid_to"));
        if (currentEnd != null && !currentEnd.isAfter(end)) {
            throw ApiException.validation("العضوية منتهية بالفعل.");
        }
        // the holder's rights as they were, so a task assigned to them can move once the grant has ended (SEAT, owner 16 Nov 2026)
        UUID holder = (UUID) m.get("person_id");
        Instant now = clock.instant();
        AccessContext held = end.isAfter(now) ? null : access.load(new ae.mover.security.Actor(holder, null, null, null), now);
        jdbc.sql("update membership set valid_to = :e, ended_reason = :r where id = :id")
                .param("e", Db.ts(end)).param("r", reason).param("id", id).update();
        int pooled = jdbc.sql("""
                select count(*) from task_assignment where status = 'OPEN' and role_code = :role
                  and (target_org_id is null or target_org_id = :org)""")
                .param("role", m.get("role_code")).param("org", m.get("organization_id")).query(Integer.class).single();
        Map<String, Object> ended = new LinkedHashMap<>();
        ended.put("membershipId", id.toString());
        ended.put("endAt", end.toString());
        ended.put("organizationId", m.get("organization_id").toString());
        ended.put("role", m.get("role_code"));
        if (batch != null) {
            ended.put("batch", batch);
        }
        audit.recordAs(ctx.actor(), "MEMBERSHIP_ENDED", "PERSON", m.get("person_id").toString(), null, ended, reason);
        // what was delegated from this grant, and the final step tied to it, end with it (ADR-059)
        for (UUID child : !cascade ? List.<UUID>of() : jdbc.sql("select id from membership where sponsor_id = :id and (valid_to is null or valid_to > :e)")
                .param("id", id).param("e", Db.ts(end)).query(UUID.class).list()) {
            jdbc.sql("update membership set valid_to = greatest(valid_from + interval '1 millisecond', :e), ended_reason = :r where id = :c")
                    .param("e", Db.ts(end)).param("r", "انتهت المنحة التي بُنيت عليها").param("c", child).update();
            audit.recordAs(ctx.actor(), "MEMBERSHIP_ENDED", "PERSON", m.get("person_id").toString(), null,
                    Map.of("membershipId", child.toString(), "endedWith", id.toString(), "organizationId", m.get("organization_id").toString()), reason);
        }
        if (pooled > 0) {
            audit.recordAs(ctx.actor(), "TASKS_REALIGNED", "PERSON", m.get("person_id").toString(), null,
                    Map.of("openTasks", pooled, "rule", "المهام مسندة إلى الدور وتبقى لدى شاغليه الحاليين"), reason);
        }
        // a task assigned to this person that they may no longer decide goes back to whoever holds the responsibility now
        int moved = held == null ? 0 : realignment.getObject().realign(Map.of(holder, held), "GRANT_ENDED", now);
        return Map.of("id", id.toString(), "validTo", end.toString(), "realignedTasks", pooled, "movedTasks", moved);
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
                select m.*, array_to_string(m.access_rights, ',') as rights_text, p.display_name, p.employee_no, r.name as role_name, r.permissions, r.scope as role_scope, r.summary_only,
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
                    .map(t -> new TargetView(t.kind(), t.id().toString(), names.of(t), t.includeDescendants(), t.levels())).toList();
            out.add(new GrantView(g.grantId().toString(),
                    Map.of("id", r.get("person_id").toString(), "displayName", (String) r.get("display_name"),
                            "employeeNo", (String) r.get("employee_no")),
                    Map.of("code", (String) r.get("role_code"), "name", (String) r.get("role_name")),
                    Ref.of(g.orgId(), g.orgName()), (String) r.get("position_title"), g.scopeMode(), g.scopeAll(),
                    (String) r.get("scope_combine"), tv, describe(g, names),
                    Db.toInstant(r.get("valid_from")).toString(), g.validTo() == null ? null : g.validTo().toString(),
                    (Boolean) r.get("active"), Ref.of((UUID) r.get("granted_by"), (String) r.get("granted_by_name")),
                    (String) r.get("ended_reason"),
                    r.get("rights_text") == null ? null : ((String) r.get("rights_text")).isEmpty() ? List.of() : List.of(((String) r.get("rights_text")).split(",")),
                    r.get("sponsor_id") != null));
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
            g.targets().stream().filter(t -> GrantTarget.ORGANIZATION.equals(t.kind())).forEach(t -> orgs.add(t.id()));
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

    /** What a unit target would cover, for the page choosing it, and the main unit of a person's branch to open the tree on. */
    public Map<String, Object> scopePreview(AccessContext ctx, UUID orgId, boolean descendants, List<Integer> levels) {
        ctx.require(Permission.MANAGE_ACCESS);
        int units = levels != null && !levels.isEmpty() ? source.reach(orgId, levels).size()
                : descendants ? access.orgSubtree(orgId).size() : 1;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("units", units);
        return out;
    }

    /** Where the units dialog's tree starts, as in the movement programme: the main units the granter may reach. */
    public List<Map<String, Object>> grantRoots(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        return jdbc.sql("""
                select o.id, o.code, o.name, o.parent_id, (select count(*) from organization c where c.parent_id = o.id and c.status = 'ACTIVE') as children
                from organization o join hr_unit h on h.external_id = o.source_external_id and h.is_main
                  and h.snapshot_id = (select s.id from hr_snapshot s where s.status = 'PUBLISHED')
                where o.status = 'ACTIVE' order by o.name""").query().listOfRows().stream()
                .filter(r -> ctx.canFor(Permission.MANAGE_ACCESS, (UUID) r.get("id")))
                .map(r -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", r.get("id").toString());
                    m.put("code", r.get("code"));
                    m.put("name", r.get("name"));
                    m.put("parentId", r.get("parent_id") == null ? null : r.get("parent_id").toString());
                    m.put("childCount", ((Number) r.get("children")).intValue());
                    m.put("siteCount", 0);
                    return m;
                }).toList();
    }

    /**
     * One unit's people and their grants, for the matrix: those posted in it, those granted a role with it as home, and those
     * added to it through «إضافة مستخدم» (ADR-049, marked {@code added}, {@code acting} when posted elsewhere).
     */
    public Map<String, Object> unitMatrix(AccessContext ctx, UUID orgId, String q, Integer page) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (!ctx.canFor(Permission.MANAGE_ACCESS, orgId)) {
            throw ApiException.notFound();
        }
        String like = q == null || q.isBlank() ? null : "%" + q.trim() + "%";
        String people = """
                from person p left join unit_member um on um.person_id = p.id and um.organization_id = :o and um.ended_at is null
                where p.status = 'ACTIVE'
                  -- the unit's users only (owner, 16 Nov 2026, as AccessWorkspaceService.USERS): added there or holding a grant there
                  and (exists (select 1 from membership m where m.person_id = p.id and m.organization_id = :o and (m.valid_to is null or m.valid_to > now()))
                    or um.id is not null)
                  and (cast(:q as text) is null or p.display_name ilike :q or p.employee_no ilike :q or coalesce(p.username, '') ilike :q)""";
        long total = jdbc.sql("select count(*) " + people).param("o", orgId).param("q", like).query(Long.class).single();
        int from = Math.max(0, page == null ? 0 : page) * 25;
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> p : jdbc.sql("select p.id, p.display_name, p.employee_no, p.username, um.id is not null as added, coalesce(um.acting, false) as acting "
                        + people + " order by p.display_name limit 25 offset :from")
                .param("o", orgId).param("q", like).param("from", from).query().listOfRows()) {
            UUID id = (UUID) p.get("id");
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", id.toString());
            row.put("displayName", p.get("display_name"));
            String no = (String) p.get("employee_no");
            // a User ID added without HR is shown by its login, not its internal key
            row.put("employeeNo", no != null && no.startsWith(UnitMemberService.LOCAL_USER_PREFIX) && p.get("username") != null ? p.get("username") : no);
            row.put("added", p.get("added"));
            row.put("acting", p.get("acting"));
            row.put("withoutHr", no != null && no.startsWith(UnitMemberService.LOCAL_USER_PREFIX));
            row.put("grants", list(ctx, orgId, id, false));
            rows.add(row);
        }
        return Map.of("total", total, "people", rows);
    }

    /**
     * The final approval of a permission request (ADR-044): the roles granted become grants at the person's unit, each with its own
     * default reach. The decision is the authority here, checked by the engine. A role already held there is left as it is.
     */
    public List<String> applyAccessRequest(AccessContext ctx, UUID requestId) {
        Map<String, Object> a = jdbc.sql("select person_id, unit_org_id, array_to_string(granted, ',') as granted, granted_scope::text as scope from access_request where request_id = :r")
                .param("r", requestId).query().singleRow();
        Map<String, Object> scope = a.get("scope") == null ? null : json.map(a.get("scope").toString());
        String mode = scope == null ? null : (String) scope.get("mode");
        UUID person = (UUID) a.get("person_id");
        UUID unit = (UUID) a.get("unit_org_id");
        Instant now = clock.instant();
        List<String> made = new ArrayList<>();
        for (String role : a.get("granted") == null ? new String[0] : ((String) a.get("granted")).split(",")) {
            long held = jdbc.sql("""
                    select count(*) from membership where person_id = :p and organization_id = :o and role_code = :r
                      and valid_from <= :now and (valid_to is null or valid_to > :now)""")
                    .param("p", person).param("o", unit).param("r", role).param("now", Db.ts(now)).query(Long.class).single();
            if (held > 0) {
                continue;
            }
            UUID id = UUID.randomUUID();
            // «معتمد السلسلة الهرمية» without a unit choice is «هذا المستوى فقط», as TNQL (ADR-061): never every unit, never sites
            String m = CHAIN_APPROVER.equals(role) && (mode == null || "ALL".equals(mode) || "SITES".equals(mode)) ? "UNIT" : mode;
            jdbc.sql("""
                    insert into membership(id, person_id, organization_id, role_code, valid_from, scope_mode, scope_combine, scope_all, granted_by)
                    values (:id, :p, :o, :r, :f, :m, 'AND', :all, :by)""")
                    .param("id", id).param("p", person).param("o", unit).param("r", role).param("f", Db.ts(now))
                    .param("m", m == null ? "ROLE" : "CUSTOM").param("all", "ALL".equals(m)).param("by", ctx.personId()).update();
            // what the final approver approved is what is written, through the same scope tables every grant uses
            if ("UNIT".equals(m) || "UNIT_TREE".equals(m)) {
                scopeTarget(id, GrantTarget.ORGANIZATION, unit, "UNIT_TREE".equals(m));
            } else if (("UNITS".equals(m) || "SITES".equals(m)) && scope.get("ids") instanceof List<?> ids) {
                for (Object t : ids) {
                    scopeTarget(id, "SITES".equals(m) ? GrantTarget.SITE : GrantTarget.ORGANIZATION, UUID.fromString(t.toString()), false);
                }
            }
            audit.recordAs(ctx.actor(), "MEMBERSHIP_CREATED", "PERSON", person.toString(), null,
                    Map.of("organizationId", unit.toString(), "role", role, "accessRequest", requestId.toString(), "scope", m == null ? "ROLE" : m), null);
            made.add(role);
        }
        // an approved request makes the person one of the unit's users (owner, 16 Nov 2026, as TNQL: «من خلال طلب الصلاحيات»);
        // they stay listed after their grants end, as a TNQL account does, until removed from the unit
        if (unit != null && jdbc.sql("""
                insert into unit_member(id, person_id, organization_id, acting, added_by, added_at)
                select :id, :p, :o, false, coalesce(cast(:by as uuid), :p), :now
                where not exists (select 1 from unit_member where person_id = :p and organization_id = :o and ended_at is null)""")
                .param("id", UUID.randomUUID()).param("p", person).param("o", unit).param("by", ctx.personId()).param("now", Db.ts(now)).update() > 0) {
            audit.recordAs(ctx.actor(), "UNIT_MEMBER_ADDED", "PERSON", person.toString(), null,
                    Map.of("organizationId", unit.toString(), "acting", false, "accessRequest", requestId.toString()), null);
        }
        return made;
    }

    static final String CHAIN_APPROVER = "CHAIN_APPROVER";

    /** A main unit of the published HR snapshot: the top of a chain, never a level in it (TNQL's rule). */
    private boolean mainUnit(UUID org) {
        return jdbc.sql("""
                select count(*) from organization o join hr_unit h on h.external_id = o.source_external_id and h.is_main
                  and h.snapshot_id = (select s.id from hr_snapshot s where s.status = 'PUBLISHED') where o.id = :o""")
                .param("o", org).query(Long.class).single() > 0;
    }

    private void scopeTarget(UUID membership, String kind, UUID target, boolean descendants) {
        jdbc.sql("insert into membership_scope_target(membership_id, kind, target_id, include_descendants) values (:m, :k, :t, :d)")
                .param("m", membership).param("k", kind).param("t", target).param("d", descendants).update();
    }

    /** A different scope is a new grant (V9): ends the old one and makes the new one together, or changes nothing. */
    @Transactional
    public Map<String, Object> replace(AccessContext ctx, UUID oldId, GrantInput in, String reason) {
        String why = reason == null || reason.isBlank() ? "تحديث النطاق من مصفوفة الصلاحيات" : reason;
        end(ctx, oldId, null, why, null, false);
        Map<String, Object> made = create(ctx, in);
        UUID next = UUID.fromString((String) made.get("id"));
        // an access manager's grant changed: its delegations move to the new one unless now wider than it, its old final
        // step ends (the new grant makes its own when it keeps FINALIZE)
        String kept = jdbc.sql("select array_to_string(access_rights, ',') from membership where id = :n").param("n", next).query(String.class).optional().orElse(null);
        Set<Right> now = kept == null ? AccessRights.ALL : kept.isEmpty() ? java.util.EnumSet.noneOf(Right.class) : AccessRights.parse(List.of(kept.split(",")));
        for (Map<String, Object> child : jdbc.sql("""
                select id, role_code, array_to_string(access_rights, ',') as r from membership
                where sponsor_id = :o and (valid_to is null or valid_to > now())""").param("o", oldId).query().listOfRows()) {
            String r = (String) child.get("r");
            Set<Right> theirs = r == null ? AccessRights.ALL : r.isEmpty() ? java.util.EnumSet.noneOf(Right.class) : AccessRights.parse(List.of(r.split(",")));
            boolean keep = !"ACCESS_FINAL_APPROVER".equals(child.get("role_code")) && now.containsAll(theirs);
            jdbc.sql(keep ? "update membership set sponsor_id = :n where id = :c"
                            : "update membership set valid_to = greatest(valid_from + interval '1 millisecond', now()), ended_reason = 'تغيّرت المنحة التي بُنيت عليها' where id = :c")
                    .param("n", next).param("c", child.get("id")).update();
        }
        return made;
    }

    public record RouteInput(String name, String from, String to, List<Integer> days, Boolean active, List<String> targets) {
    }

    /** The periods of a command, with their units. */
    public List<Map<String, Object>> routes(AccessContext ctx, UUID command) {
        if (!ctx.canFor(Permission.MANAGE_ACCESS, command)) {
            throw ApiException.notFound();
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> r : jdbc.sql("""
                select id, name, to_char(time_from, 'HH24:MI') as time_from, to_char(time_to, 'HH24:MI') as time_to,
                       array_to_string(days, ',') as days, active from unit_ops_route where command_org_id = :c order by time_from, name""")
                .param("c", command).query().listOfRows()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.get("id").toString());
            m.put("name", r.get("name"));
            m.put("from", r.get("time_from"));
            m.put("to", r.get("time_to"));
            m.put("days", java.util.Arrays.stream(((String) r.get("days")).split(",")).map(Integer::valueOf).toList());
            m.put("active", r.get("active"));
            m.put("targets", jdbc.sql("""
                    select o.id, o.name from unit_ops_route_target t join organization o on o.id = t.organization_id
                    where t.route_id = :r order by o.name""").param("r", r.get("id"))
                    .query((rs, n) -> Map.of("id", rs.getString(1), "name", rs.getString(2))).list());
            out.add(m);
        }
        return out;
    }

    /** Replaces a command's periods together. Every unit named must lie inside the command, as in the movement programme. */
    @Transactional
    public List<Map<String, Object>> saveRoutes(AccessContext ctx, UUID command, List<RouteInput> routes) {
        if (!ctx.canFor(Permission.MANAGE_ACCESS, command)) {
            throw ApiException.notFound();
        }
        rightsOf.require(ctx, Right.UNIT_OPERATIONS, command);
        Set<UUID> inside = access.orgSubtree(command);
        jdbc.sql("delete from unit_ops_route where command_org_id = :c").param("c", command).update();
        for (RouteInput r : routes == null ? List.<RouteInput>of() : routes) {
            if (r.name() == null || r.name().isBlank() || r.days() == null || r.days().isEmpty() || r.targets() == null || r.targets().isEmpty()) {
                throw ApiException.validation("حدد لكل فترة اسماً وأياماً وجهة مستلمة واحدة على الأقل.");
            }
            java.time.LocalTime from;
            java.time.LocalTime to;
            try {
                from = java.time.LocalTime.parse(r.from());
                to = java.time.LocalTime.parse(r.to());
            } catch (RuntimeException e) {
                throw ApiException.validation("وقت الفترة غير صحيح.");
            }
            if (from.equals(to)) {
                throw ApiException.validation("بداية الفترة ونهايتها متساويتان.");
            }
            UUID id = UUID.randomUUID();
            jdbc.sql("""
                    insert into unit_ops_route(id, command_org_id, name, time_from, time_to, days, active, created_by)
                    values (:id, :c, :n, cast(:f as time), cast(:t as time), string_to_array(:d, ',')::int[], :a, :by)""")
                    .param("id", id).param("c", command).param("n", r.name().trim()).param("f", from.toString()).param("t", to.toString())
                    .param("d", String.join(",", r.days().stream().map(String::valueOf).toList())).param("a", !Boolean.FALSE.equals(r.active()))
                    .param("by", ctx.personId()).update();
            for (String target : r.targets()) {
                UUID unit = uuid(target, "الجهة المستلمة");
                if (!inside.contains(unit)) {
                    throw ApiException.validation("الجهة المستلمة يجب أن تكون داخل هذه الوحدة.");
                }
                jdbc.sql("insert into unit_ops_route_target(route_id, organization_id) values (:r, :o)").param("r", id).param("o", unit).update();
            }
        }
        audit.recordAs(ctx.actor(), "UNIT_OPS_ROUTES_SAVED", "ORGANIZATION", command.toString(), null, Map.of("routes", routes == null ? 0 : routes.size()), null);
        return routes(ctx, command);
    }

    /** «الجهات الرئيسية للعلم»: chosen explicitly and audited. Holders covering one read every finally approved request. */
    public List<Map<String, Object>> fyiMains(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        return jdbc.sql("""
                select f.organization_id, o.name from fyi_main_command f join organization o on o.id = f.organization_id order by o.name""")
                .query((rs, n) -> Map.<String, Object>of("id", rs.getString(1), "name", rs.getString(2))).list();
    }

    @Transactional
    public void setFyiMain(AccessContext ctx, UUID orgId, boolean chosen) {
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("يحدد الجهات الرئيسية للعلم مسؤول الصلاحيات العام فقط.");
        }
        if (chosen) {
            jdbc.sql("insert into fyi_main_command(organization_id, added_by) values (:o, :p) on conflict do nothing")
                    .param("o", orgId).param("p", ctx.personId()).update();
        } else {
            jdbc.sql("delete from fyi_main_command where organization_id = :o").param("o", orgId).update();
        }
        audit.recordAs(ctx.actor(), chosen ? "FYI_MAIN_COMMAND_ADDED" : "FYI_MAIN_COMMAND_REMOVED", "ORGANIZATION", orgId.toString(), null, Map.of(), null);
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
        List<GrantTarget> named = "CUSTOM".equals(g.scopeMode())
                ? g.targets().stream().filter(t -> GrantTarget.ORGANIZATION.equals(t.kind())).toList() : s.orgs();
        for (GrantTarget t : named) {
            orgParts.add("«" + names.of(t) + "»" + (t.limited()
                    ? ": المستوى " + String.join(" و", t.levels().stream().map(String::valueOf).toList())
                    : t.includeDescendants() ? " وفروعها" : " وحدها"));
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
