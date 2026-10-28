package ae.mover.requests;

import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.common.ApiException;
import ae.mover.forms.FormService;
import ae.mover.workflow.WorkflowDefinition;
import ae.mover.workflow.WorkflowService;

@Service
public class RequestTypes {

    private final JdbcClient jdbc;
    private final FormService forms;
    private final WorkflowService workflows;

    public RequestTypes(JdbcClient jdbc, FormService forms, WorkflowService workflows) {
        this.jdbc = jdbc;
        this.forms = forms;
        this.workflows = workflows;
    }

    public record Type(String code, String name, String kind, boolean multiSites, boolean multiOrgs) {
        public boolean requiresTarget() {
            return !"NEW_RESERVATION".equals(kind);
        }
    }

    public record StageRef(String key, String name) {
    }

    public record TypeView(String code, String name, String kind, boolean multiSites, boolean multiOrgs,
                           boolean requiresTargetReservation, Map<String, Object> formVersion,
                           Map<String, Object> workflowVersion) {
    }

    public Type get(String code) {
        if (code == null) {
            throw ApiException.validation("نوع الطلب مطلوب.");
        }
        return jdbc.sql("select code, name, kind, multi_sites, multi_orgs from request_type where code = :c and active")
                .param("c", code)
                .query((rs, n) -> new Type(rs.getString("code"), rs.getString("name"), rs.getString("kind"),
                        rs.getBoolean("multi_sites"), rs.getBoolean("multi_orgs")))
                .optional().orElseThrow(() -> ApiException.validation("نوع الطلب غير معروف."));
    }

    public List<Type> all() {
        return jdbc.sql("select code, name, kind, multi_sites, multi_orgs from request_type where active order by sort_order")
                .query((rs, n) -> new Type(rs.getString("code"), rs.getString("name"), rs.getString("kind"),
                        rs.getBoolean("multi_sites"), rs.getBoolean("multi_orgs"))).list();
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
            return new TypeView(t.code(), t.name(), t.kind(), t.multiSites(), t.multiOrgs(), t.requiresTarget(),
                    Map.of("id", form.id().toString(), "version", form.version(), "schema", schema), wfView);
        }).toList();
    }
}
