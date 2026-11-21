package ae.mover.stationing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.access.AccessContext;
import ae.mover.common.Db;
import ae.mover.common.Json;

/**
 * Bulk read-model behind «متابعة الموقف العملياتي» and the «طلب جديد» page (ADR-094 performance hardening). Previously
 * {@link RequestHubService#posture} and {@link RequestHubService#hub} looped over up to 500 / 300 units and issued
 * ~8 SQL statements per unit (effective stationing, deployment state, site reference, deployment-area geometry,
 * occupancy count, open-request jsonb_exists). This component replaces that loop with a small, fixed set of bulk
 * queries over the whole authorised unit set — the number of SQL statements stays roughly constant whether the page
 * answers for 100 units or for 10,000. Response shapes are preserved; only the SQL profile changes.
 */
@Component
public class OperationalPostureReadModel {

    /**
     * Pending states shown in the posture pending-proposals block (ADR-091): every state in which a request is
     * «قيد الاعتماد» or «معلّق للتعديل» or «معتمد بانتظار التفعيل» in the operator's view. The per-unit `request`
     * shown beside a stationed unit uses the same states minus {@code START_HELD_PENDING_CANCELLATION}, which is
     * not an in-progress change of the unit's own posture.
     */
    static final List<String> PENDING_STATES = List.of(
            "UNDER_REVIEW", "RETURNED_FOR_CHANGES", "PAUSED_HIERARCHY_CHANGED",
            "APPROVED_NOT_ACTIVATED", "CANCELLATION_PENDING", "START_HELD_PENDING_CANCELLATION");

    static final List<String> UNIT_OPEN_STATES = List.of(
            "UNDER_REVIEW", "RETURNED_FOR_CHANGES", "PAUSED_HIERARCHY_CHANGED",
            "APPROVED_NOT_ACTIVATED", "CANCELLATION_PENDING");

    /**
     * «طلب جديد» cares about DRAFT too: an in-progress draft blocks the right to start another request for the
     * same unit, so {@link RequestHubService#hub} includes DRAFT in the open-request slot even though the posture
     * view does not.
     */
    static final List<String> HUB_OPEN_STATES = List.of(
            "DRAFT", "UNDER_REVIEW", "RETURNED_FOR_CHANGES", "PAUSED_HIERARCHY_CHANGED",
            "APPROVED_NOT_ACTIVATED", "CANCELLATION_PENDING");

    /** One row of the bulk unit-state query, enough to answer posture, hub and home-card counts for a single unit. */
    record UnitRow(UUID unitId, UUID stationingId, UUID siteId, String kind, Instant plannedEnd,
                   long activeAreas, long siteTotal) {
        /** The same label {@link RequestHubService#deploymentState} computes from the per-unit read. */
        String deploymentState(boolean openDeploymentRequest) {
            if (stationingId == null) {
                return "NO_STATIONING";
            }
            if (activeAreas >= 2) {
                return "DEPLOYMENT_COMPLETE";
            }
            return openDeploymentRequest ? "DEPLOYMENT_REQUEST_PENDING" : "DEPLOYMENT_MISSING";
        }
    }

