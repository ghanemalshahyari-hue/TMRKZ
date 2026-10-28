package ae.mover.forms;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.forms.RuleLanguage.Problem;

/** Validation of form definitions (studio) and of submitted values against a pinned form version (server side). */
public final class FormSchemas {

    public static final Set<String> KINDS = Set.of("text", "textarea", "number", "date", "select", "files");
    public static final Set<String> CHANGE_POLICIES = Set.of("DESCRIPTIVE", "RESTART_STAGES", "FULL_REAPPROVAL");
    public static final Set<String> AUTOFILL = Set.of("CURRENT_USER_NAME", "OWNER_ORG_NAME");
    private static final Set<String> FIELD_KEYS = Set.of("id", "label", "kind", "required", "visible", "options", "min",
            "max", "minLength", "maxLength", "visibleWhen", "requiredWhen", "autofill", "changePolicy", "affectsStages");
    private static final Pattern ID = Pattern.compile("^[a-z][a-z0-9_]{1,39}$");

    private FormSchemas() {
    }

    public static List<Problem> validateSchema(JsonNode schema) {
        List<Problem> out = new ArrayList<>();
        if (schema == null || !schema.isObject() || !schema.has("fields") || !schema.get("fields").isArray()) {
            out.add(new Problem("schema", "تعريف النموذج يجب أن يحتوي قائمة الحقول."));
            return out;
        }
        schema.fieldNames().forEachRemaining(k -> {
            if (!k.equals("fields")) {
                out.add(new Problem("schema." + k, "خاصية غير مدعومة في تعريف النموذج."));
            }
        });
        JsonNode fields = schema.get("fields");
        if (fields.isEmpty() || fields.size() > 100) {
            out.add(new Problem("fields", "عدد الحقول يجب أن يكون بين 1 و100."));
            return out;
        }
        Set<String> ids = new HashSet<>();
        for (JsonNode f : fields) {
            if (f.has("id") && f.get("id").isTextual()) {
                if (!ids.add(f.get("id").asText())) {
                    out.add(new Problem("fields", "معرف الحقل «" + f.get("id").asText() + "» مكرر."));
                }
            }
        }
        for (int i = 0; i < fields.size(); i++) {
            JsonNode f = fields.get(i);
            String p = "fields[" + i + "]";
            if (!f.isObject()) {
                out.add(new Problem(p, "الحقل يجب أن يكون كائناً."));
                continue;
            }
            f.fieldNames().forEachRemaining(k -> {
                if (!FIELD_KEYS.contains(k)) {
                    out.add(new Problem(p + "." + k, "خاصية غير مدعومة في الحقل: " + k));
                }
            });
            String id = text(f, "id");
            if (id == null || !ID.matcher(id).matches()) {
                out.add(new Problem(p + ".id", "معرف الحقل يجب أن يبدأ بحرف لاتيني صغير ويتكون من a-z و0-9 و_."));
            }
            String label = text(f, "label");
            if (label == null || label.isBlank() || label.length() > 120) {
                out.add(new Problem(p + ".label", "اسم الحقل مطلوب (حتى 120 حرفاً)."));
            }
            String kind = text(f, "kind");
            if (kind == null || !KINDS.contains(kind)) {
                out.add(new Problem(p + ".kind", "نوع الحقل غير مدعوم."));
            }
            if (!f.path("required").isBoolean() || !f.path("visible").isBoolean()) {
                out.add(new Problem(p, "الخاصيتان required وvisible مطلوبتان بقيم منطقية."));
            }
            if ("select".equals(kind)) {
                JsonNode options = f.get("options");
                if (options == null || !options.isArray() || options.isEmpty() || options.size() > 50) {
                    out.add(new Problem(p + ".options", "القائمة تحتاج من 1 إلى 50 خياراً."));
                } else {
                    for (JsonNode o : options) {
                        if (!o.isTextual() || o.asText().isBlank() || o.asText().length() > 120) {
                            out.add(new Problem(p + ".options", "كل خيار يجب أن يكون نصاً غير فارغ."));
                        }
                    }
                }
            }
            for (String numeric : List.of("min", "max", "minLength", "maxLength")) {
                if (f.has(numeric) && !f.get(numeric).isNull() && !f.get(numeric).isNumber()) {
                    out.add(new Problem(p + "." + numeric, "القيمة يجب أن تكون رقماً."));
                }
            }
            if (f.has("maxLength") && f.get("maxLength").asInt() > 10000) {
                out.add(new Problem(p + ".maxLength", "الحد الأقصى للطول 10000 حرف."));
            }
            for (String ruleKey : List.of("visibleWhen", "requiredWhen")) {
                JsonNode rule = f.get(ruleKey);
                if (rule != null && !rule.isNull()) {
                    out.addAll(RuleLanguage.validate(rule, ids, p + "." + ruleKey));
                }
            }
            String autofill = text(f, "autofill");
            if (autofill != null && !AUTOFILL.contains(autofill)) {
                out.add(new Problem(p + ".autofill", "مصدر التعبئة التلقائية غير مدعوم."));
            }
            String policy = text(f, "changePolicy");
            if (policy == null || !CHANGE_POLICIES.contains(policy)) {
                out.add(new Problem(p + ".changePolicy", "سياسة التعديل مطلوبة: DESCRIPTIVE أو RESTART_STAGES أو FULL_REAPPROVAL."));
            }
            JsonNode stages = f.get("affectsStages");
            if (stages != null && !stages.isNull()) {
                if (!stages.isArray()) {
                    out.add(new Problem(p + ".affectsStages", "يجب أن تكون قائمة مفاتيح مراحل."));
                } else {
                    for (JsonNode s : stages) {
                        if (!s.isTextual() || !ID.matcher(s.asText()).matches()) {
                            out.add(new Problem(p + ".affectsStages", "مفتاح مرحلة غير صالح."));
                        }
                    }
                }
            }
        }
        return out;
    }

