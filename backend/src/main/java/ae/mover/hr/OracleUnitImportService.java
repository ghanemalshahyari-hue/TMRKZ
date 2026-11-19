package ae.mover.hr;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;

/** An explicitly authorised, file-based Oracle-unit replacement. This is not a live Oracle connection or a person sync. */
@Service
public class OracleUnitImportService {

    private static final Logger LOG = LoggerFactory.getLogger(OracleUnitImportService.class);
    private static final java.time.Duration PREVIEW_TTL = java.time.Duration.ofMinutes(30);
    private static final int BATCH = 1000;

    private final JdbcClient jdbc;
    private final JdbcTemplate batch;
    private final TransactionTemplate tx;
    private final Clock clock;
    private final Json json;
    private final OracleUnitPayload files;
    private final HrProjection projection;
    private final AuditService audit;
    private final ApplicationEventPublisher events;

    public OracleUnitImportService(JdbcClient jdbc, JdbcTemplate batch, TransactionTemplate tx, Clock clock, Json json,
                                   OracleUnitPayload files, HrProjection projection, AuditService audit,
                                   ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.batch = batch;
        this.tx = tx;
        this.clock = clock;
        this.json = json;
        this.files = files;
        this.projection = projection;
        this.audit = audit;
        this.events = events;
    }

    public record Input(String storageKey, String reason) {
    }

    public record Result(String runId, String status, String sourceSyncedAtUtc, String snapshotId, Map<String, Object> effects,
                         String payloadSha256, boolean liveOracleRead) {
    }

    /** Stage units and preview only. No organization, person or current business record is changed. */
    public Result preview(AccessContext ctx, Input in) {
        require(ctx, in == null ? null : in.reason());
        OracleUnitPayload.Payload payload = files.read(in.storageKey());
        UUID runId = UUID.randomUUID();
        UUID snapshot = UUID.randomUUID();
        Instant now = clock.instant();
        Map<String, Object> result = Objects.requireNonNull(tx.execute(status -> {
            lock();
            String fingerprint = structureFingerprint();
            jdbc.sql("insert into hr_snapshot(id, origin, status) values (:id, 'ORACLE_UNIT_IMPORT', 'PREVIEWED')")
                    .param("id", snapshot).update();
            stage(snapshot, payload.units());
            Map<String, Object> effects = effects(snapshot);
            boolean valid = valid(effects);
            insertRun(runId, snapshot, payload, ctx, in.reason().trim(), fingerprint, effects, now,
                    valid ? "PREVIEWED" : "INVALID");
            audit.recordAs(ctx.actor(), "ORACLE_UNIT_IMPORT_PREVIEWED", "ORACLE_UNIT_IMPORT", runId.toString(), null,
                    Map.of("valid", valid, "sourceSyncedAtUtc", payload.syncedAtUtc(), "effects", effects), in.reason().trim());
            return Map.of("fingerprint", fingerprint, "effects", effects);
        }));
        @SuppressWarnings("unchecked")
        Map<String, Object> effects = (Map<String, Object>) result.get("effects");
        audit.recordAs(ctx.actor(), "ORACLE_UNIT_IMPORT_FILE_VALIDATED", "ORACLE_UNIT_IMPORT", runId.toString(), null,
                payload.provenance(), in.reason().trim());
        return result(runId, payload, snapshot, valid(effects) ? "PREVIEWED" : "INVALID", effects);

    }

    /** Publish a preview, never a caller-selected file or timestamp. Re-read and verify exactly the staged private bytes. */
    public Result commit(AccessContext ctx, UUID runId) {
        checkpoint("commit-service-entered");
        ctx.require(Permission.CONFIGURE);
        try {
            Committed committed = Objects.requireNonNull(tx.execute(status -> commitLocked(ctx, runId)));
            if (committed.publishEvent()) {
                events.publishEvent(new HrSnapshotPublished(committed.snapshot()));
            }
            return committed.result();
        } catch (RuntimeException e) {
            String state = e instanceof org.springframework.dao.DataAccessException db
                    ? String.valueOf(e.getClass().getSimpleName() + "/" + e.getClass().getName()) : e.getClass().getSimpleName();
            LOG.error("Oracle unit publication failed: {}", state);
            throw e;
        }
    }

