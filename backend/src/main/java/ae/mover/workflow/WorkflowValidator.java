package ae.mover.workflow;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.forms.RuleLanguage;
import ae.mover.forms.RuleLanguage.Problem;

/** Structural validation of workflow definitions before they can be compiled to BPMN and published. */
public final class WorkflowValidator {

    private static final Pattern KEY = Pattern.compile("^[a-z][a-z0-9_]{1,39}$");
    private static final Set<String> TOP_KEYS = Set.of("name", "stages", "execution");
    private static final Set<String> STAGE_KEYS = Set.of("key", "name", "mode", "slaDays", "assignees", "condition", "final", "requiresSignature");
    private static final Set<String> EXEC_KEYS = Set.of("key", "name", "role", "orgFrom", "dueDays", "evidenceRequired");
    private static final Set<String> ORG_FROM = Set.of("REQUEST_ORG", "RESOURCE_ORG", "ANY");

    private WorkflowValidator() {
    }

    /**
     * @param rolePermissions role code → permissions, used to enforce that the final stage is decided only by roles
     *                        holding APPROVE (R-21: parallel/conditional stages never bypass final approval authority)
     * @param fieldIds        field ids of the request type's published form (allowed in stage conditions)
     */
    public static List<Problem> validate(JsonNode def, Map<String, Set<String>> rolePermissions, Set<String> fieldIds) {
        List<Problem> out = new ArrayList<>();
        if (def == null || !def.isObject()) {
            out.add(new Problem("definition", "تعريف التدفق يجب أن يكون كائناً."));
            return out;
        }
        def.fieldNames().forEachRemaining(k -> {
            if (!TOP_KEYS.contains(k)) {
                out.add(new Problem(k, "خاصية غير مدعومة في تعريف التدفق: " + k));
            }
        });
        if (!def.path("name").isTextual() || def.path("name").asText().isBlank()) {
            out.add(new Problem("name", "اسم التدفق مطلوب."));
        }
        JsonNode stages = def.path("stages");
        if (!stages.isArray() || stages.isEmpty() || stages.size() > 20) {
            out.add(new Problem("stages", "التدفق يحتاج من مرحلة واحدة إلى 20 مرحلة."));
            return out;
        }
        Set<String> keys = new HashSet<>();
        for (int i = 0; i < stages.size(); i++) {
            JsonNode s = stages.get(i);
            String p = "stages[" + i + "]";
            boolean last = i == stages.size() - 1;
            s.fieldNames().forEachRemaining(k -> {
                if (!STAGE_KEYS.contains(k)) {
                    out.add(new Problem(p + "." + k, "خاصية غير مدعومة في المرحلة: " + k));
                }
            });
            String key = s.path("key").asText("");
            if (!KEY.matcher(key).matches()) {
                out.add(new Problem(p + ".key", "مفتاح المرحلة يجب أن يتكون من a-z و0-9 و_ ويبدأ بحرف."));
            } else if (!keys.add(key)) {
                out.add(new Problem(p + ".key", "مفتاح المرحلة «" + key + "» مكرر."));
            }
            if (s.path("name").asText("").isBlank()) {
                out.add(new Problem(p + ".name", "اسم المرحلة مطلوب."));
            }
            String mode = s.path("mode").asText("");
            if (!mode.equals("ALL") && !mode.equals("ANY")) {
                out.add(new Problem(p + ".mode", "شرط الإتمام يجب أن يكون ALL أو ANY."));
            }
            int sla = s.path("slaDays").asInt(0);
            if (sla < 1 || sla > 365) {
                out.add(new Problem(p + ".slaDays", "المهلة بين 1 و365 يوماً."));
            }
            JsonNode assignees = s.path("assignees");
            if (!assignees.isArray() || assignees.isEmpty() || assignees.size() > 10) {
                out.add(new Problem(p + ".assignees", "حدد مراجعاً واحداً على الأقل (حتى 10)."));
            } else {
                for (JsonNode a : assignees) {
                    String role = a.path("role").asText("");
                    if (!rolePermissions.containsKey(role)) {
                        out.add(new Problem(p + ".assignees", "الدور «" + role + "» غير معرف."));
                    } else if (last && !rolePermissions.get(role).contains("APPROVE")) {
                        out.add(new Problem(p + ".assignees", "المرحلة الأخيرة تقتصر على أدوار تملك صلاحية الاعتماد النهائي."));
                    } else if (!rolePermissions.get(role).contains("REVIEW")) {
                        out.add(new Problem(p + ".assignees", "الدور «" + role + "» لا يملك صلاحية المراجعة."));
                    }
                    if (!ORG_FROM.contains(a.path("orgFrom").asText(""))) {
                        out.add(new Problem(p + ".assignees", "مصدر جهة المراجع يجب أن يكون REQUEST_ORG أو RESOURCE_ORG أو ANY."));
                    }
                }
            }
            JsonNode condition = s.get("condition");
            if (condition != null && !condition.isNull()) {
                if (last) {
                    out.add(new Problem(p + ".condition", "لا يجوز جعل مرحلة الاعتماد النهائي شرطية."));
                } else {
                    out.addAll(RuleLanguage.validate(condition, fieldIds, p + ".condition"));
                }
            }
            if (s.path("final").asBoolean(false) != last) {
                out.add(new Problem(p + ".final", "المرحلة الأخيرة فقط هي مرحلة الاعتماد النهائي."));
            }
            if (s.path("requiresSignature").asBoolean(false) && !last) {
                out.add(new Problem(p + ".requiresSignature", "التوقيع يرتبط بمرحلة الاعتماد النهائي فقط."));
            }
        }
        JsonNode exec = def.path("execution");
        if (!exec.isMissingNode() && !exec.isArray()) {
            out.add(new Problem("execution", "مهام التنفيذ يجب أن تكون قائمة."));
        } else if (exec.isArray()) {
            Set<String> execKeys = new HashSet<>();
            for (int i = 0; i < exec.size(); i++) {
                JsonNode e = exec.get(i);
                String p = "execution[" + i + "]";
                e.fieldNames().forEachRemaining(k -> {
                    if (!EXEC_KEYS.contains(k)) {
                        out.add(new Problem(p + "." + k, "خاصية غير مدعومة في مهمة التنفيذ: " + k));
                    }
                });
                if (!KEY.matcher(e.path("key").asText("")).matches() || !execKeys.add(e.path("key").asText())) {
                    out.add(new Problem(p + ".key", "مفتاح مهمة التنفيذ غير صالح أو مكرر."));
                }
                if (e.path("name").asText("").isBlank()) {
                    out.add(new Problem(p + ".name", "اسم مهمة التنفيذ مطلوب."));
                }
                String role = e.path("role").asText("");
                if (!rolePermissions.containsKey(role)) {
                    out.add(new Problem(p + ".role", "الدور «" + role + "» غير معرف."));
                } else if (!rolePermissions.get(role).contains("EXECUTE")) {
                    out.add(new Problem(p + ".role", "الدور «" + role + "» لا يملك صلاحية التنفيذ."));
                }
                if (!ORG_FROM.contains(e.path("orgFrom").asText(""))) {
                    out.add(new Problem(p + ".orgFrom", "مصدر الجهة غير صالح."));
                }
                int due = e.path("dueDays").asInt(-1);
                if (due < 0 || due > 365) {
                    out.add(new Problem(p + ".dueDays", "مهلة التنفيذ بين 0 و365 يوماً."));
                }
            }
        }
        return out;
    }
}
