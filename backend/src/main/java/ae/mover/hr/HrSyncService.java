package ae.mover.hr;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Json;
import ae.mover.hr.HrMapping.Entity;

/**
 * Hourly read-only mirror of the HR views. One path serves the schedule and the manual button:
 * <ol>
 *   <li>a PostgreSQL advisory lock admits one run across all application instances; a run that finds it taken is
 *       recorded as SKIPPED (deferred), never started in parallel;</li>
 *   <li>the published mapping is checked against the view metadata — a mismatch is REJECTED without guessing;</li>
 *   <li>rows stream into a STAGING snapshot inside one read-only source transaction;</li>
 *   <li>keys, duplicates, parents, cycles and counts are checked; an empty source is always refused and a drop larger than
 *       max(drop%, minimum) is refused unless an authorised manual run gives a reason;</li>
 *   <li>the snapshot is published and projected in one transaction, so readers see one complete version.</li>
 * </ol>
 * Failures are recorded in their own transactions (they survive the rollback) without source rows, and the last
 * published snapshot stays in force. An HR outage never deletes data or grants rights.
 */
@Service
public class HrSyncService {

    private static final Logger log = LoggerFactory.getLogger(HrSyncService.class);
    /** Advisory lock key ("TMRKZ-HR"). */
    static final long LOCK_KEY = 0x544D524B5A4852L;
    private static final int MAX_ISSUES = 500;

