package ae.mover.security;

import java.time.Clock;
import java.time.Instant;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Predicate;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.DirectoryScope;
import ae.mover.access.GrantSource;
import ae.mover.access.Permission;
import ae.mover.access.PersonKeys;
import ae.mover.access.RawGrant;
import ae.mover.audit.AuditService;
import ae.mover.authz.GrantAdminService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.hr.HrAdminService;
import ae.mover.hr.HrPeopleService;

/**
 * Links a provider identity (issuer, subject) to a TMRKZ person. The first sign-in links automatically only on the
 * stable enterprise key (the domain account, or the employee number from the directory) matching exactly one active
 * person from the HR source,
 * while the HR mirror is within its age policy. A missing key, no match, several matches, an inactive record, a stale
 * mirror or a person already linked to another identity puts the sign-in on the review list for an access manager.
 * Similar names never link. Holding a directory account grants no business right by itself. Since ADR-065 (as MOVER) a
 * person not yet in TMRKZ is looked up live in HR at their first sign-in and, when exactly one active record holds the key,
 * that one person is imported with no permission ({@link HrPeopleService}).
 *
 * <p>ADR-068 (LDAP first login, as MOVER): while Oracle is not in force ({@link EmploymentContextResolver#mode}), a person the
 * directory verified and nobody in TMRKZ holds is created at their first sign-in — a LOCAL person linked with method
 * {@code DIRECTORY}, with NO permission and NO unit entry — and what the directory states is recorded at every sign-in.
 * Once Oracle is in force, such a person is moved onto their one active HR record at their next sign-in (the projection adopts
 * the same person by employee number; never a second record), and Oracle decides their unit.
 */
@Service
public class IdentityService {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(IdentityService.class);

    private final JdbcClient jdbc;
    private final Clock clock;
    private final HrAdminService hr;
    private final AuditService audit;
    private final OidcProperties props;
    private final PersonKeys keys;
    private final DirectoryScope directory;
    private final GrantSource source;
    private final GrantAdminService grants;
    private final HrPeopleService hrPeople;
    private final EmploymentContextResolver employment;

    public IdentityService(JdbcClient jdbc, Clock clock, HrAdminService hr, AuditService audit, OidcProperties props,
                           PersonKeys keys, DirectoryScope directory, GrantSource source, GrantAdminService grants,
                           HrPeopleService hrPeople, EmploymentContextResolver employment) {
        this.hrPeople = hrPeople;
        this.employment = employment;
        this.jdbc = jdbc;
        this.clock = clock;
        this.hr = hr;
        this.audit = audit;
        this.props = props;
        this.keys = keys;
        this.directory = directory;
        this.source = source;
        this.grants = grants;
    }