    private record Committed(UUID snapshot, Result result, boolean publishEvent) {
    }

    private static void checkpoint(String phase) {
        LOG.info("Oracle unit publication: {}", phase);
    }

    private Committed commitLocked(AccessContext ctx, UUID runId) {
        lock();
        Map<String, Object> run = jdbc.sql("""
                select * from oracle_unit_import_run where id = :id for update""").param("id", runId)
                .query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        String state = (String) run.get("status");
        if ("PUBLISHED".equals(state)) {
            UUID snapshot = uuid(run, "snapshot_id");
            return new Committed(snapshot, result(runId, run, snapshot,
                    mapNumbers(run.get("actual") == null ? run.get("expected") : run.get("actual")), true), false);
        }
        if (!"PREVIEWED".equals(state)) {
            throw invalid("UNIT_IMPORT_NOT_PREVIEWED", "لا يمكن نشر هذه الدفعة؛ أعد معاينة ملف صالح.");
        }
        if (Db.toInstant(run.get("preview_expires_at")).isBefore(clock.instant())) {
            throw invalid("UNIT_IMPORT_EXPIRED", "انتهت صلاحية معاينة الجهات؛ أعد المعاينة.");
        }
        UUID snapshot = uuid(run, "snapshot_id");
        OracleUnitPayload.Payload payload = files.read((String) run.get("storage_key"));
        checkpoint("source-read");
        if (!payload.sha256().equals(run.get("payload_sha256")) || payload.size() != ((Number) run.get("payload_size")).longValue()
                || !payload.schemaVersion().equals(run.get("schema_version"))
                || !payload.syncedAt().equals(Db.toInstant(run.get("source_synced_at")))
                || !json.tree(payload.sourceContract()).equals(json.tree(String.valueOf(run.get("source_contract"))))) {
            throw invalid("UNIT_IMPORT_PAYLOAD_CHANGED", "تغير ملف الجهات بعد المعاينة؛ أعد المعاينة على أحدث ملف.");
        }
        String fingerprint = structureFingerprint();
        checkpoint("source-metadata-verified");
        if (!fingerprint.equals(run.get("structure_fingerprint"))) {
            throw invalid("UNIT_IMPORT_STALE", "تغير الهيكل التنظيمي بعد المعاينة؛ لن تُكتب فوق تغيير أحدث.");
        }
        Map<String, Object> expected = effects(snapshot);
        checkpoint("structure-fingerprint-verified");
        if (!expected.equals(mapNumbers(run.get("expected")))) {
            throw invalid("UNIT_IMPORT_EFFECTS_CHANGED", "تغيرت آثار الدفعة منذ المعاينة؛ أعد المعاينة.");
        }
        if (!valid(expected)) {
            throw invalid("UNIT_IMPORT_UNSAFE", "لا يمكن نشر دفعة ذات تصادمات أو أعمال جارية غير معالجة.");
        }
        stageCheck(snapshot, payload.units());
        checkpoint("effects-and-staged-fields-verified");
        Map<String, Object> previous = jdbc.sql("""
                select * from hr_snapshot where status = 'PUBLISHED'""").query().listOfRows().stream().findFirst().orElse(null);
        List<UUID> retiring = retiring(snapshot);
        Instant now = clock.instant();

        // Preserve the person mirror byte-for-byte in meaning, with its own explicit lineage. No person projection is called.
        if (previous != null) {
            UUID from = uuid(previous, "id");
            jdbc.sql("""
                    insert into hr_person(snapshot_id, external_id, employee_number, legacy_employee_number, domain_account,
                                          full_name, unit_external_id, position_id, position_title, job_title, status_text, active,
                                          leave_status, rank_name)
                    select :to, external_id, employee_number, legacy_employee_number, domain_account, full_name, unit_external_id,
                           position_id, position_title, job_title, status_text, active, leave_status, rank_name
                    from hr_person where snapshot_id = :from""").param("to", snapshot).param("from", from).update();
            jdbc.sql("""
                    insert into hr_snapshot_scope(snapshot_id, external_id)
                    select :to, external_id from hr_snapshot_scope where snapshot_id = :from""")
                    .param("to", snapshot).param("from", from).update();
            jdbc.sql("""
                    update hr_snapshot set person_count = :p, active_person_count = :a where id = :id""")
                    .param("p", previous.get("person_count")).param("a", previous.get("active_person_count"))
                    .param("id", snapshot).update();
        }
        checkpoint("person-mirror-carried");
        jdbc.sql("update hr_snapshot set unit_count = :u, active_unit_count = :a where id = :s")
                .param("u", payload.units().size()).param("a", payload.units().stream().filter(OracleUnitPayload.Unit::active).count())
                .param("s", snapshot).update();

        HrProjection.OrganizationResult organizations = projection.applyOrganizations(snapshot, Set.of(), true);
        checkpoint("organizations-projected");
        int membershipsEnded = endMemberships(retiring, now);
        int responsibilitiesClosed = closeResponsibilities(retiring, now);
        checkpoint("memberships-and-responsibilities-closed");
        jdbc.sql("update hr_snapshot set status = 'SUPERSEDED' where status = 'PUBLISHED'").update();
        jdbc.sql("update hr_snapshot set status = 'PUBLISHED', published_at = :now where id = :id and status = 'PREVIEWED'")
                .param("now", Db.ts(now)).param("id", snapshot).update();
        Map<String, Object> actual = new LinkedHashMap<>(expected);
        actual.put("organizationsCreated", organizations.created());
        actual.put("organizationsUpdated", organizations.updated());
        actual.put("organizationsRetired", retiring.size());
        actual.put("membershipsEnded", membershipsEnded);
        actual.put("responsibilitiesClosed", responsibilitiesClosed);
        if (organizations.created() != number(expected, "created") || organizations.updated() != number(expected, "updated")
                || retiring.size() != number(expected, "retired")
                || membershipsEnded != number(expected, "membershipsEnding")
                || responsibilitiesClosed != number(expected, "responsibilitiesClosing")) {
            throw invalid("UNIT_IMPORT_EFFECT_MISMATCH", "نتيجة الإسقاط لا تطابق المعاينة؛ التراجع عن الدفعة كاملة.");
        }
        UUID carried = previous == null ? null : uuid(previous, "id");
        jdbc.sql("""
                update oracle_unit_import_run set status = 'PUBLISHED', committed_by = :by, committed_at = :now,
                       actual = cast(:actual as jsonb), carried_person_snapshot_id = :carried where id = :id""")
                .param("by", ctx.personId()).param("now", Db.ts(now)).param("actual", json.write(actual))
                .param("carried", carried).param("id", runId).update();
        assertPublishedOracleOnly(snapshot);
        checkpoint("oracle-active-only-verified");
        audit.recordAs(ctx.actor(), "ORACLE_UNIT_IMPORT_PUBLISHED", "ORACLE_UNIT_IMPORT", runId.toString(), null, actual,
                (String) run.get("reason"));
        return new Committed(snapshot, result(runId, payload, snapshot, "PUBLISHED", actual), true);
    }

