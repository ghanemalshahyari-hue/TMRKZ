package ae.mover.reservations;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Grant;
import ae.mover.access.Permission;
import ae.mover.access.RequestScope;
import ae.mover.audit.AuditService;
import ae.mover.audit.AuditService.Capacity;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.requests.Commands.CloseInput;
import ae.mover.requests.Commands.CompleteInput;
import ae.mover.requests.RequestViews;
import ae.mover.system.IdempotencyService;

/**
 * Execution, handover and receipt tasks after approval (separate from the approval decision), and closing of the
 * administrative file. Closing never changes a reservation's period; only an evacuation's handover evidence does.
 */
@Service
public class ExecutionService {

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AccessService access;
    private final ReservationService reservations;
    private final AuditService audit;
    private final IdempotencyService idempotency;
    private final RequestViews views;
    private final ae.mover.common.Json json;

    public ExecutionService(JdbcClient jdbc, Clock clock, AccessService access, ReservationService reservations,
                            AuditService audit, IdempotencyService idempotency, RequestViews views, ae.mover.common.Json json) {
        this.json = json;
        this.jdbc = jdbc;
        this.clock = clock;
        this.access = access;
        this.reservations = reservations;
        this.audit = audit;
        this.idempotency = idempotency;
        this.views = views;
    }

