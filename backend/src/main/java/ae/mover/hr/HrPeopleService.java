package ae.mover.hr;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.ErrorCode;
import ae.mover.hr.HrMapping.Entity;
import ae.mover.security.Actor;

/**
 * HR people come in one by one, as MOVER (owner, 16 Nov 2026: "when we connect to Oracle it should not import them unless I
 * want to import a specific person"; ADR-065). Connecting HR copies nobody: the hourly sync reads the unit tree and the people
 * already in TMRKZ only ({@code hr_linked_person}). A person enters TMRKZ through this service alone, never in bulk:
 * <ul>
 *   <li>{@link #find}: a live, read-only lookup of one key in the person view — exact employee number, or domain account
 *       ignoring case — through the published mapping, bind parameters only, at most {@value #LIMIT} rows. It writes nothing,
 *       not even the mirror;</li>
 *   <li>{@link #importOne}: that one record, re-read by the caller just before, is stored as one row of the published snapshot
 *       and projected by the sync's own rules (person and affiliation), with no permission. Audited {@code HR_PERSON_IMPORTED}.
 *       From then on the person is linked and the hourly sync keeps them current (transfer, leave, rank, departure).</li>
 * </ul>
 */
@Service
public class HrPeopleService {

    private static final Logger log = LoggerFactory.getLogger(HrPeopleService.class);
    /** Rows one live lookup may return (MOVER's limit). */
    public static final int LIMIT = 20;

    /** One person as the HR view states it now, in canonical fields. Source identifiers stay on the server. */
    public record HrRecord(String externalId, String employeeNumber, String legacyNumber, String domainAccount, String fullName,
                           String unitExternalId, String positionId, String positionTitle, String jobTitle, String statusText,
                           boolean active, String leaveStatus, String rank) {
    }

    private final JdbcClient jdbc;
    private final HrSyncService sync;
    private final HrSourceAdapter adapter;
    private final HrProjection projection;
    private final AuditService audit;

    public HrPeopleService(JdbcClient jdbc, HrSyncService sync, HrSourceAdapter adapter, HrProjection projection, AuditService audit) {
        this.jdbc = jdbc;
        this.sync = sync;
        this.adapter = adapter;
        this.projection = projection;
        this.audit = audit;
    }

    /** Whether HR can be asked at all: an enabled source with saved settings and a published mapping. */
    public boolean configured() {
        return jdbc.sql("""
                select count(*) from hr_source s join hr_mapping_version m on m.source_id = s.id and m.status = 'PUBLISHED'
                where s.enabled and s.settings_ciphertext is not null""").query(Integer.class).single() > 0;
    }

