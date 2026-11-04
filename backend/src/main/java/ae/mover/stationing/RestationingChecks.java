package ae.mover.stationing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.stationing.DeploymentRules.LegCheck;
import ae.mover.stationing.DeploymentRules.LegStatus;
import ae.mover.stationing.RestationingContent.OccupantDecision;
import ae.mover.stationing.RouteDerivation.CrossBranchInclusion;
import ae.mover.stationing.RouteDerivation.RouteStage;
import ae.mover.stationing.TerrainClassifier.TerrainAssessment;
import ae.mover.stationing.TerrainRule.TerrainDecision;

/**
 * Everything a re-stationing request must satisfy before it is submitted (Model V3 §1, §4): validation against the
 * administrator's policy version, never a recommendation. Occupied geography comes from authoritative records only —
 * the stationing of units that stay and active reservations — and a site every stationed unit leaves is not a conflict;
 * a site link never occupies (O-15). Deployment distances are measured centre to centre (O-04) with the terrain
 * allowance on the maximum (O-06); occupied ground under a deployment area is a hard block (O-08).
 */
@Component
public class RestationingChecks {

    private static final String GEOM = "ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)";

    /** One deployment leg: site → primary, primary → alternative. */
    public record Leg(String leg, String label, LegCheck check, TerrainAssessment terrain, List<String> conflicts) {
    }

    /** A unit of another branch stationed at an affected site, with whether the requester's branch must decide it. */
    public record Occupant(UUID unit, String name, UUID siteId, String siteName, boolean decisionRequired, String decision) {
    }

