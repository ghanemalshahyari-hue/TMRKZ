package ae.mover.workflow;

import ae.mover.workflow.WorkflowDefinition.Stage;

/**
 * Compiles a validated workflow definition into BPMN 2.0 for Flowable.
 *
 * <p>Each stage becomes: exclusive gateway → parallel multi-instance user task (one instance per reviewer slot) →
 * merge gateway. "ALL" stages complete when every instance completes; "ANY" stages complete after the first approval
 * (Flowable then removes the remaining instances). The only expressions in the generated XML call the fixed
 * {@code moverWf} bean with a stage key literal — administrators never author expressions.
 */
public final class BpmnCompiler {

    private BpmnCompiler() {
    }

    public static String processKey(String typeCode) {
        return "mover_" + typeCode.toLowerCase().replaceAll("[^a-z0-9_]", "_");
    }

    public static String compile(String typeCode, WorkflowDefinition def) {
        if (def.graph() != null) {
            return compileGraph(typeCode, def);
        }
        StringBuilder x = new StringBuilder();
        x.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
                .append("<definitions xmlns=\"http://www.omg.org/spec/BPMN/20100524/MODEL\"")
                .append(" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"")
                .append(" xmlns:flowable=\"http://flowable.org/bpmn\"")
                .append(" targetNamespace=\"urn:mover:workflows\">\n")
                .append("  <process id=\"").append(processKey(typeCode)).append("\" name=\"").append(xml(def.name()))
                .append("\" isExecutable=\"true\">\n")
                .append("    <startEvent id=\"start\"/>\n");
        String previous = "start";
        int flow = 0;
        for (Stage s : def.stages()) {
            String k = s.key();
            String gw = "gw_" + k;
            String task = "st_" + k;
            String join = "join_" + k;
            x.append("    <sequenceFlow id=\"f").append(flow++).append("\" sourceRef=\"").append(previous)
                    .append("\" targetRef=\"").append(gw).append("\"/>\n");
            x.append("    <exclusiveGateway id=\"").append(gw).append("\" default=\"skip_").append(k).append("\"/>\n");
            x.append("    <sequenceFlow id=\"run_").append(k).append("\" sourceRef=\"").append(gw).append("\" targetRef=\"")
                    .append(task).append("\">\n")
                    .append("      <conditionExpression xsi:type=\"tFormalExpression\"><![CDATA[${moverWf.shouldRun(execution, '")
                    .append(k).append("')}]]></conditionExpression>\n")
                    .append("    </sequenceFlow>\n");
            x.append("    <sequenceFlow id=\"skip_").append(k).append("\" sourceRef=\"").append(gw).append("\" targetRef=\"")
                    .append(join).append("\"/>\n");
            x.append("    <userTask id=\"").append(task).append("\" name=\"").append(xml(s.name())).append("\">\n")
                    .append("      <multiInstanceLoopCharacteristics isSequential=\"false\" flowable:collection=\"${moverWf.slots(execution, '")
                    .append(k).append("')}\" flowable:elementVariable=\"slot\">\n");
            if ("ANY".equals(s.mode())) {
                x.append("        <completionCondition><![CDATA[${nrOfCompletedInstances >= 1}]]></completionCondition>\n");
            }
            x.append("      </multiInstanceLoopCharacteristics>\n")
                    .append("    </userTask>\n");
            x.append("    <sequenceFlow id=\"done_").append(k).append("\" sourceRef=\"").append(task).append("\" targetRef=\"")
                    .append(join).append("\"/>\n");
            x.append("    <exclusiveGateway id=\"").append(join).append("\"/>\n");
            previous = join;
        }
        x.append("    <sequenceFlow id=\"f").append(flow).append("\" sourceRef=\"").append(previous).append("\" targetRef=\"end\"/>\n")
                .append("    <endEvent id=\"end\"/>\n")
                .append("  </process>\n")
                .append("</definitions>\n");
        return x.toString();
    }

    /**
     * A chart: an approval is gateway → multi-instance task → after-gateway, its rejected line taken when a decision set
     * {@code outcome_<key>}; a decision is an exclusive gateway on {@code moverWf.test}; parallel and join are parallel
     * gateways; notify and a rejected end are service tasks calling the fixed {@code moverWf} bean; a rejected end
     * terminates the whole process, an approved end only its token. Validated first: no expression is ever authored.
     */
    private static String compileGraph(String typeCode, WorkflowDefinition def) {
        WorkflowDefinition.Graph g = def.graph();
        StringBuilder x = new StringBuilder();
        x.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
                .append("<definitions xmlns=\"http://www.omg.org/spec/BPMN/20100524/MODEL\"")
                .append(" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"")
                .append(" xmlns:flowable=\"http://flowable.org/bpmn\"")
                .append(" targetNamespace=\"urn:mover:workflows\">\n")
                .append("  <process id=\"").append(processKey(typeCode)).append("\" name=\"").append(xml(def.name()))
                .append("\" isExecutable=\"true\">\n");
        int[] flow = {0};
        for (WorkflowDefinition.Node n : g.nodes()) {
            String k = n.id();
            switch (n.type()) {
                case WorkflowDefinition.START -> {
                    x.append("    <startEvent id=\"n_").append(k).append("\"/>\n");
                    flowTo(x, flow, "n_" + k, g.from(k).get(0).to(), g, null);
                }
                case WorkflowDefinition.APPROVAL -> approval(x, flow, g, n);
                case WorkflowDefinition.DECISION -> {
                    String yes = "yes_" + k;
                    String no = "no_" + k;
                    x.append("    <exclusiveGateway id=\"n_").append(k).append("\" default=\"").append(no).append("\"/>\n");
                    flowId(x, yes, "n_" + k, entry(g, g.from(k, "yes").orElseThrow().to()), "${moverWf.test(execution, '" + k + "')}");
                    flowId(x, no, "n_" + k, entry(g, g.from(k, "no").orElseThrow().to()), null);
                }
                case WorkflowDefinition.NOTIFY -> {
                    x.append("    <serviceTask id=\"n_").append(k).append("\" name=\"").append(xml(n.name()))
                            .append("\" flowable:expression=\"${moverWf.notify(execution, '").append(k).append("')}\"/>\n");
                    flowTo(x, flow, "n_" + k, g.from(k).get(0).to(), g, null);
                }
                case WorkflowDefinition.PARALLEL, WorkflowDefinition.JOIN -> {
                    x.append("    <parallelGateway id=\"n_").append(k).append("\"/>\n");
                    for (WorkflowDefinition.Edge e : g.from(k)) {
                        flowTo(x, flow, "n_" + k, e.to(), g, null);
                    }
                }
                case WorkflowDefinition.END_APPROVED -> x.append("    <endEvent id=\"n_").append(k).append("\"/>\n");
                case WorkflowDefinition.END_REJECTED -> {
                    x.append("    <serviceTask id=\"n_").append(k).append("\" name=\"").append(xml(n.name()))
                            .append("\" flowable:expression=\"${moverWf.endRejected(execution, '").append(k).append("')}\"/>\n");
                    x.append("    <endEvent id=\"term_").append(k).append("\"><terminateEventDefinition/></endEvent>\n");
                    flowId(x, "f" + flow[0]++, "n_" + k, "term_" + k, null);
                }
                default -> throw new IllegalArgumentException("node type " + n.type());
            }
        }
        x.append("  </process>\n</definitions>\n");
        return x.toString();
    }

    private static void approval(StringBuilder x, int[] flow, WorkflowDefinition.Graph g, WorkflowDefinition.Node n) {
        String k = n.id();
        String task = "st_" + k;
        String after = "after_" + k;
        String outcome = "execution.getVariable('outcome_" + k + "') == 'REJECTED'";
        // a climbing approval waits for one unit at a time, nearest first
        boolean chain = n.raw().hasNonNull("chain");
        x.append("    <exclusiveGateway id=\"n_").append(k).append("\" default=\"skip_").append(k).append("\"/>\n");
        flowId(x, "run_" + k, "n_" + k, task, "${moverWf.shouldRun(execution, '" + k + "')}");
        flowId(x, "skip_" + k, "n_" + k, after, null);
        x.append("    <userTask id=\"").append(task).append("\" name=\"").append(xml(n.name())).append("\">\n")
                .append("      <multiInstanceLoopCharacteristics isSequential=\"").append(chain).append("\" flowable:collection=\"${moverWf.slots(execution, '")
                .append(k).append("')}\" flowable:elementVariable=\"slot\">\n")
                .append("        <completionCondition><![CDATA[${")
                .append(!chain && "ANY".equals(n.raw().path("mode").asText("ALL")) ? "nrOfCompletedInstances >= 1 || " : "").append(outcome)
                .append("}]]></completionCondition>\n")
                .append("      </multiInstanceLoopCharacteristics>\n    </userTask>\n");
        flowId(x, "done_" + k, task, after, null);
        String approved = "ok_" + k;
        x.append("    <exclusiveGateway id=\"").append(after).append("\" default=\"").append(approved).append("\"/>\n");
        flowId(x, approved, after, entry(g, g.from(k, "approved").orElseThrow().to()), null);
        g.from(k, "rejected").ifPresent(e -> flowId(x, "no_" + k, after, entry(g, e.to()), "${" + outcome + "}"));
    }

    private static String entry(WorkflowDefinition.Graph g, String id) {
        return "n_" + id;
    }

    private static void flowTo(StringBuilder x, int[] flow, String from, String to, WorkflowDefinition.Graph g, String condition) {
        flowId(x, "f" + flow[0]++, from, entry(g, to), condition);
    }

    private static void flowId(StringBuilder x, String id, String from, String to, String condition) {
        x.append("    <sequenceFlow id=\"").append(id).append("\" sourceRef=\"").append(from).append("\" targetRef=\"").append(to).append("\"");
        if (condition == null) {
            x.append("/>\n");
        } else {
            x.append(">\n      <conditionExpression xsi:type=\"tFormalExpression\"><![CDATA[").append(condition).append("]]></conditionExpression>\n    </sequenceFlow>\n");
        }
    }

    private static String xml(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}
