package ae.mover.authz;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.access.PersonKeys;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.hr.HrPeopleService;
import ae.mover.security.OidcProperties;

/**
 * «مديرو النظام» (ADR-103, replacing the ADR-102 lifecycle whose add failed on every call). A system administrator is found by
 * one of the two verified identity lookups, shown, and only then granted:
 *
 * <ul>
 *   <li>{@code EMPLOYEE_NUMBER}: Oracle HR asked live (read-only, {@link HrPeopleService#find}); an active, unambiguous record only.
 *       A person not yet in TMRKZ is imported from that record on confirmation (never fabricated);</li>
 *   <li>{@code DIRECTORY_ACCOUNT}: an account the enterprise directory itself verified by a previous sign-in (an identity link,
 *       ADR-068/ADR-100 — no directory service account is ever used to search).</li>
 * </ul>
 *
 * The resolved identity carries a confirmation fingerprint; the grant is made only when the same fingerprint comes back with a
 * reason, through the standard grant path ({@link GrantAdminService#create}: separation of duties, bootstrap identity, audit,
 * authorisation outbox). Granting or ending the role needs configuration AND access management over everything. The last
 * effective administrator cannot be removed; the check and the change are serialised by an advisory lock.
 */
@Service
public class AdministratorService {

    public static final String ROLE = "SYSTEM_ADMIN";
    public static final String EMPLOYEE_NUMBER = "EMPLOYEE_NUMBER";
    public static final String DIRECTORY_ACCOUNT = "DIRECTORY_ACCOUNT";
    private static final long LOCK_KEY = 0x544d524b5a41L; // "TMRKZA"

    public record AdminView(String personId, String displayName, String username, String employeeNumber, String grantedAt,
                            String grantedBy, boolean platform, boolean effective) {
    }

    public record ResolveInput(String method, String value) {
    }

    public record AddInput(String method, String value, String confirmation, String reason) {
    }

    public record EndInput(String reason) {
    }

    /** The identity shown for confirmation. {@code personId} is null for an HR employee not yet in TMRKZ (imported on confirm). */
    public record Candidate(String method, String value, String verifiedBy, String personId, String displayName, String employeeNumber,
                            String account, String unitName, String hrStatus, boolean alreadyAdmin, String confirmation) {
    }

    private record Resolved(Candidate candidate, UUID person, HrPeopleService.HrRecord hr) {
    }

    private final JdbcClient jdbc;
    private final AuditService audit;
    private final HrPeopleService hrPeople;
    private final GrantAdminService grants;
    private final PersonKeys keys;
    private final OidcProperties oidc;

