package ae.mover.authz;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessRights;
import ae.mover.access.AccessRights.Right;
import ae.mover.access.DirectoryScope;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Times;

/**
 * The rest of TNQL's access workspace (owner, 11 Nov 2026: "finish the missing one in one go"; ADR-059): duty permits
 * («تصاريح المناوبة»), the account card, the providing departments of «معتمد التوفر» and the units that provide them.
 */
@Service
public class AccessAdminService {

    public static final String AVAILABILITY_PREFIX = "AVAILABILITY_";
    static final Duration MAX_PERMIT = Duration.ofDays(7);

    public record PermitInput(String personId, String organizationId, String roleCode, String validFrom, String validTo, String reason) {
    }

    public record EndInput(String reason) {
    }

    public record ActiveInput(Boolean active, String reason) {
    }

    public record ProfileInput(String displayName) {
    }

    public record DepartmentInput(String code, String name) {
    }

    public record ProviderInput(String roleCode, Boolean on) {
    }

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AuditService audit;
    private final GrantAdminService grants;
    private final AccessRights rights;
    private final DirectoryScope directory;
    private final AccessPolicyService policies;

    public AccessAdminService(JdbcClient jdbc, Clock clock, AuditService audit, GrantAdminService grants, AccessRights rights,
                              DirectoryScope directory, AccessPolicyService policies) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.audit = audit;
        this.grants = grants;
        this.rights = rights;
        this.directory = directory;
        this.policies = policies;
    }

    private static UUID uuid(String v, String label) {
        try {
            return UUID.fromString(v);
        } catch (RuntimeException e) {
            throw ApiException.validation("معرف " + label + " غير صحيح.");
        }
    }

    // ---- duty permits ------------------------------------------------------------------------------------------------

    private static final String PERMIT = """
            select dp.id, dp.person_id, p.display_name, p.employee_no, dp.organization_id, o.name as org_name, dp.role_code, r.name as role_name,
                   dp.valid_from, dp.valid_to, dp.reason, dp.issued_at, g.display_name as issued_by_name, dp.issued_by,
                   dp.activated_at, dp.ended_at, dp.end_reason
            from duty_permit dp join person p on p.id = dp.person_id join organization o on o.id = dp.organization_id
            join role_def r on r.code = dp.role_code left join person g on g.id = dp.issued_by""";

    private Map<String, Object> permitView(Map<String, Object> r) {
        Instant now = clock.instant();
        Instant from = Db.toInstant(r.get("valid_from"));
        Instant to = Db.toInstant(r.get("valid_to"));
        String state = r.get("ended_at") != null ? "ENDED" : !to.isAfter(now) ? "EXPIRED"
                : r.get("activated_at") != null ? (from.isAfter(now) ? "ACTIVATED" : "ACTIVE") : "ISSUED";
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", r.get("id").toString());
        m.put("person", Map.of("id", r.get("person_id").toString(), "displayName", r.get("display_name"), "employeeNo", r.get("employee_no")));
        m.put("organization", Map.of("id", r.get("organization_id").toString(), "name", r.get("org_name")));
        m.put("role", Map.of("code", r.get("role_code"), "name", r.get("role_name")));
        m.put("validFrom", from.toString());
        m.put("validTo", to.toString());
        m.put("reason", r.get("reason"));
        m.put("issuedBy", r.get("issued_by_name"));
        m.put("issuedAt", Db.toInstant(r.get("issued_at")).toString());
        m.put("activatedAt", r.get("activated_at") == null ? null : Db.toInstant(r.get("activated_at")).toString());
        m.put("endReason", r.get("end_reason"));
        m.put("state", state);
        return m;
    }

    /** A unit's duty permits, newest first: current ones and the last ended. */
    public List<Map<String, Object>> permits(AccessContext ctx, UUID org) {
        rights.require(ctx, Right.DUTY, org);
        return jdbc.sql(PERMIT + " where dp.organization_id = :o order by (dp.ended_at is null and dp.valid_to > now()) desc, dp.valid_from desc limit 50")
                .param("o", org).query().listOfRows().stream().map(this::permitView).toList();
    }

    /**
     * Issues a permit: by a holder of «إدارة صلاحية المناوبة» at the unit, for a role they may give there, to someone else in
     * their reach, for one window of at most seven days. Nothing is in force until the holder activates it inside the window.
     */
    @Transactional
    public Map<String, Object> issue(AccessContext ctx, PermitInput in) {
        if (in == null || in.personId() == null || in.organizationId() == null || in.roleCode() == null) {
            throw ApiException.validation("حدد الشخص والوحدة والصلاحية.");
        }
        UUID org = uuid(in.organizationId(), "الوحدة");
        UUID person = uuid(in.personId(), "الشخص");
        rights.require(ctx, Right.DUTY, org);
        grants.requireGrantee(ctx, person);
        Map<String, Object> role = jdbc.sql("select code, permissions, system from role_def where code = :c").param("c", in.roleCode())
                .query().listOfRows().stream().findFirst().orElseThrow(() -> ApiException.validation("الدور غير موجود في السياسة المنشورة."));
        if ((Boolean) role.get("system") || GrantAdminService.permissions(role.get("permissions")).contains(Permission.MANAGE_ACCESS)) {
            throw ApiException.validation("تصريح المناوبة لا يمنح إدارة الصلاحيات ولا دور نظام.");
        }
        GrantAdminService.requireGivable(GrantAdminService.permissions(role.get("permissions")));
        grants.requireAuthorityForRole(ctx, org, in.roleCode(), null, Right.DUTY);
        Instant from = in.validFrom() == null || in.validFrom().isBlank() ? clock.instant() : Times.parse(in.validFrom(), "validFrom");
        Instant to = in.validTo() == null || in.validTo().isBlank() ? null : Times.parse(in.validTo(), "validTo");
        if (to == null || !to.isAfter(from) || !to.isAfter(clock.instant())) {
            throw ApiException.validation("حدد نهاية للمناوبة بعد بدايتها وبعد الآن.");
        }
        if (Duration.between(from, to).compareTo(MAX_PERMIT) > 0) {
            throw ApiException.validation("تصريح المناوبة لا يتجاوز سبعة أيام.");
        }
        if (in.reason() == null || in.reason().trim().length() < 3) {
            throw ApiException.validation("اذكر سبب التصريح.");
        }
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into duty_permit(id, person_id, organization_id, role_code, valid_from, valid_to, reason, issued_by)
                values (:id, :p, :o, :r, :f, :t, :why, :by)""")
                .param("id", id).param("p", person).param("o", org).param("r", in.roleCode()).param("f", Db.ts(from)).param("t", Db.ts(to))
                .param("why", in.reason().trim()).param("by", ctx.personId()).update();
        jdbc.sql("""
                insert into notification(id, person_id, kind, title, body, created_at, link)
                values (:id, :p, 'DUTY_PERMIT', 'تصريح مناوبة', :b, :now, '#requestAccess')""")
                .param("id", UUID.randomUUID()).param("p", person).param("b", "صدر لك تصريح مناوبة؛ فعّله عند بدء المناوبة من «صلاحياتي».")
                .param("now", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), "DUTY_PERMIT_ISSUED", "PERSON", person.toString(), null,
                Map.of("permitId", id.toString(), "organizationId", org.toString(), "role", in.roleCode(), "validFrom", from.toString(), "validTo", to.toString()),
                in.reason().trim());
        return permitView(jdbc.sql(PERMIT + " where dp.id = :id").param("id", id).query().singleRow());
    }

    /** The holder's own permits: to activate, in force, and the recently ended. */
    public List<Map<String, Object>> mine(AccessContext ctx) {
        return jdbc.sql(PERMIT + " where dp.person_id = :p and (dp.ended_at is null or dp.ended_at > now() - interval '7 days') order by dp.valid_from desc limit 20")
                .param("p", ctx.personId()).query().listOfRows().stream().map(this::permitView).toList();
    }

    /** The holder starts the duty: only inside the window, once. */
    @Transactional
    public Map<String, Object> activate(AccessContext ctx, UUID id) {
        Map<String, Object> r = jdbc.sql(PERMIT + " where dp.id = :id for update of dp").param("id", id).query().listOfRows().stream().findFirst()
                .orElseThrow(ApiException::notFound);
        if (!ctx.personId().equals(r.get("person_id"))) {
            throw ApiException.notFound();
        }
        Instant now = clock.instant();
        if (r.get("ended_at") != null || !Db.toInstant(r.get("valid_to")).isAfter(now)) {
            throw ApiException.validation("انتهى هذا التصريح.");
        }
        if (Db.toInstant(r.get("valid_from")).isAfter(now.plus(Duration.ofMinutes(15)))) {
            throw ApiException.validation("لم تبدأ المناوبة بعد؛ يُفعَّل التصريح عند بدايتها.");
        }
        if (r.get("activated_at") == null) {
            jdbc.sql("update duty_permit set activated_at = :now where id = :id").param("now", Db.ts(now)).param("id", id).update();
            audit.recordAs(ctx.actor(), "DUTY_PERMIT_ACTIVATED", "PERSON", ctx.personId().toString(), null,
                    Map.of("permitId", id.toString(), "organizationId", r.get("organization_id").toString(), "role", r.get("role_code")), null);
        }
        return permitView(jdbc.sql(PERMIT + " where dp.id = :id").param("id", id).query().singleRow());
    }

    /** Ends a permit early: its holder, its issuer, or a holder of the duty right at its unit. */
    @Transactional
    public Map<String, Object> endPermit(AccessContext ctx, UUID id, EndInput in) {
        Map<String, Object> r = jdbc.sql(PERMIT + " where dp.id = :id for update of dp").param("id", id).query().listOfRows().stream().findFirst()
                .orElseThrow(ApiException::notFound);
        boolean holder = ctx.personId().equals(r.get("person_id"));
        if (!holder && !ctx.personId().equals(r.get("issued_by")) && !rights.can(ctx, Right.DUTY, (UUID) r.get("organization_id"))) {
            throw ApiException.notFound();
        }
        if (r.get("ended_at") != null) {
            throw ApiException.validation("التصريح منتهٍ بالفعل.");
        }
        String reason = in == null || in.reason() == null || in.reason().isBlank() ? (holder ? "انتهت المناوبة" : null) : in.reason().trim();
        if (reason == null) {
            throw ApiException.validation("اذكر سبب إنهاء التصريح.");
        }
        jdbc.sql("update duty_permit set ended_at = :now, ended_by = :by, end_reason = :r where id = :id")
                .param("now", Db.ts(clock.instant())).param("by", ctx.personId()).param("r", reason).param("id", id).update();
        audit.recordAs(ctx.actor(), "DUTY_PERMIT_ENDED", "PERSON", r.get("person_id").toString(), null,
                Map.of("permitId", id.toString(), "organizationId", r.get("organization_id").toString(), "role", r.get("role_code")), reason);
        return permitView(jdbc.sql(PERMIT + " where dp.id = :id").param("id", id).query().singleRow());
    }

    // ---- the account card --------------------------------------------------------------------------------------------

    private Map<String, Object> personRow(UUID person) {
        return jdbc.sql("""
                select p.id, p.display_name, p.employee_no, p.username, p.status, p.source, p.created_at, coalesce(p.bootstrap, false) as bootstrap,
                       p.access_disabled, p.access_disabled_reason, p.hr_unavailable,
                       exists (select 1 from identity_link l where l.person_id = p.id) as linked,
                       exists (select 1 from identity_link l where l.person_id = p.id and l.method = 'PLATFORM') as platform
                from person p where p.id = :p""").param("p", person).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
    }

    private void requireCovered(AccessContext ctx, UUID person) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (!directory.covers(ctx, person)) {
            throw ApiException.notFound();
        }
    }

    /** The units a person belongs to: their HR posting and the units they were added to. */
    private List<Map<String, Object>> units(UUID person) {
        return jdbc.sql("""
                select o.id, o.name, 'HR' as how from affiliation a join organization o on o.id = a.organization_id where a.person_id = :p and a.valid_to is null
                union all
                select o.id, o.name, case when um.acting then 'ACTING' else 'ADDED' end from unit_member um join organization o on o.id = um.organization_id
                where um.person_id = :p and um.ended_at is null""").param("p", person)
                .query((rs, n) -> Map.<String, Object>of("id", rs.getString(1), "name", rs.getString(2), "how", rs.getString(3))).list();
    }

    /** Whether this manager may change the person's account: a global manager, or «منح الصلاحيات» over one of their units. */
    private boolean mayEdit(AccessContext ctx, UUID person) {
        if (grants.keys().same(ctx.personId(), person)) {
            return false;
        }
        if (ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            return true;
        }
        return units(person).stream().anyMatch(u -> rights.can(ctx, Right.GRANT, UUID.fromString((String) u.get("id"))));
    }

    /** «بطاقة الحساب»: who the person is, where, how they sign in, what they hold and why, their permits and account history. */
    public Map<String, Object> card(AccessContext ctx, UUID person) {
        requireCovered(ctx, person);
        Map<String, Object> p = personRow(person);
        boolean global = ctx.canEverywhere(Permission.MANAGE_ACCESS);
        String no = (String) p.get("employee_no");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", person.toString());
        out.put("displayName", p.get("display_name"));
        out.put("employeeNo", no != null && no.startsWith(UnitMemberService.LOCAL_USER_PREFIX) && p.get("username") != null ? p.get("username") : no);
        out.put("username", p.get("username"));
        out.put("source", p.get("source"));
        out.put("hrStatus", p.get("status"));
        out.put("accessDisabled", p.get("access_disabled"));
        out.put("accessDisabledReason", p.get("access_disabled_reason"));
        out.put("hrUnavailable", p.get("hr_unavailable"));
        out.put("linked", p.get("linked"));
        out.put("system", (Boolean) p.get("bootstrap") || (Boolean) p.get("platform"));
        out.put("createdAt", Db.toInstant(p.get("created_at")).toString());
        out.put("units", units(person));
        out.put("grants", jdbc.sql("""
                select m.id, r.code, r.name, r.system, o.name as org_name, m.valid_to, m.sponsor_id is not null as delegated,
                       array_to_string(m.access_rights, ',') as rights
                from membership m join role_def r on r.code = m.role_code join organization o on o.id = m.organization_id
                where m.person_id = :p and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()) order by r.sort_order, r.name""")
                .param("p", person).query().listOfRows().stream().map(r -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", r.get("id").toString());
                    m.put("role", Map.of("code", r.get("code"), "name", r.get("name")));
                    m.put("system", r.get("system"));
                    m.put("organization", r.get("org_name"));
                    m.put("validTo", r.get("valid_to") == null ? null : Db.toInstant(r.get("valid_to")).toString());
                    m.put("delegated", r.get("delegated"));
                    m.put("rights", r.get("rights") == null ? null : ((String) r.get("rights")).isEmpty() ? List.of() : List.of(((String) r.get("rights")).split(",")));
                    return m;
                }).toList());
        out.put("permits", jdbc.sql(PERMIT + " where dp.person_id = :p order by dp.valid_from desc limit 10").param("p", person).query().listOfRows()
                .stream().map(this::permitView).toList());
        out.put("history", jdbc.sql("""
                select occurred_at, action, actor_name, reason from audit_event
                where entity_type = 'PERSON' and entity_id = :p order by id desc limit 30""").param("p", person.toString())
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("at", Db.toInstant(rs.getTimestamp("occurred_at")).toString());
                    m.put("action", rs.getString("action"));
                    m.put("by", rs.getString("actor_name"));
                    m.put("reason", rs.getString("reason"));
                    return m;
                }).list());
        out.put("systemRoles", global ? jdbc.sql("select code, name from role_def where system order by sort_order, name")
                .query((rs, n) -> Map.<String, Object>of("code", rs.getString(1), "name", rs.getString(2))).list() : List.of());
        out.put("canEdit", mayEdit(ctx, person) && !(Boolean) out.get("system"));
        out.put("canRetire", global && "LOCAL".equals(p.get("source")) && !(Boolean) out.get("system") && !grants.keys().same(ctx.personId(), person)
                && "ACTIVE".equals(p.get("status")));
        // ADR-103: a local account ended by «حذف الحساب» comes back only through a global manager, with a reason
        out.put("canReinstate", global && "LOCAL".equals(p.get("source")) && !(Boolean) out.get("system")
                && !grants.keys().same(ctx.personId(), person) && "DISABLED".equals(p.get("status")));
        out.put("canEditProfile", mayEdit(ctx, person) && "LOCAL".equals(p.get("source")) && !(Boolean) out.get("system"));
        return out;
    }

    /** «حساب نشط»: switches the person's access off or on here, whatever HR says; their grants stay and return when switched on. */
    @Transactional
    public Map<String, Object> setActive(AccessContext ctx, UUID person, ActiveInput in) {
        requireCovered(ctx, person);
        if (!mayEdit(ctx, person) || (Boolean) card(ctx, person).get("system")) {
            throw ApiException.forbidden("لا يمكنك تعديل هذا الحساب.");
        }
        boolean active = in != null && Boolean.TRUE.equals(in.active());
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (!active && reason.length() < 3) {
            throw ApiException.validation("اذكر سبب إيقاف الحساب.");
        }
        jdbc.sql("update person set access_disabled = :off, access_disabled_reason = :r where id = :p")
                .param("off", !active).param("r", active ? null : reason).param("p", person).update();
        audit.recordAs(ctx.actor(), active ? "PERSON_ACCESS_ENABLED" : "PERSON_ACCESS_DISABLED", "PERSON", person.toString(), null, Map.of(),
                reason.isEmpty() ? null : reason);
        return card(ctx, person);
    }

    /** Edits the name of a local account (an HR record is edited in HR). */
    @Transactional
    public Map<String, Object> profile(AccessContext ctx, UUID person, ProfileInput in) {
        requireCovered(ctx, person);
        Map<String, Object> c = card(ctx, person);
        if (!(Boolean) c.get("canEditProfile")) {
            throw ApiException.forbidden("بيانات سجل الموارد البشرية تُعدَّل في الموارد البشرية.");
        }
        String name = in == null || in.displayName() == null ? "" : in.displayName().trim();
        if (name.length() < 3 || name.length() > 120) {
            throw ApiException.validation("الاسم بين 3 و120 حرفاً.");
        }
        jdbc.sql("update person set display_name = :n where id = :p").param("n", name).param("p", person).update();
        audit.recordAs(ctx.actor(), "PERSON_PROFILE_CHANGED", "PERSON", person.toString(), null, Map.of("displayName", name), null);
        return card(ctx, person);
    }

    /**
     * «إعادة الحساب» (ADR-103): a local account ended by «حذف الحساب» is switched on again by a global manager, with a reason,
     * audited. Only the account returns: the grants, unit entries, delegations and permits it ended stay ended and are given
     * again one by one through the usual rules (least privilege). Before ADR-103 there was no way back except SQL on the server.
     */
    @Transactional
    public Map<String, Object> reinstate(AccessContext ctx, UUID person, EndInput in) {
        requireCovered(ctx, person);
        if (!(Boolean) card(ctx, person).get("canReinstate")) {
            throw ApiException.forbidden("يعيد الحسابات المحلية الموقوفة مدير الصلاحيات العام فقط.");
        }
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation("اذكر سبب إعادة الحساب.");
        }
        jdbc.sql("update person set status = 'ACTIVE', access_disabled = false, access_disabled_reason = null where id = :p")
                .param("p", person).update();
        audit.recordAs(ctx.actor(), "PERSON_REINSTATED", "PERSON", person.toString(), null, Map.of("grantsRestored", 0), reason);
        return card(ctx, person);
    }

    /**
     * «حذف الحساب» of a local account: never a deletion — the audit refers to it — but every grant, unit entry, delegation and
     * permit ends and the account is switched off. A global manager only; an HR record is ended by HR.
     */
    @Transactional
    public Map<String, Object> retire(AccessContext ctx, UUID person, EndInput in) {
        requireCovered(ctx, person);
        if (!(Boolean) card(ctx, person).get("canRetire")) {
            throw ApiException.forbidden("يحذف الحسابات المحلية مدير الصلاحيات العام فقط؛ سجل الموارد البشرية يُنهى في الموارد البشرية.");
        }
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation("اذكر سبب حذف الحساب.");
        }
        Instant now = clock.instant();
        int ended = jdbc.sql("""
                update membership set valid_to = greatest(valid_from + interval '1 millisecond', :now), ended_reason = :r
                where person_id = :p and (valid_to is null or valid_to > :now)""").param("now", Db.ts(now)).param("r", reason).param("p", person).update();
        jdbc.sql("update unit_member set ended_at = :now, ended_by = :by, ended_reason = :r where person_id = :p and ended_at is null")
                .param("now", Db.ts(now)).param("by", ctx.personId()).param("r", reason).param("p", person).update();
        jdbc.sql("update delegation set revoked_at = :now, revoked_by = :by, revoke_reason = :r where (delegator_id = :p or delegate_id = :p) and revoked_at is null")
                .param("now", Db.ts(now)).param("by", ctx.personId()).param("r", reason).param("p", person).update();
        jdbc.sql("update duty_permit set ended_at = :now, ended_by = :by, end_reason = :r where person_id = :p and ended_at is null")
                .param("now", Db.ts(now)).param("by", ctx.personId()).param("r", reason).param("p", person).update();
        jdbc.sql("update person set access_disabled = true, access_disabled_reason = :r, status = 'DISABLED' where id = :p")
                .param("r", reason).param("p", person).update();
        audit.recordAs(ctx.actor(), "PERSON_RETIRED", "PERSON", person.toString(), null, Map.of("grantsEnded", ended), reason);
        return card(ctx, person);
    }

    // ---- «معتمد التوفر»: providing departments -----------------------------------------------------------------------

    /** The providing departments (roles named AVAILABILITY_…) and how many units provide each. */
    public List<Map<String, Object>> departments(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        return jdbc.sql("""
                select r.code, r.name, (select count(*) from provider_unit pu where pu.role_code = r.code) as providers
                from role_def r where r.code like 'AVAILABILITY\\_%' order by r.sort_order, r.name""")
                .query((rs, n) -> Map.<String, Object>of("code", rs.getString(1), "name", rs.getString(2), "providers", rs.getLong(3))).list();
    }

    /**
     * Adds a providing department: a role «معتمد التوفر — …» (VIEW, REVIEW over its unit) published as a new role policy version,
     * as every role is data (ADR-018); unit access managers may give it at units providing it. Refused while another draft is open.
     */
    @Transactional
    public List<Map<String, Object>> addDepartment(AccessContext ctx, DepartmentInput in) {
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("يضيف إدارات التوفير مدير الصلاحيات العام.");
        }
        String code = in == null || in.code() == null ? "" : in.code().trim().toUpperCase(java.util.Locale.ROOT);
        String name = in == null || in.name() == null ? "" : in.name().trim();
        if (!code.matches("[A-Z][A-Z0-9_]{1,25}") || name.length() < 2) {
            throw ApiException.validation("رمز الإدارة: أحرف لاتينية كبيرة وأرقام (2–26)، والاسم مطلوب.");
        }
        if (jdbc.sql("select count(*) from access_policy_version where status = 'DRAFT'").query(Long.class).single() > 0) {
            throw ApiException.validation("توجد مسودة سياسة أدوار غير منشورة؛ انشرها أو تجاهلها أولاً من «الأدوار والإصدارات».");
        }
        String role = AVAILABILITY_PREFIX + code;
        String note = "إدارة توفير: " + name;
        policies.draft(ctx, note);
        policies.saveDraftRole(ctx, new AccessPolicyService.RoleInput(role, "معتمد التوفر — " + name, List.of("VIEW", "REVIEW"), "ORGANIZATION", false, null));
        // the unit access manager may give it, at units providing it; its other settings are kept as they are
        jdbc.sql("""
                select name, array_to_string(permissions, ',') as perms, scope, summary_only, coalesce(array_to_string(grantable_roles, ','), '') as g
                from role_def where code = 'UNIT_ACCESS_MANAGER'""").query().listOfRows().stream().findFirst().ifPresent(m -> {
            List<String> managed = ((String) m.get("g")).isEmpty() ? new ArrayList<>() : new ArrayList<>(List.of(((String) m.get("g")).split(",")));
            if (!managed.contains(role)) {
                managed.add(role);
                policies.saveDraftRole(ctx, new AccessPolicyService.RoleInput("UNIT_ACCESS_MANAGER", (String) m.get("name"),
                        List.of(((String) m.get("perms")).split(",")), (String) m.get("scope"), (Boolean) m.get("summary_only"), managed));
            }
        });
        policies.publish(ctx, note);
        audit.recordAs(ctx.actor(), "PROVIDER_DEPARTMENT_ADDED", "POLICY", role, name, Map.of("role", role), null);
        return departments(ctx);
    }

    /** The departments a unit provides («إلحاق الوحدات وتعيين مهام التوفير», the ATTACH right). */
    public List<String> providers(AccessContext ctx, UUID org) {
        ctx.require(Permission.MANAGE_ACCESS);
        return jdbc.sql("select role_code from provider_unit where organization_id = :o order by 1").param("o", org).query(String.class).list();
    }

    @Transactional
    public List<String> setProvider(AccessContext ctx, UUID org, ProviderInput in) {
        rights.require(ctx, Right.ATTACH, org);
        if (in == null || in.roleCode() == null || !in.roleCode().startsWith(AVAILABILITY_PREFIX)
                || jdbc.sql("select count(*) from role_def where code = :r").param("r", in.roleCode()).query(Long.class).single() == 0) {
            throw ApiException.validation("إدارة التوفير غير موجودة.");
        }
        if (Boolean.TRUE.equals(in.on())) {
            jdbc.sql("insert into provider_unit(organization_id, role_code, added_by) values (:o, :r, :by) on conflict do nothing")
                    .param("o", org).param("r", in.roleCode()).param("by", ctx.personId()).update();
        } else {
            jdbc.sql("delete from provider_unit where organization_id = :o and role_code = :r").param("o", org).param("r", in.roleCode()).update();
        }
        audit.recordAs(ctx.actor(), Boolean.TRUE.equals(in.on()) ? "PROVIDER_UNIT_ADDED" : "PROVIDER_UNIT_REMOVED", "ORGANIZATION", org.toString(), null,
                Map.of("organizationId", org.toString(), "role", in.roleCode()), null);
        return providers(ctx, org);
    }
}
