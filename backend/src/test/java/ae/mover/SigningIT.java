package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Certificate signature of the approver and seal of the organisation on the approval document (PA-22, PA-23, ADR-020),
 * with a throw-away PKI: signing outside the decision transaction, publication only by a decision that still holds,
 * and refusals that leave no approval, reservation or misleading document.
 */
class SigningIT extends IntegrationTest {

    static TestPki pki;

    @DynamicPropertySource
    static void signing(DynamicPropertyRegistry r) throws Exception {
        pki = new TestPki(Files.createTempDirectory("tmrkz-signing-it"));
        r.add("tmrkz.signing.provider", () -> "PKCS12_DIRECTORY");
        r.add("tmrkz.signing.keystore-dir", () -> pki.keystores.toString());
        r.add("tmrkz.signing.keystore-password-file", () -> pki.passwordFile.toString());
        r.add("tmrkz.signing.trust-dir", () -> pki.trust.toString());
        r.add("tmrkz.signing.crl-dir", () -> pki.crls.toString());
    }

    UUID root, orgA, site, res;
    String type;
    JsonNode previousSettings;

    @BeforeEach
    void fixtures() throws Exception {
        root = org("ROOT", null);
        orgA = org("A", root);
        site = site("S", null, orgA);
        res = resource("R", site, null, 0);
        person("req", "REQUESTER", orgA);
        person("apr", "APPROVER", root);
        person("revoked", "APPROVER", root);
        person("admin", "SYSTEM_ADMIN", root);
        type = requestType("NEW_RESERVATION", finalOnly(), null);
        pki.issue("person-T-apr-" + sfx, "Approver " + sfx);
        pki.revoke(pki.issue("person-T-revoked-" + sfx, "Revoked " + sfx));
        pki.issue("seal-ROOT-" + sfx, "Seal ROOT " + sfx);
        Api admin = login("admin");
        previousSettings = admin.get("/policies/current").body().path("settings");
        setMode(admin, "PKI");
    }

    @AfterEach
    void restore() {
        Api admin = login("admin");
        Res d = admin.post("/policies/drafts", Map.of("settings", JSON.convertValue(previousSettings, Map.class)));
        admin.post("/policy-versions/" + d.body().path("id").asText() + "/publish", Map.of());
    }

    private static void setMode(Api admin, String mode) {
        @SuppressWarnings("unchecked")
        Map<String, Object> s = JSON.convertValue(admin.get("/policies/current").body().path("settings"), Map.class);
        s.put("signatureMode", mode);
        Res d = admin.post("/policies/drafts", Map.of("settings", s));
        assertThat(admin.post("/policy-versions/" + d.body().path("id").asText() + "/publish", Map.of()).status()).isEqualTo(200);
    }

    private static Res approveWith(Api api, String task, int revision, String jobId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("decision", "APPROVE");
        body.put("expectedRevision", revision);
        body.put("signature", Map.of("confirm", true));
        body.put("signingJobId", jobId);
        return api.post("/tasks/" + task + "/decision", body, UUID.randomUUID().toString());
    }

    @Test
    @DisplayName("PA-22: the approver signs with their certificate, the organisation seals, the decision publishes both")
    void signAndPublish() {
        UUID id = login("req").submitted(type, orgA, List.of(res), day("2029-03-01"), day("2029-03-03"));
        Api apr = login("apr");
        String task = apr.taskFor(id);
        Res signed = apr.post("/tasks/" + task + "/signing", Map.of("expectedRevision", 1));
        assertThat(signed.status()).as(signed.toString()).isEqualTo(200);
        assertThat(signed.body().path("status").asText()).isEqualTo("SIGNED");
        assertThat(signed.body().path("signatures")).hasSize(2);
        for (JsonNode s : signed.body().path("signatures")) {
            assertThat(s.path("indication").asText()).isEqualTo("TOTAL_PASSED");
        }
        // signing again for the same frozen document returns the same job
        assertThat(apr.post("/tasks/" + task + "/signing", Map.of("expectedRevision", 1)).body().path("id").asText())
                .isEqualTo(signed.body().path("id").asText());
        // nothing is approved or reserved until the decision publishes the signature
        assertThat(activeReservations(res)).isZero();
        Res approved = approveWith(apr, task, 1, signed.body().path("id").asText());
        assertThat(approved.status()).as(approved.toString()).isEqualTo(200);
        assertThat(activeReservations(res)).isEqualTo(1);
        JsonNode doc = approved.body().path("approvalDocument");
        assertThat(doc.path("signatureMode").asText()).isEqualTo("PKI");
        assertThat(doc.path("signatures")).hasSize(2);
        JsonNode verify = apr.get("/requests/" + id + "/approval-document/verification").body();
        assertThat(verify.path("passed").asBoolean()).as(verify.toString()).isTrue();
        assertThat(verify.path("signatures").toString()).contains("PERSON").contains("SEAL");
        assertThat(jdbc.sql("select status from signing_job where id = :id").param("id", UUID.fromString(signed.body().path("id").asText()))
                .query(String.class).single()).isEqualTo("PUBLISHED");
    }

