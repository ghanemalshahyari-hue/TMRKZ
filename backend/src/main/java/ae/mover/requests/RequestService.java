package ae.mover.requests;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

import org.flowable.engine.RuntimeService;
import org.flowable.engine.runtime.ProcessInstance;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import ae.mover.common.Json;
import ae.mover.common.Times;
import ae.mover.facilities.BoundaryService;
import ae.mover.forms.FormSchemas;
import ae.mover.forms.FormService;
import ae.mover.forms.RuleLanguage.Problem;
import ae.mover.outbox.OutboxService;
import ae.mover.policy.PolicyService;
import ae.mover.policy.Settings;
import ae.mover.requests.Commands.DraftInput;
import ae.mover.requests.Commands.SubmitInput;
import ae.mover.reservations.ReservationService;
import ae.mover.system.IdempotencyService;
import ae.mover.workflow.TaskSync;
import ae.mover.workflow.WorkflowDefinition;
import ae.mover.workflow.WorkflowService;

@Service
public class RequestService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AccessService access;
    private final RequestTypes types;
    private final FormService forms;
    private final WorkflowService workflows;
    private final PolicyService policies;
    private final ReservationService reservations;
    private final RuntimeService runtime;
    private final TaskSync taskSync;
    private final AuditService audit;
    private final OutboxService outbox;
    private final IdempotencyService idempotency;
    private final RequestViews views;
    private final BoundaryService boundaries;

    public RequestService(JdbcClient jdbc, Json json, Clock clock, AccessService access, RequestTypes types,
                          FormService forms, WorkflowService workflows, PolicyService policies,
                          ReservationService reservations, RuntimeService runtime, TaskSync taskSync,
                          AuditService audit, OutboxService outbox, IdempotencyService idempotency, RequestViews views,
                          BoundaryService boundaries) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.access = access;
        this.types = types;
        this.forms = forms;
        this.workflows = workflows;
        this.policies = policies;
        this.reservations = reservations;
        this.runtime = runtime;
        this.taskSync = taskSync;
        this.audit = audit;
        this.outbox = outbox;
        this.idempotency = idempotency;
        this.views = views;
        this.boundaries = boundaries;
    }

    /** Working copy of a request held in {@code request.draft}. */
    record Draft(String subject, String unit, Instant start, Instant end, List<UUID> resourceIds,
                 List<UUID> participantOrgIds, List<UUID> infoOrgIds, Map<String, Object> values) {

        Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("subject", subject);
            m.put("unit", unit);
            Map<String, Object> period = new LinkedHashMap<>();
            period.put("start", Times.iso(start));
            period.put("end", Times.iso(end));
            m.put("period", period);
            m.put("resourceIds", resourceIds.stream().map(UUID::toString).toList());
            m.put("participantOrgIds", participantOrgIds.stream().map(UUID::toString).toList());
            m.put("infoOrgIds", infoOrgIds.stream().map(UUID::toString).toList());
            m.put("values", values);
            return m;
        }
    }

    Draft readDraft(String text) {
        JsonNode d = json.tree(text);
        return new Draft(d.path("subject").isTextual() ? d.path("subject").asText() : null,
                d.path("unit").asText("DAYS"),
                Times.parse(d.path("period").path("start").isTextual() ? d.path("period").path("start").asText() : null, "start"),
                Times.parse(d.path("period").path("end").isTextual() ? d.path("period").path("end").asText() : null, "end"),
                uuidList(d.path("resourceIds")), uuidList(d.path("participantOrgIds")), uuidList(d.path("infoOrgIds")),
                json.map(d.path("values")));
    }

    private static List<UUID> uuidList(JsonNode arr) {
        List<UUID> out = new ArrayList<>();
        arr.forEach(n -> out.add(UUID.fromString(n.asText())));
        return out;
    }

    private static List<UUID> parseIds(List<String> ids, String label) {
        if (ids == null) {
            return null;
        }
        List<UUID> out = new ArrayList<>();
        for (String id : new LinkedHashSet<>(ids)) {
            try {
                out.add(UUID.fromString(id));
            } catch (IllegalArgumentException | NullPointerException e) {
                throw ApiException.validation("معرف غير صالح في «" + label + "».");
            }
        }
        return out;
    }

    // ---- create / edit -------------------------------------------------------------------------------

    @Transactional
    public UUID create(AccessContext ctx, DraftInput in) {
        ctx.require(Permission.CREATE);
        RequestTypes.Type type = types.get(in.typeCode());
        String origin = in.origin() == null ? "LIST" : in.origin();
        if (!origin.equals("MAP") && !origin.equals("LIST")) {
            throw ApiException.validation("مصدر الطلب يجب أن يكون MAP أو LIST.");
        }
        UUID owner = in.ownerOrgId() != null ? parseIds(List.of(in.ownerOrgId()), "الجهة").get(0) : defaultOrg(ctx);
        requireOrgExists(owner);
        if (!ctx.canFor(Permission.CREATE, owner)) {
            throw ApiException.forbidden("لا تملك إنشاء طلبات باسم هذه الجهة.");
        }
        Settings settings = policies.settings();
        UUID target = null;
        if (type.requiresTarget()) {
            if (in.targetReservationId() == null) {
                throw ApiException.validation("اختر الحجز المعتمد المرتبط بالطلب.");
            }
            target = parseIds(List.of(in.targetReservationId()), "الحجز المرتبط").get(0);
        }
        Draft draft = new Draft(null, settings.defaultUnit(), null, null, List.of(), List.of(), List.of(), new LinkedHashMap<>());
        draft = merge(ctx, draft, in, type, target);
        FormService.PublishedForm form = forms.latestPublished(type.code());
        UUID id = UUID.randomUUID();
        long seq = jdbc.sql("select nextval('request_number_seq')").query(Long.class).single();
        String number = "MV-" + clock.instant().atZone(ZoneOffset.UTC).getYear() + "-" + String.format("%04d", seq);
        Instant now = clock.instant();
        jdbc.sql("""
                insert into request(id, number, type_code, status, origin, owner_org_id, created_by, created_at, updated_at,
                                    draft, period_start, period_end, target_reservation_id, form_version_id)
                values (:id, :num, :type, 'DRAFT', :origin, :owner, :by, :now, :now, cast(:draft as jsonb), :s, :e, :target, :form)""")
                .param("id", id).param("num", number).param("type", type.code()).param("origin", origin)
                .param("owner", owner).param("by", ctx.personId()).param("now", Db.ts(now))
                .param("draft", json.write(draft.toJson())).param("s", Db.ts(draft.start())).param("e", Db.ts(draft.end()))
                .param("target", target).param("form", form.id()).update();
        writeRelations(id, draft);
        audit.recordAs(ctx.actor(), "REQUEST_CREATED", "REQUEST", id.toString(), number,
                Map.of("type", type.name(), "origin", origin), null);
        return id;
    }

    private UUID defaultOrg(AccessContext ctx) {
        return ctx.grants().stream().filter(g -> g.has(Permission.CREATE) && g.delegationId() == null)
                .map(g -> g.orgId()).findFirst()
                .orElseThrow(() -> ApiException.validation("حدد الجهة الطالبة."));
    }

    private void requireOrgExists(UUID orgId) {
        boolean ok = jdbc.sql("select count(*) from organization where id = :id and status = 'ACTIVE'").param("id", orgId)
                .query(Integer.class).single() > 0;
        if (!ok) {
            throw ApiException.validation("الجهة غير موجودة أو غير نشطة.");
        }
    }

    @Transactional
    public void updateDraft(AccessContext ctx, UUID id, DraftInput in) {
        Map<String, Object> row = lockRow(id);
        requireEditable(ctx, row);
        if (in.expectedVersion() == null || in.expectedVersion() != ((Number) row.get("version")).intValue()) {
            throw ApiException.staleRevision();
        }
        RequestTypes.Type type = types.get((String) row.get("type_code"));
        if (in.typeCode() != null && !in.typeCode().equals(type.code())) {
            throw ApiException.validation("لا يمكن تغيير نوع الطلب بعد إنشائه.");
        }
        UUID owner = (UUID) row.get("owner_org_id");
        if (in.ownerOrgId() != null && !in.ownerOrgId().equals(owner.toString())) {
            if ("RETURNED".equals(row.get("status"))) {
                throw ApiException.validation("لا يمكن تغيير الجهة الطالبة بعد التقديم.");
            }
            owner = parseIds(List.of(in.ownerOrgId()), "الجهة").get(0);
            requireOrgExists(owner);
            if (!ctx.canFor(Permission.CREATE, owner)) {
                throw ApiException.forbidden("لا تملك إنشاء طلبات باسم هذه الجهة.");
            }
        }
        Draft draft = merge(ctx, readDraft((String) row.get("draft")), in, type, (UUID) row.get("target_reservation_id"));
        jdbc.sql("""
                update request set draft = cast(:d as jsonb), owner_org_id = :owner, period_start = :s, period_end = :e,
                       version = version + 1, updated_at = :now where id = :id""")
                .param("d", json.write(draft.toJson())).param("owner", owner).param("s", Db.ts(draft.start()))
                .param("e", Db.ts(draft.end())).param("now", Db.ts(clock.instant())).param("id", id).update();
        writeRelations(id, draft);
        audit.recordAs(ctx.actor(), "DRAFT_SAVED", "REQUEST", id.toString(), (String) row.get("number"), Map.of(), null);
    }

    private Map<String, Object> lockRow(UUID id) {
        return jdbc.sql("""
                select id, number, type_code, status, owner_org_id, created_by, version, current_revision, draft::text as draft,
                       target_reservation_id, form_version_id, workflow_version_id, process_instance_id
                from request where id = :id for update""")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
    }

    private void requireEditable(AccessContext ctx, Map<String, Object> row) {
        if (!ctx.personId().equals(row.get("created_by"))) {
            if (access.requestScope((UUID) row.get("id")) != null
                    && ctx.viewLevel(access.requestScope((UUID) row.get("id"))) == ViewLevel.NONE) {
                throw ApiException.notFound();
            }
            throw ApiException.forbidden("يعدّل الطلب مقدمه فقط.");
        }
        String status = (String) row.get("status");
        if (!"DRAFT".equals(status) && !"RETURNED".equals(status)) {
            throw ApiException.validation("لا يمكن تعديل الطلب في حالته الحالية.");
        }
        if (!ctx.mayModify((UUID) row.get("created_by"), (UUID) row.get("owner_org_id"), status)) {
            throw ApiException.forbidden("DRAFT".equals(status)
                    ? "لم تعد تملك صلاحية إنشاء الطلبات أو تعديلها لهذه الجهة."
                    : "تعديل الطلب المعاد يتطلب صلاحية التعديل على الجهة الطالبة.");
        }
    }

    private Draft merge(AccessContext ctx, Draft base, DraftInput in, RequestTypes.Type type, UUID target) {
        String subject = in.subject() != null ? in.subject().trim() : base.subject();
        if (subject != null && subject.length() > 200) {
            throw ApiException.validation("عنوان الطلب أطول من 200 حرف.");
        }
        String unit = in.unit() != null ? in.unit() : base.unit();
        if (!"DAYS".equals(unit) && !"HOURS".equals(unit)) {
            throw ApiException.validation("وحدة الفترة يجب أن تكون DAYS أو HOURS.");
        }
        Instant start = base.start();
        Instant end = base.end();
        if (in.period() != null) {
            start = Times.parse(in.period().start(), "بداية الفترة");
            end = Times.parse(in.period().end(), "نهاية الفترة");
        }
        List<UUID> resources = in.resourceIds() != null ? parseIds(in.resourceIds(), "المرافق") : base.resourceIds();
        if (target != null) {
            ReservationService.Reservation r = reservations.get(target);
            if (!ctx.canFor(Permission.CREATE, r.organizationId())) {
                throw ApiException.notFound();
            }
            resources = List.of(r.resourceId());
        }
        for (UUID rid : resources) {
            Map<String, Object> res = jdbc.sql("""
                    select r.status, r.site_id, sr.organization_id from resource r
                    left join site_responsibility sr on sr.site_id = r.site_id and sr.valid_to is null where r.id = :id""")
                    .param("id", rid).query().listOfRows().stream().findFirst()
                    .orElseThrow(() -> ApiException.validation("أحد المرافق المحددة غير موجود."));
            if (!"ACTIVE".equals(res.get("status"))) {
                throw ApiException.validation("أحد المرافق المحددة غير متاح للطلبات الجديدة.");
            }
            if (target == null && ctx.siteView((UUID) res.get("site_id"), Set.of(), (UUID) res.get("organization_id")) == ViewLevel.NONE) {
                throw ApiException.validation("أحد المرافق المحددة غير موجود.");
            }
        }
        List<UUID> participants = in.participantOrgIds() != null ? parseIds(in.participantOrgIds(), "الجهات المشاركة") : base.participantOrgIds();
        List<UUID> info = in.infoOrgIds() != null ? parseIds(in.infoOrgIds(), "جهات للعلم") : base.infoOrgIds();
        for (UUID org : concat(participants, info)) {
            requireOrgExists(org);
        }
        Map<String, Object> values = new LinkedHashMap<>(base.values());
        if (in.values() != null) {
            in.values().forEach((k, v) -> {
                if (k.length() > 40) {
                    throw ApiException.validation("معرف حقل غير صالح.");
                }
                if (v instanceof Map || v instanceof List) {
                    throw ApiException.validation("قيم الحقول يجب أن تكون نصوصاً أو أرقاماً.");
                }
                values.put(k, v);
            });
        }
        return new Draft(subject, unit, start, end, resources, participants, info, values);
    }

    private static List<UUID> concat(List<UUID> a, List<UUID> b) {
        List<UUID> out = new ArrayList<>(a);
        out.addAll(b);
        return out;
    }

    private void writeRelations(UUID id, Draft d) {
        jdbc.sql("delete from request_resource where request_id = :id").param("id", id).update();
        for (UUID r : d.resourceIds()) {
            jdbc.sql("insert into request_resource(request_id, resource_id) values (:id, :r)").param("id", id).param("r", r).update();
        }
        jdbc.sql("delete from request_participant where request_id = :id").param("id", id).update();
        for (UUID o : d.participantOrgIds()) {
            jdbc.sql("insert into request_participant(request_id, organization_id, relation) values (:id, :o, 'PARTICIPANT') on conflict do nothing")
                    .param("id", id).param("o", o).update();
        }
        for (UUID o : d.infoOrgIds()) {
            jdbc.sql("insert into request_participant(request_id, organization_id, relation) values (:id, :o, 'INFO') on conflict do nothing")
                    .param("id", id).param("o", o).update();
        }
    }

    // ---- submit -------------------------------------------------------------------------------------

    @Transactional
    public RequestViews.RequestDetail submit(AccessContext ctx, UUID id, SubmitInput in, String idemKey) {
        return idempotency.run(ctx.actor(), idemKey, "submit:" + id, in, () -> {
            doSubmit(ctx, id, in);
            return views.detail(ctx, id);
        }, () -> views.detail(ctx, id));
    }

    private void doSubmit(AccessContext ctx, UUID id, SubmitInput in) {
        Map<String, Object> row = lockRow(id);
        requireEditable(ctx, row);
        if (in == null || in.expectedVersion() == null || in.expectedVersion() != ((Number) row.get("version")).intValue()) {
            throw ApiException.staleRevision();
        }
        RequestTypes.Type type = types.get((String) row.get("type_code"));
        Settings settings = policies.settings();
        UUID policyVersion = policies.current().id();
        Draft d = readDraft((String) row.get("draft"));
        UUID targetId = (UUID) row.get("target_reservation_id");
        List<Problem> problems = new ArrayList<>();

        // Structural rules (identical for requests started from the map or the list).
        if (d.resourceIds().isEmpty()) {
            problems.add(new Problem("resourceIds", "اختر مرفقاً واحداً على الأقل."));
        }
        if (d.resourceIds().size() > 1 && (!settings.multiSites() || !type.multiSites())) {
            problems.add(new Problem("resourceIds", "الإعداد الحالي يسمح بمرفق واحد فقط في هذا النوع من الطلبات."));
        }
        if (!d.participantOrgIds().isEmpty() && (!settings.multiOrgs() || !type.multiOrgs())) {
            problems.add(new Problem("participantOrgIds", "الإعداد الحالي لا يسمح بجهات مشاركة في هذا النوع من الطلبات."));
        }
        Instant start = d.start();
        Instant end = d.end();
        ReservationService.Reservation target = targetId == null ? null : reservations.get(targetId);
        if (target != null && !"ACTIVE".equals(target.status())) {
            problems.add(new Problem("targetReservationId", "الحجز المرتبط لم يعد نشطاً."));
        }
        switch (type.kind()) {
            case "NEW_RESERVATION" -> {
                if (start == null) {
                    problems.add(new Problem("period", "حدد بداية الفترة."));
                } else if (end != null && !end.isAfter(start)) {
                    problems.add(new Problem("period", "نهاية الفترة يجب أن تكون بعد بدايتها."));
                } else if (end == null && !type.openEndAllowed()) {
                    problems.add(new Problem("period", "هذا النوع من الطلبات لا يسمح باستخدام مفتوح المدة؛ حدد نهاية الفترة."));
                }
            }
            case "EXTENSION" -> {
                if (target != null) {
                    start = target.start();
                    if (target.end() == null) {
                        problems.add(new Problem("period", "الحجز المرتبط مفتوح النهاية ولا يحتاج تمديداً."));
                    } else if (end == null || !end.isAfter(target.end())) {
                        problems.add(new Problem("period", "التمديد يحتاج نهاية بعد نهاية الحجز الأصلي."));
                    }
                }
            }
            case "MODIFICATION" -> {
                if (start == null || (end != null && !end.isAfter(start))) {
                    problems.add(new Problem("period", "حدد فترة صحيحة للتعديل."));
                }
            }
            default -> { // CANCELLATION, EVACUATION: start = effective date
                if (start == null) {
                    problems.add(new Problem("period", "حدد تاريخ السريان."));
                }
                end = null;
            }
        }

        // Form values against the pinned form version (server-side, regardless of client checks).
        UUID formVersionId = (UUID) row.get("form_version_id");
        JsonNode schema = forms.schema(formVersionId);
        Map<String, Integer> fileCounts = new HashMap<>();
        for (JsonNode f : schema.path("fields")) {
            if ("files".equals(f.path("kind").asText())) {
                fileCounts.put(f.path("id").asText(), jdbc.sql("""
                        select count(*) from attachment where request_id = :r and field_id = :f
                          and scan_status = 'CLEAN' and superseded_by is null""")
                        .param("r", id).param("f", f.path("id").asText()).query(Integer.class).single());
            }
        }
        Map<String, Object> facts = facts(type.code(), d.resourceIds().size(), start, end, d.participantOrgIds().size());
        Map<String, Object> cleanValues = FormSchemas.validateValues(schema, d.values(), facts, new HashMap<>(fileCounts), problems);
        if (!problems.isEmpty()) {
            throw ApiException.validation(problems.get(0).message(),
                    Map.of("errors", problems.stream().map(p -> Map.of("path", p.path(), "message", p.message())).toList()));
        }

        // Pin workflow version at first submission; resubmissions keep the pinned version.
        UUID wfVersion = (UUID) row.get("workflow_version_id");
        if (wfVersion == null) {
            WorkflowService.PublishedWorkflow wf = workflows.latestPublished(type.code());
            if (wf == null) {
                throw new ApiException(ErrorCode.WORKFLOW_NOT_PUBLISHED, "لا يوجد تدفق منشور لهذا النوع من الطلبات.");
            }
            wfVersion = wf.id();
        }
        String processDefinitionId = workflows.processDefinitionId(wfVersion);
        WorkflowDefinition def = workflows.definition(wfVersion);
        int revision = ((Number) row.get("current_revision")).intValue() + 1;
        Instant now = clock.instant();

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("subject", d.subject() == null || d.subject().isBlank() ? type.name() + " — " + resourceNames(d.resourceIds()) : d.subject());
        data.put("unit", d.unit());
        Map<String, Object> period = new LinkedHashMap<>();
        period.put("start", Times.iso(start));
        period.put("end", Times.iso(end));
        data.put("period", period);
        data.put("ownerOrgId", row.get("owner_org_id").toString());
        data.put("resourceIds", d.resourceIds().stream().map(UUID::toString).toList());
        data.put("participantOrgIds", d.participantOrgIds().stream().map(UUID::toString).toList());
        data.put("infoOrgIds", d.infoOrgIds().stream().map(UUID::toString).toList());
        data.put("targetReservationId", targetId == null ? null : targetId.toString());
        data.put("values", cleanValues);
        data.put("attachments", jdbc.sql("""
                select id, field_id, file_name, sha256 from attachment where request_id = :r and scan_status = 'CLEAN'
                  and superseded_by is null order by field_id, version""").param("r", id)
                .query((rs, n) -> Map.of("id", rs.getString("id"), "fieldId", rs.getString("field_id"),
                        "fileName", rs.getString("file_name"), "sha256", rs.getString("sha256"))).list());
        data.put("formVersionId", formVersionId.toString());
        data.put("workflowVersionId", wfVersion.toString());
        // Boundary versions the reviewers decide on; a later edit of the site record does not change this revision.
        data.put("boundaries", boundaries.snapshot(d.resourceIds()));
        String sha = Hashing.sha256(json.canonical(data));

        // D-06: on resubmission decide which earlier stage approvals remain valid.
        List<String> carried = revision > 1 ? carriedStages(id, revision - 1, data, schema, def) : List.of();

        jdbc.sql("""
                insert into request_revision(id, request_id, revision, data, period_start, period_end, form_version_id,
                    workflow_version_id, policy_version_id, submitted_by, submitted_at, reason, content_sha256, carried_stages)
                values (:id, :req, :rev, cast(:data as jsonb), :s, :e, :form, :wf, :pol, :by, :now, :reason, :sha,
                        string_to_array(:carried, ','))""")
                .param("id", UUID.randomUUID()).param("req", id).param("rev", revision).param("data", json.write(data))
                .param("s", Db.ts(start)).param("e", Db.ts(end)).param("form", formVersionId).param("wf", wfVersion)
                .param("pol", policyVersion).param("by", ctx.personId()).param("now", Db.ts(now))
                .param("reason", in.resubmissionReason()).param("sha", sha).param("carried", String.join(",", carried))
                .update();
        if (!carried.isEmpty()) {
            jdbc.sql("""
                    insert into decision(id, request_id, revision, task_id, stage_key, stage_name, actor_person_id, actor_name,
                        actor_role_code, actor_role_name, actor_org_id, actor_org_name, via_delegation_id, decision, note,
                        carried_from, decided_at)
                    select gen_random_uuid(), request_id, :rev, null, stage_key, stage_name, actor_person_id, actor_name,
                        actor_role_code, actor_role_name, actor_org_id, actor_org_name, via_delegation_id, 'CARRIED_FORWARD',
                        'موافقة محمولة من المراجعة ' || revision || ' وفق سياسة التعديل', coalesce(carried_from, id), :now
                    from decision where request_id = :req and revision = :prev and decision in ('APPROVE', 'CARRIED_FORWARD')
                      and stage_key = any(string_to_array(:carried, ','))""")
                    .param("rev", revision).param("now", Db.ts(now)).param("req", id).param("prev", revision - 1)
                    .param("carried", String.join(",", carried)).update();
            audit.recordAs(ctx.actor(), "STAGE_CARRIED_FORWARD", "REQUEST", id.toString(), (String) row.get("number"),
                    Map.of("stages", carried), null);
        }

        Map<String, Object> vars = new HashMap<>();
        vars.put("requestId", id.toString());
        vars.put("revision", revision);
        ProcessInstance pi = runtime.startProcessInstanceById(processDefinitionId, id.toString(), vars);
        jdbc.sql("""
                update request set status = 'SUBMITTED', submitted_at = :now, updated_at = :now, current_revision = :rev,
                       version = version + 1, workflow_version_id = :wf, policy_version_id = :pol, process_instance_id = :pid,
                       period_start = :s, period_end = :e, last_note = null, draft = cast(:draft as jsonb)
                where id = :id""")
                .param("now", Db.ts(now)).param("rev", revision).param("wf", wfVersion).param("pol", policyVersion)
                .param("pid", pi.getId()).param("s", Db.ts(start)).param("e", Db.ts(end))
                .param("draft", json.write(new Draft(d.subject(), d.unit(), start, end, d.resourceIds(), d.participantOrgIds(),
                        d.infoOrgIds(), cleanValues).toJson()))
                .param("id", id).update();
        if (!pi.isEnded()) {
            taskSync.sync(id, revision, pi.getId(), def);
        }
        audit.record(ctx.actor(), AuditService.Capacity.NONE, revision == 1 ? "REQUEST_SUBMITTED" : "REQUEST_RESUBMITTED",
                "REQUEST", id.toString(), (String) row.get("number"),
                Map.of("formVersion", forms.versionNumber(formVersionId), "workflowVersion", workflows.versionNumber(wfVersion),
                        "sha256", sha), in.resubmissionReason(), revision);
        outbox.enqueue("REQUEST", id.toString(), "REQUEST_SUBMITTED", Map.of("requestId", id.toString(), "revision", revision));
    }

    static Map<String, Object> facts(String typeCode, int resourceCount, Instant start, Instant end, int participants) {
        long hours = start != null && end != null ? Duration.between(start, end).toHours() : 0;
        Map<String, Object> facts = new HashMap<>();
        facts.put("resourceCount", resourceCount);
        facts.put("durationHours", hours);
        facts.put("durationDays", end == null ? 36500 : (long) Math.ceil(hours / 24.0));
        facts.put("participantCount", 1 + participants);
        facts.put("requestType", typeCode);
        return facts;
    }

    private String resourceNames(List<UUID> ids) {
        return String.join("، ", jdbc.sql("select name from resource where id = any(string_to_array(:ids, ',')::uuid[]) order by code")
                .param("ids", Db.ids(ids)).query(String.class).list());
    }

    /**
     * Change-impact policy (decision D-06, conservative default): changes to period, facilities, owner, participants or
     * target reservation require full re-approval; field changes follow each field's changePolicy. Stages fully
     * approved in the previous cycle and not affected are carried forward; the final stage always runs again because
     * its signature binds a specific revision.
     */
    private List<String> carriedStages(UUID requestId, int previous, Map<String, Object> data, JsonNode schema,
                                       WorkflowDefinition def) {
        Map<String, Object> prev = jdbc.sql("select data::text from request_revision where request_id = :r and revision = :v")
                .param("r", requestId).param("v", previous).query(String.class).optional().map(json::map).orElse(Map.of());
        for (String key : List.of("period", "resourceIds", "ownerOrgId", "participantOrgIds", "targetReservationId", "boundaries")) {
            if (!sameValue(prev.get(key), data.get(key))) {
                return List.of();
            }
        }
        Set<String> restart = new HashSet<>();
        Map<String, Object> oldValues = json.map(prev.get("values"));
        Map<String, Object> newValues = json.map(data.get("values"));
        Set<String> attachmentFieldsChanged = changedAttachmentFields(prev.get("attachments"), data.get("attachments"));
        for (JsonNode f : schema.path("fields")) {
            String fid = f.path("id").asText();
            boolean changed = "files".equals(f.path("kind").asText())
                    ? attachmentFieldsChanged.contains(fid)
                    : !sameValue(oldValues.get(fid), newValues.get(fid));
            if (!changed) {
                continue;
            }
            String policy = f.path("changePolicy").asText("FULL_REAPPROVAL");
            if ("FULL_REAPPROVAL".equals(policy)) {
                return List.of();
            }
            if ("RESTART_STAGES".equals(policy)) {
                f.path("affectsStages").forEach(s -> restart.add(s.asText()));
                if (!f.has("affectsStages") || f.path("affectsStages").isEmpty()) {
                    return List.of();
                }
            }
        }
        Set<String> approved = new HashSet<>(jdbc.sql("""
                select stage_key from task_assignment where request_id = :r and revision = :v
                group by stage_key
                having bool_and(status in ('APPROVED', 'CLOSED_BY_POLICY')) and bool_or(status = 'APPROVED')""")
                .param("r", requestId).param("v", previous).query(String.class).list());
        approved.addAll(jdbc.sql("select unnest(carried_stages) from request_revision where request_id = :r and revision = :v")
                .param("r", requestId).param("v", previous).query(String.class).list());
        List<String> carried = new ArrayList<>();
        for (WorkflowDefinition.Stage s : def.stages()) {
            if (!s.finalStage() && approved.contains(s.key()) && !restart.contains(s.key())) {
                carried.add(s.key());
            }
        }
        return carried;
    }

    /**
     * Compares stored and new values by canonical JSON text, so 30 read back from jsonb (int) equals 30 produced by
     * validation (long), and numerically equal decimals compare equal.
     */
    private boolean sameValue(Object a, Object b) {
        return Objects.equals(normalise(a), normalise(b));
    }

    private String normalise(Object v) {
        if (v instanceof Number n) {
            return new java.math.BigDecimal(n.toString()).stripTrailingZeros().toPlainString();
        }
        if (v instanceof String s) {
            java.math.BigDecimal d = null;
            try {
                d = new java.math.BigDecimal(s.trim());
            } catch (NumberFormatException e) {
                // not numeric
            }
            return d != null ? d.stripTrailingZeros().toPlainString() : s;
        }
        return json.canonical(v == null ? java.util.Map.of("null", true) : v);
    }

    private Set<String> changedAttachmentFields(Object before, Object after) {
        Map<String, Set<String>> a = attachmentsByField(before);
        Map<String, Set<String>> b = attachmentsByField(after);
        Set<String> fields = new HashSet<>(a.keySet());
        fields.addAll(b.keySet());
        Set<String> changed = new HashSet<>();
        for (String f : fields) {
            if (!Objects.equals(a.get(f), b.get(f))) {
                changed.add(f);
            }
        }
        return changed;
    }

    private Map<String, Set<String>> attachmentsByField(Object list) {
        Map<String, Set<String>> out = new HashMap<>();
        if (list == null) {
            return out;
        }
        for (Object o : json.list(list)) {
            Map<String, Object> m = json.map(o);
            out.computeIfAbsent(String.valueOf(m.get("fieldId")), k -> new HashSet<>()).add(String.valueOf(m.get("sha256")));
        }
        return out;
    }

    // ---- change requests ------------------------------------------------------------------------------

    @Transactional
    public UUID changeRequest(AccessContext ctx, UUID reservationId, String typeCode) {
        RequestTypes.Type type = types.get(typeCode);
        if (!type.requiresTarget()) {
            throw ApiException.validation("نوع الطلب لا يرتبط بحجز قائم.");
        }
        ReservationService.Reservation r = reservations.get(reservationId);
        DraftInput in = new DraftInput(typeCode, "LIST", r.organizationId().toString(), null, null, null, null, null,
                new Commands.PeriodInput(Times.iso(r.start()), Times.iso(r.end())), null, reservationId.toString(), null);
        return create(ctx, in);
    }
}
