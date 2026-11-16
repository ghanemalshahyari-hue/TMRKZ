package ae.mover.workflow;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.flowable.engine.delegate.DelegateExecution;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.forms.RuleLanguage;
import ae.mover.workflow.WorkflowDefinition.Assignee;
import ae.mover.workflow.WorkflowDefinition.Stage;

/**
 * The only bean referenced from generated BPMN expressions. It reads the pinned workflow version and the immutable
 * request revision inside the engine's (shared) transaction, so routing is reproducible for every revision.
 */
@Component("moverWf")
public class WorkflowRuntime {

    private final JdbcClient jdbc;
    private final Json json;
    private final WorkflowService workflows;
    private final PlaceResolver places;
    private final java.time.Clock clock;

    private final ae.mover.access.SeparationOfDuties separation;
    private final ae.mover.audit.AuditService audit;

    public WorkflowRuntime(JdbcClient jdbc, Json json, WorkflowService workflows, PlaceResolver places, java.time.Clock clock,
                           ae.mover.access.SeparationOfDuties separation, ae.mover.audit.AuditService audit) {
        this.separation = separation;
        this.audit = audit;
        this.jdbc = jdbc;
        this.json = json;
        this.workflows = workflows;
        this.places = places;
        this.clock = clock;
    }

    /** A decision step of a chart: the rule on this revision's values and facts. */
    public boolean test(DelegateExecution execution, String nodeKey) {
        RevisionContext ctx = load(execution);
        WorkflowDefinition.Node n = workflows.definition(ctx.workflowVersionId()).graph().node(nodeKey).orElseThrow();
        return RuleLanguage.evaluate(n.raw().get("condition"), ctx.values(), ctx.facts());
    }

    /** A notify step: tells the requester and the holders of each role at its place; nobody decides anything here. */
    public void notify(DelegateExecution execution, String nodeKey) {
        RevisionContext ctx = load(execution);
        WorkflowDefinition.Node n = workflows.definition(ctx.workflowVersionId()).graph().node(nodeKey).orElseThrow();
        Set<UUID> people = new LinkedHashSet<>();
        for (JsonNode r : n.raw().path("recipients")) {
            if ("REQUESTER".equals(r.path("kind").asText())) {
                jdbc.sql("select created_by from request where id = :id").param("id", ctx.requestId()).query(UUID.class).optional().ifPresent(people::add);
            } else {
                var a = WorkflowDefinition.assignees(json.tree(json.write(List.of(r)))).get(0);
                people.addAll(places.holdersOf(a, ctx.ownerOrgId(), ctx.resourceIds()));
            }
        }
        String number = jdbc.sql("select number from request where id = :id").param("id", ctx.requestId()).query(String.class).single();
        String message = n.raw().path("message").asText("");
        for (UUID person : people) {
            jdbc.sql("""
                    insert into notification(id, person_id, kind, title, body, request_id, created_at)
                    values (:id, :p, 'FLOW_NOTICE', :t, :b, :r, :now)""")
                    .param("id", UUID.randomUUID()).param("p", person).param("t", n.name() + " — " + number)
                    .param("b", message.isBlank() ? n.name() : message).param("r", ctx.requestId()).param("now", Db.ts(clock.instant())).update();
        }
    }

    /** A rejected end of a chart: recorded in the engine's transaction; the caller closes the request when the process ended. */
    public void endRejected(DelegateExecution execution, String nodeKey) {
        RevisionContext ctx = load(execution);
        WorkflowDefinition.Node n = workflows.definition(ctx.workflowVersionId()).graph().node(nodeKey).orElseThrow();
        jdbc.sql("""
                insert into request_flow_end(request_id, revision, node_key, outcome, note, ended_at)
                values (:r, :v, :k, 'REJECTED', :note, :now) on conflict (request_id, revision) do nothing""")
                .param("r", ctx.requestId()).param("v", ctx.revision()).param("k", nodeKey).param("note", n.name())
                .param("now", Db.ts(clock.instant())).update();
    }

