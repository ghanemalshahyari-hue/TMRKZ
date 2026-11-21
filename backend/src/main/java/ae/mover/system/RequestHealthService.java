package ae.mover.system;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;

/**
 * «صحة الطلبات» (owner, 20 Nov 2026): a read-only diagnostic surface for the system administrator. It never approves,
 * never changes a decision and never writes the request's own state. It reads the live request, its current stage, the
 * route's seat holders, and the stationing outbox, and says — in plain words — whether the request is healthy, waiting
 * on someone, returned to its requester, or stuck for a reason we can describe. Repair actions are only names of calls
 * the administrator may make with the permissions they hold (REPLAY_STATIONING_EVENTS for a failed outbox event, the
 * access-manager task realignment for a dependent access task). The service itself never performs them.
 */
@Service
public class RequestHealthService {

    private static final Logger log = LoggerFactory.getLogger(RequestHealthService.class);
    private static final Duration STAGE_WARN = Duration.ofHours(24);
    private static final Duration STAGE_STUCK = Duration.ofDays(3);
    private static final int MAX_LIST = 200;

    public enum Health { HEALTHY, WAITING_REQUESTER, WARNING, STUCK }

    public record HealthReason(String code, String message) {
    }

    public record RepairHint(String code, String label, String endpoint, String why) {
    }

    public record Row(
            UUID id,
            String number,
            String state,
            String kind,
            UUID requestingUnitId,
            String requestingUnitName,
            Instant updatedAt,
            Health health,
            HealthReason reason) {
    }

    private final JdbcClient jdbc;
    private final AuditService audit;
    private final Clock clock;

    // The last scan result in memory: on an installation of a few thousand requests this is enough; a table comes with
    // the first real scale demand.
    private volatile Map<UUID, Row> lastScan = new ConcurrentHashMap<>();
    private volatile Instant lastScanAt = Instant.EPOCH;

