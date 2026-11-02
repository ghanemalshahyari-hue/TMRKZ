package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.hr.TaskRealignment;
import ae.mover.security.Actor;

/**
 * Separation of duties (owner decision of 2 Nov 2026, ADR-027): nobody decides a request they made — not directly, not
 * through a delegation in either direction, not through another role, organisation or HR seat, and not through another
 * person record of the same human. When nobody independent holds a task, it waits for an access manager, who cannot hand
 * it to the requester. Every scenario uses its own roles, so approvers left by other tests in the shared database never
 * count as independent holders.
 */
class SeparationOfDutiesIT extends IntegrationTest {

    @Autowired
    TaskRealignment realignment;
    @Autowired
    AccessService access;

    UUID root, orgA, orgB, siteA, resA;
    String apr;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgB = org("B", root);
        UUID main = site("MAIN", null, root);
        siteA = site("SA", main, orgA);
        resA = resource("RA", siteA, null, 0);
        apr = role("APR", "ORGANIZATION", "VIEW", "REVIEW", "APPROVE");
        person("admin", "SYSTEM_ADMIN", root);
    }

    private String finalBy(String role) {
        return requestType("NEW_RESERVATION", workflow(List.of(), stage("final", "ALL", true, role + "|ANY")), null);
    }

    private String openTask(UUID request) {
        return jdbc.sql("select id::text from task_assignment where request_id = :r and status = 'OPEN'").param("r", request)
                .query(String.class).single();
    }

    private boolean awaiting(String task) {
        return jdbc.sql("select awaiting_assignment from task_assignment where id = cast(:t as uuid)").param("t", task)
                .query(Boolean.class).single();
    }

    private UUID membershipOf(UUID person, String role) {
        return jdbc.sql("select id from membership where person_id = :p and role_code = :r").param("p", person).param("r", role)
                .query(UUID.class).single();
    }

    private void delegation(UUID delegator, UUID delegate, UUID membership) {
        jdbc.sql("""
                insert into delegation(id, delegator_id, delegate_id, membership_id, valid_from, valid_to, reason)
                values (:id, :a, :b, :m, now() - interval '1 hour', now() + interval '1 day', 'تفويض اختبار')""")
                .param("id", UUID.randomUUID()).param("a", delegator).param("b", delegate).param("m", membership).update();
    }

    private void refusedForSeparation(Res r) {
        assertThat(r.status()).as(r.toString()).isEqualTo(403);
        assertThat(r.code()).isEqualTo("SEPARATION_OF_DUTIES");
    }

    @Test
    @DisplayName("SOD-1: the requester decides no stage of their own request, whatever roles they hold; independent holders do")
    void requesterNeverDecides() {
        String rev = role("REV", "ORGANIZATION", "VIEW", "REVIEW");
        String type = requestType("NEW_RESERVATION", workflow(List.of(), stage("review", "ALL", false, rev + "|REQUEST_ORG"),
                stage("final", "ALL", true, apr + "|ANY")), null);
        UUID both = person("both", "REQUESTER", orgA);
        membership(both, rev, orgA, null);
        membership(both, apr, root, null);
        person("rev2", rev, orgA);
        person("apr2", apr, root);
        Api self = login("both");
        UUID id = self.submitted(type, orgA, List.of(resA), day("2029-01-01"), day("2029-01-02"));
        String review = openTask(id);
        assertThat(self.taskFor(id)).as("own review task listed").isNull();
        assertThat(self.get("/requests/" + id).body().path("actions").path("myTasks").size()).as("decision offered").isZero();
        for (String d : List.of("APPROVE", "REFER", "RETURN", "REJECT")) {
            refusedForSeparation(self.decide(review, d, "قرار على طلبي الخاص", 1));
        }
        assertThat(awaiting(review)).as("an independent reviewer exists").isFalse();
        Api rev2 = login("rev2");
        assertThat(rev2.taskFor(id)).isEqualTo(review);
        assertThat(rev2.decide(review, "APPROVE", null, 1).status()).isEqualTo(200);

        String fin = openTask(id);
        assertThat(self.taskFor(id)).isNull();
        refusedForSeparation(self.approve(fin, 1));
        assertThat(self.get("/tasks/" + fin + "/approval-document").status()).isIn(403, 404);
        assertThat(login("apr2").approve(fin, 1).status()).isEqualTo(200);
        assertThat(activeReservations(resA)).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from decision where request_id = :r and actor_person_id = :p").param("r", id)
                .param("p", both).query(Integer.class).single()).isZero();
    }

    @Test
    @DisplayName("SOD-2: a delegation lets neither the requester decide nor a deputy decide with the requester's own authority")
    void delegationBothWays() {
        String type = finalBy(apr);
        // (a) the requester's approval authority delegated to a deputy
        UUID boss = person("boss", "REQUESTER", orgA);
        UUID bossApproval = membership(boss, apr, root, null);
        UUID deputy = person("deputy", "REQUESTER", orgB);
        delegation(boss, deputy, bossApproval);
        UUID id = login("boss").submitted(type, orgA, List.of(resA), day("2029-02-01"), day("2029-02-02"));
        String task = openTask(id);
        Api dep = login("deputy");
        assertThat(dep.taskFor(id)).isNull();
        refusedForSeparation(dep.approve(task, 1));
        assertThat(awaiting(task)).as("nobody independent holds the role").isTrue();

        // (b) the requester as deputy of someone else's approval authority
        UUID other = person("other", apr, root);
        UUID req = person("req", "REQUESTER", orgA);
        delegation(other, req, membershipOf(other, apr));
        UUID id2 = login("req").submitted(type, orgA, List.of(resA), day("2029-02-03"), day("2029-02-04"));
        String task2 = openTask(id2);
        assertThat(login("req").taskFor(id2)).isNull();
        refusedForSeparation(login("req").approve(task2, 1));
        assertThat(login("other").approve(task2, 1).status()).as("the delegator's own authority").isEqualTo(200);

        // (c) the deputy of (a) with an approval grant of their own is independent once an access manager assigns the task
        membership(deputy, apr, root, null);
        String routed = jdbc.sql("select id::text from task_reassignment where task_id = cast(:t as uuid) and resolved_at is null")
                .param("t", task).query(String.class).single();
        Res assigned = login("admin").post("/task-reassignments/" + routed + "/assign",
                Map.of("personId", deputy.toString(), "reason", "صاحب صفة مستقل عن مقدم الطلب"));
        assertThat(assigned.status()).as(assigned.toString()).isEqualTo(204);
        assertThat(dep.approve(task, 1).status()).isEqualTo(200);
        assertThat(jdbc.sql("select via_delegation_id is null from decision where request_id = :r").param("r", id)
                .query(Boolean.class).single()).as("decided through the deputy's own grant").isTrue();
    }

    @Test
    @DisplayName("SOD-3: an approval role held in another organisation or through an HR position seat changes nothing")
    void otherAssignments() {
        String type = finalBy(apr);
        UUID multi = person("multi", "REQUESTER", orgA);
        String position = "POS-APR-" + sfx;
        jdbc.sql("""
                insert into affiliation(id, person_id, organization_id, position_id, position_title, valid_from)
                values (:id, :p, :o, :pos, 'منصب اعتماد', '2026-01-01T00:00:00Z')""")
                .param("id", UUID.randomUUID()).param("p", multi).param("o", root).param("pos", position).update();
        jdbc.sql("insert into position_seat(id, organization_id, position_id, name, role_code) values (:id, :o, :pos, 'مقعد اعتماد', :r)")
                .param("id", UUID.randomUUID()).param("o", root).param("pos", position).param("r", apr).update();
        membership(multi, apr, orgB, null);
        UUID id = login("multi").submitted(type, orgA, List.of(resA), day("2029-03-01"), day("2029-03-02"));
        String task = openTask(id);
        assertThat(login("multi").taskFor(id)).isNull();
        refusedForSeparation(login("multi").approve(task, 1));
        assertThat(awaiting(task)).isTrue();
    }

    @Test
    @DisplayName("SOD-4: another person record linked to the requester's own sign-in key is the requester")
    void alternateRecord() {
        String type = finalBy(apr);
        person("req", "REQUESTER", orgA);
        UUID alias = person("alias", apr, root);
        // a sign-in claiming the requester's employee number was linked to the alias record (before ADR-027)
        jdbc.sql("""
                insert into identity_link_issue(id, issuer, subject, claimed_key, display_name, reason, resolved_at,
                                                resolved_person_id, resolution)
                values (:id, :i, :s, :k, 'حساب بديل', 'ALREADY_LINKED', now(), :p, 'LINKED')""")
                .param("id", UUID.randomUUID()).param("i", "https://idp-alt.test/" + sfx).param("s", "alt-" + sfx)
                .param("k", ("t-REQ-" + sfx).toUpperCase()).param("p", alias).update();
        UUID id = login("req").submitted(type, orgA, List.of(resA), day("2029-04-01"), day("2029-04-02"));
        String task = openTask(id);
        assertThat(login("alias").taskFor(id)).isNull();
        refusedForSeparation(login("alias").approve(task, 1));
        assertThat(awaiting(task)).as("the same human is not an independent holder").isTrue();
    }

    @Test
    @DisplayName("SOD-5: with no independent holder the task waits for an access manager, who cannot give it to the requester")
    void noIndependentApprover() {
        String type = finalBy(apr);
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, apr, root, null);
        // the requester is also an access manager over their organisation: they never resolve the routing of their own request
        String accMgr = role("ACC", "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        jdbc.sql("update role_def set grantable_roles = string_to_array(:g, ',') where code = :c").param("g", apr).param("c", accMgr).update();
        membership(req, accMgr, root, null);
        UUID admin = jdbc.sql("select id from person where username = :u").param("u", "admin-" + sfx).query(UUID.class).single();

        UUID id = login("req").submitted(type, orgA, List.of(resA), day("2029-05-01"), day("2029-05-02"));
        String task = openTask(id);
        assertThat(awaiting(task)).isTrue();
        Map<String, Object> routing = jdbc.sql("""
                select id::text as id, reason, outcome from task_reassignment where task_id = cast(:t as uuid) and resolved_at is null""")
                .param("t", task).query().singleRow();
        assertThat(routing.get("reason")).isEqualTo("SEPARATION_OF_DUTIES");
        assertThat(routing.get("outcome")).isEqualTo("ROUTED_TO_ACCESS_MANAGER");
        String routed = (String) routing.get("id");
        assertThat(jdbc.sql("select count(*) from notification where request_id = :r and person_id = :p and kind = 'TASK_ROUTED'")
                .param("r", id).param("p", admin).query(Integer.class).single()).as("global access manager notified").isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from notification where request_id = :r and person_id = :p and kind = 'TASK_ROUTED'")
                .param("r", id).param("p", req).query(Integer.class).single()).as("requester not asked to route").isZero();

        Api self = login("req");
        refusedForSeparation(self.approve(task, 1));
        assertThat(self.get("/task-reassignments").body().toString()).doesNotContain(routed);
        assertThat(self.get("/task-reassignments/" + routed + "/candidates").status()).isIn(403, 404);
        assertThat(self.post("/task-reassignments/" + routed + "/assign", Map.of("personId", req.toString(),
                "reason", "إسناد الطلب لنفسي")).status()).isIn(403, 404);

        Api m = login("admin");
        assertThat(m.get("/task-reassignments").body().toString()).contains(routed).contains("SEPARATION_OF_DUTIES");
        assertThat(m.get("/task-reassignments/" + routed + "/candidates").body().path("items").toString())
                .as("the requester is not a candidate").doesNotContain(req.toString());
        refusedForSeparation(m.post("/task-reassignments/" + routed + "/assign", Map.of("personId", req.toString(),
                "reason", "محاولة إسناد لمقدم الطلب")));
        UUID apr2 = person("apr2", apr, root);
        assertThat(m.get("/task-reassignments/" + routed + "/candidates").body().path("items").toString()).contains(apr2.toString());
        assertThat(m.post("/task-reassignments/" + routed + "/assign", Map.of("personId", apr2.toString(),
                "reason", "صاحب اعتماد مستقل")).status()).isEqualTo(204);
        assertThat(login("apr2").approve(task, 1).status()).isEqualTo(200);
        assertThat(activeReservations(resA)).isEqualTo(1);
    }

    @Test
    @DisplayName("SOD-6: when the last independent holder leaves, the task is routed — never handed to the requester")
    void departureLeavesOnlyRequester() {
        String type = finalBy(apr);
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, apr, root, null);
        UUID apr1 = person("apr1", apr, root);
        UUID id = login("req").submitted(type, orgA, List.of(resA), day("2029-06-01"), day("2029-06-02"));
        String task = openTask(id);
        assertThat(awaiting(task)).isFalse();

        Instant now = Instant.now();
        AccessContext before = access.load(new Actor(apr1, null, null, null), now);
        jdbc.sql("update membership set valid_to = now() where person_id = :p").param("p", apr1).update();
        tx.executeWithoutResult(s -> realignment.realign(Map.of(apr1, before), "HR_SYNC", Instant.now()));

        Map<String, Object> t = jdbc.sql("select assigned_person_id, awaiting_assignment from task_assignment where id = cast(:t as uuid)")
                .param("t", task).query().singleRow();
        assertThat(t.get("assigned_person_id")).as("not given to the requester").isNull();
        assertThat(t.get("awaiting_assignment")).isEqualTo(true);
        assertThat(jdbc.sql("select count(*) from task_reassignment where task_id = cast(:t as uuid) and outcome = 'SOLE_SUBSTITUTE'")
                .param("t", task).query(Integer.class).single()).isZero();
        refusedForSeparation(login("req").approve(task, 1));
    }

    @Test
    @DisplayName("SOD-8 (independent review): a stage the requester decided before ADR-027 is decided again on resubmission")
    void legacySelfDecisionNotCarried() {
        String rev = role("REV", "ORGANIZATION", "VIEW", "REVIEW");
        String type = requestType("NEW_RESERVATION", workflow(List.of(), stage("review", "ALL", false, rev + "|REQUEST_ORG"),
                stage("final", "ALL", true, apr + "|ANY")), null);
        UUID req = person("req", "REQUESTER", orgA);
        person("rev2", rev, orgA);
        person("apr2", apr, root);
        Api self = login("req");
        UUID id = self.submitted(type, orgA, List.of(resA), day("2029-08-01"), day("2029-08-02"));
        assertThat(login("rev2").decide(openTask(id), "APPROVE", null, 1).status()).isEqualTo(200);
        // a decision of the review stage recorded by the requester under the earlier rule (ADR-013); decisions are
        // append-only, so the legacy row is added beside the independent one
        jdbc.sql("""
                insert into decision(id, request_id, revision, task_id, stage_key, stage_name, actor_person_id, actor_name,
                    actor_role_code, actor_role_name, actor_org_id, actor_org_name, decision, decided_at, by_requester)
                select :id, request_id, revision, null, stage_key, stage_name, :p, 'مقدم الطلب', actor_role_code, actor_role_name,
                       actor_org_id, actor_org_name, 'APPROVE', decided_at, true
                from decision where request_id = :r and stage_key = 'review'""")
                .param("id", UUID.randomUUID()).param("p", req).param("r", id).update();
        assertThat(login("apr2").decide(openTask(id), "RETURN", "يرجى المراجعة مرة أخرى", 1).status()).isEqualTo(200);
        assertThat(self.submit(id).status()).isEqualTo(200);
        String stage = jdbc.sql("select stage_key from task_assignment where request_id = :r and status = 'OPEN'").param("r", id)
                .query(String.class).single();
        assertThat(stage).as("the requester's earlier decision is not carried").isEqualTo("review");
    }

    @Test
    @DisplayName("SOD-7: the shortcut through a held decision is closed: an assigned task still refuses the requester")
    void assignedTaskStillRefusesRequester() {
        String type = finalBy(apr);
        UUID req = person("req", "REQUESTER", orgA);
        membership(req, apr, root, null);
        person("apr1", apr, root);
        UUID id = login("req").submitted(type, orgA, List.of(resA), day("2029-07-01"), day("2029-07-02"));
        String task = openTask(id);
        // a row assigned to the requester directly (e.g. by data written before ADR-027) still gives them nothing
        jdbc.sql("update task_assignment set assigned_person_id = :p where id = cast(:t as uuid)").param("p", req).param("t", task).update();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("decision", "APPROVE");
        body.put("expectedRevision", 1);
        body.put("signature", Map.of("password", PASSWORD, "confirm", true));
        refusedForSeparation(login("req").post("/tasks/" + task + "/decision", body, UUID.randomUUID().toString()));
        assertThat(activeReservations(resA)).isZero();
    }
}