    /** Open execution tasks the actor can complete, flattened with their request reference. */
    public List<Map<String, Object>> mine(AccessContext ctx) {
        List<Map<String, Object>> rows = jdbc.sql("""
                select distinct e.request_id, r.number from execution_task e join request r on r.id = e.request_id
                where e.status = 'OPEN' and r.status = 'APPROVED' order by r.number limit 500""").query().listOfRows();
        Map<UUID, RequestScope> scopes = access.scopes(rows.stream().map(m -> (UUID) m.get("request_id")).toList());
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> m : rows) {
            UUID rid = (UUID) m.get("request_id");
            for (RequestViews.ExecutionTaskView t : views.executionTasks(ctx, rid, scopes.get(rid))) {
                if (t.canComplete()) {
                    Map<String, Object> item = json.map(t);
                    item.put("requestId", rid.toString());
                    item.put("requestNumber", m.get("number"));
                    out.add(item);
                }
            }
        }
        return out;
    }

    @Transactional
    public RequestViews.ExecutionTaskView complete(AccessContext ctx, UUID taskId, CompleteInput in, String idemKey) {
        UUID[] requestId = new UUID[1];
        return idempotency.run(ctx.actor(), idemKey, "execution:" + taskId, in, () -> {
            requestId[0] = doComplete(ctx, taskId, in);
            return find(ctx, requestId[0], taskId);
        }, () -> {
            UUID rid = jdbc.sql("select request_id from execution_task where id = :id").param("id", taskId).query(UUID.class).single();
            return find(ctx, rid, taskId);
        });
    }

    private RequestViews.ExecutionTaskView find(AccessContext ctx, UUID requestId, UUID taskId) {
        return views.executionTasks(ctx, requestId, access.requestScope(requestId)).stream()
                .filter(t -> t.id().equals(taskId.toString())).findFirst().orElseThrow(ApiException::notFound);
    }

    private UUID doComplete(AccessContext ctx, UUID taskId, CompleteInput in) {
        Map<String, Object> t = jdbc.sql("""
                select e.*, r.status as request_status, r.number, r.target_reservation_id, ty.kind
                from execution_task e join request r on r.id = e.request_id join request_type ty on ty.code = r.type_code
                where e.id = :id for update of e""")
                .param("id", taskId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        UUID requestId = (UUID) t.get("request_id");
        RequestScope scope = access.requestScope(requestId);
        Grant grant = ctx.executionGrant((String) t.get("role_code"), (UUID) t.get("target_org_id"), scope).orElse(null);
        if (grant == null) {
            if (ctx.viewLevel(scope) == ae.mover.access.ViewLevel.NONE) {
                throw ApiException.notFound();
            }
            throw ApiException.forbidden("هذه المهمة مسندة إلى دور أو جهة أخرى.");
        }
        if (!"OPEN".equals(t.get("status")) || !"APPROVED".equals(t.get("request_status"))) {
            throw ApiException.validation("المهمة مكتملة أو الطلب ليس في مرحلة التنفيذ.");
        }
        String note = in == null || in.note() == null ? null : in.note().trim();
        boolean evidence = (Boolean) t.get("evidence_required");
        UUID attachment = null;
        if (in != null && in.evidenceAttachmentId() != null) {
            attachment = UUID.fromString(in.evidenceAttachmentId());
            boolean ok = jdbc.sql("select count(*) from attachment where id = :a and request_id = :r and scan_status = 'CLEAN'")
                    .param("a", attachment).param("r", requestId).query(Integer.class).single() > 0;
            if (!ok) {
                throw ApiException.validation("مرفق الإثبات غير موجود أو لم يجتز الفحص.");
            }
        }
        if (evidence && (note == null || note.length() < 5) && attachment == null) {
            throw ApiException.validation("هذه المهمة تتطلب دليل تسليم: اكتب محضر التسليم أو أرفق مستنداً.");
        }
        Instant now = clock.instant();
        jdbc.sql("""
                update execution_task set status = 'DONE', completed_by = :by, completed_at = :now, note = :note,
                       evidence_attachment_id = :att where id = :id""")
                .param("by", ctx.personId()).param("now", Db.ts(now)).param("note", note).param("att", attachment)
                .param("id", taskId).update();
        audit.record(ctx.actor(), new Capacity(grant.roleName(), grant.orgName(), grant.delegationId()),
                "EXECUTION_COMPLETED", "REQUEST", requestId.toString(), (String) t.get("number"),
                Map.of("task", t.get("name")), note, null);
        if ("EVACUATION".equals(t.get("kind")) && evidence) {
            int openEvidence = jdbc.sql("select count(*) from execution_task where request_id = :r and evidence_required and status = 'OPEN'")
                    .param("r", requestId).query(Integer.class).single();
            if (openEvidence == 0) {
                ReservationService.Reservation r = reservations.lock((UUID) t.get("target_reservation_id"));
                reservations.end(r, now, "RELEASED", requestId, "EVACUATION", ctx.personId());
                audit.record(ctx.actor(), new Capacity(grant.roleName(), grant.orgName(), grant.delegationId()),
                        "RESERVATION_RELEASED", "REQUEST", requestId.toString(), (String) t.get("number"),
                        Map.of("reservationId", r.id().toString(), "releasedAt", now.toString()), note, null);
            }
        }
        return requestId;
    }

    @Transactional
    public RequestViews.RequestDetail close(AccessContext ctx, UUID requestId, CloseInput in, String idemKey) {
        return idempotency.run(ctx.actor(), idemKey, "close:" + requestId, in, () -> {
            doClose(ctx, requestId, in);
            return views.detail(ctx, requestId);
        }, () -> views.detail(ctx, requestId));
    }

    private void doClose(AccessContext ctx, UUID requestId, CloseInput in) {
        Map<String, Object> r = jdbc.sql("select number, status, created_by from request where id = :id for update")
                .param("id", requestId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        RequestScope scope = access.requestScope(requestId);
        if (ctx.viewLevel(scope) == ae.mover.access.ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        boolean allowed = ctx.personId().equals(r.get("created_by"))
                || ctx.grants().stream().anyMatch(g -> g.has(Permission.REVIEW) && g.covers(scope.relatedOrgs(), scope.siteIds()));
        if (!allowed) {
            throw ApiException.forbidden();
        }
        if (!"APPROVED".equals(r.get("status"))) {
            throw ApiException.validation("يُغلق الطلب بعد اعتماده فقط.");
        }
        int open = jdbc.sql("select count(*) from execution_task where request_id = :r and status = 'OPEN'")
                .param("r", requestId).query(Integer.class).single();
        if (open > 0) {
            throw ApiException.validation("توجد مهام تنفيذ أو استلام مفتوحة؛ أكملها قبل إغلاق الطلب.");
        }
        Instant now = clock.instant();
        jdbc.sql("update request set status = 'CLOSED', closed_at = :now, updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", requestId).update();
        audit.recordAs(ctx.actor(), "REQUEST_CLOSED", "REQUEST", requestId.toString(), (String) r.get("number"),
                Map.of("note", "إغلاق المعاملة لا يغيّر فترة الحجز"), in == null ? null : in.note());
    }
}