    /** How a process that has ended ended: the note of a rejected end, or null for an approved one. */
    public java.util.Optional<String> rejectedEnd(UUID requestId, int revision) {
        return jdbc.sql("select coalesce(note, '') from request_flow_end where request_id = :r and revision = :v")
                .param("r", requestId).param("v", revision).query(String.class).optional();
    }

    public record RevisionContext(UUID requestId, int revision, String typeCode, UUID ownerOrgId, UUID workflowVersionId,
                                  Map<String, Object> values, Map<String, Object> facts, List<UUID> resourceIds,
                                  Set<String> carriedStages) {
    }

    public boolean shouldRun(DelegateExecution execution, String stageKey) {
        RevisionContext ctx = load(execution);
        if (ctx.carriedStages().contains(stageKey)) {
            return false;
        }
        Stage stage = workflows.definition(ctx.workflowVersionId()).stage(stageKey).orElseThrow();
        if (!RuleLanguage.evaluate(stage.condition(), ctx.values(), ctx.facts())) {
            return false;
        }
        recordSkippedUnits(ctx, stage);
        recordNoAccessManager(ctx, stage);
        return !slots(ctx, stage).isEmpty();
    }

    public static final String NO_ACCESS_MANAGER = "NO_ACCESS_MANAGER";
    public static final String NO_ACCESS_MANAGER_TEXT = "لا يوجد مسؤول صلاحيات لهذه الوحدة — انتقل الطلب إلى الاعتماد النهائي";

    /**
     * A permission request whose unit has no access manager to recommend (or only the applicant) goes straight to the final
     * approval (ADR-044); since 16 Nov 2026 (owner, LDAP first login) that is recorded for the revision and audited, so the
     * final approver and the history read it rather than infer it. Idempotent for the same request, revision and step.
     */
    void recordNoAccessManager(RevisionContext ctx, Stage stage) {
        if (stage.finalStage() || ctx.requestId() == null) {
            return;
        }
        for (Assignee a : stage.assignees()) {
            if (!"BY_SCOPE".equals(a.orgFrom()) || !"UNIT_ACCESS_MANAGER".equals(a.role())) {
                continue;
            }
            PlaceResolver.ScopeMatch scope = places.scope(a.role(), ctx.ownerOrgId());
            if (scope.required() && !separation.requester(ctx.requestId()).containsAll(scope.people())) {
                continue;
            }
            String name = jdbc.sql("select name from organization where id = :o").param("o", ctx.ownerOrgId()).query(String.class).optional().orElse("");
            int added = jdbc.sql("""
                    insert into request_route_skip(request_id, revision, stage_key, organization_id, organization_name, organization_level,
                                                   hierarchy_order, reason_code, reason_text, workflow_version_id, created_at)
                    values (:r, :v, :s, :o, :n, null, 0, :code, :text, :wf, :at)
                    on conflict (request_id, revision, stage_key, organization_id) do nothing""")
                    .param("r", ctx.requestId()).param("v", ctx.revision()).param("s", stage.key()).param("o", ctx.ownerOrgId())
                    .param("n", name).param("code", NO_ACCESS_MANAGER).param("text", NO_ACCESS_MANAGER_TEXT)
                    .param("wf", ctx.workflowVersionId()).param("at", java.sql.Timestamp.from(clock.instant())).update();
            if (added > 0) {
                java.util.Map<String, Object> detail = new java.util.LinkedHashMap<>();
                detail.put("revision", ctx.revision());
                detail.put("stage", stage.key());
                detail.put("organizationId", ctx.ownerOrgId().toString());
                audit.record(null, ae.mover.audit.AuditService.Capacity.NONE, "ACCESS_REVIEW_SKIPPED", "REQUEST", ctx.requestId().toString(),
                        null, detail, NO_ACCESS_MANAGER_TEXT, ctx.revision());
            }
            return;
        }
    }

