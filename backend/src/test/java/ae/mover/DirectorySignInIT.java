package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
        // ADR-068: this directory's names for the employment attributes (standard inetOrgPerson attributes, fictional values)
        r.add("tmrkz.ldap.unit-id-attribute", () -> "departmentNumber");
        r.add("tmrkz.ldap.unit-name-attribute", () -> "ou");
        r.add("tmrkz.ldap.main-unit-id-attribute", () -> "businessCategory");
        r.add("tmrkz.ldap.rank-attribute", () -> "employeeType");
        r.add("tmrkz.ldap.position-attribute", () -> "title");
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

    /** A fictional employee whose entry states their unit (Unit ID and name), main unit, rank and position (ADR-068). */
    private void employee(String name, String unitId, String unitName, String mainUnitId) throws Exception {
        LDAP.add(new com.unboundid.ldap.sdk.Entry("uid=" + uid(name) + "," + PEOPLE,
                new com.unboundid.ldap.sdk.Attribute("objectClass", "inetOrgPerson"), new com.unboundid.ldap.sdk.Attribute("uid", uid(name)),
                new com.unboundid.ldap.sdk.Attribute("cn", "Test " + name), new com.unboundid.ldap.sdk.Attribute("sn", name),
                new com.unboundid.ldap.sdk.Attribute("displayName", "موظف " + name),
                new com.unboundid.ldap.sdk.Attribute("employeeNumber", "E-" + uid(name)),
                new com.unboundid.ldap.sdk.Attribute("userPassword", PASSWORD_OK),
                new com.unboundid.ldap.sdk.Attribute("departmentNumber", unitId), new com.unboundid.ldap.sdk.Attribute("ou", unitName),
                new com.unboundid.ldap.sdk.Attribute("businessCategory", mainUnitId),
                new com.unboundid.ldap.sdk.Attribute("employeeType", "نقيب"), new com.unboundid.ldap.sdk.Attribute("title", "ضابط عمليات")));
    }

    /** A unit TMRKZ already holds, carrying its Unit ID (the join with the directory and, later, Oracle). */
    private UUID unitWithId(String code, UUID parent, String unitId) {
        UUID id = org(code, parent);
        jdbc.sql("update organization set source_external_id = :x where id = :id").param("x", unitId).param("id", id).update();
        return id;
    }

    private long count(String sql, Object param) {
        return jdbc.sql(sql).param("p", param).query(Long.class).single();
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

    /** The manual authenticator for another directory: service search, or the direct bind of ADR-070. */
    private static ae.mover.security.DirectoryAuthenticator authenticator(String url, Path caDir, boolean direct) {
        return new ae.mover.security.DirectoryAuthenticator(new ae.mover.security.LdapProperties(url, true, "cn=service," + BASE,
                "service-secret", BASE, "uid", "entryUUID", "employeeNumber", "inetOrgPerson", caDir.toString(), null, 3000, 5000, 0, 0,
                null, null, null, null, null, direct ? "uid={username}," + PEOPLE : null, null));
    }

    @Test
    @DisplayName("ADR-070: a trusted directory certificate issued for another host name is refused over StartTLS and LDAPS, before any bind")
    void wrongHostname() throws Exception {
        // A second fictional directory whose certificate (trusted through its CA folder) names directory.elsewhere.test and
        // 127.0.0.1 only: dialled as "localhost" the name does not match; dialled as 127.0.0.1 it does (the control).
        Path dir = Files.createTempDirectory("tmrkz-ldap-host");
        File keystore = dir.resolve("other.p12").toFile();
        String keytool = Path.of(System.getProperty("java.home"), "bin", "keytool").toString();
        run(keytool, "-genkeypair", "-alias", "other", "-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=directory.elsewhere.test",
                "-ext", "SAN=dns:directory.elsewhere.test,ip:127.0.0.1", "-validity", "2", "-keystore", keystore.getPath(),
                "-storetype", "PKCS12", "-storepass", "changeit", "-keypass", "changeit");
        Path ca = Files.createDirectories(dir.resolve("ca"));
        run(keytool, "-exportcert", "-rfc", "-alias", "other", "-keystore", keystore.getPath(), "-storetype", "PKCS12",
                "-storepass", "changeit", "-file", ca.resolve("other-ca.pem").toString());
        List<String> requests = new java.util.concurrent.CopyOnWriteArrayList<>();
        InMemoryDirectoryServerConfig cfg = new InMemoryDirectoryServerConfig(BASE);
        cfg.addAdditionalBindCredentials("cn=service," + BASE, "service-secret");
        SSLUtil server = new SSLUtil(new KeyStoreKeyManager(keystore, "changeit".toCharArray(), "PKCS12", "other"), new TrustAllTrustManager());
        cfg.setListenerConfigs(
                InMemoryListenerConfig.createLDAPConfig("starttls", InetAddress.getLoopbackAddress(), 0, server.createSSLSocketFactory()),
                InMemoryListenerConfig.createLDAPSConfig("ldaps", InetAddress.getLoopbackAddress(), 0, server.createSSLServerSocketFactory(),
                        new SSLUtil(new TrustAllTrustManager()).createSSLSocketFactory()));
        cfg.setAccessLogHandler(new java.util.logging.Handler() {
            @Override
            public void publish(java.util.logging.LogRecord record) {
                requests.add(String.valueOf(record.getMessage()));
            }

            @Override
            public void flush() {
            }

            @Override
            public void close() {
            }
        });
        InMemoryDirectoryServer other = new InMemoryDirectoryServer(cfg);
        other.add("dn: " + BASE, "objectClass: domain", "dc: tmrkz");
        other.add("dn: " + PEOPLE, "objectClass: organizationalUnit", "ou: people");
        other.add("dn: uid=hostcheck," + PEOPLE, "objectClass: inetOrgPerson", "uid: hostcheck", "cn: Host check", "sn: check",
                "employeeNumber: E-hostcheck", "userPassword: " + PASSWORD_OK);
        other.startListening();
        try {
            int startTls = other.getListenPort("starttls");
            int ldaps = other.getListenPort("ldaps");
            for (String url : List.of("ldap://localhost:" + startTls, "ldaps://localhost:" + ldaps)) {
                for (boolean direct : List.of(false, true)) {
                    ae.mover.security.DirectoryAuthenticator wrongHost = authenticator(url, ca, direct);
                    assertThatThrownBy(() -> wrongHost.authenticate("hostcheck", PASSWORD_OK))
                            .as(url + (direct ? " direct" : " service"))
                            .isInstanceOfSatisfying(ae.mover.security.DirectoryAuthenticator.DirectoryException.class,
                                    e -> assertThat(e.failure()).isEqualTo(ae.mover.security.DirectoryAuthenticator.Failure.TLS));
                }
            }
            assertThat(requests).as("no credential reached a directory whose name did not match").noneMatch(m -> m.contains("BIND"));

            // the control: the same certificate and trust, dialled by a name it carries, binds and finds the person
            for (String url : List.of("ldap://127.0.0.1:" + startTls, "ldaps://127.0.0.1:" + ldaps)) {
                for (boolean direct : List.of(false, true)) {
                    assertThat(authenticator(url, ca, direct).authenticate("hostcheck", PASSWORD_OK).username())
                            .as(url + (direct ? " direct" : " service")).isEqualTo("hostcheck");
                }
            }
            assertThat(requests).anyMatch(m -> m.contains("BIND"));
        } finally {
            other.shutDown(true);
        }
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
        // Before Oracle is in force (ADR-068) a login nobody registered signs in holding nothing, like anyone the directory knows.
        Signed before = signIn(uid("first"), PASSWORD_OK);
        assertThat(before.status()).as(String.valueOf(before.body())).isEqualTo(200);
        JsonNode plain = JSON.readTree(call(before.cookie(), "GET", "/me", null).body());
        assertThat(plain.path("permissions").size()).isZero();
        UUID directoryPerson = UUID.fromString(plain.path("id").asText());
        jdbc.sql("insert into bootstrap_admin(login, expires_at) values (:l, now() + interval '24 hours')").param("l", uid("first")).update();
        Signed boot = signIn(uid("first"), PASSWORD_OK);
        assertThat(boot.status()).as(String.valueOf(boot.body())).isEqualTo(200);
        JsonNode me = JSON.readTree(call(boot.cookie(), "GET", "/me", null).body());
        assertThat(me.path("permissions").toString()).contains("CONFIGURE", "MANAGE_ACCESS").doesNotContain("\"VIEW\"");
        UUID bootPerson = UUID.fromString(me.path("id").asText());
        assertThat(bootPerson).isNotEqualTo(directoryPerson);
        assertThat(jdbc.sql("select valid_to - valid_from from membership where person_id = :p").param("p", bootPerson).query(String.class).single())
                .isEqualTo("3 days");
        // the identity moved to the temporary administrator; the record the first sign-in made holds nothing and links nobody
        assertThat(count("select count(*) from identity_link where person_id = :p", directoryPerson)).isZero();
        assertThat(count("select count(*) from membership where person_id = :p", directoryPerson)).isZero();
        // The request is single use and is refused while an administrator exists: that login holds nothing.
        jdbc.sql("insert into bootstrap_admin(login, expires_at) values (:l, now() + interval '24 hours')").param("l", uid("second")).update();
        directoryUser("second", PEOPLE);
        Signed second = signIn(uid("second"), PASSWORD_OK);
        assertThat(second.status()).isEqualTo(200);
        assertThat(JSON.readTree(call(second.cookie(), "GET", "/me", null).body()).path("permissions").size()).isZero();
        assertThat(jdbc.sql("select used_at is null from bootstrap_admin where login = :l").param("l", uid("second")).query(Boolean.class).single())
                .isTrue();

        // The HR mirror now has the person: the next sign-in moves to the HR record and ends the temporary grant.
        UUID hr = hrPerson("first");
        Signed later = signIn(uid("first"), PASSWORD_OK);
        assertThat(JSON.readTree(call(later.cookie(), "GET", "/me", null).body()).path("id").asText()).isEqualTo(hr.toString());
        assertThat(jdbc.sql("select status from person where id = :p").param("p", bootPerson).query(String.class).single()).isEqualTo("DISABLED");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'BOOTSTRAP_ADMIN_REPLACED' and entity_id = :p").param("p", hr.toString())
                .query(Long.class).single()).isEqualTo(1);
    }

    // ---- LDAP first login before Oracle (ADR-068; LDAP specification §1-8, §41) -------------------------------------

    @Test
    @DisplayName("AUTH-01, SOURCE-01: before Oracle, a directory user nobody added signs in as a zero-access person placed by the directory's Unit ID")
    void firstSignInBeforeOracle() throws Exception {
        UUID main = unitWithId("MAIN", null, "M-" + sfx);
        unitWithId("UNIT", main, "U-" + sfx);
        employee("new1", "U-" + sfx, "اسم الوحدة كما في الدليل", "M-" + sfx);
        assertThat(count("select count(*) from person where lower(username) = :p", uid("new1"))).as("nobody added them").isZero();

        Signed s = signIn(uid("new1"), PASSWORD_OK);
        assertThat(s.status()).as(String.valueOf(s.body())).isEqualTo(200);
        JsonNode me = JSON.readTree(call(s.cookie(), "GET", "/me", null).body());
        UUID person = UUID.fromString(me.path("id").asText());
        assertThat(me.path("permissions").size()).as("authentication is not authorization").isZero();
        assertThat(me.path("grants").size()).isZero();
        Map<String, Object> p = jdbc.sql("select source, employee_no, username, display_name, password_hash from person where id = :p")
                .param("p", person).query().singleRow();
        assertThat(p).containsEntry("source", "LOCAL").containsEntry("employee_no", "E-" + uid("new1"))
                .containsEntry("username", uid("new1")).containsEntry("display_name", "موظف new1");
        assertThat(p.get("password_hash")).as("no local usable password").isNull();
        assertThat(jdbc.sql("select method from identity_link where person_id = :p").param("p", person).query(String.class).single())
                .isEqualTo("DIRECTORY");
        assertThat(count("select count(*) from membership where person_id = :p", person)).as("no grant").isZero();
        assertThat(count("select count(*) from unit_member where person_id = :p", person)).as("no unit entry").isZero();
        assertThat(count("select count(*) from affiliation where person_id = :p", person)).isZero();
        assertThat(count("select count(*) from audit_event where action = 'IDENTITY_PROVISIONED_FROM_DIRECTORY' and entity_id = :p",
                person.toString())).isEqualTo(1);
        // what the directory stated is kept — never a password
        Map<String, Object> d = jdbc.sql("select * from person_directory_profile where person_id = :p").param("p", person).query().singleRow();
        assertThat(d).containsEntry("unit_external_id", "U-" + sfx).containsEntry("unit_name", "اسم الوحدة كما في الدليل")
                .containsEntry("main_unit_external_id", "M-" + sfx).containsEntry("rank", "نقيب").containsEntry("position", "ضابط عمليات");
        assertThat(d.toString()).doesNotContain(PASSWORD_OK);

        // the identity card: the unit joined by its Unit ID (TMRKZ's unit, not the directory's text), its main unit, source LDAP
        JsonNode mine = JSON.readTree(call(s.cookie(), "GET", "/access-requests/mine", null).body());
        JsonNode who = mine.path("identity");
        assertThat(who.path("sourceCode").asText()).isEqualTo("LDAP");
        assertThat(who.path("unit").asText()).isEqualTo("جهة UNIT");
        assertThat(who.path("mainUnit").asText()).isEqualTo("جهة MAIN");
        assertThat(who.path("unitConfigured").asBoolean()).isTrue();
        assertThat(who.path("rank").asText()).isEqualTo("نقيب");
        assertThat(who.path("position").asText()).isEqualTo("ضابط عمليات");
        assertThat(who.path("employeeNo").asText()).isEqualTo("E-" + uid("new1"));
        assertThat(who.path("name").asText()).isEqualTo("موظف new1");
        assertThat(mine.path("unit").asText()).isEqualTo("جهة UNIT");
        assertThat(mine.path("overall").path("text").asText()).isEqualTo("لم تقدم طلب صلاحية");

        // the next sign-in is the same person: no second record, no second audit
        Signed again = signIn(uid("new1"), PASSWORD_OK);
        assertThat(JSON.readTree(call(again.cookie(), "GET", "/me", null).body()).path("id").asText()).isEqualTo(person.toString());
        assertThat(count("select count(*) from person where lower(username) = :p", uid("new1"))).isEqualTo(1);
        assertThat(count("select count(*) from audit_event where action = 'IDENTITY_PROVISIONED_FROM_DIRECTORY' and entity_id = :p",
                person.toString())).isEqualTo(1);
    }

    @Test
    @DisplayName("§23 before Oracle: the directory reports another Unit ID — as an HR transfer: seats released to the unit, grants that follow the posting end, an explicit one stays; a user of the new unit")
    void directoryMoveReleasesSeats() throws Exception {
        UUID main = unitWithId("MAINM", null, "MM-" + sfx);
        UUID unitA = unitWithId("UNITA", main, "UA-" + sfx);
        unitWithId("UNITB", main, "UB-" + sfx);
        UUID unitB = jdbc.sql("select id from organization where source_external_id = :x").param("x", "UB-" + sfx).query(UUID.class).single();
        employee("mover", "UA-" + sfx, "الوحدة أ", "MM-" + sfx);
        Signed s = signIn(uid("mover"), PASSWORD_OK);
        assertThat(s.status()).as(String.valueOf(s.body())).isEqualTo(200);
        UUID person = UUID.fromString(JSON.readTree(call(s.cookie(), "GET", "/me", null).body()).path("id").asText());
        // later granted at unit A: a seat of the unit and a personal permission; a user of unit A
        UUID seat = membership(person, role("DSEAT", "ORGANIZATION", "VIEW", "DECIDE_UNIT_OPERATIONS"), unitA, null);
        UUID own = membership(person, role("DPOST", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), unitA, null);
        UUID explicit = membership(person, role("DXPL", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), unitA, null);
        jdbc.sql("update membership set follows_affiliation = false where id = :m").param("m", explicit).update();
        jdbc.sql("insert into unit_member(id, person_id, organization_id, acting, added_by, added_at) values (gen_random_uuid(), :p, :o, false, :p, now())")
                .param("p", person).param("o", unitA).update();

        // the directory now places the person in unit B
        LDAP.modify("uid=" + uid("mover") + "," + PEOPLE, new com.unboundid.ldap.sdk.Modification(
                com.unboundid.ldap.sdk.ModificationType.REPLACE, "departmentNumber", "UB-" + sfx));
        Signed again = signIn(uid("mover"), PASSWORD_OK);
        assertThat(again.status()).as(String.valueOf(again.body())).isEqualTo(200);
        assertThat(jdbc.sql("select ended_reason from membership where id = :m").param("m", seat).query(String.class).single())
                .as("the seat stays with unit A").isEqualTo("SEAT_UNIT_LEFT");
        assertThat(jdbc.sql("select ended_reason from membership where id = :m").param("m", own).query(String.class).single())
                .as("a personal permission follows its policy: it follows the posting").isEqualTo("DIRECTORY_UNIT_CHANGED");
        assertThat(jdbc.sql("select valid_to is null from membership where id = :m").param("m", explicit).query(Boolean.class).single())
                .as("an explicit grant that does not follow the posting stays").isTrue();
        assertThat(count("select count(*) from unit_member where person_id = :p and organization_id = '" + unitA + "' and ended_at is null", person)).isZero();
        assertThat(count("select count(*) from unit_member where person_id = :p and organization_id = '" + unitB + "' and ended_at is null", person)).isEqualTo(1);
        assertThat(count("select count(*) from audit_event where action = 'IDENTITY_UNIT_CHANGED' and entity_id = :p", person.toString())).isEqualTo(1);
        assertThat(count("select count(*) from audit_event where action = 'UNIT_SEAT_RELEASED' and entity_id = :p", person.toString())).isEqualTo(1);
        assertThat(JSON.readTree(call(again.cookie(), "GET", "/access-requests/mine", null).body()).path("identity").path("unit").asText())
                .isEqualTo("جهة UNITB");
        // a third sign-in at the same unit changes nothing more
        signIn(uid("mover"), PASSWORD_OK);
        assertThat(count("select count(*) from audit_event where action = 'IDENTITY_UNIT_CHANGED' and entity_id = :p", person.toString())).isEqualTo(1);
    }

    @Test
    @DisplayName("AUTH-02: a Unit ID TMRKZ does not hold signs the person in with nothing; no unit is created; the request waits for the unit")
    void unknownUnit() throws Exception {
        String unknown = "U-NONE-" + sfx;
        employee("new2", unknown, "وحدة غير مهيأة " + sfx, "M-NONE-" + sfx);
        long units = jdbc.sql("select count(*) from organization").query(Long.class).single();
        Signed s = signIn(uid("new2"), PASSWORD_OK);
        assertThat(s.status()).as(String.valueOf(s.body())).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from organization").query(Long.class).single()).as("the directory never creates a unit").isEqualTo(units);
        assertThat(count("select count(*) from organization where source_external_id = :p", unknown)).isZero();
        assertThat(count("select count(*) from organization where name = :p", "وحدة غير مهيأة " + sfx)).isZero();
        assertThat(JSON.readTree(call(s.cookie(), "GET", "/me", null).body()).path("permissions").size()).isZero();

        JsonNode mine = JSON.readTree(call(s.cookie(), "GET", "/access-requests/mine", null).body());
        JsonNode who = mine.path("identity");
        assertThat(who.path("unitConfigured").asBoolean()).isFalse();
        assertThat(who.path("statedUnitId").asText()).isEqualTo(unknown);
        assertThat(who.path("statedUnitName").asText()).isEqualTo("وحدة غير مهيأة " + sfx);
        assertThat(who.path("unit").isNull()).isTrue();
        assertThat(mine.path("unit").isNull()).isTrue();

        // the access request is refused until the unit exists in TMRKZ's tree
        jdbc.sql("update request_type set active = false where kind = 'ACCESS'").update();
        String type = requestType("ACCESS", finalOnly(), null);
        try {
            HttpResponse<String> refused = call(s.cookie(), "POST", "/access-requests",
                    Map.of("roles", List.of("REQUESTER"), "reason", "أحتاج صلاحية لعملي في الوحدة"));
            assertThat(refused.statusCode()).as(refused.body()).isEqualTo(400);
            JsonNode body = JSON.readTree(refused.body());
            assertThat(body.path("details").path("reason").asText()).isEqualTo("UNIT_NOT_CONFIGURED");
            assertThat(body.path("message").asText()).contains("تم التحقق من هويتك، لكن وحدتك التنظيمية غير مهيأة في النظام");
            assertThat(count("select count(*) from access_request where person_id = :p",
                    UUID.fromString(JSON.readTree(call(s.cookie(), "GET", "/me", null).body()).path("id").asText()))).isZero();

            // an administrator registers the unit under that Unit ID: what the directory stated now resolves, by ID only
            unitWithId("LATE", null, unknown);
            JsonNode now = JSON.readTree(call(s.cookie(), "GET", "/access-requests/mine", null).body());
            assertThat(now.path("identity").path("unitConfigured").asBoolean()).isTrue();
            assertThat(now.path("identity").path("unit").asText()).isEqualTo("جهة LATE");
            assertThat(now.path("identity").path("statedUnitId").isNull()).isTrue();
        } finally {
            jdbc.sql("update request_type set active = false where code = :c").param("c", type).update();
        }
    }

    @Test
    @DisplayName("AUTH-03, AUTH-04: a zero-access person reaches no application API; being placed in a unit (even one holding a unit grant) gives nothing")
    void zeroAccessReachesNothing() throws Exception {
        UUID unit = unitWithId("ZA", null, "Z-" + sfx);
        UUID granter = person("granter", "SYSTEM_ADMIN", unit);
        // «موروثة من الوحدة» reaches only the users added to the unit (ADR-066), never someone the directory places there
        jdbc.sql("insert into unit_grant(id, organization_id, role_code, valid_from, granted_by) values (:id, :o, 'REQUESTER', now(), :by)")
                .param("id", UUID.randomUUID()).param("o", unit).param("by", granter).update();
        employee("new3", "Z-" + sfx, "وحدة", "Z-" + sfx);
        Signed s = signIn(uid("new3"), PASSWORD_OK);
        assertThat(s.status()).as(String.valueOf(s.body())).isEqualTo(200);
        JsonNode me = JSON.readTree(call(s.cookie(), "GET", "/me", null).body());
        assertThat(me.path("permissions").size()).isZero();
        assertThat(me.path("grants").size()).isZero();
        assertThat(JSON.readTree(call(s.cookie(), "GET", "/access-requests/mine", null).body()).path("identity").path("unit").asText())
                .as("placed in the unit, for structure only").isEqualTo("جهة ZA");
        for (String path : List.of("/sites", "/requests", "/tasks", "/hr/status", "/identity-issues", "/stationing/current", "/organizations")) {
            HttpResponse<String> r = call(s.cookie(), "GET", path, null);
            assertThat(r.statusCode()).as(path).isEqualTo(403);
            assertThat(JSON.readTree(r.body()).path("code").asText()).as(path).isEqualTo("NO_EFFECTIVE_ACCESS");
        }
        assertThat(call(s.cookie(), "POST", "/sites", Map.of("name", "موقع")).statusCode()).isEqualTo(403);
        // only who they are, the access-request page and signing out
        assertThat(call(s.cookie(), "GET", "/access-requests/mine", null).statusCode()).isEqualTo(200);
        assertThat(call(s.cookie(), "GET", "/me", null).statusCode()).isEqualTo(200);
        assertThat(call(s.cookie(), "POST", "/auth/logout", Map.of()).statusCode()).isEqualTo(200);
    }
}
