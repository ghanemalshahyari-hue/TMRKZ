package ae.mover.access;

import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * One explicit target of a scoped grant: an organisation or site (alone or with its descendants), or a resource. An
 * organisation with descendants may be limited to {@code levels} of the hierarchy (ADR-042); {@code reached} is then what
 * those levels find below it today, worked out when the grant is read, so it follows the hierarchy.
 */
public record GrantTarget(String kind, UUID id, boolean includeDescendants, List<Integer> levels, Set<UUID> reached) {

    public static final String ORGANIZATION = "ORGANIZATION";
    public static final String SITE = "SITE";
    public static final String RESOURCE = "RESOURCE";

    public GrantTarget(String kind, UUID id, boolean includeDescendants) {
        this(kind, id, includeDescendants, List.of(), Set.of());
    }

    /** Limited to chosen levels. */
    public boolean limited() {
        return !levels.isEmpty();
    }
}
