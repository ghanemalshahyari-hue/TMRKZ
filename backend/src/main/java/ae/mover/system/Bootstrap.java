package ae.mover.system;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.common.Json;
import ae.mover.facilities.MapService;
import ae.mover.forms.FormService;
import ae.mover.policy.PolicyService;
import ae.mover.workflow.WorkflowService;

/**
 * Startup tasks: baseline configuration (roles, request types, first published form/workflow/policy versions) and local
 * map package registration. Every step is idempotent. The production build seeds no people, organisations or sample
 * requests: organisations and people come from the HR source, and fictional test data exists only in the separate test
 * environment ({@code ops/test-env}).
 */
@Component
@Order(1)
public class Bootstrap implements ApplicationRunner {

    private final JdbcClient jdbc;
    private final Json json;
    private final TransactionTemplate tx;
    private final PolicyService policies;
    private final FormService forms;
    private final WorkflowService workflows;
    private final MapService maps;

    public Bootstrap(JdbcClient jdbc, Json json, TransactionTemplate tx, PolicyService policies,
                     FormService forms, WorkflowService workflows, MapService maps) {
        this.jdbc = jdbc;
        this.json = json;
        this.tx = tx;
        this.policies = policies;
        this.forms = forms;
        this.workflows = workflows;
        this.maps = maps;
    }

    @Override
    public void run(ApplicationArguments args) {
        tx.executeWithoutResult(s -> {
            policies.ensureInitial();
            seedRoles();
            seedRequestTypes();
        });
        maps.installLocalPackages();
    }

    // ---- baseline configuration -----------------------------------------------------------------------

    private void seedRoles() {
        Object[][] roles = {
                // Configuration rights never imply reading request content or deciding (owner decision 2026-10-29).
                {"SYSTEM_ADMIN", "مدير النظام", "CONFIGURE,MANAGE_ACCESS,MANAGE_FACILITIES,VIEW_SOURCE_IDENTIFIERS", "ALL", false, true, 1},
                {"REQUESTER", "مقدم الطلب", "VIEW,CREATE,EDIT,EXECUTE", "ORGANIZATION", false, false, 2},
                {"FACILITIES_REVIEWER", "مراجع المرافق", "VIEW,REVIEW,EXPORT,EXECUTE", "ALL", false, false, 3},
                {"ORG_MANAGER", "مدير الجهة", "VIEW,CREATE,EDIT,REVIEW,EXPORT", "ORGANIZATION", false, false, 4},
                {"APPROVER", "صاحب الاعتماد", "VIEW,REVIEW,APPROVE,EXPORT", "ALL", false, false, 5},
                {"LIMITED_VIEWER", "اطلاع محدود", "VIEW_SUMMARY", "SITE", true, false, 6},
                {"AUDITOR", "مدقق السجلات", "VIEW,AUDIT", "ALL", false, false, 7}};
        for (Object[] r : roles) {
            jdbc.sql("""
                    insert into role_def(code, name, permissions, scope, summary_only, system, sort_order)
                    values (:c, :n, string_to_array(:p, ','), :s, :so, :sys, :o) on conflict (code) do nothing""")
                    .param("c", r[0]).param("n", r[1]).param("p", r[2]).param("s", r[3]).param("so", r[4])
                    .param("sys", r[5]).param("o", r[6]).update();
        }
    }

