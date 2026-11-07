package ae.mover.workflow;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.flowable.engine.RepositoryService;
import org.flowable.engine.repository.Deployment;
import org.flowable.engine.repository.ProcessDefinition;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Json;
import ae.mover.forms.FormService;
import ae.mover.forms.RuleLanguage;
import ae.mover.forms.RuleLanguage.Problem;
import ae.mover.workflow.WorkflowDefinition.Stage;

@Service
public class WorkflowService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final RepositoryService repository;
    private final FormService forms;
    private final PlaceResolver places;
    private final Map<UUID, WorkflowDefinition> definitionCache = new ConcurrentHashMap<>();

    public WorkflowService(JdbcClient jdbc, Json json, Clock clock, AuditService audit, RepositoryService repository,
                           FormService forms, PlaceResolver places) {
        this.places = places;
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.repository = repository;
        this.forms = forms;
    }

    public record VersionInfo(String id, int version, String status, String name, String createdAt, String publishedAt,
                              String publishedBy) {
    }

    public record WorkflowSummary(String id, Map<String, String> requestType, VersionInfo published, VersionInfo draft) {
    }

    public record WorkflowVersionView(String id, String workflowId, int version, String status, String createdAt,
                                      String publishedAt, String publishedBy, JsonNode definition, long activeRequests,
                                      String processDefinitionId) {
    }

    public record PublishedWorkflow(UUID id, int version, String processDefinitionId, WorkflowDefinition definition) {
    }

    public record SimulationStep(String key, String name, boolean runs) {
    }

    /** One place of a step in a simulation: where it would go for the unit tried, and how many people hold the role there. */
    public record SimulatedPlace(String role, List<String> orgs, boolean anyOrg, boolean unresolved, int holders) {
    }

    /** A step the simulated request passes: its {@code taken} line, and for approval and notify steps, its places. */
    public record RouteStep(String node, String type, String name, String taken, List<SimulatedPlace> places, boolean chain) {
    }

    /** How a selector covers the organisation: which units it finds nothing for. */
    public record CoverageItem(String node, String name, String role, int total, int unresolved, List<String> sample) {
    }

    public record Simulation(boolean valid, List<Map<String, String>> errors, List<SimulationStep> path,
                             Map<String, Object> impact, List<RouteStep> route, String outcome, List<CoverageItem> coverage) {
    }

    /** The route of a chart for one unit and sample values: every approval approves, except the steps tried as rejected. */
    private List<RouteStep> route(WorkflowDefinition def, UUID org, Map<String, Object> values, Map<String, Object> facts, Set<String> rejected, String[] outcome) {
        var g = def.graph();
        List<RouteStep> out = new ArrayList<>();
        java.util.ArrayDeque<String> todo = new java.util.ArrayDeque<>();
        g.nodes().stream().filter(n -> WorkflowDefinition.START.equals(n.type())).findFirst().ifPresent(n -> todo.add(n.id()));
        Set<String> seen = new HashSet<>();
        outcome[0] = null;
        while (!todo.isEmpty()) {
            String id = todo.poll();
            if (!seen.add(id)) {
                continue;
            }
            var n = g.node(id).orElseThrow();
            String taken = null;
            List<SimulatedPlace> where = List.of();
            List<String> next = new ArrayList<>();
            switch (n.type()) {
                case WorkflowDefinition.APPROVAL -> {
                    where = n.raw().hasNonNull("chain") && org != null
                            ? chainPlaces(WorkflowDefinition.assignees(n.raw().path("assignees")).get(0).role(), n.raw().path("chain"), org)
                            : simulatedPlaces(WorkflowDefinition.assignees(n.raw().path("assignees")), org, n.raw().path("final").asBoolean(false));
                    boolean no = rejected.contains(id);
                    var line = g.from(id, no ? "rejected" : "approved");
                    taken = no ? "rejected" : "approved";
                    if (line.isPresent()) {
                        next.add(line.get().to());
                    } else {
                        outcome[0] = "REJECTED"; // no line for a rejection: the request ends rejected here
                    }
                }
                case WorkflowDefinition.DECISION -> {
                    boolean yes = RuleLanguage.evaluate(n.raw().get("condition"), values, facts);
                    taken = yes ? "yes" : "no";
                    g.from(id, taken).ifPresent(e -> next.add(e.to()));
                }
                case WorkflowDefinition.NOTIFY -> {
                    List<WorkflowDefinition.Assignee> list = new ArrayList<>();
                    n.raw().path("recipients").forEach(r -> {
                        if (!"REQUESTER".equals(r.path("kind").asText())) {
                            list.addAll(WorkflowDefinition.assignees(json.tree(json.write(List.of(r)))));
                        }
                    });
                    where = simulatedPlaces(list, org, false);
                    g.from(id).forEach(e -> next.add(e.to()));
                }
                case WorkflowDefinition.END_APPROVED -> outcome[0] = outcome[0] == null ? "APPROVED" : outcome[0];
                case WorkflowDefinition.END_REJECTED -> outcome[0] = "REJECTED";
                default -> g.from(id).forEach(e -> next.add(e.to()));
            }
            out.add(new RouteStep(id, n.type(), n.name(), taken, where, n.raw().hasNonNull("chain")));
            todo.addAll(next);
            if ("REJECTED".equals(outcome[0])) {
                break;
            }
        }
        return out;
    }

    /** Every unit a climbing approval passes for this requesting unit, with who holds the role there; the page marks what it skips. */
    private List<SimulatedPlace> chainPlaces(String role, JsonNode chain, UUID org) {
        List<SimulatedPlace> out = new ArrayList<>();
        for (var u : places.chain(chain, org)) {
            out.add(new SimulatedPlace(role, List.of(u.name()), false, false, places.holders(role, new PlaceResolver.Place(List.of(u.id()), false, false)).size()));
        }
        return out;
    }

    private List<SimulatedPlace> simulatedPlaces(List<WorkflowDefinition.Assignee> list, UUID org, boolean finalStep) {
        List<SimulatedPlace> out = new ArrayList<>();
        for (var a : list) {
            if ("BY_SCOPE".equals(a.orgFrom()) && org != null) {
                var m = places.scope(a.role(), org);
                List<String> at = finalStep && m.people().isEmpty() ? List.of("لا يوجد من يعتمد بعد: لا يكتمل الطلب حتى يُمنح هذا الدور")
                        : !m.required() ? List.of("لا يوجد هذا الدور في هذه الوحدة الرئيسية، فتُتخطى الخطوة")
                        : m.people().isEmpty() ? List.of("لا يوجد معتمد يشمل نطاقه هذه الوحدة، فيُرفض الإرسال")
                        : m.anchor() == null ? List.of() : jdbc.sql("select name from organization where id = :id").param("id", m.anchor()).query(String.class).list();
                out.add(new SimulatedPlace(a.role(), at, m.everywhere(), false, m.people().size()));
                continue;
            }
            var p = org == null ? new PlaceResolver.Place(List.of(), true, false) : places.resolve(a, org, List.of());
            List<String> names = p.orgs().isEmpty() ? List.of() : jdbc.sql("select name from organization where id = any(string_to_array(:ids, ',')::uuid[]) order by name")
                    .param("ids", Db.ids(p.orgs())).query(String.class).list();
            out.add(new SimulatedPlace(a.role(), names, p.anyOrg(), p.unresolved(), places.holders(a.role(), p).size()));
        }
        return out;
    }

    /**
     * Before a request is sent: a step on its route found by scope with nobody reaching this unit. It is refused with a clear
     * message rather than left waiting for nobody or given to a guess (ADR-042, as in the movement programme).
     */
    public Optional<String> scopeProblem(WorkflowDefinition def, UUID org, Map<String, Object> values, Map<String, Object> facts) {
        if (def.graph() == null) {
            return Optional.empty();
        }
        Map<String, Object> f = new HashMap<>(facts);
        f.putAll(places.unitFacts(org));
        for (RouteStep step : route(def, org, values, f, Set.of(), new String[1])) {
            if (!WorkflowDefinition.APPROVAL.equals(step.type())) {
                continue;
            }
            var node = def.graph().node(step.node()).orElseThrow();
            var list = WorkflowDefinition.assignees(node.raw().path("assignees"));
            if (node.raw().hasNonNull("chain")) {
                var gap = places.chainGap(list.get(0).role(), node.raw().path("chain"), org);
                if (gap.isPresent()) {
                    return Optional.of("لا يوجد معتمد في «" + gap.get().name() + "» لخطوة «" + step.name() + "»؛ يحدده مسؤول الصلاحيات قبل الإرسال.");
                }
                continue;
            }
            boolean isFinal = node.raw().path("final").asBoolean(false);
            for (var a : list) {
                if ("BY_SCOPE".equals(a.orgFrom())) {
                    var m = places.scope(a.role(), org);
                    if (m.routed() != null && m.routed().isEmpty()) {
                        return Optional.of("لا توجد فترة تغطي هذا الوقت لخطوة «" + step.name() + "»؛ يحددها مسؤول الصلاحيات قبل الإرسال.");
                    }
                    if (m.people().isEmpty() && (m.required() || isFinal)) {
                        return Optional.of("لا يوجد معتمد يشمل نطاقه وحدتك لخطوة «" + step.name() + "»؛ يحدده مسؤول الصلاحيات قبل الإرسال.");
                    }
                }
            }
        }
        return Optional.empty();
    }

    private List<CoverageItem> coverage(WorkflowDefinition def) {
        List<CoverageItem> out = new ArrayList<>();
        Set<String> done = new HashSet<>();
        for (var n : def.graph().nodes()) {
            List<WorkflowDefinition.Assignee> list = new ArrayList<>();
            if (WorkflowDefinition.APPROVAL.equals(n.type())) {
                list.addAll(WorkflowDefinition.assignees(n.raw().path("assignees")));
            } else if (WorkflowDefinition.NOTIFY.equals(n.type())) {
                n.raw().path("recipients").forEach(r -> {
                    if (!"REQUESTER".equals(r.path("kind").asText())) {
                        list.addAll(WorkflowDefinition.assignees(json.tree(json.write(List.of(r)))));
                    }
                });
            }
            for (var a : list) {
                var c = places.coverage(a, 5);
                if (c.unresolved() > 0 && done.add(n.id() + "|" + a)) {
                    out.add(new CoverageItem(n.id(), n.name(), a.role(), c.total(), c.unresolved(), c.sample()));
                }
            }
        }
        return out;
    }

    private GraphValidator.Places placesCheck() {
        return new GraphValidator.Places() {
            @Override
            public boolean orgExists(UUID id) {
                return jdbc.sql("select count(*) from organization where id = :id and status = 'ACTIVE'").param("id", id).query(Long.class).single() > 0;
            }

            @Override
            public boolean responsibilityExists(String code) {
                return jdbc.sql("select count(*) from org_responsibility where code = :c").param("c", code).query(Long.class).single() > 0;
            }
        };
    }

    // ---- responsibilities: who carries a duty for a part of the organisation (ADR-041) -------------------------------

    public record ResponsibilityRule(String scopeOrgId, String scopeOrgName, String responsibleOrgId, String responsibleOrgName) {
    }

    public record Responsibility(String code, String name, List<ResponsibilityRule> rules) {
    }

    public List<Responsibility> responsibilities(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        return jdbc.sql("select code, name from org_responsibility order by name")
                .query((rs, n) -> new Responsibility(rs.getString("code"), rs.getString("name"), jdbc.sql("""
                        select r.scope_org_id, s.name as scope_name, r.responsible_org_id, o.name as org_name
                        from org_responsibility_rule r join organization s on s.id = r.scope_org_id join organization o on o.id = r.responsible_org_id
                        where r.responsibility_code = :c order by s.name""").param("c", rs.getString("code"))
                        .query((x, m) -> new ResponsibilityRule(x.getString("scope_org_id"), x.getString("scope_name"), x.getString("responsible_org_id"), x.getString("org_name"))).list()))
                .list();
    }

    @Transactional
    public List<Responsibility> saveResponsibility(AccessContext ctx, String name) {
        ctx.require(Permission.CONFIGURE);
        String clean = name == null ? "" : name.trim();
        if (clean.length() < 2 || clean.length() > 120) {
            throw ApiException.validation("اكتب اسم المسؤولية.");
        }
        String code = "r_" + UUID.randomUUID().toString().substring(0, 8);
        jdbc.sql("insert into org_responsibility(code, name, created_by) values (:c, :n, :by)").param("c", code).param("n", clean).param("by", ctx.personId()).update();
        audit.recordAs(ctx.actor(), "RESPONSIBILITY_CREATED", "RESPONSIBILITY", code, clean, Map.of(), null);
        return responsibilities(ctx);
    }

    @Transactional
    public List<Responsibility> setResponsibilityRule(AccessContext ctx, String code, UUID scope, UUID responsible) {
        ctx.require(Permission.CONFIGURE);
        if (!placesCheck().responsibilityExists(code) || !placesCheck().orgExists(scope) || !placesCheck().orgExists(responsible)) {
            throw ApiException.validation("المسؤولية أو الجهة غير موجودة.");
        }
        jdbc.sql("""
                insert into org_responsibility_rule(responsibility_code, scope_org_id, responsible_org_id, updated_at, updated_by)
                values (:c, :s, :o, :at, :by)
                on conflict (responsibility_code, scope_org_id) do update set responsible_org_id = :o, updated_at = :at, updated_by = :by""")
                .param("c", code).param("s", scope).param("o", responsible).param("at", Db.ts(clock.instant())).param("by", ctx.personId()).update();
        audit.recordAs(ctx.actor(), "RESPONSIBILITY_RULE_SET", "RESPONSIBILITY", code, null, Map.of("scopeOrgId", scope.toString(), "responsibleOrgId", responsible.toString()), null);
        return responsibilities(ctx);
    }

    @Transactional
    public List<Responsibility> removeResponsibilityRule(AccessContext ctx, String code, UUID scope) {
        ctx.require(Permission.CONFIGURE);
        jdbc.sql("delete from org_responsibility_rule where responsibility_code = :c and scope_org_id = :s").param("c", code).param("s", scope).update();
        audit.recordAs(ctx.actor(), "RESPONSIBILITY_RULE_REMOVED", "RESPONSIBILITY", code, null, Map.of("scopeOrgId", scope.toString()), null);
        return responsibilities(ctx);
    }

    public List<WorkflowSummary> list(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        return jdbc.sql("""
                select w.id, t.code, t.name, t.kind from workflow_definition w join request_type t on t.code = w.request_type_code and t.active
                order by t.sort_order""")
                .query((rs, n) -> new WorkflowSummary(rs.getString("id"),
                        Map.of("id", rs.getString("code"), "code", rs.getString("code"), "name", rs.getString("name"), "kind", rs.getString("kind")),
                        versionInfo(Db.uuid(rs, "id"), "PUBLISHED"), versionInfo(Db.uuid(rs, "id"), "DRAFT")))
                .list();
    }

    private VersionInfo versionInfo(UUID workflowId, String status) {
        return jdbc.sql("""
                select v.id, v.version, v.status, v.definition->>'name' as name, v.created_at, v.published_at, p.display_name
                from workflow_version v left join person p on p.id = v.published_by
                where v.workflow_id = :w and v.status = :s order by v.version desc limit 1""")
                .param("w", workflowId).param("s", status)
                .query((rs, n) -> new VersionInfo(rs.getString("id"), rs.getInt("version"), rs.getString("status"),
                        rs.getString("name"), Db.iso(rs, "created_at"), Db.iso(rs, "published_at"), rs.getString("display_name")))
                .optional().orElse(null);
    }

    public WorkflowVersionView get(AccessContext ctx, UUID versionId) {
        ctx.require(Permission.CONFIGURE);
        return jdbc.sql("""
                select v.*, v.definition::text as def_text, p.display_name,
                       (select count(*) from request r where r.workflow_version_id = v.id and r.status = 'SUBMITTED') as active
                from workflow_version v left join person p on p.id = v.published_by where v.id = :id""")
                .param("id", versionId)
                .query((rs, n) -> new WorkflowVersionView(rs.getString("id"), rs.getString("workflow_id"), rs.getInt("version"),
                        rs.getString("status"), Db.iso(rs, "created_at"), Db.iso(rs, "published_at"),
                        rs.getString("display_name"), json.tree(rs.getString("def_text")), rs.getLong("active"),
                        rs.getString("process_definition_id")))
                .optional().orElseThrow(ApiException::notFound);
    }

    public String bpmn(AccessContext ctx, UUID versionId) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> row = jdbc.sql("""
                select v.bpmn_xml, v.definition::text as def_text, w.request_type_code
                from workflow_version v join workflow_definition w on w.id = v.workflow_id where v.id = :id""")
                .param("id", versionId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (row.get("bpmn_xml") != null) {
            return (String) row.get("bpmn_xml");
        }
        return BpmnCompiler.compile((String) row.get("request_type_code"),
                WorkflowDefinition.from(json.tree((String) row.get("def_text"))));
    }

    /** Pinned definitions never change after publication, so they are safe to cache by version id. */
    public WorkflowDefinition definition(UUID versionId) {
        return definitionCache.computeIfAbsent(versionId, id -> WorkflowDefinition.from(json.tree(
                jdbc.sql("select definition::text from workflow_version where id = :id").param("id", id)
                        .query(String.class).optional().orElseThrow(ApiException::notFound))));
    }

    public int versionNumber(UUID versionId) {
        return jdbc.sql("select version from workflow_version where id = :id").param("id", versionId).query(Integer.class).single();
    }

    public PublishedWorkflow latestPublished(String typeCode) {
        return jdbc.sql("""
                select v.id, v.version, v.process_definition_id from workflow_version v
                join workflow_definition w on w.id = v.workflow_id
                where w.request_type_code = :t and v.status = 'PUBLISHED' order by v.version desc limit 1""")
                .param("t", typeCode)
                .query((rs, n) -> new PublishedWorkflow(Db.uuid(rs, "id"), rs.getInt("version"),
                        rs.getString("process_definition_id"), definition(Db.uuid(rs, "id"))))
                .optional().orElse(null);
    }

    public String processDefinitionId(UUID versionId) {
        return jdbc.sql("select process_definition_id from workflow_version where id = :id").param("id", versionId)
                .query(String.class).optional().orElse(null);
    }

    @Transactional
    public WorkflowVersionView saveDraft(AccessContext ctx, UUID workflowId, JsonNode definition) {
        ctx.require(Permission.CONFIGURE);
        jdbc.sql("select id from workflow_definition where id = :id for update").param("id", workflowId)
                .query(UUID.class).optional().orElseThrow(ApiException::notFound);
        UUID existing = jdbc.sql("select id from workflow_version where workflow_id = :w and status = 'DRAFT'")
                .param("w", workflowId).query(UUID.class).optional().orElse(null);
        UUID id = existing != null ? existing : UUID.randomUUID();
        if (existing != null) {
            jdbc.sql("update workflow_version set definition = cast(:d as jsonb), created_by = :by, created_at = :at where id = :id")
                    .param("d", json.write(definition)).param("by", ctx.personId()).param("at", Db.ts(clock.instant()))
                    .param("id", id).update();
        } else {
            int next = jdbc.sql("select coalesce(max(version), 0) + 1 from workflow_version where workflow_id = :w")
                    .param("w", workflowId).query(Integer.class).single();
            jdbc.sql("""
                    insert into workflow_version(id, workflow_id, version, status, definition, created_by, created_at)
                    values (:id, :w, :v, 'DRAFT', cast(:d as jsonb), :by, :at)""")
                    .param("id", id).param("w", workflowId).param("v", next).param("d", json.write(definition))
                    .param("by", ctx.personId()).param("at", Db.ts(clock.instant())).update();
        }
        audit.recordAs(ctx.actor(), "WORKFLOW_DRAFT_SAVED", "WORKFLOW", workflowId.toString(), null,
                Map.of("versionId", id.toString()), null);
        return get(ctx, id);
    }

    private Map<String, Set<String>> rolePermissions() {
        Map<String, Set<String>> out = new HashMap<>();
        jdbc.sql("select code, permissions from role_def").query((rs, n) -> {
            out.put(rs.getString("code"), new HashSet<>(Db.strings(rs, "permissions")));
            return null;
        }).list();
        return out;
    }

    private String typeOf(UUID workflowId) {
        return jdbc.sql("select request_type_code from workflow_definition where id = :id").param("id", workflowId)
                .query(String.class).optional().orElseThrow(ApiException::notFound);
    }

    private Set<String> fieldIds(String typeCode) {
        Set<String> ids = new HashSet<>();
        try {
            forms.latestPublished(typeCode).schema().path("fields").forEach(f -> ids.add(f.path("id").asText()));
        } catch (ApiException e) {
            // no published form yet: conditions may only use facts
        }
        return ids;
    }

    private List<Problem> validateVersion(UUID workflowId, JsonNode def) {
        return WorkflowValidator.validate(def, rolePermissions(), fieldIds(typeOf(workflowId)), placesCheck());
    }

    public Simulation simulate(AccessContext ctx, UUID versionId, Map<String, Object> facts) {
        ctx.require(Permission.CONFIGURE);
        WorkflowVersionView v = get(ctx, versionId);
        List<Problem> problems = validateVersion(UUID.fromString(v.workflowId()), v.definition());
        List<SimulationStep> path = new ArrayList<>();
        List<RouteStep> route = List.of();
        List<CoverageItem> cover = List.of();
        String result = null;
        if (problems.isEmpty()) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("resourceCount", facts.getOrDefault("resourceCount", 1));
            f.put("durationDays", facts.getOrDefault("durationDays", 1));
            f.put("durationHours", facts.getOrDefault("durationHours", 24));
            f.put("participantCount", facts.getOrDefault("participantCount", 1));
            f.put("requestType", typeOf(UUID.fromString(v.workflowId())));
            @SuppressWarnings("unchecked")
            Map<String, Object> values = facts.get("values") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
            WorkflowDefinition def = WorkflowDefinition.from(v.definition());
            if (def.graph() != null) {
                UUID org = facts.get("orgId") == null || String.valueOf(facts.get("orgId")).isBlank() ? null : UUID.fromString(String.valueOf(facts.get("orgId")));
                if (org != null) {
                    f.putAll(places.unitFacts(org));
                }
                Set<String> rejected = new HashSet<>();
                if (facts.get("rejected") instanceof List<?> l) {
                    l.forEach(x -> rejected.add(String.valueOf(x)));
                }
                String[] outcome = new String[1];
                route = route(def, org, values, f, rejected, outcome);
                result = outcome[0];
                // a final approval is never passed: with nobody to give it, the request cannot end approved
                if (org != null && !"REJECTED".equals(result) && route.stream().anyMatch(s -> WorkflowDefinition.APPROVAL.equals(s.type())
                        && def.graph().node(s.node()).orElseThrow().raw().path("final").asBoolean(false)
                        && !s.places().isEmpty() && s.places().stream().allMatch(p -> p.holders() == 0))) {
                    result = "NO_FINAL_APPROVER";
                }
                cover = coverage(def);
                route.stream().filter(r -> WorkflowDefinition.APPROVAL.equals(r.type())).forEach(r -> path.add(new SimulationStep(r.node(), r.name(), true)));
            } else {
                for (Stage s : def.stages()) {
                    path.add(new SimulationStep(s.key(), s.name(), RuleLanguage.evaluate(s.condition(), values, f)));
                }
            }
        }
        long older = jdbc.sql("""
                select count(*) from request r join workflow_version v on v.id = r.workflow_version_id
                where v.workflow_id = :w and v.id <> :id and r.status in ('SUBMITTED', 'RETURNED')""")
                .param("w", UUID.fromString(v.workflowId())).param("id", versionId).query(Long.class).single();
        Map<String, Object> impact = new LinkedHashMap<>();
        impact.put("inFlightOnOlderVersions", older);
        impact.put("message", older == 0
                ? "لا توجد طلبات قائمة على إصدارات سابقة. الطلبات الجديدة فقط تستخدم الإصدار بعد النشر."
                : older + " طلب قائم يبقى على إصداره السابق دون تغيير. الطلبات الجديدة فقط تستخدم الإصدار بعد النشر.");
        return new Simulation(problems.isEmpty(),
                problems.stream().map(p -> Map.of("path", p.path(), "message", p.message())).toList(), path, impact, route, result, cover);
    }

    @Transactional
    public WorkflowVersionView publish(AccessContext ctx, UUID versionId) {
        ctx.require(Permission.CONFIGURE);
        publishInternal(ctx, versionId);
        return get(ctx, versionId);
    }

    /** Validates, compiles to BPMN and deploys to Flowable in the caller's transaction. */
    @Transactional
    public void publishInternal(AccessContext ctx, UUID versionId) {
        Map<String, Object> row = jdbc.sql("""
                select v.workflow_id, v.version, v.status, v.definition::text as def_text, w.request_type_code
                from workflow_version v join workflow_definition w on w.id = v.workflow_id where v.id = :id for update of v""")
                .param("id", versionId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!"DRAFT".equals(row.get("status"))) {
            throw ApiException.validation("يمكن نشر المسودات فقط؛ الإصدارات المنشورة غير قابلة للتعديل.");
        }
        UUID workflowId = (UUID) row.get("workflow_id");
        JsonNode def = json.tree((String) row.get("def_text"));
        List<Problem> problems = validateVersion(workflowId, def);
        if (!problems.isEmpty()) {
            throw new ApiException(ErrorCode.INVALID_WORKFLOW, "تعريف التدفق غير صالح.",
                    Map.of("errors", problems.stream().map(p -> Map.of("path", p.path(), "message", p.message())).toList()));
        }
        String type = (String) row.get("request_type_code");
        String xml = BpmnCompiler.compile(type, WorkflowDefinition.from(def));
        Deployment deployment;
        ProcessDefinition pd;
        try {
            deployment = repository.createDeployment()
                    .name(type + " v" + row.get("version"))
                    .key(BpmnCompiler.processKey(type))
                    .addString(BpmnCompiler.processKey(type) + ".bpmn20.xml", xml)
                    .deploy();
            pd = repository.createProcessDefinitionQuery().deploymentId(deployment.getId()).singleResult();
        } catch (RuntimeException e) {
            throw new ApiException(ErrorCode.INVALID_WORKFLOW, "تعذر نشر تعريف BPMN في محرك الإجراءات: " + e.getMessage());
        }
        jdbc.sql("update workflow_version set status = 'RETIRED' where workflow_id = :w and status = 'PUBLISHED'")
                .param("w", workflowId).update();
        jdbc.sql("""
                update workflow_version set status = 'PUBLISHED', bpmn_xml = :x, deployment_id = :d, process_definition_id = :p,
                       published_by = :by, published_at = :at where id = :id""")
                .param("x", xml).param("d", deployment.getId()).param("p", pd.getId())
                .param("by", ctx == null ? null : ctx.personId()).param("at", Db.ts(clock.instant())).param("id", versionId)
                .update();
        if (ctx != null) {
            audit.recordAs(ctx.actor(), "WORKFLOW_PUBLISHED", "WORKFLOW", workflowId.toString(), "v" + row.get("version"),
                    Map.of("versionId", versionId.toString(), "processDefinitionId", pd.getId()), null);
        }
    }
}