    public static final String NO_HIERARCHY_APPROVER = "NO_HIERARCHY_APPROVER";
    public static final String NO_HIERARCHY_APPROVER_TEXT = "تم تجاوز هذه الجهة لعدم وجود معتمد للسلسلة الهرمية";

    /**
     * The owner's decision of 16 Nov 2026 (ADR-062): in a climb that passes units with nobody (chain.skipEmpty), every unit with
     * no hierarchy approver — neither its own nor an inherited one covering it (ADR-058) — is recorded as skipped for this
     * request revision, with its name and level as they are now, when the process reaches the step. Idempotent for the same
     * request, revision and step; one grouped audit event when something new is recorded. A step whose units are all skipped
     * has no slot and the flow goes on to the next step; it never opens to every holder of the role.
     */
    void recordSkippedUnits(RevisionContext ctx, Stage stage) {
        JsonNode chain = chainOf(ctx, stage);
        if (chain == null || !chain.path("skipEmpty").asBoolean(false)) {
            return;
        }
        String role = stage.assignees().get(0).role();
        List<java.util.Map<String, Object>> recorded = new ArrayList<>();
        int order = 0;
        for (ae.mover.stationing.OrgUnit u : places.chain(chain, ctx.ownerOrgId())) {
            order++;
            if (!places.station(role, u.id()).empty()) {
                continue;
            }
            int added = jdbc.sql("""
                    insert into request_route_skip(request_id, revision, stage_key, organization_id, organization_name, organization_level,
                                                   hierarchy_order, reason_code, reason_text, workflow_version_id, created_at)
                    values (:r, :v, :s, :o, :n, :l, :ord, :code, :text, :wf, :at)
                    on conflict (request_id, revision, stage_key, organization_id) do nothing""")
                    .param("r", ctx.requestId()).param("v", ctx.revision()).param("s", stage.key()).param("o", u.id())
                    .param("n", u.name()).param("l", u.level()).param("ord", order).param("code", NO_HIERARCHY_APPROVER)
                    .param("text", NO_HIERARCHY_APPROVER_TEXT).param("wf", ctx.workflowVersionId())
                    .param("at", java.sql.Timestamp.from(clock.instant())).update();
            if (added > 0) {
                java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
                m.put("organizationId", u.id().toString());
                m.put("organizationName", u.name());
                m.put("level", u.level());
                m.put("order", order);
                m.put("reasonCode", NO_HIERARCHY_APPROVER);
                recorded.add(m);
            }
        }
        if (!recorded.isEmpty()) {
            java.util.Map<String, Object> detail = new java.util.LinkedHashMap<>();
            detail.put("revision", ctx.revision());
            detail.put("stage", stage.key());
            detail.put("stageName", stage.name());
            detail.put("workflowVersionId", String.valueOf(ctx.workflowVersionId()));
            detail.put("units", recorded);
            audit.record(null, ae.mover.audit.AuditService.Capacity.NONE, "HIERARCHY_LEVEL_SKIPPED", "REQUEST", ctx.requestId().toString(),
                    null, detail, NO_HIERARCHY_APPROVER_TEXT, ctx.revision());
        }
    }

    public List<String> slots(DelegateExecution execution, String stageKey) {
        RevisionContext ctx = load(execution);
        return slots(ctx, workflows.definition(ctx.workflowVersionId()).stage(stageKey).orElseThrow());
    }

