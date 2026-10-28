package ae.mover.workflow;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
    private final Map<UUID, WorkflowDefinition> definitionCache = new ConcurrentHashMap<>();

    public WorkflowService(JdbcClient jdbc, Json json, Clock clock, AuditService audit, RepositoryService repository,
                           FormService forms) {
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

    public record Simulation(boolean valid, List<Map<String, String>> errors, List<SimulationStep> path,
                             Map<String, Object> impact) {
    }

    public List<WorkflowSummary> list(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        return jdbc.sql("""
                select w.id, t.code, t.name from workflow_definition w join request_type t on t.code = w.request_type_code
                order by t.sort_order""")
                .query((rs, n) -> new WorkflowSummary(rs.getString("id"),
                        Map.of("id", rs.getString("code"), "code", rs.getString("code"), "name", rs.getString("name")),
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
        return WorkflowValidator.validate(def, rolePermissions(), fieldIds(typeOf(workflowId)));
    }

    public Simulation simulate(AccessContext ctx, UUID versionId, Map<String, Object> facts) {
        ctx.require(Permission.CONFIGURE);
        WorkflowVersionView v = get(ctx, versionId);
        List<Problem> problems = validateVersion(UUID.fromString(v.workflowId()), v.definition());
        List<SimulationStep> path = new ArrayList<>();
        if (problems.isEmpty()) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("resourceCount", facts.getOrDefault("resourceCount", 1));
            f.put("durationDays", facts.getOrDefault("durationDays", 1));
            f.put("durationHours", facts.getOrDefault("durationHours", 24));
            f.put("participantCount", facts.getOrDefault("participantCount", 1));
            f.put("requestType", typeOf(UUID.fromString(v.workflowId())));
            @SuppressWarnings("unchecked")
            Map<String, Object> values = facts.get("values") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
            for (Stage s : WorkflowDefinition.from(v.definition()).stages()) {
                path.add(new SimulationStep(s.key(), s.name(), RuleLanguage.evaluate(s.condition(), values, f)));
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
                problems.stream().map(p -> Map.of("path", p.path(), "message", p.message())).toList(), path, impact);
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
