package ae.mover.requests;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.RequestScope;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.common.PageResult;
import ae.mover.common.Ref;
import ae.mover.forms.FormService;
import ae.mover.workflow.WorkflowDefinition;
import ae.mover.workflow.WorkflowService;

/**
 * Read models for requests. SUMMARY viewers receive records in which occupant organisation, participants, values,
 * attachments, people and history are absent from the JSON altogether (not merely hidden by the UI).
 */
@Service
public class RequestViews {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AccessService access;
    private final WorkflowService workflows;
    private final FormService forms;

    public RequestViews(JdbcClient jdbc, Json json, Clock clock, AccessService access, WorkflowService workflows,
                        FormService forms) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.access = access;
        this.workflows = workflows;
        this.forms = forms;
    }

    public record TypeRef(String code, String name, String kind) {
    }

    public record ResourceRef(String id, String name, String siteId) {
    }

    public record Period(String start, String end) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RequestListItem(String id, String number, TypeRef type, String status, String subject, Ref ownerOrg,
                                  List<ResourceRef> resources, Period period, int revision, String view, String updatedAt,
                                  boolean createdByMe) {
    }

    public record TaskView(String id, String roleName, String orgName, String state, String decidedBy, String decidedAt) {
    }

    public record StageView(String key, String name, String mode, int slaDays, String state, List<TaskView> tasks) {
    }

    public record HistoryItem(String event, String actor, String at, String note) {
    }

    public record ApprovalDocumentView(int revision, String sha256, String signatureMode, String signatureLabel,
                                       String signerName, String signerRole, String signedAt) {
    }

    public record ReservationRef(String id, String resourceName, Period period, String status) {
    }

    public record TargetReservation(String id, String resourceName, Period period, String status) {
    }

    public record ExecutionTaskView(String id, String key, String name, String roleName, String orgName, String dueAt,
                                    String status, boolean evidenceRequired, String completedBy, String completedAt,
                                    String note, boolean overdue, boolean canComplete) {
    }

    public record AttachmentView(String id, String fieldId, String fileName, String contentType, long size, String sha256,
                                 int version, String scanStatus, String scanDetail, String uploadedAt) {
    }

    public record MyTask(String taskId, String stageKey, String stageName, String roleName, boolean finalStage,
                         boolean requiresSignature) {
        @com.fasterxml.jackson.annotation.JsonProperty("final")
        public boolean isFinal() {
            return finalStage;
        }
    }

    public record Actions(boolean canEditDraft, boolean canSubmit, boolean canClose, List<MyTask> myTasks) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RequestDetail(
            String id, String number, TypeRef type, String status, String subject, Ref ownerOrg,
            List<ResourceRef> resources, Period period, int revision, String view, String updatedAt, boolean createdByMe,
            int version, String unit, String origin, List<Ref> participantOrgs, List<Ref> infoOrgs,
            Map<String, Object> values, List<AttachmentView> attachments,
            @JsonInclude(JsonInclude.Include.ALWAYS) TargetReservation targetReservation,
            Map<String, Object> formVersion, @JsonInclude(JsonInclude.Include.ALWAYS) Map<String, Object> workflowVersion,
            Ref createdBy, String createdAt, @JsonInclude(JsonInclude.Include.ALWAYS) String submittedAt,
            @JsonInclude(JsonInclude.Include.ALWAYS) String lastNote,
            List<StageView> stages, List<HistoryItem> history,
            @JsonInclude(JsonInclude.Include.ALWAYS) ApprovalDocumentView approvalDocument,
            List<ReservationRef> reservations, List<ExecutionTaskView> executionTasks, Actions actions) {
    }

    // ---- list ---------------------------------------------------------------------------------------

    public PageResult<RequestListItem> list(AccessContext ctx, String status, String q, Integer page, Integer size,
                                            boolean excludeDrafts, boolean mine) {
        int p = PageResult.page(page);
        int s = PageResult.size(size);
        Map<String, Object> params = new HashMap<>();
        StringBuilder where = new StringBuilder(access.requestPredicate(ctx, params));
        if (status != null && !status.isBlank()) {
            where.append(" and r.status = :status");
            params.put("status", status);
        }
        if (excludeDrafts) {
            where.append(" and r.status <> 'DRAFT'");
        }
        if (mine) {
            where.append(" and r.created_by = :me");
            params.put("me", ctx.personId());
        }
        if (q != null && !q.isBlank()) {
            where.append(" and (r.number ilike :q or coalesce(r.draft->>'subject', '') ilike :q or t.name ilike :q)");
            params.put("q", "%" + q.trim().replace("%", "") + "%");
        }
        long total = jdbc.sql("select count(*) from request r join request_type t on t.code = r.type_code where " + where)
                .params(params).query(Long.class).single();
        params.put("limit", s);
        params.put("offset", p * s);
        List<Map<String, Object>> rows = jdbc.sql("""
                select r.id, r.number, r.status, r.type_code, t.name as type_name, t.kind, r.draft->>'subject' as subject,
                       r.owner_org_id, o.name as owner_name, r.period_start, r.period_end, r.current_revision, r.updated_at,
                       r.created_by
                from request r join request_type t on t.code = r.type_code join organization o on o.id = r.owner_org_id
                where""" + " " + where + " order by r.updated_at desc limit :limit offset :offset")
                .params(params).query().listOfRows();
        List<UUID> ids = rows.stream().map(m -> (UUID) m.get("id")).toList();
        Map<UUID, RequestScope> scopes = access.scopes(ids);
        Map<UUID, List<ResourceRef>> resources = resources(ids);
        List<RequestListItem> items = new ArrayList<>();
        for (Map<String, Object> m : rows) {
            UUID id = (UUID) m.get("id");
            ViewLevel level = ctx.viewLevel(scopes.get(id));
            if (level == ViewLevel.NONE) {
                continue; // defensive: predicate and evaluator must agree
            }
            boolean full = level == ViewLevel.FULL;
            items.add(new RequestListItem(id.toString(), (String) m.get("number"),
                    new TypeRef((String) m.get("type_code"), (String) m.get("type_name"), (String) m.get("kind")),
                    (String) m.get("status"), subject(m, full), full ? Ref.of((UUID) m.get("owner_org_id"), (String) m.get("owner_name")) : null,
                    resources.getOrDefault(id, List.of()),
                    new Period(iso(m.get("period_start")), iso(m.get("period_end"))),
                    ((Number) m.get("current_revision")).intValue(), level.name(), iso(m.get("updated_at")),
                    ctx.personId().equals(m.get("created_by"))));
        }
        return new PageResult<>(items, p, s, total);
    }

    private static String subject(Map<String, Object> m, boolean full) {
        if (!full) {
            return m.get("type_name") + " — " + m.get("number");
        }
        Object s = m.get("subject");
        return s == null || String.valueOf(s).isBlank() ? (String) m.get("type_name") : String.valueOf(s);
    }

    private static String iso(Object ts) {
        Instant i = Db.toInstant(ts);
        return i == null ? null : i.toString();
    }

    private Map<UUID, List<ResourceRef>> resources(List<UUID> requestIds) {
        Map<UUID, List<ResourceRef>> out = new HashMap<>();
        if (requestIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select rr.request_id, r.id, r.name, r.site_id from request_resource rr join resource r on r.id = rr.resource_id
                where rr.request_id = any(string_to_array(:ids, ',')::uuid[]) order by r.code""")
                .param("ids", Db.ids(requestIds)).query((rs, n) -> {
                    out.computeIfAbsent(Db.uuid(rs, "request_id"), k -> new ArrayList<>())
                            .add(new ResourceRef(rs.getString("id"), rs.getString("name"), rs.getString("site_id")));
                    return null;
                }).list();
        return out;
    }

    // ---- detail -------------------------------------------------------------------------------------

    public RequestDetail detail(AccessContext ctx, UUID id) {
        RequestScope scope = access.requestScope(id);
        ViewLevel level = ctx.viewLevel(scope);
        if (level == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        boolean full = level == ViewLevel.FULL;
        Map<String, Object> r = jdbc.sql("""
                select r.*, r.draft::text as draft_text, t.name as type_name, t.kind, o.name as owner_name,
                       p.display_name as creator_name
                from request r join request_type t on t.code = r.type_code join organization o on o.id = r.owner_org_id
                join person p on p.id = r.created_by where r.id = :id""")
                .param("id", id).query().listOfRows().get(0);
        String status = (String) r.get("status");
        int revision = ((Number) r.get("current_revision")).intValue();
        JsonNode draft = json.tree((String) r.get("draft_text"));
        UUID wfVersionId = (UUID) r.get("workflow_version_id");
        WorkflowDefinition def = null;
        Map<String, Object> wfRef = null;
        if (wfVersionId != null) {
            def = workflows.definition(wfVersionId);
            wfRef = Map.of("id", wfVersionId.toString(), "version", workflows.versionNumber(wfVersionId), "name", def.name());
        } else {
            WorkflowService.PublishedWorkflow wf = workflows.latestPublished((String) r.get("type_code"));
            if (wf != null) {
                def = wf.definition(); // route preview for drafts (not pinned until submission)
            }
        }
        UUID formVersionId = (UUID) r.get("form_version_id");
        Map<String, Object> formRef = new LinkedHashMap<>();
        formRef.put("id", formVersionId.toString());
        formRef.put("version", forms.versionNumber(formVersionId));
        if (full) {
            formRef.put("schema", forms.schema(formVersionId));
        }

        List<StageView> stages = def == null ? List.of() : stages(id, revision, status, def, r.get("process_instance_id") != null
                || !"DRAFT".equals(status));
        if (!full) {
            stages = stages.stream().map(s -> new StageView(s.key(), s.name(), s.mode(), s.slaDays(), s.state(),
                    s.tasks().stream().map(t -> new TaskView(t.id(), t.roleName(), null, t.state(), null, null)).toList())).toList();
        }
        List<MyTask> myTasks = new ArrayList<>();
        if ("SUBMITTED".equals(status)) {
            jdbc.sql("select t.*, rd.name as role_name from task_assignment t join role_def rd on rd.code = t.role_code where t.request_id = :id and t.status = 'OPEN' order by t.created_at")
                    .param("id", id).query((rs, n) -> {
                        UUID target = Db.uuid(rs, "target_org_id");
                        if (ctx.taskGrant(rs.getString("role_code"), target, scope, rs.getBoolean("final")).isPresent()) {
                            myTasks.add(new MyTask(rs.getString("id"), rs.getString("stage_key"), rs.getString("stage_name"),
                                    rs.getString("role_name"), rs.getBoolean("final"), rs.getBoolean("requires_signature")));
                        }
                        return null;
                    }).list();
        }
        boolean creator = ctx.personId().equals(r.get("created_by"));
        boolean editable = ctx.mayModify((UUID) r.get("created_by"), (UUID) r.get("owner_org_id"), status);
        List<ExecutionTaskView> exec = executionTasks(ctx, id, scope);
        boolean canClose = "APPROVED".equals(status) && exec.stream().allMatch(e -> "DONE".equals(e.status()))
                && (creator || ctx.grants().stream().anyMatch(g -> g.has(Permission.REVIEW) && g.covers(scope.relatedOrgs(), scope.siteIds())));

        UUID targetId = (UUID) r.get("target_reservation_id");
        TargetReservation target = targetId == null ? null : jdbc.sql("""
                select v.id, v.period_start, v.period_end, v.status, res.name from reservation v join resource res on res.id = v.resource_id
                where v.id = :id""").param("id", targetId)
                .query((rs, n) -> new TargetReservation(rs.getString("id"), rs.getString("name"),
                        new Period(Db.iso(rs, "period_start"), Db.iso(rs, "period_end")), rs.getString("status"))).single();

        return new RequestDetail(id.toString(), (String) r.get("number"),
                new TypeRef((String) r.get("type_code"), (String) r.get("type_name"), (String) r.get("kind")), status,
                subject(Map.of("type_name", r.get("type_name"), "number", r.get("number"),
                        "subject", draft.path("subject").isTextual() ? draft.path("subject").asText() : ""), full),
                full ? Ref.of((UUID) r.get("owner_org_id"), (String) r.get("owner_name")) : null,
                resources(List.of(id)).getOrDefault(id, List.of()),
                new Period(iso(r.get("period_start")), iso(r.get("period_end"))), revision, level.name(),
                iso(r.get("updated_at")), creator, ((Number) r.get("version")).intValue(),
                draft.path("unit").asText("DAYS"), (String) r.get("origin"),
                full ? orgs(id, "PARTICIPANT") : null, full ? orgs(id, "INFO") : null,
                full ? json.map(draft.path("values")) : null, full ? attachments(id) : null, target,
                formRef, wfRef,
                full ? Ref.of((UUID) r.get("created_by"), (String) r.get("creator_name")) : null,
                iso(r.get("created_at")), iso(r.get("submitted_at")), full ? (String) r.get("last_note") : null,
                stages, full ? history(id) : List.of(), approvalDocument(id, full),
                reservations(id, full), full ? exec : List.of(),
                new Actions(editable, editable, canClose, myTasks));
    }

    private List<StageView> stages(UUID requestId, int revision, String status, WorkflowDefinition def, boolean started) {
        Map<String, List<TaskView>> tasks = new LinkedHashMap<>();
        Map<String, Boolean> open = new HashMap<>();
        if (started) {
            jdbc.sql("""
                    select t.id, t.stage_key, t.status, rd.name as role_name, o.name as org_name,
                           (select d.actor_name from decision d where d.task_id = t.id order by d.decided_at desc limit 1) as decided_by,
                           (select d.decided_at from decision d where d.task_id = t.id order by d.decided_at desc limit 1) as decided_at
                    from task_assignment t join role_def rd on rd.code = t.role_code left join organization o on o.id = t.target_org_id
                    where t.request_id = :id and t.revision = :rev order by t.created_at""")
                    .param("id", requestId).param("rev", revision).query((rs, n) -> {
                        String key = rs.getString("stage_key");
                        tasks.computeIfAbsent(key, k -> new ArrayList<>()).add(new TaskView(rs.getString("id"),
                                rs.getString("role_name"), rs.getString("org_name"), rs.getString("status"),
                                rs.getString("decided_by"), Db.iso(rs, "decided_at")));
                        if ("OPEN".equals(rs.getString("status"))) {
                            open.put(key, true);
                        }
                        return null;
                    }).list();
        }
        List<String> carried = started ? jdbc.sql("select unnest(carried_stages) from request_revision where request_id = :id and revision = :rev")
                .param("id", requestId).param("rev", revision).query(String.class).list() : List.of();
        Map<String, String> roleNames = new HashMap<>();
        jdbc.sql("select code, name from role_def").query((rs, n) -> roleNames.put(rs.getString("code"), rs.getString("name"))).list();
        boolean decided = List.of("APPROVED", "CLOSED").contains(status);
        List<StageView> out = new ArrayList<>();
        for (WorkflowDefinition.Stage s : def.stages()) {
            List<TaskView> t = tasks.get(s.key());
            String state;
            if (carried.contains(s.key())) {
                state = "CARRIED";
            } else if (t == null) {
                state = decided ? "SKIPPED" : "PENDING";
            } else if (open.containsKey(s.key())) {
                state = "SUBMITTED".equals(status) ? "ACTIVE" : "PENDING";
            } else {
                state = t.stream().anyMatch(x -> "APPROVED".equals(x.state())) ? "COMPLETE" : "PENDING";
            }
            if (t == null) {
                t = s.assignees().stream().map(a -> new TaskView(null, roleNames.getOrDefault(a.role(), a.role()), null,
                        "CARRIED".equals(state) ? "APPROVED" : "PENDING", null, null)).toList();
            }
            out.add(new StageView(s.key(), s.name(), s.mode(), s.slaDays(), state, t));
        }
        return out;
    }

    private List<Ref> orgs(UUID requestId, String relation) {
        return jdbc.sql("""
                select o.id, o.name, o.code from request_participant p join organization o on o.id = p.organization_id
                where p.request_id = :id and p.relation = :rel order by o.code""")
                .param("id", requestId).param("rel", relation)
                .query((rs, n) -> Ref.of(Db.uuid(rs, "id"), rs.getString("name"), rs.getString("code"))).list();
    }

    public List<AttachmentView> attachments(UUID requestId) {
        return jdbc.sql("""
                select * from attachment where request_id = :id and superseded_by is null order by field_id, version""")
                .param("id", requestId)
                .query((rs, n) -> new AttachmentView(rs.getString("id"), rs.getString("field_id"), rs.getString("file_name"),
                        rs.getString("content_type"), rs.getLong("size_bytes"), rs.getString("sha256"), rs.getInt("version"),
                        rs.getString("scan_status"), rs.getString("scan_detail"), Db.iso(rs, "uploaded_at"))).list();
    }

    private List<HistoryItem> history(UUID requestId) {
        return jdbc.sql("""
                select action, actor_name, actor_role, occurred_at, reason, detail->>'note' as note,
                       coalesce((detail->>'byRequester')::boolean, false) as by_requester from audit_event
                where entity_type = 'REQUEST' and entity_id = :id order by id""")
                .param("id", requestId.toString())
                .query((rs, n) -> new HistoryItem(AuditService.LABELS.getOrDefault(rs.getString("action"), rs.getString("action")),
                        (rs.getString("actor_role") == null ? rs.getString("actor_name") : rs.getString("actor_name") + " — " + rs.getString("actor_role"))
                                + (rs.getBoolean("by_requester") ? " (مقدم الطلب)" : ""),
                        Db.iso(rs, "occurred_at"), rs.getString("reason") != null ? rs.getString("reason") : rs.getString("note")))
                .list();
    }

    private ApprovalDocumentView approvalDocument(UUID requestId, boolean full) {
        return jdbc.sql("select * from approval_document where request_id = :id order by revision desc limit 1")
                .param("id", requestId)
                .query((rs, n) -> new ApprovalDocumentView(rs.getInt("revision"), rs.getString("sha256"),
                        rs.getString("signature_mode"), signatureLabel(rs.getString("signature_mode")),
                        full ? rs.getString("signer_name") : "صاحب الاعتماد", rs.getString("signer_role"), Db.iso(rs, "signed_at")))
                .optional().orElse(null);
    }

    public static String signatureLabel(String mode) {
        return "PKI".equals(mode)
                ? "توقيع رقمي بشهادة (مزود PKI)"
                : "توثيق داخلي بإعادة التحقق من هوية المعتمد — ليس توقيعاً رقمياً بشهادة";
    }

    private List<ReservationRef> reservations(UUID requestId, boolean full) {
        return jdbc.sql("""
                select v.id, res.name, v.period_start, v.period_end, v.status from reservation v join resource res on res.id = v.resource_id
                where v.request_id = :id
                   or v.id in (select target_reservation_id from request where id = :id and status in ('APPROVED', 'CLOSED'))
                order by res.code""")
                .param("id", requestId)
                .query((rs, n) -> new ReservationRef(rs.getString("id"), rs.getString("name"),
                        new Period(Db.iso(rs, "period_start"), Db.iso(rs, "period_end")), rs.getString("status"))).list();
    }

    public List<ExecutionTaskView> executionTasks(AccessContext ctx, UUID requestId, RequestScope scope) {
        Instant now = clock.instant();
        return jdbc.sql("""
                select e.*, rd.name as role_name, o.name as org_name, p.display_name as completer
                from execution_task e join role_def rd on rd.code = e.role_code left join organization o on o.id = e.target_org_id
                left join person p on p.id = e.completed_by where e.request_id = :id order by e.created_at, e.key""")
                .param("id", requestId)
                .query((rs, n) -> {
                    boolean open = "OPEN".equals(rs.getString("status"));
                    Instant due = Db.instant(rs, "due_at");
                    boolean can = open && ctx.executionGrant(rs.getString("role_code"), Db.uuid(rs, "target_org_id"), scope).isPresent();
                    return new ExecutionTaskView(rs.getString("id"), rs.getString("key"), rs.getString("name"),
                            rs.getString("role_name"), rs.getString("org_name"), due.toString(), rs.getString("status"),
                            rs.getBoolean("evidence_required"), rs.getString("completer"), Db.iso(rs, "completed_at"),
                            rs.getString("note"), open && due.isBefore(now), can);
                }).list();
    }
}
