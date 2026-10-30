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

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.annotation.JsonInclude;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.common.Ref;
import ae.mover.common.Times;
import ae.mover.org.OrganizationService;

/**
 * Stationing proposal on the map (ADR-025): configurable distance rules between an organisation's current premises
 * and a proposed location, and the occupancy of registered boundaries the proposal touches in the requested period.
 * The same evaluation runs while the marker is dragged, when the proposal is saved, at submission and at approval;
 * it reads only and never changes the site register or a reservation. Occupant identity follows the actor's view.
 */
@Service
public class PlacementService {

    public static final Set<String> ACTIONS = Set.of("RELOCATE", "WORK_AREA");
    public static final Set<String> LEVELS = Set.of("MAIN", "BRANCH");

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final OrganizationService orgs;

    public PlacementService(JdbcClient jdbc, Json json, Clock clock, AuditService audit, OrganizationService orgs) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.orgs = orgs;
    }

    // ---- rules ----------------------------------------------------------------------------------------------

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Rule(String id, String name, String action, String stationLevel, Ref organization, boolean includeDescendants,
                       double minM, Double maxM, String measure, boolean active, int version, String updatedAt) {
    }

    public record RuleInput(String name, String action, String stationLevel, String organizationId, Boolean includeDescendants,
                            Double minM, Double maxM, String measure, Boolean active, Integer expectedVersion, String reason) {
    }

    private static final String RULE_SELECT = """
            select r.*, o.name as org_name from placement_rule r left join organization o on o.id = r.organization_id""";

    private Rule rule(Map<String, Object> r) {
        UUID org = (UUID) r.get("organization_id");
        return new Rule(r.get("id").toString(), (String) r.get("name"), (String) r.get("action"), (String) r.get("station_level"),
                Ref.of(org, (String) r.get("org_name")), Boolean.TRUE.equals(r.get("include_descendants")),
                ((Number) r.get("min_m")).doubleValue(), r.get("max_m") == null ? null : ((Number) r.get("max_m")).doubleValue(),
                (String) r.get("measure"), Boolean.TRUE.equals(r.get("active")), ((Number) r.get("version")).intValue(),
                Times.iso(Db.toInstant(r.get("updated_at"))));
    }

    /** Rules are administrative policy: anyone who works on the map reads the active ones; configuration sees all. */
    public List<Rule> rules(AccessContext ctx) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES, Permission.CONFIGURE);
        boolean all = ctx.has(Permission.CONFIGURE);
        return jdbc.sql(RULE_SELECT + " where :all or r.active order by r.action, r.active desc, r.name").param("all", all)
                .query().listOfRows().stream().map(this::rule).toList();
    }

    @Transactional
    public Rule saveRule(AccessContext ctx, UUID id, RuleInput in) {
        ctx.require(Permission.CONFIGURE);
        if (in == null) {
            throw ApiException.validation("بيانات القاعدة مطلوبة.");
        }
        String name = in.name() == null ? "" : in.name().trim();
        if (name.length() < 2 || name.length() > 120) {
            throw ApiException.validation("اكتب اسماً للقاعدة (2–120 حرفاً).");
        }
        if (!ACTIONS.contains(in.action())) {
            throw ApiException.validation("حدد نوع الإجراء الذي تنطبق عليه القاعدة.");
        }
        if (in.stationLevel() != null && !in.stationLevel().isBlank() && !LEVELS.contains(in.stationLevel())) {
            throw ApiException.validation("مستوى التمركز غير معروف.");
        }
        String measure = in.measure() == null || in.measure().isBlank() ? "CENTER" : in.measure();
        if (!Set.of("CENTER", "EDGE").contains(measure)) {
            throw ApiException.validation("طريقة القياس غير معروفة.");
        }
        double min = in.minM() == null ? 0 : in.minM();
        if (min < 0 || (in.maxM() != null && in.maxM() <= min)) {
            throw ApiException.validation("الحد الأقصى يجب أن يكون أكبر من الحد الأدنى، والحد الأدنى لا يقل عن صفر.");
        }
        UUID org = in.organizationId() == null || in.organizationId().isBlank() ? null : uuid(in.organizationId(), "الجهة");
        if (org != null && jdbc.sql("select count(*) from organization where id = :id").param("id", org).query(Integer.class).single() == 0) {
            throw ApiException.validation("الجهة غير موجودة.");
        }
        String reason = in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 5) {
            throw ApiException.validation("اكتب سبب التغيير (5 أحرف على الأقل).");
        }
        String level = in.stationLevel() == null || in.stationLevel().isBlank() ? null : in.stationLevel();
        Instant now = clock.instant();
        if (id == null) {
            id = UUID.randomUUID();
            jdbc.sql("""
                    insert into placement_rule(id, name, action, station_level, organization_id, include_descendants, min_m, max_m,
                        measure, active, version, updated_by, updated_at)
                    values (:id, :n, :a, :l, :o, :d, :min, :max, :m, :act, 1, :by, :now)""")
                    .param("id", id).param("n", name).param("a", in.action()).param("l", level).param("o", org)
                    .param("d", !Boolean.FALSE.equals(in.includeDescendants())).param("min", min).param("max", in.maxM())
                    .param("m", measure).param("act", !Boolean.FALSE.equals(in.active())).param("by", ctx.personId())
                    .param("now", Db.ts(now)).update();
        } else {
            int n = jdbc.sql("""
                    update placement_rule set name = :n, action = :a, station_level = :l, organization_id = :o,
                        include_descendants = :d, min_m = :min, max_m = :max, measure = :m, active = :act,
                        version = version + 1, updated_by = :by, updated_at = :now
                    where id = :id and version = :v""")
                    .param("id", id).param("n", name).param("a", in.action()).param("l", level).param("o", org)
                    .param("d", !Boolean.FALSE.equals(in.includeDescendants())).param("min", min).param("max", in.maxM())
                    .param("m", measure).param("act", !Boolean.FALSE.equals(in.active())).param("by", ctx.personId())
                    .param("now", Db.ts(now)).param("v", in.expectedVersion() == null ? -1 : in.expectedVersion()).update();
            if (n == 0) {
                throw ApiException.staleRevision();
            }
        }
        Rule saved = jdbc.sql(RULE_SELECT + " where r.id = :id").param("id", id).query().listOfRows().stream().map(this::rule)
                .findFirst().orElseThrow();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("action", saved.action());
        detail.put("stationLevel", saved.stationLevel());
        detail.put("organizationId", org == null ? null : org.toString());
        detail.put("minM", saved.minM());
        detail.put("maxM", saved.maxM());
        detail.put("measure", saved.measure());
        detail.put("active", saved.active());
        detail.put("version", saved.version());
        audit.recordAs(ctx.actor(), "PLACEMENT_RULE_SAVED", "PLACEMENT_RULE", id.toString(), name, detail, reason);
        return saved;
    }

    /**
     * The active rule for this action, level and organisation: an organisation-specific rule over a general one (the
     * nearest ancestor first), then a rule for this level over a rule for any level. Null when none is configured.
     */
    public Rule applicable(String action, String level, UUID orgId) {
        return jdbc.sql("""
                with recursive up(id, depth) as (
                  select cast(:org as uuid), 0 where cast(:org as uuid) is not null
                  union all select o.parent_id, up.depth + 1 from organization o join up on o.id = up.id where o.parent_id is not null)
                select r.*, o.name as org_name,
                       case when r.organization_id is null then 100000 else (select min(depth) from up where up.id = r.organization_id) end as d
                from placement_rule r left join organization o on o.id = r.organization_id
                where r.active and r.action = :a and (r.station_level is null or r.station_level = :l)
                  and (r.organization_id is null
                       or r.organization_id = cast(:org as uuid)
                       or (r.include_descendants and exists (select 1 from up where up.id = r.organization_id)))
                order by d, (r.station_level is null), r.updated_at desc limit 1""")
                .param("org", orgId).param("a", action).param("l", level)
                .query().listOfRows().stream().map(this::rule).findFirst().orElse(null);
    }

    // ---- check ----------------------------------------------------------------------------------------------

    public record CheckInput(String action, String organizationId, String fromSiteId, String stationLevel,
                             Map<String, Object> geometry, String targetSiteId, String start, String end,
                             String excludeRequestId, List<String> includedOrgIds) {
    }

    /** One registered site the proposal touches. Without a view of the site, neither its name nor its users are shown. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Conflict(String siteId, String label, String kind, boolean blocking, String until, List<Ref> occupants,
                           String message) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Check(boolean ok, String status, String range, double distanceM, String measure, Rule rule,
                        double[] from, double[] point, Ref targetSite, List<Conflict> conflicts, List<String> messages,
                        Integer otherProposals, String note) {
    }

    /** Interactive check from the map (preview only: the server checks again at save, submission and approval). */
    public Check check(AccessContext ctx, CheckInput in) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        if (in == null || in.geometry() == null) {
            throw ApiException.validation("حدد الموقع المقترح على الخريطة.");
        }
        String action = in.action() == null ? "RELOCATE" : in.action();
        if (!ACTIONS.contains(action)) {
            throw ApiException.validation("نوع الإجراء غير معروف.");
        }
        UUID org = in.organizationId() == null || in.organizationId().isBlank() ? null : uuid(in.organizationId(), "الجهة");
        if (org != null) {
            orgs.requireVisibleBranch(ctx, org, false);
        }
        UUID from = uuid(in.fromSiteId(), "المقر الحالي");
        requireVisibleSite(ctx, from);
        UUID target = in.targetSiteId() == null || in.targetSiteId().isBlank() ? null : uuid(in.targetSiteId(), "الموقع المسجل");
        if (target != null) {
            requireVisibleSite(ctx, target);
        }
        Instant start = Times.parse(in.start(), "start");
        Instant end = Times.parse(in.end(), "end");
        if (start == null) {
            start = clock.instant();
        }
        if (end != null && !end.isAfter(start)) {
            throw ApiException.validation("نهاية المدة يجب أن تكون بعد بدايتها.");
        }
        List<UUID> included = new ArrayList<>();
        if (in.includedOrgIds() != null) {
            in.includedOrgIds().forEach(s -> included.add(uuid(s, "الجهات المشمولة")));
        }
        UUID exclude = in.excludeRequestId() == null || in.excludeRequestId().isBlank() ? null : uuid(in.excludeRequestId(), "الطلب");
        return evaluate(ctx, action, org, included, from, in.stationLevel(), json.write(in.geometry()), target, start, end, exclude);
    }

    /**
     * Distance to the current premises against the applicable rule, and occupancy in [start, end) (end null = from
     * start onwards) of every registered boundary the proposal touches — the boundary, not only its centre — and of the
     * chosen registered site. Reservations of the moving organisation and the organisations it covers never conflict.
     */
    public Check evaluate(AccessContext ctx, String action, UUID org, List<UUID> included, UUID from, String level, String geojson,
                          UUID target, Instant start, Instant end, UUID excludeRequest) {
        Map<String, Object> g = jdbc.sql("""
                with p as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) as g)
                select GeometryType(g) as t, ST_IsValid(g) as ok, ST_Y(ST_Centroid(g)) as lat, ST_X(ST_Centroid(g)) as lng,
                       ST_XMin(g) as x0, ST_YMin(g) as y0, ST_XMax(g) as x1, ST_YMax(g) as y1 from p""")
                .param("g", geojson).query().listOfRows().stream().findFirst().orElseThrow();
        if (!Set.of("POINT", "POLYGON", "MULTIPOLYGON").contains(g.get("t")) || !Boolean.TRUE.equals(g.get("ok"))) {
            throw ApiException.validation("الموقع المقترح يُحدد بنقطة أو بحدود مضلع صالحة.");
        }
        if (((Number) g.get("x0")).doubleValue() < -180 || ((Number) g.get("x1")).doubleValue() > 180
                || ((Number) g.get("y0")).doubleValue() < -90 || ((Number) g.get("y1")).doubleValue() > 90) {
            throw ApiException.validation("إحداثيات الموقع المقترح خارج النطاق.");
        }
        // the current premises: its registered boundary when it has one, else its marker
        Map<String, Object> f = jdbc.sql("""
                with s as (select coalesce(
                    (select v.geom from site x join site_geometry_version v on v.site_id = x.id and v.version = x.geometry_version
                     where x.id = :from and v.geometry_type <> 'Point'),
                    (select marker from site where id = :from)) as g),
                p as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) as g)
                select s.g is not null as has, ST_Y(ST_Centroid(s.g)) as lat, ST_X(ST_Centroid(s.g)) as lng,
                       ST_Distance(ST_Centroid(s.g)::geography, ST_Centroid(p.g)::geography) as center_m,
                       ST_Distance(s.g::geography, p.g::geography) as edge_m
                from s, p""").param("from", from).param("g", geojson).query().singleRow();
        if (!Boolean.TRUE.equals(f.get("has"))) {
            throw ApiException.validation("المقر الحالي ليس له علامة أو حدود على الخريطة؛ يحددها مسؤول المرافق أولاً.");
        }
        Rule rule = applicable(action, level, org);
        String measure = rule == null ? "CENTER" : rule.measure();
        double distance = ((Number) f.get("EDGE".equals(measure) ? "edge_m" : "center_m")).doubleValue();
        List<String> messages = new ArrayList<>();
        String range;
        if (rule == null) {
            range = "NO_RULE";
            messages.add("لا توجد قاعدة مسافة مهيأة لهذا الإجراء؛ تُعرض المسافة دون حد.");
        } else if (distance < rule.minM()) {
            range = "TOO_CLOSE";
            messages.add("الموقع المقترح أقرب من الحد الأدنى المسموح (" + km(rule.minM()) + ").");
        } else if (rule.maxM() != null && distance > rule.maxM()) {
            range = "TOO_FAR";
            messages.add("الموقع المقترح أبعد من الحد الأقصى المسموح (" + km(rule.maxM()) + ").");
        } else {
            range = "IN_RANGE";
        }

        // registered sites the proposal touches: their current boundary, a marker inside a drawn proposal, the chosen site
        List<Map<String, Object>> hits = jdbc.sql("""
                with p as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) as g)
                select s.id, s.name, sr.organization_id as resp from site s
                left join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version and v.geometry_type <> 'Point'
                left join site_responsibility sr on sr.site_id = s.id and sr.valid_to is null, p
                where s.status = 'ACTIVE' and s.id <> :from and (
                  (v.geom is not null and ST_Intersects(v.geom, p.g))
                  or (v.geom is null and s.marker is not null and GeometryType(p.g) <> 'POINT' and ST_Intersects(s.marker, p.g))
                  or s.id = cast(:target as uuid))
                order by s.code""").param("g", geojson).param("from", from).param("target", target).query().listOfRows();
        Set<UUID> own = new java.util.HashSet<>(included);
        if (org != null) {
            own.add(org);
        }
        List<Conflict> conflicts = new ArrayList<>();
        for (Map<String, Object> h : hits) {
            UUID siteId = (UUID) h.get("id");
            ViewLevel view = ctx == null ? ViewLevel.FULL : ctx.siteView(siteId, Set.of(), (UUID) h.get("resp"));
            String label = view == ViewLevel.NONE ? "منطقة مشغولة غير ظاهرة لك" : (String) h.get("name");
            String shownId = view == ViewLevel.NONE ? null : siteId.toString();
            boolean exclusive = false;
            boolean limit = false;
            boolean shared = false;
            Instant until = Instant.MIN;
            boolean openEnded = false;
            List<Ref> users = new ArrayList<>();
            for (Map<String, Object> v : jdbc.sql("""
                    select v.organization_id, o.name as org_name, v.period_end, r.id as rid, r.policy, r.shared_limit from reservation v
                    join resource r on r.id = v.resource_id join organization o on o.id = v.organization_id
                    where v.status = 'ACTIVE' and r.site_id = :s and tstzrange(v.period_start, v.period_end, '[)') && tstzrange(:a, :b, '[)')
                    order by o.name""").param("s", siteId).param("a", Db.ts(start)).param("b", Db.ts(end)).query().listOfRows()) {
                if (own.contains((UUID) v.get("organization_id"))) {
                    continue;
                }
                Ref user = Ref.of((UUID) v.get("organization_id"), (String) v.get("org_name"));
                if (users.stream().noneMatch(u -> u.id().equals(user.id()))) {
                    users.add(user);
                }
                Instant e = Db.toInstant(v.get("period_end"));
                if ("SHARED".equals(v.get("policy"))) {
                    Object max = v.get("shared_limit");
                    if (max != null && sharedPeak((UUID) v.get("rid"), start, end) >= ((Number) max).intValue()) {
                        limit = true;
                    } else {
                        shared = true;
                        continue;
                    }
                } else {
                    exclusive = true;
                }
                if (e == null) {
                    openEnded = true;
                } else if (e.isAfter(until)) {
                    until = e;
                }
            }
            List<Ref> shownUsers = view == ViewLevel.FULL && !users.isEmpty() ? users : null;
            String untilIso = exclusive || limit ? (openEnded ? null : Times.iso(until)) : null;
            if (exclusive || limit) {
                String msg = "لا يمكن استخدام هذا الموقع؛ «" + label + "» محجوز للفترة المطلوبة"
                        + (openEnded ? "." : "، ويصبح متاحاً بعد " + until.atZone(Times.DISPLAY_ZONE).toLocalDate() + ".");
                conflicts.add(new Conflict(shownId, label, limit && !exclusive ? "LIMIT" : "OCCUPIED", true, untilIso, shownUsers, msg));
            } else if (shared) {
                conflicts.add(new Conflict(shownId, label, "SHARED", false, null, shownUsers,
                        "«" + label + "» مستخدم استخداماً مشتركاً مسموحاً؛ لا يمنع الاختيار."));
            } else if (target != null && target.equals(siteId)) {
                conflicts.add(new Conflict(shownId, label, "FREE", false, null, null, "«" + label + "» موقع مسجل متاح للفترة."));
            }
        }
        conflicts.stream().filter(Conflict::blocking).forEach(c -> messages.add(c.message()));

        // other relocation proposals under review on the same place in an overlapping period (information only)
        Integer others = jdbc.sql("""
                with p as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) as g)
                select count(*) from request_relocation rr join request q on q.id = rr.request_id, p
                where q.status = 'SUBMITTED' and (cast(:ex as uuid) is null or rr.request_id <> cast(:ex as uuid))
                  and ST_DWithin(rr.proposed_geom::geography, p.g::geography, 25)
                  and tstzrange(q.period_start, q.period_end, '[)') && tstzrange(:a, :b, '[)')""")
                .param("g", geojson).param("ex", excludeRequest).param("a", Db.ts(start)).param("b", Db.ts(end))
                .query(Integer.class).single();

        boolean rangeOk = !"TOO_CLOSE".equals(range) && !"TOO_FAR".equals(range);
        boolean free = conflicts.stream().noneMatch(Conflict::blocking);
        String status = !rangeOk ? "OUT_OF_RANGE" : !free ? "OCCUPIED" : "OK";
        Ref targetRef = null;
        if (target != null) {
            String name = jdbc.sql("select name from site where id = :id").param("id", target).query(String.class).single();
            targetRef = Ref.of(target, name);
        }
        return new Check(rangeOk && free, status, range, Math.round(distance * 10) / 10.0, measure, rule,
                new double[] {((Number) f.get("lat")).doubleValue(), ((Number) f.get("lng")).doubleValue()},
                new double[] {((Number) g.get("lat")).doubleValue(), ((Number) g.get("lng")).doubleValue()},
                targetRef, conflicts, messages, others == 0 ? null : others,
                "معاينة فقط: لا تغيّر سجل المواقع ولا تمنح حجزاً، ويُعاد التحقق عند الحفظ والإرسال والاعتماد.");
    }

    private int sharedPeak(UUID resourceId, Instant start, Instant end) {
        return jdbc.sql("select resource_shared_peak(:rid, tstzrange(:a, :b, '[)'), null)")
                .param("rid", resourceId).param("a", Db.ts(start)).param("b", Db.ts(end)).query(Integer.class).single();
    }

    // ---- organisations covered by a move --------------------------------------------------------------------

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Unit(String id, String code, String name, String parentId, int depth, boolean atSite, List<Ref> otherSites) {
    }

    /**
     * The organisation and its visible branches, each marked whether it is at this site now (responsible for it, or
     * using it under an active reservation). A branch elsewhere is listed with its own sites and is never moved by
     * default: the person chooses which organisations the change covers.
     */
    public List<Unit> units(AccessContext ctx, UUID orgId, UUID siteId) {
        OrganizationService.requireOrgReader(ctx);
        Set<UUID> visible = orgs.requireVisibleBranch(ctx, orgId, true);
        requireVisibleSite(ctx, siteId);
        Instant now = clock.instant();
        List<Map<String, Object>> rows = jdbc.sql("""
                with recursive down(id, depth) as (select cast(:org as uuid), 0
                  union all select o.id, d.depth + 1 from organization o join down d on o.parent_id = d.id
                  where o.status = 'ACTIVE' and d.depth < 30)
                select o.id, o.code, o.name, o.parent_id, d.depth,
                       exists (select 1 from site_responsibility sr where sr.organization_id = o.id and sr.site_id = :s and sr.valid_to is null)
                       or exists (select 1 from reservation v join resource r on r.id = v.resource_id
                                  where v.organization_id = o.id and r.site_id = :s and v.status = 'ACTIVE'
                                    and (v.period_end is null or v.period_end > :now) and v.period_start <= :now) as at_site
                from down d join organization o on o.id = d.id order by d.depth, o.code limit 1000""")
                .param("org", orgId).param("s", siteId).param("now", Db.ts(now)).query().listOfRows();
        Map<UUID, List<Ref>> elsewhere = new HashMap<>();
        jdbc.sql("""
                select sr.organization_id, s.id, s.name from site_responsibility sr join site s on s.id = sr.site_id
                where sr.valid_to is null and s.status = 'ACTIVE' and s.id <> :s
                  and sr.organization_id = any(string_to_array(:ids, ',')::uuid[]) order by s.code""")
                .param("s", siteId).param("ids", Db.ids(visible)).query().listOfRows().forEach(r -> {
                    UUID sid = (UUID) r.get("id");
                    if (ctx.siteView(sid, Set.of(), (UUID) r.get("organization_id")) != ViewLevel.NONE) {
                        elsewhere.computeIfAbsent((UUID) r.get("organization_id"), k -> new ArrayList<>()).add(Ref.of(sid, (String) r.get("name")));
                    }
                });
        List<Unit> out = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            UUID id = (UUID) r.get("id");
            if (!visible.contains(id)) {
                continue;
            }
            out.add(new Unit(id.toString(), (String) r.get("code"), (String) r.get("name"),
                    r.get("parent_id") == null ? null : r.get("parent_id").toString(), ((Number) r.get("depth")).intValue(),
                    Boolean.TRUE.equals(r.get("at_site")), elsewhere.get(id)));
        }
        return out;
    }

    // ---- helpers --------------------------------------------------------------------------------------------

    private void requireVisibleSite(AccessContext ctx, UUID siteId) {
        UUID resp = jdbc.sql("select organization_id from site_responsibility where site_id = :s and valid_to is null")
                .param("s", siteId).query(UUID.class).optional().orElse(null);
        boolean exists = jdbc.sql("select count(*) from site where id = :s and status = 'ACTIVE'").param("s", siteId)
                .query(Integer.class).single() > 0;
        if (!exists || ctx.siteView(siteId, Set.of(), resp) == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
    }

    static String km(double m) {
        return m >= 1000 ? (Math.round(m / 100.0) / 10.0) + " كم" : Math.round(m) + " م";
    }

    private static UUID uuid(String v, String label) {
        try {
            return UUID.fromString(v);
        } catch (RuntimeException e) {
            throw ApiException.validation("معرف غير صالح في «" + label + "».");
        }
    }
}
