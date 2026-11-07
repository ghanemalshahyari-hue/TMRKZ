package ae.mover.workflow;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import com.fasterxml.jackson.databind.JsonNode;

/** Typed view of a stored workflow definition (JSON). Only constructs listed here exist; there is no script hook. */
public record WorkflowDefinition(String name, List<Stage> stages, List<ExecTemplate> execution, Graph graph) {

    /**
     * Who decides or is told: a role at a place. The place is found per request: REQUEST_ORG, RESOURCE_ORG and ANY as
     * before; UP the unit {@code levelsUp} above the requesting unit; AT_LEVEL the first unit at {@code level} on its way
     * up; FIXED one chosen unit; RESPONSIBLE the unit a responsibility's nearest rule names (ADR-041).
     */
    public record Assignee(String role, String orgFrom, Integer levelsUp, Integer level, String orgId, String responsibility) {
        public Assignee(String role, String orgFrom) {
            this(role, orgFrom, null, null, null, null);
        }

        static Assignee from(JsonNode a) {
            return new Assignee(a.path("role").asText(), a.path("orgFrom").asText("ANY"), a.hasNonNull("levelsUp") ? a.path("levelsUp").asInt() : null,
                    a.hasNonNull("level") ? a.path("level").asInt() : null, a.hasNonNull("orgId") ? a.path("orgId").asText() : null,
                    a.hasNonNull("responsibility") ? a.path("responsibility").asText() : null);
        }
    }

    /** The logical flow chart of a definition (ADR-041). Stored as drawn; {@link #stages} are its approval steps in order. */
    public record Graph(List<Node> nodes, List<Edge> edges) {

        public Optional<Node> node(String id) {
            return nodes.stream().filter(n -> n.id().equals(id)).findFirst();
        }

        public List<Edge> from(String id) {
            return edges.stream().filter(e -> e.from().equals(id)).toList();
        }

        public Optional<Edge> from(String id, String when) {
            return edges.stream().filter(e -> e.from().equals(id) && when.equals(e.when())).findFirst();
        }

        public boolean rejectEdge(String stageKey) {
            return from(stageKey, "rejected").isPresent();
        }

        /** Nodes in flow order: each after all that lead to it. Empty when the chart has a cycle. */
        public List<Node> ordered() {
            java.util.Map<String, Integer> in = new java.util.LinkedHashMap<>();
            nodes.forEach(n -> in.put(n.id(), 0));
            edges.forEach(e -> in.computeIfPresent(e.to(), (k, v) -> v + 1));
            java.util.ArrayDeque<String> ready = new java.util.ArrayDeque<>();
            in.forEach((k, v) -> {
                if (v == 0) {
                    ready.add(k);
                }
            });
            List<Node> out = new ArrayList<>();
            while (!ready.isEmpty()) {
                String id = ready.poll();
                node(id).ifPresent(out::add);
                for (Edge e : from(id)) {
                    if (in.computeIfPresent(e.to(), (k, v) -> v - 1) instanceof Integer left && left == 0) {
                        ready.add(e.to());
                    }
                }
            }
            return out.size() == nodes.size() ? out : List.of();
        }
    }

    public static final String START = "start";
    public static final String APPROVAL = "approval";
    public static final String DECISION = "decision";
    public static final String NOTIFY = "notify";
    public static final String PARALLEL = "parallel";
    public static final String JOIN = "join";
    public static final String END_APPROVED = "end_approved";
    public static final String END_REJECTED = "end_rejected";

    /** One step of the chart; {@code raw} holds what its type needs (condition, recipients, message…). */
    public record Node(String id, String type, String name, JsonNode raw) {
    }

    /** A line of the chart. {@code when}: approved or rejected from an approval, yes or no from a decision, else null. */
    public record Edge(String from, String to, String when) {
    }

    public record Stage(String key, String name, String mode, int slaDays, List<Assignee> assignees, JsonNode condition,
                        boolean finalStage, boolean requiresSignature) {
    }

