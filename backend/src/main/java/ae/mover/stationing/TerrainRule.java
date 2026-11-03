package ae.mover.stationing;

import java.util.Comparator;
import java.util.List;

import ae.mover.stationing.StationingPolicy.TerrainClass;

/**
 * The controlling terrain class of a deployment area (owner decisions O-05, O-05b): the class with the largest share
 * of the area governs; if two or more classes tie for the largest share, the tied class highest in the administrator's
 * {@code terrain_class_priority} governs; if any tied class has no place in that order, submission is blocked. Never
 * random, never "most restrictive" or "largest allowance" by itself.
 *
 * <p>Shares come from the approved terrain dataset (PostGIS {@code ST_Area(ST_Intersection(...))} once the dataset is
 * approved and imported; see the stop-gate report). Two shares are equal when their areas differ by at most
 * {@link #TIE_TOLERANCE_M2} — the numeric precision of exact geodesic areas, not a business rule.
 */
public final class TerrainRule {

    public static final double TIE_TOLERANCE_M2 = 0.01;

    private TerrainRule() {
    }

    /** Area of one dataset class inside the deployment geometry. */
    public record TerrainShare(String code, double areaM2) {
    }

    /**
     * @param resolved false when tied classes lack a valid priority (submission blocked)
     */
    public record TerrainDecision(TerrainClass controlling, List<TerrainShare> shares, double totalM2, boolean tie,
                                  List<String> tied, boolean resolved, List<String> priority) {

        public double percent(TerrainShare s) {
            return totalM2 == 0 ? 0 : s.areaM2() * 100 / totalM2;
        }
    }

    public static TerrainDecision decide(List<TerrainShare> shares, StationingPolicy policy) {
        if (shares.isEmpty()) {
            throw new IllegalArgumentException("no terrain coverage for the deployment geometry");
        }
        List<TerrainShare> sorted = shares.stream().sorted(Comparator.comparingDouble(TerrainShare::areaM2).reversed()).toList();
        double total = sorted.stream().mapToDouble(TerrainShare::areaM2).sum();
        double top = sorted.get(0).areaM2();
        List<String> tied = sorted.stream().filter(s -> top - s.areaM2() <= TIE_TOLERANCE_M2).map(TerrainShare::code).toList();
        List<String> priority = policy.terrainClassPriority();
        if (tied.size() == 1) {
            return new TerrainDecision(policy.terrainClass(tied.get(0)), sorted, total, false, tied, true, priority);
        }
        List<String> ranked = tied.stream().filter(priority::contains).sorted(Comparator.comparingInt(priority::indexOf)).toList();
        boolean resolved = ranked.size() == tied.size();
        TerrainClass winner = resolved ? policy.terrainClass(ranked.get(0)) : policy.terrainClass(tied.get(0));
        return new TerrainDecision(winner, sorted, total, true, tied, resolved, priority);
    }
}
