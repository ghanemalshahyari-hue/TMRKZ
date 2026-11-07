package ae.mover.workflow;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.forms.RuleLanguage;
import ae.mover.forms.RuleLanguage.Problem;
import ae.mover.workflow.WorkflowDefinition.Edge;
import ae.mover.workflow.WorkflowDefinition.Graph;
import ae.mover.workflow.WorkflowDefinition.Node;

/**
 * What makes a flow chart publishable (ADR-041), each problem pointing at its step in plain Arabic. The rules that matter:
 * nothing is left unreachable or dead-ended, the chart has no loop (a request goes back to its requester through «إعادة
 * للتصحيح», which every approval has), parallel branches close again, and no path reaches «معتمد» without a final
 * approval by a role that holds APPROVE (R-21).
 */
public final class GraphValidator {

    private static final Pattern KEY = Pattern.compile("^[a-z][a-z0-9_]{1,39}$");
    private static final Set<String> TYPES = Set.of(WorkflowDefinition.START, WorkflowDefinition.APPROVAL, WorkflowDefinition.DECISION, WorkflowDefinition.NOTIFY,
            WorkflowDefinition.PARALLEL, WorkflowDefinition.JOIN, WorkflowDefinition.END_APPROVED, WorkflowDefinition.END_REJECTED);
    private static final Set<String> ORG_FROM = Set.of("BY_SCOPE", "REQUEST_ORG", "RESOURCE_ORG", "ANY", "UP", "AT_LEVEL", "FIXED", "RESPONSIBLE");

    /** What the rules need to know about places outside the definition. */
    public interface Places {
        boolean orgExists(UUID id);

        boolean responsibilityExists(String code);

        Places NONE = new Places() {
            @Override
            public boolean orgExists(UUID id) {
                return true;
            }

            @Override
            public boolean responsibilityExists(String code) {
                return true;
            }
        };
    }

    private GraphValidator() {
    }

    public static List<Problem> validate(WorkflowDefinition def, Map<String, Set<String>> roles, Set<String> fieldIds, Places places) {
        Graph g = def.graph();
        List<Problem> out = new ArrayList<>();
        if (g.nodes().size() > 80) {
            out.add(new Problem("graph", "المخطط أكبر من المسموح (80 خطوة)."));
            return out;
        }
        Set<String> ids = new HashSet<>();
        for (Node n : g.nodes()) {
            if (!KEY.matcher(n.id()).matches()) {
                out.add(new Problem(p(n), "معرف الخطوة غير صالح."));
            } else if (!ids.add(n.id())) {
                out.add(new Problem(p(n), "معرف الخطوة مكرر."));
            }
            if (!TYPES.contains(n.type())) {
                out.add(new Problem(p(n), "نوع خطوة غير معروف: " + n.type()));
            }
        }
        for (Edge e : g.edges()) {
            if (!ids.contains(e.from()) || !ids.contains(e.to())) {
                out.add(new Problem("graph", "خط يصل إلى خطوة غير موجودة."));
            }
        }
        if (!out.isEmpty()) {
            return out;
        }
        List<Node> starts = g.nodes().stream().filter(n -> WorkflowDefinition.START.equals(n.type())).toList();
        if (starts.size() != 1) {
            out.add(new Problem("graph", "يجب أن يكون في المخطط بداية واحدة."));
            return out;
        }
        if (g.nodes().stream().noneMatch(n -> WorkflowDefinition.END_APPROVED.equals(n.type()))) {
            out.add(new Problem("graph", "أضف نهاية «معتمد»."));
        }
        if (g.nodes().stream().noneMatch(n -> WorkflowDefinition.APPROVAL.equals(n.type()) && n.raw().path("final").asBoolean(false))) {
            out.add(new Problem("graph", "علّم خطوة موافقة واحدة على الأقل بأنها الموافقة النهائية."));
        }
        for (Node n : g.nodes()) {
            lines(g, n, out);
            content(n, roles, fieldIds, places, out);
        }
        if (!out.isEmpty()) {
            return out;
        }
        Node start = starts.get(0);
        Set<String> reached = walk(start.id(), g);
        for (Node n : g.nodes()) {
            if (!reached.contains(n.id())) {
                out.add(new Problem(p(n), "«" + label(n) + "» غير موصولة بمسار يبدأ من البداية."));
            }
        }
        List<Node> ordered = g.ordered();
        if (ordered.isEmpty()) {
            out.add(new Problem("graph", "في المخطط حلقة: لا يجوز أن يعود الخط إلى خطوة سابقة. لإعادة الطلب للتصحيح، كل موافقة فيها هذا الخيار."));
            return out;
        }
        if (!out.isEmpty()) {
            return out;
        }
        order(g, ordered, out);
        return out;
    }

