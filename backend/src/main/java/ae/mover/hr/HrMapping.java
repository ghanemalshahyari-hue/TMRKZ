package ae.mover.hr;

import java.math.BigDecimal;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The HR read contract, compatible with TNQL: business semantics are fixed in code (canonical fields and which are
 * required); the source implementation (view and column names) comes from a published mapping version. Only identity,
 * affiliation, status and position fields exist here — health, passport, contact, rank and similar data cannot be
 * mapped, so they are never selected.
 */
public final class HrMapping {

    private HrMapping() {
    }

    public enum Entity { UNIT, PERSON }

    public record Canonical(Entity entity, String field, boolean required, String label) {
    }

    public static final List<Canonical> CANONICAL = List.of(
            new Canonical(Entity.UNIT, "external_unit_id", true, "معرف الجهة في المصدر"),
            new Canonical(Entity.UNIT, "name", true, "اسم الجهة"),
            new Canonical(Entity.UNIT, "parent_external_unit_id", true, "معرف الجهة الأم (فارغ للجذر)"),
            new Canonical(Entity.UNIT, "status", true, "حالة الجهة"),
            new Canonical(Entity.UNIT, "code", false, "رمز الجهة"),
            new Canonical(Entity.UNIT, "name_en", false, "الاسم بالإنجليزية"),
            new Canonical(Entity.UNIT, "level", false, "مستوى الجهة"),
            new Canonical(Entity.PERSON, "external_person_id", true, "معرف الشخص في المصدر"),
            new Canonical(Entity.PERSON, "employee_number", true, "الرقم الوظيفي"),
            new Canonical(Entity.PERSON, "full_name", true, "الاسم الكامل"),
            new Canonical(Entity.PERSON, "unit_external_id", true, "معرف جهة الانتماء"),
            new Canonical(Entity.PERSON, "status_text", true, "حالة الخدمة"),
            new Canonical(Entity.PERSON, "legacy_employee_number", false, "الرقم الوظيفي السابق"),
            new Canonical(Entity.PERSON, "domain_account", false, "حساب النطاق"),
            new Canonical(Entity.PERSON, "position_id", false, "معرف المنصب"),
            new Canonical(Entity.PERSON, "position", false, "المنصب"),
            new Canonical(Entity.PERSON, "job", false, "الوظيفة"));

    public static final Set<String> TRANSFORMS = Set.of("none", "trim", "upper", "lower", "first_non_empty");
    public static final Set<String> OPERATORS = Set.of("EQUALS", "IN", "NOT_EQUALS");

    /** View names may be schema-qualified; columns are plain identifiers. Both are checked against metadata too. */
    static final Pattern VIEW_NAME = Pattern.compile("^[A-Za-z][A-Za-z0-9_$#]{0,127}(\\.[A-Za-z][A-Za-z0-9_$#]{0,127})?$");
    static final Pattern COLUMN_NAME = Pattern.compile("^[A-Za-z][A-Za-z0-9_$#]{0,127}$");

    public record Field(Entity entity, String field, String column, String transform, List<String> alternates, boolean enabled) {
    }

    public record Rule(String column, String operator, List<String> values) {
    }

    public record Definition(List<Field> fields, Map<Entity, Rule> rules) {
    }

    public static Canonical canonical(Entity entity, String field) {
        return CANONICAL.stream().filter(c -> c.entity() == entity && c.field().equals(field)).findFirst().orElse(null);
    }

