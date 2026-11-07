package ae.mover.stationing;

import java.util.ArrayList;
import java.util.List;

import ae.mover.stationing.StationingPolicy.DeploymentRequirement;
import ae.mover.stationing.StationingPolicy.Leg;
import ae.mover.stationing.StationingPolicy.TerrainAppliesTo;
import ae.mover.stationing.TerrainRule.TerrainDecision;

/**
 * Deployment and footprint rules of Model V3. Distances apply to deployment only (none to re-stationing itself), are
 * measured centre to centre (O-04) by {@link GeoMeasure}, and the terrain allowance extends the maximum only unless the
 * policy says otherwise (O-06). Occupied deployment geography is a hard block (O-08) — see {@link OccupancyRule}.
 */
public final class DeploymentRules {

    private DeploymentRules() {
    }

    public enum LegStatus { NOT_PLACED, OK, NEEDS_EXCEPTION, OUT_OF_RANGE, TERRAIN_TIE_UNRESOLVED }

    public record LegCheck(double baseMinM, double baseMaxM, double effectiveMinM, double effectiveMaxM, Double exceptionMaxM,
                           Double distanceM, TerrainDecision terrain, LegStatus status) {
    }

    /**
     * @param distanceM centre-to-centre distance, or null when the area is not placed
     * @param terrain   the terrain decision for the placed area, or null when the leg does not apply terrain
     */
    public static LegCheck leg(Leg leg, StationingPolicy policy, Double distanceM, TerrainDecision terrain) {
        TerrainDecision t = leg.terrainApplies() ? terrain : null;
        double add = t == null ? 0 : policy.terrainAddM(leg, t.controlling());
        double min = leg.minM() + (policy.terrainAppliesTo() == TerrainAppliesTo.MIN_AND_MAX ? add : 0);
        double max = leg.maxM() + add;
        Double exceptionMax = policy.exception().allowed() ? max + policy.exception().maxExtraM() : null;
        LegStatus status;
        if (distanceM == null) {
            status = LegStatus.NOT_PLACED;
        } else if (t != null && t.tie() && !t.resolved()) {
            status = LegStatus.TERRAIN_TIE_UNRESOLVED;
        } else if (distanceM >= min && distanceM <= max) {
            status = LegStatus.OK;
        } else if (exceptionMax != null && distanceM > max && distanceM <= exceptionMax) {
            status = LegStatus.NEEDS_EXCEPTION;
        } else {
            status = LegStatus.OUT_OF_RANGE;
        }
        return new LegCheck(leg.minM(), leg.maxM(), min, max, exceptionMax, distanceM, t, status);
    }

    /** `stationing_areas_requirement`: REQUIRED needs both; OPTIONAL accepts none or both, never one alone. */
    public static List<String> pair(DeploymentRequirement requirement, boolean primary, boolean alternative) {
        List<String> out = new ArrayList<>();
        if (requirement == DeploymentRequirement.REQUIRED && !(primary && alternative)) {
            out.add("منطقتا الانتشار الرئيسية والبديلة مطلوبتان في السياسة السارية");
        }
        if (requirement == DeploymentRequirement.OPTIONAL && primary != alternative) {
            out.add("الانتشار زوج كامل: الرئيسية والبديلة معاً، أو لا شيء");
        }
        return out;
    }

    /** `max_restationing_footprint_area`: exceeding it blocks submission; nothing is resized. */
    public static boolean footprintWithin(double areaM2, StationingPolicy policy) {
        return areaM2 <= policy.maxFootprintAreaM2();
    }
}
