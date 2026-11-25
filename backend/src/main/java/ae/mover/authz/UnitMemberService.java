package ae.mover.authz;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.dao.DuplicateKeyException;
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
import ae.mover.hr.HrPeopleService;
import ae.mover.security.OidcProperties;

/**
 * «إضافة مستخدم» to a unit, as in TNQL's access workspace (owner, 11 Nov 2026; ADR-049). The access manager of a unit finds
 * a person by employee number or User ID, sees the HR card and adds them to the unit's matrix; or, without HR, adds a User ID
 * that the directory will authenticate. Either way the person enters the unit with no role: the row is empty and permissions
 * are ticked afterwards through the existing grant rules. Nothing here grants a right. Since ADR-065 (owner, 16 Nov 2026, as
 * MOVER) a person not yet in TMRKZ is looked up live in HR and, on saving, that one person is imported ({@link HrPeopleService}).
 *
 * <p>Bounds: the HR search only finds people already inside the manager's directory (a person outside it, unknown or inactive
 * gets the same answer, so the search cannot be used to discover who exists); a User ID already held by an account outside
 * the manager's reach, by a platform account or by the temporary first administrator is refused, so no one is taken over.
 */
@Service
public class UnitMemberService {

    /** A directory login: letters, digits, dot, underscore and hyphen; the domain part, if typed, is dropped. */
    private static final Pattern LOGIN = Pattern.compile("^[a-z0-9][a-z0-9._-]{1,63}$");
    static final String LOCAL_USER_PREFIX = "USER-";
    private static final String NOT_FOUND = "لم يُعثر على موظف بهذا الرقم ضمن نطاقك الإداري.";

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AuditService audit;
    private final DirectoryScope directory;
    private final OidcProperties oidc;
    private final ae.mover.access.AccessRights rights;
    private final HrPeopleService hrPeople;

    public UnitMemberService(JdbcClient jdbc, Clock clock, AuditService audit, DirectoryScope directory, OidcProperties oidc,
                             ae.mover.access.AccessRights rights, HrPeopleService hrPeople) {
        this.rights = rights;
        this.hrPeople = hrPeople;
        this.jdbc = jdbc;
        this.clock = clock;
        this.audit = audit;
        this.directory = directory;
        this.oidc = oidc;
    }

    /** The login as stored: trimmed, lower case, without a DOMAIN\ prefix or an @domain suffix; null when not a valid login. */
    public static String normalLogin(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim().toLowerCase(Locale.ROOT);
        int slash = s.lastIndexOf('\\');
        if (slash >= 0) {
            s = s.substring(slash + 1);
        }
        int at = s.indexOf('@');
        if (at > 0) {
            s = s.substring(0, at);
        }
        return LOGIN.matcher(s).matches() ? s : null;
    }

    private void requireUnit(AccessContext ctx, UUID orgId) {
        ctx.require(Permission.MANAGE_ACCESS);
        boolean active = jdbc.sql("select count(*) from organization where id = :o and status = 'ACTIVE'").param("o", orgId)
                .query(Integer.class).single() > 0;
        if (!active || !ctx.canFor(Permission.MANAGE_ACCESS, orgId)) {
            throw ApiException.notFound();
        }
    }