    public RequestHealthService(JdbcClient jdbc, AuditService audit, Clock clock) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.clock = clock;
    }

    /** The small summary for the admin's home widget. All reads, no writes. */
    public Map<String, Object> summary(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Map<Health, Long> byHealth = new LinkedHashMap<>();
        for (Health h : Health.values()) byHealth.put(h, 0L);
        for (Row r : lastScan.values()) byHealth.merge(r.health(), 1L, Long::sum);
        long outboxPending = jdbc.sql("select count(*) from stationing_outbox where state = 'PENDING'").query(Long.class).single();
        long outboxFailed = jdbc.sql("select count(*) from stationing_outbox where state = 'FAILED'").query(Long.class).single();
        // Only signed-in people (who have an identity_link) are counted; the rest of the HR mirror is intentional.
        long peopleWithoutLocalUnit = jdbc.sql("""
                select count(*) from person p
                where p.status = 'ACTIVE' and p.source in ('HR', 'DIRECTORY')
                  and exists (select 1 from identity_link il where il.person_id = p.id)
                  and not exists (select 1 from membership m where m.person_id = p.id
                                   and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
                """).query(Long.class).optional().orElse(0L);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("scannedAt", lastScanAt == Instant.EPOCH ? null : lastScanAt.toString());
        m.put("open", lastScan.size());
        m.put("healthy", byHealth.get(Health.HEALTHY));
        m.put("waitingRequester", byHealth.get(Health.WAITING_REQUESTER));
        m.put("warning", byHealth.get(Health.WARNING));
        m.put("stuck", byHealth.get(Health.STUCK));
        m.put("outboxPending", outboxPending);
        m.put("outboxFailed", outboxFailed);
        m.put("peopleWithoutLocalUnit", peopleWithoutLocalUnit);
        return m;
    }

    /** Admin search: the open requests that match, enriched with health, with no decision context exposed. */
    public List<Map<String, Object>> search(AccessContext ctx, String q, String stateFilter, String healthFilter, int limit) {
        ctx.require(Permission.CONFIGURE);
        String like = q == null ? null : "%" + q.trim() + "%";
        List<Row> rows = new ArrayList<>(lastScan.values());
        rows.sort((a, b) -> b.updatedAt().compareTo(a.updatedAt()));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Row r : rows) {
            if (healthFilter != null && !healthFilter.isBlank() && !healthFilter.equalsIgnoreCase(r.health().name())) continue;
            if (stateFilter != null && !stateFilter.isBlank() && !stateFilter.equalsIgnoreCase(r.state())) continue;
            if (like != null && !like.equals("%%") && !r.number().toLowerCase().contains(q.trim().toLowerCase())
                    && !(r.requestingUnitName() != null && r.requestingUnitName().contains(q.trim()))) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.id().toString());
            m.put("number", r.number());
            m.put("state", r.state());
            m.put("kind", r.kind());
            m.put("requestingUnit", r.requestingUnitName());
            m.put("updatedAt", r.updatedAt().toString());
            m.put("health", r.health().name());
            m.put("reasonCode", r.reason() == null ? null : r.reason().code());
            m.put("reasonText", r.reason() == null ? null : r.reason().message());
            out.add(m);
            if (out.size() >= Math.min(MAX_LIST, Math.max(10, limit))) break;
        }
        audit.recordAs(ctx.actor(), "SYSTEM_REQUEST_HEALTH_SEARCHED", "SYSTEM", "request-health", "صحة الطلبات",
                Map.of("q", q == null ? "" : q, "state", stateFilter == null ? "" : stateFilter, "health",
                        healthFilter == null ? "" : healthFilter, "returned", out.size()), null);
        return out;
    }

    /** Diagnose one request by number or id. Writes nothing on the request itself. */
    public Map<String, Object> diagnose(AccessContext ctx, String identifier) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> req = findRequest(identifier);
        if (req == null) {
            throw new ApiException(ErrorCode.RESOURCE_NOT_FOUND, "لا يوجد طلب بهذا الرقم.");
        }
        UUID requestId = (UUID) req.get("id");
        String state = (String) req.get("state");
        String number = (String) req.get("number");
        UUID requestingUnit = (UUID) req.get("requesting_unit_id");

        // Open stages: the undecided stages on the request's current route, in order.
        int routeNo = ((Number) req.get("route_no")).intValue();
        List<Map<String, Object>> stages = jdbc.sql("""
                select position, stage_key, kind, unit_id, permission, label, final_stage, decided_by, decided_at, mark
                from restationing_stage where request_id = :r and route_no = :n order by position
                """).param("r", requestId).param("n", routeNo).query().listOfRows();

        Optional<Map<String, Object>> firstOpen = stages.stream().filter((s) -> s.get("decided_by") == null).findFirst();
        Instant lastDecidedAt = stages.stream()
                .map((s) -> Db.toInstant(s.get("decided_at")))
                .filter(java.util.Objects::nonNull)
                .max(Instant::compareTo).orElse(Db.toInstant(req.get("created_at")));
        Instant now = clock.instant();
        Duration sinceLast = lastDecidedAt == null ? Duration.ZERO : Duration.between(lastDecidedAt, now);

        // Outbox events for this request's unit (the sender keys by organization_id; the request's requesting unit is the correct lookup).
        List<Map<String, Object>> outboxFailed = jdbc.sql("""
                select event_id, event_type, state, attempts, last_error, available_at, created_at
                from stationing_outbox where organization_id = :o and state = 'FAILED' order by seq desc limit 10
                """).param("o", requestingUnit).query().listOfRows();
        List<Map<String, Object>> outboxPending = jdbc.sql("""
                select event_id, event_type, state, attempts, available_at, created_at
                from stationing_outbox where organization_id = :o and state = 'PENDING' order by seq desc limit 10
                """).param("o", requestingUnit).query().listOfRows();

        // Health is decided from the signals above and the request's state.
        Health h;
        HealthReason reason;
        List<RepairHint> hints = new ArrayList<>();
        if (!outboxFailed.isEmpty()) {
            h = Health.STUCK;
            reason = new HealthReason("FAILED_EVENT", "فشل حدث تمركز بعد " + outboxFailed.get(0).get("attempts")
                    + " محاولات: " + firstLine(outboxFailed.get(0).get("last_error")));
            hints.add(new RepairHint("REPLAY_EVENT", "إعادة إرسال الحدث الفاشل",
                    "/api/v1/stationing/outbox/" + outboxFailed.get(0).get("event_id") + "/replay",
                    "يحتاج صلاحية REPLAY_STATIONING_EVENTS"));
        } else if ("RETURNED_FOR_CHANGES".equals(state)) {
            h = Health.WAITING_REQUESTER;
            reason = new HealthReason("RETURNED", "الطلب مُعاد إلى مقدم الطلب بانتظار تعديله.");
        } else if ("PAUSED_HIERARCHY_CHANGED".equals(state)) {
            h = Health.STUCK;
            reason = new HealthReason("HIERARCHY_CHANGED", "تغيّرت السلسلة الهرمية منذ إنشاء المسار؛ يحتاج إعادة بناء المسار قبل الاستئناف.");
        } else if ("APPROVED_NOT_ACTIVATED".equals(state)) {
            h = Health.WARNING;
            reason = new HealthReason("NOT_ACTIVATED", "اكتملت الاعتمادات ولم يُفعَّل الطلب بعد.");
            if (!outboxPending.isEmpty()) {
                hints.add(new RepairHint("CHECK_OUTBOX", "فحص حالة إخراج أحداث التفعيل",
                        "/api/v1/stationing/outbox?state=PENDING", "لا يتطلب تعديل الطلب."));
            }
        } else if (firstOpen.isEmpty()) {
            h = Health.HEALTHY;
            reason = new HealthReason("OK", "كل المراحل مقررة؛ الطلب في حالة نهائية.");
        } else {
            // There is an open stage. Check whether the seat has a valid current holder: anyone in that unit who holds the
            // right permission and is still active.
            String permission = (String) firstOpen.get().get("permission");
            UUID stageUnit = (UUID) firstOpen.get().get("unit_id");
            long validHolders = stageUnit == null ? 1L : jdbc.sql("""
                    select count(distinct m.person_id) from membership m
                      join role_def r on r.code = m.role_code
                      join person p on p.id = m.person_id and p.status = 'ACTIVE'
                    where :perm = any(r.permissions)
                      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
                      and (r.scope = 'ALL' or m.scope_all = true or m.organization_id = :unit)
                    """).param("perm", permission).param("unit", stageUnit).query(Long.class).optional().orElse(0L);
            if (validHolders == 0L) {
                h = Health.STUCK;
                reason = new HealthReason("NO_HOLDER", "لا يوجد حامل صالح للمقعد «" + permission + "» في الوحدة المعنية.");
                hints.add(new RepairHint("ASSIGN_HOLDER", "فتح «مركز الصلاحيات» لإسناد المقعد",
                        "/#permissions", "يحتاج صلاحية MANAGE_ACCESS. النظام لا يصلح هذا تلقائياً."));
            } else if (sinceLast.compareTo(STAGE_STUCK) > 0) {
                h = Health.WARNING;
                reason = new HealthReason("NO_PROGRESS_LONG", "لم يُتَّخذ قرار منذ " + sinceLast.toDays() + " يوماً — ممكن يحتاج تذكيراً.");
            } else if (sinceLast.compareTo(STAGE_WARN) > 0) {
                h = Health.WARNING;
                reason = new HealthReason("NO_PROGRESS", "لم يُتَّخذ قرار منذ " + sinceLast.toHours() + " ساعة.");
            } else {
                h = Health.HEALTHY;
                reason = new HealthReason("WAITING_DECISION", "ينتظر قرار «" + firstOpen.get().get("label") + "» (ليس عطلاً).");
            }
        }

        // Summary payload — no decision content, no request body — just the diagnosis.
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", requestId.toString());
        out.put("number", number);
        out.put("state", state);
        out.put("kind", req.get("kind"));
        out.put("requestingUnit", req.get("requesting_unit_name"));
        out.put("createdAt", Db.toInstant(req.get("created_at")).toString());
        out.put("updatedAt", Db.toInstant(req.get("updated_at")).toString());
        out.put("lastDecidedAt", lastDecidedAt == null ? null : lastDecidedAt.toString());
        out.put("sinceLastHours", sinceLast.toHours());
        out.put("routeNo", routeNo);
        List<Map<String, Object>> stageView = new ArrayList<>();
        for (Map<String, Object> s : stages) {
            Map<String, Object> sv = new LinkedHashMap<>();
            sv.put("position", ((Number) s.get("position")).intValue());
            sv.put("stageKey", s.get("stage_key"));
            sv.put("label", s.get("label"));
            sv.put("permission", s.get("permission"));
            sv.put("final", s.get("final_stage"));
            sv.put("decided", s.get("decided_by") != null);
            sv.put("mark", s.get("mark"));
            sv.put("decidedAt", s.get("decided_at") == null ? null : Db.toInstant(s.get("decided_at")).toString());
            stageView.add(sv);
        }
        out.put("stages", stageView);
        out.put("health", h.name());
        out.put("reason", Map.of("code", reason.code(), "message", reason.message()));
        out.put("repairs", hints.stream().map(this::repairMap).toList());
        out.put("outboxFailed", outboxFailed.stream().map(this::outboxMap).toList());
        out.put("outboxPending", outboxPending.stream().map(this::outboxMap).toList());

        audit.recordAs(ctx.actor(), "SYSTEM_REQUEST_HEALTH_READ", "REQUEST", requestId.toString(), number,
                Map.of("health", h.name(), "reason", reason.code(), "state", state), null);
        return out;
    }

    /** The scanner ticks every five minutes (owner, 20 Nov 2026) and updates the in-memory map. Writes nothing. */
    @Scheduled(fixedDelayString = "${tmrkz.health.tick-seconds:300}000")
    public void scan() {
        try {
            lastScan = computeAll();
            lastScanAt = clock.instant();
        } catch (RuntimeException e) {
            log.warn("request health scan failed: {}", e.toString());
        }
    }

    private Map<UUID, Row> computeAll() {
        Map<UUID, Row> out = new ConcurrentHashMap<>();
        List<Map<String, Object>> open = jdbc.sql("""
                select r.id, r.number, r.state, r.kind, r.requesting_unit_id, o.name as requesting_unit_name,
                       r.updated_at, r.created_at, r.route_no
                from restationing_request r join organization o on o.id = r.requesting_unit_id
                where r.state in ('UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED', 'APPROVED_NOT_ACTIVATED')
                """).query().listOfRows();
        for (Map<String, Object> req : open) {
            UUID id = (UUID) req.get("id");
            String state = (String) req.get("state");
            Instant updatedAt = Db.toInstant(req.get("updated_at"));
            Health h;
            HealthReason reason;
            if ("RETURNED_FOR_CHANGES".equals(state)) {
                h = Health.WAITING_REQUESTER; reason = new HealthReason("RETURNED", "بانتظار تعديل مقدم الطلب.");
            } else if ("PAUSED_HIERARCHY_CHANGED".equals(state)) {
                h = Health.STUCK; reason = new HealthReason("HIERARCHY_CHANGED", "تغيّرت السلسلة الهرمية.");
            } else if ("APPROVED_NOT_ACTIVATED".equals(state)) {
                h = Health.WARNING; reason = new HealthReason("NOT_ACTIVATED", "اكتملت الاعتمادات ولم يُفعَّل.");
            } else {
                Duration since = updatedAt == null ? Duration.ZERO : Duration.between(updatedAt, clock.instant());
                if (since.compareTo(STAGE_STUCK) > 0) { h = Health.WARNING; reason = new HealthReason("NO_PROGRESS_LONG", "دون قرار منذ " + since.toDays() + " يوماً."); }
                else if (since.compareTo(STAGE_WARN) > 0) { h = Health.WARNING; reason = new HealthReason("NO_PROGRESS", "دون قرار منذ " + since.toHours() + " ساعة."); }
                else { h = Health.HEALTHY; reason = new HealthReason("WAITING_DECISION", "ينتظر قرار صاحبه."); }
            }
            out.put(id, new Row(id, (String) req.get("number"), state, (String) req.get("kind"),
                    (UUID) req.get("requesting_unit_id"), (String) req.get("requesting_unit_name"),
                    updatedAt, h, reason));
        }
        return out;
    }

    private Map<String, Object> findRequest(String identifier) {
        String id = identifier == null ? "" : identifier.trim();
        if (id.isEmpty()) return null;
        if (id.matches("^[0-9a-fA-F-]{36}$")) {
            return jdbc.sql("""
                    select r.*, o.name as requesting_unit_name
                    from restationing_request r join organization o on o.id = r.requesting_unit_id
                    where r.id = :id""")
                    .param("id", UUID.fromString(id)).query().listOfRows().stream().findFirst().orElse(null);
        }
        return jdbc.sql("""
                select r.*, o.name as requesting_unit_name
                from restationing_request r join organization o on o.id = r.requesting_unit_id
                where upper(r.number) = upper(:n)""").param("n", id).query().listOfRows().stream().findFirst().orElse(null);
    }

    private Map<String, Object> outboxMap(Map<String, Object> row) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("eventId", row.get("event_id").toString());
        m.put("eventType", row.get("event_type"));
        m.put("state", row.get("state"));
        m.put("attempts", row.get("attempts"));
        m.put("lastError", row.get("last_error"));
        m.put("availableAt", row.get("available_at") == null ? null : Db.toInstant(row.get("available_at")).toString());
        m.put("createdAt", row.get("created_at") == null ? null : Db.toInstant(row.get("created_at")).toString());
        return m;
    }

    private Map<String, Object> repairMap(RepairHint h) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", h.code());
        m.put("label", h.label());
        m.put("endpoint", h.endpoint());
        m.put("why", h.why());
        return m;
    }

    private static String firstLine(Object s) {
        if (s == null) return "";
        String t = s.toString();
        int nl = t.indexOf('\n');
        return nl < 0 ? t : t.substring(0, nl);
    }
}