    private static String text(JsonNode node, String key) {
        JsonNode v = node.get(key);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    /**
     * Validates submitted values against a pinned schema. Returns the cleaned values (hidden fields removed,
     * unknown keys dropped) or throws with the list of problems. {@code fileCounts} comes from stored attachments,
     * never from the client.
     */
    public static Map<String, Object> validateValues(JsonNode schema, Map<String, Object> raw, Map<String, Object> facts,
                                                     Map<String, Integer> fileCounts, List<Problem> problems) {
        Map<String, Object> values = new LinkedHashMap<>(raw == null ? Map.of() : raw);
        fileCounts.forEach(values::put);
        Map<String, Object> clean = new LinkedHashMap<>();
        for (JsonNode f : schema.get("fields")) {
            String id = f.get("id").asText();
            String label = f.get("label").asText();
            String kind = f.get("kind").asText();
            boolean visible = f.path("visible").asBoolean(true) && RuleLanguage.evaluate(f.get("visibleWhen"), values, facts);
            if (!visible) {
                continue;
            }
            boolean required = f.path("required").asBoolean(false)
                    || (f.hasNonNull("requiredWhen") && RuleLanguage.evaluate(f.get("requiredWhen"), values, facts));
            Object v = values.get(id);
            boolean empty = v == null || (v instanceof String s && s.isBlank()) || ("files".equals(kind) && ((Number) v).intValue() == 0);
            if (empty) {
                if (required) {
                    problems.add(new Problem(id, "الحقل «" + label + "» مطلوب."));
                }
                continue;
            }
            switch (kind) {
                case "number" -> {
                    Double n = toNumber(v);
                    if (n == null) {
                        problems.add(new Problem(id, "أدخل رقماً صحيحاً في حقل «" + label + "»."));
                    } else if (f.has("min") && n < f.get("min").asDouble() || f.has("max") && n > f.get("max").asDouble()) {
                        problems.add(new Problem(id, "قيمة «" + label + "» خارج المدى المسموح."));
                    } else {
                        clean.put(id, n % 1 == 0 ? (Object) n.longValue() : n);
                    }
                }
                case "date" -> {
                    try {
                        LocalDate.parse(String.valueOf(v));
                        clean.put(id, String.valueOf(v));
                    } catch (DateTimeParseException e) {
                        problems.add(new Problem(id, "صيغة التاريخ غير صحيحة في «" + label + "»."));
                    }
                }
                case "select" -> {
                    boolean ok = false;
                    for (JsonNode o : f.get("options")) {
                        ok |= o.asText().equals(String.valueOf(v));
                    }
                    if (!ok) {
                        problems.add(new Problem(id, "القيمة المختارة في «" + label + "» غير موجودة في القائمة."));
                    } else {
                        clean.put(id, String.valueOf(v));
                    }
                }
                case "files" -> clean.put(id, v);
                default -> {
                    String s = String.valueOf(v).trim();
                    int max = f.has("maxLength") ? f.get("maxLength").asInt() : ("textarea".equals(kind) ? 5000 : 500);
                    int min = f.has("minLength") ? f.get("minLength").asInt() : 0;
                    if (s.length() > max) {
                        problems.add(new Problem(id, "النص في «" + label + "» أطول من " + max + " حرفاً."));
                    } else if (s.length() < min) {
                        problems.add(new Problem(id, "اكتب في «" + label + "» ما لا يقل عن " + min + " أحرف."));
                    } else {
                        clean.put(id, s);
                    }
                }
            }
        }
        return clean;
    }

    private static Double toNumber(Object v) {
        if (v instanceof Number n) {
            return n.doubleValue();
        }
        try {
            return Double.parseDouble(String.valueOf(v).trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