    /**
     * The HR card of one person found by exact employee number or User ID (domain account), for the unit being managed. Only a
     * member of the manager's directory is returned; anyone else is the same «not found». A person not yet in TMRKZ is looked up
     * live in HR (ADR-065, as MOVER): read-only, nothing is saved, shown only when their HR unit is inside the manager's reach;
     * the card then has no {@code personId} and {@code importOnSave}, and saving imports that one person.
     */
    public Map<String, Object> lookup(AccessContext ctx, UUID orgId, String key) {
        requireUnit(ctx, orgId);
        rights.require(ctx, ae.mover.access.AccessRights.Right.LOOKUP, orgId);
        String k = key == null ? "" : key.trim();
        if (k.length() < 2) {
            throw ApiException.validation("اكتب الرقم العسكري أو رقم المستخدم.");
        }
        String login = normalLogin(k);
        List<UUID> found = jdbc.sql("""
                select distinct p.id from person p
                left join hr_person h on h.external_id = p.source_external_id
                  and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')
                where p.source = 'HR' and p.status = 'ACTIVE'
                  and (lower(p.employee_no) = lower(:k) or lower(h.legacy_employee_number) = lower(:k)
                       or (cast(:l as text) is not null and (lower(p.username) = :l or lower(h.domain_account) = :l)))
                limit 2""")
                .param("k", k).param("l", login).query(UUID.class).list();
        if (found.isEmpty()) {
            return liveCard(ctx, orgId, k, login);
        }
        if (found.size() != 1 || !directory.members(ctx, found).contains(found.get(0))) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, NOT_FOUND);
        }
        return card(found.get(0), orgId);
    }

    /** The one active HR record with this key, live, inside the manager's reach; otherwise the same «not found». Writes nothing. */
    private HrPeopleService.HrRecord liveRecord(AccessContext ctx, String number, String login) {
        if (!hrPeople.configured()) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, NOT_FOUND);
        }
        List<HrPeopleService.HrRecord> active = hrPeople.find(number, login).stream().filter(HrPeopleService.HrRecord::active).toList();
        if (active.size() != 1) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, NOT_FOUND);
        }
        HrPeopleService.HrRecord r = active.get(0);
        // the manager's directory, as for anyone in TMRKZ: people posted in a unit of their reach (a global manager: anyone)
        DirectoryScope.Reach reach = directory.reach(ctx);
        UUID hrUnit = hrUnit(r);
        if (!reach.global() && (hrUnit == null || !reach.orgs().contains(hrUnit))) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, NOT_FOUND);
        }
        return r;
    }

    private UUID hrUnit(HrPeopleService.HrRecord r) {
        return r.unitExternalId() == null ? null : jdbc.sql("select id from organization where source = 'HR' and source_external_id = :x")
                .param("x", r.unitExternalId()).query(UUID.class).optional().orElse(null);
    }

    private Map<String, Object> liveCard(AccessContext ctx, UUID orgId, String key, String login) {
        HrPeopleService.HrRecord r = liveRecord(ctx, key, login);
        UUID hrUnit = hrUnit(r);
        String unitName = hrUnit == null ? null : jdbc.sql("select name from organization where id = :o").param("o", hrUnit)
                .query(String.class).single();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("personId", null);
        m.put("employeeNo", r.employeeNumber());
        m.put("displayName", r.fullName());
        m.put("userId", r.domainAccount());
        m.put("positionTitle", r.positionTitle());
        m.put("jobTitle", r.jobTitle());
        m.put("hrStatus", r.statusText());
        m.put("unitName", unitName);
        m.put("inUnit", false);
        m.put("acting", unitName != null && !orgId.equals(hrUnit));
        m.put("importOnSave", true);
        return m;
    }

    private Map<String, Object> card(UUID person, UUID orgId) {
        Map<String, Object> p = jdbc.sql("""
                select p.id, p.employee_no, p.display_name, p.username, p.status,
                       h.domain_account, h.position_title, h.job_title, h.status_text,
                       (select o.name from affiliation a join organization o on o.id = a.organization_id
                         where a.person_id = p.id and a.valid_to is null order by a.valid_from desc limit 1) as unit_name,
                       exists (select 1 from affiliation a where a.person_id = p.id and a.valid_to is null and a.organization_id = :o) as posted_here,
                       exists (select 1 from unit_member u where u.person_id = p.id and u.organization_id = :o and u.ended_at is null)
                         or exists (select 1 from membership m where m.person_id = p.id and m.organization_id = :o
                                      and (m.valid_to is null or m.valid_to > now())) as user_here
                from person p
                left join hr_person h on h.external_id = p.source_external_id
                  and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')
                where p.id = :p""")
                .param("p", person).param("o", orgId).query().singleRow();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("personId", person.toString());
        m.put("employeeNo", p.get("employee_no"));
        m.put("displayName", p.get("display_name"));
        m.put("userId", p.get("domain_account") != null ? p.get("domain_account") : p.get("username"));
        m.put("positionTitle", p.get("position_title"));
        m.put("jobTitle", p.get("job_title"));
        m.put("hrStatus", p.get("status_text"));
        m.put("unitName", p.get("unit_name"));
        // «مستخدم الوحدة» (owner, 16 Nov 2026): added or granted there — an HR posting alone is not; acting = posted elsewhere
        boolean here = Boolean.TRUE.equals(p.get("user_here"));
        m.put("inUnit", here);
        m.put("acting", !here && !Boolean.TRUE.equals(p.get("posted_here")) && p.get("unit_name") != null);
        return m;
    }

    /** {@code employeeNo}: an HR person not yet in TMRKZ, from a card with {@code importOnSave} (ADR-065). */
    public record AddInput(UUID organizationId, String personId, String userId, String displayName, String employeeNo) {
    }

    /**
     * Adds a person to the unit with no role: an HR person by id (from {@link #lookup}), or a User ID without HR. Since 16 Nov 2026
     * (owner, as TNQL) this is how a person becomes one of the unit's users, together with an approved access request: an HR posting
     * alone lists no one. A person already a user of the unit (added, or holding a grant made there) is answered with their id so
     * the matrix can show them; nothing is duplicated. Acting means posted by HR in another unit.
     */
    @Transactional
    public Map<String, Object> add(AccessContext ctx, AddInput in) {
        if (in == null || in.organizationId() == null) {
            throw ApiException.validation("اختر الوحدة.");
        }
        UUID orgId = in.organizationId();
        requireUnit(ctx, orgId);
        rights.require(ctx, ae.mover.access.AccessRights.Right.ANNEXED, orgId);
        Instant now = clock.instant();
        UUID person;
        boolean created = false;
        boolean fromHr = in.personId() != null && !in.personId().isBlank() || in.employeeNo() != null && !in.employeeNo().isBlank();
        if (in.personId() != null && !in.personId().isBlank()) {
            person = UUID.fromString(in.personId());
            boolean hrActive = jdbc.sql("select count(*) from person where id = :p and source = 'HR' and status = 'ACTIVE'")
                    .param("p", person).query(Integer.class).single() > 0;
            if (!hrActive || !directory.members(ctx, Set.of(person)).contains(person)) {
                throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, NOT_FOUND);
            }
        } else if (fromHr) {
            // ADR-065: that one person, re-read live now, is imported with no permission (or refreshed, if already in TMRKZ)
            HrPeopleService.HrRecord r = liveRecord(ctx, in.employeeNo().trim(), null);
            UUID known = hrPeople.existing(r.externalId());
            boolean current = known != null && jdbc.sql("select count(*) from person where id = :p and status = 'ACTIVE'")
                    .param("p", known).query(Integer.class).single() > 0 && directory.members(ctx, Set.of(known)).contains(known);
            person = current ? known : hrPeople.importOne(r, ctx.actor(), "UNIT_MEMBER", orgId);
        } else {
            String login = normalLogin(in.userId());
            if (login == null) {
                throw ApiException.validation("رقم المستخدم غير صالح: أحرف لاتينية وأرقام فقط، مثل u1234567.");
            }
            if (oidc.platformAccount(login)) {
                throw ApiException.validation("هذا الاسم محجوز لحساب منصة دائم.");
            }
            int inHr = jdbc.sql("""
                    select count(*) from person p
                    left join hr_person h on h.external_id = p.source_external_id
                    where p.source = 'HR' and (lower(p.username) = :l or lower(h.domain_account) = :l)""")
                    .param("l", login).query(Integer.class).single();
            // HR people are no longer all in TMRKZ (ADR-065): HR itself is asked, so an HR employee is never added as a local User ID
            if (inHr == 0 && hrPeople.configured() && !hrPeople.find(null, login).isEmpty()) {
                inHr = 1;
            }
            if (inHr > 0) {
                throw ApiException.validation("لهذا المستخدم سجل في الموارد البشرية؛ ابحث عنه بالرقم العسكري أو رقم المستخدم.");
            }
            Map<String, Object> existing = jdbc.sql("""
                    select p.id, p.employee_no, p.bootstrap, p.status, p.source,
                           exists (select 1 from identity_link il where il.person_id = p.id and il.method = 'DIRECTORY') as directory_made
                    from person p where lower(p.username) = :l or lower(p.employee_no) = lower(:e)""")
                    .param("l", login).param("e", LOCAL_USER_PREFIX + login).query().listOfRows().stream().findFirst().orElse(null);
            if (existing != null) {
                person = (UUID) existing.get("id");
                requireAddableAccount(ctx, person, existing);
            } else {
                person = UUID.randomUUID();
                String name = in.displayName() == null || in.displayName().isBlank() ? login : in.displayName().trim();
                if (name.length() > 200) {
                    throw ApiException.validation("الاسم أطول من المسموح.");
                }
                jdbc.sql("""
                        insert into person(id, employee_no, display_name, username, status, source)
                        values (:id, :e, :n, :l, 'ACTIVE', 'LOCAL')""")
                        .param("id", person).param("e", LOCAL_USER_PREFIX + login).param("n", name).param("l", login).update();
                created = true;
                audit.recordAs(ctx.actor(), "LOCAL_USER_CREATED", "PERSON", person.toString(), name,
                        Map.of("login", login, "organizationId", orgId.toString()), null);
            }
        }
        boolean posted = jdbc.sql("select count(*) from affiliation where person_id = :p and organization_id = :o and valid_to is null")
                .param("p", person).param("o", orgId).query(Integer.class).single() > 0;
        boolean user = jdbc.sql("""
                select count(*) from (select person_id from unit_member where person_id = :p and organization_id = :o and ended_at is null
                  union all select person_id from membership where person_id = :p and organization_id = :o and (valid_to is null or valid_to > now())) u""")
                .param("p", person).param("o", orgId).query(Integer.class).single() > 0;
        if (user) {
            return Map.of("personId", person.toString(), "created", false, "already", true);
        }
        boolean acting = !posted && jdbc.sql("select count(*) from affiliation where person_id = :p and valid_to is null")
                .param("p", person).query(Integer.class).single() > 0;
        try {
            jdbc.sql("""
                    insert into unit_member(id, person_id, organization_id, acting, added_by, added_at)
                    values (:id, :p, :o, :a, :by, :now)""")
                    .param("id", UUID.randomUUID()).param("p", person).param("o", orgId).param("a", acting)
                    .param("by", ctx.personId()).param("now", Db.ts(now)).update();
        } catch (DuplicateKeyException e) {
            return Map.of("personId", person.toString(), "created", false, "already", true);
        }
        audit.recordAs(ctx.actor(), "UNIT_MEMBER_ADDED", "PERSON", person.toString(), null,
                Map.of("organizationId", orgId.toString(), "acting", acting, "withoutHr", !fromHr), null);
        return Map.of("personId", person.toString(), "created", created, "already", false);
    }

    /**
     * An existing account typed as a User ID (ADR-103). Two kinds of LOCAL account are user accounts: one made here
     * («USER-login») and one made by the person's own first directory sign-in (ADR-068: linked DIRECTORY, carrying the
     * directory's employee number or «DIR-login»). Before ADR-103 only the first kind was accepted, so even the global
     * administrator was told that a person who had signed in was «outside your scope». Each refusal now names its real
     * cause; the scope bound itself is unchanged — a manager adds only someone already inside their reach.
     */
    private void requireAddableAccount(AccessContext ctx, UUID person, Map<String, Object> p) {
        String no = String.valueOf(p.get("employee_no"));
        if (Boolean.TRUE.equals(p.get("bootstrap")) || no.startsWith("PLATFORM-")) {
            throw ApiException.validation("رقم المستخدم هذا لحساب نظام (حساب منصة أو هوية التهيئة الأولى)؛ لا يُضاف مستخدماً لوحدة.");
        }
        boolean userAccount = "LOCAL".equals(p.get("source"))
                && (no.startsWith(LOCAL_USER_PREFIX) || Boolean.TRUE.equals(p.get("directory_made")));
        if (!userAccount) {
            throw ApiException.validation("رقم المستخدم هذا مسجل لسجل آخر في تمركز لا يُضاف بهذه الطريقة؛ يراجعه مدير الصلاحيات العام.");
        }
        if (!"ACTIVE".equals(p.get("status"))) {
            throw ApiException.validation("حساب رقم المستخدم هذا موقوف في تمركز (أُنهي من بطاقة الحساب)؛ يعيده مدير الصلاحيات العام"
                    + " من بطاقة الحساب قبل إضافته.");
        }
        // an account another manager created stays theirs unless it is already inside this manager's reach
        if (!directory.covers(ctx, person)) {
            throw ApiException.validation("رقم المستخدم هذا مستخدم لحساب خارج نطاقك؛ يضيفه مدير صلاحيات يشمل نطاقه صاحبه.");
        }
    }

    public record EndInput(UUID organizationId, String reason) {
    }

    /** Removes an added person from the unit's matrix. Their grants stay until ended one by one. */
    @Transactional
    public void end(AccessContext ctx, UUID person, EndInput in) {
        if (in == null || in.organizationId() == null) {
            throw ApiException.validation("اختر الوحدة.");
        }
        requireUnit(ctx, in.organizationId());
        rights.require(ctx, ae.mover.access.AccessRights.Right.ANNEXED, in.organizationId());
        String reason = in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation("اذكر سبب الإزالة.");
        }
        int n = jdbc.sql("""
                update unit_member set ended_at = :now, ended_by = :by, ended_reason = :r
                where person_id = :p and organization_id = :o and ended_at is null""")
                .param("now", Db.ts(clock.instant())).param("by", ctx.personId()).param("r", reason)
                .param("p", person).param("o", in.organizationId()).update();
        if (n == 0) {
            throw ApiException.notFound();
        }
        audit.recordAs(ctx.actor(), "UNIT_MEMBER_ENDED", "PERSON", person.toString(), null,
                Map.of("organizationId", in.organizationId().toString()), reason);
    }
}
