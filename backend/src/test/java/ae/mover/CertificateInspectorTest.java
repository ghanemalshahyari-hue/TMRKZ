package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

import org.bouncycastle.asn1.x509.KeyPurposeId;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import ae.mover.security.CertificateInspector;
import ae.mover.security.CertificateInspector.Parsed;
import ae.mover.security.CertificateInspector.Upload;

/** ADR-105: certificate files in every usual format are read, matched to their key and checked as install-cert.sh checks them. */
class CertificateInspectorTest {

    static TlsTestPki.Issued root;
    static TlsTestPki.Issued inter;
    static TlsTestPki.Issued leaf;

    @BeforeAll
    static void pki() throws Exception {
        root = TlsTestPki.root("Test Root CA");
        inter = TlsTestPki.intermediate("Test Issuing CA", root);
        leaf = TlsTestPki.server("tmrkz.test", inter, List.of("tmrkz.test", "*.apps.tmrkz.test"), List.of("10.1.2.3"), KeyPurposeId.id_kp_serverAuth,
                Instant.now().minus(Duration.ofDays(1)), Instant.now().plus(Duration.ofDays(365)), null);
    }

    private static Upload text(String name, String s) {
        return new Upload(name, s.getBytes(StandardCharsets.US_ASCII));
    }

    @Test
    @DisplayName("CERT-U1 PEM bundle with a PKCS#8 key: certificates and the matching key; another key does not match")
    void pemBundle() throws Exception {
        Parsed p = CertificateInspector.parse(List.of(text("server.pem", TlsTestPki.pem(leaf.cert(), inter.cert(), root.cert())),
                text("server.key", TlsTestPki.pkcs8(leaf.keys().getPrivate()))), null);
        assertThat(p.certificates()).hasSize(3);
        assertThat(CertificateInspector.matches(p.key(), leaf.cert())).isTrue();
        assertThat(CertificateInspector.matches(TlsTestPki.rsa().getPrivate(), leaf.cert())).isFalse();
        assertThat(p.toString()).doesNotContain("PRIVATE");
    }

    @Test
    @DisplayName("CERT-U2 PKCS#1 RSA, encrypted PKCS#8 (password required, wrong one refused), EC keys")
    void keyFormats() throws Exception {
        assertThat(CertificateInspector.parse(List.of(text("k.pem", TlsTestPki.pem(leaf.keys().getPrivate()))), null).key()).isNotNull();
        String enc = TlsTestPki.encryptedPkcs8(leaf.keys().getPrivate(), "Key#Pass-1");
        assertThat(CertificateInspector.matches(CertificateInspector.parse(List.of(text("k.pem", enc)), "Key#Pass-1".toCharArray()).key(),
                leaf.cert())).isTrue();
        assertThatThrownBy(() -> CertificateInspector.parse(List.of(text("k.pem", enc)), null)).hasMessageContaining("كلمة مرور");
        assertThatThrownBy(() -> CertificateInspector.parse(List.of(text("k.pem", enc)), "wrong".toCharArray())).hasMessageContaining("غير صحيحة");
        KeyPair ec = TlsTestPki.ec();
        TlsTestPki.Issued ecLeaf = TlsTestPki.server("ec.tmrkz.test", inter, List.of("ec.tmrkz.test"), List.of(), KeyPurposeId.id_kp_serverAuth,
                Instant.now().minus(Duration.ofDays(1)), Instant.now().plus(Duration.ofDays(30)), ec);
        Parsed p = CertificateInspector.parse(List.of(text("ec.pem", TlsTestPki.pem(ecLeaf.cert()) + TlsTestPki.pkcs8(ec.getPrivate()))), null);
        assertThat(CertificateInspector.matches(p.key(), ecLeaf.cert())).isTrue();
    }

