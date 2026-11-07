package ae.mover.requests;

import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.common.ApiException;
import ae.mover.common.Json;
import ae.mover.forms.FormService;
import ae.mover.workflow.WorkflowDefinition;
import ae.mover.workflow.WorkflowService;

@Service
public class RequestTypes {

    private final JdbcClient jdbc;
    private final FormService forms;
    private final WorkflowService workflows;
    private final ae.mover.audit.AuditService audit;
    private final Json json;

    public RequestTypes(JdbcClient jdbc, FormService forms, WorkflowService workflows, ae.mover.audit.AuditService audit, Json json) {
        this.audit = audit;
        this.json = json;
        this.jdbc = jdbc;
        this.forms = forms;
        this.workflows = workflows;
    }

    public record Type(String code, String name, String kind, boolean multiSites, boolean multiOrgs, boolean openEndAllowed) {
        /** Change requests act on an existing reservation; new reservations and relocations do not. */
        public boolean requiresTarget() {
            return !"NEW_RESERVATION".equals(kind) && !"RELOCATION".equals(kind) && !"ACCESS".equals(kind);
        }
    }

    public record StageRef(String key, String name) {
    }

    public record TypeView(String code, String name, String kind, boolean multiSites, boolean multiOrgs,
                           boolean requiresTargetReservation, boolean openEndAllowed, Map<String, Object> formVersion,
                           Map<String, Object> workflowVersion) {
    }

    private static final java.util.Set<String> KINDS = java.util.Set.of("NEW_RESERVATION", "EXTENSION", "MODIFICATION", "CANCELLATION", "EVACUATION", "RELOCATION", "ACCESS");

    public record NewType(String name, String kind) {
    }

    /** A new request type (owner, 6 Nov 2026): its name, what it does, and the standard form. Its approvals path is drawn after. */
    @org.springframework.transaction.annotation.Transactional
    public Map<String, Object> create(AccessContext ctx, NewType in) {
        ctx.require(Permission.CONFIGURE);
        String name = in == null || in.name() == null ? "" : in.name().trim();
        if (name.length() < 2) {
            throw ApiException.validation("اكتب اسم نوع الطلب.");
        }
        if (in.kind() == null || !KINDS.contains(in.kind())) {
            throw ApiException.validation("اختر ماذا يفعل هذا الطلب.");
        }
        if (jdbc.sql("select count(*) from request_type where active and name = :n").param("n", name).query(Long.class).single() > 0) {
            throw ApiException.validation("يوجد نوع طلب بهذا الاسم.");
        }
        if ("ACCESS".equals(in.kind()) && jdbc.sql("select count(*) from request_type where active and kind = 'ACCESS'").query(Long.class).single() > 0) {
            throw ApiException.validation("يوجد نوع طلب للصلاحيات، ويكفي واحد.");
        }
        String code = "T_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 10).toUpperCase();
        jdbc.sql("""
                insert into request_type(code, name, kind, multi_sites, multi_orgs, sort_order)
                values (:c, :n, :k, :ms, true, (select coalesce(max(sort_order), 0) + 1 from request_type))""")
                .param("c", code).param("n", name).param("k", in.kind()).param("ms", "NEW_RESERVATION".equals(in.kind())).update();
        java.util.UUID formId = java.util.UUID.randomUUID();
        jdbc.sql("insert into form_definition(id, request_type_code) values (:id, :t)").param("id", formId).param("t", code).update();
        java.util.UUID formVersion = java.util.UUID.randomUUID();
        jdbc.sql("insert into form_version(id, form_id, version, status, schema) values (:id, :f, 1, 'DRAFT', cast(:s as jsonb))")
                .param("id", formVersion).param("f", formId).param("s", json.write(ae.mover.system.Bootstrap.defaultForm())).update();
        forms.publishInternal(null, formVersion, null);
        jdbc.sql("insert into workflow_definition(id, request_type_code) values (:id, :t)").param("id", java.util.UUID.randomUUID()).param("t", code).update();
        audit.recordAs(ctx.actor(), "REQUEST_TYPE_CREATED", "REQUEST_TYPE", code, name, Map.of("kind", in.kind()), null);
        return Map.of("code", code, "name", name);
    }

    /** Takes a type off every list. Its past requests keep it; it comes back on no restart, because the row stays. */
    @org.springframework.transaction.annotation.Transactional
    public void remove(AccessContext ctx, String code) {
        ctx.require(Permission.CONFIGURE);
        String name = get(code).name();
        long open = jdbc.sql("select count(*) from request where type_code = :c and status not in ('APPROVED', 'REJECTED', 'CLOSED')")
                .param("c", code).query(Long.class).single();
        if (open > 0) {
            throw ApiException.validation("لهذا النوع " + open + " طلب لم ينتهِ بعد؛ أكملها أولاً.");
        }
        jdbc.sql("update request_type set active = false where code = :c").param("c", code).update();
        audit.recordAs(ctx.actor(), "REQUEST_TYPE_REMOVED", "REQUEST_TYPE", code, name, Map.of(), null);
    }

    public Type get(String code) {
        if (code == null) {
            throw ApiException.validation("نوع الطلب مطلوب.");
        }
        return jdbc.sql("select code, name, kind, multi_sites, multi_orgs, open_end_allowed from request_type where code = :c and active")
                .param("c", code)
                .query((rs, n) -> new Type(rs.getString("code"), rs.getString("name"), rs.getString("kind"),
                        rs.getBoolean("multi_sites"), rs.getBoolean("multi_orgs"), rs.getBoolean("open_end_allowed")))
                .optional().orElseThrow(() -> ApiException.validation("نوع الطلب غير معروف."));
    }

    public List<Type> all() {
        return jdbc.sql("select code, name, kind, multi_sites, multi_orgs, open_end_allowed from request_type where active order by sort_order")
                .query((rs, n) -> new Type(rs.getString("code"), rs.getString("name"), rs.getString("kind"),
                        rs.getBoolean("multi_sites"), rs.getBoolean("multi_orgs"), rs.getBoolean("open_end_allowed"))).list();
    }

    public List<TypeView> views() {
        return all().stream().map(t -> {
            FormService.PublishedForm form = forms.latestPublished(t.code());
            WorkflowService.PublishedWorkflow wf = workflows.latestPublished(t.code());
            Map<String, Object> wfView = null;
            if (wf != null) {
                WorkflowDefinition def = wf.definition();
                wfView = Map.of("id", wf.id().toString(), "version", wf.version(), "name", def.name(),
                        "stages", def.stages().stream().map(s -> new StageRef(s.key(), s.name())).toList());
            }
            JsonNode schema = form.schema();
            return new TypeView(t.code(), t.name(), t.kind(), t.multiSites(), t.multiOrgs(), t.requiresTarget(), t.openEndAllowed(),
                    Map.of("id", form.id().toString(), "version", form.version(), "schema", schema), wfView);
        }).toList();
    }
}
