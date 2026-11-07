package ae.mover.stationing;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.access.GrantSource;
import ae.mover.access.GrantTarget;
import ae.mover.access.RawGrant;
import ae.mover.common.Db;

/**
 * Who is told for information once a request is finally approved (ADR-042, as in the movement programme). The parties: the
 * requesting unit and its main unit, the units located at the place and their main units, the units the requester chose, and
 * the main commands chosen explicitly. A unit may stand at this place while its main unit is elsewhere, so both are told, and
 * the notice names the unit and its main unit. Walking up from the place, the first level at which units are located answers.
 *
 * <p>A holder of {@value #ROLE} whose scope covers a party gets one row in {@code request_fyi}: who is told is who may read. It
 * gives no decision, nothing before the final approval, and only the summary, without attachments.
 */
@Component
public class PlaceInfo {

    /** Created in the published role policy, as every other role. Until someone holds it, nothing here changes anything. */
    public static final String ROLE = "FYI_RECEIVER";

    private final JdbcClient jdbc;
    private final OrgHierarchy hierarchy;
    private final Clock clock;
    private final GrantSource grants;

    public PlaceInfo(JdbcClient jdbc, OrgHierarchy hierarchy, Clock clock, GrantSource grants) {
        this.jdbc = jdbc;
        this.hierarchy = hierarchy;
        this.clock = clock;
        this.grants = grants;
    }

    /** Records who is told about a finally approved request. Returns the parties' names, for the audit. */
    public List<String> route(UUID requestId) {
        UUID owner = jdbc.sql("select owner_org_id from request where id = :id").param("id", requestId).query(UUID.class).single();
        List<UUID> sites = jdbc.sql("""
                select distinct re.site_id from request_resource rr join resource re on re.id = rr.resource_id
                where rr.request_id = :id""").param("id", requestId).query(UUID.class).list();
        Map<UUID, String> parties = parties(List.of(owner), sites);
        jdbc.sql("select organization_id from request_participant where request_id = :r and relation = 'INFO'")
                .param("r", requestId).query(UUID.class).list().forEach(o -> parties.putIfAbsent(o, "CHOSEN"));
        jdbc.sql("select organization_id from fyi_main_command").query(UUID.class).list().forEach(o -> parties.putIfAbsent(o, "MAIN_COMMAND"));
        Map<UUID, Set<UUID>> upward = new LinkedHashMap<>();
        parties.keySet().forEach(o -> upward.put(o, ancestry(o)));
        List<String> reached = new ArrayList<>();
        for (RawGrant g : grants.ofRole(ROLE, clock.instant())) {
            for (Map.Entry<UUID, String> party : parties.entrySet()) {
                if (covers(g, party.getKey(), upward.get(party.getKey()))) {
                    jdbc.sql("""
                            insert into request_fyi(request_id, person_id, organization_id, reason, told_at)
                            values (:r, :p, :o, :why, :now) on conflict do nothing""")
                            .param("r", requestId).param("p", g.personId()).param("o", g.orgId()).param("why", party.getValue())
                            .param("now", Db.ts(clock.instant())).update();
                    reached.add(party.getKey().toString());
                    break;
                }
            }
        }
        return reached.isEmpty() ? reached : names(new LinkedHashSet<>(reached.stream().map(UUID::fromString).toList()));
    }

    /** A unit activated at a place: tells the holders covering the same parties, naming the unit and its main unit. */
    public void noticeStationed(Collection<UUID> units, UUID siteId, String number) {
        String site = jdbc.sql("select name from site where id = :id").param("id", siteId).query(String.class).single();
        Map<UUID, String> parties = parties(units, List.of(siteId));
        Set<UUID> people = new LinkedHashSet<>();
        for (RawGrant g : grants.ofRole(ROLE, clock.instant())) {
            if (parties.keySet().stream().anyMatch(o -> covers(g, o, ancestry(o)))) {
                people.add(g.personId());
            }
        }
        StringBuilder body = new StringBuilder();
        for (UUID unit : units) {
            body.append(body.isEmpty() ? "" : " · ").append(unitLine(unit));
        }
        for (UUID person : people) {
            jdbc.sql("""
                    insert into notification(id, person_id, kind, title, body, created_at)
                    values (:id, :p, 'INFO_COPY', :t, :b, :now)""")
                    .param("id", UUID.randomUUID()).param("p", person).param("t", "للعلم: تمركز في «" + site + "» — " + number)
                    .param("b", body.toString()).param("now", Db.ts(clock.instant())).update();
        }
    }

