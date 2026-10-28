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

    public WorkflowRuntime(JdbcClient jdbc, Json json, WorkflowService workflows) {
        this.jdbc = jdbc;
        this.json = json;
        this.workflows = workflows;
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
        return RuleLanguage.evaluate(stage.condition(), ctx.values(), ctx.facts()) && !slots(ctx, stage).isEmpty();
    }

    public List<String> slots(DelegateExecution execution, String stageKey) {
        RevisionContext ctx = load(execution);
        return slots(ctx, workflows.definition(ctx.workflowVersionId()).stage(stageKey).orElseThrow());
    }

    /** Reviewer slots are "ROLE|orgId" (or "ROLE|*"): tasks are pooled to whoever holds the role at decision time. */
    public List<String> slots(RevisionContext ctx, Stage stage) {
        Set<String> out = new LinkedHashSet<>();
        for (Assignee a : stage.assignees()) {
            switch (a.orgFrom()) {
                case "REQUEST_ORG" -> out.add(a.role() + "|" + ctx.ownerOrgId());
                case "RESOURCE_ORG" -> {
                    List<UUID> orgs = resourceOrgs(ctx.resourceIds());
                    if (orgs.isEmpty()) {
                        out.add(a.role() + "|*");
                    }
                    orgs.forEach(o -> out.add(a.role() + "|" + o));
                }
                default -> out.add(a.role() + "|*");
            }
        }
        return new ArrayList<>(out);
    }

    public List<UUID> resourceOrgs(List<UUID> resourceIds) {
        return jdbc.sql("""
                select distinct sr.organization_id from resource r
                join site_responsibility sr on sr.site_id = r.site_id and sr.valid_to is null
                where r.id = any(string_to_array(:ids, ',')::uuid[]) order by 1""")
                .param("ids", Db.ids(resourceIds)).query(UUID.class).list();
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
                    return new RevisionContext(requestId, revision, rs.getString("type_code"), Db.uuid(rs, "owner_org_id"),
                            Db.uuid(rs, "workflow_version_id"), json.map(data.path("values")), facts, resources,
                            new LinkedHashSet<>(Db.strings(rs, "carried_stages")));
                }).single();
    }
}
