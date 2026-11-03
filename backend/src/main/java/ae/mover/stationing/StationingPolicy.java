package ae.mover.stationing;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Stationing Model V3 policy values (System Properties / Studio; docs/STATIONING_MODEL_V3_AR.md §8). Every business
 * value a Stationing rule uses comes from here, never from code. Owner decisions that are not configurable are fixed in
 * the rules themselves: deployment distance is measured centre to centre (O-04), the terrain class is the one with the
 * largest area (O-05), occupied deployment geography is a hard block (O-08), the route starts at the requesting unit
 * (O-07) and a hierarchy change restarts every stage (O-10b).
 *
 * <p>Versioning, effective dating, reason and reference belong to the stored policy version (schema work after V17,
 * see the stop-gate report); this record is the value set of one version.
 */
public record StationingPolicy(
        double maxFootprintAreaM2,
        DeploymentRequirement deploymentRequirement,
        Leg primary,
        Leg alternative,
        List<TerrainClass> terrainClasses,
        List<String> terrainClassPriority,
        TerrainAppliesTo terrainAppliesTo,
        DistanceException exception,
        CrossBranch crossBranch,
        Routing routing) {

    /** `stationing_areas_requirement`: both deployment areas, or none or both. */
    public enum DeploymentRequirement { REQUIRED, OPTIONAL }

    /** O-06: the terrain allowance extends the maximum only (default) or, if configured, the whole band. */
    public enum TerrainAppliesTo { MAX_ONLY, MIN_AND_MAX }

    /** Who must authorise including a unit of another branch (O-03): one or several. */
    public enum CrossAuthority { OTHER_UNIT, OTHER_UNIT_PARENT, SITE_RESPONSIBLE }

    /** O-09: the first stage is the requesting unit's own approver (default) or its direct parent's. */
    public enum StartAt { SELF, PARENT }

    /** One deployment relation: stationing site → primary, primary → alternative (centre to centre, O-04). */
    public record Leg(double minM, double maxM, boolean terrainApplies) {
    }

    /** A class of the approved terrain dataset and the maximum allowance the administrator configured for it. */
    public record TerrainClass(String code, String label, double allowanceM) {
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

    /** The terrain class for a dataset code; a code the policy does not configure has no allowance. */
    public TerrainClass terrainClass(String code) {
        return terrainClasses.stream().filter(c -> c.code().equals(code)).findFirst()
                .orElse(new TerrainClass(code, "فئة غير مهيأة (" + code + ")", 0));
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
        Set<String> codes = new HashSet<>();
        for (var c : terrainClasses) {
            if (!codes.add(c.code())) {
                out.add("فئة أرض مكررة: " + c.code());
            }
            if (c.allowanceM() < 0) {
                out.add("إضافة فئة الأرض لا تكون سالبة: " + c.code());
            }
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
        return out;
    }
}
