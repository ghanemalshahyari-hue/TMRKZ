package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.File;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.fasterxml.jackson.databind.JsonNode;
import com.unboundid.ldap.listener.InMemoryDirectoryServer;
import com.unboundid.ldap.listener.InMemoryDirectoryServerConfig;
import com.unboundid.ldap.listener.InMemoryListenerConfig;
import com.unboundid.util.ssl.KeyStoreKeyManager;
import com.unboundid.util.ssl.SSLUtil;
import com.unboundid.util.ssl.TrustAllTrustManager;

/**
 * Manual sign-in with the directory username and password (the second path of the TNQL sign-in page): a StartTLS directory
 * whose certificate is trusted through the CA folder, exactly as in production. Also the step-up before approval for such
 * a session, throttling, refusal of an untrusted certificate, and the first administrator of an empty installation.
 */
class DirectorySignInIT extends IntegrationTest {

    static final String BASE = "dc=tmrkz,dc=test";
    static final String PEOPLE = "ou=people," + BASE;
    static final String PASSWORD_OK = "Directory#Pass-1";
    static final InMemoryDirectoryServer LDAP;
    static final Path CA_DIR;
    static final Path CA_FILE;

    static {
        try {
            Path dir = Files.createTempDirectory("tmrkz-ldap");
            File keystore = dir.resolve("ldap.p12").toFile();
            String keytool = Path.of(System.getProperty("java.home"), "bin", "keytool").toString();
            run(keytool, "-genkeypair", "-alias", "ldap", "-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=localhost",
                    "-ext", "SAN=dns:localhost,ip:127.0.0.1", "-validity", "2", "-keystore", keystore.getPath(),
                    "-storetype", "PKCS12", "-storepass", "changeit", "-keypass", "changeit");
            CA_DIR = Files.createDirectories(dir.resolve("ca"));
            CA_FILE = CA_DIR.resolve("directory-ca.pem");
            run(keytool, "-exportcert", "-rfc", "-alias", "ldap", "-keystore", keystore.getPath(), "-storetype", "PKCS12",
                    "-storepass", "changeit", "-file", CA_FILE.toString());
            InMemoryDirectoryServerConfig cfg = new InMemoryDirectoryServerConfig(BASE);
            cfg.addAdditionalBindCredentials("cn=service," + BASE, "service-secret");
            SSLUtil server = new SSLUtil(new KeyStoreKeyManager(keystore, "changeit".toCharArray(), "PKCS12", "ldap"), new TrustAllTrustManager());
            cfg.setListenerConfigs(InMemoryListenerConfig.createLDAPConfig("ldap", InetAddress.getLoopbackAddress(), 0,
                    server.createSSLSocketFactory()));
            LDAP = new InMemoryDirectoryServer(cfg);
            LDAP.add("dn: " + BASE, "objectClass: domain", "dc: tmrkz");
            LDAP.add("dn: " + PEOPLE, "objectClass: organizationalUnit", "ou: people");
            LDAP.add("dn: ou=other," + BASE, "objectClass: organizationalUnit", "ou: other");
            LDAP.startListening();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static void run(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes());
        if (p.waitFor() != 0) {
            throw new IllegalStateException("command failed: " + out);
        }
    }

    @DynamicPropertySource
    static void directory(DynamicPropertyRegistry r) {
        r.add("tmrkz.ldap.url", () -> "ldap://localhost:" + LDAP.getListenPort());
        r.add("tmrkz.ldap.start-tls", () -> "true");
        r.add("tmrkz.ldap.bind-dn", () -> "cn=service," + BASE);
        r.add("tmrkz.ldap.bind-credential", () -> "service-secret");
        r.add("tmrkz.ldap.users-dn", () -> BASE);
        r.add("tmrkz.ldap.ca-dir", CA_DIR::toString);
    }

    UUID org;
    UUID snapshot;

    @BeforeEach
    void mirror() {
        jdbc.sql("delete from hr_sync_issue").update();
        jdbc.sql("delete from hr_unit").update();
        jdbc.sql("delete from hr_person").update();
        jdbc.sql("delete from hr_snapshot").update();
        jdbc.sql("delete from hr_sync_run").update();
        jdbc.sql("delete from hr_mapping_version").update();
        jdbc.sql("delete from hr_source").update();
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        snapshot = UUID.randomUUID();
        jdbc.sql("insert into hr_source(id, name, last_success_at) values (:id, 'مصدر اختبار', now())").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'PUBLISHED', '[]', '{}')")
                .param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, source_id, mapping_version_id, trigger, status, started_at) values (:id, :s, :m, 'SCHEDULED', 'SUCCEEDED', now())")
                .param("id", runId).param("s", source).param("m", mapping).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())")
                .param("id", snapshot).param("r", runId).param("m", mapping).update();
        org = org("ORG", null);
    }

    private String uid(String name) {
        return name + "." + sfx;
    }

    private void directoryUser(String name, String ou) throws Exception {
        LDAP.add("dn: uid=" + uid(name) + "," + ou, "objectClass: inetOrgPerson", "uid: " + uid(name), "cn: Test " + name,
                "sn: " + name, "employeeNumber: E-" + uid(name), "userPassword: " + PASSWORD_OK);
    }

    /** HR person (in the published snapshot) whose domain account is the directory login. */
    private UUID hrPerson(String name) {
        UUID id = UUID.randomUUID();
        String ext = "X-" + uid(name);
        jdbc.sql("insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, active) values (:s, :x, :n, :a, :f, true)")
                .param("s", snapshot).param("x", ext).param("n", "N-" + uid(name)).param("a", uid(name)).param("f", "موظف " + name).update();
        jdbc.sql("insert into person(id, employee_no, display_name, status, source, source_external_id) values (:id, :n, :f, 'ACTIVE', 'HR', :x)")
                .param("id", id).param("n", "N-" + uid(name)).param("f", "موظف " + name).param("x", ext).update();
        membership(id, "REQUESTER", org, null);
        return id;
    }

    record Signed(int status, JsonNode body, String cookie) {
    }

    private Signed signIn(String user, String password) throws Exception {
        HttpResponse<String> r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/auth/directory/login"))
                .header("Content-Type", "application/json").header("X-Requested-With", "mover")
                .POST(HttpRequest.BodyPublishers.ofString(write(Map.of("username", user, "password", password)))).build(), HttpResponse.BodyHandlers.ofString());
        String cookie = r.headers().allValues("Set-Cookie").stream().filter(c -> c.startsWith("MOVER_SESSION=")).map(c -> c.split(";")[0]).findFirst().orElse(null);
        return new Signed(r.statusCode(), r.body().isEmpty() ? null : JSON.readTree(r.body()), cookie);
    }

    private HttpResponse<String> call(String cookie, String method, String path, Object body) throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1" + path))
                .header("Content-Type", "application/json").header("X-Requested-With", "mover").header("Cookie", cookie)
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(write(body))).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    // ---- tests ----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("Manual sign-in: the directory verifies the password over StartTLS; wrong, unknown and empty passwords get one answer")
    void manualSignIn() throws Exception {
        directoryUser("alice", PEOPLE);
        UUID person = hrPerson("alice");
        Signed ok = signIn(uid("alice"), PASSWORD_OK);
        assertThat(ok.status()).as(String.valueOf(ok.body())).isEqualTo(200);
        assertThat(ok.cookie()).isNotNull();
        JsonNode me = JSON.readTree(call(ok.cookie(), "GET", "/me", null).body());
        assertThat(me.path("id").asText()).isEqualTo(person.toString());
        assertThat(me.path("signInMethod").asText()).isEqualTo("DIRECTORY");
        Map<String, Object> link = jdbc.sql("select issuer, subject, method from identity_link where person_id = :p").param("p", person).query().singleRow();
        assertThat(link.get("issuer")).isEqualTo("urn:tmrkz:directory");
        assertThat((String) link.get("subject")).hasSize(36); // the directory's entryUUID, not the login name
        assertThat(JSON.readTree(call(ok.cookie(), "POST", "/auth/logout", Map.of()).body()).path("redirect").asText()).isEqualTo("/?signed-out=1");

        Signed wrong = signIn(uid("alice"), "not-the-password");
        Signed unknown = signIn(uid("nobody"), "whatever-1");
        Signed empty = signIn(uid("alice"), "");
        assertThat(wrong.status()).isEqualTo(401);
        assertThat(unknown.status()).isEqualTo(401);
        assertThat(empty.status()).isEqualTo(401);
        assertThat(wrong.body().path("message").asText()).isEqualTo(unknown.body().path("message").asText());
        assertThat(wrong.cookie()).isNull();
        assertThat(JSON.readTree(HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/auth/status")).build(),
                HttpResponse.BodyHandlers.ofString()).body()).path("manual").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("Manual sign-in: repeated failures lock the login name; several directory entries for one login are never linked")
    void throttlingAndAmbiguity() throws Exception {
        directoryUser("bob", PEOPLE);
        hrPerson("bob");
        for (int i = 0; i < 5; i++) {
            assertThat(signIn(uid("bob"), "wrong-" + i).status()).isEqualTo(401);
        }
        Signed locked = signIn(uid("bob"), PASSWORD_OK);
        assertThat(locked.status()).isEqualTo(429);
        assertThat(locked.body().path("code").asText()).isEqualTo("SIGN_IN_THROTTLED");

        directoryUser("twin", PEOPLE);
        directoryUser("twin", "ou=other," + BASE);
        hrPerson("twin");
        Signed twin = signIn(uid("twin"), PASSWORD_OK);
        assertThat(twin.status()).isEqualTo(403);
        assertThat(twin.body().path("details").path("reason").asText()).isEqualTo("AMBIGUOUS");
    }

    @Test
    @DisplayName("Manual sign-in: a directory certificate outside the trusted CAs is refused before any credential is sent")
    void untrustedDirectory() throws Exception {
        directoryUser("carol", PEOPLE);
        hrPerson("carol");
        Path aside = CA_DIR.resolveSibling("directory-ca.pem.aside");
        Files.move(CA_FILE, aside, StandardCopyOption.REPLACE_EXISTING);
        try {
            Signed refused = signIn(uid("carol"), PASSWORD_OK);
            assertThat(refused.status()).isEqualTo(503);
            assertThat(refused.body().path("code").asText()).isEqualTo("DIRECTORY_TLS_FAILED");
            assertThat(refused.cookie()).isNull();
        } finally {
            Files.move(aside, CA_FILE, StandardCopyOption.REPLACE_EXISTING);
        }
        assertThat(signIn(uid("carol"), PASSWORD_OK).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("Approval after manual sign-in needs the directory password again when the sign-in is older than five minutes")
    void stepUpWithDirectoryPassword() throws Exception {
        directoryUser("dave", PEOPLE);
        UUID approver = hrPerson("dave");
        membership(approver, "APPROVER", org, null);
        UUID siteId = site("S", null, org);
        UUID res = resource("R", siteId, null, 0);
        person("req", "REQUESTER", org);
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        UUID request = login("req").submitted(type, org, List.of(res), day("2029-04-01"), day("2029-04-02"));
        String cookie = signIn(uid("dave"), PASSWORD_OK).cookie();
        jdbc.sql("update user_session set authenticated_at = now() - interval '1 hour' where person_id = :p").param("p", approver).update();
        String task = jdbc.sql("select id::text from task_assignment where request_id = :r").param("r", request).query(String.class).single();
        Map<String, Object> decision = Map.of("decision", "APPROVE", "expectedRevision", 1, "signature", Map.of("confirm", true));
        HttpResponse<String> stale = call(cookie, "POST", "/tasks/" + task + "/decision", decision);
        assertThat(stale.statusCode()).isEqualTo(403);
        assertThat(JSON.readTree(stale.body()).path("code").asText()).isEqualTo("REAUTHENTICATION_REQUIRED");
        assertThat(call(cookie, "POST", "/auth/directory/reauth", Map.of("password", "wrong-password")).statusCode()).isEqualTo(403);
        assertThat(call(cookie, "POST", "/tasks/" + task + "/decision", decision).statusCode()).isEqualTo(403);
        assertThat(call(cookie, "POST", "/auth/directory/reauth", Map.of("password", PASSWORD_OK)).statusCode()).isEqualTo(204);
        HttpResponse<String> ok = call(cookie, "POST", "/tasks/" + task + "/decision", decision);
        assertThat(ok.statusCode()).as(ok.body()).isEqualTo(200);
        assertThat(activeReservations(res)).isEqualTo(1);
    }

    @Test
    @DisplayName("Empty installation: one registered login becomes a temporary administrator, then moves to its HR record")
    void bootstrapAdministrator() throws Exception {
        // An empty installation has no active system administrator (earlier fixtures' grants are ended for this test).
        jdbc.sql("update membership set valid_to = now() where role_code = 'SYSTEM_ADMIN' and (valid_to is null or valid_to > now())").update();
        directoryUser("first", PEOPLE);
        jdbc.sql("delete from hr_person").update(); // the HR mirror does not contain the person yet
        assertThat(signIn(uid("first"), PASSWORD_OK).status()).isEqualTo(403);
        jdbc.sql("insert into bootstrap_admin(login, expires_at) values (:l, now() + interval '24 hours')").param("l", uid("first")).update();
        Signed boot = signIn(uid("first"), PASSWORD_OK);
        assertThat(boot.status()).as(String.valueOf(boot.body())).isEqualTo(200);
        JsonNode me = JSON.readTree(call(boot.cookie(), "GET", "/me", null).body());
        assertThat(me.path("permissions").toString()).contains("CONFIGURE", "MANAGE_ACCESS").doesNotContain("\"VIEW\"");
        UUID bootPerson = UUID.fromString(me.path("id").asText());
        assertThat(jdbc.sql("select valid_to - valid_from from membership where person_id = :p").param("p", bootPerson).query(String.class).single())
                .isEqualTo("3 days");
        // The request is single use and is refused while an administrator exists.
        jdbc.sql("insert into bootstrap_admin(login, expires_at) values (:l, now() + interval '24 hours')").param("l", uid("second")).update();
        directoryUser("second", PEOPLE);
        assertThat(signIn(uid("second"), PASSWORD_OK).status()).isEqualTo(403);

        // The HR mirror now has the person: the next sign-in moves to the HR record and ends the temporary grant.
        UUID hr = hrPerson("first");
        Signed later = signIn(uid("first"), PASSWORD_OK);
        assertThat(JSON.readTree(call(later.cookie(), "GET", "/me", null).body()).path("id").asText()).isEqualTo(hr.toString());
        assertThat(jdbc.sql("select status from person where id = :p").param("p", bootPerson).query(String.class).single()).isEqualTo("DISABLED");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'BOOTSTRAP_ADMIN_REPLACED' and entity_id = :p").param("p", hr.toString())
                .query(Long.class).single()).isEqualTo(1);
    }
}