    private void stage(UUID snapshot, List<OracleUnitPayload.Unit> units) {
        for (int start = 0; start < units.size(); start += BATCH) {
            List<OracleUnitPayload.Unit> part = units.subList(start, Math.min(units.size(), start + BATCH));
            List<Object[]> args = new ArrayList<>(part.size());
            for (OracleUnitPayload.Unit u : part) {
                args.add(new Object[]{snapshot, u.externalId(), u.code(), u.name(), null, u.parentExternalId(), u.status(), u.active(),
                        u.level(), u.main(), u.mainExternalId()});
            }
            batch.batchUpdate("""
                    insert into hr_unit(snapshot_id, external_id, code, name, name_en, parent_external_id, status_raw, active, level,
                                        is_main, main_external_id)
                    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", args);
        }
        jdbc.sql("analyze hr_unit").update();
        jdbc.sql("update hr_snapshot set unit_count = :u, active_unit_count = :a where id = :s")
                .param("u", units.size()).param("a", units.stream().filter(OracleUnitPayload.Unit::active).count())
                .param("s", snapshot).update();
    }

    private void stageCheck(UUID snapshot, List<OracleUnitPayload.Unit> units) {
        Map<String, Object> counts = jdbc.sql("""
                select count(*) as total, count(*) filter (where active) as active from hr_unit where snapshot_id = :s""")
                .param("s", snapshot).query().singleRow();
        if (((Number) counts.get("total")).longValue() != units.size()
                || ((Number) counts.get("active")).longValue() != units.stream().filter(OracleUnitPayload.Unit::active).count()) {
            throw invalid("UNIT_IMPORT_STAGING_CHANGED", "تغيرت بيانات المعاينة المخزنة؛ أعد المعاينة.");
        }
        for (int start = 0; start < units.size(); start += BATCH) {
            List<OracleUnitPayload.Unit> part = units.subList(start, Math.min(units.size(), start + BATCH));
            StringBuilder values = new StringBuilder();
            Map<String, Object> params = new HashMap<>();
            params.put("s", snapshot);
            for (int i = 0; i < part.size(); i++) {
                OracleUnitPayload.Unit u = part.get(i);
                values.append(i == 0 ? "" : ",").append("(:id").append(i).append(",:code").append(i)
                        .append(",:name").append(i).append(",:parent").append(i).append(",:raw").append(i)
                        .append(",:active").append(i).append(",:level").append(i).append(",:main").append(i)
                        .append(",:mainid").append(i).append(")");
                params.put("id" + i, u.externalId());
                params.put("code" + i, u.code());
                params.put("name" + i, u.name());
                params.put("parent" + i, u.parentExternalId());
                params.put("raw" + i, u.status());
                params.put("active" + i, u.active());
                params.put("level" + i, u.level());
                params.put("main" + i, u.main());
                params.put("mainid" + i, u.mainExternalId());
            }
            Integer different = jdbcClientValues("select count(*) from (values" + values + ") v(external_id,code,name,parent_external_id,"
                    + "status_raw,active,level,is_main,main_external_id) "
                    + "where not exists (select 1 from hr_unit h where h.snapshot_id = :s and h.external_id = v.external_id "
                    + "and h.code = v.code and h.name = v.name and h.parent_external_id is not distinct from v.parent_external_id "
                    + "and h.status_raw = v.status_raw and h.active = v.active and h.level = v.level and h.is_main = v.is_main "
                    + "and h.main_external_id is not distinct from v.main_external_id)", params);
            if (different != 0) {
                throw invalid("UNIT_IMPORT_STAGING_CHANGED", "تغيرت بيانات المعاينة المخزنة؛ أعد المعاينة.");
            }
        }
    }

    private int jdbcClientValues(String sql, Map<String, Object> params) {
        return jdbc.sql(sql).params(params).query(Integer.class).single();
    }

    /** A preview/evaluated projection of one snapshot, with effects counted but no source IDs exposed. */
    private Map<String, Object> effects(UUID snapshot) {
        String retired = """
                select o.id from organization o where o.status = 'ACTIVE' and (
                  (o.source = 'HR' and not exists(select 1 from hr_unit h where h.snapshot_id = :s
                                                    and h.external_id = o.source_external_id and h.active))
                  or (o.source = 'LOCAL' and not exists(select 1 from hr_unit h where h.snapshot_id = :s
                                                        and h.external_id = o.source_external_id and h.active)))""";
        Map<String, Object> n = jdbc.sql("""
                with incoming as (select * from hr_unit where snapshot_id = :s), retiring as (%s)
                select (select count(*) from incoming) as units,
                       (select count(*) from incoming where active) as active_units,
                       (select count(*) from incoming h where not exists(select 1 from organization o where o.source = 'HR'
                            and o.source_external_id = h.external_id)
                          and not exists(select 1 from organization o where o.source = 'LOCAL'
                            and o.source_external_id = h.external_id)) as created,
                       (select count(*) from organization o join incoming h on h.external_id = o.source_external_id
                          where o.source = 'LOCAL' and not exists(select 1 from organization x where x.source = 'HR'
                            and x.source_external_id = h.external_id)) as adopted,
                       (select count(*) from organization o where o.id in (select id from retiring) and o.source = 'LOCAL') as local_retired,
                       (select count(*) from retiring) as retired,
                       (select count(*) from organization o join incoming h on h.external_id = o.source_external_id
                          where o.source = 'HR' and (o.name <> h.name or o.status <> case when h.active then 'ACTIVE' else 'RETIRED' end))
                         + (select count(*) from organization o join incoming h on h.external_id = o.source_external_id
                            where o.source = 'LOCAL' and not exists(select 1 from organization x where x.source = 'HR'
                              and x.source_external_id = h.external_id)) as updated,
                       (select count(*) from organization o join incoming h on h.external_id = o.source_external_id
                           left join organization p on p.id = o.parent_id
                          where coalesce(p.source_external_id, '') is distinct from coalesce(h.parent_external_id, '')
                            and (o.source = 'HR' or o.source = 'LOCAL')) as reparented,
                       (select count(*) from membership m join retiring r on r.id = m.organization_id
                          where m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) as memberships_ending,
                       (select count(distinct m.person_id) from membership m join retiring r on r.id = m.organization_id
                          join role_def d on d.code = m.role_code and 'CONFIGURE' = any(d.permissions)
                          where m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) as configure_people_affected,
                       (select count(distinct m.person_id) from membership m join retiring r on r.id = m.organization_id
                          join role_def d on d.code = m.role_code and 'MANAGE_ACCESS' = any(d.permissions)
                          where m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) as access_managers_affected,
                       (select count(*) from site_responsibility sr join retiring r on r.id = sr.organization_id
                          where sr.valid_to is null and sr.valid_from <= now()) as responsibilities_closing,
                       (select count(*) from affiliation a join retiring r on r.id = a.organization_id
                          where a.valid_to is null) as affiliations_preserved_with_retired_units,
                       (select count(*) from request q join retiring r on r.id = q.owner_org_id
                          where q.status in ('DRAFT', 'SUBMITTED', 'RETURNED')) as open_requests_affected,
                       (select count(*) from restationing_request q join retiring r on r.id = q.requesting_unit_id
                          where q.state in ('DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED',
                                            'APPROVED_NOT_ACTIVATED')) as open_restationing_affected,
                       (select count(*) from org_stationing q join retiring r on r.id = q.organization_id
                          where q.valid_to is null) as current_stationing_affected,
                       (select count(*) from incoming h join incoming p on p.external_id = h.parent_external_id
                          where h.active and not p.active) as active_children_with_retired_parents
                """.formatted(retired)).param("s", snapshot).query().singleRow();
        // a unit's code held by an organization (HR or LOCAL) that does not hold the same Unit ID, including one with none:
        // "is distinct from", so a LOCAL organization without a stored Unit ID is a collision too, never silently skipped
        Integer collisions = jdbc.sql("""
                select count(*) from hr_unit h join organization o on o.code = h.code
                where h.snapshot_id = :s and o.source_external_id is distinct from h.external_id""").param("s", snapshot)
                .query(Integer.class).single();
        Map<String, Object> out = new LinkedHashMap<>();
        n.forEach((key, value) -> out.put(camel(key), ((Number) value).longValue()));
        out.put("sourceCodeCollisions", collisions.longValue());
        // source is only ever HR or LOCAL; naming both lets the (source, source_external_id) index answer per unit
        out.put("sourceIdentityConflicts", jdbc.sql("""
                select count(*) from hr_unit h where h.snapshot_id = :s
                  and (select count(*) from organization o where o.source in ('HR', 'LOCAL')
                         and o.source_external_id = h.external_id) > 1""")
                .param("s", snapshot).query(Long.class).single());
        long unfinished = number(out, "openRequestsAffected") + number(out, "openRestationingAffected")
                + number(out, "currentStationingAffected");
        out.put("unfinishedBusinessEffects", unfinished);
        out.put("peopleImported", 0L);
        return out;
    }

    private List<UUID> retiring(UUID snapshot) {
        return jdbc.sql("""
                select o.id from organization o where o.status = 'ACTIVE' and (
                  (o.source = 'HR' and not exists(select 1 from hr_unit h where h.snapshot_id = :s
                                                    and h.external_id = o.source_external_id and h.active))
                  or (o.source = 'LOCAL' and not exists(select 1 from hr_unit h where h.snapshot_id = :s
                                                        and h.external_id = o.source_external_id and h.active)))""")
                .param("s", snapshot).query(UUID.class).list();
    }

    private int endMemberships(List<UUID> ids, Instant now) {
        if (ids.isEmpty()) {
            return 0;
        }
        return jdbc.sql("""
                update membership set valid_to = greatest(:now, valid_from + interval '1 second'),
                       ended_reason = 'ORACLE_UNIT_REPLACED'
                where organization_id = any(string_to_array(:ids, ',')::uuid[])
                  and valid_from <= :now and (valid_to is null or valid_to > :now)""")
                .param("ids", Db.ids(ids)).param("now", Db.ts(now)).update();
    }

    private int closeResponsibilities(List<UUID> ids, Instant now) {
        if (ids.isEmpty()) {
            return 0;
        }
        return jdbc.sql("""
                update site_responsibility set valid_to = :now
                where organization_id = any(string_to_array(:ids, ',')::uuid[]) and valid_to is null
                  and valid_from <= :now""")
                .param("ids", Db.ids(ids)).param("now", Db.ts(now)).update();
    }

    private void assertPublishedOracleOnly(UUID snapshot) {
        Map<String, Object> result = jdbc.sql("""
                select count(*) filter (where o.status = 'ACTIVE') as active,
                       count(*) filter (where o.status = 'ACTIVE' and o.source <> 'HR') as local_active,
                       count(*) filter (where o.status = 'ACTIVE' and not exists(
                           select 1 from hr_unit h where h.snapshot_id = :s and h.external_id = o.source_external_id and h.active))
                         as active_missing_oracle,
                       (select count(*) from hr_person where snapshot_id = :s) as people,
                       (select count(*) from hr_unit where snapshot_id = :s and active
                           and exists(select 1 from organization o where o.status = 'ACTIVE' and o.source = 'HR'
                             and o.source_external_id = hr_unit.external_id)) as linked_active
                from organization o""")
                .param("s", snapshot).query().singleRow();
        if (((Number) result.get("linked_active")).longValue() != number(result, "active")
                || ((Number) result.get("local_active")).longValue() != 0
                || ((Number) result.get("active_missing_oracle")).longValue() != 0) {
            throw invalid("UNIT_IMPORT_POSTCONDITION", "فشل تحقق: كل جهة نشطة يجب أن تكون جهة Oracle نشطة فقط.");
        }
        if (jdbc.sql("select count(*) from organization o join hr_unit h on h.snapshot_id = :s and h.external_id = o.source_external_id "
                + "where o.name <> h.name").param("s", snapshot).query(Long.class).single() != 0) {
            throw invalid("UNIT_IMPORT_POSTCONDITION", "فشل مطابقة أسماء الجهات مع المصدر.");
        }
    }

    private void insertRun(UUID id, UUID snapshot, OracleUnitPayload.Payload p, AccessContext ctx, String reason,
                           String fingerprint, Map<String, Object> expected, Instant now, String state) {
        jdbc.sql("""
                insert into oracle_unit_import_run(id, storage_key, payload_sha256, payload_size, schema_version, source_name,
                                                   source_synced_at, source_contract, structure_fingerprint, expected, snapshot_id,
                                                   previewed_by, preview_expires_at, reason, status)
                values (:id, :key, :sha, :size, :schema, :source, :synced, cast(:contract as jsonb), :fingerprint,
                        cast(:expected as jsonb), :snapshot, :by, :expiry, :reason, :status)""")
                .param("id", id).param("key", p.storageKey()).param("sha", p.sha256()).param("size", p.size())
                .param("schema", p.schemaVersion()).param("source", p.source()).param("synced", Db.ts(p.syncedAt()))
                .param("contract", p.sourceContract()).param("fingerprint", fingerprint).param("expected", json.write(expected))
                .param("snapshot", snapshot).param("by", ctx.personId()).param("expiry", Db.ts(now.plus(PREVIEW_TTL)))
                .param("reason", reason).param("status", state).update();
    }

    private Result result(UUID id, OracleUnitPayload.Payload p, UUID snapshot, String state, Map<String, Object> effects) {
        return new Result(id.toString(), state, p.syncedAtUtc(), snapshot.toString(), effects, p.sha256(), false);
    }

    private Result result(UUID id, Map<String, Object> run, UUID snapshot, Map<String, Object> effects, boolean published) {
        return new Result(id.toString(), (String) run.get("status"), java.time.format.DateTimeFormatter.ISO_INSTANT
                .format(Db.toInstant(run.get("source_synced_at"))), snapshot.toString(), effects,
                (String) run.get("payload_sha256"), false);
    }

    private static UUID uuid(Map<String, Object> row, String key) {
        Object value = row.get(key);
        return value == null ? null : value instanceof UUID id ? id : UUID.fromString(String.valueOf(value));
    }

    private String structureFingerprint() {
        return jdbc.sql("""
                select md5(coalesce(string_agg(o.id || '|' || o.source || '|' || coalesce(o.source_external_id, '') || '|'
                         || o.code || '|' || o.name || '|' || coalesce(p.id::text, '') || '|' || o.status, chr(10)
                         order by o.code, o.id), ''))
                from organization o left join organization p on p.id = o.parent_id""").query(String.class).single();
    }

    /**
     * The HR sync's advisory lock, held for this transaction only: it conflicts with a running sync's session lock (and the
     * sync's with it) and is released by commit or rollback, so a pooled connection never keeps it.
     */
    private void lock() {
        if (!jdbc.sql("select pg_try_advisory_xact_lock(" + HrSyncService.LOCK_KEY + ")").query(Boolean.class).single()) {
            throw invalid("HR_IMPORT_BUSY", "توجد مزامنة أو عملية جهات أخرى؛ أعد المحاولة بعد اكتمالها.");
        }
        checkpoint("advisory-lock-acquired");
    }

    private void require(AccessContext ctx, String reason) {
        ctx.require(Permission.CONFIGURE);
        if (reason == null || reason.trim().length() < 10) {
            throw invalid("UNIT_IMPORT_REASON", "سبب استبدال الجهات مطلوب (10 أحرف على الأقل).");
        }
    }

    private static boolean valid(Map<String, Object> effects) {
        return number(effects, "sourceCodeCollisions") == 0 && number(effects, "sourceIdentityConflicts") == 0
                && number(effects, "unfinishedBusinessEffects") == 0;
    }

    private static long number(Map<String, Object> values, String key) {
        Object n = values.get(key);
        return n instanceof Number number ? number.longValue() : Long.parseLong(String.valueOf(n));
    }

    private Map<String, Object> mapNumbers(Object value) {
        String text = String.valueOf(value);
        return json.map(text).entrySet().stream().collect(LinkedHashMap::new,
                (m, e) -> m.put(e.getKey(), ((Number) e.getValue()).longValue()), Map::putAll);
    }

    private static String camel(String value) {
        StringBuilder out = new StringBuilder();
        boolean upper = false;
        for (char c : value.toCharArray()) {
            if (c == '_') {
                upper = true;
            } else {
                out.append(upper ? Character.toUpperCase(c) : c);
                upper = false;
            }
        }
        return out.toString();
    }

    private static ApiException invalid(String reason, String message) {
        return ApiException.validation(message, Map.of("reason", reason));
    }
}
