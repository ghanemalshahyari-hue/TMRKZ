package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
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
import com.fasterxml.jackson.databind.ObjectMapper;

import ae.mover.security.CertificateInspector;

/**
 * ADR-105 «الشهادات»: only a global administrator; each service's trust (directory, Keycloak) checked live before and after it is
 * applied, refused when it would break a working connection, restorable; the https server certificate checked (key, validity,
 * server use, host name, chain) and staged for the maintenance worker, whose inventory is simulated here; a private key never
 * appears in a response or the audit log and leaves the staging volume when the request is over.
 */
class CertificateCenterIT extends IntegrationTest {

    static final Path STAGE;
    static final ObjectMapper MAPPER = new ObjectMapper();

    static {
        try {
            STAGE = Files.createTempDirectory("tmrkz-cert-it");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @DynamicPropertySource
    static void stage(DynamicPropertyRegistry r) {
        r.add("tmrkz.update.dir", STAGE::toString);
    }

    UUID root;
    Api admin;

    /** The integration sections are shared by every test class of this run: cleared through the service, so its cache renews. */
    @AfterEach
    void clearSections() {
        for (String section : java.util.List.of("directory", "oidc", "assistant")) {
            admin.delete("/settings/integration/" + section);
        }
    }

    @BeforeEach
    void fixtures() throws Exception {
        root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
        worker();
    }

    private static void worker() throws Exception {
        Files.writeString(STAGE.resolve("worker.json"), "{\"at\":\"" + Instant.now() + "\",\"version\":\"test\"}");
    }

    private static Map<String, Object> file(String name, byte[] content) {
        return Map.of("name", name, "contentBase64", Base64.getEncoder().encodeToString(content));
    }

    private static Map<String, Object> file(String name, String text) {
        return file(name, text.getBytes(StandardCharsets.US_ASCII));
    }

    /** What the maintenance worker lists: the https folder with its key (public half only), and the machine's certs/ folder. */
    private static void inventory(String keySpki, String certsPem) throws Exception {
        List<Map<String, Object>> https = new ArrayList<>();
        if (keySpki != null) {
            https.add(Map.of("name", "server.key", "size", 1704, "kind", "KEY", "keyAlgorithm", "RSA", "publicKeySha256", keySpki));
        }
        Map<String, Object> inv = new LinkedHashMap<>();
        inv.put("at", Instant.now().toString());
        inv.put("config", Map.of("tlsDir", "ops/tls/private", "trustDir", "ops/local/.generated/truststore", "certsDir", "certs",
                "httpsEnabled", false, "publicUrl", "https://tmrkz.test", "publicHost", "tmrkz.test"));
        inv.put("stores", List.of(
                Map.of("id", "HTTPS", "path", "ops/tls/private", "exists", true, "visible", true, "writable", true, "files", https),
                Map.of("id", "CERTS", "path", "certs", "exists", true, "visible", true, "writable", false, "files",
                        List.of(Map.of("name", "org-root.pem", "size", certsPem.length(), "kind", "CERTIFICATES", "pem", certsPem)))));
        Files.writeString(STAGE.resolve("certificate-inventory.json"), MAPPER.writeValueAsString(inv));
    }

    private static Map<String, Object> directory(String pem) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("enabled", true);
        d.put("server", "localhost");
        d.put("port", DirectorySignInIT.LDAP.getListenPort());
        d.put("securityMode", "starttls");
        d.put("baseDn", DirectorySignInIT.BASE);
        d.put("bindDn", "cn=service," + DirectorySignInIT.BASE);
        d.put("bindPassword", "service-secret");
        d.put("usernameAttribute", "uid");
        d.put("uuidAttribute", "entryUUID");
        d.put("employeeNumberAttribute", "employeeNumber");
        d.put("userObjectClass", "inetOrgPerson");
        d.put("caCertificatesPem", pem);
        d.put("timeoutSeconds", 5);
        return d;
    }

    private static String status(JsonNode view, String code) {
        for (JsonNode c : view.path("checks")) {
            if (code.equals(c.path("code").asText()) && !"INFO".equals(c.path("status").asText())) {
                return c.path("status").asText();
            }
        }
        return null;
    }

    private long audits(String action, String id) {
        return jdbc.sql("select count(*) from audit_event where action = :a and entity_id = :id").param("a", action).param("id", id)
                .query(Long.class).single();
    }

    @Test
    @DisplayName("CRT-01 directory trust: global administrator only; a list that breaks a working connection is refused; added, applied with a reason, restored")
    void directoryTrust() throws Exception {
        String ldapCa = Files.readString(DirectorySignInIT.CA_FILE, StandardCharsets.US_ASCII);
        assertThat(admin.put("/settings/integration/directory", directory(ldapCa)).status()).isEqualTo(200);
        person("cfg", role("CFG", "ORGANIZATION", "VIEW", "CONFIGURE"), root);
        Api cfg = login("cfg");
        assertThat(cfg.get("/settings/certificates").status()).isEqualTo(403);
        assertThat(cfg.post("/settings/certificates/check", Map.of("target", "DIRECTORY", "files", List.of(file("a.pem", ldapCa)))).status())
                .isEqualTo(403);

        JsonNode overview = admin.get("/settings/certificates").body();
        JsonNode dirStore = null;
        for (JsonNode s : overview.path("stores")) {
            if ("DIRECTORY".equals(s.path("id").asText())) {
                dirStore = s;
            }
        }
        assertThat(dirStore).isNotNull();
        assertThat(dirStore.path("certificates").size()).isEqualTo(1);

        TlsTestPki.Issued other = TlsTestPki.root("Unrelated Root " + sfx);
        Res replace = admin.post("/settings/certificates/check", Map.of("target", "DIRECTORY", "mode", "REPLACE",
                "files", List.of(file("other.pem", TlsTestPki.pem(other.cert())))));
        assertThat(replace.status()).as(replace.toString()).isEqualTo(200);
        assertThat(replace.body().path("state").asText()).isEqualTo("BLOCKED");
        assertThat(status(replace.body(), "LIVE_TLS")).as("works now, breaks with the new list").isEqualTo("FAIL");
        assertThat(admin.post("/settings/certificates/sessions/" + replace.body().path("id").asText() + "/apply", Map.of("reason", "محاولة")).status())
                .isEqualTo(409);

        Res add = admin.post("/settings/certificates/check", Map.of("target", "DIRECTORY", "mode", "ADD",
                "files", List.of(file("other.pem", TlsTestPki.pem(other.cert())))));
        String id = add.body().path("id").asText();
        assertThat(add.body().path("state").asText()).as(add.toString()).isEqualTo("CHECKED");
        assertThat(status(add.body(), "LIVE_TLS")).isEqualTo("PASS");
        assertThat(add.body().path("plan").path("after").size()).isEqualTo(2);
        assertThat(cfg.post("/settings/certificates/sessions/" + id + "/apply", Map.of("reason", "تجديد")).status()).isEqualTo(403);
        assertThat(admin.post("/settings/certificates/sessions/" + id + "/apply", Map.of()).status()).isEqualTo(400);
        Res applied = admin.post("/settings/certificates/sessions/" + id + "/apply", Map.of("reason", "إضافة جهة الإصدار الجديدة"));
        assertThat(applied.body().path("state").asText()).as(applied.toString()).isEqualTo("APPLIED");
        String saved = admin.get("/settings/integration/directory").body().path("saved").path("caCertificatesPem").asText();
        assertThat(CertificateInspector.certificates(saved)).hasSize(2);
        assertThat(audits("CERT_APPLIED", id)).isEqualTo(1);
        assertThat(admin.get("/settings/integration/status").body().path("directory").path("state").asText()).isEqualTo("UP");

        Res restored = admin.post("/settings/certificates/sessions/" + id + "/restore", Map.of("reason", "الرجوع للقائمة السابقة"));
        assertThat(restored.body().path("state").asText()).as(restored.toString()).isEqualTo("RESTORED");
        saved = admin.get("/settings/integration/directory").body().path("saved").path("caCertificatesPem").asText();
        assertThat(CertificateInspector.certificates(saved)).hasSize(1);
        assertThat(admin.post("/settings/certificates/sessions/" + id + "/restore", Map.of("reason", "مرة ثانية")).status()).isEqualTo(409);

        // a private key in a trust import: refused, never stored, never echoed
        String keyPem = TlsTestPki.pkcs8(other.keys().getPrivate());
        Res withKey = admin.post("/settings/certificates/check", Map.of("target", "DIRECTORY",
                "files", List.of(file("bundle.pem", TlsTestPki.pem(other.cert()) + keyPem))));
        assertThat(withKey.body().path("state").asText()).isEqualTo("BLOCKED");
        assertThat(status(withKey.body(), "PRIVATE_KEY")).isEqualTo("FAIL");
        String keyBody = keyPem.split("\n")[2];
        assertThat(withKey.toString()).doesNotContain("PRIVATE KEY-----").doesNotContain(keyBody);
        try (var files = Files.walk(STAGE.resolve("certificates").resolve(withKey.body().path("id").asText()))) {
            for (Path f : files.filter(Files::isRegularFile).toList()) {
                assertThat(Files.readString(f, StandardCharsets.ISO_8859_1)).as(f.toString()).doesNotContain(keyBody);
            }
        }
        assertThat(jdbc.sql("select count(*) from audit_event where detail::text like :k").param("k", "%" + keyBody + "%").query(Long.class).single())
                .isZero();

        // an expired certificate
        TlsTestPki.Issued expired = TlsTestPki.server("old.tmrkz.test", other, List.of("old.tmrkz.test"), List.of(),
                org.bouncycastle.asn1.x509.KeyPurposeId.id_kp_serverAuth, Instant.now().minusSeconds(86400 * 30), Instant.now().minusSeconds(86400), null);
        Res old = admin.post("/settings/certificates/check", Map.of("target", "DIRECTORY", "files", List.of(file("old.pem", TlsTestPki.pem(expired.cert())))));
        assertThat(status(old.body(), "VALIDITY")).isEqualTo("FAIL");
    }

    @Test
    @DisplayName("CRT-02 https: key, validity, server use, host name and chain checked; staged for the worker only when all pass; a key stays private and is removed")
    void httpsServerCertificate() throws Exception {
        TlsTestPki.Issued orgRoot = TlsTestPki.root("Org Root " + sfx);
        TlsTestPki.Issued issuing = TlsTestPki.intermediate("Org Issuing " + sfx, orgRoot);
        TlsTestPki.Issued leaf = TlsTestPki.server("tmrkz.test", issuing, "tmrkz.test");
        inventory(CertificateInspector.spki(leaf.keys().getPublic()), TlsTestPki.pem(orgRoot.cert()));

        // the certificate issued for this server's own key (server.key stays where it is); the root taken from certs/
        Res ok = admin.post("/settings/certificates/check", Map.of("target", "HTTPS",
                "files", List.of(file("issued.cer", leaf.cert().getEncoded()), file("issuing.crt", TlsTestPki.pem(issuing.cert()))),
                "fromInventory", List.of(Map.of("store", "CERTS", "file", "org-root.pem"))));
        assertThat(ok.status()).as(ok.toString()).isEqualTo(200);
        assertThat(ok.body().path("state").asText()).as(ok.toString()).isEqualTo("CHECKED");
        for (String c : List.of("KEY_MATCH", "VALIDITY", "SERVER_AUTH", "HOSTNAME", "CHAIN", "KEY_STRENGTH")) {
            assertThat(status(ok.body(), c)).as(c + " " + ok).isEqualTo("PASS");
        }
        Path s = STAGE.resolve("certificates").resolve(ok.body().path("id").asText());
        assertThat(CertificateInspector.certificates(Files.readString(s.resolve("new/server.crt")))).hasSize(2);
        assertThat(CertificateInspector.certificates(Files.readString(s.resolve("new/ca-chain.pem")))).hasSize(2);
        assertThat(Files.exists(s.resolve("new/server.key"))).as("the key on the server is kept").isFalse();

        // a certificate for another key
        TlsTestPki.Issued foreign = TlsTestPki.server("tmrkz.test", issuing, "tmrkz.test");
        Res wrongKey = admin.post("/settings/certificates/check", Map.of("target", "HTTPS",
                "files", List.of(file("chain.pem", TlsTestPki.pem(foreign.cert(), issuing.cert(), orgRoot.cert())))));
        assertThat(wrongKey.body().path("state").asText()).isEqualTo("BLOCKED");
        assertThat(status(wrongKey.body(), "KEY_MATCH")).isEqualTo("FAIL");
        assertThat(Files.exists(STAGE.resolve("certificates").resolve(wrongKey.body().path("id").asText()).resolve("new"))).isFalse();

        // a .pfx with its own key: matched, staged owner-only, never echoed, removed when discarded
        byte[] pfx = TlsTestPki.pkcs12(foreign.keys().getPrivate(), "Pfx#" + sfx, foreign.cert(), issuing.cert(), orgRoot.cert());
        Res noPassword = admin.post("/settings/certificates/check", Map.of("target", "HTTPS", "files", List.of(file("server.pfx", pfx))));
        assertThat(noPassword.status()).isEqualTo(400);
        assertThat(noPassword.toString()).contains("كلمة مرور");
        Res withKey = admin.post("/settings/certificates/check", Map.of("target", "HTTPS", "password", "Pfx#" + sfx, "files",
                List.of(file("server.pfx", pfx))));
        assertThat(withKey.body().path("state").asText()).as(withKey.toString()).isEqualTo("CHECKED");
        assertThat(withKey.body().path("keyProvided").asBoolean()).isTrue();
        Path ks = STAGE.resolve("certificates").resolve(withKey.body().path("id").asText());
        Path stagedKey = ks.resolve("new/server.key");
        assertThat(CertificateInspector.matches(CertificateInspector.parse(List.of(new CertificateInspector.Upload("k",
                Files.readAllBytes(stagedKey))), null).key(), foreign.cert())).isTrue();
        try {
            assertThat(java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(stagedKey))).isEqualTo("rw-------");
        } catch (UnsupportedOperationException ignored) {
            // not a POSIX file system
        }
        String keyBody = Files.readAllLines(stagedKey).get(2);
        assertThat(withKey.toString()).doesNotContain("PRIVATE KEY").doesNotContain(keyBody);
        assertThat(admin.get("/settings/certificates/sessions/" + withKey.body().path("id").asText()).toString()).doesNotContain(keyBody);
        assertThat(jdbc.sql("select count(*) from audit_event where detail::text like :k").param("k", "%" + keyBody + "%").query(Long.class).single())
                .isZero();
        assertThat(admin.post("/settings/certificates/sessions/" + withKey.body().path("id").asText() + "/discard", Map.of()).body()
                .path("state").asText()).isEqualTo("DISCARDED");
        assertThat(Files.exists(stagedKey)).isFalse();

        // the name users open must be on the certificate; the chain must reach a root
        Res otherHost = admin.post("/settings/certificates/check", Map.of("target", "HTTPS", "hostname", "other.tmrkz.test",
                "files", List.of(file("chain.pem", TlsTestPki.pem(leaf.cert(), issuing.cert(), orgRoot.cert())))));
        assertThat(status(otherHost.body(), "HOSTNAME")).isEqualTo("FAIL");
        Res partial = admin.post("/settings/certificates/check", Map.of("target", "HTTPS", "files", List.of(file("leaf.pem", TlsTestPki.pem(leaf.cert())))));
        assertThat(status(partial.body(), "CHAIN")).isEqualTo("FAIL");

        // explicit application hands it to the worker (APPROVED until the worker reports)
        Res approved = admin.post("/settings/certificates/sessions/" + ok.body().path("id").asText() + "/apply", Map.of("reason", "تجديد شهادة الخادم"));
        assertThat(approved.body().path("state").asText()).as(approved.toString()).isEqualTo("APPROVED");
        assertThat(Files.exists(s.resolve("approval.properties"))).isTrue();
        assertThat(admin.post("/settings/certificates/sessions/" + ok.body().path("id").asText() + "/apply", Map.of("reason", "مرة ثانية")).status())
                .isEqualTo(409);

        // without a live worker nothing is staged
        Files.writeString(STAGE.resolve("worker.json"), "{\"at\":\"2020-01-01T00:00:00Z\"}");
        Res noWorker = admin.post("/settings/certificates/check", Map.of("target", "HTTPS",
                "files", List.of(file("chain.pem", TlsTestPki.pem(leaf.cert(), issuing.cert(), orgRoot.cert())))));
        assertThat(status(noWorker.body(), "WORKER")).isEqualTo("FAIL");
    }
}
