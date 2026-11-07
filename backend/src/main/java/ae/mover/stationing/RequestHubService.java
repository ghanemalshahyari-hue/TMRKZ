package ae.mover.stationing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.requests.AccessRequestService;

/**
 * The one entry «طلب جديد» and what surrounds it (ADR-045). As in the movement programme, the SERVER answers which actions a
 * person has, for which unit and why not: the page only renders the answer, and each action checks everything again.
 * Also the read-only operational posture, the occupants of a physical site, and the scoped counts of the home page.
 */
@Service
public class RequestHubService {

    private static final List<Permission> CREATE = List.of(Permission.CREATE_INITIAL_STATIONING, Permission.CREATE_DEPLOYMENT_REQUEST,
            Permission.CREATE_RESTATIONING, Permission.REQUEST_SITE_REGISTRATION);

    private final JdbcClient jdbc;
    private final Json json;
    private final RestationingChecks checks;
    private final RestationingService requests;
    private final StationingRegister register;
    private final AccessRequestService access;

    public RequestHubService(JdbcClient jdbc, Json json, RestationingChecks checks, RestationingService requests, StationingRegister register,
                             AccessRequestService access) {
        this.jdbc = jdbc;
        this.json = json;
        this.checks = checks;
        this.requests = requests;
        this.register = register;
        this.access = access;
    }

    // ---- eligibility -------------------------------------------------------------------------------------------

    /** NO_STATIONING, DEPLOYMENT_MISSING, DEPLOYMENT_REQUEST_PENDING or DEPLOYMENT_COMPLETE, from the register. */
    public String deploymentState(UUID unit, Instant now) {
        if (checks.effectiveStationing(unit, now) == null) {
            return "NO_STATIONING";
        }
        if (checks.activeAreas(unit, now) >= 2) {
            return "DEPLOYMENT_COMPLETE";
        }
        return requests.openRequest(RestationingChecks.DEPLOYMENT_AREAS, unit, null) != null ? "DEPLOYMENT_REQUEST_PENDING" : "DEPLOYMENT_MISSING";
    }

