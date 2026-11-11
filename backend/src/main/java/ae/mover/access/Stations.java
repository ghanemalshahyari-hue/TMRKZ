package ae.mover.access;

import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.stationing.OrgHierarchy;
import ae.mover.stationing.OrgUnit;

/**
 * Who approves at one station of a hierarchy chain, as the movement programme decides it (TNQL
 * {@code _unit_chain_approvers_all}; owner, 11 Nov 2026; ADR-058):
 * <ol>
 * <li>the station's own approvers first: a grant of the role at the unit itself, a unit it names, or a level it names
 * that reaches the unit, a position seat there, and their delegates;</li>
 * <li>only when the station has none, the nearest unit above it, below the main unit, whose approver's grant covers its
 * branch («هذا المستوى ومع أبنائه») signs it — so an approver can approve down to the lowest level that has nobody of its
 * own. Own and inherited approvers are never mixed, so a higher approver cannot sign early where a lower station has its
 * own;</li>
 * </ol>
 * Who HR marks away (leave, absence; ADR-059, as TNQL) still counts as appointed — nothing is inherited past them — but the
 * station goes only to its available people, and only they may act on it; a station whose appointed approvers are all away
 * waits (for a delegate, or for the access managers).
 * A grant is held at its home unit whatever the reach of its role, as a step going to a unit has always read it (ADR-041).
 * A station nobody approves, not even from above, keeps TMRKZ's existing outcomes: refused before sending, skipped when the
 * flow says so, or open to the role. The holder who inherits a vacant station signs it in his own name and then signs his own
 * station separately.
 */
@Component
public class Stations {

    public enum Via { EXPLICIT, INHERITED, NONE }

    /**
     * {@code appointed}: who approves the station; {@code people}: those of them available now, whom it goes to;
     * {@code from}: the unit above whose approver inherits it.
     */
    public record Station(UUID unit, Set<UUID> people, Set<UUID> appointed, Via via, UUID from, String fromName) {

        /** Nobody approves it, not even from above. */
        public boolean empty() {
            return appointed.isEmpty();
        }

        /** Appointed, but every one of them away now. */
        public boolean away() {
            return !appointed.isEmpty() && people.isEmpty();
        }

        /** Whether this person may act at the station. */
        public boolean allows(UUID person) {
            return people.contains(person);
        }
    }

    private final GrantSource grants;
    private final OrgHierarchy hierarchy;
    private final Clock clock;
    private final JdbcClient jdbc;

    public Stations(GrantSource grants, OrgHierarchy hierarchy, Clock clock, JdbcClient jdbc) {
        this.grants = grants;
        this.hierarchy = hierarchy;
        this.clock = clock;
        this.jdbc = jdbc;
    }

    /** The station of a role, as a flow's step going to a unit finds it. */
    public Station of(String role, UUID unit) {
        return resolve(grants.ofRole(role, clock.instant()), unit, false, false);
    }

    /**
     * The station of a re-stationing stage, decided by permission (ADR-034): the unit's own seat is a grant whose home is the
     * unit (or that names it); a grant over everything never sits a seat there.
     */
    public Station byPermission(Permission p, UUID unit) {
        List<RawGrant> held = new ArrayList<>();
        for (String code : jdbc.sql("select code from role_def where :p = any(permissions)").param("p", p.name()).query(String.class).list()) {
            grants.ofRole(code, clock.instant()).stream().filter(g -> g.permissions().contains(p)).forEach(held::add);
        }
        return resolve(held, unit, true, true);
    }

    Station resolve(List<RawGrant> held, UUID unit, boolean homeAlso, boolean noAll) {
        // re-stationing seats were never sat by a grant over everything (ADR-034)
        List<RawGrant> usable = noAll ? held.stream().filter(g -> !g.spec().all()).toList() : held;
        Set<UUID> explicit = new LinkedHashSet<>();
        for (RawGrant g : usable) {
            if (anchoredAt(g, unit, homeAlso)) {
                explicit.add(g.personId());
            }
        }
        if (!explicit.isEmpty()) {
            return new Station(unit, available(explicit), explicit, Via.EXPLICIT, unit, null);
        }
        List<OrgUnit> path = hierarchy.path(unit);
        // a main unit only groups its units and is never a station; nothing above it is inherited (TNQL's capped chain)
        if (!path.isEmpty() && !path.get(0).main()) {
            for (int i = 1; i < path.size(); i++) {
                OrgUnit above = path.get(i);
                if (above.main()) {
                    break;
                }
                Set<UUID> people = new LinkedHashSet<>();
                for (RawGrant g : usable) {
                    if (branchFrom(g, above.id())) {
                        people.add(g.personId());
                    }
                }
                if (!people.isEmpty()) {
                    return new Station(unit, available(people), people, Via.INHERITED, above.id(), above.name());
                }
            }
        }
        return new Station(unit, Set.of(), Set.of(), Via.NONE, null, null);
    }

    /** Those not marked away by HR now. */
    private Set<UUID> available(Set<UUID> people) {
        if (people.isEmpty()) {
            return people;
        }
        Set<UUID> away = new java.util.HashSet<>(jdbc.sql("select id from person where hr_unavailable is not null and id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", ae.mover.common.Db.ids(people)).query(UUID.class).list());
        if (away.isEmpty()) {
            return people;
        }
        Set<UUID> out = new LinkedHashSet<>(people);
        out.removeAll(away);
        return out;
    }

    private static List<GrantTarget> namedUnits(RawGrant g) {
        return g.targets().stream().filter(t -> GrantTarget.ORGANIZATION.equals(t.kind())).toList();
    }

    /** The grant is held at this very unit: its home when it names no unit, a unit it names, or a level it names reaching it. */
    static boolean anchoredAt(RawGrant g, UUID unit, boolean homeAlso) {
        List<GrantTarget> units = namedUnits(g);
        boolean home = unit.equals(g.orgId());
        if (units.isEmpty()) {
            return home;
        }
        return (homeAlso && home) || units.stream().anyMatch(t -> t.id().equals(unit) || t.reached().contains(unit));
    }

    /** The grant is held at {@code anchor} with all its branch («هذا المستوى ومع أبنائه»). */
    static boolean branchFrom(RawGrant g, UUID anchor) {
        List<GrantTarget> units = namedUnits(g);
        if (units.isEmpty()) {
            return anchor.equals(g.orgId()) && g.spec().orgs().stream().anyMatch(t -> t.id().equals(anchor) && t.includeDescendants() && !t.limited());
        }
        return units.stream().anyMatch(t -> t.id().equals(anchor) && t.includeDescendants() && !t.limited());
    }
}