    /** Parallel balance and the final approval, in flow order. */
    private static void order(Graph g, List<Node> ordered, List<Problem> out) {
        Map<String, List<String>> context = new HashMap<>();
        Map<String, Boolean> allFinal = new HashMap<>();
        Map<String, Boolean> anyFinal = new HashMap<>();
        Map<String, Integer> incoming = new HashMap<>();
        g.edges().forEach(e -> incoming.merge(e.to(), 1, Integer::sum));
        for (Node n : ordered) {
            List<String> ctx = context.getOrDefault(n.id(), List.of());
            boolean all = allFinal.getOrDefault(n.id(), false);
            boolean any = anyFinal.getOrDefault(n.id(), false);
            boolean isFinal = WorkflowDefinition.APPROVAL.equals(n.type()) && n.raw().path("final").asBoolean(false);
            if (WorkflowDefinition.JOIN.equals(n.type())) {
                if (incoming.getOrDefault(n.id(), 0) < 2) {
                    out.add(new Problem(p(n), "«انتظار انتهاء الجميع» تحتاج خطين داخلين على الأقل."));
                }
                if (ctx.isEmpty()) {
                    out.add(new Problem(p(n), "«انتظار انتهاء الجميع» لا تقابلها «موافقات في نفس الوقت» قبلها."));
                } else {
                    ctx = ctx.subList(0, ctx.size() - 1);
                }
            }
            if (isFinal && !ctx.isEmpty()) {
                out.add(new Problem(p(n), "الموافقة النهائية لا تكون داخل «موافقات في نفس الوقت»: أضف «انتظار انتهاء الجميع» قبلها."));
            }
            if (WorkflowDefinition.END_APPROVED.equals(n.type())) {
                if (!ctx.isEmpty()) {
                    out.add(new Problem(p(n), "نهاية «معتمد» لا تكون داخل «موافقات في نفس الوقت»: أضف «انتظار انتهاء الجميع» قبلها."));
                }
                if (!all) {
                    out.add(new Problem(p(n), "يوجد مسار يصل إلى «" + label(n) + "» بدون موافقة نهائية."));
                }
            }
            if (WorkflowDefinition.END_REJECTED.equals(n.type()) && any) {
                out.add(new Problem(p(n), "لا يجوز أن يصل مسار إلى رفض بعد الموافقة النهائية."));
            }
            if (WorkflowDefinition.APPROVAL.equals(n.type()) && any) {
                out.add(new Problem(p(n), "لا موافقات بعد الموافقة النهائية؛ بعدها إشعار أو نهاية فقط."));
            }
            for (Edge e : g.from(n.id())) {
                List<String> next = new ArrayList<>(ctx);
                if (WorkflowDefinition.PARALLEL.equals(n.type())) {
                    next.add(n.id());
                }
                List<String> seen = context.get(e.to());
                Node to = g.node(e.to()).orElseThrow();
                if (seen != null && !seen.equals(next)) {
                    out.add(new Problem(p(to), "«" + label(to) + "» تصلها خطوط من أكثر من «موافقات في نفس الوقت»: أضف «انتظار انتهاء الجميع» لكل واحدة."));
                }
                context.put(e.to(), next);
                boolean viaFinal = isFinal && "approved".equals(e.when());
                boolean nextAll = all || viaFinal;
                boolean nextAny = any || viaFinal;
                allFinal.merge(e.to(), nextAll, (x, y) -> x && y);
                anyFinal.merge(e.to(), nextAny, (x, y) -> x || y);
            }
        }
    }