    /**
     * Live and read-only: the HR records whose employee number or earlier (legacy) number is exactly {@code number}, or whose domain account equals
     * {@code account} ignoring case (either may be null), active or not, at most {@value #LIMIT}. Nothing is written.
     *
     * @throws ApiException HR_SOURCE_NOT_CONFIGURED when there is no HR to ask, HR_SOURCE_UNAVAILABLE when it cannot be
     *                      reached or read, HR_CONTRACT_MISMATCH when the published mapping no longer fits the view
     */
    public List<HrRecord> find(String number, String account) {
        String n = blankToNull(number);
        String a = blankToNull(account);
        if (n == null && a == null) {
            return List.of();
        }
        Map<String, Object> src = jdbc.sql("""
                select * from hr_source where enabled and settings_ciphertext is not null order by created_at limit 1""")
                .query().listOfRows().stream().findFirst().orElse(null);
        Map<String, Object> mapping = src == null ? null : jdbc.sql("""
                select fields::text as fields, active_rules::text as rules from hr_mapping_version
                where source_id = :s and status = 'PUBLISHED'""").param("s", src.get("id")).query().listOfRows().stream().findFirst().orElse(null);
        if (mapping == null) {
            throw new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED, "لم يُهيأ مصدر الموارد البشرية أو لم يُنشر تعيين أعمدته.");
        }
        try {
            HrMapping.Definition def = sync.definition((String) mapping.get("fields"), (String) mapping.get("rules"));
            HrSourceAdapter.Config cfg = sync.config(src);
            try (HrSourceAdapter.Session session = adapter.open(cfg)) {
                Map<Entity, List<String>> discovered = new EnumMap<>(Entity.class);
                discovered.put(Entity.UNIT, session.columns(cfg.unitView()));
                discovered.put(Entity.PERSON, session.columns(cfg.personView()));
                HrMapping.Compiled compiled = HrMapping.compile(def, discovered);
                // a number is the employee number or the earlier one, as MOVER's live lookup (NEW_MILITARY_NO = :n OR
                // MILITARY_NUMBER = :n, hr_live.find_person_by_number; owner 17 Nov 2026); the legacy field only when mapped
                HrMapping.Condition byNumber = n == null ? null : HrMapping.Condition.or(
                        compiled.in(Entity.PERSON, "employee_number", List.of(n)),
                        compiled.in(Entity.PERSON, "legacy_employee_number", List.of(n)));
                HrMapping.Condition where = HrMapping.Condition.or(byNumber,
                        a == null ? null : compiled.equalsIgnoreCase(Entity.PERSON, "domain_account", a));
                if (where == null) {
                    return List.of();
                }
                List<HrRecord> out = new ArrayList<>();
                for (Map<String, Object> row : session.select(cfg.personView(), compiled.columns(Entity.PERSON), where, LIMIT)) {
                    Map<String, String> v = compiled.convert(Entity.PERSON, row);
                    if (v.get("external_person_id") == null || v.get("full_name") == null || v.get("employee_number") == null) {
                        continue; // the sync would not store it either
                    }
                    // exactly the key asked for, whatever the source compared
                    boolean exact = (n != null && (n.equals(v.get("employee_number")) || n.equals(v.get("legacy_employee_number"))))
                            || (a != null && v.get("domain_account") != null && a.equalsIgnoreCase(v.get("domain_account")));
                    if (exact) {
                        out.add(record(v));
                    }
                }
                return out;
            }
        } catch (HrSourceAdapter.SourceException e) {
            throw new ApiException(ErrorCode.HR_SOURCE_UNAVAILABLE, e.getMessage());
        } catch (HrMapping.ContractException e) {
            throw new ApiException(ErrorCode.HR_CONTRACT_MISMATCH, "تعيين أعمدة الموارد البشرية لا يطابق المصدر؛ يراجعه مدير النظام.");
        } catch (ApiException e) {
            throw e;
        } catch (RuntimeException e) {
            log.warn("HR live lookup failed: {}", e.getClass().getSimpleName()); // never the settings or the key
            throw new ApiException(ErrorCode.HR_SOURCE_UNAVAILABLE, "تعذر الوصول إلى مصدر الموارد البشرية.");
        }
    }

    private static HrRecord record(Map<String, String> v) {
        return new HrRecord(v.get("external_person_id"), v.get("employee_number"), v.get("legacy_employee_number"),
                v.get("domain_account"), v.get("full_name"), v.get("unit_external_id"), v.get("position_id"), v.get("position"),
                v.get("job"), v.get("status_text"), Boolean.parseBoolean(v.get("active")), v.get("leave_status"), v.get("rank"));
    }

    /** The TMRKZ person already holding this HR record, if any. */
    public UUID existing(String externalId) {
        return jdbc.sql("select id from person where source = 'HR' and source_external_id = :x").param("x", externalId)
                .query(UUID.class).optional().orElse(null);
    }

    /**
     * Imports one active HR record just read by {@link #find}: one row in the published snapshot, the person and their
     * affiliation by the projection's rules, no permission of any kind. A person already in TMRKZ is refreshed instead.
     * Runs inside the caller's transaction; never at the same time as a sync (the sync's lock is tried, not waited for).
     *
     * @param by    the access manager importing, or null for a first sign-in
     * @param via   {@code UNIT_MEMBER} or {@code SIGN_IN}
     * @param unit  the unit the person is being added to, if any (audit only)
     */
    // a refusal is thrown before anything is written; it must not doom the caller's transaction (a refused sign-in is recorded)
    @Transactional(propagation = Propagation.MANDATORY, noRollbackFor = ApiException.class)
    public UUID importOne(HrRecord r, Actor by, String via, UUID unit) {
        if (!r.active()) {
            throw ApiException.validation("سجل الموظف غير نشط في الموارد البشرية؛ لا يُستورد.");
        }
        Boolean locked = jdbc.sql("select pg_try_advisory_xact_lock(" + HrSyncService.LOCK_KEY + ")").query(Boolean.class).single();
        if (!Boolean.TRUE.equals(locked)) {
            throw new ApiException(ErrorCode.HR_SYNC_IN_PROGRESS, "يجري الآن تحديث بيانات الموارد البشرية؛ أعد المحاولة بعد قليل.");
        }
        UUID snapshot = jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).optional()
                .orElseThrow(() -> new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED,
                        "لم تُنشر بعد أول نسخة من بيانات الموارد البشرية؛ تُشغّل المزامنة أولاً."));
        UUID existing = existing(r.externalId());
        if (existing == null) {
            // the projection's identity rules, checked before anything is written: an employee number another source record
            // or another TMRKZ record holds never links (a LOCAL record without a source is adopted, as by the sync)
            int shared = jdbc.sql("select count(*) from hr_person where snapshot_id = :s and employee_number = :n and external_id <> :x")
                    .param("s", snapshot).param("n", r.employeeNumber()).param("x", r.externalId()).query(Integer.class).single();
            int taken = jdbc.sql("""
                    select count(*) from person where employee_no = :n and not (source = 'LOCAL' and source_external_id is null)""")
                    .param("n", r.employeeNumber()).query(Integer.class).single();
            if (shared > 0 || taken > 0) {
                throw ApiException.validation("لا يُستورد هذا الموظف آلياً: رقمه الوظيفي مشترك مع سجل آخر في الموارد البشرية أو في تمركز؛"
                        + " يحتاج معالجة مخولة.");
            }
        }
        jdbc.sql("""
                insert into hr_person(snapshot_id, external_id, employee_number, legacy_employee_number, domain_account, full_name,
                                      unit_external_id, position_id, position_title, job_title, status_text, active, leave_status, rank_name)
                values (:s, :x, :n, :ln, :da, :fn, :u, :pid, :pt, :jt, :st, :ac, :lv, :rk)
                on conflict (snapshot_id, external_id) do update set employee_number = excluded.employee_number,
                  legacy_employee_number = excluded.legacy_employee_number, domain_account = excluded.domain_account,
                  full_name = excluded.full_name, unit_external_id = excluded.unit_external_id, position_id = excluded.position_id,
                  position_title = excluded.position_title, job_title = excluded.job_title, status_text = excluded.status_text,
                  active = excluded.active, leave_status = excluded.leave_status, rank_name = excluded.rank_name""")
                .param("s", snapshot).param("x", r.externalId()).param("n", r.employeeNumber()).param("ln", r.legacyNumber())
                .param("da", r.domainAccount()).param("fn", r.fullName()).param("u", r.unitExternalId()).param("pid", r.positionId())
                .param("pt", r.positionTitle()).param("jt", r.jobTitle()).param("st", r.statusText()).param("ac", r.active())
                .param("lv", r.leaveStatus()).param("rk", r.rank()).update();
        jdbc.sql("insert into hr_snapshot_scope(snapshot_id, external_id) values (:s, :x) on conflict do nothing")
                .param("s", snapshot).param("x", r.externalId()).update();
        HrProjection.Result result = projection.applyPerson(snapshot, r.externalId());
        UUID person = existing(r.externalId());
        if (person == null) {
            // the checks above make this unreachable; never keep a half-made import
            throw new IllegalStateException("HR person not projected");
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("via", via);
        detail.put("created", existing == null);
        detail.put("adopted", result.peopleAdopted() > 0);
        if (unit != null) {
            detail.put("organizationId", unit.toString());
        }
        if (by != null) {
            audit.recordAs(by, "HR_PERSON_IMPORTED", "PERSON", person.toString(), r.fullName(), detail, null);
        } else {
            audit.system("HR_PERSON_IMPORTED", "PERSON", person.toString(), r.fullName(), detail);
        }
        return person;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