    /** Reviewer slots are "ROLE|orgId" (or "ROLE|*"): tasks are pooled to whoever holds the role at decision time. */
    public List<String> slots(RevisionContext ctx, Stage stage) {
        Set<String> out = new LinkedHashSet<>();
        JsonNode chain = chainOf(ctx, stage);
        if (chain != null) {
            String role = stage.assignees().get(0).role();
            List<UUID> orgs = places.chainOrgs(role, chain, ctx.ownerOrgId(), separation.requester(ctx.requestId()));
            orgs.forEach(o -> out.add(role + "|" + o));
            // owner, 16 Nov 2026 (ADR-062): units with no hierarchy approver are skipped and recorded (recordSkippedUnits); when
            // every unit is skipped the step has no slot and the flow goes on — never «ROLE|*», which opened it to any holder
            return new ArrayList<>(out);
        }
        for (Assignee a : stage.assignees()) {
            // a command that does not use this step has no such step; a final approval is never passed
            if ("BY_SCOPE".equals(a.orgFrom()) && !stage.finalStage() && !places.scope(a.role(), ctx.ownerOrgId()).required()) {
                continue;
            }
            // a permission request with no reviewer, or only its own applicant, goes on to the final approval (ADR-044)
            if ("BY_SCOPE".equals(a.orgFrom()) && !stage.finalStage() && "UNIT_ACCESS_MANAGER".equals(a.role())
                    && separation.requester(ctx.requestId()).containsAll(places.scope(a.role(), ctx.ownerOrgId()).people())) {
                continue;
            }
            PlaceResolver.Place p = places.resolve(a, ctx.ownerOrgId(), ctx.resourceIds());
            if (p.anyOrg()) {
                out.add(a.role() + "|*"); // no unit found: the step still runs, for any holder of the role in scope
            }
            p.orgs().forEach(o -> out.add(a.role() + "|" + o));
        }
        return new ArrayList<>(out);
    }

    private JsonNode chainOf(RevisionContext ctx, Stage stage) {
        var graph = workflows.definition(ctx.workflowVersionId()).graph();
        return graph == null ? null : graph.node(stage.key()).map(n -> n.raw().get("chain")).filter(c -> c != null && !c.isNull()).orElse(null);
    }

    public List<UUID> resourceOrgs(List<UUID> resourceIds) {
        return places.resourceOrgs(resourceIds);
    }

    public RevisionContext load(DelegateExecution execution) {
        UUID requestId = UUID.fromString((String) execution.getVariable("requestId"));
        int revision = ((Number) execution.getVariable("revision")).intValue();
        return load(requestId, revision);
    }

    public RevisionContext load(UUID requestId, int revision) {
        return jdbc.sql("""
                select rv.data::text as data, rv.carried_stages, rv.workflow_version_id, r.type_code, r.owner_org_id,
                       rv.period_start, rv.period_end
                from request_revision rv join request r on r.id = rv.request_id
                where rv.request_id = :id and rv.revision = :rev""")
                .param("id", requestId).param("rev", revision)
                .query((rs, n) -> {
                    JsonNode data = json.tree(rs.getString("data"));
                    List<UUID> resources = new ArrayList<>();
                    data.path("resourceIds").forEach(r -> resources.add(UUID.fromString(r.asText())));
                    Instant start = Db.instant(rs, "period_start");
                    Instant end = Db.instant(rs, "period_end");
                    long hours = start != null && end != null ? Duration.between(start, end).toHours() : 0;
                    Map<String, Object> facts = new java.util.HashMap<>();
                    facts.put("resourceCount", resources.size());
                    facts.put("durationHours", hours);
                    facts.put("durationDays", end == null ? 36500 : (long) Math.ceil(hours / 24.0));
                    facts.put("participantCount", 1 + data.path("participantOrgIds").size());
                    facts.put("requestType", rs.getString("type_code"));
                    facts.putAll(places.unitFacts(Db.uuid(rs, "owner_org_id")));
                    return new RevisionContext(requestId, revision, rs.getString("type_code"), Db.uuid(rs, "owner_org_id"),
                            Db.uuid(rs, "workflow_version_id"), json.map(data.path("values")), facts, resources,
                            new LinkedHashSet<>(Db.strings(rs, "carried_stages")));
                }).single();
    }
}