    private static void lines(Graph g, Node n, List<Problem> out) {
        List<Edge> from = g.from(n.id());
        boolean hasIn = g.edges().stream().anyMatch(e -> e.to().equals(n.id()));
        String name = label(n);
        switch (n.type()) {
            case WorkflowDefinition.START -> {
                if (from.size() != 1) {
                    out.add(new Problem(p(n), "البداية تحتاج خطاً واحداً يخرج منها."));
                }
                if (hasIn) {
                    out.add(new Problem(p(n), "لا يدخل خط إلى البداية."));
                }
            }
            case WorkflowDefinition.APPROVAL -> {
                if (from.stream().filter(e -> "approved".equals(e.when())).count() != 1) {
                    out.add(new Problem(p(n), "«" + name + "» تحتاج خط «عند الموافقة»."));
                }
                if (from.stream().filter(e -> "rejected".equals(e.when())).count() > 1) {
                    out.add(new Problem(p(n), "«" + name + "» لها أكثر من خط «عند الرفض»."));
                }
            }
            case WorkflowDefinition.DECISION -> {
                if (from.stream().filter(e -> "yes".equals(e.when())).count() != 1 || from.stream().filter(e -> "no".equals(e.when())).count() != 1) {
                    out.add(new Problem(p(n), "السؤال «" + name + "» يحتاج خط «نعم» وخط «لا»."));
                }
            }
            case WorkflowDefinition.NOTIFY, WorkflowDefinition.JOIN -> {
                if (from.size() != 1) {
                    out.add(new Problem(p(n), "«" + name + "» تحتاج خطاً واحداً يخرج منها."));
                }
            }
            case WorkflowDefinition.PARALLEL -> {
                if (from.size() < 2) {
                    out.add(new Problem(p(n), "«موافقات في نفس الوقت» تحتاج خطين خارجين على الأقل."));
                }
            }
            default -> {
                if (!from.isEmpty()) {
                    out.add(new Problem(p(n), "لا يخرج خط من النهاية."));
                }
            }
        }
    }

    private static void content(Node n, Map<String, Set<String>> roles, Set<String> fieldIds, Places places, List<Problem> out) {
        JsonNode r = n.raw();
        switch (n.type()) {
            case WorkflowDefinition.APPROVAL -> {
                if (n.name().isBlank()) {
                    out.add(new Problem(p(n), "خطوة موافقة بلا اسم."));
                }
                if (!Set.of("ALL", "ANY").contains(r.path("mode").asText(""))) {
                    out.add(new Problem(p(n), "حدد: يكفي واحد، أم الجميع."));
                }
                int sla = r.path("slaDays").asInt(0);
                if (sla < 1 || sla > 365) {
                    out.add(new Problem(p(n), "مهلة «" + label(n) + "» بين 1 و365 يوماً."));
                }
                boolean fin = r.path("final").asBoolean(false);
                if (r.path("requiresSignature").asBoolean(false) && !fin) {
                    out.add(new Problem(p(n), "التوقيع للموافقة النهائية فقط."));
                }
                if (r.hasNonNull("chain")) {
                    chainProblems(n, r.path("chain"), places, out);
                    if (fin) {
                        out.add(new Problem(p(n), "الموافقات المتتالية لا تكون هي الموافقة النهائية؛ ضع بعدها موافقة نهائية مستقلة."));
                    }
                    if (r.path("assignees").size() != 1) {
                        out.add(new Problem(p(n), "«" + label(n) + "»: الموافقات المتتالية لها دور واحد."));
                    }
                }
                JsonNode assignees = r.path("assignees");
                if (!assignees.isArray() || assignees.isEmpty() || assignees.size() > 10) {
                    out.add(new Problem(p(n), "«" + label(n) + "»: حدد من يوافق."));
                }
                for (JsonNode a : assignees) {
                    place(n, a, roles, places, out);
                    Set<String> perms = roles.get(a.path("role").asText(""));
                    if (perms != null && !perms.contains("REVIEW")) {
                        out.add(new Problem(p(n), "الدور في «" + label(n) + "» لا يملك صلاحية المراجعة."));
                    } else if (perms != null && fin && !perms.contains("APPROVE")) {
                        out.add(new Problem(p(n), "الموافقة النهائية تقتصر على أدوار تملك صلاحية الاعتماد النهائي."));
                    }
                }
            }
            case WorkflowDefinition.DECISION -> {
                JsonNode c = r.get("condition");
                if (c == null || c.isNull()) {
                    out.add(new Problem(p(n), "السؤال «" + label(n) + "» بلا شرط."));
                } else {
                    // the rule language speaks of operands: say which question it is about
                    RuleLanguage.validate(c, fieldIds, p(n)).forEach(x -> out.add(new Problem(x.path(), "شرط «" + label(n) + "»: " + x.message())));
                }
            }
            case WorkflowDefinition.NOTIFY -> {
                JsonNode rec = r.path("recipients");
                if (!rec.isArray() || rec.isEmpty()) {
                    out.add(new Problem(p(n), "الإشعار «" + label(n) + "» بلا مستلمين."));
                }
                for (JsonNode a : rec) {
                    if (!"REQUESTER".equals(a.path("kind").asText())) {
                        place(n, a, roles, places, out);
                    }
                }
            }
            default -> {
            }
        }
    }

