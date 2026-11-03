package ae.mover.stationing;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Server-side hierarchy drift (owner decisions O-10, O-16): the requesting unit's CURRENT Oracle path compared with the
 * path in its submission snapshot. A drifted request in review or approved-not-activated is paused and returned for
 * organisational confirmation; activation on a drifted hierarchy is refused even before the pause has been recorded.
 * The route is then rebuilt from the SAME requesting unit and every stage is decided again (O-10b).
 */
public final class HierarchyDrift {

    public static final String MESSAGE = "تغير الهيكل التنظيمي بعد تقديم الطلب";

    private HierarchyDrift() {
    }

    public record Drift(boolean drifted, List<UUID> submitted, List<UUID> current) {
    }

    public static Drift detect(HierarchySnapshot snapshot, OrgHierarchy hierarchy) {
        List<UUID> now = hierarchy.path(snapshot.requestingUnit()).stream().map(OrgUnit::id).toList();
        return new Drift(!now.equals(snapshot.path()), snapshot.path(), now);
    }

    /** Whether the request must now be paused. */
    public static boolean mustPause(RestationingState state, HierarchySnapshot snapshot, OrgHierarchy hierarchy) {
        return state.pausesOnHierarchyChange() && detect(snapshot, hierarchy).drifted();
    }

    /** Why activation is refused now, or empty when it may proceed (other activation guards apply as well). */
    public static Optional<String> activationRefusal(RestationingState state, HierarchySnapshot snapshot, OrgHierarchy hierarchy) {
        if (state == RestationingState.PAUSED_HIERARCHY_CHANGED) {
            return Optional.of("الطلب موقوف: " + MESSAGE);
        }
        if (state != RestationingState.APPROVED_NOT_ACTIVATED) {
            return Optional.of("التفعيل بعد الاعتماد النهائي فقط");
        }
        if (detect(snapshot, hierarchy).drifted()) {
            return Optional.of(MESSAGE + " — التفعيل ممنوع حتى إعادة التأكيد وإعادة الاعتماد");
        }
        return Optional.empty();
    }
}
