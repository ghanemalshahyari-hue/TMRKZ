package ae.mover.requests;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.RequestScope;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.common.Ref;

/**
 * The proposal of a relocation request (ADR-023): which organisation moves (alone or with its branches), from which
 * registered site, to which proposed location drawn on the map. The proposal is part of the request — edited with the
 * draft, copied into each submitted revision, reviewed and approved with it — and never changes the site register.
 */
@Service
public class RelocationService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AccessService access;
    private final AuditService audit;

    public RelocationService(JdbcClient jdbc, Json json, Clock clock, AccessService access, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.access = access;
        this.audit = audit;
    }

    public record Input(String organizationId, Boolean includeDescendants, String fromSiteId, String proposedName, Map<String, Object> geometry) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record View(Ref organization, boolean includeDescendants, Ref fromSite, String proposedName, JsonNode geometry,
                       Double areaM2, double[] centroid, String completedAt) {
    }

    public View get(AccessContext ctx, UUID requestId) {
        RequestScope scope = access.requestScope(requestId);
        if (scope == null || ctx.viewLevel(scope) == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        if (ctx.viewLevel(scope) != ViewLevel.FULL) {
            throw ApiException.forbidden("تفاصيل النقل جزء من محتوى الطلب الكامل.");
        }
        ctx.confirmView(scope, ViewLevel.FULL);
        return find(requestId);
    }

    View find(UUID requestId) {
        return jdbc.sql("""
                select r.*, o.name as org_name, s.name as site_name, r.proposed_geojson::text as gj,
                       ST_X(ST_Centroid(r.proposed_geom)) as cx, ST_Y(ST_Centroid(r.proposed_geom)) as cy
                from request_relocation r join organization o on o.id = r.organization_id join site s on s.id = r.from_site_id
                where r.request_id = :id""").param("id", requestId)
                .query((rs, n) -> new View(Ref.of(Db.uuid(rs, "organization_id"), rs.getString("org_name")),
                        rs.getBoolean("include_descendants"), Ref.of(Db.uuid(rs, "from_site_id"), rs.getString("site_name")),
                        rs.getString("proposed_name"), json.tree(rs.getString("gj")), (Double) rs.getObject("area_m2"),
                        new double[] {rs.getDouble("cy"), rs.getDouble("cx")}, Db.iso(rs, "completed_at")))
                .optional().orElse(null);
    }

    /** Saves the proposal of a draft or returned request; only its creator, under the same rules as the draft. */
    @Transactional
    public View save(AccessContext ctx, UUID requestId, Input in) {
        Map<String, Object> r = jdbc.sql("""
                select q.status, q.created_by, q.owner_org_id, t.kind from request q join request_type t on t.code = q.type_code
                where q.id = :id for update of q""").param("id", requestId).query().listOfRows().stream().findFirst()
                .orElseThrow(ApiException::notFound);
        if (!ctx.personId().equals(r.get("created_by"))) {
            throw ApiException.notFound();
        }
        if (!"RELOCATION".equals(r.get("kind"))) {
            throw ApiException.validation("هذا الطلب ليس طلب نقل مقر.");
        }
        String status = (String) r.get("status");
        if (!Set.of("DRAFT", "RETURNED").contains(status) || !ctx.mayModify(ctx.personId(), (UUID) r.get("owner_org_id"), status)) {
            throw ApiException.validation("لا يمكن تعديل تفاصيل النقل في حالة الطلب الحالية.");
        }
        if (in == null) {
            throw ApiException.validation("تفاصيل النقل مطلوبة.");
        }
        UUID org = uuid(in.organizationId(), "الجهة المنقولة");
        if (!ctx.canFor(Permission.CREATE, org)) {
            throw ApiException.forbidden("لا تملك تقديم طلب نقل باسم هذه الجهة.");
        }
        UUID from = uuid(in.fromSiteId(), "الموقع الحالي");
        UUID responsible = jdbc.sql("select organization_id from site_responsibility where site_id = :s and valid_to is null")
                .param("s", from).query(UUID.class).optional().orElse(null);
        if (ctx.siteView(from, Set.of(), responsible) == ViewLevel.NONE) {
            throw ApiException.validation("الموقع الحالي غير موجود.");
        }
        String name = in.proposedName() == null ? "" : in.proposedName().trim();
        if (name.length() < 2 || name.length() > 120) {
            throw ApiException.validation("اكتب اسماً للموقع المقترح (2–120 حرفاً).");
        }
        if (in.geometry() == null) {
            throw ApiException.validation("ارسم الموقع المقترح على الخريطة.");
        }
        String gj = json.write(in.geometry());
        Map<String, Object> check = jdbc.sql("""
                with g as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) as g)
                select GeometryType(g) as t, ST_IsValid(g) as ok, ST_IsValidReason(g) as why, ST_Area(g::geography) as area,
                       ST_XMin(g) as x0, ST_YMin(g) as y0, ST_XMax(g) as x1, ST_YMax(g) as y1 from g""")
                .param("g", gj).query().listOfRows().stream().findFirst().orElseThrow();
        String type = (String) check.get("t");
        if (!Set.of("POLYGON", "MULTIPOLYGON", "POINT").contains(type)) {
            throw ApiException.validation("الموقع المقترح يُرسم مضلعاً أو مستطيلاً أو يُحدد بنقطة.");
        }
        if (!Boolean.TRUE.equals(check.get("ok"))) {
            throw ApiException.validation("شكل الموقع المقترح غير صالح: " + check.get("why"));
        }
        if (((Number) check.get("x0")).doubleValue() < -180 || ((Number) check.get("x1")).doubleValue() > 180
                || ((Number) check.get("y0")).doubleValue() < -90 || ((Number) check.get("y1")).doubleValue() > 90) {
            throw ApiException.validation("إحداثيات الموقع المقترح خارج النطاق.");
        }
        double area = ((Number) check.get("area")).doubleValue();
        jdbc.sql("""
                insert into request_relocation(request_id, organization_id, include_descendants, from_site_id, proposed_name,
                    proposed_geojson, proposed_geom, area_m2, updated_by, updated_at)
                values (:id, :org, :desc, :from, :name, cast(:gj as jsonb), ST_SetSRID(ST_GeomFromGeoJSON(:gj), 4326), :area, :by, :now)
                on conflict (request_id) do update set organization_id = :org, include_descendants = :desc, from_site_id = :from,
                    proposed_name = :name, proposed_geojson = cast(:gj as jsonb), proposed_geom = ST_SetSRID(ST_GeomFromGeoJSON(:gj), 4326),
                    area_m2 = :area, updated_by = :by, updated_at = :now""")
                .param("id", requestId).param("org", org).param("desc", Boolean.TRUE.equals(in.includeDescendants()))
                .param("from", from).param("name", name).param("gj", gj).param("area", "POINT".equals(type) ? null : area)
                .param("by", ctx.personId()).param("now", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), "RELOCATION_PROPOSAL_SAVED", "REQUEST", requestId.toString(), name, Map.of(), null);
        return find(requestId);
    }

    /** Part of the submitted revision: the proposal exactly as reviewed (null when the request has none). */
    Map<String, Object> snapshot(UUID requestId) {
        View v = find(requestId);
        if (v == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("organizationId", v.organization().id());
        m.put("includeDescendants", v.includeDescendants());
        m.put("fromSiteId", v.fromSite().id());
        m.put("proposedName", v.proposedName());
        m.put("geometry", v.geometry());
        m.put("areaM2", v.areaM2() == null ? null : Math.round(v.areaM2()));
        return m;
    }

    /** Administrative completion of an approved relocation: the move is recorded; the site register is untouched. */
    public void complete(UUID requestId) {
        jdbc.sql("update request_relocation set completed_at = :now where request_id = :id")
                .param("now", Db.ts(clock.instant())).param("id", requestId).update();
    }

    private static UUID uuid(String v, String label) {
        try {
            return UUID.fromString(v);
        } catch (RuntimeException e) {
            throw ApiException.validation("معرف غير صالح في «" + label + "».");
        }
    }
}