    /** Returns the linked person, linking on first sign-in when unambiguous; otherwise records an issue and refuses. */
    @Transactional(noRollbackFor = ApiException.class)
    public UUID resolve(OidcClient.Identity id) {
        if (platform(id)) {
            return platformPerson(id);
        }
        Map<String, Object> linked = jdbc.sql("""
                select il.id, il.person_id, il.method, p.bootstrap, p.source = 'LOCAL' and p.employee_no like 'PLATFORM-%' as platform
                from identity_link il join person p on p.id = il.person_id
                where il.issuer = :i and il.subject = :s""")
                .param("i", id.issuer()).param("s", id.subject()).query().listOfRows().stream().findFirst().orElse(null);
        EmploymentContextResolver.Source mode = employment.mode();
        if (linked != null) {
            UUID person = (UUID) linked.get("person_id");
            if (Boolean.TRUE.equals(linked.get("platform"))) {
                // the provider no longer states the platform role, or the installation no longer names the login
                throw platformRefused(id, "PLATFORM_REVOKED", "لم يعد هذا الحساب من حسابات المنصة الدائمة.");
            }
            if (Boolean.TRUE.equals(linked.get("bootstrap"))) {
                Match m = hrMatch(id, mode);
                if (m.person() != null) {
                    return replaceBootstrap((UUID) linked.get("id"), person, m.person());
                }
                return person;
            }
            if (DIRECTORY.equals(linked.get("method")) && holdsNothing(person)) {
                // signed in once before the host operator registered this login as the first administrator, holding nothing
                UUID boot = bootstrap(id, (UUID) linked.get("id"));
                if (boot != null) {
                    return boot;
                }
            }
            if (mode == EmploymentContextResolver.Source.ORACLE) {
                toOracle(person, id);
                // ADR-094: the person's HR record is refreshed on this need when older than a day; HR not answering changes nothing
                try {
                    hrPeople.refreshIfStale(person);
                } catch (RuntimeException e) {
                    log.info("HR refresh skipped on sign-in: {}", e.getClass().getSimpleName());
                }
            }
            employment.observe(person, id);
            return person;
        }
        Match m = hrMatch(id, mode);
        if (m.person() != null) {
            link(m.person(), id.issuer(), id.subject(), "ENTERPRISE_KEY", null);
            employment.observe(m.person(), id);
            return m.person();
        }
        UUID local = localUser(id);
        if (local != null) {
            employment.observe(local, id);
            return local;
        }
        UUID boot = bootstrap(id, null);
        if (boot != null) {
            return boot;
        }
        // Mode A (ADR-068): the directory verified the person and nobody in TMRKZ holds their key — a zero-access person
        if (mode == EmploymentContextResolver.Source.LDAP && !id.platformRole()
                && ("NO_MATCH".equals(m.reason()) || "STALE_SOURCE".equals(m.reason()))) {
            UUID person = directoryPerson(id);
            if (person != null) {
                employment.observe(person, id);
                return person;
            }
        }
        // ADR-094 (owner, 20 Nov 2026): Oracle is not a dependency of the sign-in. With «الدخول بالدليل يكفي» on, a verified
        // directory sign-in that HR cannot confirm now — HR not answering, or its data stale beyond the policy — enters as a
        // zero-access person from the directory's own attributes, marked «بانتظار مطابقة HR»; a later sign-in or lookup matches
        // the HR record onto them (toOracle). An ambiguous, inactive or already linked record is still refused and reviewed.
        // (HR answering that it does not know the key is still refused and reviewed: the toggle covers HR not answering.)
        if (mode == EmploymentContextResolver.Source.ORACLE && !id.platformRole() && hrPeople.directorySignInSuffices()
                && ("SOURCE_UNAVAILABLE".equals(m.reason()) || "STALE_SOURCE".equals(m.reason()))) {
            UUID person;
            try {
                person = directoryPerson(id);
            } catch (ApiException conflict) {
                // the login or number is already someone's: the original answer (HR not answering) is the one to review
                throw refuse(id, m.reason(), m.message());
            }
            if (person != null) {
                jdbc.sql("update person set hr_match_pending = true where id = :p").param("p", person).update();
                audit.system("IDENTITY_HR_MATCH_PENDING", "PERSON", person.toString(), id.displayName(), Map.of("reason", m.reason()));
                employment.observe(person, id);
                return person;
            }
        }
        throw refuse(id, m.reason(), m.message());
    }

    /** Link method of a person created by their own first directory sign-in while Oracle was not in force (ADR-068). */
    static final String DIRECTORY = "DIRECTORY";