    @Test
    @DisplayName("PA-22: a revoked certificate is refused; without a valid signature nothing is approved")
    void revokedRefused() {
        UUID id = login("req").submitted(type, orgA, List.of(res), day("2029-04-01"), day("2029-04-03"));
        Api revoked = login("revoked");
        String task = revoked.taskFor(id);
        Res r = revoked.post("/tasks/" + task + "/signing", Map.of("expectedRevision", 1));
        assertThat(r.status()).isEqualTo(409);
        assertThat(r.code()).isEqualTo("SIGNATURE_CERTIFICATE_REJECTED");
        assertThat(r.body().path("details").path("failure").asText()).isEqualTo("CERTIFICATE_REVOKED");
        Res noJob = approveWith(revoked, task, 1, null);
        assertThat(noJob.code()).isEqualTo("SIGNATURE_REQUIRED");
        Res failedJob = approveWith(revoked, task, 1, r.body().path("details").path("signingJobId").asText());
        assertThat(failedJob.code()).isEqualTo("SIGNATURE_REQUIRED");
        assertThat(jdbc.sql("select count(*) from decision where request_id = :id").param("id", id).query(Long.class).single()).isZero();
        assertThat(activeReservations(res)).isZero();
    }

    @Test
    @DisplayName("PA-23: a conflict after signing publishes nothing; the signature stays on record as unpublished")
    void conflictAfterSigning() {
        Api req = login("req");
        UUID a = req.submitted(type, orgA, List.of(res), day("2029-05-01"), day("2029-05-05"));
        UUID b = req.submitted(type, orgA, List.of(res), day("2029-05-03"), day("2029-05-08"));
        Api apr = login("apr");
        String ta = apr.taskFor(a);
        String tb = apr.taskFor(b);
        String ja = apr.post("/tasks/" + ta + "/signing", Map.of("expectedRevision", 1)).body().path("id").asText();
        String jb = apr.post("/tasks/" + tb + "/signing", Map.of("expectedRevision", 1)).body().path("id").asText();
        assertThat(approveWith(apr, ta, 1, ja).status()).isEqualTo(200);
        Res conflict = approveWith(apr, tb, 1, jb);
        assertThat(conflict.code()).isEqualTo("RESERVATION_CONFLICT");
        Map<String, Object> job = jdbc.sql("select status, unpublished_reason, decision_id from signing_job where id = :id")
                .param("id", UUID.fromString(jb)).query().singleRow();
        assertThat(job.get("status")).isEqualTo("UNPUBLISHED");
        assertThat((String) job.get("unpublished_reason")).startsWith("RESERVATION_CONFLICT");
        assertThat(job.get("decision_id")).isNull();
        assertThat(jdbc.sql("select count(*) from approval_document where request_id = :id").param("id", b).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select status from request where id = :id").param("id", b).query(String.class).single()).isEqualTo("SUBMITTED");
        assertThat(activeReservations(res)).isEqualTo(1);
    }

    @Test
    @DisplayName("PA-23: a signature of an earlier revision is never published on a later one")
    void revisionChangedAfterSigning() {
        Api req = login("req");
        UUID id = req.submitted(type, orgA, List.of(res), day("2029-06-01"), day("2029-06-03"));
        Api apr = login("apr");
        String task = apr.taskFor(id);
        String job = apr.post("/tasks/" + task + "/signing", Map.of("expectedRevision", 1)).body().path("id").asText();
        Map<String, Object> ret = new LinkedHashMap<>();
        ret.put("decision", "RETURN");
        ret.put("note", "يرجى تعديل الفترة");
        ret.put("expectedRevision", 1);
        assertThat(apr.post("/tasks/" + task + "/decision", ret, UUID.randomUUID().toString()).status()).isEqualTo(200);
        int v = req.get("/requests/" + id).body().path("version").asInt();
        assertThat(req.patch("/requests/" + id + "/draft", Map.of("expectedVersion", v,
                "period", Map.of("start", day("2029-06-02"), "end", day("2029-06-04")))).status()).isEqualTo(200);
        assertThat(req.submit(id).status()).isEqualTo(200);
        String task2 = apr.taskFor(id);
        Res stale = approveWith(apr, task2, 2, job);
        assertThat(stale.status()).isIn(403, 409);
        assertThat(jdbc.sql("select count(*) from approval_document where request_id = :id").param("id", id).query(Long.class).single()).isZero();
        assertThat(activeReservations(res)).isZero();
    }

    @Test
    @DisplayName("PA-23: the signing provider unavailable stops the approval without any trace of it")
    void providerOutage() throws Exception {
        UUID id = login("req").submitted(type, orgA, List.of(res), day("2029-07-01"), day("2029-07-03"));
        Api apr = login("apr");
        String task = apr.taskFor(id);
        Path moved = pki.passwordFile.resolveSibling("password.moved");
        Files.move(pki.passwordFile, moved);
        try {
            Res r = apr.post("/tasks/" + task + "/signing", Map.of("expectedRevision", 1));
            assertThat(r.status()).isEqualTo(503);
            assertThat(r.code()).isEqualTo("SIGNATURE_PROVIDER_UNAVAILABLE");
            assertThat(approveWith(apr, task, 1, null).code()).isEqualTo("SIGNATURE_PROVIDER_UNAVAILABLE");
        } finally {
            Files.move(moved, pki.passwordFile);
        }
        assertThat(jdbc.sql("select count(*) from decision where request_id = :id").param("id", id).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from signing_job where request_id = :id").param("id", id).query(Long.class).single()).isZero();
        assertThat(activeReservations(res)).isZero();
    }
}
