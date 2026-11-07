package ae.mover.workflow;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.Db;
import ae.mover.stationing.OrgHierarchy;
import ae.mover.stationing.OrgUnit;
import ae.mover.workflow.WorkflowDefinition.Assignee;

/**
 * Finds the place of a role in a flow for one request (ADR-041), so a flow is written once and works for any number of
 * units. A step never silently disappears: when no unit is found it stays open to any holder of the role in scope, and the
 * studio reports which units end up there.
 */
@Component
public class PlaceResolver {

    private final JdbcClient jdbc;
    private final OrgHierarchy hierarchy;
    private final Clock clock;
    private final ae.mover.access.GrantSource grants;

    public PlaceResolver(JdbcClient jdbc, OrgHierarchy hierarchy, Clock clock, ae.mover.access.GrantSource grants) {
        this.grants = grants;
        this.jdbc = jdbc;
        this.hierarchy = hierarchy;
        this.clock = clock;
    }

    /** {@code orgs} found, or {@code anyOrg}: any unit in scope. {@code unresolved}: the selector found nothing. */
    public record Place(List<UUID> orgs, boolean anyOrg, boolean unresolved) {
        static Place any(boolean unresolved) {
            return new Place(List.of(), true, unresolved);
        }

        public static Place of(UUID org) {
            return new Place(List.of(org), false, false);
        }
    }

    public Place resolve(Assignee a, UUID requestOrg, List<UUID> resourceIds) {
        return switch (a.orgFrom()) {
            case "REQUEST_ORG", "BY_SCOPE" -> Place.of(requestOrg);
            case "RESOURCE_ORG" -> {
                List<UUID> orgs = resourceOrgs(resourceIds);
                yield orgs.isEmpty() ? Place.any(false) : new Place(orgs, false, false);
            }
            case "UP" -> {
                List<OrgUnit> path = hierarchy.path(requestOrg);
                int up = a.levelsUp() == null ? 1 : a.levelsUp();
                yield path.isEmpty() ? Place.any(true) : Place.of(path.get(Math.min(up, path.size() - 1)).id());
            }
            case "AT_LEVEL" -> hierarchy.path(requestOrg).stream().filter(u -> a.level() != null && a.level().equals(u.level())).findFirst()
                    .map(u -> Place.of(u.id())).orElse(Place.any(true));
            case "FIXED" -> a.orgId() == null ? Place.any(true) : Place.of(UUID.fromString(a.orgId()));
            case "RESPONSIBLE" -> {
                Map<UUID, UUID> rules = rules(a.responsibility());
                yield hierarchy.path(requestOrg).stream().filter(u -> rules.containsKey(u.id())).findFirst()
                        .map(u -> Place.of(rules.get(u.id()))).orElse(Place.any(true));
            }
            default -> Place.any(false);
        };
    }

    public List<UUID> resourceOrgs(List<UUID> resourceIds) {
        return jdbc.sql("""
                select distinct sr.organization_id from resource r
                join site_responsibility sr on sr.site_id = r.site_id and sr.valid_to is null
                where r.id = any(string_to_array(:ids, ',')::uuid[]) order by 1""")
                .param("ids", Db.ids(resourceIds)).query(UUID.class).list();
    }

    /**
     * One approval climbing the hierarchy from the requesting unit (ADR-041): the units it passes, nearest first. It stops at
     * what the flow says, never at a fixed depth: the main unit of the branch (or the top, where a branch has none), the
     * first of several levels, a number of approvals, or one unit. A requesting unit already at or above the stop has nothing
     * to climb. {@code onlyLevels} keeps only those levels.
     */
    public List<OrgUnit> chain(com.fasterxml.jackson.databind.JsonNode chain, UUID requestOrg) {
        List<OrgUnit> path = hierarchy.path(requestOrg);
        boolean fromSelf = "SELF".equals(chain.path("from").asText("PARENT"));
        String stop = chain.path("stop").asText("MAIN_UNIT");
        Set<Integer> levels = new java.util.HashSet<>();
        chain.path("levels").forEach(l -> levels.add(l.asInt()));
        Set<Integer> only = new java.util.HashSet<>();
        chain.path("onlyLevels").forEach(l -> only.add(l.asInt()));
        int count = chain.path("count").asInt(0);
        String orgId = chain.path("orgId").asText("");
        java.util.function.Predicate<OrgUnit> atStop = switch (stop) {
            case "TOP" -> u -> u.parentId() == null;
            case "LEVELS" -> u -> u.level() != null && levels.contains(u.level());
            case "ORG" -> u -> u.id().toString().equals(orgId);
            case "COUNT" -> u -> false;
            default -> u -> u.main() || u.parentId() == null; // MAIN_UNIT: a branch with no flagged unit stops at its top
        };
        // as in the movement programme, a main unit only groups its units and is never a station: the climb ends below it
        boolean belowMain = "MAIN_UNIT".equals(stop);
        List<OrgUnit> out = new ArrayList<>();
        if (path.isEmpty() || (!fromSelf && atStop.test(path.get(0)))) {
            return out;
        }
        boolean reached = "COUNT".equals(stop);
        for (int i = fromSelf ? 0 : 1; i < path.size(); i++) {
            OrgUnit u = path.get(i);
            if (belowMain && u.main()) {
                reached = true;
                break;
            }
            if (only.isEmpty() || (u.level() != null && only.contains(u.level()))) {
                out.add(u);
            }
            if ("COUNT".equals(stop) && out.size() >= count) {
                break;
            }
            if (atStop.test(u)) {
                reached = true;
                break;
            }
        }
        // the stop is not above this unit (a level below it, a unit in another branch): nothing to climb
        return reached ? out : new ArrayList<>();
    }

