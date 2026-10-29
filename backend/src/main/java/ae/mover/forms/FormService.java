package ae.mover.forms;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.forms.RuleLanguage.Problem;

@Service
public class FormService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;

    public FormService(JdbcClient jdbc, Json json, Clock clock, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
    }

    public record VersionInfo(String id, int version, String status, String createdAt, String publishedAt, String publishedBy) {
    }

    public record FormSummary(String id, Map<String, String> requestType, VersionInfo published, VersionInfo draft) {
    }

    public record FormVersionView(String id, String formId, int version, String status, String createdAt,
                                  String publishedAt, String publishedBy, JsonNode schema) {
    }

    public record ValidationResult(boolean valid, List<Map<String, String>> errors) {
    }

    public record PublishedForm(UUID id, int version, JsonNode schema) {
    }

    public List<FormSummary> list(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        return jdbc.sql("""
                select f.id, t.code, t.name from form_definition f join request_type t on t.code = f.request_type_code
                order by t.sort_order""")
                .query((rs, n) -> new FormSummary(rs.getString("id"),
                        Map.of("id", rs.getString("code"), "code", rs.getString("code"), "name", rs.getString("name")),
                        versionInfo(Db.uuid(rs, "id"), "PUBLISHED"), versionInfo(Db.uuid(rs, "id"), "DRAFT")))
                .list();
    }

    private VersionInfo versionInfo(UUID formId, String status) {
        return jdbc.sql("""
                select v.id, v.version, v.status, v.created_at, v.published_at, p.display_name
                from form_version v left join person p on p.id = v.published_by
                where v.form_id = :f and v.status = :s order by v.version desc limit 1""")
                .param("f", formId).param("s", status)
                .query((rs, n) -> new VersionInfo(rs.getString("id"), rs.getInt("version"), rs.getString("status"),
                        Db.iso(rs, "created_at"), Db.iso(rs, "published_at"), rs.getString("display_name")))
                .optional().orElse(null);
    }

    public FormVersionView get(AccessContext ctx, UUID versionId) {
        ctx.require(Permission.CONFIGURE);
        return view(versionId);
    }

    public FormVersionView view(UUID versionId) {
        return jdbc.sql("""
                select v.*, v.schema::text as schema_text, p.display_name from form_version v left join person p on p.id = v.published_by
                where v.id = :id""").param("id", versionId)
                .query((rs, n) -> new FormVersionView(rs.getString("id"), rs.getString("form_id"), rs.getInt("version"),
                        rs.getString("status"), Db.iso(rs, "created_at"), Db.iso(rs, "published_at"),
                        rs.getString("display_name"), json.tree(rs.getString("schema_text"))))
                .optional().orElseThrow(ApiException::notFound);
    }

    public JsonNode schema(UUID versionId) {
        return jdbc.sql("select schema::text from form_version where id = :id").param("id", versionId)
                .query(String.class).optional().map(json::tree).orElseThrow(ApiException::notFound);
    }

    public int versionNumber(UUID versionId) {
        return jdbc.sql("select version from form_version where id = :id").param("id", versionId).query(Integer.class).single();
    }

    public PublishedForm latestPublished(String typeCode) {
        return jdbc.sql("""
                select v.id, v.version, v.schema::text as schema_text from form_version v
                join form_definition f on f.id = v.form_id
                where f.request_type_code = :t and v.status = 'PUBLISHED' order by v.version desc limit 1""")
                .param("t", typeCode)
                .query((rs, n) -> new PublishedForm(Db.uuid(rs, "id"), rs.getInt("version"), json.tree(rs.getString("schema_text"))))
                .optional().orElseThrow(() -> ApiException.validation("لا يوجد إصدار منشور من نموذج هذا النوع."));
    }

    @Transactional
    public FormVersionView saveDraft(AccessContext ctx, UUID formId, JsonNode schema) {
        ctx.require(Permission.CONFIGURE);
        jdbc.sql("select id from form_definition where id = :id for update").param("id", formId)
                .query(UUID.class).optional().orElseThrow(ApiException::notFound);
        UUID existing = jdbc.sql("select id from form_version where form_id = :f and status = 'DRAFT'")
                .param("f", formId).query(UUID.class).optional().orElse(null);
        UUID id;
        if (existing != null) {
            id = existing;
            jdbc.sql("update form_version set schema = cast(:s as jsonb), created_by = :by, created_at = :at where id = :id")
                    .param("s", json.write(schema)).param("by", ctx.personId()).param("at", Db.ts(clock.instant()))
                    .param("id", id).update();
        } else {
            id = UUID.randomUUID();
            int next = jdbc.sql("select coalesce(max(version), 0) + 1 from form_version where form_id = :f")
                    .param("f", formId).query(Integer.class).single();
            jdbc.sql("""
                    insert into form_version(id, form_id, version, status, schema, created_by, created_at)
                    values (:id, :f, :v, 'DRAFT', cast(:s as jsonb), :by, :at)""")
                    .param("id", id).param("f", formId).param("v", next).param("s", json.write(schema))
                    .param("by", ctx.personId()).param("at", Db.ts(clock.instant())).update();
        }
        audit.recordAs(ctx.actor(), "FORM_DRAFT_SAVED", "FORM", formId.toString(), null, Map.of("versionId", id.toString()), null);
        return view(id);
    }

    public ValidationResult validate(AccessContext ctx, UUID versionId) {
        ctx.require(Permission.CONFIGURE);
        List<Problem> problems = FormSchemas.validateSchema(schema(versionId));
        return new ValidationResult(problems.isEmpty(),
                problems.stream().map(p -> Map.of("path", p.path(), "message", p.message())).toList());
    }

    public record FieldState(String id, String label, boolean visible, boolean required) {
    }

    public record Evaluation(boolean valid, List<Map<String, String>> errors, List<FieldState> fields) {
    }

    /**
     * Tries an unsaved schema with sample values and facts, using the server's own rule evaluation (the studio's
     * "try it"). Nothing is stored; an invalid schema returns its problems instead of states.
     */
    public Evaluation evaluate(AccessContext ctx, JsonNode schema, Map<String, Object> values, Map<String, Object> facts) {
        ctx.require(Permission.CONFIGURE);
        List<Problem> problems = FormSchemas.validateSchema(schema);
        if (!problems.isEmpty()) {
            return new Evaluation(false, problems.stream().map(p -> Map.of("path", p.path(), "message", p.message())).toList(), List.of());
        }
        List<FieldState> out = new java.util.ArrayList<>();
        for (JsonNode f : schema.get("fields")) {
            boolean visible = f.path("visible").asBoolean(true) && RuleLanguage.evaluate(f.get("visibleWhen"), values, facts);
            boolean required = visible && (f.path("required").asBoolean(false)
                    || f.hasNonNull("requiredWhen") && RuleLanguage.evaluate(f.get("requiredWhen"), values, facts));
            out.add(new FieldState(f.get("id").asText(), f.get("label").asText(), visible, required));
        }
        return new Evaluation(true, List.of(), out);
    }

    @Transactional
    public FormVersionView publish(AccessContext ctx, UUID versionId) {
        ctx.require(Permission.CONFIGURE);
        return publishInternal(ctx.actor() == null ? null : ctx.personId(), versionId, ctx);
    }

    @Transactional
    public FormVersionView publishInternal(UUID publisher, UUID versionId, AccessContext ctx) {
        Map<String, Object> row = jdbc.sql("select form_id, version, status from form_version where id = :id for update")
                .param("id", versionId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!"DRAFT".equals(row.get("status"))) {
            throw ApiException.validation("يمكن نشر المسودات فقط؛ الإصدارات المنشورة غير قابلة للتعديل.");
        }
        List<Problem> problems = FormSchemas.validateSchema(schema(versionId));
        if (!problems.isEmpty()) {
            throw ApiException.validation("تعريف النموذج غير صالح.",
                    Map.of("errors", problems.stream().map(p -> Map.of("path", p.path(), "message", p.message())).toList()));
        }
        UUID formId = (UUID) row.get("form_id");
        jdbc.sql("update form_version set status = 'RETIRED' where form_id = :f and status = 'PUBLISHED'").param("f", formId).update();
        jdbc.sql("update form_version set status = 'PUBLISHED', published_by = :by, published_at = :at where id = :id")
                .param("by", publisher).param("at", Db.ts(clock.instant())).param("id", versionId).update();
        if (ctx != null) {
            audit.recordAs(ctx.actor(), "FORM_PUBLISHED", "FORM", formId.toString(), "v" + row.get("version"),
                    Map.of("versionId", versionId.toString()), null);
        }
        return view(versionId);
    }
}
