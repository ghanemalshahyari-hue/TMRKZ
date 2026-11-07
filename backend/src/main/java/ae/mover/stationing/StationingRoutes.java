package ae.mover.stationing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.stationing.RouteDerivation.RouteStage;
import ae.mover.stationing.StationingPolicy.ApprovalStages;
import ae.mover.stationing.StationingPolicy.Routing;
import ae.mover.stationing.StationingPolicy.RoutingLevel;

/**
 * The approval path of each stationing request type (ADR-046): which Oracle levels approve, and which stages follow. Saved as a
 * draft, tried on a unit, then activated with a reason. It names levels and stages, never a person: who decides is what the
 * grants say. A type with no activated version follows the policy's route. Requests are pinned to the version they started on.
 */
@Service
public class StationingRoutes {

    public static final List<String> PURPOSES = List.of(RestationingChecks.RESTATIONING, RestationingChecks.INITIAL_STATIONING,
            RestationingChecks.DEPLOYMENT_AREAS, RestationingChecks.SITE_REGISTRATION);

    /** What a request's route is built from. */
    public record RouteRule(Routing routing, ApprovalStages stages) {
    }

    public record RouteInput(Routing routing, ApprovalStages stages) {
    }

    public record SimulateInput(Routing routing, ApprovalStages stages, UUID orgId) {
    }

    public record PublishInput(String reason) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final AuditService audit;
    private final OrgHierarchy hierarchy;

    public StationingRoutes(JdbcClient jdbc, Json json, AuditService audit, OrgHierarchy hierarchy) {
        this.jdbc = jdbc;
        this.json = json;
        this.audit = audit;
        this.hierarchy = hierarchy;
    }

    private static void requirePurpose(String purpose) {
        if (!PURPOSES.contains(purpose)) {
            throw ApiException.validation("نوع طلب غير معروف.");
        }
    }

    private RouteRule rule(String routing, String stages) {
        return new RouteRule(json.read(routing, Routing.class), json.read(stages, ApprovalStages.class));
    }

    /** The version activated last for this type, as (id, rule), or empty. */
    public Optional<Map.Entry<UUID, RouteRule>> published(String purpose) {
        return jdbc.sql("""
                select id, routing::text as routing, stages::text as stages from stationing_route_version
                 where purpose = :p and status = 'PUBLISHED' order by version desc limit 1""")
                .param("p", purpose).query((rs, n) -> Map.entry(Db.uuid(rs, "id"), rule(rs.getString("routing"), rs.getString("stages")))).optional();
    }

    public Optional<RouteRule> byId(UUID id) {
        return jdbc.sql("select routing::text as routing, stages::text as stages from stationing_route_version where id = :id")
                .param("id", id).query((rs, n) -> rule(rs.getString("routing"), rs.getString("stages"))).optional();
    }

