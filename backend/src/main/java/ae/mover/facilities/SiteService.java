package ae.mover.facilities;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Json;
import ae.mover.common.Ref;
import ae.mover.reservations.ReservationService;

/** Permanent sites and reservable resources. Sites are never destructively deleted; they are retired. */
@Service
public class SiteService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final ReservationService reservations;

    public SiteService(JdbcClient jdbc, Json json, Clock clock, AuditService audit, ReservationService reservations) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.reservations = reservations;
    }

    public record Location(double lat, double lng) {
    }

    public record ResourceView(String id, String code, String name, String kind, String policy, String parentResourceId,
                               int handoverMinutes, Integer capacity, String siteId, String label, boolean childBlocking,
                               Integer sharedLimit) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SiteView(String id, String code, String name, String kind,
                           @JsonInclude(JsonInclude.Include.ALWAYS) String parentId, String status,
                           @JsonInclude(JsonInclude.Include.ALWAYS) Integer capacity,
                           @JsonInclude(JsonInclude.Include.ALWAYS) Location location,
                           Ref responsibleOrg, List<ResourceView> resources, String view) {
    }

    public record OccupancyItem(String reservationId, String resourceName, @JsonInclude(JsonInclude.Include.NON_NULL) Ref org,
                                Map<String, String> period, String status) {
    }

    public record GeometryView(int version, String type, String crs, String source, String validFrom, JsonNode geojson) {
    }

    /**
     * Site fields at top level plus the current boundary, the path of parent sites, occupancy history and what the actor
     * may do. The boundary is shown to anyone who may view the site; a site without a registered boundary says so
     * ({@code boundaryStatus = NOT_REGISTERED}) and nothing is drawn in its place.
     */
    public Map<String, Object> detailView(AccessContext ctx, UUID id) {
        SiteDetail d = detail(ctx, id);
        Map<String, Object> out = json.map(d.site());
        out.put("geometry", d.geometry());
        out.put("boundaryStatus", d.geometry() == null || "Point".equals(d.geometry().type()) ? "NOT_REGISTERED" : "REGISTERED");
        out.put("geometryVersion", d.geometryVersion());
        out.put("occupancy", d.occupancy());
        out.put("path", path(ctx, id));
        out.put("canManage", d.canManage());
        return out;
    }

    public record SiteDetail(SiteView site, GeometryView geometry, List<OccupancyItem> occupancy, Integer geometryVersion,
                             boolean canManage) {
    }

    record SiteRow(UUID id, String code, String name, String kind, UUID parentId, String status, Integer capacity,
                   Double lat, Double lng, UUID orgId, String orgName) {
    }

    private List<SiteRow> rows(String where, Map<String, Object> params) {
        return jdbc.sql("""
                select s.*, sr.organization_id, o.name as org_name from site s
                left join site_responsibility sr on sr.site_id = s.id and sr.valid_to is null
                left join organization o on o.id = sr.organization_id""" + " " + where + " order by s.code")
                .params(params)
                .query((rs, n) -> new SiteRow(Db.uuid(rs, "id"), rs.getString("code"), rs.getString("name"), rs.getString("kind"),
                        Db.uuid(rs, "parent_id"), rs.getString("status"), (Integer) rs.getObject("capacity"),
                        (Double) rs.getObject("lat"), (Double) rs.getObject("lng"), Db.uuid(rs, "organization_id"),
                        rs.getString("org_name"))).list();
    }

    private Map<UUID, List<ResourceView>> resourcesBySite() {
        Map<UUID, List<ResourceView>> out = new HashMap<>();
        jdbc.sql("""
                select r.*, s.name as site_name from resource r join site s on s.id = r.site_id where r.status = 'ACTIVE'
                order by r.code""").query((rs, n) -> {
            UUID site = Db.uuid(rs, "site_id");
            boolean primary = rs.getString("parent_resource_id") == null;
            out.computeIfAbsent(site, k -> new ArrayList<>()).add(new ResourceView(rs.getString("id"), rs.getString("code"),
                    rs.getString("name"), rs.getString("kind"), rs.getString("policy"), rs.getString("parent_resource_id"),
                    rs.getInt("handover_minutes"), (Integer) rs.getObject("capacity"), site.toString(),
                    primary ? rs.getString("site_name") : rs.getString("site_name") + " — " + rs.getString("name"),
                    rs.getBoolean("child_blocking"), (Integer) rs.getObject("shared_limit")));
            return null;
        }).list();
        return out;
    }

    /** View value of an ancestor that is listed only to place visible sites in the tree. */
    public static final String CONTEXT = "CONTEXT";

    /**
     * Visible sites, main (no parent) and sub-sites alike. Ancestors outside the actor's scope are included only as
     * tree context ({@link #CONTEXT}): code, name and parent — never location, resources, capacity or occupant.
     */
    public List<SiteView> list(AccessContext ctx) {
        List<SiteRow> all = rows("", Map.of());
        Map<UUID, SiteRow> byId = new HashMap<>();
        all.forEach(s -> byId.put(s.id(), s));
        Map<UUID, ViewLevel> levels = new LinkedHashMap<>();
        for (SiteRow s : all) {
            ViewLevel v = ctx.siteView(s.id(), Set.of(), s.orgId());
            if (v != ViewLevel.NONE) {
                levels.put(s.id(), v);
            }
        }
        Set<UUID> context = new java.util.HashSet<>();
        for (UUID id : List.copyOf(levels.keySet())) {
            UUID p = byId.get(id).parentId();
            while (p != null && !levels.containsKey(p) && context.add(p)) {
                p = byId.get(p) == null ? null : byId.get(p).parentId();
            }
        }
        Map<UUID, List<ResourceView>> resources = resourcesBySite();
        List<SiteView> out = new ArrayList<>();
        for (SiteRow s : all) {
            ViewLevel v = levels.get(s.id());
            if (v != null) {
                out.add(view(s, v, resources.getOrDefault(s.id(), List.of())));
            } else if (context.contains(s.id())) {
                out.add(new SiteView(s.id().toString(), s.code(), s.name(), s.kind(),
                        s.parentId() == null ? null : s.parentId().toString(), s.status(), null, null, null, List.of(), CONTEXT));
            }
        }
        return out;
    }

    /**
     * Fails with "not found" unless every resource is in the actor's scope. An unknown id and an out-of-scope id give
     * the same answer, so an availability check cannot confirm that a resource exists, nor reveal its name or requests.
     */
    public void requireVisibleResources(AccessContext ctx, List<UUID> resourceIds) {
        for (UUID rid : resourceIds) {
            Map<String, Object> res = jdbc.sql("""
                    select r.site_id, sr.organization_id from resource r
                    left join site_responsibility sr on sr.site_id = r.site_id and sr.valid_to is null where r.id = :id""")
                    .param("id", rid).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
            if (ctx.siteView((UUID) res.get("site_id"), Set.of(), (UUID) res.get("organization_id")) == ViewLevel.NONE) {
                throw ApiException.notFound();
            }
        }
    }

    private SiteView view(SiteRow s, ViewLevel v, List<ResourceView> resources) {
        return new SiteView(s.id().toString(), s.code(), s.name(), s.kind(), s.parentId() == null ? null : s.parentId().toString(),
                s.status(), s.capacity(), s.lat() == null ? null : new Location(s.lat(), s.lng()),
                v == ViewLevel.FULL ? Ref.of(s.orgId(), s.orgName()) : null, resources, v.name());
    }

    public SiteDetail detail(AccessContext ctx, UUID id) {
        SiteRow s = rows("where s.id = :id", Map.of("id", id)).stream().findFirst().orElseThrow(ApiException::notFound);
        ViewLevel v = ctx.siteView(s.id(), Set.of(), s.orgId());
        if (v == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        boolean full = v == ViewLevel.FULL;
        Integer geometryVersion = jdbc.sql("select geometry_version from site where id = :id").param("id", id)
                .query(Integer.class).optional().orElse(null);
        GeometryView geometry = geometryVersion == null ? null : jdbc.sql("""
                select version, geometry_type, crs, source, valid_from, geojson::text as g from site_geometry_version
                where site_id = :id and version = :v""")
                .param("id", id).param("v", geometryVersion).query((rs, n) -> new GeometryView(rs.getInt("version"),
                        rs.getString("geometry_type"), rs.getString("crs"), rs.getString("source"), Db.iso(rs, "valid_from"),
                        json.tree(rs.getString("g")))).optional().orElse(null);
        List<OccupancyItem> occupancy = jdbc.sql("""
                select v.id, r.name, v.organization_id, o.name as org_name, v.period_start, v.period_end, v.status
                from reservation v join resource r on r.id = v.resource_id join organization o on o.id = v.organization_id
                where r.site_id = :id order by v.period_start desc limit 200""")
                .param("id", id).query((rs, n) -> {
                    Map<String, String> period = new LinkedHashMap<>();
                    period.put("start", Db.iso(rs, "period_start"));
                    period.put("end", Db.iso(rs, "period_end"));
                    return new OccupancyItem(rs.getString("id"), rs.getString("name"),
                            full ? Ref.of(Db.uuid(rs, "organization_id"), rs.getString("org_name")) : null, period, rs.getString("status"));
                }).list();
        return new SiteDetail(view(s, v, resourcesBySite().getOrDefault(s.id(), List.of())), geometry, occupancy, geometryVersion,
                BoundaryService.canManage(ctx, s.orgId()));
    }

    // ---- tree and search (lazy) ---------------------------------------------------------------------------

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SiteNode(String id, String code, String name, String kind, String parentId, String view, int childCount,
                           boolean hasMarker, boolean hasBoundary, int resourceCount, List<Ref> path) {
    }

    /**
     * One level of the site tree: the roots (sites without a visible parent) or the children of one site. Ancestors
     * outside the actor's scope appear only as navigation context (code and name), never with location or resources.
     */
    public List<SiteNode> children(AccessContext ctx, UUID parentId) {
        List<SiteView> all = list(ctx);
        Map<String, SiteView> byId = new HashMap<>();
        all.forEach(s -> byId.put(s.id(), s));
        if (parentId != null && !byId.containsKey(parentId.toString())) {
            throw ApiException.notFound();
        }
        Map<String, Integer> childCounts = new HashMap<>();
        all.forEach(s -> {
            if (s.parentId() != null && byId.containsKey(s.parentId())) {
                childCounts.merge(s.parentId(), 1, Integer::sum);
            }
        });
        Set<String> bounded = boundedSites();
        List<SiteNode> out = new ArrayList<>();
        for (SiteView s : all) {
            boolean root = s.parentId() == null || !byId.containsKey(s.parentId());
            if (parentId == null ? root : parentId.toString().equals(s.parentId())) {
                out.add(node(s, childCounts, bounded, null));
            }
        }
        return out;
    }

    /** Search across every visible site (not only loaded branches), with the path of parent sites for each match. */
    public List<SiteNode> search(AccessContext ctx, String q, int limit) {
        String term = q == null ? "" : q.trim();
        if (term.isEmpty()) {
            return List.of();
        }
        List<SiteView> all = list(ctx);
        Map<String, SiteView> byId = new HashMap<>();
        all.forEach(s -> byId.put(s.id(), s));
        Set<String> bounded = boundedSites();
        String lower = term.toLowerCase(java.util.Locale.ROOT);
        List<SiteNode> out = new ArrayList<>();
        for (SiteView s : all) {
            if (CONTEXT.equals(s.view())) {
                continue;
            }
            if (s.name().contains(term) || s.code().toLowerCase(java.util.Locale.ROOT).contains(lower)) {
                out.add(node(s, Map.of(), bounded, pathOf(byId, s)));
                if (out.size() >= Math.max(1, Math.min(limit, 100))) {
                    break;
                }
            }
        }
        return out;
    }

    /** Parent sites from the root down (visible sites and tree context only). */
    public List<Ref> path(AccessContext ctx, UUID id) {
        Map<String, SiteView> byId = new HashMap<>();
        list(ctx).forEach(s -> byId.put(s.id(), s));
        SiteView s = byId.get(id.toString());
        return s == null ? List.of() : pathOf(byId, s);
    }

    private static List<Ref> pathOf(Map<String, SiteView> byId, SiteView s) {
        List<Ref> path = new ArrayList<>();
        String p = s.parentId();
        Set<String> guard = new java.util.HashSet<>();
        while (p != null && byId.containsKey(p) && guard.add(p)) {
            SiteView a = byId.get(p);
            path.add(0, Ref.of(UUID.fromString(a.id()), a.name()));
            p = a.parentId();
        }
        return path;
    }

    private static SiteNode node(SiteView s, Map<String, Integer> childCounts, Set<String> bounded, List<Ref> path) {
        boolean context = CONTEXT.equals(s.view());
        return new SiteNode(s.id(), s.code(), s.name(), context ? null : s.kind(), s.parentId(), s.view(),
                childCounts.getOrDefault(s.id(), 0), !context && s.location() != null, !context && bounded.contains(s.id()),
                context ? 0 : s.resources().size(), path);
    }

    private Set<String> boundedSites() {
        return new java.util.HashSet<>(jdbc.sql("""
                select s.id::text from site s join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version
                where g.geometry_type <> 'Point'""").query(String.class).list());
    }

    public record SiteInput(String code, String name, String kind, String parentId, String responsibleOrgId, Integer capacity,
                            Location location) {
    }

    @Transactional
    public SiteView create(AccessContext ctx, SiteInput in) {
        validate(in);
        requireFacilityManager(ctx, UUID.fromString(in.responsibleOrgId()));
        UUID id = UUID.randomUUID();
        Instant now = clock.instant();
        try {
            jdbc.sql("""
                    insert into site(id, code, name, kind, parent_id, capacity, lat, lng, created_at)
                    values (:id, :code, :name, :kind, :parent, :cap, :lat, :lng, :now)""")
                    .param("id", id).param("code", in.code().trim()).param("name", in.name().trim()).param("kind", in.kind().trim())
                    .param("parent", in.parentId() == null ? null : UUID.fromString(in.parentId())).param("cap", in.capacity())
                    .param("lat", in.location() == null ? null : in.location().lat())
                    .param("lng", in.location() == null ? null : in.location().lng()).param("now", Db.ts(now)).update();
        } catch (DataAccessException e) {
            throw ApiException.validation("تعذر حفظ الموقع: الرمز مستخدم أو الموقع الأب غير صالح.");
        }
        setResponsibility(id, UUID.fromString(in.responsibleOrgId()), now);
        audit.recordAs(ctx.actor(), "SITE_CREATED", "SITE", id.toString(), in.name(), Map.of("code", in.code()), null);
        return list(ctx).stream().filter(s -> s.id().equals(id.toString())).findFirst().orElseThrow();
    }

    @Transactional
    public SiteView update(AccessContext ctx, UUID id, SiteInput in) {
        validate(in);
        SiteRow current = rows("where s.id = :id", Map.of("id", id)).stream().findFirst().orElseThrow(ApiException::notFound);
        requireFacilityManager(ctx, current.orgId());
        requireFacilityManager(ctx, UUID.fromString(in.responsibleOrgId()));
        Instant now = clock.instant();
        try {
            jdbc.sql("""
                    update site set name = :name, kind = :kind, parent_id = :parent, capacity = :cap, lat = :lat, lng = :lng,
                           version = version + 1 where id = :id""")
                    .param("name", in.name().trim()).param("kind", in.kind().trim())
                    .param("parent", in.parentId() == null ? null : UUID.fromString(in.parentId())).param("cap", in.capacity())
                    .param("lat", in.location() == null ? null : in.location().lat())
                    .param("lng", in.location() == null ? null : in.location().lng()).param("id", id).update();
        } catch (DataAccessException e) {
            if (Db.isCheckViolation(e)) {
                throw ApiException.validation("لا يمكن أن يصبح الموقع تابعاً لأحد فروعه (دورة في شجرة المواقع).");
            }
            throw e;
        }
        UUID newOrg = UUID.fromString(in.responsibleOrgId());
        if (!newOrg.equals(current.orgId())) {
            setResponsibility(id, newOrg, now);
        }
        audit.recordAs(ctx.actor(), "SITE_UPDATED", "SITE", id.toString(), in.name(), Map.of("code", current.code()), null);
        return list(ctx).stream().filter(s -> s.id().equals(id.toString())).findFirst().orElseThrow();
    }

    public record MoveMarkerInput(Location location, String reason) {
    }

    /**
     * Moves (or sets) a site's point marker to a coordinate the facility manager placed on the map or typed, as a
     * direct, audited edit of the site register — the same authority ({@link Permission#MANAGE_FACILITIES} on the
     * responsible organisation) and the same «reason + audit» contract as boundary editing. It never touches the
     * registered boundary, resources, responsibility or any reservation; selecting or panning the map writes nothing,
     * only this call does. A retired site is refused.
     */
    @Transactional
    public SiteView moveMarker(AccessContext ctx, UUID id, MoveMarkerInput in) {
        if (in == null || in.location() == null) {
            throw ApiException.validation("حدد موقع العلامة الجديد (خط العرض وخط الطول)، أو انقل العلامة على الخريطة.");
        }
        double lat = in.location().lat();
        double lng = in.location().lng();
        if (!Double.isFinite(lat) || !Double.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            throw ApiException.validation("إحداثيات غير صالحة: خط العرض بين −90 و90، وخط الطول بين −180 و180.");
        }
        if (in.reason() == null || in.reason().trim().length() < 5) {
            throw ApiException.validation("اكتب سبب نقل العلامة (5 أحرف على الأقل).");
        }
        SiteRow current = rows("where s.id = :id", Map.of("id", id)).stream().findFirst().orElseThrow(ApiException::notFound);
        requireFacilityManager(ctx, current.orgId());
        if (!"ACTIVE".equals(current.status())) {
            throw ApiException.validation("الموقع موقوف؛ لا تُحدَّث علامته.");
        }
        double nlat = Math.round(lat * 1e7) / 1e7;
        double nlng = Math.round(lng * 1e7) / 1e7;
        jdbc.sql("update site set lat = :lat, lng = :lng, version = version + 1 where id = :id")
                .param("lat", nlat).param("lng", nlng).param("id", id).update();
        Map<String, Object> detail = new LinkedHashMap<>();
        if (current.lat() != null) {
            detail.put("fromLat", current.lat());
            detail.put("fromLng", current.lng());
        }
        detail.put("toLat", nlat);
        detail.put("toLng", nlng);
        audit.recordAs(ctx.actor(), current.lat() == null ? "SITE_MARKER_SET" : "SITE_MARKER_MOVED", "SITE", id.toString(),
                current.name(), detail, in.reason().trim());
        return list(ctx).stream().filter(s -> s.id().equals(id.toString())).findFirst().orElseThrow();
    }

    @Transactional
    public void retire(AccessContext ctx, UUID id) {
        SiteRow current = rows("where s.id = :id", Map.of("id", id)).stream().findFirst().orElseThrow(ApiException::notFound);
        requireFacilityManager(ctx, current.orgId());
        int n = jdbc.sql("update site set status = 'RETIRED', version = version + 1 where id = :id and status = 'ACTIVE'")
                .param("id", id).update();
        if (n == 0) {
            throw ApiException.notFound();
        }
        jdbc.sql("update resource set status = 'RETIRED' where site_id = :id").param("id", id).update();
        audit.recordAs(ctx.actor(), "SITE_RETIRED", "SITE", id.toString(), null, Map.of(), null);
    }

    public record ResourceInput(String siteId, String code, String name, String kind, String policy, String parentResourceId,
                                Integer handoverMinutes, Integer capacity, Boolean childBlocking, Integer sharedLimit) {
    }

    @Transactional
    public ResourceView createResource(AccessContext ctx, ResourceInput in) {
        ctx.require(Permission.MANAGE_FACILITIES);
        if (in.siteId() == null || in.code() == null || in.code().isBlank() || in.name() == null || in.name().isBlank()
                || !List.of("EXCLUSIVE", "SHARED").contains(in.policy())) {
            throw ApiException.validation("أكمل بيانات المورد: الموقع والرمز والاسم وسياسة الحجز.");
        }
        SiteRow site = rows("where s.id = :id", Map.of("id", UUID.fromString(in.siteId()))).stream().findFirst()
                .orElseThrow(() -> ApiException.validation("الموقع غير موجود."));
        requireFacilityManager(ctx, site.orgId());
        checkSharedLimit(in.policy(), in.sharedLimit());
        if (in.handoverMinutes() != null && (in.handoverMinutes() < 0 || in.handoverMinutes() > 10080)) {
            throw ApiException.validation("فترة التسليم بين 0 و10080 دقيقة.");
        }
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("""
                    insert into resource(id, site_id, code, name, kind, policy, parent_resource_id, handover_minutes, capacity,
                                         child_blocking, shared_limit)
                    values (:id, :site, :code, :name, :kind, :policy, :parent, :handover, :cap, :blocks, :limit)""")
                    .param("id", id).param("site", UUID.fromString(in.siteId())).param("code", in.code().trim())
                    .param("name", in.name().trim()).param("kind", in.kind() == null ? "مورد" : in.kind())
                    .param("policy", in.policy())
                    .param("parent", in.parentResourceId() == null ? null : UUID.fromString(in.parentResourceId()))
                    .param("handover", in.handoverMinutes() == null ? 0 : in.handoverMinutes()).param("cap", in.capacity())
                    .param("blocks", !Boolean.FALSE.equals(in.childBlocking())).param("limit", in.sharedLimit()).update();
        } catch (DataAccessException e) {
            throw ApiException.validation("تعذر حفظ المورد: الرمز مستخدم أو المورد الأب غير صالح.");
        }
        audit.recordAs(ctx.actor(), "RESOURCE_CREATED", "RESOURCE", id.toString(), in.name(), Map.of("code", in.code()), null);
        return resourcesBySite().values().stream().flatMap(List::stream).filter(r -> r.id().equals(id.toString()))
                .findFirst().orElseThrow();
    }

    public record ResourceUpdate(String name, String kind, Integer handoverMinutes, Boolean childBlocking, Integer sharedLimit) {
    }

    /**
     * Changes a resource's name, kind, handover time, relation to its sub-resources or shared-use limit. Locks of the
     * reservations the change can affect are rebuilt in the same transaction, so a rule that would make existing
     * approved bookings overlap, or a limit below the uses already approved, is refused and nothing changes.
     */
    @Transactional
    public ResourceView updateResource(AccessContext ctx, UUID id, ResourceUpdate in) {
        ctx.require(Permission.MANAGE_FACILITIES);
        Map<String, Object> cur = jdbc.sql("""
                select r.*, sr.organization_id from resource r
                left join site_responsibility sr on sr.site_id = r.site_id and sr.valid_to is null
                where r.id = :id and r.status = 'ACTIVE' for update of r""")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        requireFacilityManager(ctx, (UUID) cur.get("organization_id"));
        if (in == null) {
            throw ApiException.validation("لا توجد تغييرات.");
        }
        String name = in.name() == null || in.name().isBlank() ? (String) cur.get("name") : in.name().trim();
        String kind = in.kind() == null || in.kind().isBlank() ? (String) cur.get("kind") : in.kind().trim();
        int handover = in.handoverMinutes() == null ? ((Number) cur.get("handover_minutes")).intValue() : in.handoverMinutes();
        if (handover < 0 || handover > 10080) {
            throw ApiException.validation("فترة التسليم بين 0 و10080 دقيقة.");
        }
        boolean blocks = in.childBlocking() == null ? (Boolean) cur.get("child_blocking") : in.childBlocking();
        Integer limit = in.sharedLimit() == null ? null : in.sharedLimit() == 0 ? null : in.sharedLimit();
        checkSharedLimit((String) cur.get("policy"), limit);
        if (limit != null) {
            int peak = reservations.sharedPeak(id, clock.instant());
            if (peak > limit) {
                throw ApiException.validation("الحد الجديد (" + limit + ") أقل من عدد الاستخدامات المعتمدة المتزامنة حالياً أو لاحقاً ("
                        + peak + "). خفّض الحد بعد انتهائها أو اختر حداً أعلى.");
            }
        }
        jdbc.sql("""
                update resource set name = :n, kind = :k, handover_minutes = :h, child_blocking = :b, shared_limit = :l
                where id = :id""")
                .param("n", name).param("k", kind).param("h", handover).param("b", blocks).param("l", limit).param("id", id).update();
        boolean relationChanged = blocks != (Boolean) cur.get("child_blocking")
                || handover != ((Number) cur.get("handover_minutes")).intValue();
        int relocked = 0;
        if (relationChanged) {
            try {
                relocked = reservations.relock(id);
            } catch (ApiException e) {
                if (e.code() == ErrorCode.RESERVATION_CONFLICT) {
                    throw new ApiException(ErrorCode.RESERVATION_CONFLICT, "لا يمكن تطبيق التغيير: توجد حجوزات معتمدة على «" + name
                            + "» أو موارده الفرعية أو الأعلى منه تتداخل وفق القاعدة الجديدة. لم يتغير شيء.", e.details());
                }
                throw e;
            }
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("childBlocking", blocks);
        detail.put("sharedLimit", limit);
        detail.put("handoverMinutes", handover);
        detail.put("relockedReservations", relocked);
        audit.recordAs(ctx.actor(), "RESOURCE_UPDATED", "RESOURCE", id.toString(), name, detail, null);
        return resourcesBySite().values().stream().flatMap(List::stream).filter(r -> r.id().equals(id.toString()))
                .findFirst().orElseThrow();
    }

    private static void checkSharedLimit(String policy, Integer limit) {
        if (limit != null && !"SHARED".equals(policy)) {
            throw ApiException.validation("حد الاستخدام المتزامن خاص بالموارد المشتركة.");
        }
        if (limit != null && (limit < 1 || limit > 10000)) {
            throw ApiException.validation("حد الاستخدام المتزامن بين 1 و10000، أو اتركه فارغاً لعدم التقييد.");
        }
    }

    /** MANAGE_FACILITIES over the administering organisation; configuration rights alone are not enough. */
    static void requireFacilityManager(AccessContext ctx, UUID orgId) {
        boolean allowed = orgId == null
                ? ctx.canEverywhere(Permission.MANAGE_FACILITIES)
                : ctx.canFor(Permission.MANAGE_FACILITIES, orgId);
        if (!allowed) {
            throw ApiException.forbidden("إدارة المرافق تتطلب صلاحية إدارة المرافق على الجهة المسؤولة.");
        }
    }

    private void validate(SiteInput in) {
        if (in == null || in.code() == null || in.code().isBlank() || in.name() == null || in.name().isBlank()
                || in.kind() == null || in.kind().isBlank() || in.responsibleOrgId() == null) {
            throw ApiException.validation("أكمل رمز الموقع واسمه وتصنيفه والجهة المسؤولة.");
        }
        if (in.location() != null && (Math.abs(in.location().lat()) > 90 || Math.abs(in.location().lng()) > 180)) {
            throw ApiException.validation("إحداثيات غير صالحة.");
        }
    }

    private void setResponsibility(UUID siteId, UUID orgId, Instant now) {
        jdbc.sql("update site_responsibility set valid_to = :now where site_id = :s and valid_to is null")
                .param("now", Db.ts(now)).param("s", siteId).update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, :now)")
                .param("id", UUID.randomUUID()).param("s", siteId).param("o", orgId).param("now", Db.ts(now)).update();
    }
}
