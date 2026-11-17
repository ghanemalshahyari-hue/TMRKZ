package ae.mover.stationing;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.facilities.BoundaryService;
import ae.mover.facilities.SiteService;
import ae.mover.stationing.StationingPolicyStore.PolicyVersion;
import ae.mover.system.IdempotencyService;

/**
 * «موقع جديد» for the setup administrator (ADR-067, owner's full acceptance specification of 16 Nov 2026): the site, its
 * initial stationing and each stationed unit's primary and alternative deployment areas in ONE transaction and ONE audit
 * event. Only someone who holds both {@link Permission#MANAGE_FACILITIES} and {@link Permission#CORRECT_STATIONING} over
 * everything («تهيئة المواقع والتمركز», confirmed by OpenFGA) may do it; everyone else keeps the request path.
 *
 * <p>Nothing is invented here: the site and its boundary go through {@link BoundaryService#createWithBoundary} (or
 * {@link SiteService#create} for a site that is one point) exactly as «/sites/with-boundary»; each area through
 * {@link RestationingChecks#deploymentLeg}, the leg every request is checked with (shape, terrain, occupied ground, the
 * range of the policy in force); the pair rule is the policy's {@code deploymentRequirement} ({@link DeploymentRules#pair}).
 * A stationing is written with origin SETUP and no request, its event is the one a correction writes, and the units at the
 * place are told for information as at an activation. Any refusal rolls back everything: no half site is left behind.
 *
 * <p>«تحديد مواقع التمركز المبدئية» (owner brief, phase 2, ADR-081): the setup is the site and its unit's initial stationing.
 * A unit sent without any area is stationed alone, whatever the policy requires: its areas are asked for afterwards by
 * «طلب مناطق انتشار», and the hub shows it {@code DEPLOYMENT_MISSING} until then. Areas that are sent are still checked as
 * above (a complete pair the policy accepts, each leg in range), and only then is a policy in force needed.
 */
@Service
public class SiteSetupService {

    public static final String AUDIT_ACTION = "SITE_SETUP_BOOTSTRAPPED";
    private static final String PRIMARY_LABEL = "منطقة الانتشار الرئيسية";
    private static final String ALTERNATIVE_LABEL = "منطقة الانتشار الفرعية";

    /**
     * One unit stationed by the setup, with its own two areas (GeoJSON polygons in WGS 84, as the request editor sends them);
     * none for the initial stationing alone (ADR-081).
     */
    public record UnitInput(UUID organizationId, Map<String, Object> primary, Map<String, Object> alternative) {
    }

    /**
     * {@code site} and {@code boundary} are what «/sites/with-boundary» takes (no boundary: a site that is one point, at its
     * location). Their own reasons default to the setup's reason. {@code effectiveFrom}: when the stationing began (now when
     * absent; never in the future, as a correction).
     */
    public record SetupInput(SiteService.SiteInput site, BoundaryService.SaveInput boundary, List<UnitInput> units, String reason,
                             String reference, Instant effectiveFrom) {
    }

    /** The server's answer for one unit: its problems and the two legs as every request shows them. */
    record UnitCheck(UUID organizationId, String name, List<String> problems, List<RestationingChecks.Leg> legs) {
    }

    record Evaluation(List<String> problems, List<UnitCheck> units, PolicyVersion policy, Instant effective) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final SiteService sites;
    private final BoundaryService boundaries;
    private final RestationingChecks checks;
    private final StationingPolicyStore policies;
    private final StationingOutbox outbox;
    private final PlaceInfo placeInfo;
    private final AuditService audit;
    private final IdempotencyService idempotency;
    private final TransactionTemplate tx;
    private final SiteSetupAccess access;

