package ae.mover.forms;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Restricted, typed rule language for form visibility/requirement and workflow stage conditions.
 * A rule is a JSON tree of {all|any|not|field|fact} nodes with a fixed operator set. Nothing in a rule is ever
 * evaluated as code, SQL, a script or a network call; unknown constructs are rejected at validation time.
 */
public final class RuleLanguage {

    public static final Set<String> OPS = Set.of("eq", "neq", "gt", "gte", "lt", "lte", "in", "empty", "notEmpty");
    public static final Set<String> FACTS = Set.of("resourceCount", "durationDays", "durationHours", "participantCount", "requestType");
    private static final int MAX_DEPTH = 6;
    private static final int MAX_NODES = 60;

    private RuleLanguage() {
    }

    public record Problem(String path, String message) {
    }

    public static List<Problem> validate(JsonNode rule, Set<String> fieldIds, String path) {
        List<Problem> problems = new ArrayList<>();
        int[] count = {0};
        check(rule, fieldIds, path, 0, count, problems);
        return problems;
    }

    private static void check(JsonNode node, Set<String> fieldIds, String path, int depth, int[] count, List<Problem> out) {
        if (++count[0] > MAX_NODES) {
            out.add(new Problem(path, "القاعدة أكبر من الحد المسموح."));
            return;
        }
        if (depth > MAX_DEPTH) {
            out.add(new Problem(path, "تداخل القاعدة أعمق من الحد المسموح."));
            return;
        }
        if (node == null || !node.isObject()) {
            out.add(new Problem(path, "القاعدة يجب أن تكون كائناً من لغة القواعد المعتمدة."));
            return;
        }
        List<String> keys = new ArrayList<>();
        node.fieldNames().forEachRemaining(keys::add);
        if (keys.contains("all") || keys.contains("any")) {
            String key = keys.contains("all") ? "all" : "any";
            if (keys.size() != 1) {
                out.add(new Problem(path, "عنصر غير مدعوم في لغة القواعد: " + otherKeys(keys, Set.of(key))));
                return;
            }
            JsonNode items = node.get(key);
            if (!items.isArray() || items.isEmpty()) {
                out.add(new Problem(path + "." + key, "يجب أن تحتوي المجموعة على شرط واحد على الأقل."));
                return;
            }
            for (int i = 0; i < items.size(); i++) {
                check(items.get(i), fieldIds, path + "." + key + "[" + i + "]", depth + 1, count, out);
            }
            return;
        }
        if (keys.contains("not")) {
            if (keys.size() != 1) {
                out.add(new Problem(path, "عنصر غير مدعوم في لغة القواعد: " + otherKeys(keys, Set.of("not"))));
                return;
            }
            check(node.get("not"), fieldIds, path + ".not", depth + 1, count, out);
            return;
        }
        boolean isField = keys.contains("field");
        boolean isFact = keys.contains("fact");
        if (isField == isFact) {
            out.add(new Problem(path, "عنصر غير مدعوم في لغة القواعد: " + String.join(", ", keys)
                    + ". المسموح: all, any, not, field, fact."));
            return;
        }
        String subject = isField ? "field" : "fact";
        String extra = otherKeys(keys, Set.of(subject, "op", "value"));
        if (!extra.isEmpty()) {
            out.add(new Problem(path, "عنصر غير مدعوم في لغة القواعد: " + extra));
        }
        JsonNode target = node.get(subject);
        if (!target.isTextual()) {
            out.add(new Problem(path + "." + subject, "المعرف يجب أن يكون نصاً."));
        } else if (isField && !fieldIds.contains(target.asText())) {
            out.add(new Problem(path + ".field", "الحقل «" + target.asText() + "» غير معرف في النموذج."));
        } else if (isFact && !FACTS.contains(target.asText())) {
            out.add(new Problem(path + ".fact", "المعطى «" + target.asText() + "» غير مدعوم."));
        }
        JsonNode op = node.get("op");
        if (op == null || !op.isTextual() || !OPS.contains(op.asText())) {
            out.add(new Problem(path + ".op", "المعامل غير مدعوم. المسموح: " + String.join(", ", OPS)));
            return;
        }
        JsonNode value = node.get("value");
        boolean unary = op.asText().equals("empty") || op.asText().equals("notEmpty");
        if (unary) {
            if (value != null && !value.isNull()) {
                out.add(new Problem(path + ".value", "هذا المعامل لا يأخذ قيمة."));
            }
            return;
        }
        if (value == null || value.isNull()) {
            out.add(new Problem(path + ".value", "القيمة مطلوبة لهذا المعامل."));
            return;
        }
        if (op.asText().equals("in")) {
            if (!value.isArray() || value.isEmpty() || value.size() > 50) {
                out.add(new Problem(path + ".value", "المعامل in يتطلب قائمة قيم (1 إلى 50)."));
                return;
            }
            for (JsonNode v : value) {
                checkScalar(v, path + ".value", out);
            }
        } else {
            checkScalar(value, path + ".value", out);
        }
    }

