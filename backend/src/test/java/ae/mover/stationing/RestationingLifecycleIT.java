package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.common.ApiException;
import ae.mover.security.Actor;

/**
 * The lifecycle of a re-stationing request (ADR-034; owner-approved model D9, D10, D12, D16, A4, A5, A6) on the
 * disposable PostgreSQL + PostGIS with OpenFGA in the loop: cancellation before activation, cancellation of an activated
 * temporary before its start (including a start held by a pending cancellation, a refusal after the approved start and a
 * window that ends without a start), early return, extension activated by its final approval (ADR-095), and an extension that lapses.
 * Since ADR-078 none of these is a permission of its own: a requester of the requesting unit starts each, the unit's final
 * approver (the nearest holder of «الاعتماد النهائي») decides it, never the human who started it; since ADR-095 the final
 * APPROVE of an extension activates it in the same transaction. Time-dependent steps run the scheduler and the decisions at explicit instants.
 */
class RestationingLifecycleIT extends RestationingTestBase {

    @Autowired
    RestationingLifecycle lifecycle;
    @Autowired
    AccessService access;
    @Autowired
    StationingRegister register;

    @BeforeEach
    void lifecycleRights() {
        String fin = role("LCFIN", "ORGANIZATION", "VIEW", "FINAL_APPROVE_STATIONING");
        // the requesting unit's final approver: the nearest holder covering it (the department, above the section)
        person("finalApprover", fin, dept);
        // a wider holder over the top unit: covers the unit, but is not the nearest, so has no turn (ADR-066)
        person("finalTop", fin, top);
        // another requester of the requesting unit: the request belongs to the unit (ADR-069)
        person("unitRequester", role("LCREQ", "ORGANIZATION", "VIEW", "CREATE_RESTATIONING"), sec);
        // a requester who is also a final approver at the department: may start an action, never decide the one they started
        person("requesterFinal", role("LCBOTH", "ORGANIZATION", "VIEW", "CREATE_RESTATIONING", "FINAL_APPROVE_STATIONING"), dept);
    }

    // ---- cancellation before activation (D9, D16) ---------------------------------------------------------

