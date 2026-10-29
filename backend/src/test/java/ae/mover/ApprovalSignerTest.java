package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import ae.mover.signing.ApprovalSigner;
import ae.mover.signing.Pkcs12DirectoryProvider;
import ae.mover.signing.SigningProperties;

/** PA-22 at the signing component: person signature + organisation seal with real certificates, and the refusals. */
class ApprovalSignerTest {

    static TestPki pki;
    static ApprovalSigner signer;
    static final byte[] DOC = "{\"request\":\"MV-TEST-1\",\"revision\":1,\"decision\":\"APPROVE\"}".getBytes(StandardCharsets.UTF_8);

    @BeforeAll
    static void pki() throws Exception {
        Path root = Files.createTempDirectory("tmrkz-pki");
        pki = new TestPki(root);
        pki.issue("person-E1", "Approver One");
        pki.issue("seal-GA", "Seal General Administration");
        pki.revoke(pki.issue("person-E2", "Approver Revoked"));
        pki.issueExpired("person-E3", "Approver Expired");
        pki.issueUntrusted("person-E4", "Approver Untrusted");
        signer = new ApprovalSigner(new Pkcs12DirectoryProvider(new SigningProperties("PKCS12_DIRECTORY", pki.keystores.toString(),
                pki.passwordFile.toString(), pki.trust.toString(), pki.crls.toString())));
    }

    @Test
    @DisplayName("PA-22: the approver's signature and the organisation's seal both validate (TOTAL_PASSED)")
    void personAndSeal() {
        ApprovalSigner.Outcome o = signer.sign(DOC, "E1", "GA", Instant.now());
        assertThat(o.ok()).as(o.failureCode() + " " + o.failureMessage() + " " + o.checks()).isTrue();
        assertThat(o.checks()).extracting(ApprovalSigner.Check::role).containsExactlyInAnyOrder("PERSON", "SEAL");
        assertThat(o.checks()).allMatch(ApprovalSigner.Check::passed);
        assertThat(new String(o.signed(), StandardCharsets.UTF_8)).contains("\"signatures\"");
        // the stored document re-validates later with both signatures intact
        assertThat(signer.validate(o.signed(), o.checks().get(0).certificate(), o.checks().get(1).certificate()))
                .allMatch(ApprovalSigner.Check::passed).hasSize(2);
    }

    @Test
    @DisplayName("PA-22: revoked, expired and untrusted certificates are refused with a reason")
    void refusals() {
        assertThat(signer.sign(DOC, "E2", "GA", Instant.now()).failureCode()).isEqualTo("CERTIFICATE_REVOKED");
        assertThat(signer.sign(DOC, "E3", "GA", Instant.now()).failureCode()).isEqualTo("CERTIFICATE_EXPIRED");
        assertThat(signer.sign(DOC, "E4", "GA", Instant.now()).failureCode()).isEqualTo("CERTIFICATE_UNTRUSTED");
        assertThat(signer.sign(DOC, "E9", "GA", Instant.now()).failureCode()).isEqualTo("PERSON_CERTIFICATE_MISSING");
        assertThat(signer.sign(DOC, "E1", "XX", Instant.now()).failureCode()).isEqualTo("SEAL_CERTIFICATE_MISSING");
        assertThat(signer.sign(DOC, "../E1", "GA", Instant.now()).failureCode()).isEqualTo("PERSON_CERTIFICATE_MISSING");
    }

    @Test
    @DisplayName("PA-23: no provider configured fails closed")
    void noProvider() {
        ApprovalSigner none = new ApprovalSigner(new Pkcs12DirectoryProvider(new SigningProperties("NONE", null, null, null, null)));
        assertThat(none.sign(DOC, "E1", "GA", Instant.now()).failureCode()).isEqualTo("PROVIDER_UNAVAILABLE");
    }
}
