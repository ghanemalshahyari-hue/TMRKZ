package ae.mover.stationing;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * The REQUEST-SUBMISSION SNAPSHOT: the requesting unit's path (unit → top, local ids and Oracle ids) when the route was
 * derived. It locks the submitted request and lets the route be reconstructed and audited; it is never a second source
 * of the hierarchy — the current state stays in {@link OrgHierarchy}.
 */
public record HierarchySnapshot(UUID requestingUnit, List<UUID> path, List<String> externalPath, Instant takenAt) {

    public static HierarchySnapshot take(OrgHierarchy hierarchy, UUID requestingUnit, Instant at) {
        List<OrgUnit> p = hierarchy.path(requestingUnit);
        if (p.isEmpty()) {
            throw new IllegalArgumentException("unknown requesting unit " + requestingUnit);
        }
        return new HierarchySnapshot(requestingUnit, p.stream().map(OrgUnit::id).toList(),
                p.stream().map(u -> u.externalId() == null ? "" : u.externalId()).toList(), at);
    }
}
