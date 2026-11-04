package ae.mover.stationing;

import java.util.List;

import ae.mover.stationing.StationingPolicy.SlopeClass;
import ae.mover.stationing.StationingPolicy.SlopeClassification;

/**
 * The owner-approved INITIAL values of `terrain_slope_classification` (stop-gate decision 2, 4 Nov 2026): slope percent
 * from the approved DEM in the documented FAO terrain gradients, as half-open bands so a cell belongs to one class only.
 * They are offered as the starting point of the first policy version; the System Administrator publishes them (or
 * adjusted thresholds) as a versioned change. Allowances are deliberately absent: every allowance is the
 * administrator's value and none is assumed here. Labels are presentation only: ROLLING's «تضاريس متدرجة» is the owner's
 * provisional UI label (next-gate decision, 4 Nov 2026); the codes and thresholds are what rules and audit keep.
 */
public final class StationingPolicyDefaults {

    private StationingPolicyDefaults() {
    }

    public static final List<SlopeClass> FAO_SLOPE_CLASSES = List.of(
            new SlopeClass("FLAT", "مستوٍ / شبه مستوٍ", 0, 2.0),
            new SlopeClass("UNDULATING", "متموّج", 2, 10.0),
            new SlopeClass("ROLLING", "تضاريس متدرجة", 10, 15.0),
            new SlopeClass("HILLY", "تلال", 15, 30.0),
            new SlopeClass("MOUNTAINOUS", "جبلي / شديد التضرس", 30, null));

    public static SlopeClassification slopeClassification(String datasetCode, String datasetVersion) {
        return new SlopeClassification(datasetCode, datasetVersion, FAO_SLOPE_CLASSES);
    }
}
