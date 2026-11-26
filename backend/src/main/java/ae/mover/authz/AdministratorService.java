package ae.mover.authz;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

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
import ae.mover.security.DirectoryAuthenticator;
import ae.mover.security.IdentityService;
import ae.mover.security.LoginThrottle;
import ae.mover.security.OidcClient;
import ae.mover.security.OidcProperties;

/**
 * «مديرو النظام» (ADR-103, replacing the ADR-102 lifecycle whose add failed on every call). A system administrator is found by
 * one of the two verified identity lookups, shown, and only then granted:
 *
 * <ul>
 *   <li>{@code EMPLOYEE_NUMBER}: Oracle HR asked live (read-only, {@link HrPeopleService#find}); an active, unambiguous record only.
 *       A person not yet in TMRKZ is imported from that record on confirmation (never fabricated);</li>
 *   <li>{@code DIRECTORY_ACCOUNT}: an account the enterprise directory itself verified by a previous sign-in (an identity link,
 *       ADR-068/ADR-100); or, before any sign-in (ADR-105), the directory's own entry found live — with its read-only service
 *       account when the installation has one, otherwise with the administrator's own directory account (their password typed
 *       for that one search, never stored). A directory that allows neither is explained, never bypassed. The person is then
 *       created on confirmation exactly as their own first sign-in would create them ({@link IdentityService#resolve}).</li>
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
    public static final String DEVELOPER_ROLE = "DEVELOPER";
    public static final String EMPLOYEE_NUMBER = "EMPLOYEE_NUMBER";
    public static final String DIRECTORY_ACCOUNT = "DIRECTORY_ACCOUNT";
    private static final long LOCK_KEY = 0x544d524b5a41L; // "TMRKZA"

    public record AdminView(String personId, String displayName, String username, String employeeNumber, String grantedAt,
                            String grantedBy, boolean platform, boolean effective, String role) {
    }

    public record ResolveInput(String method, String value, String directoryPassword) {

        public ResolveInput(String method, String value) {
            this(method, value, null);
        }

        @Override
        public String toString() {
            return "ResolveInput[" + method + " " + value + "]"; // never the password
        }
    }

    /**
     * {@code roles}: one or both of SYSTEM_ADMIN and DEVELOPER (falls back to {@code role}, else SYSTEM_ADMIN). Granting DEVELOPER
     * (a full superuser) needs the actor to be a developer.
     */
    public record AddInput(String method, String value, String confirmation, String reason, String role, List<String> roles) {

        public AddInput(String method, String value, String confirmation, String reason) {
            this(method, value, confirmation, reason, null, null);
        }

        public AddInput(String method, String value, String confirmation, String reason, String role) {
            this(method, value, confirmation, reason, role, null);
        }
    }

    public record EndInput(String reason) {
    }

    /** The identity shown for confirmation. {@code personId} is null for an HR employee not yet in TMRKZ (imported on confirm). */
    public record Candidate(String method, String value, String verifiedBy, String personId, String displayName, String employeeNumber,
                            String account, String unitName, String hrStatus, boolean alreadyAdmin, String confirmation) {
    }

    private record Resolved(Candidate candidate, UUID person, HrPeopleService.HrRecord hr, DirectoryAuthenticator.DirectoryUser entry) {

        Resolved(Candidate candidate, UUID person, HrPeopleService.HrRecord hr) {
            this(candidate, person, hr, null);
        }
    }

    /** A directory entry found live for one administrator, kept for their confirmation (never the password that found it). */
    private record Pending(UUID actor, DirectoryAuthenticator.DirectoryUser entry, String verifiedBy, java.time.Instant until) {
    }

    /** What the screen offers (ADR-105): which lookups this installation can make, and why not when it cannot. */
    public record LookupOptions(boolean employeeNumber, String employeeNumberMessage, String directoryMode, boolean directoryNeedsPassword,
                                String directoryMessage) {
    }

    private final JdbcClient jdbc;
    private final AuditService audit;
    private final HrPeopleService hrPeople;
    private final GrantAdminService grants;
    private final PersonKeys keys;
    private final OidcProperties oidc;
    private final DirectoryAuthenticator directory;
    private final IdentityService identities;
    private final java.time.Clock clock;
    private final LoginThrottle throttle;
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();

    public AdministratorService(JdbcClient jdbc, AuditService audit, HrPeopleService hrPeople, GrantAdminService grants,
                                PersonKeys keys, OidcProperties oidc, DirectoryAuthenticator directory, IdentityService identities,
                                java.time.Clock clock, LoginThrottle throttle) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.hrPeople = hrPeople;
        this.grants = grants;
        this.keys = keys;
        this.oidc = oidc;
        this.directory = directory;
        this.identities = identities;
        this.clock = clock;
        this.throttle = throttle;
    }

    /** Which verified lookups this installation offers now, with the reason when one is not available. */
    public LookupOptions lookupOptions(AccessContext ctx) {
        requireGlobal(ctx);
        boolean hr = hrPeople.configured();
        DirectoryAuthenticator.LookupMode mode = directory.lookupMode();
        boolean ownLinked = ownDirectoryLink(ctx) != null;
        String message = switch (mode) {
            case SERVICE_ACCOUNT -> "يبحث في الدليل حساب الخدمة المهيأ (للقراءة فقط)، فيظهر الشخص ولو لم يدخل تمركز من قبل.";
            case OWN_ACCOUNT -> ownLinked
                    ? "لا يوجد حساب خدمة (ADR-100): يبحث تمركز في الدليل بحسابك أنت؛ اكتب كلمة مرورك في الدليل لهذا البحث وحده، ولا تُحفظ."
                    : "لا يوجد حساب خدمة، ودخولك الحالي ليس بحساب الدليل المؤسسي؛ لا يمكن البحث في الدليل عمن لم يدخل بعد."
                      + " يظهر من دخل تمركز مرة واحدة بحسابه، أو استخدم الرقم الوظيفي من الموارد البشرية.";
            case UNAVAILABLE -> "الدليل المؤسسي غير مهيأ في «إعدادات التكامل»؛ يظهر فقط من دخل تمركز من قبل بحساب تحقق منه الدليل.";
        };
        return new LookupOptions(hr, hr ? "يسأل مصدر الموارد البشرية (Oracle) مباشرة، للقراءة فقط."
                : "مصدر الموارد البشرية (Oracle) غير مهيأ أو غير مفعل.", mode.name(), mode == DirectoryAuthenticator.LookupMode.OWN_ACCOUNT && ownLinked,
                message);
    }

    /** The administrator's own directory identity link: [stable identifier, login], or null when they did not sign in with it. */
    private String[] ownDirectoryLink(AccessContext ctx) {
        String issuer;
        try {
            issuer = directory.issuer();
        } catch (RuntimeException e) {
            return null;
        }
        if (issuer == null) {
            return null;
        }
        String subject = jdbc.sql("select subject from identity_link where person_id = :p and issuer = :i")
                .param("p", ctx.personId()).param("i", issuer).query(String.class).optional().orElse(null);
        if (subject == null) {
            return null;
        }
        String login = jdbc.sql("""
                select coalesce(d.username, p.username) from person p
                left join person_directory_profile d on d.person_id = p.id and d.issuer = :i
                where p.id = :p""").param("p", ctx.personId()).param("i", issuer).query(String.class).optional().orElse(null);
        return login == null ? null : new String[]{subject, login};
    }

    /** Handing out or taking back the system administrator role: configuration and access management over everything. */
    private static void requireGlobal(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("يمنح صلاحية مدير النظام ويسحبها مدير صلاحيات عام فقط.");
        }
    }

    /** The roles to grant: a de-duplicated subset of {SYSTEM_ADMIN, DEVELOPER} (from {@code roles}, else {@code role}, else SYSTEM_ADMIN). */
    private static List<String> rolesOf(AddInput in) {
        List<String> raw = in != null && in.roles() != null && !in.roles().isEmpty()
                ? in.roles()
                : List.of(in == null || in.role() == null || in.role().isBlank() ? ROLE : in.role().trim());
        java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>();
        for (String r : raw) {
            String t = r == null ? "" : r.trim();
            if (!ROLE.equals(t) && !DEVELOPER_ROLE.equals(t)) {
                throw ApiException.validation("دور غير معروف: اختر مدير النظام أو مطوّر النظام.");
            }
            set.add(t);
        }
        if (set.isEmpty()) {
            set.add(ROLE);
        }
        return List.copyOf(set);
    }

    /** A developer holds every permission in every unit; only such an actor may grant the developer role (no self-escalation from admin). */
    private static boolean isDeveloper(AccessContext ctx) {
        for (Permission p : Permission.values()) {
            if (!ctx.canEverywhere(p)) {
                return false;
            }
        }
        return true;
    }

    /** The person already holds {@code role} by a current grant. */
    private boolean holdsRole(UUID person, String role) {
        return jdbc.sql("select count(*) from membership where person_id = :p and role_code = :r"
                + " and valid_from <= clock_timestamp() and (valid_to is null or valid_to > clock_timestamp())")
                .param("p", person).param("r", role).query(Integer.class).single() > 0;
    }

    /** A current system administrator grant of membership {@code m} (leading space: text blocks drop the trailing one before it). */
    private static final String CURRENT = " m.role_code = 'SYSTEM_ADMIN' and m.valid_from <= clock_timestamp() and (m.valid_to is null or m.valid_to > clock_timestamp())";
    /** A current administrator-type grant — system administrator or developer: both are listed and ended through this facility (ADR-108). */
    private static final String CURRENT_ADMIN = " m.role_code in ('SYSTEM_ADMIN', 'DEVELOPER') and m.valid_from <= clock_timestamp() and (m.valid_to is null or m.valid_to > clock_timestamp())";

    public List<AdminView> list(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Map<String, AdminView> out = new LinkedHashMap<>();
        jdbc.sql("""
                select m.person_id, p.display_name, p.username, p.employee_no, m.valid_from, m.role_code, g.display_name as granted_by,
                       p.employee_no like 'PLATFORM-%' as platform,
                       o.status = 'ACTIVE' and not p.access_disabled as effective
                from membership m
                join person p on p.id = m.person_id and p.status = 'ACTIVE'
                join organization o on o.id = m.organization_id
                left join person g on g.id = m.granted_by
                where """ + CURRENT_ADMIN + " order by m.valid_from")
                .query((rs, n) -> {
                    String id = rs.getString("person_id");
                    AdminView prior = out.get(id);
                    boolean effective = rs.getBoolean("effective") || prior != null && prior.effective();
                    // a person holding both roles is shown as the higher one (developer)
                    String role = DEVELOPER_ROLE.equals(rs.getString("role_code")) || (prior != null && DEVELOPER_ROLE.equals(prior.role()))
                            ? DEVELOPER_ROLE : ROLE;
                    out.put(id, new AdminView(id, rs.getString("display_name"), rs.getString("username"), rs.getString("employee_no"),
                            prior != null ? prior.grantedAt() : Db.toInstant(rs.getTimestamp("valid_from")).toString(),
                            prior != null ? prior.grantedBy() : rs.getString("granted_by"), rs.getBoolean("platform"), effective, role));
                    return null;
                }).list();
        return List.copyOf(out.values());
    }

    public Candidate resolve(AccessContext ctx, ResolveInput in) {
        requireGlobal(ctx);
        return resolved(ctx, in == null ? null : in.method(), in == null ? null : in.value(), in == null ? null : in.directoryPassword(),
                null).candidate();
    }

    private Resolved resolved(AccessContext ctx, String method, String raw, String directoryPassword, String confirmation) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty() || value.length() > 120) {
            throw ApiException.validation("اكتب الرقم الوظيفي أو حساب الدليل المؤسسي.");
        }
        Resolved r;
        if (EMPLOYEE_NUMBER.equals(method)) {
            r = byEmployeeNumber(value);
        } else if (DIRECTORY_ACCOUNT.equals(method)) {
            r = byDirectoryAccount(ctx, value, directoryPassword, confirmation);
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

    private Resolved byDirectoryAccount(AccessContext ctx, String raw, String directoryPassword, String confirmation) {
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
            return byDirectoryLookup(ctx, login, directoryPassword, confirmation);
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

    /**
     * ADR-105: an account nobody signed in with yet, found live in the directory. A record TMRKZ already holds for the login or the
     * number is never duplicated: it is refused for review (as a first sign-in would be). On confirmation the entry found for THIS
     * administrator is used again (kept for ten minutes), so the administrator's own password is never asked twice.
     */
    private Resolved byDirectoryLookup(AccessContext ctx, String login, String directoryPassword, String confirmation) {
        pending.values().removeIf(p -> p.until().isBefore(clock.instant()));
        if (confirmation != null) {
            Pending kept = pending.get(confirmation);
            if (kept != null && kept.actor().equals(ctx.personId()) && login.equalsIgnoreCase(kept.entry().username())) {
                return fromEntry(login, kept.entry(), kept.verifiedBy());
            }
        }
        DirectoryAuthenticator.LookupMode mode = directory.lookupMode();
        String notFoundHere = "لا يوجد في تمركز حساب دليل بهذا الاسم تحقق منه الدليل بدخول سابق.";
        if (mode == DirectoryAuthenticator.LookupMode.UNAVAILABLE) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, notFoundHere + " والبحث في الدليل قبل أول دخول غير متاح: الدليل المؤسسي غير مهيأ."
                    + " يدخل الشخص مرة واحدة بحسابه، أو استخدم الرقم الوظيفي من الموارد البشرية.", Map.of("lookup", "UNAVAILABLE"));
        }
        String[] own = null;
        if (mode == DirectoryAuthenticator.LookupMode.OWN_ACCOUNT) {
            own = ownDirectoryLink(ctx);
            if (own == null) {
                throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, notFoundHere + " ولا يوجد حساب خدمة للدليل (ADR-100)، ودخولك الحالي ليس"
                        + " بحساب الدليل، فلا يمكن البحث عمن لم يدخل بعد. يدخل الشخص مرة واحدة بحسابه، أو استخدم الرقم الوظيفي.",
                        Map.of("lookup", "UNAVAILABLE_NOT_DIRECTORY_SESSION"));
            }
            if (directoryPassword == null || directoryPassword.isEmpty()) {
                throw new ApiException(ErrorCode.VALIDATION_FAILED, "هذا الحساب لم يدخل تمركز بعد. للبحث عنه في الدليل دون حساب خدمة اكتب"
                        + " كلمة مرورك أنت في الدليل (تُستخدم لهذا البحث وحده ولا تُحفظ).", Map.of("lookup", "PASSWORD_REQUIRED"));
            }
        }
        DirectoryAuthenticator.DirectoryUser entry;
        if (own != null) {
            throttle.check("id:" + own[0], null); // the administrator's own password: as many tries as a step-up, no more
        }
        try {
            entry = own == null ? directory.lookup(login, null, null, null) : directory.lookup(login, own[1], own[0], directoryPassword);
            if (own != null) {
                throttle.succeeded("id:" + own[0]);
            }
        } catch (DirectoryAuthenticator.DirectoryException e) {
            if (own != null && e.failure() == DirectoryAuthenticator.Failure.INVALID_CREDENTIALS) {
                throttle.failed("id:" + own[0], null);
            }
            throw switch (e.failure()) {
                case INVALID_CREDENTIALS -> new ApiException(ErrorCode.REAUTHENTICATION_FAILED,
                        "رفض الدليل كلمة مرورك؛ لم يُبحث عن الحساب ولم يُمنح شيء.", Map.of("lookup", "PASSWORD_REFUSED"));
                case AMBIGUOUS -> ApiException.validation("الاسم يطابق أكثر من سجل في الدليل؛ لا يُختار أحدها آلياً.");
                case TLS -> new ApiException(ErrorCode.DIRECTORY_TLS_FAILED, "تعذر تأمين الاتصال بالدليل (الشهادة أو اسم الخادم)؛ لم يُرسل شيء.");
                case NOT_CONFIGURED -> new ApiException(ErrorCode.RESOURCE_NOT_FOUND, notFoundHere + " والدليل غير مهيأ للبحث.",
                        Map.of("lookup", "UNAVAILABLE"));
                case UNAVAILABLE -> new ApiException(ErrorCode.DIRECTORY_UNAVAILABLE, "تعذر الوصول إلى الدليل المؤسسي الآن؛ لم يُمنح شيء.");
            };
        }
        if (entry == null) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, "لم يجد الدليل المؤسسي حساباً بهذا الاسم.", Map.of("lookup", "NOT_IN_DIRECTORY"));
        }
        String verifiedBy = own == null ? "DIRECTORY_SERVICE_LOOKUP" : "DIRECTORY_OWN_ACCOUNT_LOOKUP";
        Resolved r = fromEntry(login, entry, verifiedBy);
        pending.put(r.candidate().confirmation(), new Pending(ctx.personId(), entry, verifiedBy, clock.instant().plusSeconds(600)));
        return r;
    }

    /** The candidate an entry found in the directory makes; a TMRKZ record that already holds the login or number is refused. */
    private Resolved fromEntry(String login, DirectoryAuthenticator.DirectoryUser entry, String verifiedBy) {
        String number = entry.employeeNumber();
        int held = jdbc.sql("""
                select count(*) from person where lower(username) = :l or (cast(:n as text) is not null and employee_no = cast(:n as text))""")
                .param("l", login).param("n", number).query(Integer.class).single();
        if (held > 0) {
            throw ApiException.validation("اسم الدخول أو الرقم الوظيفي لهذا الحساب مسجل لسجل آخر في تمركز؛ لا يُنشأ سجل ثانٍ."
                    + " يراجعه مدير الصلاحيات (بطاقة الحساب) قبل المنح.");
        }
        Candidate c = candidate(DIRECTORY_ACCOUNT, login, verifiedBy, null, "DIR:" + entry.uuid(), entry.displayName(), number,
                entry.username(), entry.profile() == null ? null : entry.profile().unitName(), null);
        return new Resolved(c, null, null, entry);
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
        List<String> roles = rolesOf(in);
        boolean dev = roles.contains(DEVELOPER_ROLE);
        if (dev && !isDeveloper(ctx)) {
            throw ApiException.forbidden("يمنح صلاحية مطوّر النظام مطوّرٌ فقط (من يملك كل الصلاحيات في كل الوحدات)؛ لا يمنحها مدير النظام.");
        }
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation(dev ? "اذكر سبب منح الصلاحية (مطوّر النظام)." : "اذكر سبب منح صلاحية مدير النظام.");
        }
        lock();
        Resolved r = resolved(ctx, in.method(), in.value(), null, in.confirmation());
        if (in.confirmation() == null || !in.confirmation().equals(r.candidate().confirmation())) {
            throw new ApiException(ErrorCode.STALE_REVISION, "لم تُؤكد هذه الهوية كما عُرضت أو تغيرت بياناتها منذ العرض؛ اعرضها وأكدها من جديد.");
        }
        UUID person = r.person() != null ? r.person() : r.entry() != null ? fromDirectory(r.entry()) : hrPeople.importOne(r.hr(), ctx.actor(),
                "ADMINISTRATOR", null);
        List<String> toGrant = roles.stream().filter(role -> !holdsRole(person, role)).toList();
        if (toGrant.isEmpty()) {
            throw ApiException.validation(roles.size() > 1 ? "هذا الشخص يملك هاتين الصلاحيتين بالفعل."
                    : dev ? "هذا الشخص مطوّر نظام بالفعل." : "هذا الشخص مدير نظام بالفعل.");
        }
        pending.remove(in.confirmation());
        UUID anchor = anchor();
        for (String role : toGrant) {
            boolean roleDev = DEVELOPER_ROLE.equals(role);
            Map<String, Object> made = grants.create(ctx, new GrantAdminService.GrantInput(person.toString(), anchor.toString(), role,
                    roleDev ? "مطوّر نظام" : "مدير نظام", null, null, null, null));
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("role", role);
            detail.put("method", r.candidate().method());
            detail.put("verifiedBy", r.candidate().verifiedBy());
            detail.put("key", r.candidate().value());
            detail.put("membershipId", made.get("id"));
            detail.put("importedFromHr", r.person() == null && r.hr() != null);
            detail.put("createdFromDirectory", r.entry() != null);
            audit.recordAs(ctx.actor(), roleDev ? "DEVELOPER_GRANTED" : "ADMIN_GRANTED", "PERSON", person.toString(),
                    r.candidate().displayName(), detail, reason);
        }
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
        List<UUID> ids = jdbc.sql("select m.id from membership m where m.person_id = :p and " + CURRENT_ADMIN).param("p", person)
                .query(UUID.class).list();
        if (ids.isEmpty()) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, "هذا الشخص ليس مدير نظام ولا مطوّر نظام حالياً.");
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

    /**
     * The person an entry found in the directory stands for, made exactly as their own first sign-in would make them (the unchanged
     * {@link IdentityService#resolve}: HR record when Oracle is in force, otherwise a LOCAL record linked with method DIRECTORY,
     * duplicates refused for review). Their later sign-in finds this link by the directory's stable identifier.
     */
    private UUID fromDirectory(DirectoryAuthenticator.DirectoryUser u) {
        OidcClient.Identity id = new OidcClient.Identity(directory.issuer(), u.uuid(),
                "EMPLOYEE_NUMBER".equals(oidc.linkKey()) ? u.employeeNumber() : u.username(), u.displayName(), u.username(), clock.instant(),
                null, "ADMIN_LOOKUP", "/", null, false, u.profile());
        return identities.resolve(id);
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
