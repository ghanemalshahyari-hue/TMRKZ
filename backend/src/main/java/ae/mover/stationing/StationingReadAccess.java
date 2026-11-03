package ae.mover.stationing;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import ae.mover.access.Grant;
import ae.mover.access.Permission;

/**
 * Read contract for approved consumers (owner decision O-01): the authoritative stationing of units, filtered by the
 * consumer's existing grants. A record is visible only when one grant with VIEW reaches the record's own unit through
 * its resolved organisation scope (descendants included where the grant chose them) — the same {@link Grant#covers}
 * used everywhere else. A unit moved by another branch's request stays visible only to scopes reaching that unit.
 * Only the contract fields are exposed; no person, decision or security data.
 */
public final class StationingReadAccess {

    private StationingReadAccess() {
    }

    public record StationingView(UUID orgId, String orgExternalId, UUID siteId, String siteExternalId, String kind,
                                 Instant from, Instant to) {
    }

    public static boolean visible(Collection<Grant> grants, UUID orgId) {
        return grants.stream().anyMatch(g -> g.has(Permission.VIEW) && g.covers(Set.of(orgId), Set.of()));
    }

    public static List<StationingView> filter(Collection<Grant> grants, Collection<StationingView> views) {
        return views.stream().filter(v -> visible(grants, v.orgId())).toList();
    }
}