    @Test
    @DisplayName("Cancellation before activation: started by a requester of the unit; pending blocks the final approval that activates (ADR-095); decided by the unit's final approver, never by who started it; rejection restores")
    void cancellationBeforeActivation() {
        // ADR-095 (commit 7df000b): the final APPROVE activates in the same transaction, so APPROVED_NOT_ACTIVATED is never
        // reached. An activated request has no «cancellation before activation» any more; the window before activation is the
        // review up to the final decision, and that decision is what a pending cancellation blocks.
        String activated = approvedPermanent(List.of(team));
        Res late = login("req").post("/restationing-requests/" + activated + "/cancellation", Map.of("reason", "لم تعد الحاجة قائمة"));
        assertThat(late.status()).as("an activated request is not cancelled before activation").isEqualTo(400);
        assertThat(late.body().path("message").asText()).isEqualTo("يُطلب الإلغاء قبل التفعيل فقط.");
        assertThat(state(activated)).isEqualTo("ACTIVATED_PERMANENT");

        String id = create("req", permanent(List.of(team)));
        assertThat(login("req").post("/restationing-requests/" + id + "/submit", Map.of()).status()).isEqualTo(200);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        // only the final stage, whose APPROVE activates, is left
        Res asked = login("req").post("/restationing-requests/" + id + "/cancellation", Map.of("reason", "لم تعد الحاجة قائمة"));
        assertThat(asked.status()).as(asked.toString()).isEqualTo(200);
        assertThat(asked.body().path("state").asText()).isEqualTo("CANCELLATION_PENDING");
        String action = asked.body().path("actions").get(0).path("id").asText();
        assertThat(login("finalApprover").get("/restationing-requests/" + id).body().path("can").path("decideAction").asText()).isEqualTo(action);
        assertThat(login("finalTop").get("/restationing-requests/" + id).body().path("can").path("decideAction").isNull())
                .as("a wider final approver has no turn: the nearest decides").isTrue();
        Res blocked = decide("apTop", id, "APPROVE");
        assertThat(blocked.status()).as("a pending cancellation blocks the final approval, which activates").isEqualTo(400);
        assertThat(state(id)).isEqualTo("CANCELLATION_PENDING");
        assertThat(jdbc.sql("select count(*) from org_stationing where request_id = cast(:id as uuid)").param("id", id).query(Long.class).single())
                .as("nothing activated while the cancellation is pending").isZero();
        Res self = decideAction("req", id, action, "APPROVE", null);
        assertThat(self.status()).isEqualTo(403);
        assertThat(self.code()).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(decideAction("apTop", id, action, "APPROVE", null).status()).as("a hierarchy approver does not decide it").isEqualTo(403);
        assertThat(decideAction("activator", id, action, "APPROVE", null).status()).as("nor the activator").isEqualTo(403);
        assertThat(decideAction("finalTop", id, action, "APPROVE", null).status()).as("nor a wider final approver").isEqualTo(403);
        assertThat(decideAction("finalApprover", id, action, "REJECT", null).status()).as("a rejection needs a reason").isEqualTo(400);
        Res rejected = decideAction("finalApprover", id, action, "REJECT", "الطلب ما زال مطلوباً");
        assertThat(rejected.body().path("state").asText()).as("the rejection restores the review where it was").isEqualTo("UNDER_REVIEW");

        assertThat(login("apSec").post("/restationing-requests/" + id + "/cancellation", Map.of("reason", "ليس من مقدمي الطلب")).status())
                .as("only a requester of the unit starts it").isEqualTo(403);
        // another requester of the unit starts it; the final approver who is also a requester may not decide what they started
        String again = login("requesterFinal").post("/restationing-requests/" + id + "/cancellation", Map.of("reason", "أُلغيت الحاجة نهائياً"))
                .body().path("actions").get(1).path("id").asText();
        Res own = decideAction("requesterFinal", id, again, "APPROVE", null);
        assertThat(own.code()).as("whoever started an action never decides it").isEqualTo("SEPARATION_OF_DUTIES");
        Res cancelled = decideAction("finalApprover", id, again, "APPROVE", null);
        assertThat(cancelled.body().path("state").asText()).isEqualTo("CANCELLED_BEFORE_ACTIVATION");
        assertThat(decide("apTop", id, "APPROVE").status()).as("a cancelled request is never finally approved, so never activated").isEqualTo(400);
        // the retained /activate is an idempotent no-op (ADR-095 API compatibility): it changes nothing
        Res noop = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(noop.status()).as(noop.toString()).isEqualTo(200);
        assertThat(noop.body().path("state").asText()).isEqualTo("CANCELLED_BEFORE_ACTIVATION");
        assertThat(state(id)).isEqualTo("CANCELLED_BEFORE_ACTIVATION");
        assertThat(jdbc.sql("select count(*) from org_stationing where request_id = cast(:id as uuid)").param("id", id).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'RESTATIONING_ACTIVATED'")
                .param("id", id).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action like 'RESTATIONING_PRE_ACTIVATION_CANCELLATION_%'")
                .param("id", id).query(Long.class).single()).isEqualTo(2);
    }

    @Test
    @DisplayName("Cancellation while under review: stage decisions wait; a rejection resumes the review where it was")
    void cancellationUnderReview() {
        String id = create("req", permanent(List.of(team)));
        login("req").post("/restationing-requests/" + id + "/submit", Map.of());
        decide("apSec", id, "APPROVE");
        // the request belongs to the unit: a requester who did not start it may ask
        String action = login("unitRequester").post("/restationing-requests/" + id + "/cancellation", Map.of("reason", "مراجعة الحاجة"))
                .body().path("actions").get(0).path("id").asText();
        assertThat(decide("apDept", id, "APPROVE").status()).as("no stage decision while the cancellation is pending").isNotEqualTo(200);
        assertThat(decideAction("finalApprover", id, action, "REJECT", "يستمر الطلب").body().path("state").asText()).isEqualTo("UNDER_REVIEW");
        assertThat(decide("apDept", id, "APPROVE").status()).isEqualTo(200);
    }

    // ---- cancellation before the start of an activated temporary (A4, A6) ----------------------------------

