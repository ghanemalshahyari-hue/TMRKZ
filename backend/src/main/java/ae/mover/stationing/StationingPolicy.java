package ae.mover.stationing;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Stationing Model V3 policy values (System Properties / Studio; docs/STATIONING_MODEL_V3_AR.md §8). Every business
 * value a Stationing rule uses comes from here, never from code. Owner decisions that are not configurable are fixed in
 * the rules themselves: deployment distance is measured centre to centre (O-04), the terrain class is the one with the
 * largest area (O-05), occupied deployment geography is a hard block (O-08), the route starts at the requesting unit
 * (O-07) and a hierarchy change restarts every stage (O-10b).
 *
 * <p>Terrain class and terrain allowance stay separate (owner stop-gate decision 2): the class of a terrain cell comes
 * from its slope percent in the approved dataset through {@link #terrainSlopeClassification} (half-open bands, the FAO
 * gradients as the initial values), and the allowance of each class is a separate administrator value in
 * {@link #terrainAllowancesM}; no allowance is ever assumed. The allowance extends the maximum only (O-06).
 *
 * <p>The initial footprint of a deployment area placed by a single map click is {@link #deploymentAreaDefault} (owner
 * decision, 5 Nov 2026): an administrator value like every other, never a size in client code. It is the last component
 * and nullable so versions stored before it read it as null («not configured») without a migration.
 *
 * <p>Versioning, effective dating, author, reason and reference belong to the stored version
 * ({@code stationing_policy_version}, {@link StationingPolicyStore}); this record is the value set of one version.
 */
public record StationingPolicy(
        double maxFootprintAreaM2,
        DeploymentRequirement deploymentRequirement,
        Leg primary,
        Leg alternative,
        SlopeClassification terrainSlopeClassification,
        Map<String, Double> terrainAllowancesM,
        List<String> terrainClassPriority,
        TerrainAppliesTo terrainAppliesTo,
        DistanceException exception,
        CrossBranch crossBranch,
        Routing routing,
        DeploymentAreaDefault deploymentAreaDefault) {

    /** `stationing_areas_requirement`: both deployment areas, or none or both. */
    public enum DeploymentRequirement { REQUIRED, OPTIONAL }

    /** O-06: the terrain allowance extends the maximum only; MIN_AND_MAX is never publishable (the minimum stays). */
    public enum TerrainAppliesTo { MAX_ONLY, MIN_AND_MAX }

    /** Largest slope the dataset encodes (uint16 percent × 100, 65535 = no data); a threshold must stay below it. */
    public static final double MAX_ENCODED_SLOPE_PCT = 655.34;

    /** Who must authorise including a unit of another branch (O-03): one or several. */
    public enum CrossAuthority { OTHER_UNIT, OTHER_UNIT_PARENT, SITE_RESPONSIBLE }

    /** O-09: the first stage is the requesting unit's own approver (default) or its direct parent's. */
    public enum StartAt { SELF, PARENT }

    /**
     * Upper bound of {@link DeploymentAreaDefault#areaM2()}: 25 km². Deployment areas have no footprint maximum, so this
     * is not a rule of the model, only a guard against a mistyped value drawing an absurd starting shape.
     */
    public static final double MAX_DEPLOYMENT_AREA_DEFAULT_M2 = 25_000_000;

    /** The shape a single click draws; CIRCLE is drawn by the client as a regular 16-vertex polygon of the same area. */
    public enum Shape { SQUARE, CIRCLE }

    /** The initial footprint of a deployment area placed by a single map click: its shape and area in m². */
    public record DeploymentAreaDefault(Shape shape, double areaM2) {
    }

    /** One deployment relation: stationing site → primary, primary → alternative (centre to centre, O-04). */
    public record Leg(double minM, double maxM, boolean terrainApplies) {
    }

    /** A terrain class as the rules use it: code and label from the classification, its configured allowance. */
    public record TerrainClass(String code, String label, double allowanceM) {
    }

    /**
     * `terrain_slope_classification`: the approved dataset it applies to and contiguous half-open slope bands
     * [fromPct, toPct), the first from 0 and the last open-ended (toPct null), so a cell belongs to exactly one class.
     */
    public record SlopeClassification(String datasetCode, String datasetVersion, List<SlopeClass> classes) {

        /** The class of a slope percent; null when the classification does not cover it (an invalid policy). */
        public SlopeClass classify(double slopePct) {
            return classes.stream().filter(c -> slopePct >= c.fromPct() && (c.toPct() == null || slopePct < c.toPct()))
                    .findFirst().orElse(null);
        }
    }

    public record SlopeClass(String code, String label, double fromPct, Double toPct) {
    }

    /** An explicit, reasoned, permission-controlled distance exception above the effective maximum. */
    public record DistanceException(boolean allowed, double maxExtraM) {
    }

    /** O-03 / O-03b: never automatic; which authorities; whether each needs an independent stage and human. */
    public record CrossBranch(boolean allowed, List<CrossAuthority> authorities, boolean independent) {
    }

    /** For one Oracle level value: does it approve, the stage label, the final stage, the facts its decision rests on. */
    public record RoutingLevel(int level, boolean approves, String label, boolean finalStage, Set<Fact> dependsOn) {
    }

    public record Routing(StartAt startAt, List<RoutingLevel> levels) {
    }

    /** The terrain class for a code: label from the classification, allowance from the administrator's values. */
    public TerrainClass terrainClass(String code) {
        String label = terrainSlopeClassification.classes().stream().filter(c -> c.code().equals(code)).map(SlopeClass::label)
                .findFirst().orElse("فئة غير مهيأة (" + code + ")");
        Double allowance = terrainAllowancesM.get(code);
        return new TerrainClass(code, label, allowance == null ? 0 : allowance);
    }

    /** Problems that make the policy unpublishable; empty when it is valid. */
    public List<String> problems() {
        List<String> out = new ArrayList<>();
        if (!(maxFootprintAreaM2 > 0)) {
            out.add("الحد الأقصى لمساحة موقع إعادة التمركز يجب أن يكون أكبر من صفر");
        }
        for (var leg : List.of(primary, alternative)) {
            if (leg.minM() < 0 || leg.maxM() <= 0 || leg.minM() > leg.maxM()) {
                out.add("نطاق مسافة غير صالح: " + leg.minM() + "–" + leg.maxM() + " م");
            }
        }
        Set<String> codes = classificationProblems(out);
        for (String c : codes) {
            Double a = terrainAllowancesM.get(c);
            if (a == null) {
                out.add("لم تُهيأ إضافة فئة الأرض «" + c + "» (القيمة يحددها المسؤول، والصفر قيمة صريحة)");
            } else if (a < 0) {
                out.add("إضافة فئة الأرض لا تكون سالبة: " + c);
            }
        }
        for (String c : terrainAllowancesM.keySet()) {
            if (!codes.contains(c)) {
                out.add("إضافة لفئة غير موجودة في تصنيف الميل: " + c);
            }
        }
        if (terrainAppliesTo != TerrainAppliesTo.MAX_ONLY) {
            out.add("إضافة الأرض تمد الحد الأقصى فقط، والحد الأدنى لا يتغير (O-06)");
        }
        Set<String> seen = new HashSet<>();
        for (var c : terrainClassPriority) {
            if (!codes.contains(c)) {
                out.add("ترتيب الأولوية يذكر فئة غير مهيأة: " + c);
            }
            if (!seen.add(c)) {
                out.add("ترتيب الأولوية يكرر الفئة: " + c);
            }
        }
        if (exception.allowed() && exception.maxExtraM() <= 0) {
            out.add("أقصى زيادة الاستثناء يجب أن تكون أكبر من صفر");
        }
        if (crossBranch.allowed() && crossBranch.authorities().isEmpty()) {
            out.add("ضم وحدة من فرع آخر يحتاج سلطة واحدة على الأقل");
        }
        Set<Integer> levels = new HashSet<>();
        for (var l : routing.levels()) {
            if (!levels.add(l.level())) {
                out.add("مستوى مكرر في المسار: " + l.level());
            }
            if (l.finalStage() && !l.approves()) {
                out.add("المستوى النهائي يجب أن يعتمد: " + l.level());
            }
        }
        if (routing.levels().stream().noneMatch(RoutingLevel::finalStage)) {
            out.add("لا مستوى نهائي في إعداد المسار");
        }
        if (deploymentAreaDefault != null) { // absent is valid: not configured
            if (deploymentAreaDefault.shape() == null) {
                out.add("شكل المنطقة الابتدائية لمنطقة الانتشار مطلوب (مربع أو دائرة)");
            }
            double a = deploymentAreaDefault.areaM2();
            if (!(a > 0)) {
                out.add("مساحة المنطقة الابتدائية لمنطقة الانتشار يجب أن تكون أكبر من صفر");
            } else if (a > MAX_DEPLOYMENT_AREA_DEFAULT_M2) { // JSON 1e400 reads as infinity, which BigDecimal refuses
                out.add("مساحة المنطقة الابتدائية لمنطقة الانتشار لا تتجاوز 25 كم² (25000000 م²): "
                        + (Double.isInfinite(a) ? "∞" : BigDecimal.valueOf(a).toPlainString()) + " م²");
            }
        }
        return out;
    }

    /** Validates `terrain_slope_classification`; returns its class codes. */
    private Set<String> classificationProblems(List<String> out) {
        Set<String> codes = new HashSet<>();
        SlopeClassification sc = terrainSlopeClassification;
        if (sc == null || sc.classes() == null || sc.classes().isEmpty()) {
            out.add("تصنيف الميل بلا فئات");
            return codes;
        }
        if (blank(sc.datasetCode()) || blank(sc.datasetVersion())) {
            out.add("تصنيف الميل يجب أن يذكر مجموعة بيانات الأرض المعتمدة وإصدارها");
        }
        List<SlopeClass> cs = sc.classes();
        for (int i = 0; i < cs.size(); i++) {
            SlopeClass c = cs.get(i);
            if (blank(c.code()) || blank(c.label())) {
                out.add("كل فئة ميل تحتاج رمزاً وتسمية");
                continue;
            }
            if (!codes.add(c.code())) {
                out.add("فئة أرض مكررة: " + c.code());
            }
            boolean last = i == cs.size() - 1;
            if (i == 0 && c.fromPct() != 0) {
                out.add("أول فئة ميل تبدأ من 0٪");
            }
            if (last != (c.toPct() == null)) {
                out.add(last ? "آخر فئة ميل مفتوحة الحد الأعلى" : "فئة الميل «" + c.code() + "» تحتاج حداً أعلى");
            }
            if (c.toPct() != null && !(c.toPct() > c.fromPct())) {
                out.add("حدود فئة الميل «" + c.code() + "» غير صالحة: " + c.fromPct() + "–" + c.toPct() + "٪");
            }
            if (i > 0 && cs.get(i - 1).toPct() != null && cs.get(i - 1).toPct() != c.fromPct()) {
                out.add("فئات الميل غير متصلة عند «" + c.code() + "»: كل فئة تبدأ حيث تنتهي سابقتها");
            }
            for (Double t : new Double[] {c.fromPct(), c.toPct()}) {
                if (t != null && (t > MAX_ENCODED_SLOPE_PCT || new BigDecimal(Double.toString(t)).stripTrailingZeros().scale() > 2)) {
                    out.add("حد الميل " + t + "٪ يجب أن يكون بخانتين عشريتين على الأكثر وأقل من " + MAX_ENCODED_SLOPE_PCT + "٪");
                }
            }
        }
        return codes;
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