    /** «الوحدة: س — وحدتها الرئيسية: ص», or the unit alone where it has none above it. */
    public String unitLine(UUID org) {
        List<OrgUnit> path = hierarchy.path(org);
        String name = !path.isEmpty() ? path.get(0).name()
                : jdbc.sql("select name from organization where id = :id").param("id", org).query(String.class).optional().orElse("");
        String main = path.stream().skip(1).filter(OrgUnit::main).findFirst().map(OrgUnit::name).orElse(null);
        return "الوحدة: " + name + (main == null ? "" : " — وحدتها الرئيسية: " + main);
    }

    /** The grant's own unit, or the units it names, alone, with what is under them, or at chosen levels. */
    private static boolean covers(RawGrant g, UUID party, Set<UUID> partyAndAbove) {
        if ("CUSTOM".equals(g.scopeMode()) && g.scopeAll()) {
            return true;
        }
        List<GrantTarget> units = g.targets().stream().filter(t -> GrantTarget.ORGANIZATION.equals(t.kind())).toList();
        if (units.isEmpty()) {
            return party.equals(g.orgId());
        }
        return units.stream().anyMatch(t -> t.limited() ? t.reached().contains(party)
                : t.includeDescendants() ? partyAndAbove.contains(t.id()) : t.id().equals(party));
    }

    private Set<UUID> ancestry(UUID org) {
        Set<UUID> out = new HashSet<>();
        out.add(org);
        hierarchy.path(org).forEach(u -> out.add(u.id()));
        return out;
    }

    /** {@code units} and their main units, the units located at {@code sites}, and the main unit of each of those. */
    private Map<UUID, String> parties(Collection<UUID> units, Collection<UUID> sites) {
        Map<UUID, String> out = new LinkedHashMap<>();
        for (UUID unit : units) {
            out.putIfAbsent(unit, "REQUESTER_UNIT");
            mainOf(unit).ifPresent(m -> out.putIfAbsent(m, "MAIN_UNIT"));
        }
        for (UUID site : sites) {
            for (UUID unit : locatedAt(site)) {
                out.putIfAbsent(unit, "AT_PLACE");
                mainOf(unit).ifPresent(m -> out.putIfAbsent(m, "MAIN_OF_PLACE"));
            }
        }
        return out;
    }

    private java.util.Optional<UUID> mainOf(UUID org) {
        return hierarchy.path(org).stream().filter(OrgUnit::main).map(OrgUnit::id).findFirst();
    }

    /** Units stationed at, linked to or responsible for the place; if none, those of the nearest place above it. */
    private List<UUID> locatedAt(UUID site) {
        List<Map<String, Object>> rows = jdbc.sql("""
                with recursive up(id, parent, depth) as (
                  select id, parent_id, 0 from site where id = :s
                  union all select x.id, x.parent_id, u.depth + 1 from site x join up u on x.id = u.parent where u.depth < 32)
                select u.depth, l.organization_id from up u join lateral (
                  select organization_id from org_stationing where site_id = u.id and valid_to is null
                  union select organization_id from site_link where site_id = u.id and valid_to is null
                  union select organization_id from site_responsibility where site_id = u.id and valid_to is null) l on true
                order by u.depth""").param("s", site).query().listOfRows();
        if (rows.isEmpty()) {
            return List.of();
        }
        Object nearest = rows.get(0).get("depth");
        return rows.stream().filter(r -> nearest.equals(r.get("depth"))).map(r -> (UUID) r.get("organization_id")).toList();
    }

    private List<String> names(Set<UUID> orgs) {
        return jdbc.sql("select name from organization where id = any(string_to_array(:ids, ',')::uuid[]) order by name")
                .param("ids", Db.ids(orgs)).query(String.class).list();
    }
}
