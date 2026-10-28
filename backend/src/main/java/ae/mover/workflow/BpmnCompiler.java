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

    private static String xml(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}