    private void seedRequestTypes() {
        Object[][] types = {
                {"TEMP_OCCUPANCY", "إشغال مؤقت", "NEW_RESERVATION", true, 1},
                {"ADMIN_TRANSFER", "نقل إداري", "NEW_RESERVATION", true, 2},
                {"EXTENSION", "تمديد", "EXTENSION", false, 3},
                {"MODIFICATION", "تعديل", "MODIFICATION", false, 4},
                {"CANCELLATION", "إلغاء", "CANCELLATION", false, 5},
                {"EVACUATION", "إخلاء", "EVACUATION", false, 6}};
        for (Object[] t : types) {
            int inserted = jdbc.sql("""
                    insert into request_type(code, name, kind, multi_sites, multi_orgs, sort_order)
                    values (:c, :n, :k, :ms, true, :o) on conflict (code) do nothing""")
                    .param("c", t[0]).param("n", t[1]).param("k", t[2]).param("ms", t[3]).param("o", t[4]).update();
            if (inserted == 0) {
                continue;
            }
            String code = (String) t[0];
            UUID formId = UUID.randomUUID();
            jdbc.sql("insert into form_definition(id, request_type_code) values (:id, :t)").param("id", formId).param("t", code).update();
            UUID formVersion = UUID.randomUUID();
            jdbc.sql("insert into form_version(id, form_id, version, status, schema) values (:id, :f, 1, 'DRAFT', cast(:s as jsonb))")
                    .param("id", formVersion).param("f", formId).param("s", json.write(defaultForm())).update();
            forms.publishInternal(null, formVersion, null);
            UUID wfId = UUID.randomUUID();
            jdbc.sql("insert into workflow_definition(id, request_type_code) values (:id, :t)").param("id", wfId).param("t", code).update();
            UUID wfVersion = UUID.randomUUID();
            jdbc.sql("insert into workflow_version(id, workflow_id, version, status, definition) values (:id, :w, 1, 'DRAFT', cast(:d as jsonb))")
                    .param("id", wfVersion).param("w", wfId).param("d", json.write(defaultWorkflow((String) t[2]))).update();
            workflows.publishInternal(null, wfVersion);
        }
    }

    public static Map<String, Object> defaultForm() {
        List<Map<String, Object>> fields = new ArrayList<>();
        fields.add(field("reason", "مبرر الطلب", "textarea", true, Map.of("minLength", 10, "maxLength", 2000), "DESCRIPTIVE", null));
        fields.add(field("headcount", "عدد المستفيدين", "number", false, Map.of("min", 1, "max", 100000), "RESTART_STAGES",
                List.of("facilities_review")));
        fields.add(field("reference", "المرجع الإداري", "text", false, Map.of("maxLength", 100), "DESCRIPTIVE", null));
        fields.add(field("attachments", "المرفقات", "files", false, Map.of(), "FULL_REAPPROVAL", null));
        return Map.of("fields", fields);
    }

    private static Map<String, Object> field(String id, String label, String kind, boolean required, Map<String, Object> extra,
                                             String policy, List<String> stages) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("id", id);
        f.put("label", label);
        f.put("kind", kind);
        f.put("required", required);
        f.put("visible", true);
        f.putAll(extra);
        f.put("changePolicy", policy);
        if (stages != null) {
            f.put("affectsStages", stages);
        }
        return f;
    }

    public static Map<String, Object> defaultWorkflow(String kind) {
        List<Map<String, Object>> stages = List.of(
                stage("facilities_review", "دراسة المرفق", "FACILITIES_REVIEWER", "RESOURCE_ORG", 2, false),
                stage("org_approval", "موافقة الجهة", "ORG_MANAGER", "REQUEST_ORG", 2, false),
                stage("final_approval", "الاعتماد النهائي", "APPROVER", "ANY", 1, true));
        List<Map<String, Object>> execution = switch (kind) {
            case "NEW_RESERVATION" -> List.of(
                    exec("handover", "تسليم المرفق", "FACILITIES_REVIEWER", "RESOURCE_ORG", 1, true),
                    exec("receipt", "استلام المرفق", "REQUESTER", "REQUEST_ORG", 1, false));
            case "EVACUATION" -> List.of(exec("handover", "تسليم المرفق وإثبات الإخلاء", "FACILITIES_REVIEWER", "RESOURCE_ORG", 1, true));
            default -> List.of();
        };
        Map<String, Object> def = new LinkedHashMap<>();
        def.put("name", "مراجعة إدارية قياسية");
        def.put("stages", stages);
        def.put("execution", execution);
        return def;
    }

    private static Map<String, Object> stage(String key, String name, String role, String orgFrom, int sla, boolean fin) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("key", key);
        s.put("name", name);
        s.put("mode", "ALL");
        s.put("slaDays", sla);
        s.put("assignees", List.of(Map.of("role", role, "orgFrom", orgFrom)));
        s.put("final", fin);
        s.put("requiresSignature", fin);
        return s;
    }

    private static Map<String, Object> exec(String key, String name, String role, String orgFrom, int due, boolean evidence) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("key", key);
        e.put("name", name);
        e.put("role", role);
        e.put("orgFrom", orgFrom);
        e.put("dueDays", due);
        e.put("evidenceRequired", evidence);
        return e;
    }
}
