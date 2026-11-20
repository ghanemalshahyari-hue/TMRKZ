package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.sun.net.httpserver.HttpServer;

/**
 * «إعدادات التكامل» (owner, 20 Nov 2026; ADR-092): the directory and the automatic sign-in's Keycloak entered on the screen,
 * tested before they are saved, applied without a restart and ahead of the environment, cleared back to it; only whoever
 * configures the system; no secret ever leaves the server.
 */
class IntegrationSettingsIT extends IntegrationTest {

    private static final String PASSWORD = "Settings#Directory-Pass-1";

    private static Map<String, Object> directory(String pem, String bindPassword) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("enabled", true);
        d.put("server", "localhost");
        d.put("port", DirectorySignInIT.LDAP.getListenPort());
        d.put("securityMode", "starttls");
        d.put("baseDn", DirectorySignInIT.BASE);
        d.put("bindDn", "cn=service," + DirectorySignInIT.BASE);
        d.put("bindPassword", bindPassword);
        d.put("usernameAttribute", "uid");
        d.put("uuidAttribute", "entryUUID");
        d.put("employeeNumberAttribute", "employeeNumber");
        d.put("userObjectClass", "inetOrgPerson");
        d.put("caCertificatesPem", pem);
        d.put("timeoutSeconds", 5);
        return d;
    }

    @Test
    @DisplayName("INT-01 the directory saved on the screen signs people in at once, ahead of an unconfigured environment; tested first; cleared back")
    void directorySavedTestedAndCleared() throws Exception {
        UUID top = org("IS", null);
        person("cfg", role("ISCFG", "ALL", "VIEW", "CONFIGURE"), top);
        person("plain", role("ISVIEW", "ALL", "VIEW"), top);
        String pem = Files.readString(DirectorySignInIT.CA_FILE, StandardCharsets.UTF_8);
        String login = "set" + sfx;
        DirectorySignInIT.LDAP.add("dn: uid=" + login + "," + DirectorySignInIT.PEOPLE, "objectClass: inetOrgPerson", "uid: " + login,
                "cn: Settings test " + login, "sn: Test", "employeeNumber: E-" + login, "userPassword: " + PASSWORD);
        UUID local = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username, source) values (:id, :e, :l, :l, 'LOCAL')")
                .param("id", local).param("e", "USER-" + login).param("l", login).update();
        Api cfg = login("cfg");
        try {
            // this context names no directory in its environment: the manual form is not configured
            assertThat(new Api().get("/auth/status").body().path("manual").asBoolean()).isFalse();
            assertThat(new Api().post("/auth/directory/login", Map.of("username", login, "password", PASSWORD)).status()).isEqualTo(503);

            assertThat(login("plain").get("/settings/integration/directory").status()).isEqualTo(403);
            assertThat(login("plain").put("/settings/integration/directory", directory(pem, "service-secret")).status()).isEqualTo(403);
            Res before = cfg.get("/settings/integration/directory");
            assertThat(before.status()).as(before.toString()).isEqualTo(200);
            assertThat(before.body().path("source").asText()).isEqualTo("NONE");
            assertThat(before.body().path("saved").isNull()).isTrue();

            // tests of unsaved values: the channel and the service bind; a wrong password named as such; a person's own sign-in
            Res ok = cfg.post("/settings/integration/directory/test", Map.of("settings", directory(pem, "service-secret")));
            assertThat(ok.status()).as(ok.toString()).isEqualTo(200);
            assertThat(ok.body().path("ok").asBoolean()).as(ok.toString()).isTrue();
            assertThat(ok.body().path("step").asText()).isEqualTo("SERVICE_BIND");
            Res wrong = cfg.post("/settings/integration/directory/test", Map.of("settings", directory(pem, "not-the-secret")));
            assertThat(wrong.body().path("ok").asBoolean()).isFalse();
            assertThat(wrong.body().path("step").asText()).isEqualTo("INVALID_CREDENTIALS");
            Res untrusted = cfg.post("/settings/integration/directory/test", Map.of("settings", directory("", "service-secret")));
            assertThat(untrusted.body().path("ok").asBoolean()).isFalse();
            assertThat(untrusted.body().path("step").asText()).isEqualTo("TLS");
            Res asPerson = cfg.post("/settings/integration/directory/test",
                    Map.of("settings", directory(pem, "service-secret"), "testLogin", login, "testPassword", PASSWORD));
            assertThat(asPerson.body().path("ok").asBoolean()).as(asPerson.toString()).isTrue();
            assertThat(asPerson.body().path("step").asText()).isEqualTo("SIGN_IN");
            assertThat(asPerson.body().toString()).doesNotContain(PASSWORD).doesNotContain("service-secret");

            // validation: no search base, a private key instead of a certificate
            Map<String, Object> noBase = directory(pem, "service-secret");
            noBase.put("baseDn", "");
            assertThat(cfg.put("/settings/integration/directory", noBase).status()).isEqualTo(400);
            Map<String, Object> key = directory("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n", "service-secret");
            assertThat(cfg.put("/settings/integration/directory", key).status()).isEqualTo(400);

            // saved: in force at once; the password never shown; the manual form configured; the person signs in
            Res saved = cfg.put("/settings/integration/directory", directory(pem, "service-secret"));
            assertThat(saved.status()).as(saved.toString()).isEqualTo(200);
            assertThat(saved.body().path("source").asText()).isEqualTo("SAVED");
            assertThat(saved.body().path("saved").path("bindPasswordSet").asBoolean()).isTrue();
            assertThat(saved.body().path("saved").has("bindPassword")).isFalse();
            assertThat(saved.body().path("effective").path("configured").asBoolean()).isTrue();
            assertThat(saved.body().path("effective").path("url").asText()).isEqualTo("ldap://localhost:" + DirectorySignInIT.LDAP.getListenPort());
            assertThat(saved.body().toString()).doesNotContain("service-secret");
            assertThat(new Api().get("/auth/status").body().path("manual").asBoolean()).isTrue();
            Res in = new Api().post("/auth/directory/login", Map.of("username", login, "password", PASSWORD));
            assertThat(in.status()).as(in.toString()).isEqualTo(200);
            assertThat(in.body().path("id").asText()).isEqualTo(local.toString());
            assertThat(new Api().post("/auth/directory/login", Map.of("username", login, "password", "wrong")).status()).isEqualTo(401);

            // a save with a blank password keeps the stored one; switched off, the environment applies again
            Map<String, Object> again = directory(pem, "");
            again.put("timeoutSeconds", 7);
            assertThat(cfg.put("/settings/integration/directory", again).body().path("saved").path("bindPasswordSet").asBoolean()).isTrue();
            assertThat(new Api().post("/auth/directory/login", Map.of("username", login, "password", PASSWORD)).status()).isEqualTo(200);
            Map<String, Object> off = directory(pem, "");
            off.put("enabled", false);
            assertThat(cfg.put("/settings/integration/directory", off).body().path("source").asText()).isEqualTo("NONE");
            assertThat(new Api().post("/auth/directory/login", Map.of("username", login, "password", PASSWORD)).status()).isEqualTo(503);
            assertThat(jdbc.sql("select count(*) from audit_event where action like 'INTEGRATION_DIRECTORY_%'").query(Long.class).single())
                    .isGreaterThanOrEqualTo(4);
        } finally {
            cfg.delete("/settings/integration/directory");
        }
        assertThat(cfg.get("/settings/integration/directory").body().path("saved").isNull()).isTrue();
    }

    @Test
    @DisplayName("INT-02 the Keycloak saved on the screen is the automatic provider: tested against its discovery document, applied at once, cleared back")
    void keycloakSavedTestedAndCleared() throws Exception {
        UUID top = org("IK", null);
        person("cfg", role("IKCFG", "ALL", "VIEW", "CONFIGURE"), top);
        Api cfg = login("cfg");
        HttpServer kc = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        String base = "http://127.0.0.1:" + kc.getAddress().getPort();
        String issuer = base + "/realms/enterprise";
        kc.createContext("/realms/enterprise/.well-known/openid-configuration", x -> {
            byte[] b = ("{\"issuer\":\"" + issuer + "\",\"jwks_uri\":\"" + issuer + "/protocol/openid-connect/certs\"}").getBytes(StandardCharsets.UTF_8);
            x.getResponseHeaders().add("Content-Type", "application/json");
            x.sendResponseHeaders(200, b.length);
            x.getResponseBody().write(b);
            x.close();
        });
        kc.createContext("/realms/enterprise/protocol/openid-connect/certs", x -> {
            byte[] b = "{\"keys\":[{\"kty\":\"RSA\",\"kid\":\"a\",\"n\":\"AQAB\",\"e\":\"AQAB\"},{\"kty\":\"RSA\",\"kid\":\"b\",\"n\":\"AQAB\",\"e\":\"AQAB\"}]}"
                    .getBytes(StandardCharsets.UTF_8);
            x.getResponseHeaders().add("Content-Type", "application/json");
            x.sendResponseHeaders(200, b.length);
            x.getResponseBody().write(b);
            x.close();
        });
        kc.start();
        try {
            Res before = cfg.get("/settings/integration/oidc");
            assertThat(before.status()).as(before.toString()).isEqualTo(200);
            String envIssuer = before.body().path("env").path("issuer").asText(null);

            Map<String, Object> form = new LinkedHashMap<>();
            form.put("enabled", true);
            form.put("serverUrl", base + "/");
            form.put("realm", "enterprise");
            form.put("clientId", "tmrkz-enterprise");
            form.put("clientSecret", "enterprise-client-secret");
            form.put("redirectUri", "http://localhost:" + port + "/api/v1/auth/oidc/callback");
            Res probe = cfg.post("/settings/integration/oidc/test", form);
            assertThat(probe.status()).as(probe.toString()).isEqualTo(200);
            assertThat(probe.body().path("ok").asBoolean()).as(probe.toString()).isTrue();
            assertThat(probe.body().path("issuer").asText()).isEqualTo(issuer);
            assertThat(probe.body().path("keys").asInt()).isEqualTo(2);
            assertThat(probe.body().toString()).doesNotContain("enterprise-client-secret");

            Map<String, Object> otherIssuer = new LinkedHashMap<>(form);
            otherIssuer.put("issuer", "https://keycloak.example.invalid/realms/enterprise");
            Res mismatch = cfg.post("/settings/integration/oidc/test", otherIssuer);
            assertThat(mismatch.body().path("ok").asBoolean()).isFalse();
            assertThat(mismatch.body().path("step").asText()).isEqualTo("ISSUER");

            Map<String, Object> noRealm = new LinkedHashMap<>(form);
            noRealm.put("realm", "");
            assertThat(cfg.put("/settings/integration/oidc", noRealm).status()).isEqualTo(400);

            Res saved = cfg.put("/settings/integration/oidc", form);
            assertThat(saved.status()).as(saved.toString()).isEqualTo(200);
            assertThat(saved.body().path("source").asText()).isEqualTo("SAVED");
            assertThat(saved.body().path("saved").path("clientSecretSet").asBoolean()).isTrue();
            assertThat(saved.body().path("saved").has("clientSecret")).isFalse();
            assertThat(saved.body().path("effective").path("issuer").asText()).isEqualTo(issuer);
            assertThat(saved.body().path("effective").path("clientId").asText()).isEqualTo("tmrkz-enterprise");
            // the platform accounts' provider is untouched by the saved automatic one (this context has no local provider, so
            // the single-provider rule of OidcProperties applies; DualProviderSignInIT covers the separated production shape)
            if (envIssuer != null) {
                assertThat(saved.body().path("effective").path("platformIssuer").asText(null)).isEqualTo(envIssuer);
            }
            Res status = new Api().get("/auth/status");
            assertThat(status.body().path("configured").asBoolean()).isTrue();
            assertThat(status.body().path("reachable").asBoolean()).as("the key set over the back channel").isTrue();
            // the automatic button now goes to the saved Keycloak
            java.net.http.HttpResponse<Void> start = java.net.http.HttpClient.newBuilder().followRedirects(java.net.http.HttpClient.Redirect.NEVER)
                    .build().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:" + port + "/api/v1/auth/oidc/start"))
                            .GET().build(), java.net.http.HttpResponse.BodyHandlers.discarding());
            assertThat(start.statusCode()).isIn(302, 303);
            assertThat(start.headers().firstValue("Location").orElse("")).startsWith(issuer + "/protocol/openid-connect/auth")
                    .contains("client_id=tmrkz-enterprise");
        } finally {
            kc.stop(0);
            cfg.delete("/settings/integration/oidc");
        }
        Res after = cfg.get("/settings/integration/oidc");
        assertThat(after.body().path("saved").isNull()).isTrue();
        assertThat(after.body().path("source").asText()).isNotEqualTo("SAVED");
    }
}
