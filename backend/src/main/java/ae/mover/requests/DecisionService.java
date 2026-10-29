package ae.mover.requests;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Grant;
import ae.mover.access.RequestScope;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.audit.AuditService.Capacity;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import ae.mover.common.Json;
import ae.mover.common.Times;
import ae.mover.outbox.OutboxService;
import ae.mover.policy.PolicyService;
import ae.mover.requests.Commands.DecisionInput;
import ae.mover.reservations.ReservationService;
import ae.mover.system.IdempotencyService;
import ae.mover.workflow.TaskSync;
import ae.mover.workflow.WorkflowDefinition;
import ae.mover.workflow.WorkflowRuntime;
import ae.mover.workflow.WorkflowService;

/**
 * Review decisions. For the final approval, the active-task check, revision check, current authorisation,
 * signature, reservation commit (all resources or none), decision record, approval document, audit row and outbox
 * event all happen in one database transaction shared with the embedded Flowable engine.
 */
@Service
public class DecisionService {

    public static final Set<String> REASON_CODES = Set.of("INCOMPLETE_DATA", "PERIOD_CONFLICT", "WRONG_FACILITY",
            "MISSING_ATTACHMENT", "OTHER");

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AccessService access;
    private final TaskService taskService;
    private final RuntimeService runtime;
    private final TaskSync taskSync;
    private final WorkflowService workflows;
    private final WorkflowRuntime workflowRuntime;
    private final ReservationService reservations;
    private final PolicyService policies;
    private final SignatureService signatures;
    private final AuditService audit;
    private final OutboxService outbox;
    private final IdempotencyService idempotency;
    private final RequestViews views;

