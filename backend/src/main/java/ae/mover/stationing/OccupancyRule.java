package ae.mover.stationing;

import java.time.Instant;
import java.util.Collection;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Occupied geography (owner decisions O-08, O-15). A site is occupied only by AUTHORITATIVE records: stationing that
 * stays, an approved use, or a reservation, active at the time. A site ↔ unit link is not an input here at all — a link
 * never occupies a site. A site from which every stationed unit moves in the request is not a conflict for that request.
 */
public final class OccupancyRule {

    private OccupancyRule() {
    }

    public enum Kind { STATIONING, APPROVED_USE, RESERVATION }

    /** One authoritative occupancy record; {@code to} null = open-ended. */
    public record Occupancy(UUID siteId, UUID orgId, Kind kind, Instant from, Instant to, String reference) {

        boolean activeAt(Instant t) {
            return !from.isAfter(t) && (to == null || to.isAfter(t));
        }
    }

    /** Sites that block a proposed site or deployment area of a request moving {@code movingOrgs}. */
    public static Set<UUID> occupiedSites(Collection<Occupancy> records, Set<UUID> movingOrgs, Instant at) {
        Map<UUID, Set<Occupancy>> bySite = records.stream().filter(r -> r.activeAt(at))
                .collect(Collectors.groupingBy(Occupancy::siteId, Collectors.toSet()));
        Set<UUID> out = new HashSet<>();
        bySite.forEach((site, rs) -> {
            boolean stays = rs.stream().anyMatch(r -> r.kind() != Kind.STATIONING || !movingOrgs.contains(r.orgId()));
            if (stays) {
                out.add(site);
            }
        });
        return out;
    }
}
