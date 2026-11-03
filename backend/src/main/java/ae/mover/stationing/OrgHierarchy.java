package ae.mover.stationing;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * The CURRENT organisational hierarchy (Oracle is authoritative; TMRKZ reads its projection). A request keeps its own
 * {@link HierarchySnapshot} of the path it was submitted with; the two are compared, never merged.
 */
public interface OrgHierarchy {

    Optional<OrgUnit> unit(UUID id);

    /** The unit and its ancestors, nearest first, up to the top; empty when the unit is unknown. */
    List<OrgUnit> path(UUID id);

    default boolean isUnder(UUID unit, UUID root) {
        return path(unit).stream().anyMatch(u -> u.id().equals(root));
    }
}