    public SiteSetupService(JdbcClient jdbc, Json json, Clock clock, SiteService sites, BoundaryService boundaries, RestationingChecks checks,
                            StationingPolicyStore policies, StationingOutbox outbox, PlaceInfo placeInfo, AuditService audit,
                            IdempotencyService idempotency, TransactionTemplate tx, @org.springframework.context.annotation.Lazy SiteSetupAccess access) {
        this.access = access;
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.sites = sites;
        this.boundaries = boundaries;
        this.checks = checks;
        this.policies = policies;
        this.outbox = outbox;
        this.placeInfo = placeInfo;
        this.audit = audit;
        this.idempotency = idempotency;
        this.tx = tx;
    }

    /** «تهيئة المواقع والتمركز» (SITE_SETUP_ADMIN): facilities and stationing corrections over everything. */
    public static boolean admin(AccessContext ctx) {
        return ctx.canEverywhere(Permission.MANAGE_FACILITIES) && ctx.canEverywhere(Permission.CORRECT_STATIONING);
    }

    private static void requireAdmin(AccessContext ctx) {
        if (!admin(ctx)) {
            throw ApiException.forbidden("تسجيل الموقع مع تمركزه ومناطق انتشاره يحتاج «تهيئة المواقع والتمركز»: إدارة المرافق وتصحيح التمركز على كل الوحدات. "
                    + "لغير ذلك يُسجَّل الموقع وحده، ويُطلب التمركز من «＋ طلب جديد».");
        }
    }

    // ---- the one save -------------------------------------------------------------------------------------------------

    @Transactional
    public Map<String, Object> setup(AccessContext ctx, SetupInput in, String idemKey) {
        if (in == null) {
            throw ApiException.validation("أدخل بيانات الموقع.");
        }
        if (admin(ctx)) {
            return idempotency.run(ctx.actor(), idemKey, "site-setup", hashable(in), () -> write(ctx, in, idemKey), () -> replay(ctx, idemKey));
        }
        // «صلاحيات تهيئة المواقع» (phase 7; ADR-089): someone the rule allows sets up a site with the units it covers
        SetupInput scoped = scoped(ctx, in);
        AccessContext acting = access.actingFor(ctx, UUID.fromString(scoped.site().responsibleOrgId()));
        return idempotency.run(ctx.actor(), idemKey, "site-setup", hashable(scoped), () -> write(acting, scoped, idemKey), () -> replay(ctx, idemKey));
    }

    /**
     * A save by someone «صلاحيات تهيئة المواقع» allows (not the administrator): at least one unit, every unit inside the rule;
     * the site is registered under the first unit unless another unit of the rule is named; an inside site only inside a site
     * whose responsible unit the rule covers. Anything else is refused before anything is written.
     */
    private SetupInput scoped(AccessContext ctx, SetupInput in) {
        List<UUID> ids = unitIds(in);
        if (ids.isEmpty() || !access.anywhere(ctx)) {
            requireAdmin(ctx);
        }
        for (UUID u : ids) {
            if (!access.allows(ctx, u)) {
                throw ApiException.forbidden("تهيئة موقع لهذه الوحدة خارج «صلاحيات تهيئة المواقع» الممنوحة لك (الإعدادات). لم يُحفظ شيء.");
            }
        }
        SiteService.SiteInput s = in.site();
        if (s == null) {
            throw ApiException.validation("أدخل بيانات الموقع.");
        }
        String responsible = s.responsibleOrgId() == null || s.responsibleOrgId().isBlank() ? ids.get(0).toString() : s.responsibleOrgId();
        if (!access.allows(ctx, UUID.fromString(responsible))) {
            throw ApiException.forbidden("الجهة المسؤولة عن الموقع خارج «صلاحيات تهيئة المواقع» الممنوحة لك.");
        }
        if (s.parentId() != null && !s.parentId().isBlank()) {
            UUID parentOrg = jdbc.sql("select organization_id from site_responsibility where site_id = :s and valid_to is null order by valid_from desc limit 1")
                    .param("s", UUID.fromString(s.parentId())).query(UUID.class).optional().orElse(null);
            if (parentOrg == null || !access.allows(ctx, parentOrg)) {
                throw ApiException.forbidden("الموقع الرئيسي المختار خارج «صلاحيات تهيئة المواقع» الممنوحة لك: يُضاف الموقع الداخلي فيه من مدير النظام.");
            }
        }
        SiteService.SiteInput site = new SiteService.SiteInput(s.code(), s.name(), s.kind(), s.parentId(), responsible, s.capacity(), s.location(),
                s.notes(), s.reason(), s.symbol());
        return new SetupInput(site, in.boundary(), in.units(), in.reason(), in.reference(), in.effectiveFrom());
    }

