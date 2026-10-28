package ae.mover.workflow;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
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
import ae.mover.workflow.WorkflowDefinition.Stage;

/**
 * Mirrors Flowable's active user tasks into {@code task_assignment} (the business view of who must decide what,
 * with SLA). Runs in the same transaction as the engine operation that created or removed the tasks.
 */
@Component
public class TaskSync {

    private final JdbcClient jdbc;
    private final TaskService taskService;
    private final RuntimeService runtimeService;
    private final Clock clock;

    public TaskSync(JdbcClient jdbc, TaskService taskService, RuntimeService runtimeService, Clock clock) {
        this.jdbc = jdbc;
        this.taskService = taskService;
        this.runtimeService = runtimeService;
        this.clock = clock;
    }

    public void sync(UUID requestId, int revision, String processInstanceId, WorkflowDefinition def) {
        List<Task> active = taskService.createTaskQuery().processInstanceId(processInstanceId).list();
        Set<String> activeIds = new HashSet<>();
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
            jdbc.sql("""
                    insert into task_assignment(id, request_id, revision, flowable_task_id, process_instance_id, stage_key,
                        stage_name, role_code, target_org_id, final, requires_signature, status, created_at, due_at)
                    values (:id, :req, :rev, :tid, :pid, :sk, :sn, :role, :org, :fin, :sig, 'OPEN', :now, :due)""")
                    .param("id", UUID.randomUUID()).param("req", requestId).param("rev", revision).param("tid", t.getId())
                    .param("pid", processInstanceId).param("sk", stageKey).param("sn", stage.name()).param("role", parts[0])
                    .param("org", targetOrg).param("fin", stage.finalStage()).param("sig", stage.requiresSignature())
                    .param("now", Db.ts(now)).param("due", Db.ts(now.plus(Duration.ofDays(stage.slaDays()))))
                    .update();
        }
        // Tasks Flowable removed (e.g. remaining instances of an "ANY" stage) are closed by policy.
        jdbc.sql("""
                update task_assignment set status = 'CLOSED_BY_POLICY', closed_at = :now
                where request_id = :req and status = 'OPEN' and not (flowable_task_id = any(string_to_array(:ids, ',')))""")
                .param("now", Db.ts(now)).param("req", requestId).param("ids", Db.texts(activeIds)).update();
    }
}