    /**
     * The slots of a climbing approval. A level where the requester is the only holder is passed, as a unit never approves
     * through its own applicant. A level with nobody stays, and waits for the access managers, unless the flow says to skip it.
     */
    public List<UUID> chainOrgs(String role, com.fasterxml.jackson.databind.JsonNode chain, UUID requestOrg, Set<UUID> requesters) {
        boolean skipEmpty = chain.path("skipEmpty").asBoolean(false);
        return chain(chain, requestOrg).stream().map(OrgUnit::id).filter(id -> {
            Set<UUID> people = holders(role, Place.of(id));
            return people.isEmpty() ? !skipEmpty : !requesters.containsAll(people);
        }).toList();
    }

    /** A unit on the climb where nobody holds the role, for refusing a request before it is sent. */
    public java.util.Optional<OrgUnit> chainGap(String role, com.fasterxml.jackson.databind.JsonNode chain, UUID requestOrg) {
        return chain.path("skipEmpty").asBoolean(false) ? java.util.Optional.empty()
                : chain(chain, requestOrg).stream().filter(u -> holders(role, Place.of(u.id())).isEmpty()).findFirst();
    }

    /** What a flow's questions can ask about the requesting unit. */
    public Map<String, Object> unitFacts(UUID requestOrg) {
        Map<String, Object> out = new HashMap<>();
        hierarchy.path(requestOrg).stream().findFirst().ifPresent(u -> {
            out.put("requesterLevel", u.level());
            out.put("requesterIsMain", u.main() || u.parentId() == null ? "YES" : "NO");
            out.put("requesterHasParent", u.parentId() != null ? "YES" : "NO");
        });
        return out;
    }

    /** A responsibility's rules: units it is set on → the unit responsible. */
    public Map<UUID, UUID> rules(String responsibility) {
        Map<UUID, UUID> out = new HashMap<>();
        jdbc.sql("select scope_org_id, responsible_org_id from org_responsibility_rule where responsibility_code = :c")
                .param("c", responsibility == null ? "" : responsibility)
                .query((rs, n) -> out.put(Db.uuid(rs, "scope_org_id"), Db.uuid(rs, "responsible_org_id"))).list();
        return out;
    }

    /**
     * Who a step found by scope goes to (ADR-042, as «معتمد عمليات الوحدة» in the movement programme): those whose grant of
     * the role reaches the requesting unit, and of those only the nearest. A grant named on the unit itself comes before one
     * on a unit above it, and one over everything comes last, so a branch can have its own approver under the unit's.
     */
    public record ScopeMatch(UUID anchor, boolean everywhere, Set<UUID> people, boolean required, List<UUID> routed) {
    }

    public static final String UNIT_OPERATIONS_ROLE = "UNIT_OPERATIONS_APPROVER";

    /**
     * The periods of «اعتماد عمليات الوحدة حسب الوقت» (ADR-042): the nearest command up to the main unit that has any decides.
     * Empty: no schedule. A schedule with no period covering now answers {@code List.of()} inside the optional: nobody, refused.
     */
    private java.util.Optional<List<UUID>> routedNow(UUID requestOrg) {
        java.time.ZonedDateTime now = clock.instant().atZone(java.time.ZoneId.of("Asia/Dubai"));
        int day = now.getDayOfWeek().getValue() % 7;
        for (OrgUnit u : hierarchy.path(requestOrg)) {
            List<Map<String, Object>> routes = jdbc.sql("""
                    select r.id, r.time_from, r.time_to, array_to_string(r.days, ',') as days from unit_ops_route r
                    where r.command_org_id = :o and r.active""").param("o", u.id()).query().listOfRows();
            if (!routes.isEmpty()) {
                java.time.LocalTime t = now.toLocalTime();
                for (Map<String, Object> r : routes) {
                    java.time.LocalTime from = ((java.sql.Time) r.get("time_from")).toLocalTime();
                    java.time.LocalTime to = ((java.sql.Time) r.get("time_to")).toLocalTime();
                    boolean inside = from.isBefore(to) ? !t.isBefore(from) && t.isBefore(to) : !t.isBefore(from) || t.isBefore(to);
                    if (inside && java.util.Arrays.asList(((String) r.get("days")).split(",")).contains(String.valueOf(day))) {
                        return java.util.Optional.of(jdbc.sql("select organization_id from unit_ops_route_target where route_id = :r")
                                .param("r", r.get("id")).query(UUID.class).list());
                    }
                }
                return java.util.Optional.of(List.of());
            }
            if (u.main()) {
                break;
            }
        }
        return java.util.Optional.empty();
    }

