package ae.mover.facilities;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Grant;
import ae.mover.access.Permission;
import ae.mover.access.ViewLevel;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.common.Ref;
import ae.mover.common.Times;
import ae.mover.org.OrganizationService;
import ae.mover.reservations.ReservationService;

/**
 * Facility layers for the map workspace. Everything is decided on the server for the requested viewport, period and
 * resources: which sites the actor may see, their registered boundaries (never a shape around a point), the state of
 * each resource, partial occupancy of shared sites, request layers the role may see, and background coverage for the
 * selected package and zoom. Nothing outside scope is sent to the browser to be hidden there.
 */
@Service
public class MapService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final SiteService sites;
    private final ReservationService reservations;
    private final MapPackageService packages;
    private final OrganizationService orgs;

    public MapService(JdbcClient jdbc, Json json, Clock clock, SiteService sites, ReservationService reservations,
                      MapPackageService packages, OrganizationService orgs) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.sites = sites;
        this.reservations = reservations;
        this.packages = packages;
        this.orgs = orgs;
    }

    // ---- query --------------------------------------------------------------------------------------------

    public record FeatureQuery(String bbox, String from, String to, Boolean open, String time, String resourceIds,
                               String orgId, Boolean includeSubOrgs, String packageId, Double zoom, String siteIds) {
    }

    /** Half-open period [start, end); end null = open-ended use. */
    record Period(Instant start, Instant end) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ResourceState(String id, String code, String name, String label, String kind, String policy,
                                String parentResourceId, String state, String reason, Boolean pending, Integer handoverMinutes) {
    }

    public record Boundary(int version, String type, JsonNode geojson, boolean simplified) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Feature(String siteId, String code, String name, String kind,
                          @JsonInclude(JsonInclude.Include.ALWAYS) String parentId, String view,
                          @JsonInclude(JsonInclude.Include.ALWAYS) Double lat, @JsonInclude(JsonInclude.Include.ALWAYS) Double lng,
                          @JsonInclude(JsonInclude.Include.ALWAYS) Boundary boundary, String boundaryStatus,
                          String availability, String administrative, Integer pendingCount, Ref responsibleOrg,
                          List<Ref> occupants, List<String> relations, List<ResourceState> resources, boolean requestsVisible) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MapFeatures(String asOf, Map<String, String> period, String dataVersion, Map<String, Object> coverage,
                              List<Feature> features, Map<String, Object> filter, Map<String, Object> limits) {
    }

    /** Beyond these counts in one viewport the map asks the user to zoom in instead of sending every shape. */
    static final int MAX_BOUNDARIES = 1500;
    static final int MAX_FEATURES = 5000;

    public MapFeatures features(AccessContext ctx, FeatureQuery q) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        Period period = period(q);
        double[] box = bbox(q.bbox());
        Set<UUID> onlySites = ids(q.siteIds(), "siteIds");
        Set<UUID> selectedResources = ids(q.resourceIds(), "resourceIds");

        // 1. candidate sites in the viewport (marker or boundary intersects), spatially indexed
        List<UUID> candidates;
        if (box != null) {
            candidates = jdbc.sql("""
                    with env as (select ST_MakeEnvelope(:x1, :y1, :x2, :y2, 4326) as e)
                    select s.id from site s, env where s.status = 'ACTIVE' and s.marker && env.e
                    union
                    select s.id from site s join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version, env
                    where s.status = 'ACTIVE' and g.geometry_type <> 'Point' and g.geom && env.e""")
                    .param("x1", box[0]).param("y1", box[1]).param("x2", box[2]).param("y2", box[3]).query(UUID.class).list();
        } else {
            candidates = jdbc.sql("""
                    select s.id from site s left join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version
                    where s.status = 'ACTIVE' and (s.marker is not null or (g.geometry_type is not null and g.geometry_type <> 'Point'))""")
                    .query(UUID.class).list();
        }
        if (onlySites != null) {
            candidates = candidates.stream().filter(onlySites::contains).toList();
        }

        // 2. scope: only sites the actor may view; full view decides occupant names and request layers
        Map<UUID, Row> rows = new LinkedHashMap<>();
        if (!candidates.isEmpty()) {
            jdbc.sql("""
                    select s.id, s.code, s.name, s.kind, s.parent_id, s.lat, s.lng, s.geometry_version, sr.organization_id,
                           o.name as org_name from site s
                    left join site_responsibility sr on sr.site_id = s.id and sr.valid_to is null
                    left join organization o on o.id = sr.organization_id
                    where s.id = any(string_to_array(:ids, ',')::uuid[]) order by s.code""")
                    .param("ids", Db.ids(candidates)).query((rs, n) -> {
                        UUID id = Db.uuid(rs, "id");
                        UUID org = Db.uuid(rs, "organization_id");
                        ViewLevel v = ctx.siteView(id, Set.of(), org);
                        if (v != ViewLevel.NONE) {
                            rows.put(id, new Row(id, rs.getString("code"), rs.getString("name"), rs.getString("kind"),
                                    Db.uuid(rs, "parent_id"), (Double) rs.getObject("lat"), (Double) rs.getObject("lng"), org,
                                    rs.getString("org_name"), v, requestViewer(ctx, id, org)));
                        }
                        return null;
                    }).list();
        }

        // 3. optional organisation filter: responsibility or use in the period (full view only, never inferred from names)
        final Set<UUID> orgSet = q.orgId() == null || q.orgId().isBlank() ? null
                : orgs.requireVisibleBranch(ctx, uuid(q.orgId(), "orgId"), !Boolean.FALSE.equals(q.includeSubOrgs()));

        Map<String, Object> limits = new LinkedHashMap<>();
        if (rows.size() > MAX_FEATURES) {
            List<UUID> keep = new ArrayList<>(rows.keySet()).subList(0, MAX_FEATURES);
            rows.keySet().retainAll(new HashSet<>(keep));
            limits.put("truncated", true);
            limits.put("message", "نطاق العرض يضم أكثر من " + MAX_FEATURES + " موقع؛ كبّر الخريطة أو اختر جهة لعرض جميع المواقع.");
        }
        Set<UUID> siteIds = rows.keySet();
        Map<UUID, List<Map<String, Object>>> resourcesBySite = resources(siteIds);
        Set<UUID> allResources = new HashSet<>();
        resourcesBySite.values().forEach(l -> l.forEach(r -> allResources.add((UUID) r.get("id"))));
        Map<UUID, String> lockKind = locks(allResources, period);
        Set<UUID> sharedInUse = sharedInUse(allResources, period);
        Map<UUID, Integer> pendingByResource = pendingByResource(allResources, period);
        Map<UUID, Set<UUID>> pendingRequestsBySite = pendingRequestsBySite(siteIds, period);
        Set<UUID> approvedSites = approvedSites(siteIds, period);
        Map<UUID, List<Ref>> occupants = occupants(siteIds, period);
        Set<UUID> registered = siteIds.isEmpty() ? Set.of() : new HashSet<>(jdbc.sql("""
                select s.id from site s join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version
                where s.id = any(string_to_array(:ids, ',')::uuid[]) and g.geometry_type <> 'Point'""")
                .param("ids", Db.ids(siteIds)).query(UUID.class).list());
        Map<UUID, Boundary> boundaries;
        if (siteIds.size() > MAX_BOUNDARIES) {
            boundaries = Map.of();
            limits.put("boundariesOmitted", true);
            limits.putIfAbsent("message", "تُعرض العلامات فقط لأن نطاق العرض يضم " + siteIds.size()
                    + " موقعاً؛ كبّر الخريطة لعرض الحدود.");
        } else {
            boundaries = boundaries(siteIds, box);
        }

        List<Feature> features = new ArrayList<>();
        for (Row r : rows.values()) {
            List<String> relations = new ArrayList<>();
            if (orgSet != null) {
                if (r.view() != ViewLevel.FULL) {
                    continue;
                }
                if (r.orgId() != null && orgSet.contains(r.orgId())) {
                    relations.add("RESPONSIBLE");
                }
                if (occupants.getOrDefault(r.id(), List.of()).stream().anyMatch(o -> orgSet.contains(UUID.fromString(o.id())))) {
                    relations.add("OCCUPANT");
                }
                if (relations.isEmpty()) {
                    continue;
                }
            }
            boolean full = r.view() == ViewLevel.FULL;
            List<ResourceState> states = new ArrayList<>();
            for (Map<String, Object> res : resourcesBySite.getOrDefault(r.id(), List.of())) {
                UUID rid = (UUID) res.get("id");
                String policy = (String) res.get("policy");
                String state;
                String reason = null;
                if ("SHARED".equals(policy)) {
                    state = sharedInUse.contains(rid) ? "SHARED_IN_USE" : "FREE";
                    reason = sharedInUse.contains(rid) ? "مورد مشترك مستخدم في الفترة ويبقى قابلاً للطلب" : null;
                } else if (lockKind.containsKey(rid)) {
                    state = "BLOCKED";
                    reason = "X".equals(lockKind.get(rid)) ? "محجوز بحجز معتمد خلال الفترة (أو فترة التسليم)"
                            : "جزء منه (مورد فرعي) محجوز خلال الفترة";
                } else {
                    state = "FREE";
                }
                String name = (String) res.get("name");
                String label = res.get("parent_resource_id") == null ? r.name() : r.name() + " — " + name;
                states.add(new ResourceState(rid.toString(), (String) res.get("code"), name, label, (String) res.get("kind"), policy,
                        res.get("parent_resource_id") == null ? null : res.get("parent_resource_id").toString(), state, reason,
                        r.requests() ? pendingByResource.containsKey(rid) : null, ((Number) res.get("handover_minutes")).intValue()));
            }
            // Selected resources decide the colour of the site that holds them; other sites keep their own resources.
            List<ResourceState> chosen = selectedResources == null ? List.of()
                    : states.stream().filter(s -> selectedResources.contains(UUID.fromString(s.id()))).toList();
            List<ResourceState> relevant = chosen.isEmpty() ? states : chosen;
            String availability;
            if (relevant.isEmpty()) {
                availability = "NO_RESOURCES";
            } else if (relevant.stream().allMatch(s -> "BLOCKED".equals(s.state()))) {
                availability = "BUSY";
            } else if (relevant.stream().anyMatch(s -> !"FREE".equals(s.state()))) {
                availability = "PARTIAL";
            } else {
                availability = "FREE";
            }
            Set<UUID> pending = pendingRequestsBySite.getOrDefault(r.id(), Set.of());
            String administrative = r.requests() && !pending.isEmpty() ? "PENDING" : approvedSites.contains(r.id()) ? "APPROVED" : "NONE";
            Boundary b = boundaries.get(r.id());
            features.add(new Feature(r.id().toString(), r.code(), r.name(), r.kind(),
                    r.parentId() == null ? null : r.parentId().toString(), r.view().name(), r.lat(), r.lng(), b,
                    registered.contains(r.id()) ? "REGISTERED" : "NOT_REGISTERED", availability, administrative,
                    r.requests() ? pending.size() : null, full && r.orgId() != null ? Ref.of(r.orgId(), r.orgName()) : null,
                    full ? occupants.getOrDefault(r.id(), List.of()) : null, orgSet == null ? null : relations, states, r.requests()));
        }
        String dataVersion = jdbc.sql("""
                select greatest((select coalesce(max(updated_at), 'epoch') from reservation),
                                (select coalesce(max(updated_at), 'epoch') from request),
                                (select coalesce(max(valid_from), 'epoch') from site_geometry_version))::text""").query(String.class).single();
        Map<String, String> p = new LinkedHashMap<>();
        p.put("start", period.start().toString());
        p.put("end", period.end() == null ? null : period.end().toString());
        Map<String, Object> filter = new LinkedHashMap<>();
        if (orgSet != null) {
            filter.put("orgId", q.orgId());
            filter.put("includeSubOrgs", !Boolean.FALSE.equals(q.includeSubOrgs()));
        }
        if (selectedResources != null) {
            filter.put("resourceIds", selectedResources.stream().map(UUID::toString).sorted().toList());
        }
        return new MapFeatures(clock.instant().toString(), p, dataVersion, coverage(ctx, box, q.zoom(), q.packageId()), features,
                filter.isEmpty() ? null : filter, limits.isEmpty() ? null : limits);
    }

    record Row(UUID id, String code, String name, String kind, UUID parentId, Double lat, Double lng, UUID orgId, String orgName,
               ViewLevel view, boolean requests) {
    }

    /**
     * Request layers (pending counts, request status) need a full VIEW grant over the site. Facility management or a
     * summary view shows availability and approved occupancy of the facility, never request content or counts.
     */
    private static boolean requestViewer(AccessContext ctx, UUID siteId, UUID orgId) {
        Set<UUID> orgSet = orgId == null ? Set.of() : Set.of(orgId);
        for (Grant g : ctx.grants()) {
            if (g.fullViewer() && g.covers(orgSet, Set.of(siteId))) {
                return true;
            }
        }
        return false;
    }

    Period period(FeatureQuery q) {
        if (q.from() != null && !q.from().isBlank()) {
            Instant start = Times.parse(q.from(), "from");
            Instant end = Boolean.TRUE.equals(q.open()) || q.to() == null || q.to().isBlank() ? null : Times.parse(q.to(), "to");
            if (end == null && !Boolean.TRUE.equals(q.open())) {
                throw ApiException.validation("حدد نهاية الفترة، أو اطلب فترة مفتوحة صراحةً (open=true).");
            }
            if (end != null && !end.isAfter(start)) {
                throw ApiException.validation("نهاية الفترة يجب أن تكون بعد بدايتها.");
            }
            return new Period(start, end);
        }
        Instant at = q.time() == null || q.time().isBlank() ? clock.instant() : Times.parse(q.time(), "time");
        return new Period(at, at.plus(Duration.ofDays(1)));
    }

    private static double[] bbox(String bbox) {
        if (bbox == null || bbox.isBlank()) {
            return null;
        }
        String[] parts = bbox.split(",");
        if (parts.length != 4) {
            throw ApiException.validation("صيغة النطاق bbox يجب أن تكون minLng,minLat,maxLng,maxLat.");
        }
        double[] b = new double[4];
        try {
            for (int i = 0; i < 4; i++) {
                b[i] = Double.parseDouble(parts[i].trim());
            }
        } catch (NumberFormatException e) {
            throw ApiException.validation("صيغة النطاق bbox غير رقمية.");
        }
        if (b[0] >= b[2] || b[1] >= b[3] || b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90) {
            throw ApiException.validation("النطاق bbox خارج حدود الإحداثيات أو مقلوب.");
        }
        return b;
    }

    private static Set<UUID> ids(String csv, String label) {
        if (csv == null || csv.isBlank()) {
            return null;
        }
        Set<UUID> out = new HashSet<>();
        for (String s : csv.split(",")) {
            if (!s.isBlank()) {
                out.add(uuid(s.trim(), label));
            }
        }
        return out;
    }

    private static UUID uuid(String v, String label) {
        try {
            return UUID.fromString(v);
        } catch (IllegalArgumentException e) {
            throw ApiException.validation("معرف غير صالح في «" + label + "».");
        }
    }

    // ---- set-based reads ------------------------------------------------------------------------------------

    private Map<UUID, List<Map<String, Object>>> resources(Set<UUID> siteIds) {
        Map<UUID, List<Map<String, Object>>> out = new HashMap<>();
        if (siteIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select id, site_id, code, name, kind, policy, parent_resource_id, handover_minutes from resource
                where status = 'ACTIVE' and site_id = any(string_to_array(:ids, ',')::uuid[]) order by code""")
                .param("ids", Db.ids(siteIds)).query().listOfRows()
                .forEach(r -> out.computeIfAbsent((UUID) r.get("site_id"), k -> new ArrayList<>()).add(r));
        return out;
    }

    /**
     * Scope locks overlapping the period extended by each resource's handover time: an X lock (the resource or an
     * ancestor reserved) or an I lock (a sub-resource reserved) both mean reserving this resource would conflict.
     */
    private Map<UUID, String> locks(Set<UUID> resourceIds, Period p) {
        Map<UUID, String> out = new HashMap<>();
        if (resourceIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select l.resource_id, bool_or(l.kind = 'X') as x from reservation_lock l join resource r on r.id = l.resource_id
                where l.resource_id = any(string_to_array(:ids, ',')::uuid[])
                  and l.period && tstzrange(:a, cast(:b as timestamptz) + make_interval(mins => r.handover_minutes), '[)')
                group by l.resource_id""")
                .param("ids", Db.ids(resourceIds)).param("a", Db.ts(p.start())).param("b", Db.ts(p.end()))
                .query((rs, n) -> out.put(Db.uuid(rs, "resource_id"), rs.getBoolean("x") ? "X" : "I")).list();
        return out;
    }

    private Set<UUID> sharedInUse(Set<UUID> resourceIds, Period p) {
        if (resourceIds.isEmpty()) {
            return Set.of();
        }
        return new HashSet<>(jdbc.sql("""
                select distinct v.resource_id from reservation v join resource r on r.id = v.resource_id
                where r.policy = 'SHARED' and v.status = 'ACTIVE' and v.resource_id = any(string_to_array(:ids, ',')::uuid[])
                  and tstzrange(v.period_start, v.period_end, '[)') && tstzrange(:a, :b, '[)')""")
                .param("ids", Db.ids(resourceIds)).param("a", Db.ts(p.start())).param("b", Db.ts(p.end())).query(UUID.class).list());
    }

    /** Submitted requests never block anything; they are a separate administrative layer (orange). */
    private Map<UUID, Integer> pendingByResource(Set<UUID> resourceIds, Period p) {
        Map<UUID, Integer> out = new HashMap<>();
        if (resourceIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select rr.resource_id, count(distinct q.id) as n from request q join request_resource rr on rr.request_id = q.id
                join request_type t on t.code = q.type_code and t.kind in ('NEW_RESERVATION', 'EXTENSION', 'MODIFICATION')
                where q.status = 'SUBMITTED' and rr.resource_id = any(string_to_array(:ids, ',')::uuid[])
                  and tstzrange(q.period_start, q.period_end, '[)') && tstzrange(:a, :b, '[)')
                group by rr.resource_id""")
                .param("ids", Db.ids(resourceIds)).param("a", Db.ts(p.start())).param("b", Db.ts(p.end()))
                .query((rs, n) -> out.put(Db.uuid(rs, "resource_id"), rs.getInt("n"))).list();
        return out;
    }

    private Map<UUID, Set<UUID>> pendingRequestsBySite(Set<UUID> siteIds, Period p) {
        Map<UUID, Set<UUID>> out = new HashMap<>();
        if (siteIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select distinct r.site_id, q.id from request q
                join request_type t on t.code = q.type_code and t.kind in ('NEW_RESERVATION', 'EXTENSION', 'MODIFICATION')
                join request_resource rr on rr.request_id = q.id join resource r on r.id = rr.resource_id
                where q.status = 'SUBMITTED' and r.site_id = any(string_to_array(:ids, ',')::uuid[])
                  and tstzrange(q.period_start, q.period_end, '[)') && tstzrange(:a, :b, '[)')""")
                .param("ids", Db.ids(siteIds)).param("a", Db.ts(p.start())).param("b", Db.ts(p.end()))
                .query((rs, n) -> out.computeIfAbsent(Db.uuid(rs, "site_id"), k -> new HashSet<>()).add(Db.uuid(rs, "id"))).list();
        return out;
    }

    private Set<UUID> approvedSites(Set<UUID> siteIds, Period p) {
        if (siteIds.isEmpty()) {
            return Set.of();
        }
        return new HashSet<>(jdbc.sql("""
                select distinct r.site_id from reservation v join resource r on r.id = v.resource_id
                where v.status = 'ACTIVE' and r.site_id = any(string_to_array(:ids, ',')::uuid[])
                  and tstzrange(v.period_start, v.period_end, '[)') && tstzrange(:a, :b, '[)')""")
                .param("ids", Db.ids(siteIds)).param("a", Db.ts(p.start())).param("b", Db.ts(p.end())).query(UUID.class).list());
    }

    /** Every organisation using the site in the period (not only the first one found). */
    private Map<UUID, List<Ref>> occupants(Set<UUID> siteIds, Period p) {
        Map<UUID, List<Ref>> out = new HashMap<>();
        if (siteIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select distinct r.site_id, o.id, o.name from reservation v join resource r on r.id = v.resource_id
                join organization o on o.id = v.organization_id
                where v.status = 'ACTIVE' and r.site_id = any(string_to_array(:ids, ',')::uuid[])
                  and tstzrange(v.period_start, v.period_end, '[)') && tstzrange(:a, :b, '[)')
                order by r.site_id, o.name""")
                .param("ids", Db.ids(siteIds)).param("a", Db.ts(p.start())).param("b", Db.ts(p.end()))
                .query((rs, n) -> out.computeIfAbsent(Db.uuid(rs, "site_id"), k -> new ArrayList<>())
                        .add(Ref.of(Db.uuid(rs, "id"), rs.getString("name")))).list();
        return out;
    }

    /**
     * Current registered boundaries (Polygon/MultiPolygon only). Large shapes are simplified for the viewport scale;
     * the exact stored version is always available from the site record.
     */
    private Map<UUID, Boundary> boundaries(Set<UUID> siteIds, double[] box) {
        Map<UUID, Boundary> out = new HashMap<>();
        if (siteIds.isEmpty()) {
            return out;
        }
        double tolerance = box == null ? 0.00005 : Math.max((box[2] - box[0]) / 3000.0, 0.000001);
        jdbc.sql("""
                select g.site_id, g.version, g.geometry_type, ST_NPoints(g.geom) > 2000 as big,
                       ST_AsGeoJSON(case when ST_NPoints(g.geom) > 2000 then ST_SimplifyPreserveTopology(g.geom, :tol) else g.geom end, 7) as gj
                from site s join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version
                where s.id = any(string_to_array(:ids, ',')::uuid[]) and g.geometry_type <> 'Point'""")
                .param("ids", Db.ids(siteIds)).param("tol", tolerance)
                .query((rs, n) -> out.put(Db.uuid(rs, "site_id"), new Boundary(rs.getInt("version"), rs.getString("geometry_type"),
                        json.tree(rs.getString("gj")), rs.getBoolean("big")))).list();
        return out;
    }

    // ---- coverage and context -----------------------------------------------------------------------------

    /**
     * Coverage of the viewport by the selected background (or by any active background when none is selected),
     * computed from the actual viewport, zoom and package — a package somewhere in the database is not coverage.
     */
    public Map<String, Object> coverage(AccessContext ctx, double[] box, Double zoom, String packageId) {
        List<MapPackageService.MapPackage> active = packages.activeBackgrounds();
        Map<String, Object> out = new LinkedHashMap<>();
        if (packageId != null && !packageId.isBlank()) {
            MapPackageService.MapPackage pkg = active.stream().filter(p -> p.id().equals(packageId)).findFirst().orElse(null);
            if (pkg == null) {
                pkg = MapPackageService.manager(ctx) ? packages.list(ctx, true).stream()
                        .filter(p -> p.id().equals(packageId) && "overlay".equals(p.role())).findFirst().orElse(null) : null;
            }
            if (pkg == null) {
                out.put("status", "NO_PACKAGE");
                out.put("message", "الخلفية المختارة غير مثبتة أو غير مفعّلة.");
                return out;
            }
            active = List.of(pkg);
            out.put("packageId", pkg.id());
            out.put("packageName", pkg.name());
        }
        if (active.isEmpty()) {
            out.put("status", "NO_PACKAGE");
            out.put("message", "لا توجد خلفية خرائط مفعّلة. تُعرض المواقع وحدودها دون خلفية.");
            return out;
        }
        if (box == null) {
            out.put("status", "UNKNOWN");
            out.put("message", null);
            return out;
        }
        double viewArea = (box[2] - box[0]) * (box[3] - box[1]);
        double best = 0;
        MapPackageService.MapPackage bestPkg = null;
        for (MapPackageService.MapPackage p : active) {
            double w = Math.min(box[2], p.coverage().maxLng()) - Math.max(box[0], p.coverage().minLng());
            double h = Math.min(box[3], p.coverage().maxLat()) - Math.max(box[1], p.coverage().minLat());
            double f = w > 0 && h > 0 ? (w * h) / viewArea : 0;
            if (f > best) {
                best = f;
                bestPkg = p;
            }
        }
        out.put("fraction", Math.round(best * 1000) / 1000.0);
        String name = bestPkg != null ? bestPkg.name() : active.get(0).name();
        if (best <= 0) {
            out.put("status", "NONE");
            out.put("message", "نافذة العرض خارج تغطية «" + name + "». لا توجد خلفية مثبتة لهذا النطاق؛ تُعرض المواقع وحدودها دون خلفية.");
        } else if (best < 0.999) {
            out.put("status", "PARTIAL");
            out.put("message", "تغطية جزئية: «" + name + "» يغطي نحو " + Math.round(best * 100)
                    + "% من نافذة العرض؛ خارجها لا توجد خلفية.");
        } else {
            out.put("status", "FULL");
            out.put("message", null);
        }
        if (bestPkg != null && zoom != null && bestPkg.minZoom() != null && bestPkg.maxZoom() != null
                && (zoom < bestPkg.minZoom() || zoom > bestPkg.maxZoom()) && best > 0) {
            out.put("status", "ZOOM_OUT_OF_RANGE");
            out.put("message", "مستوى التكبير " + zoom + " خارج نطاق «" + name + "» (" + bestPkg.minZoom() + "–" + bestPkg.maxZoom()
                    + "). قد تظهر الخلفية غير واضحة أو ناقصة.");
        }
        if (bestPkg != null) {
            out.putIfAbsent("packageId", bestPkg.id());
            out.putIfAbsent("packageName", bestPkg.name());
        }
        return out;
    }

    /** First-visit view: the extent of what the actor may see (markers and boundaries), not a fixed city or zoom. */
    public Map<String, Object> context(AccessContext ctx) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        Set<String> visible = new HashSet<>();
        for (SiteService.SiteView s : sites.list(ctx)) {
            if (!SiteService.CONTEXT.equals(s.view())) {
                visible.add(s.id());
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        if (!visible.isEmpty()) {
            Map<String, Object> e = jdbc.sql("""
                    with v as (select s.id, s.marker, g.geom from site s
                        left join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version and g.geometry_type <> 'Point'
                        where s.id = any(string_to_array(:ids, ',')::uuid[]) and s.status = 'ACTIVE'),
                    all_g as (select marker as g from v where marker is not null union all select geom from v where geom is not null)
                    select ST_XMin(ST_Extent(g)) x1, ST_YMin(ST_Extent(g)) y1, ST_XMax(ST_Extent(g)) x2, ST_YMax(ST_Extent(g)) y2,
                           count(*) as n from all_g""").param("ids", String.join(",", visible)).query().singleRow();
            if (e.get("x1") != null) {
                out.put("extent", List.of(e.get("x1"), e.get("y1"), e.get("x2"), e.get("y2")));
            }
        }
        out.put("siteCount", visible.size());
        List<MapPackageService.MapPackage> bg = packages.activeBackgrounds();
        out.put("backgrounds", bg);
        out.put("aerialInstalled", bg.stream().anyMatch(p -> "AERIAL".equals(p.kind())));
        out.put("canManagePackages", MapPackageService.manager(ctx));
        out.put("canEditBoundaries", ctx.has(Permission.MANAGE_FACILITIES));
        out.put("canExport", ctx.has(Permission.EXPORT));
        out.put("timezone", Times.DISPLAY_ZONE.getId());
        return out;
    }

    // ---- day grid and availability check (shared with the calendar and the request form) --------------------

    public record GridRow(String siteId, List<String> cells) {
    }

    public record Grid(List<String> days, List<GridRow> rows) {
    }

    /** Days × sites with the same rules as the map: BUSY only when every resource is blocked, PARTIAL otherwise. */
    public Grid grid(AccessContext ctx, String from, Integer days) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        LocalDate start = from == null ? LocalDate.now(clock.withZone(Times.DISPLAY_ZONE)) : Times.parseDate(from, "from");
        int n = days == null ? 7 : Math.max(1, Math.min(days, 31));
        List<String> dayList = new ArrayList<>();
        List<Map<String, String>> cells = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            LocalDate d = start.plusDays(i);
            dayList.add(d.toString());
            MapFeatures f = features(ctx, new FeatureQuery(null, Times.startOfDay(d).toString(), Times.startOfDay(d.plusDays(1)).toString(),
                    false, null, null, null, null, null, null, null));
            Map<String, String> m = new HashMap<>();
            f.features().forEach(x -> m.put(x.siteId(), "PENDING".equals(x.administrative()) && !"BUSY".equals(x.availability())
                    ? "PENDING" : x.availability()));
            cells.add(m);
        }
        List<GridRow> rows = new ArrayList<>();
        for (SiteService.SiteView s : sites.list(ctx)) {
            if (SiteService.CONTEXT.equals(s.view())) {
                continue;
            }
            List<String> row = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                row.add(cells.get(i).getOrDefault(s.id(), "NO_RESOURCES"));
            }
            rows.add(new GridRow(s.id(), row));
        }
        return new Grid(dayList, rows);
    }

    public record CheckInput(List<String> resourceIds, String start, String end, String excludeReservationId) {
    }

    public record CheckResult(boolean available, List<ReservationService.Conflict> conflicts,
                              @JsonInclude(JsonInclude.Include.ALWAYS) Integer pendingRequests, String note) {
    }

    public CheckResult check(AccessContext ctx, CheckInput in) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        if (in == null || in.resourceIds() == null || in.resourceIds().isEmpty()) {
            throw ApiException.validation("حدد المرافق المطلوب فحصها.");
        }
        Instant start = Times.parse(in.start(), "start");
        Instant end = Times.parse(in.end(), "end");
        if (start == null || (end != null && !end.isAfter(start))) {
            throw ApiException.validation("حدد فترة صحيحة.");
        }
        List<UUID> ids;
        try {
            ids = in.resourceIds().stream().map(UUID::fromString).toList();
        } catch (IllegalArgumentException e) {
            throw ApiException.notFound();
        }
        sites.requireVisibleResources(ctx, ids);
        List<ReservationService.Conflict> conflicts = reservations.conflicts(ids, start, end,
                in.excludeReservationId() == null ? null : UUID.fromString(in.excludeReservationId()));
        // The number of requests under review is request content: only for a full VIEW over every resource's site.
        boolean requests = jdbc.sql("""
                select r.site_id, sr.organization_id from resource r
                left join site_responsibility sr on sr.site_id = r.site_id and sr.valid_to is null
                where r.id = any(string_to_array(:ids, ',')::uuid[])""").param("ids", Db.ids(ids)).query().listOfRows().stream()
                .allMatch(m -> requestViewer(ctx, (UUID) m.get("site_id"), (UUID) m.get("organization_id")));
        Integer pending = !requests ? null : jdbc.sql("""
                select count(distinct q.id) from request q join request_resource rr on rr.request_id = q.id
                where q.status = 'SUBMITTED' and rr.resource_id = any(string_to_array(:ids, ',')::uuid[])
                  and tstzrange(q.period_start, q.period_end, '[)') && tstzrange(:a, :b, '[)')""")
                .param("ids", Db.ids(ids)).param("a", Db.ts(start)).param("b", Db.ts(end)).query(Integer.class).single();
        return new CheckResult(conflicts.isEmpty(), conflicts, pending,
                "معاينة فقط: لا تمنح حجزاً، ويُعاد التحقق عند الاعتماد النهائي.");
    }
}