    private Map<String, Object> write(AccessContext ctx, SetupInput in, String idemKey) {
        Instant now = clock.instant();
        // serialised with every activation: the occupied ground checked below cannot change before this transaction ends
        jdbc.sql("select pg_advisory_xact_lock(hashtext('tmrkz.restationing.activation'))").query().singleRow();
        List<UUID> ids = unitIds(in);
        if (!ids.isEmpty()) {
            jdbc.sql("select id from organization where id = any(string_to_array(:ids, ',')::uuid[]) order by id for update")
                    .param("ids", Db.ids(ids)).query().listOfRows();
        }
        Evaluation e = evaluate(in, now);
        if (!e.problems().isEmpty()) {
            Map<String, Object> details = new LinkedHashMap<>();
            details.put("problems", e.problems());
            throw ApiException.validation(e.problems().get(0), details);
        }
        String reason = in.reason().trim();
        SiteService.SiteView site = createSite(ctx, in, reason);
        UUID siteId = UUID.fromString(site.id());
        String sourceVersion = e.policy() == null ? "policy:none" : "policy:" + e.policy().version();
        List<Map<String, Object>> written = new ArrayList<>();
        Map<UUID, UnitInput> byUnit = new LinkedHashMap<>();
        for (UnitInput u : in.units() == null ? List.<UnitInput>of() : in.units()) {
            byUnit.putIfAbsent(u.organizationId(), u);
        }
        for (UnitCheck c : e.units()) {
            UnitInput u = byUnit.get(c.organizationId());
            UUID record = UUID.randomUUID();
            try {
                jdbc.sql("""
                        insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, reference, recorded_by,
                                                   recorded_at)
                        values (:id, :org, :site, 'PERMANENT', :from, 'SETUP', :reason, :ref, :by, :now)""")
                        .param("id", record).param("org", c.organizationId()).param("site", siteId).param("from", Db.ts(e.effective()))
                        .param("reason", reason).param("ref", blankToNull(in.reference())).param("by", ctx.personId())
                        .param("now", Db.ts(now)).update();
            } catch (DataAccessException x) {
                if (Db.isExclusionViolation(x)) {
                    throw ApiException.validation("«" + c.name() + "»: يتداخل هذا التمركز مع تمركز مسجل للوحدة في الفترة نفسها. لم يُحفظ شيء.");
                }
                throw x;
            }
            outbox.enqueue(StationingEvent.Type.STATIONING_CORRECTED, c.organizationId(), siteId, e.effective(), now, sourceVersion,
                    "org_stationing:" + record);
            Map<String, Object> areas = new LinkedHashMap<>();
            areas.put("PRIMARY", insertArea(u.primary(), "PRIMARY", siteId, c.organizationId(), record, e.effective()));
            areas.put("ALTERNATIVE", insertArea(u.alternative(), "ALTERNATIVE", siteId, c.organizationId(), record, e.effective()));
            Map<String, Object> w = new LinkedHashMap<>();
            w.put("organizationId", c.organizationId().toString());
            w.put("name", c.name());
            w.put("stationingId", record.toString());
            w.put("areas", areas);
            written.add(w);
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("siteId", siteId.toString());
        detail.put("siteCode", site.code());
        detail.put("boundary", in.boundary() != null);
        detail.put("units", written);
        detail.put("effectiveFrom", e.effective().toString());
        detail.put("reference", blankToNull(in.reference()));
        detail.put("policyVersion", e.policy() == null ? null : e.policy().version());
        if (idemKey != null && !idemKey.isBlank()) {
            detail.put("idempotencyKey", idemKey);
        }
        audit.recordAs(ctx.actor(), AUDIT_ACTION, "SITE", siteId.toString(), site.name(), detail, reason);
        if (!e.units().isEmpty()) {
            // for information, as at an activation (ADR-042): who is now at this place, and their main unit
            placeInfo.noticeStationed(e.units().stream().map(UnitCheck::organizationId).toList(), siteId, "تهيئة " + site.code());
        }
        return result(site, written, e.policy(), e.effective());
    }

    private UUID insertArea(Map<String, Object> area, String role, UUID site, UUID unit, UUID stationing, Instant from) {
        if (area == null) {
            return null;
        }
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into deployment_area(id, request_id, origin, site_id, role, geom, state, valid_from, organization_id, stationing_id)
                values (:id, null, 'SETUP', :site, :role, ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326), 'ACTIVE', :from, :org, :st)""")
                .param("id", id).param("site", site).param("role", role).param("g", json.write(area)).param("from", Db.ts(from))
                .param("org", unit).param("st", stationing).update();
        return id;
    }

    /** The site and its boundary as «/sites/with-boundary» registers them (a point site: as «/sites»), with their own audit. */
    private SiteService.SiteView createSite(AccessContext ctx, SetupInput in, String reason) {
        SiteService.SiteInput s = in.site();
        if (s == null) {
            throw ApiException.validation("أدخل بيانات الموقع.");
        }
        String why = blank(s.reason()) ? reason : s.reason();
        SiteService.SiteInput site = new SiteService.SiteInput(s.code(), s.name(), s.kind(), s.parentId(), s.responsibleOrgId(), s.capacity(),
                s.location(), s.notes(), why, s.symbol());
        BoundaryService.SaveInput b = in.boundary();
        if (b == null) {
            return sites.create(ctx, site);
        }
        BoundaryService.SaveInput boundary = new BoundaryService.SaveInput(b.geometry(), b.crs(), b.expectedVersion() == null ? 0 : b.expectedVersion(),
                blank(b.reason()) ? why : b.reason(), b.method());
        return boundaries.createWithBoundary(ctx, new BoundaryService.CreateInput(site, boundary));
    }

    /** A resent save (same Idempotency-Key, same body): what the first one wrote, never a second site. */
    private Map<String, Object> replay(AccessContext ctx, String idemKey) {
        UUID siteId = jdbc.sql("""
                select entity_id::uuid from audit_event where action = :a and actor_person_id = :p and detail->>'idempotencyKey' = :k
                 order by id desc limit 1""")
                .param("a", AUDIT_ACTION).param("p", ctx.personId()).param("k", idemKey).query(UUID.class).optional()
                .orElseThrow(() -> ApiException.validation("لم يكتمل الحفظ السابق بهذا المفتاح؛ أعد المحاولة بمفتاح جديد."));
        SiteService.SiteView site = sites.list(ctx).stream().filter(s -> s.id().equals(siteId.toString())).findFirst().orElseThrow(ApiException::notFound);
        List<Map<String, Object>> written = new ArrayList<>();
        jdbc.sql("""
                select s.id, s.organization_id, o.name,
                       (select a.id from deployment_area a where a.stationing_id = s.id and a.role = 'PRIMARY' and a.origin = 'SETUP') as primary_id,
                       (select a.id from deployment_area a where a.stationing_id = s.id and a.role = 'ALTERNATIVE' and a.origin = 'SETUP') as alternative_id
                  from org_stationing s join organization o on o.id = s.organization_id
                 where s.site_id = :site and s.origin = 'SETUP' order by s.recorded_at, o.name""")
                .param("site", siteId).query((rs, n) -> {
                    Map<String, Object> areas = new LinkedHashMap<>();
                    areas.put("PRIMARY", Db.uuid(rs, "primary_id"));
                    areas.put("ALTERNATIVE", Db.uuid(rs, "alternative_id"));
                    Map<String, Object> w = new LinkedHashMap<>();
                    w.put("organizationId", rs.getString("organization_id"));
                    w.put("name", rs.getString("name"));
                    w.put("stationingId", rs.getString("id"));
                    w.put("areas", areas);
                    return written.add(w);
                }).list();
        Instant at = jdbc.sql("select min(valid_from) from org_stationing where site_id = :s and origin = 'SETUP'").param("s", siteId)
                .query((rs, n) -> Db.instant(rs, "min")).optional().orElse(null);
        return result(site, written, null, at);
    }

    private static Map<String, Object> result(SiteService.SiteView site, List<Map<String, Object>> units, PolicyVersion policy, Instant effective) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("site", site);
        m.put("units", units);
        m.put("policyVersion", policy == null ? null : policy.version());
        m.put("effectiveFrom", effective == null ? null : effective.toString());
        return m;
    }

    // ---- the review: the same checks, nothing written -----------------------------------------------------------------

    /**
     * «مراجعة وحفظ»: everything the save would check, with each unit's legs as every request shows them, and the site
     * registered and rolled back so its own rules (the overlap with registered sites among them) answer too. Nothing stays.
     */
    public Map<String, Object> check(AccessContext ctx, SetupInput given) {
        if (given == null) {
            throw ApiException.validation("أدخل بيانات الموقع.");
        }
        // the same rule as the save (ADR-089)
        SetupInput in = admin(ctx) ? given : scoped(ctx, given);
        return tx.execute(status -> {
            Instant now = clock.instant();
            Evaluation e = evaluate(in, now);
            List<String> problems = new ArrayList<>(e.problems());
            try {
                createSite(ctx, in, in.reason() == null || in.reason().trim().length() < 5 ? "مراجعة قبل الحفظ" : in.reason().trim());
            } catch (ApiException x) {
                // the boundary's own refusal is already listed when the legs could not be measured from it
                Object listed = x.details().get("problems");
                List<String> site = listed instanceof List<?> l && !l.isEmpty() ? l.stream().map(String::valueOf).toList() : List.of(x.getMessage());
                site.stream().filter(p -> problems.stream().noneMatch(q -> q.contains(p))).forEach(p -> problems.add("الموقع: " + p));
            }
            status.setRollbackOnly();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("ok", problems.isEmpty());
            m.put("problems", new ArrayList<>(new LinkedHashSet<>(problems)));
            m.put("policyVersion", e.policy() == null ? null : e.policy().version());
            m.put("deploymentRequirement", e.policy() == null ? null : e.policy().values().deploymentRequirement().name());
            m.put("units", e.units().stream().map(u -> {
                Map<String, Object> v = new LinkedHashMap<>();
                v.put("organizationId", u.organizationId().toString());
                v.put("name", u.name());
                v.put("ok", u.problems().isEmpty());
                v.put("problems", u.problems());
                v.put("legs", u.legs().stream().map(SiteSetupService::legView).toList());
                return v;
            }).toList());
            return m;
        });
    }

    // ---- the rules ----------------------------------------------------------------------------------------------------

    /** Every problem of a setup, nothing written: the reason, the date, the units, the policy in force and each unit's legs. */
    Evaluation evaluate(SetupInput in, Instant now) {
        List<String> problems = new ArrayList<>();
        if (in.reason() == null || in.reason().trim().length() < 5) {
            problems.add("اكتب سبب التهيئة (5 أحرف على الأقل).");
        }
        Instant effective = in.effectiveFrom() == null ? now : in.effectiveFrom();
        if (effective.isAfter(now)) {
            problems.add("التهيئة تسجل واقعاً قائماً؛ لا يكون تاريخ بدء التمركز في المستقبل.");
            effective = now;
        }
        List<UnitInput> given = in.units() == null ? List.of() : in.units();
        if (given.stream().anyMatch(u -> u == null || u.organizationId() == null)) {
            problems.add("حدد كل وحدة بمعرفها.");
        }
        List<UUID> ids = unitIds(in);
        if (ids.size() < given.stream().filter(u -> u != null && u.organizationId() != null).count()) {
            problems.add("وحدة مكررة في التهيئة: لكل وحدة تمركز واحد ومنطقتاها.");
        }
        Map<UUID, String> names = activeNames(ids);
        long unknown = ids.stream().filter(u -> !names.containsKey(u)).count();
        if (unknown > 0) {
            problems.add("وحدات غير موجودة أو موقوفة: " + unknown + ".");
        }
        // stationed nowhere: no record in force or scheduled, and none that ends after the stationing would begin
        List<Map<String, Object>> taken = ids.isEmpty() ? List.of() : jdbc.sql("""
                select distinct on (s.organization_id) s.organization_id, si.name as site, s.valid_to
                  from org_stationing s join site si on si.id = s.site_id
                 where s.organization_id = any(string_to_array(:ids, ',')::uuid[]) and (s.valid_to is null or s.valid_to > :from)
                 order by s.organization_id, s.valid_to desc nulls first""")
                .param("ids", Db.ids(ids)).param("from", Db.ts(effective)).query().listOfRows();
        for (Map<String, Object> r : taken) {
            UUID unit = (UUID) r.get("organization_id");
            Object to = r.get("valid_to");
            String name = names.getOrDefault(unit, unit.toString());
            problems.add(to == null || Db.toInstant(to).isAfter(now)
                    ? "«" + name + "» متمركزة حالياً في «" + r.get("site") + "»؛ التهيئة للوحدات التي لا تمركز لها، والنقل بطلب إعادة تمركز."
                    : "«" + name + "»: تاريخ بدء التمركز يسبق نهاية تمركزها السابق في «" + r.get("site") + "».");
        }
        Optional<PolicyVersion> pv = policies.inForce(now);
        // the initial stationing alone needs no policy; areas are measured by the one in force (ADR-081)
        boolean anyArea = given.stream().anyMatch(u -> u != null && (u.primary() != null || u.alternative() != null));
        if (anyArea && pv.isEmpty()) {
            problems.add("لا توجد سياسة تمركز نافذة؛ ينشرها مسؤول النظام قبل تهيئة مناطق الانتشار.");
        }
        List<UnitCheck> units = new ArrayList<>();
        if (!ids.isEmpty() && pv.isPresent()) {
            StationingPolicy policy = pv.get().values();
            int version = pv.get().version();
            String siteGeo = sitePlace(in, problems);
            Map<UUID, UnitInput> byUnit = new LinkedHashMap<>();
            given.stream().filter(u -> u != null && u.organizationId() != null).forEach(u -> byUnit.putIfAbsent(u.organizationId(), u));
            for (UUID id : ids) {
                if (!names.containsKey(id)) {
                    continue;
                }
                UnitInput u = byUnit.get(id);
                if (u.primary() == null && u.alternative() == null) {
                    // the initial stationing alone: its areas come by «طلب مناطق انتشار» (owner brief, phase 2, ADR-081)
                    units.add(new UnitCheck(id, names.get(id), List.of(), List.of()));
                    continue;
                }
                List<String> own = new ArrayList<>(DeploymentRules.pair(policy.deploymentRequirement(), u.primary() != null, u.alternative() != null));
                String primaryGeo = u.primary() == null ? null : json.write(u.primary());
                String alternativeGeo = u.alternative() == null ? null : json.write(u.alternative());
                List<RestationingChecks.Leg> legs = List.of(
                        checks.deploymentLeg("primary", PRIMARY_LABEL, policy.primary(), siteGeo, primaryGeo, ids, null, policy, version, now, own),
                        checks.deploymentLeg("alternative", ALTERNATIVE_LABEL, policy.alternative(), primaryGeo, alternativeGeo, ids, null, policy, version,
                                now, own));
                units.add(new UnitCheck(id, names.get(id), own, legs));
                own.forEach(p -> problems.add("«" + names.get(id) + "»: " + p));
            }
        } else {
            ids.stream().filter(names::containsKey).forEach(id -> units.add(new UnitCheck(id, names.get(id), List.of(), List.of())));
        }
        return new Evaluation(problems, units, pv.orElse(null), effective);
    }

    /** Where the primary area is measured from: the boundary as the register will hold it, else the site's point. */
    private String sitePlace(SetupInput in, List<String> problems) {
        if (in.boundary() != null && in.boundary().geometry() != null) {
            BoundaryService.Check c = boundaries.check(json.tree((Object) in.boundary().geometry()), in.boundary().crs());
            if (!c.valid()) {
                problems.add("حدود الموقع: " + (c.problems().isEmpty() ? "غير صالحة." : c.problems().get(0)));
                return null;
            }
            return json.write(c.normalized());
        }
        SiteService.Location at = in.site() == null ? null : in.site().location();
        if (at == null) {
            problems.add("حدد مكان الموقع على الخريطة: منه تُقاس منطقة الانتشار الرئيسية.");
            return null;
        }
        return json.write(Map.of("type", "Point", "coordinates", List.of(at.lng(), at.lat())));
    }

    private static List<UUID> unitIds(SetupInput in) {
        Set<UUID> out = new LinkedHashSet<>();
        if (in.units() != null) {
            in.units().stream().filter(u -> u != null && u.organizationId() != null).forEach(u -> out.add(u.organizationId()));
        }
        return List.copyOf(out);
    }

    private Map<UUID, String> activeNames(List<UUID> ids) {
        Map<UUID, String> out = new LinkedHashMap<>();
        if (ids.isEmpty()) {
            return out;
        }
        jdbc.sql("select id, name from organization where id = any(string_to_array(:ids, ',')::uuid[]) and status = 'ACTIVE'")
                .param("ids", Db.ids(ids)).query((rs, n) -> out.put(Db.uuid(rs, "id"), rs.getString("name"))).list();
        return out;
    }

    /** A leg as the request's checks show it (the shape of {@code GET /restationing-requests/{id}/checks}). */
    static Map<String, Object> legView(RestationingChecks.Leg l) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("leg", l.leg());
        v.put("label", l.label());
        v.put("status", l.check().status().name());
        v.put("distanceM", l.check().distanceM() == null ? null : Math.round(l.check().distanceM()));
        v.put("baseMinM", l.check().baseMinM());
        v.put("baseMaxM", l.check().baseMaxM());
        v.put("effectiveMinM", l.check().effectiveMinM());
        v.put("effectiveMaxM", l.check().effectiveMaxM());
        v.put("exceptionMaxM", l.check().exceptionMaxM());
        v.put("method", "CENTROID_TO_CENTROID");
        v.put("conflicts", l.conflicts());
        if (l.terrain() != null) {
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("controllingClass", l.terrain().controllingClass());
            t.put("controllingLabel", l.terrain().controllingLabel());
            t.put("shares", l.terrain().shares());
            t.put("tie", l.terrain().tie());
            t.put("tied", l.terrain().tied());
            t.put("resolved", l.terrain().resolved());
            t.put("priority", l.terrain().priority());
            t.put("allowanceM", Math.max(0, l.check().effectiveMaxM() - l.check().baseMaxM()));
            t.put("dataset", l.terrain().datasetCode() + " " + l.terrain().datasetVersion());
            t.put("surfaceModel", l.terrain().surfaceModel());
            v.put("terrain", t);
        }
        return v;
    }

    /** The body as the idempotency record hashes it (times as text: the internal mapper has no time module). */
    private static Map<String, Object> hashable(SetupInput in) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("site", in.site());
        m.put("boundary", in.boundary());
        m.put("units", in.units());
        m.put("reason", in.reason());
        m.put("reference", in.reference());
        m.put("effectiveFrom", in.effectiveFrom() == null ? null : in.effectiveFrom().toString());
        return m;
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