    /** Who acts for routed units: the routed unit's own people, among those whose grant reaches it. */
    public Set<UUID> routedHolders(String role, List<UUID> units) {
        Set<UUID> people = new LinkedHashSet<>();
        for (ae.mover.access.RawGrant g : grants.ofRole(role, clock.instant())) {
            Set<UUID> home = hierarchy.path(g.orgId()).stream().map(OrgUnit::id).collect(java.util.stream.Collectors.toSet());
            home.add(g.orgId());
            for (UUID unit : units) {
                List<UUID> path = new ArrayList<>(hierarchy.path(unit).stream().map(OrgUnit::id).toList());
                if (path.isEmpty()) {
                    path.add(unit);
                }
                if (home.contains(unit) && reach(g, path) >= 0) {
                    people.add(g.personId());
                }
            }
        }
        return people;
    }

    public ScopeMatch scope(String role, UUID requestOrg) {
        if (UNIT_OPERATIONS_ROLE.equals(role)) {
            var routed = routedNow(requestOrg);
            if (routed.isPresent()) {
                List<UUID> units = routed.get();
                return new ScopeMatch(units.isEmpty() ? null : units.get(0), false, units.isEmpty() ? Set.of() : routedHolders(role, units), true, units);
            }
        }
        List<UUID> path = new ArrayList<>(hierarchy.path(requestOrg).stream().map(OrgUnit::id).toList());
        if (path.isEmpty()) {
            path.add(requestOrg);
        }
        int best = Integer.MAX_VALUE;
        Set<UUID> people = new LinkedHashSet<>();
        List<ae.mover.access.RawGrant> held = grants.ofRole(role, clock.instant());
        for (ae.mover.access.RawGrant g : held) {
            int d = reach(g, path);
            if (d < 0 || d > best) {
                continue;
            }
            if (d < best) {
                people.clear();
                best = d;
            }
            people.add(g.personId());
        }
        boolean everywhere = best == path.size();
        return new ScopeMatch(people.isEmpty() || everywhere ? null : path.get(best), everywhere, people,
                !people.isEmpty() || usedInCommand(held, requestOrg), null);
    }

    /**
     * Whether this unit's command uses the step at all: someone holds the role somewhere under its main unit. A command where
     * nobody does has no such step and the request goes on; one where someone does, but not for this unit, must not be passed
     * silently (ADR-042, the movement programme's «not required» and «required and broken»).
     */
    private boolean usedInCommand(List<ae.mover.access.RawGrant> held, UUID requestOrg) {
        List<OrgUnit> path = hierarchy.path(requestOrg);
        UUID command = path.stream().filter(OrgUnit::main).map(OrgUnit::id).findFirst()
                .orElse(path.isEmpty() ? requestOrg : path.get(path.size() - 1).id());
        Set<UUID> inCommand = new java.util.HashSet<>(jdbc.sql("""
                with recursive t(id) as (select id from organization where id = :c
                  union select o.id from organization o join t on o.parent_id = t.id)
                select id from t""").param("c", command).query(UUID.class).list());
        for (ae.mover.access.RawGrant g : held) {
            List<UUID> anchors = new ArrayList<>(g.targets().stream().filter(t -> ae.mover.access.GrantTarget.ORGANIZATION.equals(t.kind())).map(ae.mover.access.GrantTarget::id).toList());
            if (anchors.isEmpty()) {
                anchors.add(g.orgId());
            }
            if (anchors.stream().anyMatch(inCommand::contains)) {
                return true;
            }
        }
        return false;
    }

