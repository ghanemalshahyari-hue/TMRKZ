package ae.mover.workflow;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.flowable.task.api.Task;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.Db;
import ae.mover.hr.TaskRealignment;
import ae.mover.workflow.WorkflowDefinition.Stage;

/**
 * Mirrors Flowable's active user tasks into {@code task_assignment} (the business view of who must decide what,
 * with SLA). Runs in the same transaction as the engine operation that created or removed the tasks. New tasks pass the
 * separation-of-duties routing (ADR-027) before the transaction commits.
 */
@Component
public class TaskSync {

    private final JdbcClient jdbc;
    private final TaskService taskService;
    private final RuntimeService runtimeService;
    private final Clock clock;
    private final PlaceResolver places;
    private final TaskRealignment realignment;

    public TaskSync(JdbcClient jdbc, TaskService taskService, RuntimeService runtimeService, Clock clock, TaskRealignment realignment, PlaceResolver places) {
        this.places = places;
        this.jdbc = jdbc;
        this.taskService = taskService;
        this.runtimeService = runtimeService;
        this.clock = clock;
        this.realignment = realignment;
    }

    public void sync(UUID requestId, int revision, String processInstanceId, WorkflowDefinition def) {
        List<Task> active = taskService.createTaskQuery().processInstanceId(processInstanceId).list();
        Set<String> activeIds = new HashSet<>();
        List<UUID> created = new ArrayList<>();
        Instant now = clock.instant();
        for (Task t : active) {
            activeIds.add(t.getId());
            boolean known = jdbc.sql("select count(*) from task_assignment where flowable_task_id = :id")
                    .param("id", t.getId()).query(Integer.class).single() > 0;
            if (known) {
                continue;
            }
            String slot = (String) runtimeService.getVariableLocal(t.getExecutionId(), "slot");
            String stageKey = t.getTaskDefinitionKey().substring("st_".length());
            Stage stage = def.stage(stageKey).orElseThrow();
            String[] parts = slot.split("\\|", 2);
            UUID targetOrg = "*".equals(parts[1]) ? null : UUID.fromString(parts[1]);
            // found by a grant's scope, not bound to a unit's own holders; and nobody who approved earlier decides it (ADR-042)
            boolean byScope = def.graph() != null && stage.assignees().stream().anyMatch(a -> a.role().equals(parts[0]) && "BY_SCOPE".equals(a.orgFrom()));
            boolean independent = def.graph() != null && (byScope || stage.finalStage());
            // the routed units are pinned here: a later edit of the periods affects new requests only
            List<UUID> routed = byScope && targetOrg != null ? places.scope(parts[0], targetOrg).routed() : null;
            String pinned = routed == null ? null : Db.ids(routed);
            UUID id = UUID.randomUUID();
            created.add(id);
            jdbc.sql("""
                    insert into task_assignment(id, request_id, revision, flowable_task_id, process_instance_id, stage_key,
                        stage_name, role_code, target_org_id, final, requires_signature, status, created_at, due_at, strict_place,
                        by_scope, independent_of_earlier, scope_orgs)
                    values (:id, :req, :rev, :tid, :pid, :sk, :sn, :role, :org, :fin, :sig, 'OPEN', :now, :due, :strict, :scope, :indep,
                            string_to_array(:pinned, ',')::uuid[])""")
                    .param("id", id).param("req", requestId).param("rev", revision).param("tid", t.getId())
                    .param("pid", processInstanceId).param("sk", stageKey).param("sn", stage.name()).param("role", parts[0])
                    .param("org", targetOrg).param("fin", stage.finalStage()).param("sig", stage.requiresSignature())
                    .param("now", Db.ts(now)).param("due", Db.ts(now.plus(Duration.ofDays(stage.slaDays()))))
                    .param("strict", def.graph() != null && targetOrg != null && !byScope)
                    .param("scope", byScope).param("indep", independent).param("pinned", pinned)
                    .update();
        }
        // Tasks Flowable removed (e.g. remaining instances of an "ANY" stage) are closed by policy.
        jdbc.sql("""
                update task_assignment set status = 'CLOSED_BY_POLICY', closed_at = :now
                where request_id = :req and status = 'OPEN' and not (flowable_task_id = any(string_to_array(:ids, ',')))""")
                .param("now", Db.ts(now)).param("req", requestId).param("ids", Db.texts(activeIds)).update();
        realignment.separate(requestId, created, now);
    }
}
