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
 * ADR-028 against requests already in progress, and against role and organisational scope (owner brief of 3 Nov 2026).
 * A step approved before ADR-028 was never routed at approval; these tests recreate that state in the throw-away test
 * database and record which cases the application can recover through ordinary audited grants, and which stay stuck
 * until a recovery workflow exists. Tests named "(gap)" assert today's behaviour so a change to it is noticed.
 */
class ExecutionInFlightIT extends IntegrationTest {

    UUID root, orgA, orgB, siteA, resA;
    String apr, fac, closer;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgB = org("B", root);
        siteA = site("SA", site("MAIN", null, root), orgA);
        resA = resource("RA", siteA, null, 0);
        apr = role("APR", "ORGANIZATION", "VIEW", "REVIEW", "APPROVE");
        fac = role("FAC", "ORGANIZATION", "VIEW", "EXECUTE");
        closer = role("CLS", "ORGANIZATION", "VIEW", "CLOSE");
        person("apr1", apr, root);
        person("admin", "SYSTEM_ADMIN", root);
    }

    private static Map<String, Object> step(String key, String role, String orgFrom, boolean evidence) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("key", key);
        e.put("name", "خطوة " + key);
        e.put("role", role);
        e.put("orgFrom", orgFrom);
        e.put("dueDays", 1);
        e.put("evidenceRequired", evidence);
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

    private Res complete(Api a, String stepId) {
        return a.post("/execution-tasks/" + stepId + "/complete", Map.of("note", "محضر تسليم المرفق"), UUID.randomUUID().toString());
    }

    private Res close(Api a, UUID request) {
        return a.post("/requests/" + request + "/close", Map.of("statement", "سُلّم المرفق واستُلم وفق المحضر المرفق."),
                UUID.randomUUID().toString());
    }

    /** The state a step had when its request was approved before ADR-028: no routing, optionally assigned. */
    private void asBeforeAdr028(String stepId, UUID assignedTo) {
        jdbc.sql("delete from task_reassignment where task_id = :t").param("t", UUID.fromString(stepId)).update();
        jdbc.sql("update execution_task set awaiting_assignment = false, assigned_person_id = :p where id = :t")
                .param("p", assignedTo).param("t", UUID.fromString(stepId)).update();
    }

    private int routings(UUID request) {
        return jdbc.sql("select count(*) from task_reassignment where request_id = :r").param("r", request).query(Integer.class).single();
    }

    private boolean pendingForAccessManagers(String stepId) {
        return jdbc.sql("""
                select count(*) from task_reassignment where task_id = :t and outcome = 'ROUTED_TO_ACCESS_MANAGER'
                and resolved_at is null""").param("t", UUID.fromString(stepId)).query(Integer.class).single() > 0;
    }

    @Test
    @DisplayName("IF-1 (gap): an in-progress handover only its requester holds is refused and never routed; an audited grant to an independent party recovers it")
    void legacyHandoverOnlyRequesterHolds() {
        String type = type(List.of(step("handover", fac, "RESOURCE_ORG", true)));
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, fac, orgA, null);
        UUID id = approved(login("req"), type, "2031-01-01", "2031-01-02");
        String handover = stepId(id, "handover");
        assertThat(pendingForAccessManagers(handover)).as("ADR-028 routes it when approved today").isTrue();

        asBeforeAdr028(handover, null);
        Res own = complete(login("req"), handover);
        assertThat(own.status()).as(own.toString()).isEqualTo(403);
        assertThat(own.code()).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(pendingForAccessManagers(handover)).as("nothing routes a step approved before ADR-028").isFalse();

        // recovery that exists today: the access manager grants the role to an independent party (audited grant)
        person("fac2", fac, orgA);
        assertThat(complete(login("fac2"), handover).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("IF-2 (gap): an in-progress handover assigned to its requester cannot be completed by anyone")
    void legacyHandoverAssignedToRequester() {
        String type = type(List.of(step("handover", fac, "RESOURCE_ORG", true)));
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, fac, orgA, null);
        person("fac2", fac, orgA);
        UUID id = approved(login("req"), type, "2031-02-01", "2031-02-02");
        String handover = stepId(id, "handover");

        asBeforeAdr028(handover, req);
        Res own = complete(login("req"), handover);
        assertThat(own.status()).as(own.toString()).isEqualTo(403);
        assertThat(own.code()).isEqualTo("SEPARATION_OF_DUTIES");
        Res independent = complete(login("fac2"), handover);
        assertThat(independent.status()).as("assigned to someone else: " + independent).isEqualTo(403);
        assertThat(pendingForAccessManagers(handover)).as("no screen offers a reassignment").isFalse();
    }

    @Test
    @DisplayName("IF-3 (gap): a file only its requester could close gets no routing; an audited CLOSE grant to an independent party recovers it")
    void closingWithoutIndependentCloser() {
        String type = type(List.of());
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, closer, orgA, null);
        UUID id = approved(login("req"), type, "2031-03-01", "2031-03-02");

        assertThat(login("req").get("/requests/" + id).body().path("actions").path("canClose").asBoolean()).isFalse();
        Res own = close(login("req"), id);
        assertThat(own.status()).as(own.toString()).isEqualTo(403);
        assertThat(own.code()).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(routings(id)).as("closing is never routed to the access managers").isZero();

        person("closer2", closer, orgA);
        assertThat(close(login("closer2"), id).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("IF-4: a handover role held only in another organisation is outside scope: refused there, and the step is routed as having no holder")
    void executionScope() {
        String type = type(List.of(step("handover", fac, "RESOURCE_ORG", true)));
        person("req", "REQUESTER", orgA);
        person("facB", fac, orgB);
        UUID id = approved(login("req"), type, "2031-04-01", "2031-04-02");
        String handover = stepId(id, "handover");

        Res outside = complete(login("facB"), handover);
        assertThat(outside.status()).as(outside.toString()).isIn(403, 404);
        assertThat(outside.code()).isNotEqualTo("SEPARATION_OF_DUTIES");
        assertThat(jdbc.sql("select reason from task_reassignment where task_id = :t").param("t", UUID.fromString(handover))
                .query(String.class).single()).isEqualTo("NO_HOLDER");
    }

    @Test
    @DisplayName("IF-5 (gap): an approval stage whose role is held only outside the request's scope is not routed at submission")
    void reviewStageHeldOnlyOutsideScope() {
        String rv = role("RV", "ORGANIZATION", "VIEW", "REVIEW", "APPROVE");
        person("rvB", rv, orgB);
        String type = requestType("NEW_RESERVATION", workflow(List.of(), stage("final", "ALL", true, rv + "|REQUEST_ORG")), null);
        person("req", "REQUESTER", orgA);
        UUID id = login("req").submitted(type, orgA, List.of(resA), day("2031-05-01"), day("2031-05-02"));
        String task = jdbc.sql("select id::text from task_assignment where request_id = :r and status = 'OPEN'").param("r", id)
                .query(String.class).single();

        assertThat(login("rvB").approve(task, 1).status()).as("the only holder is outside the request's organisation").isIn(403, 404);
        assertThat(routings(id)).as("held somewhere, so not routed — but nobody in scope can act").isZero();
    }
}
