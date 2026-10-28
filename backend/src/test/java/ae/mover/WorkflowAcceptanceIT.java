package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/** Server-side validation, versions, parallel stages and change policy (AT-02, 04, 05, 07, 08, 13–15, 33–35). */
class WorkflowAcceptanceIT extends IntegrationTest {

    UUID root, orgA, siteA, res1, res2;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        UUID main = site("MAIN", null, root);
        siteA = site("SA", main, orgA);
        res1 = resource("R1", siteA, null, 0);
        res2 = resource("R2", siteA, null, 0);
        person("req", "REQUESTER", orgA);
        person("fac", "FACILITIES_REVIEWER", orgA);
        person("fac2", "FACILITIES_REVIEWER", orgA);
        person("mgr", "ORG_MANAGER", orgA);
        person("apr", "APPROVER", root);
        person("admin", "SYSTEM_ADMIN", root);
    }

    @Test
    @DisplayName("AT-02: a request started from the map and one from the list produce the same record kind and rules")
    void mapAndListSameRules() {
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        Api req = login("req");
        UUID fromMap = req.draft(type, "MAP", orgA, List.of(res1), day("2027-10-01"), day("2027-10-02"), Map.of("reason", "قصير"));
        UUID fromList = req.draft(type, "LIST", orgA, List.of(res1), day("2027-10-01"), day("2027-10-02"), Map.of("reason", "قصير"));
        Res a = req.submit(fromMap);
        Res b = req.submit(fromList);
        assertThat(a.status()).isEqualTo(400);
        assertThat(b.status()).isEqualTo(400);
        assertThat(a.body().path("message").asText()).isEqualTo(b.body().path("message").asText());
        JsonNode ra = req.get("/requests/" + fromMap).body();
        JsonNode rb = req.get("/requests/" + fromList).body();
        assertThat(ra.path("formVersion").path("id")).isEqualTo(rb.path("formVersion").path("id"));
        assertThat(ra.path("origin").asText()).isEqualTo("MAP");
        assertThat(rb.path("origin").asText()).isEqualTo("LIST");
    }

    @Test
    @DisplayName("AT-04: a missing required field is rejected by the server even when the client skips validation")
    void serverSideRequired() {
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        Api req = login("req");
        UUID id = req.draft(type, "LIST", orgA, List.of(res1), day("2027-10-01"), day("2027-10-02"), Map.of());
        Res r = req.submit(id);
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.code()).isEqualTo("VALIDATION_FAILED");
        assertThat(r.body().path("details").path("errors").get(0).path("path").asText()).isEqualTo("reason");
        assertThat(jdbc.sql("select status from request where id = :id").param("id", id).query(String.class).single()).isEqualTo("DRAFT");
    }

    @Test
    @DisplayName("AT-05 + AT-15: return needs a reason; resubmission keeps prior decisions and applies the change policy")
    void returnAndResubmit() {
        String type = requestType("NEW_RESERVATION", workflow(List.of(),
                stage("facilities_review", "ALL", false, "FACILITIES_REVIEWER|RESOURCE_ORG"),
                stage("org_approval", "ALL", false, "ORG_MANAGER|REQUEST_ORG"),
                stage("final_approval", "ALL", true, "APPROVER|ANY")), null);
        Api req = login("req");
        Api fac = login("fac");
        Api mgr = login("mgr");
        UUID id = req.submitted(type, orgA, List.of(res1), day("2027-11-01"), day("2027-11-03"));
        assertThat(fac.approve(fac.taskFor(id), 1).status()).isEqualTo(200);

        String mgrTask = mgr.taskFor(id);
        assertThat(mgr.decide(mgrTask, "RETURN", null, 1).status()).isEqualTo(400);
        assertThat(mgr.decide(mgrTask, "RETURN", "يرجى توضيح عدد المستفيدين", 1).status()).isEqualTo(200);
        assertThat(jdbc.sql("select status from request where id = :id").param("id", id).query(String.class).single()).isEqualTo("RETURNED");
        assertThat(jdbc.sql("select note from decision where request_id = :id and decision = 'RETURN'").param("id", id).query(String.class).single())
                .isEqualTo("يرجى توضيح عدد المستفيدين");

        // Descriptive change only: the facilities study approved in revision 1 is carried forward.
        int v = req.get("/requests/" + id).body().path("version").asInt();
        assertThat(req.patch("/requests/" + id + "/draft", Map.of("expectedVersion", v,
                "values", Map.of("reason", "مبرر اختبار كافٍ للطلب مع توضيح إضافي"))).status()).isEqualTo(200);
        assertThat(req.submit(id).status()).isEqualTo(200);
        JsonNode detail = req.get("/requests/" + id).body();
        assertThat(detail.path("revision").asInt()).isEqualTo(2);
        assertThat(stageState(detail, "facilities_review")).isEqualTo("CARRIED");
        assertThat(fac.taskFor(id)).isNull();
        assertThat(mgr.taskFor(id)).isNotNull();
        assertThat(mgr.decide(mgr.taskFor(id), "RETURN", "تعديل الفترة مطلوب", 2).status()).isEqualTo(200);

        // Period change: conservative policy re-runs every stage; earlier decisions stay on record.
        v = req.get("/requests/" + id).body().path("version").asInt();
        req.patch("/requests/" + id + "/draft", Map.of("expectedVersion", v, "period", Map.of("start", day("2027-11-02"), "end", day("2027-11-04"))));
        assertThat(req.submit(id).status()).isEqualTo(200);
        assertThat(fac.taskFor(id)).isNotNull();
        assertThat(stageState(req.get("/requests/" + id).body(), "facilities_review")).isEqualTo("ACTIVE");
        long decisions = jdbc.sql("select count(*) from decision where request_id = :id").param("id", id).query(Long.class).single();
        assertThat(decisions).isEqualTo(4); // approve r1, return r1, carried r2, return r2
        assertThat(jdbc.sql("select count(*) from request_revision where request_id = :id").param("id", id).query(Long.class).single()).isEqualTo(3);
    }

    @Test
    @DisplayName("AT-15: an unchanged numeric field keeps approvals; changing it restarts only the stages its policy names")
    void restartStagesPolicy() {
        String type = requestType("NEW_RESERVATION", workflow(List.of(),
                stage("facilities_review", "ALL", false, "FACILITIES_REVIEWER|RESOURCE_ORG"),
                stage("org_approval", "ALL", false, "ORG_MANAGER|REQUEST_ORG"),
                stage("final_approval", "ALL", true, "APPROVER|ANY")), null);
        Api req = login("req");
        Api fac = login("fac");
        Api mgr = login("mgr");
        UUID id = req.draft(type, "LIST", orgA, List.of(res2), day("2027-11-10"), day("2027-11-12"),
                Map.of("reason", "مبرر اختبار كافٍ للطلب", "headcount", 30));
        assertThat(req.submit(id).status()).isEqualTo(200);
        assertThat(fac.approve(fac.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(mgr.decide(mgr.taskFor(id), "RETURN", "أضف المرجع الإداري", 1).status()).isEqualTo(200);

        int v = req.get("/requests/" + id).body().path("version").asInt();
        req.patch("/requests/" + id + "/draft", Map.of("expectedVersion", v, "values", Map.of("reference", "م-ج/118")));
        assertThat(req.submit(id).status()).isEqualTo(200);
        assertThat(stageState(req.get("/requests/" + id).body(), "facilities_review")).isEqualTo("CARRIED");
        assertThat(mgr.decide(mgr.taskFor(id), "RETURN", "عدّل عدد المستفيدين", 2).status()).isEqualTo(200);

        v = req.get("/requests/" + id).body().path("version").asInt();
        req.patch("/requests/" + id + "/draft", Map.of("expectedVersion", v, "values", Map.of("headcount", 31)));
        assertThat(req.submit(id).status()).isEqualTo(200);
        assertThat(stageState(req.get("/requests/" + id).body(), "facilities_review")).isEqualTo("ACTIVE");
    }

    private static String stageState(JsonNode detail, String key) {
        for (JsonNode s : detail.path("stages")) {
            if (s.path("key").asText().equals(key)) {
                return s.path("state").asText();
            }
        }
        return null;
    }

    @Test
    @DisplayName("AT-07 / AT-08: parallel ALL stays open until every task completes; ANY closes after one approval")
    void parallelStages() {
        UUID orgB = org("B", root);
        UUID siteB = site("SB", site("MAIN2", null, root), orgB);
        UUID resB = resource("RB", siteB, null, 0);
        String allType = requestType("NEW_RESERVATION", workflow(List.of(),
                stage("parallel", "ALL", false, "FACILITIES_REVIEWER|RESOURCE_ORG"),
                stage("final_approval", "ALL", true, "APPROVER|ANY")), null);
        // Facilities of two administering organisations: only an all-scope creator may combine them in one request.
        Api req = login("admin");
        Api fac = login("fac");
        Api fac2 = login("fac2");
        UUID id = req.submitted(allType, orgA, List.of(res1, resB), day("2027-12-01"), day("2027-12-02"));
        List<String> open = jdbc.sql("select id::text from task_assignment where request_id = :id and status = 'OPEN' order by created_at")
                .param("id", id).query(String.class).list();
        assertThat(open).hasSize(2); // one per administering organisation
        assertThat(fac.approve(open.get(0), 1).status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from task_assignment where request_id = :id and status = 'OPEN' and stage_key = 'parallel'")
                .param("id", id).query(Long.class).single()).isEqualTo(1);
        assertThat(login("apr").taskFor(id)).isNull();
        assertThat(fac2.approve(open.get(1), 1).status()).isEqualTo(200);
        assertThat(login("apr").taskFor(id)).isNotNull();

        String anyType = requestType("NEW_RESERVATION", workflow(List.of(),
                stage("either", "ANY", false, "FACILITIES_REVIEWER|RESOURCE_ORG", "ORG_MANAGER|REQUEST_ORG"),
                stage("final_approval", "ALL", true, "APPROVER|ANY")), null);
        UUID any = req.submitted(anyType, orgA, List.of(res2), day("2027-12-01"), day("2027-12-02"));
        assertThat(jdbc.sql("select count(*) from task_assignment where request_id = :id and status = 'OPEN'").param("id", any)
                .query(Long.class).single()).isEqualTo(2);
        Api mgr = login("mgr");
        assertThat(mgr.approve(mgr.taskFor(any), 1).status()).isEqualTo(200);
        assertThat(jdbc.sql("select status from task_assignment where request_id = :id and stage_key = 'either' and role_code = 'FACILITIES_REVIEWER'")
                .param("id", any).query(String.class).single()).isEqualTo("CLOSED_BY_POLICY");
        assertThat(login("apr").taskFor(any)).isNotNull();
    }

    @Test
    @DisplayName("AT-13 / AT-14: publishing new form and workflow versions leaves existing requests on their pinned versions")
    void versionsArePinned() {
        String type = requestType("NEW_RESERVATION", workflow(List.of(),
                stage("facilities_review", "ALL", false, "FACILITIES_REVIEWER|RESOURCE_ORG"),
                stage("final_approval", "ALL", true, "APPROVER|ANY")), null);
        Api req = login("req");
        Api admin = login("admin");
        UUID existing = req.submitted(type, orgA, List.of(res1), day("2028-01-01"), day("2028-01-02"));
        String oldTask = login("fac").taskFor(existing);
        assertThat(oldTask).isNotNull();

        UUID formId = jdbc.sql("select id from form_definition where request_type_code = :t").param("t", type).query(UUID.class).single();
        Map<String, Object> schema = new LinkedHashMap<>(ae.mover.system.Bootstrap.defaultForm());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields = new java.util.ArrayList<>((List<Map<String, Object>>) schema.get("fields"));
        fields.add(Map.of("id", "vehicle_plate", "label", "رقم المركبة", "kind", "text", "required", true, "visible", true,
                "changePolicy", "DESCRIPTIVE"));
        Res draft = admin.post("/forms/" + formId + "/drafts", Map.of("schema", Map.of("fields", fields)));
        assertThat(draft.status()).isEqualTo(200);
        assertThat(admin.post("/form-versions/" + draft.body().path("id").asText() + "/publish", Map.of()).status()).isEqualTo(200);

        UUID wfId = jdbc.sql("select id from workflow_definition where request_type_code = :t").param("t", type).query(UUID.class).single();
        Res wfDraft = admin.post("/workflows/" + wfId + "/drafts", Map.of("definition", finalOnly()));
        Res sim = admin.post("/workflow-versions/" + wfDraft.body().path("id").asText() + "/simulate", Map.of());
        assertThat(sim.body().path("valid").asBoolean()).isTrue();
        assertThat(sim.body().path("impact").path("inFlightOnOlderVersions").asInt()).isEqualTo(1);
        assertThat(admin.post("/workflow-versions/" + wfDraft.body().path("id").asText() + "/publish", Map.of()).status()).isEqualTo(200);

        JsonNode old = req.get("/requests/" + existing).body();
        assertThat(old.path("formVersion").path("version").asInt()).isEqualTo(1);
        assertThat(old.path("workflowVersion").path("version").asInt()).isEqualTo(1);
        assertThat(login("fac").taskFor(existing)).isEqualTo(oldTask);

        UUID fresh = req.draft(type, "LIST", orgA, List.of(res2), day("2028-01-01"), day("2028-01-02"), Map.of("reason", "مبرر اختبار كافٍ للطلب"));
        Res missing = req.submit(fresh);
        assertThat(missing.status()).isEqualTo(400);
        assertThat(missing.body().path("message").asText()).contains("رقم المركبة");
        int v = req.get("/requests/" + fresh).body().path("version").asInt();
        req.patch("/requests/" + fresh + "/draft", Map.of("expectedVersion", v, "values", Map.of("vehicle_plate", "12345")));
        assertThat(req.submit(fresh).status()).isEqualTo(200);
        JsonNode created = req.get("/requests/" + fresh).body();
        assertThat(created.path("formVersion").path("version").asInt()).isEqualTo(2);
        assertThat(created.path("workflowVersion").path("version").asInt()).isEqualTo(2);
        assertThat(login("fac").taskFor(fresh)).isNull();
        assertThat(login("apr").taskFor(fresh)).isNotNull();

        // Published versions are immutable at the database level.
        assertThat(jdbc.sql("select count(*) from form_version where form_id = :f and status = 'RETIRED'").param("f", formId)
                .query(Long.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("AT-33: a rule that tries to run code or a query is rejected by the rule language")
    void ruleLanguageRejectsCode() {
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        Api admin = login("admin");
        UUID formId = jdbc.sql("select id from form_definition where request_type_code = :t").param("t", type).query(UUID.class).single();
        Map<String, Object> evil = Map.of("fields", List.of(Map.of("id", "reason", "label", "المبرر", "kind", "text",
                "required", true, "visible", true, "changePolicy", "DESCRIPTIVE",
                "visibleWhen", Map.of("expression", "${T(java.lang.Runtime).getRuntime().exec('id')}"))));
        Res d = admin.post("/forms/" + formId + "/drafts", Map.of("schema", evil));
        Res v = admin.post("/form-versions/" + d.body().path("id").asText() + "/validate", Map.of());
        assertThat(v.body().path("valid").asBoolean()).isFalse();
        assertThat(admin.post("/form-versions/" + d.body().path("id").asText() + "/publish", Map.of()).status()).isEqualTo(400);

        Map<String, Object> sql = Map.of("fields", List.of(Map.of("id", "reason", "label", "المبرر", "kind", "text",
                "required", true, "visible", true, "changePolicy", "DESCRIPTIVE",
                "requiredWhen", Map.of("field", "reason", "op", "eq", "value", "#{select * from person}"))));
        Res d2 = admin.post("/forms/" + formId + "/drafts", Map.of("schema", sql));
        assertThat(admin.post("/form-versions/" + d2.body().path("id").asText() + "/validate", Map.of()).body().path("valid").asBoolean()).isFalse();

        UUID wfId = jdbc.sql("select id from workflow_definition where request_type_code = :t").param("t", type).query(UUID.class).single();
        Map<String, Object> wf = workflow(List.of(), stage("x", "ALL", false, "FACILITIES_REVIEWER|ANY"),
                stage("final_approval", "ALL", true, "APPROVER|ANY"));
        @SuppressWarnings("unchecked")
        Map<String, Object> first = new LinkedHashMap<>(((List<Map<String, Object>>) wf.get("stages")).get(0));
        first.put("condition", Map.of("script", "return true"));
        wf.put("stages", List.of(first, ((List<?>) wf.get("stages")).get(1)));
        Res wd = admin.post("/workflows/" + wfId + "/drafts", Map.of("definition", wf));
        Res pub = admin.post("/workflow-versions/" + wd.body().path("id").asText() + "/publish", Map.of());
        assertThat(pub.code()).isEqualTo("INVALID_WORKFLOW");
    }

    @Test
    @DisplayName("AT-34: oversized, disallowed or failed-scan files are refused and never served")
    void attachments() {
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        Api req = login("req");
        UUID id = req.draft(type, "LIST", orgA, List.of(res1), day("2028-02-01"), day("2028-02-02"), Map.of("reason", "مبرر اختبار كافٍ للطلب"));
        Res ok = req.upload(id, "attachments", "note.txt", "محضر اجتماع".getBytes(StandardCharsets.UTF_8));
        assertThat(ok.body().path("scanStatus").asText()).isEqualTo("CLEAN");
        assertThat(req.get("/attachments/" + ok.body().path("id").asText() + "/content").status()).isEqualTo(200);

        Res exe = req.upload(id, "attachments", "tool.exe", new byte[]{'M', 'Z', 0, 0, 1, 2, 3});
        assertThat(exe.body().path("scanStatus").asText()).isEqualTo("REJECTED");
        Res eicar = req.upload(id, "attachments", "eicar.txt",
                "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*".getBytes(StandardCharsets.US_ASCII));
        assertThat(eicar.body().path("scanStatus").asText()).isEqualTo("REJECTED");
        Res blocked = req.get("/attachments/" + eicar.body().path("id").asText() + "/content");
        assertThat(blocked.code()).isEqualTo("ATTACHMENT_NOT_READY");
        Res big = req.upload(id, "attachments", "big.txt", new byte[11 * 1024 * 1024]);
        assertThat(big.status()).isEqualTo(400);
        assertThat(jdbc.sql("select count(*) from attachment where request_id = :id and scan_status = 'CLEAN'").param("id", id)
                .query(Long.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("AT-35: editing a request with a stale version is refused")
    void staleRevision() {
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        Api req = login("req");
        UUID id = req.draft(type, "LIST", orgA, List.of(res1), day("2028-03-01"), day("2028-03-02"), Map.of("reason", "مبرر اختبار كافٍ للطلب"));
        int v = req.get("/requests/" + id).body().path("version").asInt();
        assertThat(req.patch("/requests/" + id + "/draft", Map.of("expectedVersion", v, "subject", "أحدث")).status()).isEqualTo(200);
        Res stale = req.patch("/requests/" + id + "/draft", Map.of("expectedVersion", v, "subject", "أقدم"));
        assertThat(stale.code()).isEqualTo("STALE_REVISION");
        Res staleSubmit = req.post("/requests/" + id + "/submit", Map.of("expectedVersion", v));
        assertThat(staleSubmit.code()).isEqualTo("STALE_REVISION");
    }
}