    @Test
    @DisplayName("Before-start cancellation: approved before the start, the temporary never takes effect and the scheduler never starts it")
    void cancellationBeforeStart() {
        Instant start = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).plus(Duration.ofHours(1));
        Instant end = start.plus(Duration.ofHours(2));
        String id = activatedTemporary(start, end);
        assertThat(login("req").post("/restationing-requests/" + id + "/early-return", Map.of("reason", "عودة قبل البدء")).status())
                .as("no early return from a temporary that has not started (A4)").isEqualTo(400);
        Res asked = login("req").post("/restationing-requests/" + id + "/start-cancellation", Map.of("reason", "أُلغي النشاط المؤقت"));
        assertThat(asked.body().path("state").asText()).isEqualTo("TEMPORARY_SCHEDULED");
        String action = asked.body().path("actions").get(0).path("id").asText();
        assertThat(decideAction("req", id, action, "APPROVE", null).code()).as("the requester who started it").isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(decideAction("finalTop", id, action, "APPROVE", null).status()).as("not the nearest final approver").isEqualTo(403);
        Res approved = decideAction("finalApprover", id, action, "APPROVE", null);
        assertThat(approved.body().path("state").asText()).isEqualTo("TEMPORARY_CANCELLED_BEFORE_START");
        Map<String, Object> rec = temporaryRecord(id);
        assertThat(rec.get("end_reason")).isEqualTo("CANCELLED");
        assertThat(rec.get("valid_to")).as("an empty window: never in force").isEqualTo(rec.get("valid_from"));
        service.runTemporaryLifecycle(start.plus(Duration.ofMinutes(5)));
        assertThat(state(id)).isEqualTo("TEMPORARY_CANCELLED_BEFORE_START");
        assertThat(kindsInForce(start.plus(Duration.ofMinutes(10)))).containsExactly("PERMANENT");
    }

    @Test
    @DisplayName("A start held by a pending cancellation: not in force; refused after the start, it takes effect from the decision (no backdating)")
    void heldStartThenRefused() {
        Instant start = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).plus(Duration.ofHours(1));
        Instant end = start.plus(Duration.ofHours(2));
        String id = activatedTemporary(start, end);
        String action = login("req").post("/restationing-requests/" + id + "/start-cancellation", Map.of("reason", "قد يُلغى النشاط"))
                .body().path("actions").get(0).path("id").asText();
        service.runTemporaryLifecycle(start.plus(Duration.ofMinutes(5)));
        assertThat(state(id)).isEqualTo("START_HELD_PENDING_CANCELLATION");
        assertThat(temporaryRecord(id).get("start_held_at")).isNotNull();
        assertThat(kindsInForce(start.plus(Duration.ofMinutes(10)))).as("the permanent stationing stays the authoritative one").containsExactly("PERMANENT");
        service.runTemporaryLifecycle(start.plus(Duration.ofMinutes(15)));
        assertThat(state(id)).as("repeating the job does not start it").isEqualTo("START_HELD_PENDING_CANCELLATION");

        Instant decided = start.plus(Duration.ofMinutes(30));
        lifecycle.decide(ctx("finalApprover"), UUID.fromString(id), UUID.fromString(action), new RestationingLifecycle.DecideInput("REJECT", "يستمر النشاط"), decided);
        assertThat(state(id)).isEqualTo("ACTIVE_TEMPORARY");
        Map<String, Object> rec = temporaryRecord(id);
        assertThat(((java.sql.Timestamp) rec.get("valid_from")).toInstant()).as("in force from the decision, not the approved start").isEqualTo(decided);
        assertThat(((java.sql.Timestamp) rec.get("planned_end")).toInstant()).as("the approved end does not move").isEqualTo(end);
        assertThat(rec.get("start_held_at")).isNull();
        assertThat(kindsInForce(decided.plus(Duration.ofMinutes(1)))).containsExactlyInAnyOrder("PERMANENT", "TEMPORARY");
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'STATIONING_TEMPORARY_STARTED' and detail ->> 'actualEffectiveStart' = :at")
                .param("id", id).param("at", decided.toString()).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("A held window that ends before the decision: the temporary never starts; the cancellation is no longer actionable")
    void windowExpiresWithoutStart() {
        Instant start = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).plus(Duration.ofHours(1));
        Instant end = start.plus(Duration.ofHours(2));
        String id = activatedTemporary(start, end);
        String action = login("req").post("/restationing-requests/" + id + "/start-cancellation", Map.of("reason", "قد يُلغى النشاط"))
                .body().path("actions").get(0).path("id").asText();
        service.runTemporaryLifecycle(start.plus(Duration.ofMinutes(5)));
        service.runTemporaryLifecycle(end.plus(Duration.ofMinutes(5)));
        assertThat(state(id)).isEqualTo("TEMPORARY_WINDOW_EXPIRED_WITHOUT_START");
        Map<String, Object> rec = temporaryRecord(id);
        assertThat(rec.get("end_reason")).isEqualTo("WINDOW_EXPIRED");
        assertThat(rec.get("valid_to")).isEqualTo(rec.get("valid_from"));
        assertThat(jdbc.sql("select state from restationing_action where id = cast(:a as uuid)").param("a", action).query(String.class).single())
                .isEqualTo("NO_LONGER_ACTIONABLE");
        assertThatThrownBy(() -> lifecycle.decide(ctx("finalApprover"), UUID.fromString(id), UUID.fromString(action),
                new RestationingLifecycle.DecideInput("APPROVE", null), end.plus(Duration.ofMinutes(10))))
                .isInstanceOf(ApiException.class).hasMessageContaining("انقضت نافذة النفاذ");
    }

    // ---- early return (D12) ---------------------------------------------------------------------------------

    @Test
    @DisplayName("Early return: started by a requester of the unit, decided by the unit's final approver (never the asker); the temporary ends at the decision with planned and actual end")
    void earlyReturn() {
        Instant start = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).plus(Duration.ofHours(1));
        Instant end = start.plus(Duration.ofHours(2));
        String id = activatedTemporary(start, end);
        service.runTemporaryLifecycle(start.plus(Duration.ofMinutes(5)));
        String action = login("req").post("/restationing-requests/" + id + "/early-return", Map.of("reason", "انتهى العمل قبل موعده"))
                .body().path("actions").get(0).path("id").asText();
        assertThat(decideAction("apDept", id, action, "APPROVE", null).status()).as("a hierarchy approver does not decide it").isEqualTo(403);
        assertThat(decideAction("req", id, action, "APPROVE", null).code()).isEqualTo("SEPARATION_OF_DUTIES");
        Instant decided = start.plus(Duration.ofMinutes(40));
        lifecycle.decide(ctx("finalApprover"), UUID.fromString(id), UUID.fromString(action), new RestationingLifecycle.DecideInput("APPROVE", "انتهى العمل"), decided);
        assertThat(state(id)).isEqualTo("TEMPORARY_RETURNED");
        Map<String, Object> rec = temporaryRecord(id);
        assertThat(rec.get("end_reason")).isEqualTo("ENDED_EARLY");
        assertThat(((java.sql.Timestamp) rec.get("valid_to")).toInstant()).isEqualTo(decided);
        assertThat(kindsInForce(decided.plus(Duration.ofMinutes(1)))).containsExactly("PERMANENT");
        assertThat(jdbc.sql("select count(*) from deployment_area where request_id = cast(:id as uuid) and state = 'RETIRED'").param("id", id)
                .query(Long.class).single()).isEqualTo(2);
        assertThat(jdbc.sql("select detail ->> 'plannedEnd' from audit_event where entity_id = :id and action = 'RESTATIONING_RETURNED_EARLY'")
                .param("id", id).query(String.class).single()).isEqualTo(end.toString());
    }

    // ---- extension (D10, A5) --------------------------------------------------------------------------------

    @Test
    @DisplayName("Extension: its own approval, whose final APPROVE activates it in the same transaction (ADR-095, D10); /activate is a no-op for anyone; the stationing runs on to the new end")
    void extension() {
        Instant start = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).plus(Duration.ofHours(1));
        Instant end = start.plus(Duration.ofHours(2));
        Instant extended = end.plus(Duration.ofHours(2));
        String id = activatedTemporary(start, end);
        service.runTemporaryLifecycle(start.plus(Duration.ofMinutes(5)));
        // ADR-095: «An approved extension's activation runs the same way inside the final approver's transaction (D10)»; the
        // separate «تفعيل التمركز» and its separation-of-duties rule are retired by construction
        String ext = activatedExtension(id, extended);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'RESTATIONING_EXTENSION_ACTIVATED'")
                .param("id", ext).query(Long.class).single()).as("activated once, by the final approval").isEqualTo(1);
        long recordsBefore = jdbc.sql("select count(*) from org_stationing where organization_id = :o and kind = 'TEMPORARY'").param("o", team)
                .query(Long.class).single();
        long auditBefore = jdbc.sql("select count(*) from audit_event where entity_id = :id").param("id", ext).query(Long.class).single();
        for (String who : List.of("req", "finalApprover", "activator", "apTop")) {
            assertThat(login(who).get("/restationing-requests/" + ext).body().path("can").path("activate").asBoolean())
                    .as(who + ": no separate activation action").isFalse();
            Res again = login(who).post("/restationing-requests/" + ext + "/activate", Map.of());
            assertThat(again.status()).as(who + " " + again).isEqualTo(200);
            assertThat(again.body().path("state").asText()).isEqualTo("EXTENSION_ACTIVATED");
        }
        assertThat(jdbc.sql("select count(*) from org_stationing where organization_id = :o and kind = 'TEMPORARY'").param("o", team)
                .query(Long.class).single()).as("no second activation").isEqualTo(recordsBefore);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id").param("id", ext).query(Long.class).single())
                .as("the no-op writes nothing").isEqualTo(auditBefore);
        List<Map<String, Object>> recs = jdbc.sql("""
                select request_id, end_reason, valid_from, valid_to, planned_end from org_stationing
                 where organization_id = :o and kind = 'TEMPORARY' order by valid_from""").param("o", team).query().listOfRows();
        assertThat(recs).hasSize(2);
        assertThat(recs.get(0).get("end_reason")).isEqualTo("SUPERSEDED");
        assertThat(((java.sql.Timestamp) recs.get(0).get("valid_to")).toInstant()).as("the earlier record keeps its dates").isEqualTo(end);
        assertThat(((java.sql.Timestamp) recs.get(1).get("valid_from")).toInstant()).isEqualTo(end);
        assertThat(((java.sql.Timestamp) recs.get(1).get("planned_end")).toInstant()).isEqualTo(extended);
        service.runTemporaryLifecycle(end.plus(Duration.ofMinutes(5)));
        assertThat(state(id)).as("still in force after the original end").isEqualTo("ACTIVE_TEMPORARY");
        assertThat(kindsInForce(end.plus(Duration.ofMinutes(10)))).containsExactlyInAnyOrder("PERMANENT", "TEMPORARY");
        service.runTemporaryLifecycle(extended.plus(Duration.ofMinutes(5)));
        assertThat(state(id)).isEqualTo("TEMPORARY_RETURNED");
        assertThat(kindsInForce(extended.plus(Duration.ofMinutes(10)))).containsExactly("PERMANENT");
    }

    @Test
    @DisplayName("Extension not activated before the end lapses (A5) and can no longer be approved, so never activated")
    void extensionLapses() {
        Instant start = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).plus(Duration.ofHours(1));
        Instant end = start.plus(Duration.ofHours(2));
        String id = activatedTemporary(start, end);
        service.runTemporaryLifecycle(start.plus(Duration.ofMinutes(5)));
        // ADR-095: an extension is activated by its final APPROVE, so the one not yet activated is still under review —
        // here every stage but the final one has approved when the temporary stationing ends
        String ext = reviewedExtension(id, end.plus(Duration.ofHours(1)));
        service.runTemporaryLifecycle(end.plus(Duration.ofMinutes(5)));
        assertThat(state(id)).isEqualTo("TEMPORARY_RETURNED");
        assertThat(state(ext)).isEqualTo("LAPSED_NOT_ACTIVATED");
        assertThat(jdbc.sql("select lapse_reason from restationing_request where id = cast(:id as uuid)").param("id", ext).query(String.class).single())
                .isNotBlank();
        assertThat(decide("apTop", ext, "APPROVE").status()).as("a lapsed extension is never finally approved").isEqualTo(400);
        // the retained /activate is an idempotent no-op (ADR-095): it changes nothing
        Res noop = login("activator").post("/restationing-requests/" + ext + "/activate", Map.of());
        assertThat(noop.status()).as(noop.toString()).isEqualTo(200);
        assertThat(state(ext)).isEqualTo("LAPSED_NOT_ACTIVATED");
        assertThat(jdbc.sql("select count(*) from org_stationing where request_id = cast(:id as uuid)").param("id", ext).query(Long.class).single())
                .as("a lapsed extension adds no stationing").isZero();
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'RESTATIONING_EXTENSION_ACTIVATED'")
                .param("id", ext).query(Long.class).single()).isZero();
        assertThat(kindsInForce(end.plus(Duration.ofMinutes(10)))).containsExactly("PERMANENT");
    }

    // ---- helpers -------------------------------------------------------------------------------------------

    private String activatedTemporary(Instant start, Instant end) {
        String id = create("req", temporary(List.of(team), start, end));
        assertThat(login("req").post("/restationing-requests/" + id + "/submit", Map.of()).status()).isEqualTo(200);
        decide("apSec", id, "APPROVE");
        decide("apDept", id, "APPROVE");
        decide("apTop", id, "APPROVE");
        Res act = login("activator").post("/restationing-requests/" + id + "/activate", Map.of());
        assertThat(act.body().path("state").asText()).as(act.toString()).isEqualTo("TEMPORARY_SCHEDULED");
        return id;
    }

    /** An extension approved by every stage but the final one: still under review, not activated. */
    private String reviewedExtension(String parent, Instant newEnd) {
        Res created = login("req").post("/restationing-requests/" + parent + "/extensions", Map.of("end", newEnd.toString(), "reason", "امتد النشاط"));
        assertThat(created.status()).as(created.toString()).isEqualTo(200);
        assertThat(created.body().path("requestKind").asText()).isEqualTo("EXTENSION");
        String ext = created.body().path("id").asText();
        Res submitted = login("req").post("/restationing-requests/" + ext + "/submit", Map.of());
        assertThat(submitted.status()).as(submitted.toString()).isEqualTo(200);
        assertThat(decide("apSec", ext, "APPROVE").status()).isEqualTo(200);
        assertThat(decide("apDept", ext, "APPROVE").status()).isEqualTo(200);
        assertThat(state(ext)).isEqualTo("UNDER_REVIEW");
        return ext;
    }

    /** ADR-095 (D10): the extension's final APPROVE activates it in the same transaction, by the final approver. */
    private String activatedExtension(String parent, Instant newEnd) {
        String ext = reviewedExtension(parent, newEnd);
        Res fin = decide("apTop", ext, "APPROVE");
        assertThat(fin.status()).as(fin.toString()).isEqualTo(200);
        assertThat(fin.body().path("state").asText()).isEqualTo("EXTENSION_ACTIVATED");
        assertThat(fin.body().path("activation").path("by").path("id").asText()).as("activated by the final approver")
                .isEqualTo(personId("apTop").toString());
        return ext;
    }

    private Res decideAction(String who, String id, String action, String decision, String reason) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("decision", decision);
        if (reason != null) {
            body.put("reason", reason);
        }
        return login(who).post("/restationing-requests/" + id + "/actions/" + action + "/decision", body);
    }

    private String state(String id) {
        return jdbc.sql("select state from restationing_request where id = cast(:id as uuid)").param("id", id).query(String.class).single();
    }

    private Map<String, Object> temporaryRecord(String id) {
        return jdbc.sql("""
                select valid_from, valid_to, planned_end, end_reason, start_held_at from org_stationing
                 where request_id = cast(:id as uuid) and kind = 'TEMPORARY'""").param("id", id).query().singleRow();
    }

    /** The kinds of the team's stationing in force at a time, through the read contract. */
    private List<String> kindsInForce(Instant at) {
        return register.current(ctx("activator"), team, null, at).stream().map(StationingRegister.StationingRecord::kind).toList();
    }

    private AccessContext ctx(String username) {
        UUID id = personId(username);
        return access.context(new Actor(id, username + "-" + sfx, "شخص " + username, null));
    }
}
