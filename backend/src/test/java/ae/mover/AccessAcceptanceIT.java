package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/** Server-side scope, summary views, export rights, dated memberships, delegation, SoD, info copies, outbox. */
class AccessAcceptanceIT extends IntegrationTest {

    UUID root, orgA, orgB, siteA, siteB, resA, resB;
    String finalType;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgB = org("B", root);
        UUID main = site("MAIN", null, root);
        siteA = site("SA", main, orgA);
        siteB = site("SB", main, orgB);
        resA = resource("RA", siteA, null, 0);
        resB = resource("RB", siteB, null, 0);
        person("req", "REQUESTER", orgA);
        person("outsider", "REQUESTER", orgB);
        person("apr", "APPROVER", root);
        person("auditor", "AUDITOR", root);
        person("limited", "LIMITED_VIEWER", orgA, siteA);
        finalType = requestType("NEW_RESERVATION", finalOnly(), null);
    }

    private UUID approvedWithAttachment(Api req, List<UUID> info) {
        UUID id = req.draft(finalType, "LIST", orgA, List.of(resA), day("2028-04-01"), day("2028-04-03"), Map.of("reason", "مبرر اختبار كافٍ للطلب"));
        assertThat(req.upload(id, "attachments", "plan.txt", "خطة الاستخدام".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(200);
        int v = req.get("/requests/" + id).body().path("version").asInt();
        req.patch("/requests/" + id + "/draft", Map.of("expectedVersion", v, "infoOrgIds", info.stream().map(UUID::toString).toList()));
        assertThat(req.submit(id).status()).isEqualTo(200);
        Api apr = login("apr");
        assertThat(apr.approve(apr.taskFor(id), 1).status()).isEqualTo(200);
        return id;
    }

    @Test
    @DisplayName("AT-19: a user outside the scope cannot read the request, its attachments or its counts by id")
    void outOfScope() {
        Api req = login("req");
        UUID id = approvedWithAttachment(req, List.of());
        String attachment = req.get("/requests/" + id).body().path("attachments").get(0).path("id").asText();
        Api out = login("outsider");
        assertThat(out.get("/requests/" + id).status()).isEqualTo(404);
        assertThat(out.get("/attachments/" + attachment + "/content").status()).isEqualTo(404);
        JsonNode list = out.get("/requests?size=200").body();
        for (JsonNode item : list.path("items")) {
            assertThat(item.path("id").asText()).isNotEqualTo(id.toString());
        }
        JsonNode sites = out.get("/sites").body();
        for (JsonNode s : sites) {
            assertThat(s.path("id").asText()).isNotEqualTo(siteA.toString());
        }
        assertThat(out.get("/sites/" + siteA).status()).isEqualTo(404);
        assertThat(out.post("/tasks/" + UUID.randomUUID() + "/decision", Map.of("decision", "APPROVE", "expectedRevision", 1)).status()).isEqualTo(404);
    }

    @Test
    @DisplayName("AT-20: summary-only users receive no occupant, values or attachment fields at all")
    void summaryOnly() {
        Api req = login("req");
        UUID id = approvedWithAttachment(req, List.of());
        Api limited = login("limited");
        Res r = limited.get("/requests/" + id);
        assertThat(r.status()).isEqualTo(200);
        JsonNode body = r.body();
        assertThat(body.path("view").asText()).isEqualTo("SUMMARY");
        for (String hidden : List.of("ownerOrg", "values", "attachments", "participantOrgs", "infoOrgs", "createdBy")) {
            assertThat(body.has(hidden)).as(hidden).isFalse();
        }
        String raw = new String(r.raw(), StandardCharsets.UTF_8);
        assertThat(raw).doesNotContain("plan.txt").doesNotContain("مبرر اختبار");
        String attachment = req.get("/requests/" + id).body().path("attachments").get(0).path("id").asText();
        assertThat(limited.get("/attachments/" + attachment + "/content").status()).isEqualTo(404);
        JsonNode site = limited.get("/sites").body();
        for (JsonNode s : site) {
            assertThat(s.has("responsibleOrg")).isFalse();
        }
        JsonNode reservations = limited.get("/reservations").body();
        for (JsonNode x : reservations) {
            assertThat(x.has("org")).isFalse();
        }
    }

    @Test
    @DisplayName("AT-21: view without export cannot create or download exports")
    void exportRight() {
        Api req = login("req");
        assertThat(req.post("/exports", Map.of("kind", "REQUESTS_CSV")).status()).isEqualTo(403);
        Api apr = login("apr");
        Res created = apr.post("/exports", Map.of("kind", "REQUESTS_CSV"));
        assertThat(created.status()).isEqualTo(200);
        String exportId = created.body().path("id").asText();
        assertThat(apr.get("/exports/" + exportId + "/content").status()).isEqualTo(200);
        assertThat(req.get("/exports/" + exportId + "/content").status()).isEqualTo(403);
        // Export right withdrawn after creation: the download is re-checked and refused.
        UUID aprId = jdbc.sql("select id from person where username = :u").param("u", "apr-" + sfx).query(UUID.class).single();
        jdbc.sql("update membership set valid_to = now() where person_id = :p").param("p", aprId).update();
        assertThat(apr.get("/exports/" + exportId + "/content").status()).isEqualTo(403);
    }

    @Test
    @DisplayName("AT-22: moving a person ends the old organisation's access but keeps the identity on past decisions")
    void transfer() {
        UUID mover = person("mover", "ORG_MANAGER", orgA);
        String type = requestType("NEW_RESERVATION", workflow(List.of(),
                stage("org_approval", "ALL", false, "ORG_MANAGER|REQUEST_ORG"),
                stage("final_approval", "ALL", true, "APPROVER|ANY")), null);
        Api req = login("req");
        Api mgr = login("mover");
        UUID decided = req.submitted(type, orgA, List.of(resA), day("2028-05-01"), day("2028-05-02"));
        assertThat(mgr.approve(mgr.taskFor(decided), 1).status()).isEqualTo(200);
        UUID pending = req.submitted(type, orgA, List.of(resA), day("2028-06-01"), day("2028-06-02"));
        assertThat(mgr.taskFor(pending)).isNotNull();

        Api admin = adminApi();
        UUID membershipId = jdbc.sql("select id from membership where person_id = :p").param("p", mover).query(UUID.class).single();
        assertThat(admin.post("/memberships/" + membershipId + "/end", Map.of("reason", "نقل إلى جهة أخرى")).status()).isEqualTo(200);
        assertThat(admin.post("/memberships", Map.of("personId", mover.toString(), "organizationId", orgB.toString(),
                "roleCode", "ORG_MANAGER")).status()).isEqualTo(200);

        assertThat(mgr.taskFor(pending)).isNull();
        assertThat(mgr.get("/requests/" + pending).status()).isEqualTo(404);
        Map<String, Object> d = jdbc.sql("select actor_person_id, actor_org_name, actor_role_name from decision where request_id = :r")
                .param("r", decided).query().singleRow();
        assertThat(d.get("actor_person_id")).isEqualTo(mover);
        assertThat(d.get("actor_org_name")).isEqualTo("جهة A");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'TASKS_REALIGNED' and entity_id = :p").param("p", mover.toString())
                .query(Long.class).single()).isEqualTo(1);
    }

    private Api adminApi() {
        person("admin", "SYSTEM_ADMIN", root);
        return login("admin");
    }

    @Test
    @DisplayName("AT-23: revoking a delegation stops delegated actions immediately within the same session")
    void delegationRevoked() {
        UUID owner = person("owner", "APPROVER", root);
        UUID deputy = person("deputy", "REQUESTER", orgB);
        Api ownerApi = login("owner");
        Api deputyApi = login("deputy");
        UUID membership = jdbc.sql("select id from membership where person_id = :p").param("p", owner).query(UUID.class).single();
        Res del = ownerApi.post("/delegations", Map.of("delegateId", deputy.toString(), "membershipId", membership.toString(),
                "validTo", java.time.Instant.now().plusSeconds(3600).toString(), "reason", "إجازة"));
        assertThat(del.status()).isEqualTo(200);
        Api req = login("req");
        UUID id = req.submitted(finalType, orgA, List.of(resA), day("2028-07-01"), day("2028-07-02"));
        String task = deputyApi.taskFor(id);
        assertThat(task).isNotNull();
        assertThat(ownerApi.post("/delegations/" + del.body().path("id").asText() + "/revoke", Map.of("reason", "عودة من الإجازة")).status())
                .isEqualTo(204);
        assertThat(deputyApi.taskFor(id)).isNull();
        assertThat(deputyApi.approve(task, 1).status()).isIn(403, 404);
        assertThat(deputyApi.get("/requests/" + id).status()).isEqualTo(404);
    }

    @Test
    @DisplayName("AT-24 (revised 2026-10-29): a requester holding APPROVE over the stage may approve their own request, recorded as such; one without it may not")
    void requesterDecision() {
        UUID both = person("both", "REQUESTER", orgA);
        membership(both, "APPROVER", root, null);
        Api api = login("both");
        UUID id = api.submitted(finalType, orgA, List.of(resA), day("2028-08-01"), day("2028-08-02"));
        String task = api.taskFor(id);
        assertThat(task).isNotNull();
        assertThat(api.approve(task, 1).status()).isEqualTo(200);
        assertThat(activeReservations(resA)).isEqualTo(1);
        assertThat(jdbc.sql("select by_requester from decision where request_id = :r").param("r", id).query(Boolean.class).single()).isTrue();
        assertThat(api.get("/requests/" + id).body().path("history").toString()).contains("(مقدم الطلب)");

        // REVIEW without APPROVE (organisation manager) does not reach the final stage, for one's own request or any other.
        UUID reviewer = person("selfrev", "REQUESTER", orgA);
        membership(reviewer, "ORG_MANAGER", orgA, null);
        Api other = login("selfrev");
        UUID id2 = other.submitted(finalType, orgA, List.of(resA), day("2028-08-03"), day("2028-08-04"));
        String task2 = jdbc.sql("select id::text from task_assignment where request_id = :r").param("r", id2).query(String.class).single();
        assertThat(other.taskFor(id2)).isNull();
        assertThat(other.approve(task2, 1).status()).isEqualTo(403);
        assertThat(activeReservations(resA)).isEqualTo(1);
    }

    @Test
    @DisplayName("Independent actions: view without edit, create without edit, edit without approve, administration without content")
    void independentActions() {
        person("viewer", role("VIEWONLY", "ORGANIZATION", "VIEW"), orgA);
        person("composer", role("CREATEONLY", "ORGANIZATION", "VIEW", "CREATE"), orgA);
        Api composer = login("composer");
        UUID id = composer.submitted(finalType, orgA, List.of(resA), day("2028-10-01"), day("2028-10-02"));

        JsonNode seen = login("viewer").get("/requests/" + id).body();
        assertThat(seen.path("view").asText()).isEqualTo("FULL");
        assertThat(seen.path("actions").path("canEditDraft").asBoolean()).isFalse();

        // Revising a returned request is EDIT, which CREATE does not imply.
        Api apr = login("apr");
        assertThat(apr.decide(apr.taskFor(id), "RETURN", "يرجى استكمال البيانات", 1).status()).isEqualTo(200);
        JsonNode returned = composer.get("/requests/" + id).body();
        assertThat(returned.path("actions").path("canEditDraft").asBoolean()).isFalse();
        assertThat(composer.patch("/requests/" + id + "/draft",
                Map.of("expectedVersion", returned.path("version").asInt(), "subject", "تعديل")).status()).isEqualTo(403);
        assertThat(composer.upload(id, "attachments", "a.txt", "نص".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(403);
        assertThat(composer.submit(id).status()).isEqualTo(403);

        // EDIT without APPROVE: the requester gets no approval task and cannot decide one.
        Api req = login("req");
        UUID id2 = req.submitted(finalType, orgA, List.of(resA), day("2028-10-03"), day("2028-10-04"));
        String task = jdbc.sql("select id::text from task_assignment where request_id = :r").param("r", id2).query(String.class).single();
        assertThat(req.taskFor(id2)).isNull();
        assertThat(req.approve(task, 1).status()).isEqualTo(403);

        // System administration grants neither request content nor decisions.
        Api admin = adminApi();
        assertThat(admin.get("/requests/" + id2).status()).isEqualTo(404);
        assertThat(admin.get("/requests?size=200").body().path("items").size()).isZero();
        assertThat(admin.taskFor(id2)).isNull();
        assertThat(admin.approve(task, 1).status()).isIn(403, 404);
        assertThat(admin.get("/reports/kpis").status()).isEqualTo(403);
        assertThat(admin.get("/roles").status()).isEqualTo(200);
        assertThat(activeReservations(resA)).isZero();
    }

    @Test
    @DisplayName("Availability preview: a resource outside the caller's scope is indistinguishable from one that does not exist")
    void availabilityOutOfScope() {
        login("req").submitted(finalType, orgA, List.of(resA), day("2028-09-01"), day("2028-09-03"));
        Api out = login("outsider");
        Res hidden = out.post("/availability/check", Map.of("resourceIds", List.of(resA.toString()),
                "start", day("2028-09-01"), "end", day("2028-09-02")));
        Res unknown = out.post("/availability/check", Map.of("resourceIds", List.of(UUID.randomUUID().toString()),
                "start", day("2028-09-01"), "end", day("2028-09-02")));
        Res mixed = out.post("/availability/check", Map.of("resourceIds", List.of(resB.toString(), resA.toString()),
                "start", day("2028-09-01"), "end", day("2028-09-02")));
        assertThat(hidden.status()).isEqualTo(404);
        assertThat(unknown.status()).isEqualTo(404);
        assertThat(mixed.status()).isEqualTo(404);
        assertThat(hidden.code()).isEqualTo(unknown.code());
        assertThat(hidden.body().path("message").asText()).isEqualTo(unknown.body().path("message").asText());
        assertThat(new String(hidden.raw(), StandardCharsets.UTF_8)).doesNotContain("RA-" + sfx).doesNotContain("مورد RA");
        Res own = out.post("/availability/check", Map.of("resourceIds", List.of(resB.toString()),
                "start", day("2028-09-01"), "end", day("2028-09-02")));
        assertThat(own.status()).isEqualTo(200);
        assertThat(own.body().path("pendingRequests").asInt()).isZero();
    }

    @Test
    @DisplayName("AT-25 + AT-28: info recipients get a notice without attachment access; outbox re-processing never duplicates")
    void infoCopyAndOutbox() {
        UUID infoPerson = person("info", "REQUESTER", orgB);
        Api req = login("req");
        UUID id = approvedWithAttachment(req, List.of(orgB));
        outbox.processBatch(500);
        long notices = jdbc.sql("select count(*) from notification where person_id = :p and request_id = :r and kind = 'INFO_COPY'")
                .param("p", infoPerson).param("r", id).query(Long.class).single();
        assertThat(notices).isEqualTo(1);
        // Every viewing member of the info organisation (here: "info" and "outsider") receives one copy.
        long infoCopies = jdbc.sql("select count(*) from notification where request_id = :r and kind = 'INFO_COPY'")
                .param("r", id).query(Long.class).single();
        assertThat(infoCopies).isEqualTo(2);
        Api info = login("info");
        JsonNode summary = info.get("/requests/" + id).body();
        assertThat(summary.path("view").asText()).isEqualTo("SUMMARY");
        assertThat(summary.has("attachments")).isFalse();
        String attachment = req.get("/requests/" + id).body().path("attachments").get(0).path("id").asText();
        assertThat(info.get("/attachments/" + attachment + "/content").status()).isEqualTo(404);

        // Simulate a worker that crashed after delivering: put the event back to PENDING and process again.
        jdbc.sql("update outbox_event set delivery_state = 'PENDING' where aggregate_id = :r and event_type = 'REQUEST_APPROVED'")
                .param("r", id.toString()).update();
        outbox.processBatch(500);
        assertThat(jdbc.sql("select count(*) from notification where request_id = :r").param("r", id).query(Long.class).single())
                .isEqualTo(3); // creator + two info recipients, once each
    }

    @Test
    @DisplayName("Audit trail is append-only and readable only with the AUDIT permission")
    void auditImmutable() {
        Api req = login("req");
        assertThat(req.get("/audit-events").status()).isEqualTo(403);
        assertThat(login("auditor").get("/audit-events?size=5").status()).isEqualTo(200);
        try {
            jdbc.sql("update audit_event set action = 'X' where id = (select max(id) from audit_event)").update();
            throw new AssertionError("audit update should fail");
        } catch (org.springframework.dao.DataAccessException expected) {
            assertThat(expected.getMostSpecificCause().getMessage()).contains("append-only");
        }
    }

    @Test
    @DisplayName("R-36: indicators and reservation lists only count what the caller may see")
    void reportsAreScoped() {
        Api req = login("req");
        approvedWithAttachment(req, List.of());
        Res kpis = login("apr").get("/reports/kpis?from=2026-01-01&to=2029-12-31");
        assertThat(kpis.status()).isEqualTo(200);
        assertThat(kpis.body().path("definitions").path("occupancy").asText()).isNotBlank();
        assertThat(kpis.body().path("occupancy").toString()).contains(resA.toString());
        Res outsider = login("outsider").get("/reports/kpis?from=2026-01-01&to=2029-12-31");
        assertThat(outsider.status()).isEqualTo(200);
        assertThat(outsider.body().path("occupancy").toString()).doesNotContain(resA.toString());
        assertThat(login("apr").get("/reservations?status=ACTIVE").body().toString()).contains(resA.toString());
        assertThat(login("outsider").get("/reservations?status=ACTIVE").body().toString()).doesNotContain(resA.toString());
    }

    @Test
    @DisplayName("CSRF guard: state-changing calls without the custom header are refused")
    void csrfGuard() throws Exception {
        Api req = login("req");
        var response = req.http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(req.url("/requests")))
                .header("Content-Type", "application/json")
                .POST(java.net.http.HttpRequest.BodyPublishers.ofString("{\"typeCode\":\"" + finalType + "\"}")).build(),
                java.net.http.HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(403);
    }
}