    public DecisionService(JdbcClient jdbc, Json json, Clock clock, AccessService access, TaskService taskService,
                           RuntimeService runtime, TaskSync taskSync, WorkflowService workflows,
                           WorkflowRuntime workflowRuntime, ReservationService reservations, PolicyService policies,
                           SignatureService signatures, AuditService audit, OutboxService outbox,
                           IdempotencyService idempotency, RequestViews views) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.access = access;
        this.taskService = taskService;
        this.runtime = runtime;
        this.taskSync = taskSync;
        this.workflows = workflows;
        this.workflowRuntime = workflowRuntime;
        this.reservations = reservations;
        this.policies = policies;
        this.signatures = signatures;
        this.audit = audit;
        this.outbox = outbox;
        this.idempotency = idempotency;
        this.views = views;
    }

    public record TaskItem(String id, String requestId, String requestNumber, String requestType, String stageKey,
                           String stageName, String roleName, String orgName, String createdAt, String dueAt,
                           boolean overdue, boolean finalStage, boolean requiresSignature) {
        @com.fasterxml.jackson.annotation.JsonProperty("final")
        public boolean isFinal() {
            return finalStage;
        }
    }

    public record DocumentLine(String label, String value) {
    }

    public record ApprovalDocumentPreview(int revision, String sha256, String signatureMode, String signatureLabel,
                                          List<DocumentLine> lines) {
    }

    record TaskRow(UUID id, UUID requestId, int revision, String flowableTaskId, String stageKey, String stageName,
                   String roleCode, String roleName, UUID targetOrgId, boolean finalStage, boolean requiresSignature,
                   String status, Instant createdAt, Instant dueAt, UUID assignedPersonId, boolean awaitingAssignment) {
    }

    private TaskRow task(UUID taskId, boolean lock) {
        return jdbc.sql("""
                select t.*, rd.name as role_name from task_assignment t join role_def rd on rd.code = t.role_code
                where t.id = :id""" + (lock ? " for update of t" : ""))
                .param("id", taskId)
                .query((rs, n) -> new TaskRow(Db.uuid(rs, "id"), Db.uuid(rs, "request_id"), rs.getInt("revision"),
                        rs.getString("flowable_task_id"), rs.getString("stage_key"), rs.getString("stage_name"),
                        rs.getString("role_code"), rs.getString("role_name"), Db.uuid(rs, "target_org_id"),
                        rs.getBoolean("final"), rs.getBoolean("requires_signature"), rs.getString("status"),
                        Db.instant(rs, "created_at"), Db.instant(rs, "due_at"), Db.uuid(rs, "assigned_person_id"),
                        rs.getBoolean("awaiting_assignment")))
                .optional().orElseThrow(ApiException::notFound);
    }

    /** Open tasks the actor may decide now (role + scope + separation of duties evaluated per task). */
    public List<TaskItem> myTasks(AccessContext ctx) {
        Set<String> roles = new java.util.HashSet<>();
        ctx.grants().stream().filter(g -> g.has(ae.mover.access.Permission.REVIEW)).forEach(g -> roles.add(g.roleCode()));
        if (roles.isEmpty()) {
            return List.of();
        }
        List<Map<String, Object>> rows = jdbc.sql("""
                select t.id, t.request_id, r.number, ty.name as type_name, t.stage_key, t.stage_name, t.role_code,
                       rd.name as role_name, o.name as org_name, t.target_org_id, t.created_at, t.due_at, t.final, t.requires_signature,
                       t.assigned_person_id, t.awaiting_assignment
                from task_assignment t join request r on r.id = t.request_id join request_type ty on ty.code = r.type_code
                join role_def rd on rd.code = t.role_code left join organization o on o.id = t.target_org_id
                where t.status = 'OPEN' and r.status = 'SUBMITTED' and t.role_code = any(string_to_array(:roles, ','))
                order by t.due_at limit 500""")
                .param("roles", String.join(",", roles)).query().listOfRows();
        Map<UUID, RequestScope> scopes = access.scopes(rows.stream().map(m -> (UUID) m.get("request_id")).distinct().toList());
        Instant now = clock.instant();
        List<TaskItem> out = new ArrayList<>();
        for (Map<String, Object> m : rows) {
            RequestScope scope = scopes.get((UUID) m.get("request_id"));
            boolean fin = (Boolean) m.get("final");
            if (ctx.taskGrant((String) m.get("role_code"), (UUID) m.get("target_org_id"), scope, fin).isEmpty()
                    || !ctx.assignedToMe((UUID) m.get("assigned_person_id"), (Boolean) m.get("awaiting_assignment"))) {
                continue;
            }
            Instant due = Db.toInstant(m.get("due_at"));
            out.add(new TaskItem(m.get("id").toString(), m.get("request_id").toString(), (String) m.get("number"),
                    (String) m.get("type_name"), (String) m.get("stage_key"), (String) m.get("stage_name"),
                    (String) m.get("role_name"), (String) m.get("org_name"), Db.toInstant(m.get("created_at")).toString(),
                    due.toString(), due.isBefore(now), fin, (Boolean) m.get("requires_signature")));
        }
        return out;
    }

    // ---- approval document ----------------------------------------------------------------------------

    record Canonical(Map<String, Object> document, String sha256, List<DocumentLine> lines) {
    }

    private Canonical canonical(UUID requestId, int revision) {
        Map<String, Object> rev = jdbc.sql("""
                select rv.data::text as data, rv.content_sha256, r.number, r.type_code, t.name as type_name, o.name as owner_name
                from request_revision rv join request r on r.id = rv.request_id join request_type t on t.code = r.type_code
                join organization o on o.id = r.owner_org_id where rv.request_id = :id and rv.revision = :rev""")
                .param("id", requestId).param("rev", revision).query().singleRow();
        JsonNode data = json.tree((String) rev.get("data"));
        List<String> resourceNames = jdbc.sql("select name from resource where id = any(string_to_array(:ids, ',')::uuid[]) order by code")
                .param("ids", String.join(",", json.convert(data.path("resourceIds"), String[].class))).query(String.class).list();
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("requestNumber", rev.get("number"));
        doc.put("requestType", rev.get("type_code"));
        doc.put("revision", revision);
        doc.put("revisionSha256", rev.get("content_sha256"));
        doc.put("ownerOrganization", rev.get("owner_name"));
        doc.put("resources", resourceNames);
        doc.put("period", json.map(data.path("period")));
        doc.put("subject", data.path("subject").asText());
        StringBuilder boundaryLine = new StringBuilder();
        if (data.path("boundaries").isArray()) {
            List<Map<String, Object>> versions = new ArrayList<>();
            for (JsonNode b : data.path("boundaries")) {
                Map<String, Object> v = new LinkedHashMap<>();
                v.put("siteCode", b.path("siteCode").asText());
                v.put("version", b.path("version").isNumber() ? b.path("version").asInt() : null);
                v.put("type", b.path("type").asText());
                versions.add(v);
                if (!boundaryLine.isEmpty()) {
                    boundaryLine.append("، ");
                }
                boolean registered = "Polygon".equals(b.path("type").asText()) || "MultiPolygon".equals(b.path("type").asText());
                boundaryLine.append(b.path("siteName").asText()).append(registered
                        ? " — الإصدار " + b.path("version").asInt() : " — حدود غير مسجلة");
            }
            doc.put("boundaryVersions", versions);
        }
        String sha = Hashing.sha256(json.canonical(doc));
        List<DocumentLine> lines = List.of(
                new DocumentLine("رقم الطلب", (String) rev.get("number")),
                new DocumentLine("نوع الطلب", (String) rev.get("type_name")),
                new DocumentLine("المراجعة", String.valueOf(revision)),
                new DocumentLine("الجهة", (String) rev.get("owner_name")),
                new DocumentLine("المرافق", String.join("، ", resourceNames)),
                new DocumentLine("بداية الفترة", data.path("period").path("start").asText("")),
                new DocumentLine("نهاية الفترة", data.path("period").path("end").isTextual() ? data.path("period").path("end").asText() : "مفتوحة"),
                new DocumentLine("نسخ الحدود", boundaryLine.isEmpty() ? "غير مسجلة في هذه المراجعة" : boundaryLine.toString()),
                new DocumentLine("بصمة المراجعة SHA-256", (String) rev.get("content_sha256")));
        return new Canonical(doc, sha, lines);
    }

    public ApprovalDocumentPreview approvalDocument(AccessContext ctx, UUID taskId) {
        TaskRow t = task(taskId, false);
        RequestScope scope = access.requestScope(t.requestId());
        if (ctx.taskGrant(t.roleCode(), t.targetOrgId(), scope, t.finalStage()).isEmpty()
                || !ctx.assignedToMe(t.assignedPersonId(), t.awaitingAssignment())) {
            throw ApiException.notFound();
        }
        Canonical c = canonical(t.requestId(), t.revision());
        String mode = policies.settings().signatureMode();
        return new ApprovalDocumentPreview(t.revision(), c.sha256(), mode, RequestViews.signatureLabel(mode), c.lines());
    }

    // ---- decide -----------------------------------------------------------------------------------

    @Transactional
    public RequestViews.RequestDetail decide(AccessContext ctx, UUID taskId, DecisionInput in, String idemKey) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("decision", in.decision());
        body.put("note", in.note());
        body.put("reasonCode", in.reasonCode());
        body.put("expectedRevision", in.expectedRevision());
        body.put("signed", in.signature() != null && Boolean.TRUE.equals(in.signature().confirm()));
        UUID[] requestId = new UUID[1];
        return idempotency.run(ctx.actor(), idemKey, "decision:" + taskId, body, () -> {
            requestId[0] = doDecide(ctx, taskId, in);
            return views.detail(ctx, requestId[0]);
        }, () -> views.detail(ctx, task(taskId, false).requestId()));
    }

    private UUID doDecide(AccessContext ctx, UUID taskId, DecisionInput in) {
        String decision = in.decision() == null ? "" : in.decision();
        if (!Set.of("APPROVE", "RETURN", "REJECT").contains(decision)) {
            throw ApiException.validation("القرار يجب أن يكون APPROVE أو RETURN أو REJECT.");
        }
        TaskRow peek = task(taskId, false);
        // Lock the request first, then the task: all decisions on one request are serialised.
        Map<String, Object> req = jdbc.sql("""
                select id, number, status, current_revision, process_instance_id, workflow_version_id, type_code, owner_org_id,
                       target_reservation_id, created_by
                from request where id = :id for update""").param("id", peek.requestId()).query().singleRow();
        TaskRow t = task(taskId, true);
        RequestScope scope = access.requestScope(t.requestId());
        if (ctx.viewLevel(scope) == ViewLevel.NONE && ctx.taskGrant(t.roleCode(), t.targetOrgId(), scope, t.finalStage()).isEmpty()) {
            throw ApiException.notFound();
        }
        if (!"OPEN".equals(t.status()) || !"SUBMITTED".equals(req.get("status"))) {
            throw new ApiException(ErrorCode.TASK_ALREADY_COMPLETED, "هذه المهمة لم تعد مفتوحة؛ ربما أُنجزت أو أُغلقت وفق سياسة المرحلة.");
        }
        // The requester may decide only through a grant that satisfies this stage like anyone else's would.
        boolean byRequester = ctx.personId().equals(req.get("created_by"));
        Grant grant = ctx.taskGrant(t.roleCode(), t.targetOrgId(), scope, t.finalStage())
                .orElseThrow(() -> ApiException.forbidden("لا تملك حالياً صفة هذه المهمة أو نطاقها."));
        if (!ctx.assignedToMe(t.assignedPersonId(), t.awaitingAssignment())) {
            throw ApiException.forbidden(t.awaitingAssignment()
                    ? "المهمة بانتظار أن يسندها مسؤول الصلاحيات إلى شخص مخول."
                    : "المهمة مسندة إلى شخص آخر.");
        }
        int currentRevision = ((Number) req.get("current_revision")).intValue();
        if (in.expectedRevision() == null || in.expectedRevision() != currentRevision || t.revision() != currentRevision) {
            throw ApiException.staleRevision();
        }
        String note = in.note() == null ? null : in.note().trim();
        if (!"APPROVE".equals(decision) && (note == null || note.length() < 5)) {
            throw ApiException.validation("اكتب سبب " + ("RETURN".equals(decision) ? "الإرجاع" : "الرفض") + " بخمسة أحرف على الأقل.");
        }
        if (note != null && note.length() > 2000) {
            throw ApiException.validation("الملاحظة أطول من المسموح.");
        }
        String reasonCode = in.reasonCode();
        if ("RETURN".equals(decision)) {
            reasonCode = reasonCode == null ? "OTHER" : reasonCode;
            if (!REASON_CODES.contains(reasonCode)) {
                throw ApiException.validation("رمز سبب الإرجاع غير معروف.");
            }
        } else {
            reasonCode = null;
        }
        UUID requestIdValue = t.requestId();
        String number = (String) req.get("number");
        String pid = (String) req.get("process_instance_id");
        Instant now = clock.instant();
        Capacity capacity = new Capacity(grant.roleName(), grant.orgName(), grant.delegationId());
        UUID decisionId = UUID.randomUUID();

        // Signature is produced before anything is written, so a provider failure leaves no trace of approval.
        Canonical doc = null;
        SignatureService.Signed signed = null;
        String mode = policies.settings().signatureMode();
        if ("APPROVE".equals(decision) && t.finalStage() && t.requiresSignature() && policies.settings().signatureRequired()) {
            doc = canonical(requestIdValue, currentRevision);
            signed = signatures.sign(mode, ctx.personId(), ctx.actor().sessionId(), grant.roleName(), doc.sha256(), now, in.signature());
        }

        jdbc.sql("""
                insert into decision(id, request_id, revision, task_id, stage_key, stage_name, actor_person_id, actor_name,
                    actor_role_code, actor_role_name, actor_org_id, actor_org_name, via_delegation_id, decision, reason_code,
                    note, decided_at, by_requester)
                values (:id, :req, :rev, :task, :sk, :sn, :pid, :pname, :rc, :rn, :oid, :oname, :del, :dec, :rcode, :note, :now, :self)""")
                .param("id", decisionId).param("req", requestIdValue).param("rev", currentRevision).param("task", t.id())
                .param("sk", t.stageKey()).param("sn", t.stageName()).param("pid", ctx.personId())
                .param("pname", ctx.actor().displayName()).param("rc", grant.roleCode()).param("rn", grant.roleName())
                .param("oid", grant.orgId()).param("oname", grant.orgName()).param("del", grant.delegationId())
                .param("dec", decision).param("rcode", reasonCode).param("note", note).param("now", Db.ts(now))
                .param("self", byRequester).update();

        if (!"APPROVE".equals(decision)) {
            String status = "RETURN".equals(decision) ? "RETURNED" : "REJECTED";
            jdbc.sql("update task_assignment set status = :s, closed_at = :now where id = :id")
                    .param("s", status).param("now", Db.ts(now)).param("id", t.id()).update();
            jdbc.sql("update task_assignment set status = 'CANCELLED', closed_at = :now where request_id = :r and status = 'OPEN'")
                    .param("now", Db.ts(now)).param("r", requestIdValue).update();
            runtime.deleteProcessInstance(pid, status);
            jdbc.sql("""
                    update request set status = :s, last_note = :note, decided_at = :now, updated_at = :now, version = version + 1,
                           process_instance_id = null where id = :id""")
                    .param("s", status).param("note", note).param("now", Db.ts(now)).param("id", requestIdValue).update();
            audit.record(ctx.actor(), capacity, "RETURN".equals(decision) ? "REQUEST_RETURNED" : "REQUEST_REJECTED",
                    "REQUEST", requestIdValue.toString(), number,
                    reasonCode == null ? Map.of("stage", t.stageName(), "byRequester", byRequester)
                            : Map.of("stage", t.stageName(), "reasonCode", reasonCode, "byRequester", byRequester),
                    note, currentRevision);
            outbox.enqueue("REQUEST", requestIdValue.toString(), "REQUEST_" + status,
                    Map.of("requestId", requestIdValue.toString(), "revision", currentRevision));
            return requestIdValue;
        }

        jdbc.sql("update task_assignment set status = 'APPROVED', closed_at = :now where id = :id")
                .param("now", Db.ts(now)).param("id", t.id()).update();
        if (note != null && !note.isEmpty()) {
            jdbc.sql("update request set last_note = :note where id = :id").param("note", note).param("id", requestIdValue).update();
        }
        audit.record(ctx.actor(), capacity, "TASK_APPROVED", "REQUEST", requestIdValue.toString(), number,
                Map.of("stage", t.stageName(), "byRequester", byRequester), note, currentRevision);
        taskService.complete(t.flowableTaskId());
        WorkflowDefinition def = workflows.definition((UUID) req.get("workflow_version_id"));
        boolean ended = runtime.createProcessInstanceQuery().processInstanceId(pid).count() == 0;
        if (!ended) {
            taskSync.sync(requestIdValue, currentRevision, pid, def);
            return requestIdValue;
        }
        if (doc == null) {
            // Final stage did not require a signature (policy): still bind the decision to the revision hash.
            doc = canonical(requestIdValue, currentRevision);
            signed = new SignatureService.Signed(mode, "NO_SIGNATURE_REQUIRED_BY_POLICY");
        }
        jdbc.sql("""
                insert into approval_document(id, request_id, revision, decision_id, canonical, sha256, signature_mode,
                    signer_person_id, signer_name, signer_role, signed_at, evidence)
                values (:id, :req, :rev, :dec, cast(:doc as jsonb), :sha, :mode, :pid, :pname, :role, :now, :ev)""")
                .param("id", UUID.randomUUID()).param("req", requestIdValue).param("rev", currentRevision)
                .param("dec", decisionId).param("doc", json.write(doc.document())).param("sha", doc.sha256())
                .param("mode", signed.mode()).param("pid", ctx.personId()).param("pname", ctx.actor().displayName())
                .param("role", grant.roleName()).param("now", Db.ts(now)).param("ev", signed.evidence()).update();
        audit.record(ctx.actor(), capacity, "APPROVAL_SIGNED", "REQUEST", requestIdValue.toString(), number,
                Map.of("sha256", doc.sha256(), "signatureMode", signed.mode(),
                        "label", RequestViews.signatureLabel(signed.mode())), null, currentRevision);
        finalizeApproval(ctx, requestIdValue, number, currentRevision, req, def, capacity, now);
        return requestIdValue;
    }

    /** Applies the approved revision to reservations. Any conflict aborts the whole transaction. */
    private void finalizeApproval(AccessContext ctx, UUID requestId, String number, int revision, Map<String, Object> req,
                                  WorkflowDefinition def, Capacity capacity, Instant now) {
        String kind = jdbc.sql("select kind from request_type where code = :c").param("c", req.get("type_code"))
                .query(String.class).single();
        WorkflowRuntime.RevisionContext rc = workflowRuntime.load(requestId, revision);
        Map<String, Object> rev = jdbc.sql("select period_start, period_end from request_revision where request_id = :r and revision = :v")
                .param("r", requestId).param("v", revision).query().singleRow();
        Instant start = Db.toInstant(rev.get("period_start"));
        Instant end = Db.toInstant(rev.get("period_end"));
        UUID owner = (UUID) req.get("owner_org_id");
        UUID targetId = (UUID) req.get("target_reservation_id");
        List<String> effects = new ArrayList<>();
        switch (kind) {
            case "NEW_RESERVATION" -> {
                for (UUID resourceId : rc.resourceIds()) {
                    UUID rid = reservations.create(resourceId, owner, requestId, revision, "APPROVAL", start, end,
                            number, ctx.personId());
                    effects.add(rid.toString());
                }
            }
            case "EXTENSION" -> {
                ReservationService.Reservation r = reservations.lock(targetId);
                reservations.changePeriod(r, r.start(), end, requestId, "EXTENSION", ctx.personId());
                effects.add(r.id().toString());
            }
            case "MODIFICATION" -> {
                ReservationService.Reservation r = reservations.lock(targetId);
                reservations.changePeriod(r, start, end, requestId, "MODIFICATION", ctx.personId());
                effects.add(r.id().toString());
            }
            case "CANCELLATION" -> {
                ReservationService.Reservation r = reservations.lock(targetId);
                reservations.end(r, start, "CANCELLED", requestId, "CANCELLATION", ctx.personId());
                effects.add(r.id().toString());
            }
            case "EVACUATION" -> {
                // The reservation is released only when the handover evidence task is completed.
                ReservationService.Reservation r = reservations.lock(targetId);
                if (!"ACTIVE".equals(r.status())) {
                    throw ApiException.validation("الحجز المرتبط لم يعد نشطاً.");
                }
            }
            default -> throw new IllegalStateException(kind);
        }
        List<WorkflowDefinition.ExecTemplate> templates = new ArrayList<>(def.execution());
        if ("EVACUATION".equals(kind) && templates.stream().noneMatch(WorkflowDefinition.ExecTemplate::evidenceRequired)) {
            templates.add(new WorkflowDefinition.ExecTemplate("handover", "تسليم المرفق وإثبات الإخلاء",
                    "FACILITIES_REVIEWER", "RESOURCE_ORG", 1, true));
        }
        for (WorkflowDefinition.ExecTemplate e : templates) {
            List<UUID> targets = switch (e.orgFrom()) {
                case "REQUEST_ORG" -> List.of(owner);
                case "RESOURCE_ORG" -> workflowRuntime.resourceOrgs(rc.resourceIds());
                default -> java.util.Collections.singletonList((UUID) null);
            };
            if (targets.isEmpty()) {
                targets = java.util.Collections.singletonList(null);
            }
            for (UUID org : targets) {
                jdbc.sql("""
                        insert into execution_task(id, request_id, key, name, role_code, target_org_id, due_at, evidence_required,
                                                   status, created_at)
                        values (:id, :req, :k, :n, :role, :org, :due, :ev, 'OPEN', :now)""")
                        .param("id", UUID.randomUUID()).param("req", requestId).param("k", e.key()).param("n", e.name())
                        .param("role", e.role()).param("org", org).param("due", Db.ts(now.plus(Duration.ofDays(e.dueDays()))))
                        .param("ev", e.evidenceRequired()).param("now", Db.ts(now)).update();
            }
        }
        jdbc.sql("update request set status = 'APPROVED', decided_at = :now, updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", requestId).update();
        audit.record(ctx.actor(), capacity, "REQUEST_APPROVED", "REQUEST", requestId.toString(), number,
                Map.of("kind", kind, "reservations", effects, "period", Times.iso(start) + " → " + (end == null ? "مفتوحة" : Times.iso(end))),
                null, revision);
        outbox.enqueue("REQUEST", requestId.toString(), "REQUEST_APPROVED",
                Map.of("requestId", requestId.toString(), "revision", revision));
    }
}