    public record Result(List<String> problems, Double siteAreaM2, double maxFootprintAreaM2, List<String> siteConflicts,
                         List<Leg> legs, List<Occupant> otherBranch, List<RouteStage> route, boolean needsDistanceException,
                         Map<UUID, UUID> currentSites) {
        public boolean ok() {
            return problems.isEmpty();
        }
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final GeoMeasure geo;
    private final TerrainClassifier terrain;
    private final OrgHierarchy hierarchy;

    public RestationingChecks(JdbcClient jdbc, Json json, GeoMeasure geo, TerrainClassifier terrain, OrgHierarchy hierarchy) {
        this.jdbc = jdbc;
        this.json = json;
        this.geo = geo;
        this.terrain = terrain;
        this.hierarchy = hierarchy;
    }

    public Result evaluate(UUID requestingUnit, RestationingContent c, StationingPolicy policy, int policyVersion, Instant now) {
        List<String> problems = new ArrayList<>();
        List<OrgUnit> path = hierarchy.path(requestingUnit);
        if (path.isEmpty()) {
            throw ApiException.validation("الوحدة الطالبة غير موجودة.");
        }
        // units: explicit, inside the requesting unit's branch unless explicitly included (O-03)
        if (c.scope().isEmpty()) {
            problems.add("لم تُحدد أي وحدة تنتقل.");
        }
        Map<UUID, String> names = names(c.scope());
        List<UUID> unknown = c.scope().stream().filter(u -> !names.containsKey(u)).toList();
        if (!unknown.isEmpty()) {
            problems.add("وحدات غير موجودة أو موقوفة في الطلب: " + unknown.size());
        }
        List<UUID> outside = c.scope().stream().filter(u -> names.containsKey(u) && !under(u, requestingUnit)).toList();
        List<UUID> notIncluded = outside.stream().filter(u -> c.decision(u) != OccupantDecision.INCLUDED).toList();
        if (!notIncluded.isEmpty()) {
            problems.add("وحدات خارج فرع الوحدة الطالبة: " + join(notIncluded, names));
        }
        List<UUID> included = outside.stream().filter(u -> c.decision(u) == OccupantDecision.INCLUDED).toList();
        if (!included.isEmpty() && !policy.crossBranch().allowed()) {
            problems.add("ضم وحدة من فرع آخر غير مسموح في السياسة السارية.");
        }
        // kind and duration
        if (!Set.of(RestationingContent.PERMANENT, RestationingContent.TEMPORARY).contains(c.kind())) {
            problems.add("نوع التمركز دائم أو مؤقت.");
        }
        // a permanent move takes effect at activation; a temporary one at its approved start
        if (c.temporary() && c.start() == null) {
            problems.add("حدد تاريخ بدء التمركز المؤقت.");
        }
        if (c.temporary() && (c.end() == null || c.start() != null && !c.end().isAfter(c.start()))) {
            problems.add("التمركز المؤقت يحتاج نهاية بعد بدايته.");
        }
        if (c.temporary() && c.end() != null && !c.end().isAfter(now)) {
            problems.add("نهاية التمركز المؤقت في الماضي.");
        }
        Map<UUID, UUID> current = currentSites(c.scope(), now);
        if (c.temporary()) {
            List<UUID> noBase = c.scope().stream().filter(u -> names.containsKey(u) && permanentSite(u, now) == null).toList();
            if (!noBase.isEmpty()) {
                problems.add("لا تمركز دائم حالياً للوحدات (يُحفظ أثناء المؤقت ويُعاد إليه): " + join(noBase, names));
            }
        }
        // the one proposed site
        Double area = null;
        List<String> siteConflicts = List.of();
        String siteGeo = null;
        if (c.site() == null || c.site().geometry() == null) {
            problems.add("لم يُحدد موقع إعادة التمركز.");
        } else {
            siteGeo = json.write(c.site().geometry());
            String shapeProblem = polygonProblem(siteGeo);
            if (shapeProblem != null) {
                problems.add("حدود الموقع المقترح: " + shapeProblem);
                siteGeo = null;
            } else {
                area = geo.areaM2(siteGeo);
                if (!DeploymentRules.footprintWithin(area, policy)) {
                    problems.add("مساحة الموقع المقترح (" + Math.round(area) + " م²) تتجاوز الحد الأقصى المعتمد ("
                            + Math.round(policy.maxFootprintAreaM2()) + " م²).");
                }
                siteConflicts = occupiedIntersecting(siteGeo, c.scope(), now);
                if (!siteConflicts.isEmpty()) {
                    problems.add("الموقع المقترح يتداخل مع: " + String.join("، ", siteConflicts));
                }
            }
        }
        // deployment areas: a complete pair or none, distances, terrain, occupied ground
        problems.addAll(DeploymentRules.pair(policy.deploymentRequirement(), c.primary() != null, c.alternative() != null));
        List<Leg> legs = new ArrayList<>();
        String primaryGeo = c.primary() == null ? null : json.write(c.primary());
        String alternativeGeo = c.alternative() == null ? null : json.write(c.alternative());
        legs.add(leg("primary", "منطقة الانتشار الرئيسية", policy.primary(), siteGeo, primaryGeo, c, policy, policyVersion, now, problems));
        legs.add(leg("alternative", "منطقة الانتشار البديلة", policy.alternative(), primaryGeo, alternativeGeo, c, policy, policyVersion, now,
                problems));
        boolean exception = legs.stream().anyMatch(l -> l.check().status() == LegStatus.NEEDS_EXCEPTION);
        // units of another branch at the affected sites (O-03): an explicit decision where the requester's branch is
        // responsible for the site
        List<Occupant> others = otherBranch(requestingUnit, c, current, now);
        for (Occupant o : others) {
            if (o.decisionRequired() && o.decision() == null) {
                problems.add("حدّد معالجة الوحدة من فرع آخر: " + o.name());
            }
        }
        if (c.reason().trim().length() < 5) {
            problems.add("سبب الطلب مطلوب (5 أحرف على الأقل).");
        }
        // the route from the requesting unit (O-07, O-09) must reach the configured final stage
        List<CrossBranchInclusion> inclusions = included.stream().map(u -> inclusion(u, names.get(u), current.get(u), now)).toList();
        List<RouteStage> route = RouteDerivation.derive(path, policy.routing(), policy.crossBranch(), inclusions, exception);
        if (!RouteDerivation.complete(route)) {
            problems.add("لم يُشتق مسار اعتماد كامل من هيكل الوحدة الطالبة والإعداد (لا مرحلة نهائية).");
        }
        return new Result(problems, area, policy.maxFootprintAreaM2(), siteConflicts, legs, others, route, exception, current);
    }

    /**
     * The checks of an extension (D10): the units, site and deployment areas are the temporary stationing's own and are
     * not checked again; the new end must come after the current effective end, the reason is written, and the route
     * from the requesting unit reaches the configured final stage (an extension changes the duration, which the
     * hierarchy stages rest on).
     */
    public Result evaluateExtension(UUID requestingUnit, RestationingContent c, Instant effectiveEnd, StationingPolicy policy, Instant now) {
        List<String> problems = new ArrayList<>();
        List<OrgUnit> path = hierarchy.path(requestingUnit);
        if (path.isEmpty()) {
            throw ApiException.validation("الوحدة الطالبة غير موجودة.");
        }
        if (c.end() == null || effectiveEnd == null || !c.end().isAfter(effectiveEnd)) {
            problems.add("نهاية التمديد يجب أن تكون بعد النهاية الفعالة الحالية للتمركز المؤقت.");
        }
        if (effectiveEnd != null && !effectiveEnd.isAfter(now)) {
            problems.add("انتهى التمركز المؤقت؛ لا يُمدَّد.");
        }
        if (c.reason().trim().length() < 5) {
            problems.add("سبب التمديد مطلوب (5 أحرف على الأقل).");
        }
        List<RouteStage> route = RouteDerivation.derive(path, policy.routing(), policy.crossBranch(), List.of(), false);
        if (!RouteDerivation.complete(route)) {
            problems.add("لم يُشتق مسار اعتماد كامل من هيكل الوحدة الطالبة والإعداد (لا مرحلة نهائية).");
        }
        return new Result(problems, null, policy.maxFootprintAreaM2(), List.of(), List.of(), List.of(), route, false, Map.of());
    }

    /** Occupied geography intersecting a geometry now (also the atomic re-check at activation). */
    public List<String> occupiedIntersecting(String geoJson, List<UUID> moving, Instant now) {
        return jdbc.sql("""
                with eff as (
                  select distinct on (s.organization_id) s.organization_id, s.site_id
                    from org_stationing s
                   where s.valid_from <= :now and (s.valid_to is null or s.valid_to > :now) and s.start_held_at is null
                   order by s.organization_id, case s.kind when 'TEMPORARY' then 0 else 1 end),
                occupied as (
                  select site_id from eff where not (organization_id = any(string_to_array(:moving, ',')::uuid[]))
                  union
                  select r.site_id from reservation v join resource r on r.id = v.resource_id
                   where v.status = 'ACTIVE' and v.period_start <= :now and (v.period_end is null or v.period_end > :now))
                select s.name from site s
                  left join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version
                 where s.status = 'ACTIVE' and s.id in (select site_id from occupied)
                   and coalesce(g.geom, s.marker) is not null
                   and ST_Intersects(coalesce(g.geom, s.marker), """ + GEOM.formatted(":g") + """
                ) order by s.name""")
                .param("now", Db.ts(now)).param("moving", Db.ids(moving)).param("g", geoJson).query(String.class).list();
    }

    /** The site each unit is stationed at now (an active temporary overlays the permanent base, V2 D7). */
    public Map<UUID, UUID> currentSites(List<UUID> units, Instant now) {
        Map<UUID, UUID> out = new LinkedHashMap<>();
        if (units.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select distinct on (s.organization_id) s.organization_id, s.site_id from org_stationing s
                 where s.organization_id = any(string_to_array(:ids, ',')::uuid[])
                   and s.valid_from <= :now and (s.valid_to is null or s.valid_to > :now) and s.start_held_at is null
                 order by s.organization_id, case s.kind when 'TEMPORARY' then 0 else 1 end""")
                .param("ids", Db.ids(units)).param("now", Db.ts(now))
                .query((rs, n) -> out.put(Db.uuid(rs, "organization_id"), Db.uuid(rs, "site_id"))).list();
        return out;
    }

    /** The current permanent stationing record of a unit, or null. */
    public UUID permanentSite(UUID unit, Instant now) {
        return jdbc.sql("""
                select id from org_stationing where organization_id = :u and kind = 'PERMANENT'
                   and valid_from <= :now and (valid_to is null or valid_to > :now)""")
                .param("u", unit).param("now", Db.ts(now)).query(UUID.class).optional().orElse(null);
    }

    /** A problem with a submitted polygon, or null when it is one valid polygon. */
    public String polygonProblem(String geoJson) {
        try {
            Map<String, Object> r = jdbc.sql("select GeometryType(g) as t, ST_IsValid(g) as valid, ST_IsValidReason(g) as why from (select "
                            + GEOM.formatted(":g") + " as g) x")
                    .param("g", geoJson).query().singleRow();
            if (!"POLYGON".equals(r.get("t"))) {
                return "يجب أن تكون مضلعاً واحداً.";
            }
            return Boolean.TRUE.equals(r.get("valid")) ? null : "متقاطعة أو غير صالحة (" + r.get("why") + ").";
        } catch (RuntimeException e) {
            return "هندسة غير مقروءة.";
        }
    }

    private Leg leg(String key, String label, StationingPolicy.Leg cfg, String fromGeo, String toGeo, RestationingContent c,
                    StationingPolicy policy, int policyVersion, Instant now, List<String> problems) {
        TerrainAssessment t = null;
        TerrainDecision decision = null;
        List<String> conflicts = List.of();
        Double distance = null;
        if (toGeo != null) {
            String shape = polygonProblem(toGeo);
            if (shape != null) {
                problems.add(label + ": " + shape);
                toGeo = null;
            }
        }
        if (toGeo != null) {
            if (cfg.terrainApplies()) {
                try {
                    t = terrain.assess(toGeo, policy, policyVersion);
                    decision = new TerrainDecision(policy.terrainClass(t.controllingClass()), List.of(), 0, t.tie(), t.tied(),
                            t.resolved(), t.priority());
                } catch (ApiException e) {
                    problems.add(label + ": " + e.getMessage());
                }
            }
            conflicts = occupiedIntersecting(toGeo, c.scope(), now);
            if (!conflicts.isEmpty()) {
                // O-08: a hard block, never a warning
                problems.add(label + " تتداخل مع أرض مشغولة: " + String.join("، ", conflicts) + " — يجب نقلها إلى أرض خالية.");
            }
            if (fromGeo != null) {
                distance = geo.centroidDistanceM(fromGeo, toGeo);
            }
        }
        LegCheck check = DeploymentRules.leg(cfg, policy, distance, decision);
        switch (check.status()) {
            case OUT_OF_RANGE -> problems.add(label + " خارج النطاق المسموح (" + Math.round(check.distanceM()) + " م، المسموح "
                    + Math.round(check.effectiveMinM()) + "–" + Math.round(check.effectiveMaxM()) + " م).");
            case NEEDS_EXCEPTION -> {
                if (c.exception(key).length() < 5) {
                    problems.add(label + " تحتاج استثناء مسافة بسبب مكتوب.");
                }
            }
            case TERRAIN_TIE_UNRESOLVED -> problems.add(label + ": تعادل بين فئات أرض (" + String.join("، ", t.tied())
                    + ") دون ترتيب أولوية صالح لها في السياسة — يُمنع الإرسال (O-05b).");
            default -> {
            }
        }
        return new Leg(key, label, check, t, conflicts);
    }

    private List<Occupant> otherBranch(UUID requestingUnit, RestationingContent c, Map<UUID, UUID> current, Instant now) {
        Set<UUID> sites = new LinkedHashSet<>(current.values());
        if (sites.isEmpty()) {
            return List.of();
        }
        List<Occupant> out = new ArrayList<>();
        jdbc.sql("""
                with eff as (
                  select distinct on (s.organization_id) s.organization_id, s.site_id
                    from org_stationing s
                   where s.valid_from <= :now and (s.valid_to is null or s.valid_to > :now) and s.start_held_at is null
                   order by s.organization_id, case s.kind when 'TEMPORARY' then 0 else 1 end)
                select e.organization_id, o.name, e.site_id, st.name as site_name, r.organization_id as responsible
                  from eff e join organization o on o.id = e.organization_id join site st on st.id = e.site_id
                  left join site_responsibility r on r.site_id = e.site_id and r.valid_to is null
                 where e.site_id = any(string_to_array(:sites, ',')::uuid[])
                 order by st.name, o.name""")
                .param("now", Db.ts(now)).param("sites", Db.ids(sites))
                .query((rs, n) -> {
                    UUID unit = Db.uuid(rs, "organization_id");
                    UUID responsible = Db.uuid(rs, "responsible");
                    if (!under(unit, requestingUnit) && c.decision(unit) != OccupantDecision.INCLUDED) {
                        OccupantDecision d = c.decision(unit);
                        out.add(new Occupant(unit, rs.getString("name"), Db.uuid(rs, "site_id"), rs.getString("site_name"),
                                responsible != null && under(responsible, requestingUnit), d == null ? null : d.name()));
                    }
                    return null;
                }).list();
        return out;
    }

    private CrossBranchInclusion inclusion(UUID unit, String name, UUID site, Instant now) {
        UUID parent = hierarchy.unit(unit).map(OrgUnit::parentId).orElse(null);
        UUID responsible = site == null ? null : jdbc.sql("select organization_id from site_responsibility where site_id = :s and valid_to is null")
                .param("s", site).query(UUID.class).optional().orElse(null);
        return new CrossBranchInclusion(unit, name, parent, responsible);
    }

    private boolean under(UUID unit, UUID root) {
        return hierarchy.path(unit).stream().anyMatch(u -> u.id().equals(root));
    }

    private Map<UUID, String> names(List<UUID> units) {
        Map<UUID, String> out = new LinkedHashMap<>();
        if (units.isEmpty()) {
            return out;
        }
        jdbc.sql("select id, name from organization where id = any(string_to_array(:ids, ',')::uuid[]) and status = 'ACTIVE'")
                .param("ids", Db.ids(units)).query((rs, n) -> out.put(Db.uuid(rs, "id"), rs.getString("name"))).list();
        return out;
    }

    private static String join(List<UUID> units, Map<UUID, String> names) {
        return String.join("، ", units.stream().map(u -> names.getOrDefault(u, u.toString())).toList());
    }
}
