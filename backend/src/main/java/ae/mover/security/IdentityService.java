package ae.mover.security;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.hr.HrAdminService;

/**
 * Links a provider identity (issuer, subject) to a TMRKZ person. The first sign-in links automatically only on the
 * stable enterprise key (the domain account, or the employee number from the directory) matching exactly one active
 * person from the HR source,
 * while the HR mirror is within its age policy. A missing key, no match, several matches, an inactive record, a stale
 * mirror or a person already linked to another identity puts the sign-in on the review list for an access manager.
 * Similar names never link. Holding a directory account grants no business right by itself.
 */
@Service
public class IdentityService {

    private final JdbcClient jdbc;
    private final Clock clock;
    private final HrAdminService hr;
    private final AuditService audit;
    private final OidcProperties props;

    public IdentityService(JdbcClient jdbc, Clock clock, HrAdminService hr, AuditService audit, OidcProperties props) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.hr = hr;
        this.audit = audit;
        this.props = props;
    }

    /** Returns the linked person, linking on first sign-in when unambiguous; otherwise records an issue and refuses. */
    @Transactional(noRollbackFor = ApiException.class)
    public UUID resolve(OidcClient.Identity id) {
        UUID linked = jdbc.sql("select person_id from identity_link where issuer = :i and subject = :s")
                .param("i", id.issuer()).param("s", id.subject()).query(UUID.class).optional().orElse(null);
        if (linked != null) {
            return linked;
        }
        if (id.enterpriseKey() == null) {
            throw refuse(id, "NO_KEY", "لا يحمل حسابك مفتاح الربط المؤسسي في الدليل؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
        }
        if (hr.stale()) {
            throw refuse(id, "STALE_SOURCE", "بيانات الموارد البشرية غير محدثة ضمن السياسة؛ لا يُربط حساب جديد حتى تنجح المزامنة.");
        }
        // DOMAIN_ACCOUNT: the directory login name equals the HR domain account of the published snapshot (TNQL's rule);
        // EMPLOYEE_NUMBER: a directory attribute equals the HR employee number.
        List<Map<String, Object>> matches = "DOMAIN_ACCOUNT".equals(props.linkKey())
                ? jdbc.sql("""
                        select p.id, p.status from hr_person h
                        join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED'
                        join person p on p.source = 'HR' and p.source_external_id = h.external_id
                        where lower(h.domain_account) = lower(:k)""")
                        .param("k", id.enterpriseKey()).query().listOfRows()
                : jdbc.sql("select id, status from person where source = 'HR' and employee_no = :k")
                        .param("k", id.enterpriseKey()).query().listOfRows();
        if (matches.isEmpty()) {
            throw refuse(id, "NO_MATCH", "لم يُعثر على سجلك في مصدر الموارد البشرية؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
        }
        if (matches.size() > 1) {
            throw refuse(id, "AMBIGUOUS", "مفتاح الربط يطابق أكثر من سجل؛ لا يُربط آلياً وأُحيل إلى مسؤول الصلاحيات.");
        }
        UUID person = (UUID) matches.get(0).get("id");
        if (!"ACTIVE".equals(matches.get(0).get("status"))) {
            throw refuse(id, "INACTIVE", "سجلك غير نشط في مصدر الموارد البشرية.");
        }
        boolean taken = jdbc.sql("select count(*) from identity_link where person_id = :p and issuer = :i")
                .param("p", person).param("i", id.issuer()).query(Integer.class).single() > 0;
        if (taken) {
            throw refuse(id, "ALREADY_LINKED", "سجل الموارد البشرية مرتبط بحساب آخر؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
        }
        link(person, id.issuer(), id.subject(), "ENTERPRISE_KEY", null);
        return person;
    }

    private void link(UUID person, String issuer, String subject, String method, UUID by) {
        jdbc.sql("""
                insert into identity_link(id, person_id, issuer, subject, method, linked_by, linked_at)
                values (:id, :p, :i, :s, :m, :by, :now)""")
                .param("id", UUID.randomUUID()).param("p", person).param("i", issuer).param("s", subject).param("m", method)
                .param("by", by).param("now", Db.ts(clock.instant())).update();
        audit.system("IDENTITY_LINKED", "PERSON", person.toString(), null, Map.of("method", method));
    }

    private ApiException refuse(OidcClient.Identity id, String reason, String message) {
        record(id, reason);
        return new ApiException(ErrorCode.IDENTITY_NOT_LINKED, message, Map.of("reason", reason));
    }

    /** The review entry is kept although the sign-in fails: {@link #resolve} does not roll back on refusal. */
    private void record(OidcClient.Identity id, String reason) {
        Instant now = clock.instant();
        int n = jdbc.sql("""
                update identity_link_issue set attempts = attempts + 1, last_seen_at = :now, reason = :r, claimed_key = :k
                where issuer = :i and subject = :s and resolved_at is null""")
                .param("now", Db.ts(now)).param("r", reason).param("k", id.enterpriseKey()).param("i", id.issuer())
                .param("s", id.subject()).update();
        if (n == 0) {
            jdbc.sql("""
                    insert into identity_link_issue(id, issuer, subject, claimed_key, display_name, reason, first_seen_at, last_seen_at)
                    values (:id, :i, :s, :k, :n, :r, :now, :now)""")
                    .param("id", UUID.randomUUID()).param("i", id.issuer()).param("s", id.subject()).param("k", id.enterpriseKey())
                    .param("n", id.displayName()).param("r", reason).param("now", Db.ts(now)).update();
        }
        audit.system("IDENTITY_LINK_REFUSED", "IDENTITY", null, id.displayName(), Map.of("reason", reason));
    }

    // ---- review list -------------------------------------------------------------------------------------------

    public List<Map<String, Object>> issues(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        boolean ids = ctx.has(Permission.VIEW_SOURCE_IDENTIFIERS);
        return jdbc.sql("select * from identity_link_issue where resolved_at is null order by last_seen_at desc limit 200")
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("displayName", rs.getString("display_name"));
                    m.put("reason", rs.getString("reason"));
                    m.put("attempts", rs.getInt("attempts"));
                    m.put("lastSeenAt", Db.iso(rs, "last_seen_at"));
                    if (ids) {
                        m.put("claimedKey", rs.getString("claimed_key"));
                        m.put("subject", rs.getString("subject"));
                    }
                    return m;
                }).list();
    }

    public record ResolveInput(String personId, String reason) {
    }

    /** An access manager links the identity to a chosen active person, or dismisses the entry, with a reason. */
    @Transactional
    public void resolveIssue(AccessContext ctx, UUID issueId, ResolveInput in) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (in == null || in.reason() == null || in.reason().trim().length() < 5) {
            throw ApiException.validation("اذكر سبب القرار.");
        }
        Map<String, Object> issue = jdbc.sql("select * from identity_link_issue where id = :id and resolved_at is null for update")
                .param("id", issueId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        UUID person = null;
        if (in.personId() != null) {
            person = UUID.fromString(in.personId());
            UUID org = jdbc.sql("select organization_id from affiliation where person_id = :p and valid_to is null")
                    .param("p", person).query(UUID.class).optional().orElse(null);
            boolean active = jdbc.sql("select count(*) from person where id = :p and status = 'ACTIVE'").param("p", person)
                    .query(Integer.class).single() > 0;
            if (!active || (org == null ? !ctx.grants().stream().anyMatch(g -> g.has(Permission.MANAGE_ACCESS) && g.isAll())
                    : !ctx.canFor(Permission.MANAGE_ACCESS, org))) {
                throw ApiException.forbidden("لا تملك ربط هذا الشخص أو أنه غير نشط.");
            }
            int existing = jdbc.sql("select count(*) from identity_link where person_id = :p and issuer = :i")
                    .param("p", person).param("i", issue.get("issuer")).query(Integer.class).single();
            if (existing > 0) {
                throw ApiException.validation("هذا الشخص مرتبط بحساب آخر لدى المزود نفسه؛ أنهِ الربط القائم أولاً.");
            }
            link(person, (String) issue.get("issuer"), (String) issue.get("subject"), "ADMINISTRATOR", ctx.personId());
        }
        jdbc.sql("""
                update identity_link_issue set resolved_at = :now, resolved_by = :by, resolved_person_id = :p, resolution = :r
                where id = :id""")
                .param("now", Db.ts(clock.instant())).param("by", ctx.personId()).param("p", person)
                .param("r", person == null ? "DISMISSED" : "LINKED").param("id", issueId).update();
        audit.recordAs(ctx.actor(), person == null ? "IDENTITY_ISSUE_DISMISSED" : "IDENTITY_LINKED_BY_ADMINISTRATOR", "IDENTITY",
                issueId.toString(), (String) issue.get("display_name"), Map.of(), in.reason());
    }
}
