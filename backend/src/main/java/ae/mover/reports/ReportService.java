package ae.mover.reports;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.ViewLevel;
import ae.mover.attachments.FileStore;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.common.Times;

/** Indicators (each with an explicit definition) and scoped CSV exports. All figures use the request scope rule. */
@Service
public class ReportService {

    private static final Map<String, String> REASONS = Map.of(
            "INCOMPLETE_DATA", "بيانات ناقصة", "PERIOD_CONFLICT", "تعارض في الفترة", "WRONG_FACILITY", "مرفق غير مناسب",
            "MISSING_ATTACHMENT", "مرفق مطلوب غير موجود", "OTHER", "سبب آخر");

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AccessService access;
    private final FileStore store;
    private final AuditService audit;

    public ReportService(JdbcClient jdbc, Json json, Clock clock, AccessService access, FileStore store, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.access = access;
        this.store = store;
        this.audit = audit;
    }

    public Map<String, Object> kpis(AccessContext ctx, String from, String to) {
        ctx.require(Permission.VIEW);
        LocalDate today = LocalDate.now(clock.withZone(Times.DISPLAY_ZONE));
        Instant a = Times.startOfDay(from == null ? today.minusDays(30) : Times.parseDate(from, "from"));
        Instant b = Times.startOfDay((to == null ? today : Times.parseDate(to, "to")).plusDays(1));
        if (!b.isAfter(a)) {
            throw ApiException.validation("نهاية الفترة يجب أن تكون بعد بدايتها.");
        }
        Map<String, Object> params = new HashMap<>();
        String scope = access.requestPredicate(ctx, params);
        params.put("a", Db.ts(a));
        params.put("b", Db.ts(b));
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, String> defs = new LinkedHashMap<>();
        defs.put("reviewTime", "زمن المراجعة: الساعات من إنشاء مهمة المراجعة حتى قرار الموافقة أو الإرجاع أو الرفض، للقرارات المتخذة خلال الفترة وضمن نطاقك.");
        defs.put("returnReasons", "أسباب الإرجاع: عدد قرارات الإرجاع خلال الفترة مصنفة برمز السبب الذي اختاره المراجع.");
        defs.put("occupancy", "الإشغال: مجموع ساعات الحجوزات النشطة المعتمدة المتقاطعة مع الفترة مقسوماً على ساعات الفترة لكل مورد. لا يقيس الحضور الميداني.");
        defs.put("overdueExecution", "مهام التنفيذ المتأخرة: مهام تنفيذ أو تسليم أو استلام مفتوحة تجاوزت موعدها الآن.");
        defs.put("overdueReview", "مراجعات متأخرة: مهام مراجعة مفتوحة تجاوزت مهلة المرحلة الآن.");
        out.put("definitions", defs);
        out.put("period", Map.of("from", a.toString(), "to", b.toString()));

        Map<String, Object> review = jdbc.sql("""
                select count(*) as n, avg(h) as avg_h, percentile_cont(0.5) within group (order by h) as p50,
                       percentile_cont(0.95) within group (order by h) as p95
                from (select extract(epoch from d.decided_at - t.created_at) / 3600.0 as h
                      from decision d join task_assignment t on t.id = d.task_id join request r on r.id = d.request_id
                      where d.decision in ('APPROVE', 'RETURN', 'REJECT') and d.decided_at >= :a and d.decided_at < :b
                        and""" + " " + scope + ") x").params(params).query().singleRow();
        Map<String, Object> rt = new LinkedHashMap<>();
        rt.put("count", ((Number) review.get("n")).longValue());
        rt.put("avgHours", round(review.get("avg_h")));
        rt.put("p50Hours", round(review.get("p50")));
        rt.put("p95Hours", round(review.get("p95")));
        rt.put("byStage", jdbc.sql("""
                select d.stage_name, count(*) as n, avg(extract(epoch from d.decided_at - t.created_at) / 3600.0) as h
                from decision d join task_assignment t on t.id = d.task_id join request r on r.id = d.request_id
                where d.decision in ('APPROVE', 'RETURN', 'REJECT') and d.decided_at >= :a and d.decided_at < :b and""" + " " + scope + " group by d.stage_name order by d.stage_name").params(params)
                .query((rs, n) -> Map.of("stageName", rs.getString("stage_name"), "count", rs.getLong("n"),
                        "avgHours", round(rs.getObject("h")))).list());
        out.put("reviewTime", rt);

        Map<String, Long> reasonCounts = new LinkedHashMap<>();
        REASONS.keySet().stream().sorted().forEach(k -> reasonCounts.put(k, 0L));
        jdbc.sql("""
                select coalesce(d.reason_code, 'OTHER') as code, count(*) as n from decision d join request r on r.id = d.request_id
                where d.decision = 'RETURN' and d.decided_at >= :a and d.decided_at < :b and""" + " " + scope + " group by 1")
                .params(params).query((rs, n) -> reasonCounts.put(rs.getString("code"), rs.getLong("n"))).list();
        List<Map<String, Object>> reasons = new ArrayList<>();
        reasonCounts.forEach((k, v) -> reasons.add(Map.of("code", k, "label", REASONS.getOrDefault(k, k), "count", v)));
        out.put("returnReasons", reasons);

        double totalHours = Duration.between(a, b).toMinutes() / 60.0;
        List<Map<String, Object>> occupancy = new ArrayList<>();
        Map<String, Object> occParams = new HashMap<>(params);
        jdbc.sql("""
                select res.id, res.name, res.site_id, sr.organization_id,
                       coalesce(sum(extract(epoch from (least(coalesce(v.period_end, :b), :b) - greatest(v.period_start, :a))) / 3600.0)
                         filter (where v.id is not null), 0) as h
                from resource res
                left join site_responsibility sr on sr.site_id = res.site_id and sr.valid_to is null
                left join reservation v on v.resource_id = res.id and v.status in ('ACTIVE', 'RELEASED')
                     and tstzrange(v.period_start, v.period_end, '[)') && tstzrange(:a, :b, '[)')
                where res.status = 'ACTIVE' group by res.id, res.name, res.site_id, sr.organization_id order by res.code""")
                .params(occParams).query((rs, n) -> {
                    if (ctx.siteView(Db.uuid(rs, "site_id"), java.util.Set.of(), Db.uuid(rs, "organization_id")) != ViewLevel.NONE) {
                        double h = rs.getDouble("h");
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("resourceId", rs.getString("id"));
                        m.put("resourceName", rs.getString("name"));
                        m.put("reservedHours", Math.round(h * 10) / 10.0);
                        m.put("totalHours", Math.round(totalHours * 10) / 10.0);
                        m.put("ratio", Math.round(Math.min(1.0, h / totalHours) * 1000) / 1000.0);
                        occupancy.add(m);
                    }
                    return null;
                }).list();
        out.put("occupancy", occupancy);

        params.put("now", Db.ts(clock.instant()));
        List<Map<String, Object>> overdue = jdbc.sql("""
                select e.id, e.name, r.number, e.due_at from execution_task e join request r on r.id = e.request_id
                where e.status = 'OPEN' and e.due_at < :now and""" + " " + scope + " order by e.due_at limit 50")
                .params(params).query((rs, n) -> Map.<String, Object>of("id", rs.getString("id"), "name", rs.getString("name"),
                        "requestNumber", rs.getString("number"), "dueAt", Db.iso(rs, "due_at"))).list();
        long overdueCount = jdbc.sql("select count(*) from execution_task e join request r on r.id = e.request_id where e.status = 'OPEN' and e.due_at < :now and " + scope)
                .params(params).query(Long.class).single();
        out.put("overdueExecution", Map.of("count", overdueCount, "items", overdue));
        long overdueReview = jdbc.sql("select count(*) from task_assignment t join request r on r.id = t.request_id where t.status = 'OPEN' and t.due_at < :now and " + scope)
                .params(params).query(Long.class).single();
        out.put("overdueReview", Map.of("count", overdueReview));
        return out;
    }

