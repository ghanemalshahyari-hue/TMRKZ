package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Workflow integrity after approval (owner decisions of 2 Nov 2026, ADR-028): a handover is never made by the requester; a
 * receipt confirms a completed handover and is made by the authorised receiving party, never by the human who handed
 * over; the requester may acknowledge completing their own work, recorded as an acknowledgement and not an approval;
 * administrative closing needs an actor independent of the requester; and no step is left silently without a party.
 * Every scenario uses its own roles, so holders left by other tests in the shared database never count.
 */
class ExecutionIntegrityIT extends IntegrationTest {

    UUID root, orgA, siteA, resA;
    String apr, fac, closer;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        siteA = site("SA", site("MAIN", null, root), orgA);
        resA = resource("RA", siteA, null, 0);
        apr = role("APR", "ORGANIZATION", "VIEW", "REVIEW", "APPROVE");
        fac = role("FAC", "ORGANIZATION", "VIEW", "EXECUTE");
        closer = role("CLS", "ORGANIZATION", "VIEW", "CLOSE");
        person("apr1", apr, root);
        person("admin", "SYSTEM_ADMIN", root);
    }

    private static Map<String, Object> step(String key, String role, String orgFrom, boolean evidence, String purpose) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("key", key);
        e.put("name", "خطوة " + key);
        e.put("role", role);
        e.put("orgFrom", orgFrom);
        e.put("dueDays", 1);
        e.put("evidenceRequired", evidence);
        if (purpose != null) {
            e.put("purpose", purpose);
        }
        return e;
    }

    private String type(List<Map<String, Object>> steps) {
        return requestType("NEW_RESERVATION", workflow(steps, stage("final", "ALL", true, apr + "|ANY")), null);
    }

    private UUID approved(Api requester, String type, String from, String to) {
        UUID id = requester.submitted(type, orgA, List.of(resA), day(from), day(to));
        String task = jdbc.sql("select id::text from task_assignment where request_id = :r and status = 'OPEN'").param("r", id)
                .query(String.class).single();
        assertThat(login("apr1").approve(task, 1).status()).isEqualTo(200);
        return id;
    }

    private String stepId(UUID request, String key) {
        return jdbc.sql("select id::text from execution_task where request_id = :r and key = :k").param("r", request).param("k", key)
                .query(String.class).single();
    }

    private Res complete(Api a, String stepId, String note) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("note", note);
        return a.post("/execution-tasks/" + stepId + "/complete", body, UUID.randomUUID().toString());
    }

    private Res close(Api a, UUID request) {
        return a.post("/requests/" + request + "/close", Map.of("statement", "سُلّم المرفق واستُلم وفق المحضر المرفق."),
                UUID.randomUUID().toString());
    }

    @Test
    @DisplayName("EX-1: handover never by the requester; receipt after it, by the receiving party, not by the one who handed over")
    void handoverAndReceipt() {
        String type = type(List.of(step("handover", fac, "RESOURCE_ORG", true, null), step("receipt", "REQUESTER", "REQUEST_ORG", false, null)));
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, fac, orgA, null);
        UUID fac2 = person("fac2", fac, orgA);
        membership(fac2, "REQUESTER", orgA, null);
        Api self = login("req");
        UUID id = approved(self, type, "2030-01-01", "2030-01-02");
        String handover = stepId(id, "handover");
        String receipt = stepId(id, "receipt");

        Res early = complete(self, receipt, "استلمت المرفق");
        assertThat(early.status()).as("receipt before the handover: " + early).isEqualTo(400);
        Res own = complete(self, handover, "سلّمت المرفق لنفسي");
        assertThat(own.status()).as(own.toString()).isEqualTo(403);
        assertThat(own.code()).isEqualTo("SEPARATION_OF_DUTIES");

        assertThat(complete(login("fac2"), handover, "محضر تسليم المرفق").status()).isEqualTo(200);
        Res byHandingParty = complete(login("fac2"), receipt, "أؤكد الاستلام");
        assertThat(byHandingParty.status()).as("receipt by the one who handed over: " + byHandingParty).isEqualTo(403);
        assertThat(byHandingParty.code()).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(complete(self, receipt, "استلمت المرفق").status()).as("receiving party").isEqualTo(200);
    }

    @Test
    @DisplayName("EX-2: the requester may acknowledge their own work; it is recorded as an acknowledgement, not an approval")
    void acknowledgement() {
        String type = type(List.of(step("relocated", "REQUESTER", "REQUEST_ORG", false, null)));
        person("req", "REQUESTER", orgA);
        UUID id = approved(login("req"), type, "2030-02-01", "2030-02-02");
        assertThat(complete(login("req"), stepId(id, "relocated"), "أنجزت العمل المطلوب").status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :r and action = 'EXECUTION_ACKNOWLEDGED'")
                .param("r", id.toString()).query(Integer.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :r and action = 'EXECUTION_COMPLETED'")
                .param("r", id.toString()).query(Integer.class).single()).isZero();
    }

    @Test
    @DisplayName("EX-3: administrative closing needs an authorised actor independent of the requester")
    void closingIndependent() {
        String type = type(List.of());
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, closer, orgA, null);
        person("closer2", closer, orgA);
        UUID id = approved(login("req"), type, "2030-03-01", "2030-03-02");
        assertThat(login("req").get("/requests/" + id).body().path("actions").path("canClose").asBoolean()).isFalse();
        Res self = close(login("req"), id);
        assertThat(self.status()).as(self.toString()).isEqualTo(403);
        assertThat(self.code()).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(close(login("closer2"), id).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("EX-4: a step only the requester could take, or nobody can, waits for the access managers — never skipped")
    void missingParties() {
        String rcv = role("RCV", "ORGANIZATION", "VIEW", "EXECUTE");
        String type = type(List.of(step("handover", fac, "RESOURCE_ORG", true, null), step("receipt", rcv, "REQUEST_ORG", false, "RECEIPT")));
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, fac, orgA, null);
        UUID id = approved(login("req"), type, "2030-04-01", "2030-04-02");
        Map<String, Object> handover = jdbc.sql("""
                select e.awaiting_assignment, tr.reason from execution_task e join task_reassignment tr on tr.task_id = e.id
                where e.request_id = :r and e.key = 'handover'""").param("r", id).query().singleRow();
        assertThat(handover.get("awaiting_assignment")).isEqualTo(true);
        assertThat(handover.get("reason")).as("only the requester holds the handover role").isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(jdbc.sql("""
                select tr.reason from execution_task e join task_reassignment tr on tr.task_id = e.id
                where e.request_id = :r and e.key = 'receipt'""").param("r", id).query(String.class).single())
                .as("nobody holds the receiving role").isEqualTo("NO_HOLDER");
        // the requester is never offered the handover, even when assigned through the screen
        String routed = jdbc.sql("""
                select tr.id::text from execution_task e join task_reassignment tr on tr.task_id = e.id
                where e.request_id = :r and e.key = 'handover'""").param("r", id).query(String.class).single();
        Res toRequester = login("admin").post("/task-reassignments/" + routed + "/assign", Map.of("personId", req.toString(),
                "reason", "محاولة إسناد التسليم لمقدم الطلب"));
        assertThat(toRequester.status()).as(toRequester.toString()).isEqualTo(403);
    }

    @Test
    @DisplayName("EX-5: an approval stage whose role nobody holds is routed at submission, not left silent")
    void unheldStage() {
        String nobody = role("NOBODY", "ORGANIZATION", "VIEW", "REVIEW", "APPROVE");
        String type = requestType("NEW_RESERVATION", workflow(List.of(), stage("final", "ALL", true, nobody + "|ANY")), null);
        person("req", "REQUESTER", orgA);
        UUID id = login("req").submitted(type, orgA, List.of(resA), day("2030-05-01"), day("2030-05-02"));
        assertThat(jdbc.sql("""
                select tr.reason from task_assignment t join task_reassignment tr on tr.task_id = t.id where t.request_id = :r""")
                .param("r", id).query(String.class).single()).isEqualTo("NO_HOLDER");
    }
}
