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
import ae.mover.common.Json;
import ae.mover.common.Ref;

/** Permanent sites and reservable resources. Sites are never destructively deleted; they are retired. */
@Service
public class SiteService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;

    public SiteService(JdbcClient jdbc, Json json, Clock clock, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
    }

    public record Location(double lat, double lng) {
    }

    public record ResourceView(String id, String code, String name, String kind, String policy, String parentResourceId,
                               int handoverMinutes, Integer capacity, String siteId, String label) {
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

    public record GeometryView(int version, String crs, String source, String validFrom, JsonNode geojson) {
    }

    /** Site fields at top level plus geometry and occupancy history (matches the documented contract). */
    public Map<String, Object> detailView(AccessContext ctx, UUID id) {
        SiteDetail d = detail(ctx, id);
        Map<String, Object> out = json.map(d.site());
        out.put("geometry", d.geometry());
        out.put("occupancy", d.occupancy());
        return out;
    }

    public record SiteDetail(SiteView site, GeometryView geometry, List<OccupancyItem> occupancy) {
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
                    primary ? rs.getString("site_name") : rs.getString("site_name") + " — " + rs.getString("name")));
            return null;
        }).list();
        return out;
    }

    /** Visible sites. Ancestors of visible sites are included as summary context (name only). */
    public List<SiteView> list(AccessContext ctx) {
        List<SiteRow> all = rows("", Map.of());
        Map<UUID, SiteRow> byId = new HashMap<>();
        all.forEach(s -> byId.put(s.id(), s));
        Map<UUID, ViewLevel> levels = new LinkedHashMap<>();
        for (SiteRow s : all) {
            ViewLevel v = ctx.siteView(s.id(), Set.of(), s.orgId());
            if (v != ViewLevel.NONE) {
                levels.put(s.id(), v);
                UUID p = s.parentId();
                while (p != null && !levels.containsKey(p)) {
                    levels.put(p, ViewLevel.SUMMARY);
                    p = byId.get(p) == null ? null : byId.get(p).parentId();
                }
            }
        }
        Map<UUID, List<ResourceView>> resources = resourcesBySite();
        List<SiteView> out = new ArrayList<>();
        for (SiteRow s : all) {
            ViewLevel v = levels.get(s.id());
            if (v != null) {
                out.add(view(s, v, resources.getOrDefault(s.id(), List.of())));
            }
        }
        return out;
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
        GeometryView geometry = jdbc.sql("""
                select version, crs, source, valid_from, geojson::text as g from site_geometry_version
                where site_id = :id and valid_to is null order by version desc limit 1""")
                .param("id", id).query((rs, n) -> new GeometryView(rs.getInt("version"), rs.getString("crs"),
                        rs.getString("source"), Db.iso(rs, "valid_from"), json.tree(rs.getString("g")))).optional().orElse(null);
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
        return new SiteDetail(view(s, v, resourcesBySite().getOrDefault(s.id(), List.of())), full ? geometry : null, occupancy);
    }

    public record SiteInput(String code, String name, String kind, String parentId, String responsibleOrgId, Integer capacity,
                            Location location) {
    }

    @Transactional
    public SiteView create(AccessContext ctx, SiteInput in) {
        ctx.require(Permission.CONFIGURE);
        validate(in);
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
        if (in.location() != null) {
            addGeometry(id, in.location(), now);
        }
        audit.recordAs(ctx.actor(), "SITE_CREATED", "SITE", id.toString(), in.name(), Map.of("code", in.code()), null);
        return list(ctx).stream().filter(s -> s.id().equals(id.toString())).findFirst().orElseThrow();
    }

    @Transactional
    public SiteView update(AccessContext ctx, UUID id, SiteInput in) {
        ctx.require(Permission.CONFIGURE);
        validate(in);
        SiteRow current = rows("where s.id = :id", Map.of("id", id)).stream().findFirst().orElseThrow(ApiException::notFound);
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
        if (in.location() != null && (current.lat() == null || current.lat() != in.location().lat() || current.lng() != in.location().lng())) {
            addGeometry(id, in.location(), now);
        }
        audit.recordAs(ctx.actor(), "SITE_UPDATED", "SITE", id.toString(), in.name(), Map.of("code", current.code()), null);
        return list(ctx).stream().filter(s -> s.id().equals(id.toString())).findFirst().orElseThrow();
    }

    @Transactional
    public void retire(AccessContext ctx, UUID id) {
        ctx.require(Permission.CONFIGURE);
        int n = jdbc.sql("update site set status = 'RETIRED', version = version + 1 where id = :id and status = 'ACTIVE'")
                .param("id", id).update();
        if (n == 0) {
            throw ApiException.notFound();
        }
        jdbc.sql("update resource set status = 'RETIRED' where site_id = :id").param("id", id).update();
        audit.recordAs(ctx.actor(), "SITE_RETIRED", "SITE", id.toString(), null, Map.of(), null);
    }

    public record ResourceInput(String siteId, String code, String name, String kind, String policy, String parentResourceId,
                                Integer handoverMinutes, Integer capacity) {
    }

    @Transactional
    public ResourceView createResource(AccessContext ctx, ResourceInput in) {
        ctx.require(Permission.CONFIGURE);
        if (in.siteId() == null || in.code() == null || in.code().isBlank() || in.name() == null || in.name().isBlank()
                || !List.of("EXCLUSIVE", "SHARED").contains(in.policy())) {
            throw ApiException.validation("أكمل بيانات المورد: الموقع والرمز والاسم وسياسة الحجز.");
        }
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("""
                    insert into resource(id, site_id, code, name, kind, policy, parent_resource_id, handover_minutes, capacity)
                    values (:id, :site, :code, :name, :kind, :policy, :parent, :handover, :cap)""")
                    .param("id", id).param("site", UUID.fromString(in.siteId())).param("code", in.code().trim())
                    .param("name", in.name().trim()).param("kind", in.kind() == null ? "مورد" : in.kind())
                    .param("policy", in.policy())
                    .param("parent", in.parentResourceId() == null ? null : UUID.fromString(in.parentResourceId()))
                    .param("handover", in.handoverMinutes() == null ? 0 : in.handoverMinutes()).param("cap", in.capacity()).update();
        } catch (DataAccessException e) {
            throw ApiException.validation("تعذر حفظ المورد: الرمز مستخدم أو المورد الأب غير صالح.");
        }
        audit.recordAs(ctx.actor(), "RESOURCE_CREATED", "RESOURCE", id.toString(), in.name(), Map.of("code", in.code()), null);
        return resourcesBySite().values().stream().flatMap(List::stream).filter(r -> r.id().equals(id.toString()))
                .findFirst().orElseThrow();
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

    private void addGeometry(UUID siteId, Location loc, Instant now) {
        int next = jdbc.sql("select coalesce(max(version), 0) + 1 from site_geometry_version where site_id = :s")
                .param("s", siteId).query(Integer.class).single();
        // Previous geometry versions are kept untouched (append-only); the latest version is the current one.
        Map<String, Object> geo = Map.of("type", "Point", "coordinates", List.of(loc.lng(), loc.lat()));
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from)
                values (:id, :s, :v, cast(:g as jsonb), 'EPSG:4326', 'إدخال إداري', :now)""")
                .param("id", UUID.randomUUID()).param("s", siteId).param("v", next).param("g", json.write(geo))
                .param("now", Db.ts(now)).update();
    }
}