    /** How far above the requesting unit the grant is named: 0 on the unit itself, the path's length for everywhere, or -1. */
    private static int reach(ae.mover.access.RawGrant g, List<UUID> path) {
        ae.mover.access.RawGrant.Spec s = g.spec();
        if (s.all()) {
            return path.size();
        }
        if (!s.orgConstraint()) {
            return -1;
        }
        List<ae.mover.access.GrantTarget> units = "CUSTOM".equals(g.scopeMode())
                ? g.targets().stream().filter(t -> ae.mover.access.GrantTarget.ORGANIZATION.equals(t.kind())).toList() : s.orgs();
        int best = -1;
        for (ae.mover.access.GrantTarget t : units) {
            int i = path.indexOf(t.id());
            if (i >= 0 && (t.limited() ? t.reached().contains(path.get(0)) : i == 0 || t.includeDescendants()) && (best < 0 || i < best)) {
                best = i;
            }
        }
        return best;
    }

    /** The people of a step's place, however it is found. */
    public Set<UUID> holdersOf(Assignee a, UUID requestOrg, List<UUID> resourceIds) {
        return "BY_SCOPE".equals(a.orgFrom()) ? scope(a.role(), requestOrg).people() : holders(a.role(), resolve(a, requestOrg, resourceIds));
    }

    /** Active people who hold the role at the place, through a membership, a delegation or a seat. At most 500. */
    public Set<UUID> holders(String role, Place place) {
        if (place.orgs().isEmpty() && !place.anyOrg()) {
            return Set.of();
        }
        return new LinkedHashSet<>(jdbc.sql("""
                select distinct c.person_id from (
                  select m.person_id, coalesce(t.target_id, m.organization_id) as organization_id from membership m
                  left join membership_scope_target t on t.membership_id = m.id and t.kind = 'ORGANIZATION'
                  where m.role_code = :r and m.valid_from <= :now and (m.valid_to is null or m.valid_to > :now)
                  union
                  select d.delegate_id, coalesce(t.target_id, m.organization_id) from delegation d join membership m on m.id = d.membership_id
                  left join membership_scope_target t on t.membership_id = m.id and t.kind = 'ORGANIZATION'
                  where m.role_code = :r and d.revoked_at is null and d.valid_from <= :now and d.valid_to > :now
                  union
                  select a.person_id, ps.organization_id from affiliation a
                  join position_seat ps on ps.organization_id = a.organization_id and ps.position_id = a.position_id and ps.active
                  where ps.role_code = :r and a.valid_to is null) c
                join person p on p.id = c.person_id and p.status = 'ACTIVE'
                where :any or c.organization_id = any(string_to_array(:orgs, ',')::uuid[])
                limit 500""")
                .param("r", role).param("now", Db.ts(clock.instant())).param("any", place.anyOrg()).param("orgs", Db.ids(place.orgs()))
                .query(UUID.class).list());
    }

    /** Which active units a selector finds nothing for, over the whole organisation: at most {@code sample} names, and how many. */
    public record Coverage(int total, int unresolved, List<String> sample) {
    }

    public Coverage coverage(Assignee a, int sample) {
        if (!Set.of("AT_LEVEL", "RESPONSIBLE", "FIXED").contains(a.orgFrom())) {
            return new Coverage(0, 0, List.of());
        }
        record U(UUID id, UUID parent, Integer level, String name) {
        }
        Map<UUID, U> units = new HashMap<>();
        jdbc.sql("""
                select o.id, o.parent_id, o.name, h.level from organization o
                left join hr_unit h on h.external_id = o.source_external_id and h.snapshot_id = (select s.id from hr_snapshot s where s.status = 'PUBLISHED')
                where o.status = 'ACTIVE'""")
                .query((rs, n) -> units.put(Db.uuid(rs, "id"), new U(Db.uuid(rs, "id"), Db.uuid(rs, "parent_id"), (Integer) rs.getObject("level"), rs.getString("name")))).list();
        Map<UUID, UUID> rules = "RESPONSIBLE".equals(a.orgFrom()) ? rules(a.responsibility()) : Map.of();
        Map<UUID, Boolean> known = new HashMap<>();
        List<String> names = new ArrayList<>();
        int missing = 0;
        for (U u : units.values()) {
            boolean found;
            if ("FIXED".equals(a.orgFrom())) {
                found = a.orgId() != null && units.containsKey(UUID.fromString(a.orgId()));
            } else {
                List<UUID> walked = new ArrayList<>();
                Boolean result = null;
                for (U at = u; at != null && walked.size() < 64; at = at.parent() == null ? null : units.get(at.parent())) {
                    if (known.containsKey(at.id())) {
                        result = known.get(at.id());
                        break;
                    }
                    walked.add(at.id());
                    if ("RESPONSIBLE".equals(a.orgFrom()) ? rules.containsKey(at.id()) : a.level() != null && a.level().equals(at.level())) {
                        result = true;
                        break;
                    }
                }
                found = Boolean.TRUE.equals(result);
                walked.forEach(id -> known.put(id, found));
            }
            if (!found) {
                missing++;
                if (names.size() < sample) {
                    names.add(u.name());
                }
            }
        }
        return new Coverage(units.size(), missing, names);
    }
}
