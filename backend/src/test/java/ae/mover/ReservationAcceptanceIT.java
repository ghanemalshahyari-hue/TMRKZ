package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/** Reservation journey, atomic conflict prevention and reservation changes (AT-01, 03, 06, 09–12, 16–18, 26, 36). */
class ReservationAcceptanceIT extends IntegrationTest {

    UUID root, orgA, orgB, mainSite, siteA, siteB;
    UUID res1, res2, res3;
    String finalType;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgB = org("B", root);
        mainSite = site("MAIN", null, root);
        siteA = site("SA", mainSite, orgA);
        siteB = site("SB", mainSite, orgA);
        res1 = resource("R1", siteA, null, 0);
        res2 = resource("R2", siteA, null, 0);
        res3 = resource("R3", siteB, null, 0);
        person("req", "REQUESTER", orgA);
        person("reqb", "REQUESTER", orgB);
        person("fac", "FACILITIES_REVIEWER", orgA);
        person("mgr", "ORG_MANAGER", orgA);
        person("apr", "APPROVER", root);
        person("apr2", "APPROVER", root);
        finalType = requestType("NEW_RESERVATION", finalOnly(), null);
    }

    @Test
    @DisplayName("AT-01/03/06/09: sequential stages, no reservation before approval, signed approval creates an independent reservation")
    void fullJourney() {
        String type = requestType("NEW_RESERVATION", workflow(List.of(
                        Map.of("key", "handover", "name", "تسليم", "role", "FACILITIES_REVIEWER", "orgFrom", "RESOURCE_ORG",
                                "dueDays", 1, "evidenceRequired", true)),
                stage("facilities_review", "ALL", false, "FACILITIES_REVIEWER|RESOURCE_ORG"),
                stage("org_approval", "ALL", false, "ORG_MANAGER|REQUEST_ORG"),
                stage("final_approval", "ALL", true, "APPROVER|ANY")), null);
        Api req = login("req");
        UUID id = req.submitted(type, orgA, List.of(res1), day("2026-12-01"), day("2026-12-04"));

        // AT-03: visible to the reviewer, but no exclusive reservation exists yet.
        Api fac = login("fac");
        assertThat(fac.taskFor(id)).isNotNull();
        assertThat(activeReservations(res1)).isZero();

        // AT-06: the second stage does not exist before the first completes.
        Api mgr = login("mgr");
        assertThat(mgr.taskFor(id)).isNull();
        assertThat(fac.approve(fac.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(mgr.taskFor(id)).isNotNull();
        assertThat(mgr.approve(mgr.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(activeReservations(res1)).isZero();

        // AT-09: final approval with attestation binds decision, revision hash, reservation and audit.
        Api apr = login("apr");
        Res approved = apr.approve(apr.taskFor(id), 1);
        assertThat(approved.status()).isEqualTo(200);
        assertThat(approved.body().path("status").asText()).isEqualTo("APPROVED");
        assertThat(approved.body().path("approvalDocument").path("revision").asInt()).isEqualTo(1);
        assertThat(approved.body().path("approvalDocument").path("signatureMode").asText()).isEqualTo("INTERNAL_ATTESTATION");
        assertThat(activeReservations(res1)).isEqualTo(1);
        long audited = jdbc.sql("select count(*) from audit_event where entity_id = :id and action in ('APPROVAL_SIGNED','REQUEST_APPROVED')")
                .param("id", id.toString()).query(Long.class).single();
        assertThat(audited).isEqualTo(2);

        // AT-01: the site keeps its identity; the reservation is a separate record referencing it.
        String siteCode = jdbc.sql("select code from site where id = :id").param("id", siteA).query(String.class).single();
        assertThat(siteCode).isEqualTo("SA-" + sfx);
        UUID reservedResource = jdbc.sql("select resource_id from reservation where request_id = :r").param("r", id).query(UUID.class).single();
        assertThat(reservedResource).isEqualTo(res1);

        // AT-18: closing needs execution done, and closing never releases the reservation.
        assertThat(req.post("/requests/" + id + "/close", Map.of()).status()).isEqualTo(400);
        JsonNode exec = req.get("/requests/" + id).body().path("executionTasks");
        String handover = exec.get(0).path("id").asText();
        assertThat(fac.post("/execution-tasks/" + handover + "/complete", Map.of("note", "")).status()).isEqualTo(400);
        assertThat(fac.post("/execution-tasks/" + handover + "/complete", Map.of("note", "تم التسليم بمحضر رقم 12")).status()).isEqualTo(200);
        Res closed = req.post("/requests/" + id + "/close", Map.of());
        assertThat(closed.body().path("status").asText()).isEqualTo("CLOSED");
        assertThat(activeReservations(res1)).isEqualTo(1);
    }

    @Test
    @DisplayName("AT-10: two concurrent approvals on the same exclusive resource and overlapping period — exactly one succeeds")
    void concurrentApprovals() throws Exception {
        Api reqA = login("req");
        UUID a = reqA.submitted(finalType, orgA, List.of(res2), day("2027-01-10"), day("2027-01-15"));
        UUID b = reqA.submitted(finalType, orgA, List.of(res2), day("2027-01-12"), day("2027-01-20"));
        Api apr = login("apr");
        Api apr2 = login("apr2");
        String ta = apr.taskFor(a);
        String tb = apr2.taskFor(b);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<Res> fa = pool.submit(() -> {
            start.await();
            return apr.approve(ta, 1);
        });
        Future<Res> fb = pool.submit(() -> {
            start.await();
            return apr2.approve(tb, 1);
        });
        start.countDown();
        List<Res> results = List.of(fa.get(), fb.get());
        pool.shutdown();
        assertThat(results).extracting(Res::status).containsExactlyInAnyOrder(200, 409);
        Res conflict = results.stream().filter(r -> r.status() == 409).findFirst().orElseThrow();
        assertThat(conflict.code()).isEqualTo("RESERVATION_CONFLICT");
        assertThat(activeReservations(res2)).isEqualTo(1);
        // The losing request is untouched: still in review, its final task still open, no decision recorded.
        UUID loser = results.get(0).status() == 409 ? a : b;
        assertThat(jdbc.sql("select status from request where id = :id").param("id", loser).query(String.class).single()).isEqualTo("SUBMITTED");
        assertThat(jdbc.sql("select count(*) from decision where request_id = :id").param("id", loser).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from task_assignment where request_id = :id and status = 'OPEN'").param("id", loser)
                .query(Long.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("AT-11: a request for three resources where one conflicts reserves none of them")
    void allOrNothing() {
        Api req = login("req");
        Api apr = login("apr");
        UUID blocker = req.submitted(finalType, orgA, List.of(res3), day("2027-02-01"), day("2027-02-10"));
        assertThat(apr.approve(apr.taskFor(blocker), 1).status()).isEqualTo(200);
        UUID multi = req.submitted(finalType, orgA, List.of(res1, res2, res3), day("2027-02-05"), day("2027-02-08"));
        Res r = apr.approve(apr.taskFor(multi), 1);
        assertThat(r.status()).isEqualTo(409);
        assertThat(r.code()).isEqualTo("RESERVATION_CONFLICT");
        assertThat(jdbc.sql("select count(*) from reservation where request_id = :id").param("id", multi).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from approval_document where request_id = :id").param("id", multi).query(Long.class).single()).isZero();
    }

    @Test
    @DisplayName("AT-12: end of one booking equal to start of the next is allowed; a configured handover buffer blocks it")
    void boundaries() {
        Api req = login("req");
        Api apr = login("apr");
        UUID first = req.submitted(finalType, orgA, List.of(res1), day("2027-03-01"), day("2027-03-04"));
        assertThat(apr.approve(apr.taskFor(first), 1).status()).isEqualTo(200);
        UUID touching = req.submitted(finalType, orgA, List.of(res1), day("2027-03-04"), day("2027-03-06"));
        assertThat(apr.approve(apr.taskFor(touching), 1).status()).isEqualTo(200);

        UUID buffered = resource("RH", siteA, null, 60);
        UUID h1 = req.submitted(finalType, orgA, List.of(buffered), day("2027-03-01"), day("2027-03-04"));
        assertThat(apr.approve(apr.taskFor(h1), 1).status()).isEqualTo(200);
        UUID h2 = req.submitted(finalType, orgA, List.of(buffered), day("2027-03-04"), day("2027-03-06"));
        assertThat(apr.approve(apr.taskFor(h2), 1).code()).isEqualTo("RESERVATION_CONFLICT");
    }

    @Test
    @DisplayName("AT-26: re-sending an approval after a lost response returns one result and one reservation")
    void idempotentApproval() {
        Api req = login("req");
        Api apr = login("apr");
        UUID id = req.submitted(finalType, orgA, List.of(res2), day("2027-04-01"), day("2027-04-03"));
        String task = apr.taskFor(id);
        Map<String, Object> body = Map.of("decision", "APPROVE", "expectedRevision", 1,
                "signature", Map.of("password", PASSWORD, "confirm", true));
        Res first = apr.post("/tasks/" + task + "/decision", body, "same-key-" + sfx);
        Res again = apr.post("/tasks/" + task + "/decision", body, "same-key-" + sfx);
        assertThat(first.status()).isEqualTo(200);
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.body().path("status").asText()).isEqualTo("APPROVED");
        assertThat(jdbc.sql("select count(*) from reservation where request_id = :id").param("id", id).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from approval_document where request_id = :id").param("id", id).query(Long.class).single()).isEqualTo(1);
        Res misuse = apr.post("/tasks/" + task + "/decision", Map.of("decision", "REJECT", "note", "سبب مختلف", "expectedRevision", 1),
                "same-key-" + sfx);
        assertThat(misuse.code()).isEqualTo("IDEMPOTENCY_CONFLICT");
        Res secondDecision = apr.approve(task, 1);
        assertThat(secondDecision.code()).isEqualTo("TASK_ALREADY_COMPLETED");
    }

    @Test
    @DisplayName("AT-16/17: extension into a used period is refused and leaves the original intact; cancellation ends the reservation")
    void changes() {
        Api req = login("req");
        Api apr = login("apr");
        UUID original = req.submitted(finalType, orgA, List.of(res3), day("2027-05-01"), day("2027-05-05"));
        assertThat(apr.approve(apr.taskFor(original), 1).status()).isEqualTo(200);
        UUID next = req.submitted(finalType, orgA, List.of(res3), day("2027-05-07"), day("2027-05-09"));
        assertThat(apr.approve(apr.taskFor(next), 1).status()).isEqualTo(200);
        UUID reservation = jdbc.sql("select id from reservation where request_id = :r").param("r", original).query(UUID.class).single();

        String extType = requestType("EXTENSION", finalOnly(), null);
        Res draft = req.post("/reservations/" + reservation + "/change-requests", Map.of("typeCode", extType));
        assertThat(draft.status()).isEqualTo(200);
        UUID ext = UUID.fromString(draft.body().path("id").asText());
        Res patched = req.patch("/requests/" + ext + "/draft", Map.of("expectedVersion", draft.body().path("version").asInt(),
                "period", Map.of("start", day("2027-05-01"), "end", day("2027-05-08")), "values", Map.of("reason", "تمديد لاستكمال الأعمال")));
        assertThat(patched.status()).isEqualTo(200);
        assertThat(req.submit(ext).status()).isEqualTo(200);
        assertThat(apr.approve(apr.taskFor(ext), 1).code()).isEqualTo("RESERVATION_CONFLICT");
        String end = jdbc.sql("select period_end::text from reservation where id = :id").param("id", reservation).query(String.class).single();
        assertThat(end).startsWith("2027-05-04 20:00:00");

        String cancelType = requestType("CANCELLATION", finalOnly(), null);
        Res c = req.post("/reservations/" + reservation + "/change-requests", Map.of("typeCode", cancelType));
        UUID cancel = UUID.fromString(c.body().path("id").asText());
        req.patch("/requests/" + cancel + "/draft", Map.of("expectedVersion", c.body().path("version").asInt(),
                "period", Map.of("start", day("2027-05-03")), "values", Map.of("reason", "انتهاء الحاجة إلى المرفق")));
        assertThat(req.submit(cancel).status()).isEqualTo(200);
        assertThat(apr.approve(apr.taskFor(cancel), 1).status()).isEqualTo(200);
        Map<String, Object> after = jdbc.sql("select status, period_end::text as e from reservation where id = :id").param("id", reservation)
                .query().singleRow();
        assertThat(after.get("status")).isEqualTo("CANCELLED");
        assertThat((String) after.get("e")).startsWith("2027-05-02 20:00:00");
        assertThat(jdbc.sql("select count(*) from reservation_change where reservation_id = :id and change_kind = 'CANCELLATION'")
                .param("id", reservation).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("AT-17: evacuation releases the reservation only after handover evidence")
    void evacuation() {
        Api req = login("req");
        Api apr = login("apr");
        Api fac = login("fac");
        UUID original = req.submitted(finalType, orgA, List.of(res1), day("2027-06-01"), day("2027-07-01"));
        assertThat(apr.approve(apr.taskFor(original), 1).status()).isEqualTo(200);
        UUID reservation = jdbc.sql("select id from reservation where request_id = :r").param("r", original).query(UUID.class).single();
        String evacType = requestType("EVACUATION", finalOnly(), null);
        Res d = req.post("/reservations/" + reservation + "/change-requests", Map.of("typeCode", evacType));
        UUID evac = UUID.fromString(d.body().path("id").asText());
        req.patch("/requests/" + evac + "/draft", Map.of("expectedVersion", d.body().path("version").asInt(),
                "values", Map.of("reason", "إخلاء المرفق بعد انتهاء البرنامج")));
        assertThat(req.submit(evac).status()).isEqualTo(200);
        assertThat(apr.approve(apr.taskFor(evac), 1).status()).isEqualTo(200);
        assertThat(jdbc.sql("select status from reservation where id = :id").param("id", reservation).query(String.class).single()).isEqualTo("ACTIVE");
        String handover = req.get("/requests/" + evac).body().path("executionTasks").get(0).path("id").asText();
        assertThat(fac.post("/execution-tasks/" + handover + "/complete", Map.of("note", "محضر تسليم المفاتيح رقم 7")).status()).isEqualTo(200);
        assertThat(jdbc.sql("select status from reservation where id = :id").param("id", reservation).query(String.class).single()).isEqualTo("RELEASED");
        // Handover happened before the booked period began, so nothing of the reservation remains in force.
        assertThat(jdbc.sql("select count(*) from reservation_lock where reservation_id = :id").param("id", reservation).query(Long.class).single())
                .isZero();
    }

    @Test
    @DisplayName("AT-36: booking a parent resource and an overlapping child conflicts; two siblings do not")
    void parentChildScope() {
        UUID parent = resource("HALL", siteB, null, 0);
        UUID childA = resource("HALL-A", siteB, parent, 0);
        UUID childB = resource("HALL-B", siteB, parent, 0);
        Api req = login("req");
        Api apr = login("apr");
        UUID a = req.submitted(finalType, orgA, List.of(childA), day("2027-08-01"), day("2027-08-03"));
        assertThat(apr.approve(apr.taskFor(a), 1).status()).isEqualTo(200);
        UUID b = req.submitted(finalType, orgA, List.of(childB), day("2027-08-01"), day("2027-08-03"));
        assertThat(apr.approve(apr.taskFor(b), 1).status()).isEqualTo(200);
        UUID whole = req.submitted(finalType, orgA, List.of(parent), day("2027-08-02"), day("2027-08-04"));
        Res r = apr.approve(apr.taskFor(whole), 1);
        assertThat(r.code()).isEqualTo("RESERVATION_CONFLICT");
        UUID later = req.submitted(finalType, orgA, List.of(parent), day("2027-08-03"), day("2027-08-04"));
        assertThat(apr.approve(apr.taskFor(later), 1).status()).isEqualTo(200);
        UUID childAfter = req.submitted(finalType, orgA, List.of(childA), day("2027-08-03"), day("2027-08-05"));
        assertThat(apr.approve(apr.taskFor(childAfter), 1).code()).isEqualTo("RESERVATION_CONFLICT");
        List<UUID> all = new ArrayList<>(List.of(parent, childA, childB));
        assertThat(all).hasSize(3);
    }

    @Test
    @DisplayName("Availability check is a preview only and reports conflicts without reserving")
    void availabilityPreview() {
        Api req = login("req");
        Api apr = login("apr");
        UUID id = req.submitted(finalType, orgA, List.of(res2), day("2027-09-01"), day("2027-09-05"));
        assertThat(apr.approve(apr.taskFor(id), 1).status()).isEqualTo(200);
        Res check = req.post("/availability/check", Map.of("resourceIds", List.of(res2.toString()),
                "start", day("2027-09-04"), "end", day("2027-09-06")));
        assertThat(check.body().path("available").asBoolean()).isFalse();
        Res free = req.post("/availability/check", Map.of("resourceIds", List.of(res2.toString()),
                "start", day("2027-09-05"), "end", day("2027-09-06")));
        assertThat(free.body().path("available").asBoolean()).isTrue();
        assertThat(activeReservations(res2)).isEqualTo(1);
    }
}