    private Map<String, Object> versionView(String purpose, String status) {
        return jdbc.sql("""
                select v.id, v.version, v.routing::text as routing, v.stages::text as stages, v.reason, v.published_at, p.display_name
                  from stationing_route_version v left join person p on p.id = v.published_by
                 where v.purpose = :p and v.status = :s order by v.version desc limit 1""")
                .param("p", purpose).param("s", status).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("version", rs.getInt("version"));
                    m.put("routing", json.map(rs.getString("routing")));
                    m.put("stages", json.map(rs.getString("stages")));
                    m.put("reason", rs.getString("reason"));
                    m.put("publishedAt", Db.iso(rs, "published_at"));
                    m.put("publishedBy", rs.getString("display_name"));
                    return m;
                }).optional().orElse(null);
    }

    /** Every type with its activated path and its draft, and whether requests can be sent at all yet. */
    public Map<String, Object> list(AccessContext ctx, boolean policyInForce) {
        ctx.require(Permission.CONFIGURE);
        List<Map<String, Object>> out = new ArrayList<>();
        for (String purpose : PURPOSES) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("purpose", purpose);
            m.put("published", versionView(purpose, "PUBLISHED"));
            m.put("draft", versionView(purpose, "DRAFT"));
            out.add(m);
        }
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("routes", out);
        r.put("policyInForce", policyInForce);
        return r;
    }

    /** What makes a path unusable, in the person's words. */
    static List<String> problems(Routing routing, ApprovalStages stages) {
        List<String> out = new ArrayList<>();
        if (routing == null || routing.levels() == null || routing.startAt() == null) {
            out.add("حدد المستويات وبداية المسار.");
            return out;
        }
        Set<Integer> seen = new HashSet<>();
        for (RoutingLevel l : routing.levels()) {
            if (!seen.add(l.level())) {
                out.add("المستوى L" + l.level() + " مكرر.");
            }
            if (l.approves() && (l.label() == null || l.label().isBlank())) {
                out.add("اكتب اسم مرحلة المستوى L" + l.level() + ".");
            }
        }
        List<RoutingLevel> last = routing.levels().stream().filter(RoutingLevel::finalStage).toList();
        if (last.size() != 1) {
            out.add("حدد مستوى واحداً يكون آخر مستوى في التسلسل.");
        } else if (!last.get(0).approves()) {
            out.add("آخر مستوى في التسلسل يجب أن يعتمد.");
        }
        if (stages == null) {
            out.add("حدد مراحل ما بعد التسلسل.");
        }
        return out;
    }

    @Transactional
    public Map<String, Object> saveDraft(AccessContext ctx, String purpose, RouteInput in, Instant now) {
        ctx.require(Permission.CONFIGURE);
        requirePurpose(purpose);
        if (in == null) {
            throw ApiException.validation("حدد المسار.");
        }
        List<String> problems = problems(in.routing(), in.stages());
        if (!problems.isEmpty()) {
            throw ApiException.validation(problems.get(0), Map.of("problems", problems));
        }
        int updated = jdbc.sql("""
                update stationing_route_version set routing = cast(:r as jsonb), stages = cast(:s as jsonb), created_by = :by, created_at = :now
                 where purpose = :p and status = 'DRAFT'""")
                .param("r", json.write(in.routing())).param("s", json.write(in.stages())).param("by", ctx.personId()).param("now", Db.ts(now)).param("p", purpose).update();
        if (updated == 0) {
            int next = jdbc.sql("select coalesce(max(version), 0) + 1 from stationing_route_version where purpose = :p").param("p", purpose).query(Integer.class).single();
            jdbc.sql("""
                    insert into stationing_route_version(id, purpose, version, status, routing, stages, created_by, created_at)
                    values (:id, :p, :v, 'DRAFT', cast(:r as jsonb), cast(:s as jsonb), :by, :now)""")
                    .param("id", UUID.randomUUID()).param("p", purpose).param("v", next).param("r", json.write(in.routing()))
                    .param("s", json.write(in.stages())).param("by", ctx.personId()).param("now", Db.ts(now)).update();
        }
        audit.recordAs(ctx.actor(), "STATIONING_ROUTE_DRAFT_SAVED", "STATIONING_ROUTE", purpose, purpose, Map.of("levels", in.routing().levels().size()), null);
        return versionView(purpose, "DRAFT");
    }

    @Transactional
    public Map<String, Object> publish(AccessContext ctx, String purpose, PublishInput in, Instant now) {
        ctx.require(Permission.CONFIGURE);
        requirePurpose(purpose);
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 5) {
            throw ApiException.validation("اكتب سبب تفعيل المسار (5 أحرف على الأقل).");
        }
        Map<String, Object> draft = jdbc.sql("select id, routing::text as routing, stages::text as stages, version from stationing_route_version where purpose = :p and status = 'DRAFT' for update")
                .param("p", purpose).query().listOfRows().stream().findFirst().orElseThrow(() -> ApiException.validation("احفظ المسار أولاً."));
        RouteRule r = rule(draft.get("routing").toString(), draft.get("stages").toString());
        List<String> problems = problems(r.routing(), r.stages());
        if (!problems.isEmpty()) {
            throw ApiException.validation(problems.get(0), Map.of("problems", problems));
        }
        jdbc.sql("update stationing_route_version set status = 'PUBLISHED', reason = :why, published_by = :by, published_at = :now where id = :id")
                .param("why", reason).param("by", ctx.personId()).param("now", Db.ts(now)).param("id", draft.get("id")).update();
        audit.recordAs(ctx.actor(), "STATIONING_ROUTE_PUBLISHED", "STATIONING_ROUTE", purpose, purpose, Map.of("version", draft.get("version")), reason);
        return versionView(purpose, "PUBLISHED");
    }

    /** The path as one unit would get it, with how many people could decide each stage now. Writes nothing. */
    public Map<String, Object> simulate(AccessContext ctx, String purpose, SimulateInput in) {
        ctx.require(Permission.CONFIGURE);
        requirePurpose(purpose);
        if (in == null || in.orgId() == null) {
            throw ApiException.validation("اختر الوحدة.");
        }
        List<String> problems = new ArrayList<>(problems(in.routing(), in.stages()));
        Map<String, Object> out = new LinkedHashMap<>();
        List<Map<String, Object>> stages = new ArrayList<>();
        boolean complete = false;
        if (problems.isEmpty()) {
            List<OrgUnit> path = hierarchy.path(in.orgId());
            List<RouteStage> route = RouteDerivation.withConfiguredStages(
                    RouteDerivation.derive(path, in.routing(), new StationingPolicy.CrossBranch(false, List.of(), false), List.of(), false), in.stages());
            complete = RouteDerivation.complete(route);
            if (!complete) {
                problems.add("لا يصل المسار من هذه الوحدة إلى آخر مستوى محدد؛ لن يُقبل إرسال طلبها.");
            }
            Set<UUID> ids = new HashSet<>();
            path.forEach(u -> ids.add(u.id()));
            for (RouteStage s : route) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("key", s.key());
                m.put("kind", s.kind().name());
                m.put("label", s.label());
                m.put("unit", s.unit() == null ? null : path.stream().filter(u -> u.id().equals(s.unit())).map(OrgUnit::name).findFirst().orElse(null));
                m.put("holders", s.unit() != null ? seatHolders(s.unit()) : holders(s.kind() == RouteDerivation.Kind.UNIT_OPERATIONS ? "DECIDE_UNIT_OPERATIONS" : "FINAL_APPROVE_STATIONING", ids));
                stages.add(m);
            }
            if (Boolean.TRUE.equals(in.stages().fyiBeforeActivation())) {
                out.put("fyiHolders", holders("MANAGE_FYI_DISTRIBUTION", ids));
            }
            out.put("activators", holders("ACTIVATE_STATIONING", ids));
        }
        out.put("stages", stages);
        out.put("complete", complete);
        out.put("problems", problems);
        return out;
    }

    private long seatHolders(UUID unit) {
        return jdbc.sql("""
                select count(distinct m.person_id) from membership m join role_def r on r.code = m.role_code
                 where m.organization_id = :u and r.scope <> 'ALL' and 'APPROVE' = any(r.permissions)
                   and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())""").param("u", unit).query(Long.class).single();
    }

    /** People holding the right through a grant at this unit, one above it, or across everything. A grant's narrower targets are not read here: it is a guide, and the decision itself checks them. */
    private long holders(String permission, Set<UUID> path) {
        return jdbc.sql("""
                select count(distinct m.person_id) from membership m join role_def r on r.code = m.role_code
                 where :perm = any(r.permissions) and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
                   and (r.scope = 'ALL' or m.scope_all or m.organization_id = any(string_to_array(:ids, ',')::uuid[]))""")
                .param("perm", permission).param("ids", Db.ids(List.copyOf(path))).query(Long.class).single();
    }
}