    @Test
    @DisplayName("CERT-U3 PKCS#12 with its password, DER certificate, DER and PEM PKCS#7; two keys refused")
    void containers() throws Exception {
        byte[] pfx = TlsTestPki.pkcs12(leaf.keys().getPrivate(), "Pfx#Pass-1", leaf.cert(), inter.cert(), root.cert());
        Parsed p = CertificateInspector.parse(List.of(new Upload("server.pfx", pfx)), "Pfx#Pass-1".toCharArray());
        assertThat(p.certificates()).hasSize(3);
        assertThat(CertificateInspector.matches(p.key(), leaf.cert())).isTrue();
        assertThatThrownBy(() -> CertificateInspector.parse(List.of(new Upload("server.pfx", pfx)), "nope".toCharArray()))
                .hasMessageContaining("غير صحيحة");
        assertThat(CertificateInspector.parse(List.of(new Upload("root.cer", root.cert().getEncoded())), null).certificates()).hasSize(1);
        byte[] p7 = TlsTestPki.p7b(inter.cert(), root.cert());
        assertThat(CertificateInspector.parse(List.of(new Upload("chain.p7b", p7)), null).certificates()).hasSize(2);
        String p7pem = "-----BEGIN PKCS7-----\n" + java.util.Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(p7) + "\n-----END PKCS7-----\n";
        assertThat(CertificateInspector.parse(List.of(text("chain.p7b", p7pem)), null).certificates()).hasSize(2);
        assertThatThrownBy(() -> CertificateInspector.parse(List.of(text("a.key", TlsTestPki.pkcs8(leaf.keys().getPrivate())),
                text("b.key", TlsTestPki.pkcs8(TlsTestPki.rsa().getPrivate()))), null)).hasMessageContaining("أكثر من مفتاح");
        assertThatThrownBy(() -> CertificateInspector.parse(List.of(text("x.txt", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")), null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("CERT-U4 host names: exact, a wildcard covers one label only, IP alternative name; a missing name fails")
    void hostNames() {
        assertThat(CertificateInspector.hostMatches(leaf.cert(), "TMRKZ.test")).isTrue();
        assertThat(CertificateInspector.hostMatches(leaf.cert(), "a.apps.tmrkz.test")).isTrue();
        assertThat(CertificateInspector.hostMatches(leaf.cert(), "a.b.apps.tmrkz.test")).isFalse();
        assertThat(CertificateInspector.hostMatches(leaf.cert(), "10.1.2.3")).isTrue();
        assertThat(CertificateInspector.hostMatches(leaf.cert(), "10.1.2.4")).isFalse();
        assertThat(CertificateInspector.hostMatches(leaf.cert(), "other.test")).isFalse();
    }

    @Test
    @DisplayName("CERT-U5 chains: complete validates for server use; incomplete stops; client-only, expired and not-yet-valid fail")
    void chains() throws Exception {
        List<java.security.cert.X509Certificate> path = CertificateInspector.chainOf(leaf.cert(), List.of(root.cert(), inter.cert()));
        assertThat(path).containsExactly(leaf.cert(), inter.cert(), root.cert());
        assertThat(CertificateInspector.validate(path, Instant.now(), true)).isNull();
        assertThat(CertificateInspector.chainOf(leaf.cert(), List.of(root.cert()))).containsExactly(leaf.cert());
        assertThat(CertificateInspector.validate(List.of(leaf.cert()), Instant.now(), true)).isNotNull();
        TlsTestPki.Issued client = TlsTestPki.server("client.tmrkz.test", inter, List.of("client.tmrkz.test"), List.of(), KeyPurposeId.id_kp_clientAuth,
                Instant.now().minus(Duration.ofDays(1)), Instant.now().plus(Duration.ofDays(30)), null);
        assertThat(CertificateInspector.serverAuth(client.cert())).isFalse();
        assertThat(CertificateInspector.validate(List.of(client.cert(), inter.cert(), root.cert()), Instant.now(), true)).isNotNull();
        TlsTestPki.Issued expired = TlsTestPki.server("old.tmrkz.test", inter, List.of("old.tmrkz.test"), List.of(), KeyPurposeId.id_kp_serverAuth,
                Instant.now().minus(Duration.ofDays(30)), Instant.now().minus(Duration.ofDays(1)), null);
        assertThat(CertificateInspector.health(expired.cert(), Instant.now())).isEqualTo("EXPIRED");
        assertThat(CertificateInspector.validate(List.of(expired.cert(), inter.cert(), root.cert()), Instant.now(), true)).isNotNull();
        TlsTestPki.Issued soon = TlsTestPki.server("soon.tmrkz.test", inter, List.of("soon.tmrkz.test"), List.of(), KeyPurposeId.id_kp_serverAuth,
                Instant.now().minus(Duration.ofDays(1)), Instant.now().plus(Duration.ofDays(10)), null);
        assertThat(CertificateInspector.describe(soon.cert(), Instant.now()).get("health")).isEqualTo("EXPIRING");
        assertThat(CertificateInspector.describe(root.cert(), Instant.now()).get("role")).isEqualTo("ROOT");
        assertThat(CertificateInspector.describe(inter.cert(), Instant.now()).get("role")).isEqualTo("INTERMEDIATE");
    }
}
