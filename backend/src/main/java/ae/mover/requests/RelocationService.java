package ae.mover.requests;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
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
import ae.mover.common.Times;
import ae.mover.facilities.PlacementService;
import ae.mover.org.OrganizationService;

/**
 * The proposal of a relocation request (ADR-023): which organisation moves (alone or with its branches), from which
 * registered site, to which proposed location drawn on the map. The proposal is part of the request — edited with the
 * draft, copied into each submitted revision, reviewed and approved with it — and never changes the site register.
 * Stationing details (ADR-025) add the kind, level, duration, the organisations covered and the checked distance.
 */
@Service
public class RelocationService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AccessService access;
    private final AuditService audit;
    private final PlacementService placement;
    private final OrganizationService orgs;

    public RelocationService(JdbcClient jdbc, Json json, Clock clock, AccessService access, AuditService audit,
                             PlacementService placement, OrganizationService orgs) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.access = access;
        this.audit = audit;
        this.placement = placement;
        this.orgs = orgs;
    }

    /**
     * The proposal as saved from the map. The stationing fields are optional, so a client that sends only the
     * organisation, the current site, the name and the drawn location keeps working unchanged.
     */
    public record Input(String organizationId, Boolean includeDescendants, String fromSiteId, String proposedName, Map<String, Object> geometry,
                        String action, String stationLevel, Boolean temporary, String temporaryEnd, String targetSiteId,
                        List<String> includedOrgIds) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record View(Ref organization, boolean includeDescendants, Ref fromSite, String proposedName, JsonNode geometry,
                       Double areaM2, double[] centroid, String completedAt, String action, String stationLevel, boolean temporary,
                       String temporaryEnd, Ref targetSite, List<Ref> includedOrgs, Double distanceM, String checkStatus,
                       String ruleName) {
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
                       ST_X(ST_Centroid(r.proposed_geom)) as cx, ST_Y(ST_Centroid(r.proposed_geom)) as cy,
                       t.name as target_name, pr.name as rule_name
                from request_relocation r join organization o on o.id = r.organization_id join site s on s.id = r.from_site_id
                left join site t on t.id = r.target_site_id left join placement_rule pr on pr.id = r.rule_id
                where r.request_id = :id""").param("id", requestId)
                .query((rs, n) -> new View(Ref.of(Db.uuid(rs, "organization_id"), rs.getString("org_name")),
                        rs.getBoolean("include_descendants"), Ref.of(Db.uuid(rs, "from_site_id"), rs.getString("site_name")),
                        rs.getString("proposed_name"), json.tree(rs.getString("gj")), (Double) rs.getObject("area_m2"),
                        new double[] {rs.getDouble("cy"), rs.getDouble("cx")}, Db.iso(rs, "completed_at"),
                        rs.getString("action"), rs.getString("station_level"), rs.getBoolean("temporary"),
                        Db.iso(rs, "temporary_end"), Ref.of(Db.uuid(rs, "target_site_id"), rs.getString("target_name")),
                        includedOrgs(requestId), (Double) rs.getObject("distance_m"), rs.getString("check_status"),
                        rs.getString("rule_name")))
                .optional().orElse(null);
    }

    private List<Ref> includedOrgs(UUID requestId) {
        return jdbc.sql("""
                select o.id, o.name from request_relocation r join organization o on o.id = any(r.included_org_ids)
                where r.request_id = :id order by o.code""").param("id", requestId)
                .query((rs, n) -> Ref.of(Db.uuid(rs, "id"), rs.getString("name"))).list();
    }

    /** Saves the proposal of a draft or returned request; only its creator, under the same rules as the draft. */
    @Transactional
    public View save(AccessContext ctx, UUID requestId, Input in) {
        Map<String, Object> r = jdbc.sql("""
                select q.status, q.created_by, q.owner_org_id, q.period_start, t.kind from request q join request_type t on t.code = q.type_code
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

        // stationing details: kind, level, duration, covered organisations and an optional registered site
        String action = in.action() == null || in.action().isBlank() ? "RELOCATE" : in.action();
        if (!PlacementService.ACTIONS.contains(action)) {
            throw ApiException.validation("نوع الإجراء غير معروف.");
        }
        if ("WORK_AREA".equals(action) && "POINT".equals(type)) {
            throw ApiException.validation("منطقة العمل المؤقتة تُرسم حدوداً على الخريطة.");
        }
        String level = in.stationLevel() == null || in.stationLevel().isBlank() ? null : in.stationLevel();
        if (level != null && !PlacementService.LEVELS.contains(level)) {
            throw ApiException.validation("مستوى التمركز غير معروف.");
        }
        boolean temporary = Boolean.TRUE.equals(in.temporary()) || "WORK_AREA".equals(action);
        Instant start = r.get("period_start") == null ? clock.instant() : Db.toInstant(r.get("period_start"));
        Instant tempEnd = temporary ? Times.parse(in.temporaryEnd(), "temporaryEnd") : null;
        if (temporary && (tempEnd == null || !tempEnd.isAfter(start))) {
            throw ApiException.validation("حدد نهاية المدة المؤقتة بعد تاريخ البداية.");
        }
        UUID target = in.targetSiteId() == null || in.targetSiteId().isBlank() ? null : uuid(in.targetSiteId(), "الموقع المسجل");
        Set<UUID> branch = orgs.requireVisibleBranch(ctx, org, true);
        List<UUID> included = new ArrayList<>();
        if (in.includedOrgIds() != null) {
            for (String v : in.includedOrgIds()) {
                UUID u = uuid(v, "الجهات المشمولة");
                if (!branch.contains(u)) {
                    throw ApiException.validation("الجهات المشمولة يجب أن تكون الجهة المختارة أو من فروعها.");
                }
                if (!included.contains(u)) {
                    included.add(u);
                }
            }
        }
        PlacementService.Check result = placement.evaluate(ctx, action, org, included, from, level, gj, target, start, tempEnd, requestId);

        jdbc.sql("""
                insert into request_relocation(request_id, organization_id, include_descendants, from_site_id, proposed_name,
                    proposed_geojson, proposed_geom, area_m2, updated_by, updated_at, action, station_level, temporary,
                    temporary_end, target_site_id, included_org_ids, distance_m, rule_id, rule_version, check_status)
                values (:id, :org, :desc, :from, :name, cast(:gj as jsonb), ST_SetSRID(ST_GeomFromGeoJSON(:gj), 4326), :area, :by, :now,
                    :action, :level, :temp, :tend, :target, string_to_array(:inc, ',')::uuid[], :dist, :rule, :rv, :st)
                on conflict (request_id) do update set organization_id = :org, include_descendants = :desc, from_site_id = :from,
                    proposed_name = :name, proposed_geojson = cast(:gj as jsonb), proposed_geom = ST_SetSRID(ST_GeomFromGeoJSON(:gj), 4326),
                    area_m2 = :area, updated_by = :by, updated_at = :now, action = :action, station_level = :level,
                    temporary = :temp, temporary_end = :tend, target_site_id = :target,
                    included_org_ids = string_to_array(:inc, ',')::uuid[], distance_m = :dist, rule_id = :rule,
                    rule_version = :rv, check_status = :st""")
                .param("id", requestId).param("org", org).param("desc", Boolean.TRUE.equals(in.includeDescendants()))
                .param("from", from).param("name", name).param("gj", gj).param("area", "POINT".equals(type) ? null : area)
                .param("by", ctx.personId()).param("now", Db.ts(clock.instant()))
                .param("action", action).param("level", level).param("temp", temporary).param("tend", Db.ts(tempEnd))
                .param("target", target).param("inc", Db.ids(included)).param("dist", result.distanceM())
                .param("rule", result.rule() == null ? null : UUID.fromString(result.rule().id()))
                .param("rv", result.rule() == null ? null : result.rule().version()).param("st", result.status()).update();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("action", action);
        detail.put("stationLevel", level);
        detail.put("temporary", temporary);
        detail.put("distanceM", result.distanceM());
        detail.put("check", result.status());
        audit.recordAs(ctx.actor(), "RELOCATION_PROPOSAL_SAVED", "REQUEST", requestId.toString(), name, detail, null);
        return find(requestId);
    }

    /**
     * Server re-check before submission and approval: the saved proposal against the rule and the occupancy in force
     * now, for the request period. Null when the request has no proposal.
     */
    public PlacementService.Check recheck(UUID requestId, Instant start) {
        Map<String, Object> r = jdbc.sql("""
                select organization_id, from_site_id, action, station_level, temporary_end, target_site_id,
                       array_to_string(included_org_ids, ',') as inc, proposed_geojson::text as gj
                from request_relocation where request_id = :id""").param("id", requestId).query().listOfRows().stream().findFirst()
                .orElse(null);
        if (r == null) {
            return null;
        }
        List<UUID> included = new ArrayList<>();
        String inc = (String) r.get("inc");
        if (inc != null && !inc.isBlank()) {
            for (String v : inc.split(",")) {
                included.add(UUID.fromString(v));
            }
        }
        return placement.evaluate(null, (String) r.get("action"), (UUID) r.get("organization_id"), included,
                (UUID) r.get("from_site_id"), (String) r.get("station_level"), (String) r.get("gj"), (UUID) r.get("target_site_id"),
                start == null ? clock.instant() : start, Db.toInstant(r.get("temporary_end")), requestId);
    }

    /** End of a temporary stationing (null when permanent or when the request has no proposal). */
    public Instant temporaryEnd(UUID requestId) {
        return jdbc.sql("select temporary_end from request_relocation where request_id = :id").param("id", requestId).query()
                .listOfRows().stream().findFirst().map(m -> Db.toInstant(m.get("temporary_end"))).orElse(null);
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
        m.put("action", v.action());
        m.put("stationLevel", v.stationLevel());
        m.put("temporary", v.temporary());
        m.put("temporaryEnd", v.temporaryEnd());
        m.put("targetSiteId", v.targetSite() == null ? null : v.targetSite().id());
        m.put("includedOrgIds", v.includedOrgs().stream().map(Ref::id).toList());
        m.put("distanceM", v.distanceM() == null ? null : Math.round(v.distanceM()));
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