    /** Structural problems of a definition, independent of the source (unknown fields, transforms, identifiers). */
    public static List<String> structuralProblems(Definition def) {
        List<String> problems = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Field f : def.fields()) {
            if (f.entity() == null || canonical(f.entity(), f.field()) == null) {
                problems.add("حقل غير معروف في العقد: " + f.field());
                continue;
            }
            if (!seen.add(f.entity() + ":" + f.field())) {
                problems.add("الحقل مكرر في التعيين: " + f.field());
            }
            if (f.column() == null || !COLUMN_NAME.matcher(f.column()).matches()) {
                problems.add("اسم عمود غير صالح للحقل " + f.field());
            }
            String t = f.transform() == null ? "none" : f.transform();
            if (!TRANSFORMS.contains(t)) {
                problems.add("تحويل غير مسموح للحقل " + f.field());
            }
            if ("first_non_empty".equals(t) && (f.alternates() == null || f.alternates().isEmpty())) {
                problems.add("التحويل first_non_empty يحتاج عموداً بديلاً واحداً على الأقل للحقل " + f.field());
            }
            for (String alt : f.alternates() == null ? List.<String>of() : f.alternates()) {
                if (!COLUMN_NAME.matcher(alt).matches()) {
                    problems.add("اسم عمود بديل غير صالح للحقل " + f.field());
                }
            }
        }
        for (Canonical c : CANONICAL) {
            if (c.required() && def.fields().stream().noneMatch(f -> f.entity() == c.entity() && f.field().equals(c.field()) && f.enabled())) {
                problems.add("الحقل الإلزامي غير معيّن: " + c.field());
            }
        }
        for (Entity e : Entity.values()) {
            Rule r = def.rules() == null ? null : def.rules().get(e);
            if (r == null || r.column() == null || !COLUMN_NAME.matcher(r.column()).matches() || !OPERATORS.contains(r.operator())
                    || r.values() == null || r.values().isEmpty()) {
                problems.add("قاعدة السجل النشط غير مكتملة لـ " + (e == Entity.UNIT ? "الجهات" : "الأشخاص"));
            }
        }
        return problems;
    }

    /** Problems against discovered metadata: every chosen column must exist in its view (case-insensitive). */
    public static List<String> metadataProblems(Definition def, Map<Entity, List<String>> discovered) {
        List<String> problems = new ArrayList<>(structuralProblems(def));
        for (Entity e : Entity.values()) {
            if (discovered == null || discovered.get(e) == null || discovered.get(e).isEmpty()) {
                problems.add("لم تُكتشف أعمدة " + (e == Entity.UNIT ? "عرض الجهات" : "عرض الأشخاص") + " بعد.");
            }
        }
        if (!problems.isEmpty()) {
            return problems;
        }
        for (Field f : def.fields()) {
            if (!f.enabled()) {
                continue;
            }
            for (String col : columnsOf(f)) {
                if (resolve(discovered.get(f.entity()), col) == null) {
                    problems.add("العمود غير موجود في المصدر للحقل " + f.field() + ": " + col);
                }
            }
        }
        for (Entity e : Entity.values()) {
            if (resolve(discovered.get(e), def.rules().get(e).column()) == null) {
                problems.add("عمود قاعدة السجل النشط غير موجود في المصدر: " + def.rules().get(e).column());
            }
        }
        return problems;
    }

    private static List<String> columnsOf(Field f) {
        List<String> cols = new ArrayList<>();
        cols.add(f.column());
        if ("first_non_empty".equals(f.transform()) && f.alternates() != null) {
            cols.addAll(f.alternates());
        }
        return cols;
    }

    static String resolve(List<String> available, String column) {
        if (available == null || column == null) {
            return null;
        }
        for (String a : available) {
            if (a.equalsIgnoreCase(column)) {
                return a;
            }
        }
        return null;
    }

    /** A mapping bound to the exact column spellings reported by the source metadata. */
    public static final class Compiled {
        private final Map<Entity, List<String>> select = new EnumMap<>(Entity.class);
        private final Map<Entity, List<Field>> fields = new EnumMap<>(Entity.class);
        private final Map<Entity, Rule> rules = new EnumMap<>(Entity.class);
        private final Map<String, String> exact = new LinkedHashMap<>();

        public List<String> columns(Entity e) {
            return select.get(e);
        }

        /** Canonical values of one source row (column → raw value), plus {@code active} from the active rule. */
        public Map<String, String> convert(Entity e, Map<String, Object> row) {
            Map<String, String> out = new LinkedHashMap<>();
            for (Field f : fields.get(e)) {
                String value = null;
                if ("first_non_empty".equals(f.transform())) {
                    for (String col : columnsOf(f)) {
                        value = text(row.get(exact.get(e + ":" + col.toUpperCase(Locale.ROOT))));
                        if (value != null) {
                            break;
                        }
                    }
                } else {
                    value = text(row.get(exact.get(e + ":" + f.column().toUpperCase(Locale.ROOT))));
                    if (value != null && "upper".equals(f.transform())) {
                        value = value.toUpperCase(Locale.ROOT);
                    } else if (value != null && "lower".equals(f.transform())) {
                        value = value.toLowerCase(Locale.ROOT);
                    }
                }
                out.put(f.field(), value);
            }
            Rule r = rules.get(e);
            String actual = text(row.get(exact.get(e + ":" + r.column().toUpperCase(Locale.ROOT))));
            boolean match = actual != null && r.values().stream().anyMatch(v -> v.trim().equals(actual));
            out.put("active", String.valueOf("NOT_EQUALS".equals(r.operator()) ? actual != null && !match : match));
            return out;
        }
    }

    public static Compiled compile(Definition def, Map<Entity, List<String>> discovered) {
        List<String> problems = metadataProblems(def, discovered);
        if (!problems.isEmpty()) {
            throw new ContractException(problems);
        }
        Compiled c = new Compiled();
        for (Entity e : Entity.values()) {
            Set<String> cols = new LinkedHashSet<>();
            List<Field> fs = new ArrayList<>();
            for (Field f : def.fields()) {
                if (f.entity() != e || !f.enabled()) {
                    continue;
                }
                fs.add(f);
                for (String col : columnsOf(f)) {
                    String exact = resolve(discovered.get(e), col);
                    cols.add(exact);
                    c.exact.put(e + ":" + col.toUpperCase(Locale.ROOT), exact);
                }
            }
            String ruleCol = resolve(discovered.get(e), def.rules().get(e).column());
            cols.add(ruleCol);
            c.exact.put(e + ":" + def.rules().get(e).column().toUpperCase(Locale.ROOT), ruleCol);
            c.select.put(e, List.copyOf(cols));
            c.fields.put(e, fs);
            c.rules.put(e, def.rules().get(e));
        }
        return c;
    }

    /** Normalises a JDBC value to text: Oracle NUMBER arrives as BigDecimal, so 1 and "1" compare equal. */
    static String text(Object value) {
        if (value == null) {
            return null;
        }
        String s;
        if (value instanceof BigDecimal d) {
            s = d.stripTrailingZeros().toPlainString();
        } else if (value instanceof Number n) {
            s = new BigDecimal(n.toString()).stripTrailingZeros().toPlainString();
        } else if (value instanceof java.sql.Timestamp t) {
            s = t.toInstant().toString();
        } else if (value instanceof TemporalAccessor || value instanceof java.util.Date) {
            s = value.toString();
        } else {
            s = value.toString();
        }
        s = s.strip();
        return s.isEmpty() ? null : s;
    }

    /** The mapping does not fit the source; nothing is guessed and the mirror is not touched. */
    public static final class ContractException extends RuntimeException {
        private final List<String> problems;

        public ContractException(List<String> problems) {
            super(String.join("؛ ", problems));
            this.problems = List.copyOf(problems);
        }

        public List<String> problems() {
            return problems;
        }
    }
}
