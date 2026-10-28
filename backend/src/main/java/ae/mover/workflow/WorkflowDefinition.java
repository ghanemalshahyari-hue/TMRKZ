package ae.mover.workflow;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import com.fasterxml.jackson.databind.JsonNode;

/** Typed view of a stored workflow definition (JSON). Only constructs listed here exist; there is no script hook. */
public record WorkflowDefinition(String name, List<Stage> stages, List<ExecTemplate> execution) {

    public record Assignee(String role, String orgFrom) {
    }

    public record Stage(String key, String name, String mode, int slaDays, List<Assignee> assignees, JsonNode condition,
                        boolean finalStage, boolean requiresSignature) {
    }

    public record ExecTemplate(String key, String name, String role, String orgFrom, int dueDays, boolean evidenceRequired) {
    }

    public Optional<Stage> stage(String key) {
        return stages.stream().filter(s -> s.key().equals(key)).findFirst();
    }

    public static WorkflowDefinition from(JsonNode node) {
        List<Stage> stages = new ArrayList<>();
        for (JsonNode s : node.path("stages")) {
            List<Assignee> assignees = new ArrayList<>();
            for (JsonNode a : s.path("assignees")) {
                assignees.add(new Assignee(a.path("role").asText(), a.path("orgFrom").asText("ANY")));
            }
            JsonNode condition = s.get("condition");
            stages.add(new Stage(s.path("key").asText(), s.path("name").asText(), s.path("mode").asText("ALL"),
                    s.path("slaDays").asInt(2), assignees, condition == null || condition.isNull() ? null : condition,
                    s.path("final").asBoolean(false), s.path("requiresSignature").asBoolean(false)));
        }
        List<ExecTemplate> exec = new ArrayList<>();
        for (JsonNode e : node.path("execution")) {
            exec.add(new ExecTemplate(e.path("key").asText(), e.path("name").asText(), e.path("role").asText(),
                    e.path("orgFrom").asText("ANY"), e.path("dueDays").asInt(1), e.path("evidenceRequired").asBoolean(false)));
        }
        return new WorkflowDefinition(node.path("name").asText(), stages, exec);
    }
}