    private Map<String, Object> action(String action, boolean allowed, String reason, String open) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("action", action);
        m.put("allowed", allowed);
        m.put("reason", allowed ? null : reason);
        m.put("openRequest", open);
        return m;
    }

    /** What this person may ask for one unit now, each with its reason when not. A right the person lacks reads NOT_AUTHORISED. */
    private List<Map<String, Object>> unitActions(AccessContext ctx, UUID unit, String state, Instant now) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (ctx.canFor(Permission.CREATE_INITIAL_STATIONING, unit)) {
            String open = requests.openRequest(RestationingChecks.INITIAL_STATIONING, unit, null);
            boolean stationed = !"NO_STATIONING".equals(state);
            out.add(action("INITIAL_STATIONING", !stationed && open == null,
                    stationed ? "للوحدة تمركز حالي؛ يبدأ طلبها بإعادة التمركز." : "يوجد طلب تمركز أولي مفتوح لهذه الوحدة.", open));
        }
        if (ctx.canFor(Permission.CREATE_DEPLOYMENT_REQUEST, unit)) {
            String open = requests.openRequest(RestationingChecks.DEPLOYMENT_AREAS, unit, null);
            String why = switch (state) {
                case "NO_STATIONING" -> "لا تمركز حالي للوحدة؛ يبدأ بطلب تمركز أولي.";
                case "DEPLOYMENT_COMPLETE" -> "للوحدة منطقتا انتشار نافذتان.";
                default -> "يوجد طلب منطقة انتشار مفتوح لهذه الوحدة.";
            };
            out.add(action("DEPLOYMENT_AREAS", "DEPLOYMENT_MISSING".equals(state), why, open));
        }
        if (ctx.canFor(Permission.CREATE_RESTATIONING, unit)) {
            out.add(action("RESTATIONING", !"NO_STATIONING".equals(state), "لا تمركز حالي للوحدة؛ يبدأ بطلب تمركز أولي.", null));
        }
        if (ctx.canFor(Permission.REQUEST_SITE_REGISTRATION, unit)) {
            out.add(action("SITE_REGISTRATION", true, null, null));
        }
        return out;
    }

    /** «طلب جديد»: the cards this person has, and for each unit in reach where it stands and what may be asked. */
    public Map<String, Object> hub(AccessContext ctx, Instant now) {
        Set<UUID> reach = new HashSet<>();
        CREATE.forEach(p -> reach.addAll(requests.reach(ctx, p)));
        List<Map<String, Object>> units = new ArrayList<>();
        List<Map<String, Object>> all = requests.unitTree(reach);
        for (Map<String, Object> u : all.stream().limit(300).toList()) {
            UUID id = UUID.fromString(u.get("id").toString());
            String state = deploymentState(id, now);
            Map<String, Object> m = new LinkedHashMap<>(u);
            m.put("state", state);
            m.put("site", currentSite(id, now));
            m.put("actions", unitActions(ctx, id, state, now));
            units.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("units", units);
        out.put("unitsTotal", all.size());
        List<Map<String, Object>> cards = new ArrayList<>();
        Map<String, Object> mine = access.mine(ctx);
        boolean accessOpen = ((List<?>) mine.get("requests")).stream().anyMatch(r -> Set.of("SUBMITTED", "RETURNED").contains(String.valueOf(((Map<?, ?>) r).get("status"))));
        boolean accessReady = Boolean.TRUE.equals(mine.get("available"));
        cards.add(action("ACCESS_REQUEST", accessReady && !accessOpen,
                !accessReady ? "لم يُفعَّل بعد مسار طلب الصلاحيات؛ راجع مدير النظام." : "لديك طلب صلاحية مفتوح.", null));
        for (String kind : List.of("SITE_REGISTRATION", "INITIAL_STATIONING", "DEPLOYMENT_AREAS", "RESTATIONING")) {
            List<Map<String, Object>> offered = units.stream().flatMap(u -> ((List<?>) u.get("actions")).stream()).map(x -> (Map<String, Object>) cast(x))
                    .filter(x -> kind.equals(x.get("action"))).toList();
            if (offered.isEmpty()) {
                continue; // the person does not hold this right: no card at all
            }
            boolean allowed = offered.stream().anyMatch(x -> Boolean.TRUE.equals(x.get("allowed")));
            cards.add(action(kind, allowed, String.valueOf(offered.get(0).get("reason")), null));
        }
        out.put("actions", cards);
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Object o) {
        return (Map<String, Object>) o;
    }

    private void requireUnit(AccessContext ctx, UUID unit) {
        if (CREATE.stream().noneMatch(p -> ctx.canFor(p, unit)) && !ctx.canFor(Permission.VIEW, unit) && !ctx.canFor(Permission.VIEW_OPERATIONAL_POSTURE, unit)) {
            throw ApiException.notFound();
        }
    }

    /** One unit's eligibility with the register's shape of its current site: the starting point of a deployment request. */
    public Map<String, Object> unit(AccessContext ctx, UUID unit, Instant now) {
        requireUnit(ctx, unit);
        String state = deploymentState(unit, now);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", unit.toString());
        m.put("name", jdbc.sql("select name from organization where id = :id").param("id", unit).query(String.class).single());
        m.put("state", state);
        m.put("site", currentSite(unit, now));
        m.put("actions", unitActions(ctx, unit, state, now));
        return m;
    }

    private Map<String, Object> siteRef(UUID site) {
        return jdbc.sql("""
                select s.id, s.code, s.name, s.lat, s.lng, coalesce(g.geojson::text, case when s.marker is not null then ST_AsGeoJSON(s.marker) end) as geo
                  from site s left join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version where s.id = :id""")
                .param("id", site).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("code", rs.getString("code"));
                    m.put("name", rs.getString("name"));
                    m.put("lat", rs.getObject("lat"));
                    m.put("lng", rs.getObject("lng"));
                    m.put("geometry", rs.getString("geo") == null ? null : json.map(rs.getString("geo")));
                    return m;
                }).optional().orElse(null);
    }

    private Map<String, Object> currentSite(UUID unit, Instant now) {
        UUID site = checks.currentSites(List.of(unit), now).get(unit);
        return site == null ? null : siteRef(site);
    }

    /** The registered sites a unit may be stationed at: those linked to it or its parents, and those this person sees. */
    public List<Map<String, Object>> selectableSites(AccessContext ctx, UUID unit) {
        if (!ctx.canFor(Permission.CREATE_INITIAL_STATIONING, unit)) {
            throw ApiException.forbidden("هذا الطلب يحتاج صلاحيته للوحدة.");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> row : jdbc.sql("""
                with recursive up(id, parent_id) as (
                  select id, parent_id from organization where id = :u union all select o.id, o.parent_id from organization o join up on o.id = up.parent_id)
                select s.id, r.organization_id as responsible,
                       exists (select 1 from site_link l where l.site_id = s.id and l.valid_to is null and l.organization_id in (select id from up)) as linked
                  from site s left join site_responsibility r on r.site_id = s.id and r.valid_to is null
                 where s.status = 'ACTIVE' order by s.name""").param("u", unit).query().listOfRows()) {
            UUID id = (UUID) row.get("id");
            boolean linked = Boolean.TRUE.equals(row.get("linked"));
            if (linked || ctx.siteView(id, Set.of(), (UUID) row.get("responsible")) != ae.mover.access.ViewLevel.NONE) {
                Map<String, Object> m = siteRef(id);
                if (m != null) {
                    m.put("linked", linked);
                    out.add(m);
                }
            }
        }
        return out;
    }

    // ---- a physical site: one object, its occupants told apart -------------------------------------------------

    /** Stationed units and linked units of one site, apart. Units this person may not read are counted, never named. */
    public Map<String, Object> occupants(AccessContext ctx, UUID site, Instant now) {
        List<StationingRegister.StationingRecord> stationed = register.current(ctx, null, site, now);
        List<StationingRegister.SiteLinkRecord> linked = register.links(ctx, site, null, false);
        long total = jdbc.sql("""
                select count(distinct organization_id) from org_stationing where site_id = :s and valid_from <= :now and (valid_to is null or valid_to > :now)""")
                .param("s", site).param("now", Db.ts(now)).query(Long.class).single();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("stationed", stationed.stream().map(r -> {
            Map<String, Object> x = new LinkedHashMap<>();
            x.put("orgId", r.orgId().toString());
            x.put("orgName", r.orgName());
            return x;
        }).toList());
        m.put("linked", linked.stream().map(l -> {
            Map<String, Object> x = new LinkedHashMap<>();
            x.put("id", l.id().toString());
            x.put("orgId", l.orgId().toString());
            x.put("orgName", l.orgName());
            x.put("reason", l.reason());
            return x;
        }).toList());
        m.put("otherStationed", Math.max(0, total - stationed.stream().map(StationingRegister.StationingRecord::orgId).distinct().count()));
        return m;
    }

    // ---- operational posture: read only -----------------------------------------------------------------------

    /**
     * «متابعة الموقف العملياتي»: each unit the right reaches with where it is stationed, its kind and end, its own deployment
     * areas and the state of a request in progress. A unit outside the reach sharing its site is counted, never named.
     * Nothing here changes anything, and holding this right opens no action.
     */
    public Map<String, Object> posture(AccessContext ctx, Instant now) {
        if (!ctx.has(Permission.VIEW_OPERATIONAL_POSTURE)) {
            throw ApiException.forbidden("يحتاج صلاحية «متابعة الموقف العملياتي».");
        }
        Set<UUID> reach = requests.reach(ctx, Permission.VIEW_OPERATIONAL_POSTURE);
        List<Map<String, Object>> tree = requests.unitTree(reach);
        List<Map<String, Object>> units = new ArrayList<>();
        for (Map<String, Object> u : tree.stream().limit(500).toList()) {
            UUID id = UUID.fromString(u.get("id").toString());
            Map<String, Object> m = new LinkedHashMap<>(u);
            UUID record = checks.effectiveStationing(id, now);
            m.put("state", deploymentState(id, now));
            if (record != null) {
                Map<String, Object> st = jdbc.sql("select site_id, kind, planned_end from org_stationing where id = :id").param("id", record).query().singleRow();
                UUID site = (UUID) st.get("site_id");
                m.put("site", siteRef(site));
                m.put("kind", st.get("kind"));
                m.put("plannedEnd", st.get("planned_end") == null ? null : Db.toInstant(st.get("planned_end")).toString());
                Map<String, Object> areas = new LinkedHashMap<>();
                jdbc.sql("select role, ST_AsGeoJSON(geom) as g from deployment_area where stationing_id = :s and state = 'ACTIVE'").param("s", record)
                        .query((rs, n) -> areas.put(rs.getString("role"), json.map(rs.getString("g")))).list();
                m.put("primary", areas.get("PRIMARY"));
                m.put("alternative", areas.get("ALTERNATIVE"));
                long others = jdbc.sql("""
                        select count(distinct organization_id) from org_stationing where site_id = :s and valid_from <= :now and (valid_to is null or valid_to > :now)
                           and not organization_id = any(string_to_array(:mine, ',')::uuid[])""")
                        .param("s", site).param("now", Db.ts(now)).param("mine", Db.ids(List.copyOf(reach))).query(Long.class).single();
                m.put("otherUnitsAtSite", others);
            }
            m.put("request", jdbc.sql("""
                    select purpose, state from restationing_request where jsonb_exists(content->'scope', :u)
                       and state in ('UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED', 'APPROVED_NOT_ACTIVATED', 'CANCELLATION_PENDING')
                     order by updated_at desc limit 1""").param("u", id.toString()).query((rs, n) -> {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("purpose", rs.getString("purpose"));
                r.put("state", rs.getString("state"));
                return r;
            }).optional().orElse(null));
            units.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("units", units);
        out.put("unitsTotal", tree.size());
        return out;
    }

    // ---- one list, and the counts of the home page --------------------------------------------------------------

    /** Every request this person may see, each with its type: stationing requests and permission requests, told apart. */
    public List<Map<String, Object>> overview(AccessContext ctx, String filter) {
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> r : requests.list(ctx, null)) {
            Map<String, Object> m = new LinkedHashMap<>(r);
            m.put("type", r.get("purpose"));
            items.add(m);
        }
        Map<String, Object> mine = access.mine(ctx);
        for (Object o : (List<?>) mine.get("requests")) {
            Map<String, Object> r = cast(o);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.get("id"));
            m.put("number", r.get("number"));
            m.put("type", "ACCESS");
            m.put("state", r.get("status"));
            m.put("stateLabel", r.get("statusLabel"));
            m.put("updatedAt", r.get("submittedAt"));
            m.put("requestingUnit", Map.of("name", String.valueOf(r.get("unit"))));
            m.put("mine", true);
            m.put("myTurn", false);
            items.add(m);
        }
        for (Map<String, Object> t : ctx.has(Permission.REVIEW) ? access.inbox(ctx) : List.<Map<String, Object>>of()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", t.get("requestId"));
            m.put("number", t.get("number"));
            m.put("type", "ACCESS");
            m.put("state", "SUBMITTED");
            m.put("stateLabel", Boolean.TRUE.equals(t.get("final")) ? "بانتظار الاعتماد النهائي" : "بانتظار التوصية");
            m.put("updatedAt", t.get("submittedAt"));
            m.put("requestingUnit", Map.of("name", String.valueOf(t.get("unit"))));
            m.put("person", t.get("person"));
            m.put("mine", false);
            m.put("myTurn", true);
            m.put("accessFinal", t.get("final"));
            items.add(m);
        }
        String f = filter == null || filter.isBlank() ? "ALL" : filter;
        return items.stream().filter(m -> switch (f) {
            case "ACCESS" -> "ACCESS".equals(m.get("type"));
            case "SITE" -> RestationingChecks.SITE_REGISTRATION.equals(m.get("type"));
            case "INITIAL" -> RestationingChecks.INITIAL_STATIONING.equals(m.get("type"));
            case "DEPLOYMENT" -> RestationingChecks.DEPLOYMENT_AREAS.equals(m.get("type"));
            case "RESTATIONING" -> RestationingChecks.RESTATIONING.equals(m.get("type"));
            case "MY_TURN" -> Boolean.TRUE.equals(m.get("myTurn")) || Boolean.TRUE.equals(m.get("fyiPending")) || Boolean.TRUE.equals(m.get("activatable"));
            case "UNIT_OPERATIONS" -> "UNIT_OPERATIONS".equals(m.get("currentStageKind")) && "UNDER_REVIEW".equals(m.get("state"));
            case "FINAL" -> "FINAL".equals(m.get("currentStageKind")) && "UNDER_REVIEW".equals(m.get("state"));
            case "FYI" -> Boolean.TRUE.equals(m.get("fyi"));
            default -> true;
        }).toList();
    }

    /** The cards of the home page: counted only over what this person's rights reach, and absent for what they cannot act on. */
    public List<Map<String, Object>> homeCards(AccessContext ctx, Instant now) {
        List<Map<String, Object>> items = overview(ctx, "ALL");
        List<Map<String, Object>> out = new ArrayList<>();
        if (ctx.has(Permission.REVIEW)) {
            card(out, "ACCESS_REVIEW", "بانتظار توصية صلاحية", items.stream().filter(i -> "ACCESS".equals(i.get("type")) && Boolean.TRUE.equals(i.get("myTurn")) && !Boolean.TRUE.equals(i.get("accessFinal"))).count(), "#accessInbox");
            card(out, "ACCESS_FINAL", "بانتظار اعتمادي للصلاحيات", items.stream().filter(i -> Boolean.TRUE.equals(i.get("accessFinal"))).count(), "#accessInbox");
        }
        long turn = items.stream().filter(i -> !"ACCESS".equals(i.get("type")) && Boolean.TRUE.equals(i.get("myTurn"))).count();
        if (turn > 0 || ctx.has(Permission.APPROVE)) {
            card(out, "MY_TURN", "بانتظار اعتمادي", turn, "#allRequests");
        }
        if (ctx.has(Permission.DECIDE_UNIT_OPERATIONS)) {
            card(out, "UNIT_OPERATIONS", "بانتظار اعتماد عمليات الوحدة", items.stream().filter(i -> "UNIT_OPERATIONS".equals(i.get("currentStageKind")) && Boolean.TRUE.equals(i.get("myTurn"))).count(), "#allRequests");
        }
        if (ctx.has(Permission.FINAL_APPROVE_STATIONING)) {
            card(out, "FINAL", "بانتظار الاعتماد النهائي", items.stream().filter(i -> "FINAL".equals(i.get("currentStageKind")) && Boolean.TRUE.equals(i.get("myTurn"))).count(), "#allRequests");
        }
        long fyi = items.stream().filter(i -> Boolean.TRUE.equals(i.get("fyi"))).count();
        if (fyi > 0) {
            card(out, "FYI", "طلبات للعلم", fyi, "#allRequests");
        }
        Set<UUID> reach = new HashSet<>(requests.reach(ctx, Permission.VIEW_OPERATIONAL_POSTURE));
        reach.addAll(requests.reach(ctx, Permission.CREATE_INITIAL_STATIONING));
        reach.addAll(requests.reach(ctx, Permission.CREATE_DEPLOYMENT_REQUEST));
        if (!reach.isEmpty()) {
            Map<String, Object> c = jdbc.sql("""
                    with u as (select unnest(string_to_array(:ids, ',')::uuid[]) as id),
                    eff as (
                      select distinct on (s.organization_id) s.organization_id, s.id from org_stationing s
                       where s.organization_id in (select id from u) and s.valid_from <= :now and (s.valid_to is null or s.valid_to > :now) and s.start_held_at is null
                       order by s.organization_id, case s.kind when 'TEMPORARY' then 0 else 1 end)
                    select (select count(*) from u where id not in (select organization_id from eff)) as none,
                           (select count(*) from eff where (select count(*) from deployment_area a where a.stationing_id = eff.id and a.state = 'ACTIVE') < 2) as noareas""")
                    .param("ids", Db.ids(List.copyOf(reach))).param("now", Db.ts(now)).query().singleRow();
            card(out, "NO_STATIONING", "وحدات بلا تمركز معتمد", ((Number) c.get("none")).longValue(), "#newRequest");
            card(out, "NO_DEPLOYMENT", "وحدات بلا مناطق انتشار", ((Number) c.get("noareas")).longValue(), "#newRequest");
        }
        long moving = items.stream().filter(i -> RestationingChecks.RESTATIONING.equals(i.get("type")) && Set.of("UNDER_REVIEW", "APPROVED_NOT_ACTIVATED").contains(String.valueOf(i.get("state")))).count();
        if (moving > 0 || ctx.has(Permission.CREATE_RESTATIONING)) {
            card(out, "RESTATIONING", "طلبات إعادة تمركز جارية", moving, "#allRequests");
        }
        return out;
    }

    private static void card(List<Map<String, Object>> out, String key, String label, long value, String href) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", key);
        m.put("label", label);
        m.put("value", value);
        m.put("href", href);
        out.add(m);
    }
}