    public AdministratorService(JdbcClient jdbc, AuditService audit, HrPeopleService hrPeople, GrantAdminService grants,
                                PersonKeys keys, OidcProperties oidc) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.hrPeople = hrPeople;
        this.grants = grants;
        this.keys = keys;
        this.oidc = oidc;
    }

    /** Handing out or taking back the system administrator role: configuration and access management over everything. */
    private static void requireGlobal(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("يمنح صلاحية مدير النظام ويسحبها مدير صلاحيات عام فقط.");
        }
    }

    /** A current system administrator grant of membership {@code m} (leading space: text blocks drop the trailing one before it). */
    private static final String CURRENT = " m.role_code = 'SYSTEM_ADMIN' and m.valid_from <= clock_timestamp() and (m.valid_to is null or m.valid_to > clock_timestamp())";

    public List<AdminView> list(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Map<String, AdminView> out = new LinkedHashMap<>();
        jdbc.sql("""
                select m.person_id, p.display_name, p.username, p.employee_no, m.valid_from, g.display_name as granted_by,
                       p.employee_no like 'PLATFORM-%' as platform,
                       o.status = 'ACTIVE' and not p.access_disabled as effective
                from membership m
                join person p on p.id = m.person_id and p.status = 'ACTIVE'
                join organization o on o.id = m.organization_id
                left join person g on g.id = m.granted_by
                where """ + CURRENT + " order by m.valid_from")
                .query((rs, n) -> {
                    String id = rs.getString("person_id");
                    AdminView prior = out.get(id);
                    boolean effective = rs.getBoolean("effective") || prior != null && prior.effective();
                    out.put(id, new AdminView(id, rs.getString("display_name"), rs.getString("username"), rs.getString("employee_no"),
                            prior != null ? prior.grantedAt() : Db.toInstant(rs.getTimestamp("valid_from")).toString(),
                            prior != null ? prior.grantedBy() : rs.getString("granted_by"), rs.getBoolean("platform"), effective));
                    return null;
                }).list();
        return List.copyOf(out.values());
    }

    public Candidate resolve(AccessContext ctx, ResolveInput in) {
        requireGlobal(ctx);
        return resolved(ctx, in == null ? null : in.method(), in == null ? null : in.value()).candidate();
    }

    private Resolved resolved(AccessContext ctx, String method, String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty() || value.length() > 120) {
            throw ApiException.validation("اكتب الرقم الوظيفي أو حساب الدليل المؤسسي.");
        }
        Resolved r;
        if (EMPLOYEE_NUMBER.equals(method)) {
            r = byEmployeeNumber(value);
        } else if (DIRECTORY_ACCOUNT.equals(method)) {
            r = byDirectoryAccount(value);
        } else {
            throw ApiException.validation("طريقة التحقق غير معروفة: اختر الرقم الوظيفي (الموارد البشرية) أو حساب الدليل المؤسسي.");
        }
        if (r.person() != null && keys.same(ctx.personId(), r.person())) {
            throw ApiException.forbidden("لا يمكنك منح نفسك صلاحية مدير النظام؛ يمنحها لك مدير نظام آخر.");
        }
        return r;
    }

    private Resolved byEmployeeNumber(String number) {
        if (!hrPeople.configured()) {
            throw new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED,
                    "التحقق بالرقم الوظيفي يسأل مصدر الموارد البشرية (Oracle)، وهو غير مهيأ أو غير مفعل؛ استخدم حساب الدليل المؤسسي.");
        }
        List<HrPeopleService.HrRecord> found = hrPeople.find(number, null); // HR_SOURCE_UNAVAILABLE etc. are passed on as they are
        if (found.isEmpty()) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, "لم يجد مصدر الموارد البشرية موظفاً بهذا الرقم الوظيفي.");
        }
        List<HrPeopleService.HrRecord> active = found.stream().filter(HrPeopleService.HrRecord::active).toList();
        if (active.isEmpty()) {
            throw ApiException.validation("سجل الموظف غير نشط في الموارد البشرية؛ لا تُمنح له صلاحية مدير النظام.");
        }
        if (active.size() > 1) {
            throw ApiException.validation("الرقم يطابق أكثر من سجل نشط في الموارد البشرية؛ لا يُختار أحدها آلياً.");
        }
        HrPeopleService.HrRecord r = active.get(0);
        UUID person = hrPeople.existing(r.externalId());
        if (person != null) {
            Map<String, Object> p = jdbc.sql("select status, access_disabled from person where id = :p").param("p", person).query().singleRow();
            if (Boolean.TRUE.equals(p.get("access_disabled"))) {
                throw ApiException.validation("حساب هذا الموظف موقوف في تمركز؛ يعيده مدير الصلاحيات من بطاقة الحساب أولاً.");
            }
        }
        String unit = r.unitExternalId() == null ? null : jdbc.sql("select name from organization where source = 'HR' and source_external_id = :x")
                .param("x", r.unitExternalId()).query(String.class).optional().orElse(null);
        Candidate c = candidate(EMPLOYEE_NUMBER, r.employeeNumber(), "ORACLE_HR", person, "HR:" + r.externalId(), r.fullName(),
                r.employeeNumber(), r.domainAccount(), unit, r.statusText());
        return new Resolved(c, person, r);
    }

    private Resolved byDirectoryAccount(String raw) {
        String login = UnitMemberService.normalLogin(raw);
        if (login == null) {
            throw ApiException.validation("حساب الدليل غير صالح: أحرف لاتينية وأرقام فقط، مثل u1234567.");
        }
        if (oidc.platformAccount(login)) {
            throw ApiException.validation("هذا حساب منصة دائم؛ صلاحياته من إعدادات التثبيت لا من هنا.");
        }
        List<Map<String, Object>> rows = jdbc.sql("""
                select p.id, p.display_name, p.employee_no, coalesce(d.username, p.username) as account,
                       (select o.name from affiliation a join organization o on o.id = a.organization_id
                         where a.person_id = p.id and a.valid_to is null order by a.valid_from desc limit 1) as unit_name,
                       d.unit_name as directory_unit
                from person p
                left join person_directory_profile d on d.person_id = p.id
                where p.status = 'ACTIVE' and not p.access_disabled and not p.bootstrap and p.employee_no not like 'PLATFORM-%'
                  and (lower(p.username) = :l or lower(d.username) = :l)
                  and exists (select 1 from identity_link il where il.person_id = p.id
                              and il.method in ('DIRECTORY', 'LOCAL_USER', 'ENTERPRISE_KEY'))""")
                .param("l", login).query().listOfRows();
        List<Object> distinct = rows.stream().map(m -> m.get("id")).distinct().toList();
        if (distinct.isEmpty()) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, "لا يوجد في تمركز حساب دليل مؤسسي بهذا الاسم تحقق منه الدليل بدخول سابق؛"
                    + " يدخل الشخص مرة واحدة بحسابه (يتحقق الدليل من كلمة مروره دون حساب خدمة)، أو استخدم الرقم الوظيفي من الموارد البشرية.");
        }
        if (distinct.size() > 1) {
            throw ApiException.validation("حساب الدليل يطابق أكثر من سجل في تمركز؛ يراجعه مدير الصلاحيات قبل المنح.");
        }
        Map<String, Object> p = rows.get(0);
        UUID person = (UUID) p.get("id");
        String unit = p.get("unit_name") != null ? (String) p.get("unit_name") : (String) p.get("directory_unit");
        Candidate c = candidate(DIRECTORY_ACCOUNT, login, "DIRECTORY_SIGN_IN", person, "PERSON:" + person, (String) p.get("display_name"),
                (String) p.get("employee_no"), (String) p.get("account"), unit, null);
        return new Resolved(c, person, null);
    }

    private Candidate candidate(String method, String value, String verifiedBy, UUID person, String key, String name, String number,
                                String account, String unit, String hrStatus) {
        boolean already = person != null && jdbc.sql("select count(*) from membership m where m.person_id = :p and " + CURRENT)
                .param("p", person).query(Integer.class).single() > 0;
        String fingerprint = sha256(String.join("\n", method, value, verifiedBy, key, String.valueOf(name), String.valueOf(number),
                String.valueOf(account)));
        return new Candidate(method, value, verifiedBy, person == null ? null : person.toString(), name, number, account, unit, hrStatus,
                already, fingerprint);
    }

    @Transactional
    public AdminView add(AccessContext ctx, AddInput in) {
        requireGlobal(ctx);
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation("اذكر سبب منح صلاحية مدير النظام.");
        }
        lock();
        Resolved r = resolved(ctx, in.method(), in.value());
        if (in.confirmation() == null || !in.confirmation().equals(r.candidate().confirmation())) {
            throw new ApiException(ErrorCode.STALE_REVISION, "لم تُؤكد هذه الهوية كما عُرضت أو تغيرت بياناتها منذ العرض؛ اعرضها وأكدها من جديد.");
        }
        if (r.candidate().alreadyAdmin()) {
            throw ApiException.validation("هذا الشخص مدير نظام بالفعل.");
        }
        UUID person = r.person() != null ? r.person() : hrPeople.importOne(r.hr(), ctx.actor(), "ADMINISTRATOR", null);
        UUID anchor = anchor();
        Map<String, Object> made = grants.create(ctx, new GrantAdminService.GrantInput(person.toString(), anchor.toString(), ROLE,
                "مدير نظام", null, null, null, null));
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("method", r.candidate().method());
        detail.put("verifiedBy", r.candidate().verifiedBy());
        detail.put("key", r.candidate().value());
        detail.put("membershipId", made.get("id"));
        detail.put("importedFromHr", r.person() == null);
        audit.recordAs(ctx.actor(), "ADMIN_GRANTED", "PERSON", person.toString(), r.candidate().displayName(), detail, reason);
        return list(ctx).stream().filter(a -> a.personId().equals(person.toString())).findFirst()
                .orElseThrow(() -> new IllegalStateException("administrator just granted is not listed"));
    }

    @Transactional
    public void end(AccessContext ctx, UUID person, EndInput in) {
        requireGlobal(ctx);
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation("اذكر سبب سحب صلاحية مدير النظام.");
        }
        if (keys.same(ctx.personId(), person)) {
            throw ApiException.forbidden("لا يمكنك سحب صلاحيتك أنت؛ يسحبها مدير نظام آخر.");
        }
        boolean platform = jdbc.sql("select count(*) from person where id = :p and employee_no like 'PLATFORM-%'").param("p", person)
                .query(Integer.class).single() > 0;
        if (platform) {
            throw ApiException.forbidden("هذا حساب منصة دائم؛ صلاحياته من إعدادات التثبيت لا من هنا.");
        }
        lock();
        List<UUID> ids = jdbc.sql("select m.id from membership m where m.person_id = :p and " + CURRENT).param("p", person)
                .query(UUID.class).list();
        if (ids.isEmpty()) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, "هذا الشخص ليس مدير نظام حالياً.");
        }
        long others = jdbc.sql("""
                select count(distinct m.person_id) from membership m
                join person p on p.id = m.person_id and p.status = 'ACTIVE' and not p.access_disabled
                join organization o on o.id = m.organization_id and o.status = 'ACTIVE'
                where m.person_id <> :p and """ + CURRENT).param("p", person).query(Long.class).single();
        if (others < 1) {
            throw ApiException.validation("لا يمكن سحب صلاحية آخر مدير نظام فعّال؛ يُضاف مدير آخر أولاً.");
        }
        for (UUID id : ids) {
            grants.end(ctx, id, null, reason);
        }
        String name = jdbc.sql("select display_name from person where id = :id").param("id", person).query(String.class).optional().orElse(null);
        audit.recordAs(ctx.actor(), "ADMIN_REVOKED", "PERSON", person.toString(), name,
                Map.of("membershipIds", ids.stream().map(UUID::toString).toList()), reason);
    }

    /** Where the grant is held: a LOCAL root first — an HR unit may be retired by a sync, and a grant on a retired unit counts for nothing. */
    private UUID anchor() {
        return jdbc.sql("""
                select id from organization where status = 'ACTIVE'
                order by (source = 'LOCAL') desc, (parent_id is null) desc, created_at limit 1""")
                .query(UUID.class).optional().orElseThrow(() -> ApiException.validation("لا توجد وحدة نشطة يُربط بها المنح."));
    }

    private void lock() {
        jdbc.sql("select pg_advisory_xact_lock(:k)").param("k", LOCK_KEY).query().listOfRows();
    }

    private static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

}