    private static void checkScalar(JsonNode v, String path, List<Problem> out) {
        if (!(v.isTextual() || v.isNumber() || v.isBoolean())) {
            out.add(new Problem(path, "القيم المسموحة نصوص أو أرقام أو قيم منطقية فقط."));
            return;
        }
        if (v.isTextual()) {
            String s = v.asText();
            if (s.length() > 200) {
                out.add(new Problem(path, "القيمة النصية أطول من المسموح."));
            }
            if (s.contains("${") || s.contains("#{") || s.contains("<script")) {
                out.add(new Problem(path, "القيم تُقارن حرفياً ولا تقبل تعبيرات برمجية."));
            }
        }
    }

    private static String otherKeys(Collection<String> keys, Set<String> allowed) {
        return String.join(", ", keys.stream().filter(k -> !allowed.contains(k)).toList());
    }

    // ---- evaluation ----------------------------------------------------------------------------------

    public static boolean evaluate(JsonNode rule, Map<String, Object> values, Map<String, Object> facts) {
        if (rule == null || rule.isNull() || rule.isMissingNode()) {
            return true;
        }
        if (rule.has("all")) {
            for (JsonNode r : rule.get("all")) {
                if (!evaluate(r, values, facts)) {
                    return false;
                }
            }
            return true;
        }
        if (rule.has("any")) {
            for (JsonNode r : rule.get("any")) {
                if (evaluate(r, values, facts)) {
                    return true;
                }
            }
            return false;
        }
        if (rule.has("not")) {
            return !evaluate(rule.get("not"), values, facts);
        }
        Object actual = rule.has("field") ? values.get(rule.get("field").asText()) : facts.get(rule.get("fact").asText());
        String op = rule.get("op").asText();
        JsonNode expected = rule.get("value");
        return switch (op) {
            case "empty" -> isEmpty(actual);
            case "notEmpty" -> !isEmpty(actual);
            case "eq" -> equalsValue(actual, expected);
            case "neq" -> !equalsValue(actual, expected);
            case "in" -> {
                Iterator<JsonNode> it = expected.elements();
                while (it.hasNext()) {
                    if (equalsValue(actual, it.next())) {
                        yield true;
                    }
                }
                yield false;
            }
            default -> compare(actual, expected, op);
        };
    }

    private static boolean isEmpty(Object v) {
        return v == null || (v instanceof String s && s.isBlank()) || (v instanceof Collection<?> c && c.isEmpty());
    }

    private static boolean equalsValue(Object actual, JsonNode expected) {
        if (actual == null) {
            return false;
        }
        BigDecimal a = number(actual);
        if (a != null && expected.isNumber()) {
            return a.compareTo(expected.decimalValue()) == 0;
        }
        if (actual instanceof Boolean b && expected.isBoolean()) {
            return b == expected.asBoolean();
        }
        return String.valueOf(actual).equals(expected.asText());
    }

    private static boolean compare(Object actual, JsonNode expected, String op) {
        BigDecimal a = number(actual);
        BigDecimal e = expected.isNumber() ? expected.decimalValue() : number(expected.asText());
        if (a == null || e == null) {
            return false;
        }
        int c = a.compareTo(e);
        return switch (op) {
            case "gt" -> c > 0;
            case "gte" -> c >= 0;
            case "lt" -> c < 0;
            case "lte" -> c <= 0;
            default -> false;
        };
    }

    private static BigDecimal number(Object v) {
        if (v instanceof Number n) {
            return new BigDecimal(n.toString());
        }
        if (v instanceof String s && !s.isBlank()) {
            try {
                return new BigDecimal(s.trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }
}