    private static Double round(Object v) {
        if (v == null) {
            return null;
        }
        return Math.round(((Number) v).doubleValue() * 10) / 10.0;
    }

    // ---- exports --------------------------------------------------------------------------------------

    public record ExportJob(String id, String status, int rowCount, String createdAt) {
    }

    @Transactional
    public ExportJob createExport(AccessContext ctx, String kind, Map<String, Object> filter) {
        ctx.require(Permission.EXPORT);
        if (!"REQUESTS_CSV".equals(kind)) {
            throw ApiException.validation("نوع التصدير غير مدعوم.");
        }
        Map<String, Object> params = new HashMap<>();
        StringBuilder where = new StringBuilder(access.requestPredicate(ctx, params));
        Object status = filter == null ? null : filter.get("status");
        if (status instanceof String s && !s.isBlank()) {
            where.append(" and r.status = :status");
            params.put("status", s);
        }
        List<Map<String, Object>> rows = jdbc.sql("""
                select r.id, r.number, t.name as type_name, r.status, o.name as org_name, r.period_start, r.period_end,
                       (select string_agg(res.name, '، ' order by res.code) from request_resource rr join resource res on res.id = rr.resource_id
                        where rr.request_id = r.id) as resources
                from request r join request_type t on t.code = r.type_code join organization o on o.id = r.owner_org_id
                where""" + " " + where + " order by r.number limit 50000").params(params).query().listOfRows();
        var scopes = access.scopes(rows.stream().map(m -> (UUID) m.get("id")).toList());
        StringBuilder csv = new StringBuilder("﻿");
        csv.append(row("رقم الطلب", "النوع", "الحالة", "الجهة", "المرافق", "بداية الفترة", "نهاية الفترة")).append('\n');
        int count = 0;
        for (Map<String, Object> m : rows) {
            ViewLevel level = ctx.viewLevel(scopes.get((UUID) m.get("id")));
            if (level == ViewLevel.NONE) {
                continue;
            }
            boolean full = level == ViewLevel.FULL;
            Instant s = Db.toInstant(m.get("period_start"));
            Instant e = Db.toInstant(m.get("period_end"));
            csv.append(row((String) m.get("number"), (String) m.get("type_name"), (String) m.get("status"),
                    full ? (String) m.get("org_name") : "مقيد", (String) m.get("resources"),
                    s == null ? "" : s.toString(), e == null ? "مفتوحة" : e.toString())).append('\n');
            count++;
        }
        UUID id = UUID.randomUUID();
        String key = "exports/" + id + ".csv";
        store.write(key, csv.toString().getBytes(StandardCharsets.UTF_8));
        jdbc.sql("""
                insert into export_job(id, requested_by, kind, filter, status, row_count, storage_key, created_at)
                values (:id, :by, :k, cast(:f as jsonb), 'READY', :n, :key, :now)""")
                .param("id", id).param("by", ctx.personId()).param("k", kind).param("f", json.write(filter == null ? Map.of() : filter))
                .param("n", count).param("key", key).param("now", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), "EXPORT_CREATED", "EXPORT", id.toString(), kind, Map.of("rows", count), null);
        return export(ctx, id);
    }

    public ExportJob export(AccessContext ctx, UUID id) {
        ctx.require(Permission.EXPORT);
        return jdbc.sql("select * from export_job where id = :id and requested_by = :me").param("id", id).param("me", ctx.personId())
                .query((rs, n) -> new ExportJob(rs.getString("id"), rs.getString("status"), rs.getInt("row_count"), Db.iso(rs, "created_at")))
                .optional().orElseThrow(ApiException::notFound);
    }

    /** The EXPORT permission is re-checked at download time, not only when the export was created. */
    @Transactional
    public byte[] exportContent(AccessContext ctx, UUID id) {
        ctx.require(Permission.EXPORT);
        String key = jdbc.sql("select storage_key from export_job where id = :id and requested_by = :me and status = 'READY'")
                .param("id", id).param("me", ctx.personId()).query(String.class).optional().orElseThrow(ApiException::notFound);
        audit.recordAs(ctx.actor(), "EXPORT_DOWNLOADED", "EXPORT", id.toString(), null, Map.of(), null);
        return store.read(key);
    }

    private static String row(String... values) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < values.length; i++) {
            if (i > 0) {
                sb.append(',');
            }
            String v = values[i] == null ? "" : values[i];
            if (!v.isEmpty() && "=+-@".indexOf(v.charAt(0)) >= 0) {
                v = "'" + v; // neutralise spreadsheet formula injection
            }
            sb.append('"').append(v.replace("\"", "\"\"")).append('"');
        }
        return sb.toString();
    }
}
