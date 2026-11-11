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
import ae.mover.security.OidcProperties;

/**
 * «إضافة مستخدم» to a unit, as in TNQL's access workspace (owner, 11 Nov 2026; ADR-049). The access manager of a unit finds
 * a person in the HR mirror by employee number or User ID, sees the HR card and adds them to the unit's matrix; or, without
 * HR, adds a User ID that the directory will authenticate. Either way the person enters the unit with no role: the row is
 * empty and permissions are ticked afterwards through the existing grant rules. Nothing here grants a right.
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

    public UnitMemberService(JdbcClient jdbc, Clock clock, AuditService audit, DirectoryScope directory, OidcProperties oidc,
                             ae.mover.access.AccessRights rights) {
        this.rights = rights;
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
     * member of the manager's directory is returned; anyone else is the same «not found».
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
                  and (lower(p.employee_no) = lower(:k) or (cast(:l as text) is not null and (lower(p.username) = :l or lower(h.domain_account) = :l)))
                limit 2""")
                .param("k", k).param("l", login).query(UUID.class).list();
        if (found.size() != 1 || !directory.members(ctx, found).contains(found.get(0))) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, NOT_FOUND);
        }
        return card(found.get(0), orgId);
    }

    private Map<String, Object> card(UUID person, UUID orgId) {
        Map<String, Object> p = jdbc.sql("""
                select p.id, p.employee_no, p.display_name, p.username, p.status,
                       h.domain_account, h.position_title, h.job_title, h.status_text,
                       (select o.name from affiliation a join organization o on o.id = a.organization_id
                         where a.person_id = p.id and a.valid_to is null order by a.valid_from desc limit 1) as unit_name,
                       exists (select 1 from affiliation a where a.person_id = p.id and a.valid_to is null and a.organization_id = :o) as posted_here,
                       exists (select 1 from unit_member u where u.person_id = p.id and u.organization_id = :o and u.ended_at is null) as added_here
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
        boolean here = Boolean.TRUE.equals(p.get("posted_here")) || Boolean.TRUE.equals(p.get("added_here"));
        m.put("inUnit", here);
        m.put("acting", !here && !Boolean.TRUE.equals(p.get("posted_here")) && p.get("unit_name") != null);
        return m;
    }

    public record AddInput(UUID organizationId, String personId, String userId, String displayName) {
    }

    /**
     * Adds a person to the unit with no role: an HR person by id (from {@link #lookup}), or a User ID without HR. A person already
     * posted to or added to the unit is answered with their id so the matrix can show them; nothing is duplicated.
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
        if (in.personId() != null && !in.personId().isBlank()) {
            person = UUID.fromString(in.personId());
            boolean hrActive = jdbc.sql("select count(*) from person where id = :p and source = 'HR' and status = 'ACTIVE'")
                    .param("p", person).query(Integer.class).single() > 0;
            if (!hrActive || !directory.members(ctx, Set.of(person)).contains(person)) {
                throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, NOT_FOUND);
            }
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
            if (inHr > 0) {
                throw ApiException.validation("لهذا المستخدم سجل في الموارد البشرية؛ ابحث عنه بالرقم العسكري أو رقم المستخدم.");
            }
            Map<String, Object> existing = jdbc.sql("""
                    select id, employee_no, bootstrap, status from person where lower(username) = :l or lower(employee_no) = lower(:e)""")
                    .param("l", login).param("e", LOCAL_USER_PREFIX + login).query().listOfRows().stream().findFirst().orElse(null);
            if (existing != null) {
                person = (UUID) existing.get("id");
                boolean ours = String.valueOf(existing.get("employee_no")).startsWith(LOCAL_USER_PREFIX)
                        && !Boolean.TRUE.equals(existing.get("bootstrap"));
                // an account another manager created stays theirs unless it is already inside this manager's reach
                if (!ours || !"ACTIVE".equals(existing.get("status")) || !directory.covers(ctx, person)) {
                    throw ApiException.validation("رقم المستخدم هذا مستخدم لحساب خارج نطاقك؛ يضيفه مدير صلاحيات يشمل نطاقه صاحبه.");
                }
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
        boolean added = jdbc.sql("select count(*) from unit_member where person_id = :p and organization_id = :o and ended_at is null")
                .param("p", person).param("o", orgId).query(Integer.class).single() > 0;
        if (posted || added) {
            return Map.of("personId", person.toString(), "created", false, "already", true);
        }
        boolean acting = jdbc.sql("select count(*) from affiliation where person_id = :p and valid_to is null")
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
                Map.of("organizationId", orgId.toString(), "acting", acting, "withoutHr", in.personId() == null || in.personId().isBlank()), null);
        return Map.of("personId", person.toString(), "created", created, "already", false);
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