    record SiteRef(UUID id, String code, String name, Object lat, Object lng, Map<String, Object> geometry) {
        Map<String, Object> asMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id.toString());
            m.put("code", code);
            m.put("name", name);
            m.put("lat", lat);
            m.put("lng", lng);
            m.put("geometry", geometry);
            return m;
        }
    }

    /** Open-request slot for a given unit: the most recently-updated open request whose scope covers it. */
    record UnitOpenRequest(String number, String purpose, String state, Instant updatedAt) {
    }

    private final JdbcClient jdbc;
    private final Json json;

    /**
     * Posture-invocation counter (ADR-094 Gate 2 §A). Incremented on the first bulk read inside {@link #posture},
     * so tests can assert that a 304 Not Modified response never touched the read model. Public because
     * {@code OperationalPostureScaleIT} lives in another package; production code never reads it.
     */
    public final java.util.concurrent.atomic.AtomicLong postureInvocations = new java.util.concurrent.atomic.AtomicLong();

    OperationalPostureReadModel(JdbcClient jdbc, Json json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    // ---- bulk primitives -------------------------------------------------------------------------------

    /**
     * Effective stationing + active-area count + site occupancy for every unit in {@code units}, in ONE round trip.
     * A unit with no stationing still appears in the result with a null {@code stationingId}, so the caller can
     * compose the per-unit response without a second lookup.
     */
    Map<UUID, UnitRow> unitState(Set<UUID> units, Instant now) {
        Map<UUID, UnitRow> out = new HashMap<>(units.size() * 2);
        if (units.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                with units as (select unnest(string_to_array(:ids, ',')::uuid[]) as id),
                eff as (
                  select distinct on (s.organization_id)
                         s.organization_id, s.id as stationing_id, s.site_id, s.kind, s.planned_end
                    from org_stationing s
                   where s.organization_id in (select id from units)
                     and s.valid_from <= :now and (s.valid_to is null or s.valid_to > :now)
                     and s.start_held_at is null
                   order by s.organization_id, case s.kind when 'TEMPORARY' then 0 else 1 end),
                areas as (
                  select stationing_id, count(*) as cnt
                    from deployment_area
                   where stationing_id in (select stationing_id from eff) and state = 'ACTIVE'
                   group by stationing_id),
                site_total as (
                  select site_id, count(distinct organization_id) as cnt
                    from org_stationing
                   where site_id in (select site_id from eff where site_id is not null)
                     and valid_from <= :now and (valid_to is null or valid_to > :now)
                   group by site_id)
                select u.id as unit_id, e.stationing_id, e.site_id, e.kind, e.planned_end,
                       coalesce(a.cnt, 0) as active_areas, coalesce(st.cnt, 0) as site_total
                  from units u
                  left join eff e on e.organization_id = u.id
                  left join areas a on a.stationing_id = e.stationing_id
                  left join site_total st on st.site_id = e.site_id""")
                .param("ids", Db.ids(List.copyOf(units))).param("now", Db.ts(now))
                .query((rs, n) -> {
                    UUID id = Db.uuid(rs, "unit_id");
                    out.put(id, new UnitRow(id, Db.uuid(rs, "stationing_id"), Db.uuid(rs, "site_id"),
                            rs.getString("kind"), Db.instant(rs, "planned_end"), rs.getLong("active_areas"),
                            rs.getLong("site_total")));
                    return null;
                }).list();
        return out;
    }

    /** One bulk read for the site reference every stationed unit in the posture result needs. */
    Map<UUID, SiteRef> siteRefs(Collection<UUID> sites) {
        Map<UUID, SiteRef> out = new HashMap<>(sites.size() * 2);
        if (sites.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select s.id, s.code, s.name, s.lat, s.lng,
                       coalesce(g.geojson::text,
                                case when s.marker is not null then ST_AsGeoJSON(s.marker) end) as geo
                  from site s
                  left join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version
                 where s.id = any(string_to_array(:ids, ',')::uuid[])""")
                .param("ids", Db.ids(List.copyOf(sites)))
                .query((rs, n) -> {
                    UUID id = Db.uuid(rs, "id");
                    out.put(id, new SiteRef(id, rs.getString("code"), rs.getString("name"),
                            rs.getObject("lat"), rs.getObject("lng"),
                            rs.getString("geo") == null ? null : json.map(rs.getString("geo"))));
                    return null;
                }).list();
        return out;
    }

    /** PRIMARY/ALTERNATIVE deployment-area geometry for every stationing in one scan. Empty entries omitted. */
    Map<UUID, Map<String, Object>> deploymentAreas(Collection<UUID> stationingIds) {
        Map<UUID, Map<String, Object>> out = new HashMap<>();
        if (stationingIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select stationing_id, role, ST_AsGeoJSON(geom) as g
                  from deployment_area
                 where stationing_id = any(string_to_array(:ids, ',')::uuid[]) and state = 'ACTIVE'""")
                .param("ids", Db.ids(List.copyOf(stationingIds)))
                .query((rs, n) -> {
                    UUID id = Db.uuid(rs, "stationing_id");
                    out.computeIfAbsent(id, k -> new LinkedHashMap<>())
                            .put(rs.getString("role"), json.map(rs.getString("g")));
                    return null;
                }).list();
        return out;
    }

    /**
     * For every unit in {@code units}, the most recently-updated open request whose scope covers that unit, in one
     * scan — replaces the per-unit {@code jsonb_exists} loop (~600 scans) with a single {@code content->'scope' ?|}
     * scan. States is the open-states set the per-unit `request` slot cares about. The scan is sequential against
     * {@code restationing_request} (no GIN on {@code content}); once EXPLAIN shows the cost warrants it the
     * supporting GIN index can be added without changing callers.
     */
    Map<UUID, UnitOpenRequest> openRequestByUnit(Set<UUID> units, List<String> states, List<String> purposes) {
        Map<UUID, UnitOpenRequest> out = new HashMap<>();
        if (units.isEmpty()) {
            return out;
        }
        List<String> unitStrs = new ArrayList<>(units.size());
        for (UUID u : units) {
            unitStrs.add(u.toString());
        }
        jdbc.sql("""
                select id, purpose, state, number, updated_at, content->'scope' as scope
                  from restationing_request
                 where state = any(string_to_array(:states, ',')::text[])
                   and purpose = any(string_to_array(:purposes, ',')::text[])
                   and jsonb_exists_any(content->'scope', :units)
                 order by updated_at desc""")
                .param("states", String.join(",", states))
                .param("purposes", String.join(",", purposes))
                .param("units", unitStrs.toArray(new String[0]))
                .query((rs, n) -> {
                    String scopeJson = rs.getString("scope");
                    if (scopeJson == null) {
                        return null;
                    }
                    List<Object> scope = json.list(json.tree(scopeJson));
                    UnitOpenRequest row = new UnitOpenRequest(rs.getString("number"), rs.getString("purpose"),
                            rs.getString("state"), Db.instant(rs, "updated_at"));
                    for (Object o : scope) {
                        UUID unit = UUID.fromString(o.toString());
                        if (units.contains(unit)) {
                            // first write wins — rows arrive in updated_at descending order
                            out.putIfAbsent(unit, row);
                        }
                    }
                    return null;
                }).list();
        return out;
    }

    /**
     * Ids of open requests whose scope touches any unit in {@code reach}: one scan; callers then load/visibility-check
     * only those candidates, never every pending row. Returned in {@code updated_at desc} order.
     */
    List<UUID> openRequestIdsForReach(Set<UUID> reach, List<String> states, List<String> purposes) {
        if (reach.isEmpty()) {
            return List.of();
        }
        List<String> unitStrs = new ArrayList<>(reach.size());
        for (UUID u : reach) {
            unitStrs.add(u.toString());
        }
        return jdbc.sql("""
                select id from restationing_request
                 where state = any(string_to_array(:states, ',')::text[])
                   and purpose = any(string_to_array(:purposes, ',')::text[])
                   and jsonb_exists_any(content->'scope', :units)
                 order by updated_at desc""")
                .param("states", String.join(",", states))
                .param("purposes", String.join(",", purposes))
                .param("units", unitStrs.toArray(new String[0]))
                .query(UUID.class).list();
    }

    /** Current-stage label («تحت دراسة …») for every request id in one scan, never per request. */
    Map<UUID, String> currentStageLabel(Collection<UUID> requestIds) {
        Map<UUID, String> out = new HashMap<>();
        if (requestIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select distinct on (s.request_id, s.route_no) s.request_id, s.label
                  from restationing_stage s
                  join restationing_request r on r.id = s.request_id and r.route_no = s.route_no
                 where s.request_id = any(string_to_array(:ids, ',')::uuid[]) and s.mark is null
                 order by s.request_id, s.route_no, s.position""")
                .param("ids", Db.ids(List.copyOf(requestIds)))
                .query((rs, n) -> out.put(Db.uuid(rs, "request_id"), rs.getString("label")))
                .list();
        return out;
    }

    /** Code and name for every unit id in one scan. */
    Map<UUID, Map<String, String>> unitLabels(Collection<UUID> unitIds) {
        Map<UUID, Map<String, String>> out = new HashMap<>();
        if (unitIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select id, code, name from organization
                 where id = any(string_to_array(:ids, ',')::uuid[])""")
                .param("ids", Db.ids(List.copyOf(unitIds)))
                .query((rs, n) -> {
                    Map<String, String> m = new LinkedHashMap<>();
                    m.put("code", rs.getString("code"));
                    m.put("name", rs.getString("name"));
                    out.put(Db.uuid(rs, "id"), m);
                    return null;
                }).list();
        return out;
    }

    /**
     * A per-user revision token for conditional-GET 304s on the posture (brief §24, Gate 2.5 §A-§C). The token has
     * two axes, both single-row and index-backed:
     *
     * <ul>
     *   <li>Access axis — the greatest {@code seq} from {@code authz_change} filtered to the global stream
     *       ({@code person_id IS NULL}) and this person's own stream. Bumps the moment a grant, membership,
     *       delegation, affiliation or any permission-studio write touches either stream; backed by
     *       {@code authz_change_person_idx (person_id, seq)}.</li>
     *   <li>Posture axis — the greatest {@code seq} from {@code posture_change} (V60). Bumps on any write to
     *       {@code org_stationing}, {@code deployment_area}, {@code restationing_request}, {@code site},
     *       {@code site_geometry_version}, {@code organization} or {@code site_responsibility}. Covers EVERY
     *       input to the Site-Hub response — the Gate 2 query over {@code max(updated_at)} of three tables did
     *       not move on a site rename, a marker move, a new geometry version or a unit rename, which this stream
     *       catches.</li>
     * </ul>
     *
     * <p>Combining both axes is non-negotiable: a user whose reach shrinks (a grant revoked between requests)
     * would otherwise keep seeing a 304-served stale posture until the GLOBAL posture happened to bump. The
     * access axis moves the ETag immediately so {@link RequestHubController} misses the browser cache on the
     * very next request — the system's next-request revocation semantic (brief §O / previous brief §T).
     *
     * <p>A single query returns both axes together — two primary-key max() lookups and nothing else, so the
     * controller's 304 path remains a cheap round trip independent of data volume.
     */
    String dataRevisionFor(java.util.UUID personId) {
        Map<String, Object> row = jdbc.sql("""
                select
                  coalesce((select max(seq) from authz_change where person_id is null or person_id = :p), 0) as access_seq,
                  coalesce((select max(seq) from posture_change), 0) as posture_seq
                """)
                .param("p", personId).query().singleRow();
        Object access = row.get("access_seq");
        Object posture = row.get("posture_seq");
        return (access == null ? "0" : access.toString()) + "|" + (posture == null ? "0" : posture.toString());
    }

    /**
     * How many units in {@code units} are at each distinct site, so «غيرها على الموقع» can be computed as
     * {@code siteTotal - unitsOfMineAtSite}. Derived from the same {@link #unitState} result in Java: no extra query.
     */
    static Map<UUID, Long> countInReachAtSite(Map<UUID, UnitRow> state) {
        Map<UUID, Long> out = new HashMap<>();
        for (UnitRow r : state.values()) {
            if (r.siteId() != null) {
                out.merge(r.siteId(), 1L, Long::sum);
            }
        }
        return out;
    }

    // ---- site-hub summary (ADR-094 Gate 2 §C) --------------------------------------------------

    /**
     * «متابعة الموقف العملياتي» overview as the Site-Hub UI wants it: compact aggregates per site, a one-line
     * summary of the whole reach, a small no-stationing summary, and totals. No per-unit records, no PRIMARY/SUB
     * geometry, no proposal geometry — those come from the lazy detail endpoints when the operator drills in.
     * A single bulk pass over the authorised unit set gives the counts; one scan over pending requests gives the
     * site-keyed pending indicator. The result size scales with the number of distinct sites in reach, not with
     * the number of units.
     *
     * <p>Shape:
     * <pre>
     * {
     *   "dataRevision": "...",
     *   "unitsTotal": 30000,
     *   "sitesTotal": 10000,
     *   "summary": {complete, incomplete, noStationing, temporary, expiring, pending},
     *   "siteHubs": [ {siteId, siteCode, siteName, anchor:{lat,lng}, unitsTotal, completeCount, incompleteCount,
     *                   temporaryCount, expiringCount, pendingCount} ],
     *   "noStationingSummary": { "count": N }
     * }
     * </pre>
     */
    Map<String, Object> overview(AccessContext ctx, Instant now, Set<UUID> reach) {
        postureInvocations.incrementAndGet();
        Map<UUID, UnitRow> state = unitState(reach, now);
        // Pending indicator by unit (scope-intersection scan), then rolled up by site in Java.
        Map<UUID, UnitOpenRequest> pendingByUnit = openRequestByUnit(reach, PENDING_STATES,
                List.of("RESTATIONING", "DEPLOYMENT_AREAS"));

        // Per-site aggregates (in Java off the single bulk state map — no extra round trip).
        Map<UUID, long[]> perSite = new LinkedHashMap<>();
        // slot 0 unitsTotal, 1 complete, 2 incomplete, 3 temporary, 4 expiring, 5 pending
        Instant expiringSoon = now.plusSeconds(60L * 60L * 24L * 14L); // two weeks
        long complete = 0, incomplete = 0, noStationing = 0, temporary = 0, expiring = 0, pendingTotal = 0;
        for (Map.Entry<UUID, UnitRow> e : state.entrySet()) {
            UnitRow r = e.getValue();
            if (r.siteId() == null) {
                noStationing++;
                if (pendingByUnit.containsKey(e.getKey())) pendingTotal++;
                continue;
            }
            long[] s = perSite.computeIfAbsent(r.siteId(), k -> new long[6]);
            s[0]++;
            boolean isComplete = r.activeAreas() >= 2;
            if (isComplete) {
                complete++; s[1]++;
            } else {
                incomplete++; s[2]++;
            }
            if ("TEMPORARY".equals(r.kind())) {
                temporary++; s[3]++;
            }
            if (r.plannedEnd() != null && r.plannedEnd().isBefore(expiringSoon)) {
                expiring++; s[4]++;
            }
            if (pendingByUnit.containsKey(e.getKey())) {
                pendingTotal++; s[5]++;
            }
        }

        Map<UUID, SiteRef> sites = siteRefs(perSite.keySet());

        List<Map<String, Object>> siteHubs = new ArrayList<>(perSite.size());
        for (Map.Entry<UUID, long[]> e : perSite.entrySet()) {
            SiteRef site = sites.get(e.getKey());
            if (site == null) {
                continue;
            }
            Map<String, Object> hub = new LinkedHashMap<>();
            hub.put("siteId", site.id().toString());
            hub.put("siteCode", site.code());
            hub.put("siteName", site.name());
            Map<String, Object> anchor = new LinkedHashMap<>();
            anchor.put("lat", site.lat());
            anchor.put("lng", site.lng());
            hub.put("anchor", anchor);
            long[] s = e.getValue();
            hub.put("unitsTotal", s[0]);
            hub.put("completeCount", s[1]);
            hub.put("incompleteCount", s[2]);
            hub.put("temporaryCount", s[3]);
            hub.put("expiringCount", s[4]);
            hub.put("pendingCount", s[5]);
            siteHubs.add(hub);
        }

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("complete", complete);
        summary.put("incomplete", incomplete);
        summary.put("noStationing", noStationing);
        summary.put("temporary", temporary);
        summary.put("expiring", expiring);
        summary.put("pending", pendingTotal);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("dataRevision", dataRevisionFor(ctx.personId()));
        out.put("unitsTotal", (long) reach.size());
        out.put("sitesTotal", (long) siteHubs.size());
        out.put("summary", summary);
        out.put("siteHubs", siteHubs);
        Map<String, Object> noSt = new LinkedHashMap<>();
        noSt.put("count", noStationing);
        out.put("noStationingSummary", noSt);
        return out;
    }

    // ---- lazy detail endpoints (ADR-094 Gate 2 §D-§F) ------------------------------------------

    /**
     * Site detail (§D): one site's identity + geometry + the authorised units that stand there, each with its
     * compact posture status, plus a compact summary of visible pending requests at that site. The pending-request
     * list is bounded by the number of open requests referencing a reach unit at THIS site — not by the whole
     * pending population.
     */
    Map<String, Object> siteDetail(AccessContext ctx, UUID siteId, Instant now, Set<UUID> reach,
                                   RestationingService requests) {
        SiteRef site = siteRefs(List.of(siteId)).get(siteId);
        if (site == null) {
            return null;
        }
        // Units at this site inside the viewer's reach.
        Map<UUID, UnitRow> allState = unitState(reach, now);
        List<UUID> atSite = new ArrayList<>();
        for (Map.Entry<UUID, UnitRow> e : allState.entrySet()) {
            if (siteId.equals(e.getValue().siteId())) {
                atSite.add(e.getKey());
            }
        }
        // Site identity and geometry are visible only when at least one of this viewer's reach units stands at the
        // site (POSTURE-SCOPE-06). Without that, the lazy site endpoint fails closed so a forged site id leaks
        // nothing — the controller turns null into 404.
        if (atSite.isEmpty()) {
            return null;
        }
        Map<UUID, Map<String, String>> labels = unitLabels(atSite);
        Map<UUID, UnitOpenRequest> openByUnit = openRequestByUnit(new HashSet<>(atSite), UNIT_OPEN_STATES,
                List.of("RESTATIONING", "DEPLOYMENT_AREAS", "SITE_REGISTRATION"));
        Map<UUID, UnitOpenRequest> openDeploy = openRequestByUnit(new HashSet<>(atSite), UNIT_OPEN_STATES,
                List.of("DEPLOYMENT_AREAS"));

        List<Map<String, Object>> units = new ArrayList<>(atSite.size());
        for (UUID uid : atSite) {
            UnitRow row = allState.get(uid);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", uid.toString());
            Map<String, String> label = labels.get(uid);
            m.put("code", label == null ? null : label.get("code"));
            m.put("name", label == null ? null : label.get("name"));
            m.put("state", row.deploymentState(openDeploy.containsKey(uid)));
            m.put("kind", row.kind());
            m.put("plannedEnd", row.plannedEnd() == null ? null : row.plannedEnd().toString());
            UnitOpenRequest or = openByUnit.get(uid);
            if (or != null) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("purpose", or.purpose());
                r.put("state", or.state());
                r.put("number", or.number());
                m.put("request", r);
            } else {
                m.put("request", null);
            }
            units.add(m);
        }

        // Pending-request summaries visible to this viewer at THIS site: candidates come from scope-intersection
        // with the units at the site, then visible() per candidate (small list, bounded).
        Set<UUID> atSiteSet = new HashSet<>(atSite);
        List<UUID> candidateIds = openRequestIdsForReach(atSiteSet, PENDING_STATES,
                List.of("RESTATIONING", "DEPLOYMENT_AREAS"));
        Map<UUID, String> stageLabels = currentStageLabel(candidateIds);
        List<Map<String, Object>> pending = new ArrayList<>();
        for (UUID rid : candidateIds) {
            requests.load(rid).ifPresent(r -> {
                if (!requests.visible(ctx, r)) {
                    return;
                }
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("requestId", r.id().toString());
                row.put("requestNumber", r.number());
                row.put("purpose", r.purpose());
                row.put("state", r.state());
                row.put("currentStage", stageLabels.get(r.id()));
                row.put("scopeUnitCount", r.content().scope().size());
                pending.add(row);
            });
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("site", site.asMap());
        out.put("units", units);
        out.put("pending", pending);
        return out;
    }

    /**
     * Unit detail (§E): one unit's full posture with geometry — the shape {@link #posture} used to carry per unit
     * in the overview, now served on demand when the operator selects a unit. Preserves exact field names so a
     * frontend that drills in has no surprise.
     */
    Map<String, Object> unitDetail(AccessContext ctx, UUID unitId, Instant now) {
        UnitRow row = unitState(Set.of(unitId), now).get(unitId);
        Map<UUID, Map<String, String>> labels = unitLabels(List.of(unitId));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", unitId.toString());
        Map<String, String> label = labels.get(unitId);
        m.put("code", label == null ? null : label.get("code"));
        m.put("name", label == null ? null : label.get("name"));
        if (row == null || row.stationingId() == null) {
            m.put("state", "NO_STATIONING");
            return m;
        }
        Map<UUID, UnitOpenRequest> openDeploy = openRequestByUnit(Set.of(unitId), UNIT_OPEN_STATES,
                List.of("DEPLOYMENT_AREAS"));
        m.put("state", row.deploymentState(openDeploy.containsKey(unitId)));
        m.put("kind", row.kind());
        m.put("plannedEnd", row.plannedEnd() == null ? null : row.plannedEnd().toString());
        SiteRef site = row.siteId() == null ? null : siteRefs(List.of(row.siteId())).get(row.siteId());
        m.put("site", site == null ? null : site.asMap());
        Map<String, Object> areas = deploymentAreas(List.of(row.stationingId())).getOrDefault(row.stationingId(), Map.of());
        m.put("primary", areas.get("PRIMARY"));
        m.put("alternative", areas.get("ALTERNATIVE"));
        Map<UUID, UnitOpenRequest> openAny = openRequestByUnit(Set.of(unitId), UNIT_OPEN_STATES,
                List.of("RESTATIONING", "DEPLOYMENT_AREAS", "SITE_REGISTRATION"));
        UnitOpenRequest or = openAny.get(unitId);
        if (or != null) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("purpose", or.purpose());
            r.put("state", or.state());
            r.put("number", or.number());
            m.put("request", r);
        } else {
            m.put("request", null);
        }
        return m;
    }

    /**
     * Request geometry detail (§F): one pending request's proposal geometry, loaded only when the operator
     * expands/selects that request. The overview never carries this — the brief wants it off the hot path.
     */
    Map<String, Object> requestGeometry(AccessContext ctx, UUID requestId, RestationingService requests) {
        return requests.load(requestId).map(r -> {
            if (!requests.visible(ctx, r)) {
                return null;
            }
            RestationingContent c = r.content();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("requestId", r.id().toString());
            out.put("requestNumber", r.number());
            out.put("purpose", r.purpose());
            out.put("state", r.state());
            out.put("scope", c.scope().stream().map(UUID::toString).toList());
            out.put("proposedSite", c.site() == null ? null : c.site().geometry());
            out.put("proposedPrimary", c.primary());
            out.put("proposedSub", c.alternative());
            return out;
        }).orElse(null);
    }

    // ---- composed answers -----------------------------------------------------------------------------

    /**
     * «متابعة الموقف العملياتي» response (preserved shape): {@code units}, {@code unitsTotal}, {@code pending},
     * {@code dataRevision}. The 500-unit cap is gone and SQL count no longer scales with unit count. The pending
     * block honours {@code visible(ctx, r)} but only for requests whose scope actually intersects {@code reach},
     * which eliminates the whole-table load.
     */
    Map<String, Object> posture(AccessContext ctx, Instant now, Set<UUID> reach, List<Map<String, Object>> tree,
                                RestationingService requests) {
        postureInvocations.incrementAndGet();
        // Everything each unit needs — one bulk pass.
        Set<UUID> ids = new HashSet<>(reach);
        Map<UUID, UnitRow> state = unitState(ids, now);
        Set<UUID> siteIds = new LinkedHashSet<>();
        Set<UUID> stationingIds = new LinkedHashSet<>();
        for (UnitRow r : state.values()) {
            if (r.siteId() != null) {
                siteIds.add(r.siteId());
            }
            if (r.stationingId() != null) {
                stationingIds.add(r.stationingId());
            }
        }
        Map<UUID, SiteRef> sites = siteRefs(siteIds);
        Map<UUID, Map<String, Object>> areas = deploymentAreas(stationingIds);
        Map<UUID, Long> inReach = countInReachAtSite(state);
        Map<UUID, UnitOpenRequest> openByUnit = openRequestByUnit(ids, UNIT_OPEN_STATES,
                List.of("RESTATIONING", "DEPLOYMENT_AREAS", "SITE_REGISTRATION", "INITIAL_STATIONING"));
        // We still need the open-DEPLOYMENT_AREAS slot used by the DEPLOYMENT_REQUEST_PENDING state label.
        Map<UUID, UnitOpenRequest> openDeploy = openRequestByUnit(ids, UNIT_OPEN_STATES, List.of("DEPLOYMENT_AREAS"));

        List<Map<String, Object>> units = new ArrayList<>(tree.size());
        for (Map<String, Object> u : tree) {
            UUID id = UUID.fromString(u.get("id").toString());
            UnitRow row = state.get(id);
            Map<String, Object> m = new LinkedHashMap<>(u);
            boolean pendingDep = row != null && openDeploy.containsKey(id);
            m.put("state", row == null ? "NO_STATIONING" : row.deploymentState(pendingDep));
            if (row != null && row.stationingId() != null) {
                SiteRef site = row.siteId() == null ? null : sites.get(row.siteId());
                m.put("site", site == null ? null : site.asMap());
                m.put("kind", row.kind());
                m.put("plannedEnd", row.plannedEnd() == null ? null : row.plannedEnd().toString());
                Map<String, Object> ar = areas.getOrDefault(row.stationingId(), Map.of());
                m.put("primary", ar.get("PRIMARY"));
                m.put("alternative", ar.get("ALTERNATIVE"));
                long inR = row.siteId() == null ? 0 : inReach.getOrDefault(row.siteId(), 0L);
                m.put("otherUnitsAtSite", Math.max(0, row.siteTotal() - inR));
            }
            UnitOpenRequest or = openByUnit.get(id);
            if (or != null) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("purpose", or.purpose());
                r.put("state", or.state());
                m.put("request", r);
            } else {
                m.put("request", null);
            }
            units.add(m);
        }

        // Pending proposals: one bulk id-list filtered by scope-intersection, one bulk load of only those requests,
        // then visible() per candidate (unavoidable — the rule is complex), and one bulk stage/label scan.
        List<UUID> candidateIds = openRequestIdsForReach(ids, PENDING_STATES, List.of("RESTATIONING", "DEPLOYMENT_AREAS"));
        List<Map<String, Object>> pending = new ArrayList<>();
        if (!candidateIds.isEmpty()) {
            Map<UUID, String> stageLabels = currentStageLabel(candidateIds);
            Set<UUID> scopeAll = new LinkedHashSet<>();
            List<RestationingService.Req> visible = new ArrayList<>();
            for (UUID rid : candidateIds) {
                requests.load(rid).ifPresent(r -> {
                    if (requests.visible(ctx, r)) {
                        visible.add(r);
                        scopeAll.addAll(r.content().scope());
                    }
                });
            }
            Map<UUID, Map<String, String>> labels = unitLabels(scopeAll);
            Map<UUID, UUID> scopeSites = new HashMap<>();
            if (!scopeAll.isEmpty()) {
                Map<UUID, UnitRow> scopeState = unitState(scopeAll, now);
                for (Map.Entry<UUID, UnitRow> e : scopeState.entrySet()) {
                    scopeSites.put(e.getKey(), e.getValue().siteId());
                }
            }
            for (RestationingService.Req r : visible) {
                String stage = stageLabels.get(r.id());
                RestationingContent c = r.content();
                for (UUID scopeUnit : c.scope()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("requestId", r.id().toString());
                    row.put("requestNumber", r.number());
                    row.put("purpose", r.purpose());
                    row.put("state", r.state());
                    row.put("currentStage", stage);
                    row.put("unitId", scopeUnit.toString());
                    Map<String, String> label = labels.get(scopeUnit);
                    row.put("unitCode", label == null ? null : label.get("code"));
                    row.put("unitName", label == null ? null : label.get("name"));
                    UUID siteId = scopeSites.get(scopeUnit);
                    row.put("currentSiteId", siteId == null ? null : siteId.toString());
                    row.put("proposedSite", c.site() == null ? null : c.site().geometry());
                    row.put("proposedPrimary", c.primary());
                    row.put("proposedSub", c.alternative());
                    pending.add(row);
                }
            }
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("units", units);
        out.put("unitsTotal", tree.size());
        out.put("pending", pending);
        // The controller already computed the user-scoped data-revision and either short-circuited to 304 or fell
        // through to here; carry the same value in the body so the client knows what revision it got.
        out.put("dataRevision", dataRevisionFor(ctx.personId()));
        return out;
    }
}