    private final JdbcClient jdbc;
    private final JdbcTemplate batch;
    private final DataSource dataSource;
    private final TransactionTemplate tx;
    private final Clock clock;
    private final Json json;
    private final HrProperties props;
    private final HrSettingsCipher cipher;
    private final HrSourceAdapter adapter;
    private final HrProjection projection;
    private final AuditService audit;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "hr-sync");
        t.setDaemon(true);
        return t;
    });
    private final AtomicBoolean busy = new AtomicBoolean();

    public HrSyncService(JdbcClient jdbc, JdbcTemplate batch, DataSource dataSource, TransactionTemplate tx, Clock clock,
                         Json json, HrProperties props, HrSettingsCipher cipher, HrSourceAdapter adapter,
                         HrProjection projection, AuditService audit) {
        this.jdbc = jdbc;
        this.batch = batch;
        this.dataSource = dataSource;
        this.tx = tx;
        this.clock = clock;
        this.json = json;
        this.props = props;
        this.cipher = cipher;
        this.adapter = adapter;
        this.projection = projection;
        this.audit = audit;
    }

    // ---- triggers ---------------------------------------------------------------------------------------------

    @Scheduled(fixedDelayString = "${tmrkz.hr.sync-interval-seconds:3600}",
            initialDelayString = "${tmrkz.hr.initial-delay-seconds:60}", timeUnit = TimeUnit.SECONDS)
    public void scheduled() {
        if (!props.schedulerEnabled() || !enabledSourceExists()) {
            return;
        }
        if (!busy.compareAndSet(false, true)) {
            recordSkipped(UUID.randomUUID(), "SCHEDULED", null, "التشغيل السابق ما زال قائماً؛ أُجّل هذا الموعد دون تشغيل متداخل.");
            return;
        }
        executor.submit(() -> {
            try {
                run("SCHEDULED", null, null);
            } finally {
                busy.set(false);
            }
        });
    }

    /** Manual refresh: the same path as the schedule, never a second concurrent run. Returns the run id. */
    public UUID requestManual(UUID requestedBy, String overrideReason) {
        if (!enabledSourceExists()) {
            throw new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED, "لم يُهيأ مصدر الموارد البشرية أو هو معطل.");
        }
        if (!busy.compareAndSet(false, true)) {
            throw new ApiException(ErrorCode.HR_SYNC_IN_PROGRESS, "يوجد تحديث قائم لبيانات الموارد البشرية؛ انتظر انتهاءه.");
        }
        UUID runId = UUID.randomUUID();
        executor.submit(() -> {
            try {
                run(runId, "MANUAL", requestedBy, overrideReason);
            } finally {
                busy.set(false);
            }
        });
        return runId;
    }

    public boolean running() {
        return busy.get();
    }

    private boolean enabledSourceExists() {
        return jdbc.sql("select count(*) from hr_source where enabled").query(Integer.class).single() > 0;
    }

    // ---- the run ----------------------------------------------------------------------------------------------

    public UUID run(String trigger, UUID requestedBy, String overrideReason) {
        return run(UUID.randomUUID(), trigger, requestedBy, overrideReason);
    }

    UUID run(UUID runId, String trigger, UUID requestedBy, String overrideReason) {
        try (Connection lock = dataSource.getConnection()) {
            if (!advisory(lock, "pg_try_advisory_lock")) {
                recordSkipped(runId, trigger, requestedBy, "تشغيل آخر يحمل قفل المزامنة؛ أُجّل هذا التشغيل.");
                return runId;
            }
            try {
                recoverInterrupted();
                execute(runId, trigger, requestedBy, overrideReason);
            } finally {
                advisory(lock, "pg_advisory_unlock");
            }
        } catch (SQLException e) {
            log.error("HR sync lock connection failed", e);
        }
        return runId;
    }

    private static boolean advisory(Connection c, String fn) throws SQLException {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("select " + fn + "(" + LOCK_KEY + ")")) {
            return rs.next() && rs.getBoolean(1);
        }
    }

    /** A run left RUNNING by a stopped worker is closed as FAILED and its staging rows are discarded. */
    private void recoverInterrupted() {
        tx.executeWithoutResult(s -> {
            jdbc.sql("delete from hr_unit where snapshot_id in (select id from hr_snapshot where status = 'STAGING')").update();
            jdbc.sql("delete from hr_person where snapshot_id in (select id from hr_snapshot where status = 'STAGING')").update();
            jdbc.sql("update hr_snapshot set status = 'DISCARDED' where status = 'STAGING'").update();
            jdbc.sql("""
                    update hr_sync_run set status = 'FAILED', finished_at = :now, error_code = 'INTERRUPTED',
                           error_message = 'توقف العامل أثناء التشغيل؛ بقيت آخر نسخة منشورة سارية.'
                    where status = 'RUNNING'""").param("now", Db.ts(clock.instant())).update();
        });
    }

    record Source(UUID id, String name, Map<String, Object> row) {
    }

    private void execute(UUID runId, String trigger, UUID requestedBy, String overrideReason) {
        Instant started = clock.instant();
        Instant deadline = started.plus(Duration.ofSeconds(props.maxRunSeconds()));
        Map<String, Object> src = jdbc.sql("select * from hr_source where enabled order by created_at limit 1").query().listOfRows()
                .stream().findFirst().orElse(null);
        if (src == null) {
            finish(runId, trigger, requestedBy, null, null, started, "FAILED", "HR_SOURCE_NOT_CONFIGURED",
                    "لم يُهيأ مصدر الموارد البشرية.", Map.of(), overrideReason, null);
            return;
        }
        UUID sourceId = (UUID) src.get("id");
        Map<String, Object> mapping = jdbc.sql("""
                select id, version, fields::text as fields, active_rules::text as rules from hr_mapping_version
                where source_id = :s and status = 'PUBLISHED'""").param("s", sourceId).query().listOfRows().stream().findFirst().orElse(null);
        if (mapping == null) {
            finish(runId, trigger, requestedBy, sourceId, null, started, "FAILED", "HR_MAPPING_NOT_PUBLISHED",
                    "لا يوجد إصدار تعيين منشور لمصدر الموارد البشرية.", Map.of(), overrideReason, null);
            return;
        }
        UUID mappingId = (UUID) mapping.get("id");
        jdbc.sql("""
                insert into hr_sync_run(id, source_id, mapping_version_id, trigger, requested_by, status, started_at, override_reason)
                values (:id, :s, :m, :t, :by, 'RUNNING', :now, :o)""")
                .param("id", runId).param("s", sourceId).param("m", mappingId).param("t", trigger).param("by", requestedBy)
                .param("now", Db.ts(started)).param("o", blankToNull(overrideReason)).update();
        UUID snapshot = UUID.randomUUID();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status) values (:id, :r, :m, 'STAGING')")
                .param("id", snapshot).param("r", runId).param("m", mappingId).update();
        Map<String, Object> counts = new LinkedHashMap<>();
        try {
            HrMapping.Definition def = definition((String) mapping.get("fields"), (String) mapping.get("rules"));
            HrSourceAdapter.Config cfg = config(src);
            int[] dup = new int[2];
            int[] skipped = new int[2];
            try (HrSourceAdapter.Session session = adapter.open(cfg)) {
                Map<Entity, List<String>> discovered = new EnumMap<>(Entity.class);
                discovered.put(Entity.UNIT, session.columns(cfg.unitView()));
                discovered.put(Entity.PERSON, session.columns(cfg.personView()));
                HrMapping.Compiled compiled = HrMapping.compile(def, discovered);
                counts.put("sourceVersion", session.databaseVersion());
                session.stream(cfg.unitView(), compiled.columns(Entity.UNIT), props.fetchSize(), props.insertBatch(), rows -> {
                    checkDeadline(deadline);
                    insertUnits(runId, snapshot, compiled, rows, dup, skipped);
                });
                session.stream(cfg.personView(), compiled.columns(Entity.PERSON), props.fetchSize(), props.insertBatch(), rows -> {
                    checkDeadline(deadline);
                    insertPeople(runId, snapshot, compiled, rows, dup, skipped);
                });
                counts.put("statements", session.statements().size());
            }
            counts.put("duplicateUnitKeys", dup[0]);
            counts.put("duplicatePersonKeys", dup[1]);
            counts.put("skippedUnits", skipped[0]);
            counts.put("skippedPeople", skipped[1]);
            if (dup[0] + dup[1] > 0) {
                throw new Rejection("DUPLICATE_KEYS", "المصدر أعاد معرفات مكررة؛ لا يمكن تحديد السجل الصحيح فرُفضت النتيجة.");
            }
            Set<String> cycles = validate(runId, snapshot, counts);
            protect(snapshot, src, counts, trigger, overrideReason);
            HrProjection.Result result = tx.execute(s -> publish(snapshot, cycles));
            counts.putAll(result.asMap());
            jdbc.sql("update hr_source set last_success_at = :now, updated_at = :now where id = :id")
                    .param("now", Db.ts(clock.instant())).param("id", sourceId).update();
            finish(runId, trigger, requestedBy, sourceId, mappingId, started, "SUCCEEDED", null, null, counts, overrideReason, snapshot);
            retain();
        } catch (Rejection r) {
            discard(snapshot);
            finish(runId, trigger, requestedBy, sourceId, mappingId, started, "REJECTED", r.code, r.getMessage(), counts, overrideReason, null);
        } catch (HrMapping.ContractException e) {
            discard(snapshot);
            finish(runId, trigger, requestedBy, sourceId, mappingId, started, "REJECTED", "HR_CONTRACT_MISMATCH",
                    "تعيين الأعمدة لا يطابق بيانات المصدر: " + e.getMessage(), counts, overrideReason, null);
        } catch (HrSourceAdapter.SourceException e) {
            discard(snapshot);
            finish(runId, trigger, requestedBy, sourceId, mappingId, started, "FAILED", "SOURCE_" + e.failure().name(),
                    e.getMessage(), counts, overrideReason, null);
        } catch (ApiException e) {
            discard(snapshot);
            finish(runId, trigger, requestedBy, sourceId, mappingId, started, "FAILED", e.code().name(), e.getMessage(), counts,
                    overrideReason, null);
        } catch (RuntimeException e) {
            log.error("HR sync failed", e);
            discard(snapshot);
            finish(runId, trigger, requestedBy, sourceId, mappingId, started, "FAILED", "ERROR",
                    "خطأ داخلي أثناء المزامنة؛ بقيت آخر نسخة منشورة سارية.", counts, overrideReason, null);
        }
    }

    private void checkDeadline(Instant deadline) {
        if (clock.instant().isAfter(deadline)) {
            throw new Rejection("MAX_RUN_TIME", "تجاوز التشغيل المدة القصوى المسموحة؛ أُوقف دون نشر.");
        }
    }

    static final class Rejection extends RuntimeException {
        final String code;

        Rejection(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    HrMapping.Definition definition(String fields, String rules) {
        List<HrMapping.Field> fs = new ArrayList<>();
        for (JsonNode f : json.tree(fields)) {
            List<String> alts = new ArrayList<>();
            f.path("alternates").forEach(a -> alts.add(a.asText()));
            fs.add(new HrMapping.Field(Entity.valueOf(f.path("entity").asText()), f.path("field").asText(),
                    f.path("column").asText(null), f.path("transform").asText("none"), alts, f.path("enabled").asBoolean(true)));
        }
        Map<Entity, HrMapping.Rule> rs = new EnumMap<>(Entity.class);
        JsonNode r = json.tree(rules);
        for (Entity e : Entity.values()) {
            JsonNode n = r.path(e.name());
            if (!n.isMissingNode()) {
                List<String> values = new ArrayList<>();
                n.path("values").forEach(v -> values.add(v.asText()));
                rs.put(e, new HrMapping.Rule(n.path("column").asText(null), n.path("operator").asText("EQUALS"), values));
            }
        }
        return new HrMapping.Definition(fs, rs);
    }

    HrSourceAdapter.Config config(Map<String, Object> src) {
        JsonNode s = json.tree(cipher.decrypt((String) src.get("settings_ciphertext"), (String) src.get("settings_key_id")));
        return new HrSourceAdapter.Config(s.path("hostOrUrl").asText(), s.path("port").asInt(1521), s.path("serverName").asText(),
                s.path("nameType").asText("service_name"), s.path("username").asText(), s.path("password").asText(),
                (String) src.get("unit_view"), (String) src.get("person_view"),
                ((Number) src.get("connect_timeout_s")).intValue(), ((Number) src.get("call_timeout_ms")).intValue());
    }

    // ---- staging ----------------------------------------------------------------------------------------------

    private void insertUnits(UUID runId, UUID snapshot, HrMapping.Compiled c, List<Map<String, Object>> rows, int[] dup, int[] skipped) {
        List<Object[]> args = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Map<String, String> v = c.convert(Entity.UNIT, row);
            if (v.get("external_unit_id") == null || v.get("name") == null) {
                skipped[0]++;
                issue(runId, "MISSING_KEY", "UNIT", v.get("external_unit_id"), "سجل جهة دون معرف أو اسم؛ لم يُستورد.");
                continue;
            }
            args.add(new Object[]{snapshot, v.get("external_unit_id"), v.get("code"), v.get("name"), v.get("name_en"),
                    v.get("parent_external_unit_id"), v.get("status"), Boolean.parseBoolean(v.get("active")), integer(v.get("level"))});
        }
        int[] done = batch.batchUpdate("""
                insert into hr_unit(snapshot_id, external_id, code, name, name_en, parent_external_id, status_raw, active, level)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing""", args);
        for (int i = 0; i < done.length; i++) {
            if (done[i] == 0) {
                dup[0]++;
                issue(runId, "DUPLICATE_KEY", "UNIT", (String) args.get(i)[1], "معرف جهة مكرر في المصدر.");
            }
        }
    }

    private void insertPeople(UUID runId, UUID snapshot, HrMapping.Compiled c, List<Map<String, Object>> rows, int[] dup, int[] skipped) {
        List<Object[]> args = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Map<String, String> v = c.convert(Entity.PERSON, row);
            if (v.get("external_person_id") == null || v.get("full_name") == null || v.get("employee_number") == null) {
                skipped[1]++;
                issue(runId, "MISSING_KEY", "PERSON", v.get("external_person_id"), "سجل شخص دون معرف أو اسم أو رقم وظيفي؛ لم يُستورد.");
                continue;
            }
            args.add(new Object[]{snapshot, v.get("external_person_id"), v.get("employee_number"), v.get("legacy_employee_number"),
                    v.get("domain_account"), v.get("full_name"), v.get("unit_external_id"), v.get("position_id"), v.get("position"),
                    v.get("job"), v.get("status_text"), Boolean.parseBoolean(v.get("active"))});
        }
        int[] done = batch.batchUpdate("""
                insert into hr_person(snapshot_id, external_id, employee_number, legacy_employee_number, domain_account, full_name,
                                      unit_external_id, position_id, position_title, job_title, status_text, active)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing""", args);
        for (int i = 0; i < done.length; i++) {
            if (done[i] == 0) {
                dup[1]++;
                issue(runId, "DUPLICATE_KEY", "PERSON", (String) args.get(i)[1], "معرف شخص مكرر في المصدر.");
            }
        }
    }

    private static Integer integer(String s) {
        try {
            return s == null ? null : (int) Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private final Map<UUID, Integer> issueCounts = new java.util.concurrent.ConcurrentHashMap<>();

    private void issue(UUID runId, String kind, String entity, String externalId, String detail) {
        if (issueCounts.merge(runId, 1, Integer::sum) > MAX_ISSUES) {
            return;
        }
        jdbc.sql("insert into hr_sync_issue(run_id, kind, entity, external_id, detail) values (:r, :k, :e, :x, :d)")
                .param("r", runId).param("k", kind).param("e", entity).param("x", externalId).param("d", detail).update();
    }

    // ---- validation and protection -----------------------------------------------------------------------------

    /** Records orphans, cycles, unknown units and ambiguous employee numbers; returns the units on parent cycles. */
    private Set<String> validate(UUID runId, UUID snapshot, Map<String, Object> counts) {
        Map<String, Object> n = jdbc.sql("""
                select (select count(*) from hr_unit where snapshot_id = :s) as units,
                       (select count(*) from hr_unit where snapshot_id = :s and active) as active_units,
                       (select count(*) from hr_person where snapshot_id = :s) as people,
                       (select count(*) from hr_person where snapshot_id = :s and active) as active_people""")
                .param("s", snapshot).query().singleRow();
        counts.put("units", ((Number) n.get("units")).intValue());
        counts.put("activeUnits", ((Number) n.get("active_units")).intValue());
        counts.put("people", ((Number) n.get("people")).intValue());
        counts.put("activePeople", ((Number) n.get("active_people")).intValue());
        List<String> orphans = jdbc.sql("""
                select u.external_id from hr_unit u where u.snapshot_id = :s and u.parent_external_id is not null
                  and not exists (select 1 from hr_unit p where p.snapshot_id = :s and p.external_id = u.parent_external_id)""")
                .param("s", snapshot).query(String.class).list();
        orphans.forEach(o -> issue(runId, "ORPHAN_UNIT", "UNIT", o, "الجهة الأم غير موجودة في المصدر؛ عُرضت الجهة جذراً."));
        Set<String> cycles = new HashSet<>(jdbc.sql("""
                with recursive walk(start_id, id, depth) as (
                  select external_id, parent_external_id, 1 from hr_unit where snapshot_id = :s and parent_external_id is not null
                  union all
                  select w.start_id, u.parent_external_id, w.depth + 1 from walk w
                  join hr_unit u on u.snapshot_id = :s and u.external_id = w.id
                  where u.parent_external_id is not null and w.depth < 64 and w.id <> w.start_id)
                select distinct start_id from walk where id = start_id""")
                .param("s", snapshot).query(String.class).list());
        cycles.forEach(c -> issue(runId, "CYCLE", "UNIT", c, "الجهة ضمن دورة في شجرة المصدر؛ عُرضت جذراً حتى يُصحح المصدر."));
        int unknown = jdbc.sql("""
                select count(*) from hr_person h where h.snapshot_id = :s and h.unit_external_id is not null
                  and not exists (select 1 from hr_unit u where u.snapshot_id = :s and u.external_id = h.unit_external_id)""")
                .param("s", snapshot).query(Integer.class).single();
        List<String> ambiguous = jdbc.sql("""
                select external_id from hr_person h where h.snapshot_id = :s
                  and (select count(*) from hr_person d where d.snapshot_id = :s and d.employee_number = h.employee_number) > 1""")
                .param("s", snapshot).query(String.class).list();
        ambiguous.forEach(a -> issue(runId, "DUPLICATE_NUMBER", "PERSON", a,
                "الرقم الوظيفي مشترك بين أكثر من سجل؛ لن يُربط آلياً ويحتاج معالجة مخولة."));
        counts.put("orphanUnits", orphans.size());
        counts.put("cycleUnits", cycles.size());
        counts.put("peopleWithUnknownUnit", unknown);
        counts.put("ambiguousEmployeeNumbers", ambiguous.size());
        jdbc.sql("""
                update hr_snapshot set unit_count = :u, person_count = :p, active_unit_count = :au, active_person_count = :ap
                where id = :id""").param("u", counts.get("units")).param("p", counts.get("people"))
                .param("au", counts.get("activeUnits")).param("ap", counts.get("activePeople")).param("id", snapshot).update();
        return cycles;
    }

    private void protect(UUID snapshot, Map<String, Object> src, Map<String, Object> counts, String trigger, String overrideReason) {
        if ((int) counts.get("units") == 0 || (int) counts.get("people") == 0) {
            throw new Rejection("EMPTY_SOURCE", "أعاد المصدر نتيجة فارغة؛ لا تُنشر أبداً وبقيت آخر نسخة صالحة.");
        }
        Map<String, Object> prev = jdbc.sql("select * from hr_snapshot where status = 'PUBLISHED'").query().listOfRows()
                .stream().findFirst().orElse(null);
        if (prev == null) {
            return;
        }
        int pct = ((Number) src.get("drop_percent")).intValue();
        int min = ((Number) src.get("drop_minimum")).intValue();
        List<String> drops = new ArrayList<>();
        check(drops, "الجهات", prev.get("unit_count"), counts.get("units"), pct, min);
        check(drops, "الأشخاص", prev.get("person_count"), counts.get("people"), pct, min);
        check(drops, "الجهات النشطة", prev.get("active_unit_count"), counts.get("activeUnits"), pct, min);
        check(drops, "الأشخاص النشطون", prev.get("active_person_count"), counts.get("activePeople"), pct, min);
        if (drops.isEmpty()) {
            return;
        }
        counts.put("drops", drops);
        String reason = blankToNull(overrideReason);
        if (!"MANUAL".equals(trigger) || reason == null || reason.length() < 10) {
            throw new Rejection("LARGE_DROP", "انخفاض غير مفسر في أعداد المصدر (" + String.join("، ", drops)
                    + ")؛ بقيت آخر نسخة صالحة. يمكن لمدير مخول إعادة التشغيل يدوياً مع ذكر السبب.");
        }
        audit.system("HR_SYNC_OVERRIDE_USED", "HR_SNAPSHOT", snapshot.toString(), null, Map.of("drops", drops, "reason", reason));
    }

    private static void check(List<String> drops, String label, Object before, Object after, int pct, int min) {
        int b = ((Number) before).intValue();
        int a = ((Number) after).intValue();
        int allowed = Math.max((int) Math.floor(b * pct / 100.0), min);
        if (b - a > allowed) {
            drops.add(label + " " + b + " → " + a);
        }
    }

    // ---- publish ----------------------------------------------------------------------------------------------

    private HrProjection.Result publish(UUID snapshot, Set<String> cycles) {
        Instant now = clock.instant();
        jdbc.sql("update hr_snapshot set status = 'SUPERSEDED' where status = 'PUBLISHED'").update();
        jdbc.sql("update hr_snapshot set status = 'PUBLISHED', published_at = :now where id = :id")
                .param("now", Db.ts(now)).param("id", snapshot).update();
        return projection.apply(snapshot, cycles);
    }

    private void discard(UUID snapshot) {
        tx.executeWithoutResult(s -> {
            jdbc.sql("delete from hr_unit where snapshot_id = :s").param("s", snapshot).update();
            jdbc.sql("delete from hr_person where snapshot_id = :s").param("s", snapshot).update();
            jdbc.sql("update hr_snapshot set status = 'DISCARDED' where id = :s and status = 'STAGING'").param("s", snapshot).update();
        });
    }

    /** Keeps the published snapshot and the most recent superseded ones; older mirror rows are removed. */
    private void retain() {
        List<UUID> old = jdbc.sql("""
                select id from hr_snapshot where status in ('SUPERSEDED', 'DISCARDED')
                order by created_at desc offset :keep""").param("keep", Math.max(0, props.retainSnapshots() - 1))
                .query(UUID.class).list();
        for (UUID id : old) {
            tx.executeWithoutResult(s -> {
                jdbc.sql("delete from hr_unit where snapshot_id = :s").param("s", id).update();
                jdbc.sql("delete from hr_person where snapshot_id = :s").param("s", id).update();
            });
        }
    }

    private void recordSkipped(UUID runId, String trigger, UUID requestedBy, String message) {
        Instant now = clock.instant();
        jdbc.sql("""
                insert into hr_sync_run(id, trigger, requested_by, status, started_at, finished_at, error_code, error_message)
                values (:id, :t, :by, 'SKIPPED', :now, :now, 'RUN_IN_PROGRESS', :m)""")
                .param("id", runId).param("t", trigger).param("by", requestedBy).param("now", Db.ts(now))
                .param("m", message).update();
    }

    private void finish(UUID runId, String trigger, UUID requestedBy, UUID sourceId, UUID mappingId, Instant started, String status,
                        String code, String message, Map<String, Object> counts, String overrideReason, UUID snapshot) {
        Instant now = clock.instant();
        counts.put("durationMs", Duration.between(started, now).toMillis());
        int n = jdbc.sql("""
                update hr_sync_run set status = :st, finished_at = :now, counts = cast(:c as jsonb), error_code = :code,
                       error_message = :msg, snapshot_id = :snap where id = :id""")
                .param("st", status).param("now", Db.ts(now)).param("c", json.write(counts)).param("code", code)
                .param("msg", message).param("snap", snapshot).param("id", runId).update();
        if (n == 0) {
            jdbc.sql("""
                    insert into hr_sync_run(id, source_id, mapping_version_id, trigger, requested_by, status, started_at, finished_at,
                                            counts, error_code, error_message, override_reason)
                    values (:id, :s, :m, :t, :by, :st, :start, :now, cast(:c as jsonb), :code, :msg, :o)""")
                    .param("id", runId).param("s", sourceId).param("m", mappingId).param("t", trigger).param("by", requestedBy)
                    .param("st", status).param("start", Db.ts(started)).param("now", Db.ts(now)).param("c", json.write(counts))
                    .param("code", code).param("msg", message).param("o", blankToNull(overrideReason)).update();
        }
        issueCounts.remove(runId);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("status", status);
        detail.put("trigger", trigger);
        if (code != null) {
            detail.put("code", code);
        }
        audit.system("SUCCEEDED".equals(status) ? "HR_SYNC_COMPLETED" : "HR_SYNC_" + status, "HR_SYNC_RUN", runId.toString(), null, detail);
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