    private static void chainProblems(Node n, JsonNode c, Places places, List<Problem> out) {
        if (!Set.of("SELF", "PARENT").contains(c.path("from").asText(""))) {
            out.add(new Problem(p(n), "«" + label(n) + "»: حدد من أين تبدأ الموافقات."));
        }
        switch (c.path("stop").asText("")) {
            case "MAIN_UNIT", "TOP" -> {
            }
            case "LEVELS" -> {
                if (!c.path("levels").isArray() || c.path("levels").isEmpty()) {
                    out.add(new Problem(p(n), "«" + label(n) + "»: اختر مستوى توقف واحداً على الأقل."));
                }
            }
            case "COUNT" -> {
                int count = c.path("count").asInt(0);
                if (count < 1 || count > 30) {
                    out.add(new Problem(p(n), "«" + label(n) + "»: عدد الموافقات بين 1 و30."));
                }
            }
            case "ORG" -> {
                try {
                    if (!places.orgExists(UUID.fromString(c.path("orgId").asText("")))) {
                        out.add(new Problem(p(n), "«" + label(n) + "»: جهة التوقف غير موجودة أو غير نشطة."));
                    }
                } catch (IllegalArgumentException e) {
                    out.add(new Problem(p(n), "«" + label(n) + "»: اختر جهة التوقف."));
                }
            }
            default -> out.add(new Problem(p(n), "«" + label(n) + "»: حدد أين تتوقف الموافقات."));
        }
    }

    private static void place(Node n, JsonNode a, Map<String, Set<String>> roles, Places places, List<Problem> out) {
        if (!roles.containsKey(a.path("role").asText(""))) {
            out.add(new Problem(p(n), "«" + label(n) + "»: اختر دوراً."));
        }
        String from = a.path("orgFrom").asText("");
        if (!ORG_FROM.contains(from)) {
            out.add(new Problem(p(n), "«" + label(n) + "»: اختر الجهة."));
            return;
        }
        switch (from) {
            case "UP" -> {
                int up = a.path("levelsUp").asInt(0);
                if (up < 1 || up > 30) {
                    out.add(new Problem(p(n), "«" + label(n) + "»: عدد المستويات للأعلى بين 1 و30."));
                }
            }
            case "AT_LEVEL" -> {
                if (!a.hasNonNull("level")) {
                    out.add(new Problem(p(n), "«" + label(n) + "»: حدد المستوى."));
                }
            }
            case "FIXED" -> {
                try {
                    if (!places.orgExists(UUID.fromString(a.path("orgId").asText("")))) {
                        out.add(new Problem(p(n), "«" + label(n) + "»: الجهة المختارة غير موجودة أو غير نشطة."));
                    }
                } catch (IllegalArgumentException e) {
                    out.add(new Problem(p(n), "«" + label(n) + "»: اختر الجهة."));
                }
            }
            case "RESPONSIBLE" -> {
                if (!places.responsibilityExists(a.path("responsibility").asText(""))) {
                    out.add(new Problem(p(n), "«" + label(n) + "»: اختر المسؤولية."));
                }
            }
            default -> {
            }
        }
    }

    private static Set<String> walk(String from, Graph g) {
        Set<String> seen = new HashSet<>();
        ArrayDeque<String> todo = new ArrayDeque<>(List.of(from));
        while (!todo.isEmpty()) {
            String id = todo.poll();
            if (seen.add(id)) {
                g.from(id).forEach(e -> todo.add(e.to()));
            }
        }
        return seen;
    }

    private static String p(Node n) {
        return "node:" + n.id();
    }

    private static String label(Node n) {
        return n.name().isBlank() ? "خطوة بلا اسم" : n.name();
    }
}