    /**
     * Mode A first sign-in (ADR-068, LDAP specification §1, 6): the directory verified the password; nobody in TMRKZ holds
     * the key. The same person signing in through the other path (manual directory, identity provider) is linked to the
     * record their first sign-in made. Otherwise a LOCAL person is created — the directory's employee number (or a placeholder
     * when the entry has none), display name and login — linked with method {@code DIRECTORY}, with NO grant of any kind and NO
     * unit entry; it has no usable local password. A login or employee number another TMRKZ record holds never gets a second
     * record: the sign-in waits on the review list ({@code DIRECTORY_CONFLICT}).
     *
     * @return the person, or null when the identity carries no usable login (refused by the caller with its reason)
     */
    private UUID directoryPerson(OidcClient.Identity id) {
        String login = ae.mover.authz.UnitMemberService.normalLogin(id.username());
        if (login == null || id.enterpriseKey() == null) {
            return null;
        }
        UUID same = directoryPersonByLogin(login);
        if (same != null) {
            boolean taken = jdbc.sql("select count(*) from identity_link where person_id = :p and issuer = :i")
                    .param("p", same).param("i", id.issuer()).query(Integer.class).single() > 0;
            if (taken) {
                throw refuse(id, "ALREADY_LINKED", "حسابك مرتبط بحساب دخول آخر؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
            }
            link(same, id.issuer(), id.subject(), DIRECTORY, null);
            return same;
        }
        String number = id.profile().employeeNumber();
        if (number == null && "EMPLOYEE_NUMBER".equals(props.linkKey())) {
            number = DirectoryProfile.clean(id.enterpriseKey());
        }
        String employeeNo = number != null ? number : EmploymentContextResolver.DIRECTORY_NUMBER_PREFIX + login;
        // also an HR person of an earlier Oracle period whose published record carries this account (a stale mirror links nobody)
        int held = jdbc.sql("""
                select count(*) from person where lower(username) = :l or employee_no = :n
                  or id in (select p.id from hr_person h join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED'
                            join person p on p.source = 'HR' and p.source_external_id = h.external_id where lower(h.domain_account) = :l)""")
                .param("l", login).param("n", employeeNo).query(Integer.class).single();
        String conflict = "اسم الدخول أو الرقم الوظيفي مسجل لسجل آخر في تمركز؛ لا يُنشأ سجل ثانٍ، وأُحيل الدخول إلى مسؤول الصلاحيات.";
        if (held > 0) {
            throw refuse(id, "DIRECTORY_CONFLICT", conflict);
        }
        UUID person = UUID.randomUUID();
        String name = DirectoryProfile.clean(id.displayName());
        int made = jdbc.sql("""
                insert into person(id, employee_no, display_name, username, status, source)
                values (:id, :e, :n, :l, 'ACTIVE', 'LOCAL') on conflict do nothing""")
                .param("id", person).param("e", employeeNo).param("n", name == null ? login : name).param("l", login).update();
        if (made == 0) {
            throw refuse(id, "DIRECTORY_CONFLICT", conflict); // another sign-in of the same key at the same moment
        }
        link(person, id.issuer(), id.subject(), DIRECTORY, null);
        UUID unit = employment.unitById(id.profile().unitId());
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("login", login);
        detail.put("grants", 0);
        detail.put("unitIdStated", id.profile().unitId() != null);
        detail.put("unitResolved", unit != null);
        audit.system("IDENTITY_PROVISIONED_FROM_DIRECTORY", "PERSON", person.toString(), name == null ? login : name, detail);
        return person;
    }

    /** The person a first directory sign-in created for this login (ADR-068), if any and still LOCAL. */
    private UUID directoryPersonByLogin(String login) {
        return jdbc.sql("""
                select p.id from person p
                where p.source = 'LOCAL' and p.status = 'ACTIVE' and not p.bootstrap and lower(p.username) = :l
                  and exists (select 1 from identity_link il where il.person_id = p.id and il.method = 'DIRECTORY')
                limit 1""").param("l", login).query(UUID.class).optional().orElse(null);
    }

    /** No grant was ever made to the person (a first sign-in that received nothing yet). */
    private boolean holdsNothing(UUID person) {
        return jdbc.sql("select count(*) from membership where person_id = :p").param("p", person).query(Integer.class).single() == 0;
    }

    /**
     * Oracle now in force (ADR-068 §25): a person created by the directory before is moved onto their one ACTIVE HR record,
     * found live by the sign-in's enterprise key as at a first sign-in (ADR-065). The projection adopts the same person — a LOCAL
     * record with that employee number — so grants, requests and history stay; no second record is ever made. When the
     * directory's employee number differs from Oracle's (or the entry had none), Oracle's number is taken first, unless another
     * record holds it. Anything else (HR unreachable, no record, several, inactive, the record already someone else's) leaves the
     * person as they are, signed in, and is audited ({@code IDENTITY_SOURCE_TRANSITION_DEFERRED}); Oracle then decides their unit
     * as for anyone it does not post: none, or the unit an access manager added them to.
     */
    private void toOracle(UUID person, OidcClient.Identity id) {
        Map<String, Object> p = jdbc.sql("""
                select p.source, p.employee_no,
                       exists (select 1 from identity_link il where il.person_id = p.id and il.method = 'DIRECTORY') as made
                from person p where p.id = :p""").param("p", person).query().singleRow();
        // only a person a directory sign-in created; never a platform account or a User ID an access manager added
        if (!"LOCAL".equals(p.get("source")) || !Boolean.TRUE.equals(p.get("made")) || !hrPeople.configured() || id.enterpriseKey() == null) {
            return;
        }
        List<HrPeopleService.HrRecord> found;
        try {
            found = "DOMAIN_ACCOUNT".equals(props.linkKey()) ? hrPeople.find(null, id.enterpriseKey()) : hrPeople.find(id.enterpriseKey(), null);
        } catch (ApiException e) {
            deferred(person, "SOURCE_UNAVAILABLE");
            return;
        }
        if (found.size() != 1 || !found.get(0).active()) {
            deferred(person, found.isEmpty() ? "NO_MATCH" : found.size() > 1 ? "AMBIGUOUS" : "INACTIVE");
            return;
        }
        String refused = adoptInto(person, (String) p.get("employee_no"), found.get(0));
        if (refused != null) {
            deferred(person, refused);
            return;
        }
        jdbc.sql("update person set hr_match_pending = false, hr_fetched_at = :now where id = :p").param("now", Db.ts(clock.instant())).param("p", person).update();
        audit.system("IDENTITY_HR_MATCHED", "PERSON", person.toString(), null, Map.of("via", "SIGN_IN"));
    }

    /**
     * Imports one HR record onto an existing LOCAL person (the projection adopts them by employee number). Runs in the caller's
     * transaction; on refusal nothing stays changed.
     *
     * @return null when the person is now that HR record, else why not
     */
    private String adoptInto(UUID person, String currentNumber, HrPeopleService.HrRecord r) {
        UUID holder = hrPeople.existing(r.externalId());
        if (holder != null) {
            return holder.equals(person) ? null : "RECORD_HELD";
        }
        boolean aligned = !r.employeeNumber().equals(currentNumber);
        if (aligned) {
            int other = jdbc.sql("select count(*) from person where employee_no = :n and id <> :p")
                    .param("n", r.employeeNumber()).param("p", person).query(Integer.class).single();
            if (other > 0) {
                return "NUMBER_HELD";
            }
            jdbc.sql("update person set employee_no = :n where id = :p").param("n", r.employeeNumber()).param("p", person).update();
        }
        UUID imported;
        try {
            imported = hrPeople.importOne(r, null, "SIGN_IN", null);
        } catch (ApiException e) {
            if (aligned) {
                jdbc.sql("update person set employee_no = :n where id = :p").param("n", currentNumber).param("p", person).update();
            }
            return ErrorCode.HR_SYNC_IN_PROGRESS.equals(e.code()) || ErrorCode.HR_SOURCE_NOT_CONFIGURED.equals(e.code())
                    ? "SOURCE_UNAVAILABLE" : "REFUSED";
        }
        if (!person.equals(imported)) {
            // the checks above make this unreachable; never keep a half move
            throw new IllegalStateException("HR record not adopted by the directory person");
        }
        return null;
    }

    private void deferred(UUID person, String reason) {
        audit.system("IDENTITY_SOURCE_TRANSITION_DEFERRED", "PERSON", person.toString(), null, Map.of("reason", reason));
    }

    /** Either the one HR person the identity belongs to, or why there is none. */
    record Match(UUID person, String reason, String message) {
    }

    /**
     * The HR person of a sign-in: already in TMRKZ ({@link #match}), else — HR people come in one by one since ADR-065 (owner,
     * 16 Nov 2026, as MOVER) — HR is asked live by the sign-in's enterprise key, and exactly one ACTIVE record holding it is
     * imported, that one person and with no permission. Unknown, inactive, several records, or HR not answering: refused as
     * before. HR not configured at all, or not in force (no published snapshot yet, ADR-068), leaves the old answer (no match).
     * A person the directory created before Oracle was in force, under the same login, is the one the record is imported onto.
     */
    private Match hrMatch(OidcClient.Identity id, EmploymentContextResolver.Source mode) {
        Match local = match(id);
        if (local.person() != null || !"NO_MATCH".equals(local.reason()) || mode != EmploymentContextResolver.Source.ORACLE
                || !hrPeople.configured()) {
            return local;
        }
        boolean byAccount = "DOMAIN_ACCOUNT".equals(props.linkKey());
        List<HrPeopleService.HrRecord> found;
        try {
            found = byAccount ? hrPeople.find(null, id.enterpriseKey()) : hrPeople.find(id.enterpriseKey(), null);
        } catch (ApiException e) {
            return new Match(null, "SOURCE_UNAVAILABLE", "تعذر التحقق من سجلك في مصدر الموارد البشرية الآن؛ أعد المحاولة لاحقاً.");
        }
        if (found.isEmpty()) {
            return local;
        }
        if (found.size() > 1) {
            return new Match(null, "AMBIGUOUS", "مفتاح الربط يطابق أكثر من سجل؛ لا يُربط آلياً وأُحيل إلى مسؤول الصلاحيات.");
        }
        HrPeopleService.HrRecord r = found.get(0);
        if (!r.active()) {
            return new Match(null, "INACTIVE", "سجلك غير نشط في مصدر الموارد البشرية.");
        }
        String login = ae.mover.authz.UnitMemberService.normalLogin(id.username());
        UUID earlier = login == null ? null : directoryPersonByLogin(login);
        if (earlier != null) {
            // the same person, made by the directory before Oracle was in force (signed in then through the other path)
            String number = jdbc.sql("select employee_no from person where id = :p").param("p", earlier).query(String.class).single();
            String refused = adoptInto(earlier, number, r);
            if (refused != null) {
                return new Match(null, "AMBIGUOUS", "سجلك في الموارد البشرية لا يُنقل آلياً إلى حسابك في تمركز؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
            }
            boolean taken = jdbc.sql("select count(*) from identity_link where person_id = :p and issuer = :i")
                    .param("p", earlier).param("i", id.issuer()).query(Integer.class).single() > 0;
            return taken ? new Match(null, "ALREADY_LINKED", "سجل الموارد البشرية مرتبط بحساب آخر؛ أُحيل الدخول إلى مسؤول الصلاحيات.")
                    : new Match(earlier, null, null);
        }
        UUID person;
        try {
            person = hrPeople.importOne(r, null, "SIGN_IN", null);
        } catch (ApiException e) {
            return ErrorCode.HR_SYNC_IN_PROGRESS.equals(e.code()) || ErrorCode.HR_SOURCE_NOT_CONFIGURED.equals(e.code())
                    ? new Match(null, "SOURCE_UNAVAILABLE", "يجري تحديث بيانات الموارد البشرية الآن؛ أعد المحاولة بعد قليل.")
                    : new Match(null, "AMBIGUOUS", e.getMessage());
        }
        boolean taken = jdbc.sql("select count(*) from identity_link where person_id = :p and issuer = :i")
                .param("p", person).param("i", id.issuer()).query(Integer.class).single() > 0;
        if (taken) {
            return new Match(null, "ALREADY_LINKED", "سجل الموارد البشرية مرتبط بحساب آخر؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
        }
        return new Match(person, null, null);
    }

    private Match match(OidcClient.Identity id) {
        if (id.enterpriseKey() == null) {
            return new Match(null, "NO_KEY", "لا يحمل حسابك مفتاح الربط المؤسسي في الدليل؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
        }
        if (hr.stale()) {
            return new Match(null, "STALE_SOURCE", "بيانات الموارد البشرية غير محدثة ضمن السياسة؛ لا يُربط حساب جديد حتى تنجح المزامنة.");
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
            return new Match(null, "NO_MATCH", "لم يُعثر على سجلك في مصدر الموارد البشرية؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
        }
        if (matches.size() > 1) {
            return new Match(null, "AMBIGUOUS", "مفتاح الربط يطابق أكثر من سجل؛ لا يُربط آلياً وأُحيل إلى مسؤول الصلاحيات.");
        }
        UUID person = (UUID) matches.get(0).get("id");
        if (!"ACTIVE".equals(matches.get(0).get("status"))) {
            return new Match(null, "INACTIVE", "سجلك غير نشط في مصدر الموارد البشرية.");
        }
        boolean taken = jdbc.sql("select count(*) from identity_link where person_id = :p and issuer = :i")
                .param("p", person).param("i", id.issuer()).query(Integer.class).single() > 0;
        if (taken) {
            return new Match(null, "ALREADY_LINKED", "سجل الموارد البشرية مرتبط بحساب آخر؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
        }
        return new Match(person, null, null);
    }

    /**
     * A User ID an access manager added without HR (ADR-049, «إضافة مستخدم»): the first sign-in under exactly that directory
     * login links to it. The password was verified by the directory or the identity provider before this point, and the
     * account holds only what an access manager granted it. An HR match always comes first; a second identity claiming the
     * same account goes to the review list.
     */
    private UUID localUser(OidcClient.Identity id) {
        String login = ae.mover.authz.UnitMemberService.normalLogin(id.username());
        if (login == null) {
            return null;
        }
        Map<String, Object> p = jdbc.sql("""
                select id, display_name from person
                where source = 'LOCAL' and status = 'ACTIVE' and not bootstrap and lower(username) = :l and employee_no = :e""")
                .param("l", login).param("e", "USER-" + login).query().listOfRows().stream().findFirst().orElse(null);
        if (p == null) {
            return null;
        }
        UUID person = (UUID) p.get("id");
        boolean taken = jdbc.sql("select count(*) from identity_link where person_id = :p and issuer = :i")
                .param("p", person).param("i", id.issuer()).query(Integer.class).single() > 0;
        if (taken) {
            throw refuse(id, "ALREADY_LINKED", "رقم المستخدم مرتبط بحساب دخول آخر؛ أُحيل الدخول إلى مسؤول الصلاحيات.");
        }
        link(person, id.issuer(), id.subject(), "LOCAL_USER", null);
        // the name typed by the manager stays; a login used as a placeholder takes the directory's display name
        if (login.equals(p.get("display_name")) && id.displayName() != null && !id.displayName().isBlank()) {
            jdbc.sql("update person set display_name = :n where id = :p").param("n", id.displayName().trim()).param("p", person).update();
        }
        return person;
    }

    /**
     * First administrator of an empty installation: only for a login registered by the host operator
     * (ops/bootstrap-admin.sh), within 24 hours, and only while no active system administrator exists. The password was
     * verified by the directory or the identity provider before this point. {@code linkId}: the identity is already linked to
     * a person its first directory sign-in created and who holds nothing (ADR-068); the link moves to the administrator.
     */
    private UUID bootstrap(OidcClient.Identity id, UUID linkId) {
        String login = id.username() == null ? null : id.username().trim().toLowerCase(java.util.Locale.ROOT);
        if (login == null || login.isEmpty()) {
            return null;
        }
        Instant now = clock.instant();
        Map<String, Object> request = jdbc.sql("""
                select login from bootstrap_admin where login = :l and used_at is null and expires_at > :now for update""")
                .param("l", login).param("now", Db.ts(now)).query().listOfRows().stream().findFirst().orElse(null);
        if (request == null) {
            return null;
        }
        int admins = jdbc.sql("""
                select count(*) from membership m join person p on p.id = m.person_id and p.status = 'ACTIVE'
                where m.role_code = 'SYSTEM_ADMIN' and m.valid_from <= :now and (m.valid_to is null or m.valid_to > :now)""")
                .param("now", Db.ts(now)).query(Integer.class).single();
        if (admins > 0) {
            audit.system("BOOTSTRAP_ADMIN_REFUSED", "IDENTITY", null, login, Map.of("reason", "ADMIN_EXISTS"));
            return null;
        }
        UUID org = jdbc.sql("select id from organization where status = 'ACTIVE' order by (parent_id is null) desc, created_at limit 1")
                .query(UUID.class).optional().orElse(null);
        if (org == null) {
            org = UUID.randomUUID();
            jdbc.sql("insert into organization(id, code, name, valid_from) values (:id, 'LOCAL-ROOT', 'المؤسسة (تهيئة أولى)', :now)")
                    .param("id", org).param("now", Db.ts(now)).update();
        }
        UUID person = UUID.randomUUID();
        jdbc.sql("""
                insert into person(id, employee_no, display_name, status, source, bootstrap)
                values (:id, :e, :n, 'ACTIVE', 'LOCAL', true)""")
                .param("id", person).param("e", "BOOTSTRAP-" + login).param("n", id.displayName() == null ? login : id.displayName()).update();
        jdbc.sql("""
                insert into membership(id, person_id, organization_id, role_code, position_title, valid_from, valid_to, follows_affiliation)
                values (:id, :p, :o, 'SYSTEM_ADMIN', 'مدير التهيئة الأولى', :now, :until, false)""")
                .param("id", UUID.randomUUID()).param("p", person).param("o", org).param("now", Db.ts(now))
                .param("until", Db.ts(now.plus(java.time.Duration.ofHours(72)))).update();
        if (linkId == null) {
            link(person, id.issuer(), id.subject(), "BOOTSTRAP", null);
        } else {
            jdbc.sql("update identity_link set person_id = :p, method = 'BOOTSTRAP', linked_at = :now where id = :id")
                    .param("p", person).param("now", Db.ts(now)).param("id", linkId).update();
            audit.system("IDENTITY_LINKED", "PERSON", person.toString(), null, Map.of("method", "BOOTSTRAP", "movedFrom", DIRECTORY));
        }
        jdbc.sql("update bootstrap_admin set used_at = :now, person_id = :p where login = :l")
                .param("now", Db.ts(now)).param("p", person).param("l", login).update();
        audit.system("BOOTSTRAP_ADMIN_CREATED", "PERSON", person.toString(), id.displayName(), Map.of("login", login, "validHours", 72));
        return person;
    }

    // ---- platform accounts (V21, owner decision of 6 Nov 2026) ----------------------------------------------------

    private static final String PLATFORM_PREFIX = "PLATFORM-";
    /** Every administrative right: configuration, access, facilities, source identifiers (مدير النظام) and audit. */
    private static final List<String> PLATFORM_ROLES = List.of("SYSTEM_ADMIN", "AUDITOR");
    /** The «developer» platform account carries a temporary wide-open role in addition (V59, owner 20 Nov 2026). */
    private static final List<String> PLATFORM_ROLES_DEVELOPER = List.of("SYSTEM_ADMIN", "AUDITOR", "DEVELOPER");

    private List<String> platformRolesFor(String login) {
        return "developer".equals(login) ? PLATFORM_ROLES_DEVELOPER : PLATFORM_ROLES;
    }

    /**
     * A lasting platform account («admin», «developer»): a local user of the identity provider holding the realm role
     * tmrkz-platform, AND a login the installation names in TMRKZ_PLATFORM_ACCOUNTS, AND issued by the approved local platform
     * issuer (ADR-071): the same role name from the external enterprise realm never creates or renews platform rights. A
     * directory user of the same name holds no such role, and the manual directory path never states it.
     */
    private boolean platform(OidcClient.Identity id) {
        return id.platformRole() && props.platformAccount(id.username()) && id.issuer() != null
                && id.issuer().equals(props.platformIssuer());
    }

    /**
     * The account's LOCAL person (created on its first sign-in), linked to this identity, with its lasting grants made
     * current on every sign-in. The HR projection only changes HR people, so neither HR nor the directory disables it.
     */
    private UUID platformPerson(OidcClient.Identity id) {
        String login = id.username().trim().toLowerCase(Locale.ROOT);
        Instant now = clock.instant();
        int created = jdbc.sql("""
                insert into person(id, employee_no, display_name, username, status, source)
                values (:id, :e, :n, :l, 'ACTIVE', 'LOCAL') on conflict (employee_no) do nothing""")
                .param("id", UUID.randomUUID()).param("e", PLATFORM_PREFIX + login)
                .param("n", id.displayName() == null || id.displayName().isBlank() ? login : id.displayName()).param("l", login).update();
        UUID person = jdbc.sql("select id from person where employee_no = :e and source = 'LOCAL'")
                .param("e", PLATFORM_PREFIX + login).query(UUID.class).optional()
                .orElseThrow(() -> platformRefused(id, "PLATFORM_CONFLICT", "اسم حساب المنصة محجوز لسجل آخر."));
        if (created > 0) {
            audit.system("PLATFORM_ACCOUNT_CREATED", "PERSON", person.toString(), login, Map.of("login", login, "roles", platformRolesFor(login)));
        }
        UUID linkedTo = jdbc.sql("select person_id from identity_link where issuer = :i and subject = :s")
                .param("i", id.issuer()).param("s", id.subject()).query(UUID.class).optional().orElse(null);
        if (linkedTo == null) {
            // a provider user re-created under the same login keeps the same person: the link follows the new subject
            int moved = jdbc.sql("update identity_link set subject = :s, linked_at = :now where person_id = :p and issuer = :i")
                    .param("s", id.subject()).param("now", Db.ts(now)).param("p", person).param("i", id.issuer()).update();
            if (moved == 0) {
                link(person, id.issuer(), id.subject(), "PLATFORM", null);
            }
        } else if (!linkedTo.equals(person)) {
            throw platformRefused(id, "PLATFORM_CONFLICT", "هذا الحساب مرتبط بسجل آخر؛ لا يصبح حساب منصة.");
        }
        UUID org = jdbc.sql("select id from organization where status = 'ACTIVE' order by (parent_id is null) desc, (source = 'LOCAL') desc, created_at limit 1")
                .query(UUID.class).optional().orElse(null);
        if (org == null) {
            org = UUID.randomUUID();
            jdbc.sql("insert into organization(id, code, name, valid_from) values (:id, 'LOCAL-ROOT', 'المؤسسة (تهيئة أولى)', :now)")
                    .param("id", org).param("now", Db.ts(now)).update();
        }
        for (String role : platformRolesFor(login)) {
            int current = jdbc.sql("""
                    select count(*) from membership where person_id = :p and role_code = :r
                      and valid_from <= :now and (valid_to is null or valid_to > :now)""")
                    .param("p", person).param("r", role).param("now", Db.ts(now)).query(Integer.class).single();
            if (current == 0) {
                jdbc.sql("""
                        insert into membership(id, person_id, organization_id, role_code, position_title, valid_from, follows_affiliation)
                        values (:id, :p, :o, :r, 'حساب المنصة الدائم', :now, false)""")
                        .param("id", UUID.randomUUID()).param("p", person).param("o", org).param("r", role).param("now", Db.ts(now)).update();
                if (created == 0) {
                    // the first grants belong to the account's creation; later ones restore a grant someone ended
                    audit.system("PLATFORM_GRANT_RENEWED", "PERSON", person.toString(), login, Map.of("role", role));
                }
            }
        }
        return person;
    }

    /** Platform refusals are not review-list items: no access manager can link them; they are audited. */
    private ApiException platformRefused(OidcClient.Identity id, String reason, String message) {
        audit.system("IDENTITY_LINK_REFUSED", "IDENTITY", null, id.displayName(), Map.of("reason", reason));
        return new ApiException(ErrorCode.IDENTITY_NOT_LINKED, message, Map.of("reason", reason));
    }

    /** The HR record now exists: the identity moves to it and the temporary administrator grant ends. */
    private UUID replaceBootstrap(UUID linkId, UUID bootstrapPerson, UUID hrPerson) {
        Instant now = clock.instant();
        jdbc.sql("update identity_link set person_id = :p, method = 'ENTERPRISE_KEY', linked_at = :now where id = :id")
                .param("p", hrPerson).param("now", Db.ts(now)).param("id", linkId).update();
        jdbc.sql("""
                update membership set valid_to = greatest(:now, valid_from + interval '1 second'), ended_reason = 'BOOTSTRAP_REPLACED'
                where person_id = :p and (valid_to is null or valid_to > :now)""")
                .param("now", Db.ts(now)).param("p", bootstrapPerson).update();
        jdbc.sql("update person set status = 'DISABLED' where id = :p").param("p", bootstrapPerson).update();
        audit.system("BOOTSTRAP_ADMIN_REPLACED", "PERSON", hrPerson.toString(), null, Map.of("bootstrapPerson", bootstrapPerson.toString()));
        return hrPerson;
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

    /**
     * Sign-ins waiting for a decision (ADR-027): all of them for a global access manager; for a scoped one only those whose
     * claimed key belongs to a member of their directory — a sign-in without a key, or with a key nobody inside holds,
     * is decided by a global access manager.
     */
    public List<Map<String, Object>> issues(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        boolean ids = ctx.has(Permission.VIEW_SOURCE_IDENTIFIERS);
        List<String> claimed = jdbc.sql("select claimed_key from identity_link_issue where resolved_at is null and claimed_key is not null")
                .query(String.class).list();
        Predicate<String> visible = visibility(ctx, claimed);
        return jdbc.sql("select * from identity_link_issue where resolved_at is null order by last_seen_at desc")
                .query((rs, n) -> {
                    if (!visible.test(rs.getString("claimed_key"))) {
                        return null;
                    }
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
                }).list().stream().filter(java.util.Objects::nonNull).limit(200).toList();
    }

    private static String normal(String key) {
        return key == null ? null : key.trim().toLowerCase(Locale.ROOT);
    }

    /** Which claimed keys the manager may handle: every one for a global manager, else those a directory member holds. */
    private Predicate<String> visibility(AccessContext ctx, List<String> claimedKeys) {
        if (directory.reach(ctx).global()) {
            return k -> true;
        }
        Map<String, Set<UUID>> holders = keys.holders(claimedKeys);
        Set<UUID> all = new HashSet<>();
        holders.values().forEach(all::addAll);
        Set<UUID> members = directory.members(ctx, all);
        return k -> k != null && holders.getOrDefault(normal(k), Set.of()).stream().anyMatch(members::contains);
    }

    /**
     * Linking a sign-in hands it the person's roles (ADR-027): only an active person inside the linker's directory, all
     * of whose current and future grants the linker could give; never the linker themselves or the temporary first
     * administrator; and never anyone but the person whose key the sign-in claims.
     */
    private void requireLinkable(AccessContext ctx, UUID person, String claimedKey) {
        if (keys.same(ctx.personId(), person)) {
            throw ApiException.forbidden("لا يجوز ربط حساب دخول بسجلك أنت؛ يربطه مدير صلاحيات آخر.");
        }
        Map<String, Object> p = jdbc.sql("select status, coalesce(bootstrap, false) as bootstrap from person where id = :p")
                .param("p", person).query().listOfRows().stream().findFirst()
                .orElseThrow(() -> ApiException.forbidden("لا تملك ربط هذا الشخص أو أنه غير نشط."));
        if (Boolean.TRUE.equals(p.get("bootstrap"))) {
            throw ApiException.forbidden("هوية التهيئة الأولى مؤقتة ولا يُربط بها حساب دخول آخر.");
        }
        if (!"ACTIVE".equals(p.get("status")) || !directory.covers(ctx, person)) {
            throw ApiException.forbidden("لا تملك ربط هذا الشخص أو أنه غير نشط.");
        }
        if (claimedKey != null) {
            Set<UUID> owners = keys.holders(List.of(claimedKey)).getOrDefault(normal(claimedKey), Set.of());
            if (!owners.isEmpty() && !owners.contains(person)) {
                throw ApiException.forbidden("الحساب يحمل مفتاح شخص آخر؛ لا يُربط بسجل غيره.");
            }
        }
        for (RawGrant g : source.unended(person, clock.instant())) {
            try {
                grants.requireAuthority(ctx, g);
            } catch (ApiException e) {
                throw ApiException.forbidden("للشخص أدوار تتجاوز ما تملك منحه؛ يربط حسابه مدير صلاحيات يملك منحها.");
            }
        }
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
        String claimed = (String) issue.get("claimed_key");
        if (!visibility(ctx, claimed == null ? List.of() : List.of(claimed)).test(claimed)) {
            throw ApiException.notFound();
        }
        UUID person = null;
        if (in.personId() != null) {
            person = UUID.fromString(in.personId());
            requireLinkable(ctx, person, claimed);
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