    /**
     * An execution step after approval. {@code purpose} fixes its independence rule (ADR-028): HANDOVER — the delivering
     * side, never the requester; RECEIPT — the authorised receiving party confirms a completed handover, never the same
     * human who handed over; ACKNOWLEDGEMENT — the requester records completing their own work, which is not an approval;
     * TASK — any other step. Definitions without it take it from the key (handover, receipt, relocated).
     */
    public record ExecTemplate(String key, String name, String role, String orgFrom, int dueDays, boolean evidenceRequired,
                               String purpose) {

        public static final java.util.Set<String> PURPOSES = java.util.Set.of("HANDOVER", "RECEIPT", "ACKNOWLEDGEMENT", "TASK");

        public static String purposeOf(String key) {
            return switch (key == null ? "" : key) {
                case "handover" -> "HANDOVER";
                case "receipt" -> "RECEIPT";
                case "relocated" -> "ACKNOWLEDGEMENT";
                default -> "TASK";
            };
        }
    }

    public Optional<Stage> stage(String key) {
        return stages.stream().filter(s -> s.key().equals(key)).findFirst();
    }

    private static Graph graphOf(JsonNode node) {
        JsonNode g = node.get("graph");
        if (g == null || g.isNull()) {
            return null;
        }
        List<Node> nodes = new ArrayList<>();
        g.path("nodes").forEach(n -> nodes.add(new Node(n.path("id").asText(), n.path("type").asText(), n.path("name").asText(""), n)));
        List<Edge> edges = new ArrayList<>();
        g.path("edges").forEach(e -> edges.add(new Edge(e.path("from").asText(), e.path("to").asText(), e.hasNonNull("when") ? e.path("when").asText() : null)));
        return new Graph(nodes, edges);
    }

    public static List<Assignee> assignees(JsonNode list) {
        List<Assignee> out = new ArrayList<>();
        list.forEach(a -> out.add(Assignee.from(a)));
        return out;
    }

    public static WorkflowDefinition from(JsonNode node) {
        Graph graph = graphOf(node);
        List<Stage> stages = new ArrayList<>();
        if (graph != null) {
            // a chart's approval steps are the definition's stages: tasks, the route shown and carried approvals read them
            for (Node n : graph.ordered().isEmpty() ? graph.nodes() : graph.ordered()) {
                if (APPROVAL.equals(n.type())) {
                    JsonNode r = n.raw();
                    stages.add(new Stage(n.id(), n.name(), r.path("mode").asText("ALL"), r.path("slaDays").asInt(2), assignees(r.path("assignees")), null,
                            r.path("final").asBoolean(false), r.path("requiresSignature").asBoolean(false)));
                }
            }
        }
        for (JsonNode s : graph != null ? com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode() : node.path("stages")) {
            JsonNode condition = s.get("condition");
            stages.add(new Stage(s.path("key").asText(), s.path("name").asText(), s.path("mode").asText("ALL"),
                    s.path("slaDays").asInt(2), assignees(s.path("assignees")), condition == null || condition.isNull() ? null : condition,
                    s.path("final").asBoolean(false), s.path("requiresSignature").asBoolean(false)));
        }
        List<ExecTemplate> exec = new ArrayList<>();
        for (JsonNode e : node.path("execution")) {
            String purpose = e.path("purpose").asText(ExecTemplate.purposeOf(e.path("key").asText()));
            exec.add(new ExecTemplate(e.path("key").asText(), e.path("name").asText(), e.path("role").asText(),
                    e.path("orgFrom").asText("ANY"), e.path("dueDays").asInt(1), e.path("evidenceRequired").asBoolean(false),
                    ExecTemplate.PURPOSES.contains(purpose) ? purpose : ExecTemplate.purposeOf(e.path("key").asText())));
        }
        return new WorkflowDefinition(node.path("name").asText(), stages, exec, graph);
    }
}
