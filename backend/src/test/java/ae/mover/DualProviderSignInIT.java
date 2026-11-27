package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.fasterxml.jackson.databind.JsonNode;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;

/** Enterprise automatic SSO and local platform identity are independent providers (ADR-071), with different keys. */
class DualProviderSignInIT extends IntegrationTest {

    @DynamicPropertySource
    static void providers(DynamicPropertyRegistry r) {
        r.add("tmrkz.oidc.issuer", EnterpriseSignInIT::issuer);
        r.add("tmrkz.oidc.internal-base-url", EnterpriseSignInIT::issuer);
        r.add("tmrkz.oidc.client-id", () -> EnterpriseSignInIT.CLIENT);
        r.add("tmrkz.oidc.client-secret", () -> EnterpriseSignInIT.SECRET);
        r.add("tmrkz.oidc.redirect-uri", () -> "http://tmrkz.test/api/v1/auth/oidc/callback");
        r.add("tmrkz.oidc.post-logout-redirect-uri", () -> "http://tmrkz.test/?signed-out=1");
        r.add("tmrkz.oidc.link-key", () -> "DOMAIN_ACCOUNT");
        r.add("tmrkz.oidc.platform-accounts", () -> "platform.dual.it");
        r.add("tmrkz.oidc.password-client-id", () -> EnterpriseSignInIT.PASSWORD_CLIENT);
        r.add("tmrkz.oidc.password-client-secret", () -> EnterpriseSignInIT.PASSWORD_SECRET);
        r.add("tmrkz.oidc.platform-issuer", EnterpriseSignInIT::platformIssuer);
        r.add("tmrkz.oidc.platform-internal-base-url", EnterpriseSignInIT::platformIssuer);
        r.add("tmrkz.oidc.platform-client-id", () -> EnterpriseSignInIT.CLIENT);
        r.add("tmrkz.oidc.platform-client-secret", () -> EnterpriseSignInIT.SECRET);
        r.add("tmrkz.oidc.platform-redirect-uri", () -> "http://tmrkz.test/api/v1/auth/oidc/callback");
        r.add("tmrkz.oidc.platform-post-logout-redirect-uri", () -> "http://tmrkz.test/?signed-out=1");
    }

    @BeforeEach
    void independentDirectoryAndEndpointLedger() {
        jdbc.sql("update hr_source set enabled = false").update();
        EnterpriseSignInIT.TOKEN_CALLS.clear();
        EnterpriseSignInIT.tokenEndpointDown = false;
    }

    @Test
    @DisplayName("ADR-071: automatic is enterprise, platform password/step-up/logout stay local, enterprise role grants no platform rights")
    void separateProvidersAndPlatformBoundary() throws Exception {
        String localLogin = "platform.dual.it";
        String localSubject = "local-" + sfx;
        List<String> role = List.of("tmrkz-platform");
        directIdentity(localLogin, localSubject, role, EnterpriseSignInIT.PLATFORM_KEY);
        Browser local = new Browser();
        HttpResponse<String> signed = local.post("/api/v1/auth/directory/login",
                write(Map.of("username", localLogin, "password", "local-test-password")));
        assertThat(signed.statusCode()).as(signed.body()).isEqualTo(200);
        com.fasterxml.jackson.databind.JsonNode me = JSON.readTree(local.get("/api/v1/me").body());
        String platformPerson = me.path("id").asText();
        assertThat(me.path("signInMethod").asText()).isEqualTo("PROVIDER");
        assertThat(me.path("permissions").toString()).contains("MANAGE_ACCESS", "CONFIGURE", "AUDIT");
        assertThat(jdbc.sql("select method from identity_link where person_id = :p").param("p", UUID.fromString(platformPerson))
                .query(String.class).single()).isEqualTo("PLATFORM");
        assertThat(EnterpriseSignInIT.TOKEN_CALLS).containsOnly("/realms/platform/protocol/openid-connect/token");

        // The session's issuer, not the current default provider, chooses local step-up and local logout.
        String redirect = JSON.readTree(local.post("/api/v1/auth/reauth", "{\"returnTo\":\"/#review\"}").body()).path("redirect").asText();
        assertThat(redirect).startsWith(EnterpriseSignInIT.platformIssuer() + "/protocol/openid-connect/auth?");
        Map<String, String> stepUp = query(redirect);
        assertThat(stepUp).containsEntry("prompt", "login").containsEntry("max_age", "0");
        assertThat(location(local.get(callback(stepUp, localSubject, localLogin, EnterpriseSignInIT.platformIssuer(),
                EnterpriseSignInIT.PLATFORM_KEY, role)))).isEqualTo("/#review");
        EnterpriseSignInIT.LOGOUT_CALLS.clear();
        HttpResponse<String> out = local.post("/api/v1/auth/logout", "{}");
        assertThat(JSON.readTree(out.body()).path("redirect").asText()).isEqualTo("/?signed-out=1");
        assertThat(EnterpriseSignInIT.LOGOUT_CALLS).singleElement().satisfies(call -> assertThat(call)
                .containsEntry("path", "/realms/platform/protocol/openid-connect/logout").containsKey("id_token_hint"));
        assertThat(local.get("/api/v1/me").statusCode()).isEqualTo(401);
        assertThat(EnterpriseSignInIT.TOKEN_CALLS).allMatch(path -> path.startsWith("/realms/platform/"));

        // Even a real-looking platform role from the external issuer gets no local administrator identity or grant.
        long platformAccounts = jdbc.sql("select count(*) from person where employee_no like 'PLATFORM-%'").query(Long.class).single();
        Browser externalWithRole = new Browser();
        String start = location(externalWithRole.get("/api/v1/auth/oidc/start?return=/%23home"));
        Map<String, String> request = query(start);
        HttpResponse<String> refused = externalWithRole.get(callback(request, "external-role-" + sfx, localLogin,
                EnterpriseSignInIT.issuer(), EnterpriseSignInIT.KEY, role));
        assertThat(refused.statusCode()).isEqualTo(302);
        assertThat(refused.headers().firstValue("Location").orElseThrow()).startsWith("/#auth-error=");
        assertThat(externalWithRole.get("/api/v1/me").statusCode()).isEqualTo(401);
        assertThat(jdbc.sql("select count(*) from person where employee_no like 'PLATFORM-%'").query(Long.class).single())
                .isEqualTo(platformAccounts);
        assertThat(EnterpriseSignInIT.TOKEN_CALLS).contains("/realms/test/protocol/openid-connect/token");

        // An ordinary pre-added enterprise user succeeds through automatic SSO with no privileges, not platform rights.
        String ordinaryLogin = "employee" + sfx;
        UUID ordinary = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username, source) values (:id, :e, :l, :l, 'LOCAL')")
                .param("id", ordinary).param("e", "USER-" + ordinaryLogin).param("l", ordinaryLogin).update();
        Browser ordinarySso = new Browser();
        Map<String, String> ordinaryRequest = query(location(ordinarySso.get("/api/v1/auth/oidc/start?return=/%23home")));
        assertThat(location(ordinarySso.get(callback(ordinaryRequest, "external-user-" + sfx, ordinaryLogin,
                EnterpriseSignInIT.issuer(), EnterpriseSignInIT.KEY, null)))).isEqualTo("/#home");
        JsonNode ordinaryMe = JSON.readTree(ordinarySso.get("/api/v1/me").body());
        assertThat(ordinaryMe.path("id").asText()).isEqualTo(ordinary.toString());
        assertThat(ordinaryMe.path("permissions").size()).isZero();

        // The platform verifier does not accept the enterprise key even if all other claims look valid.
        directIdentity(localLogin, localSubject, role, EnterpriseSignInIT.KEY);
        Browser wrongKey = new Browser();
        HttpResponse<String> refusedKey = wrongKey.post("/api/v1/auth/directory/login",
                write(Map.of("username", localLogin, "password", "local-test-password")));
        assertThat(refusedKey.statusCode()).isEqualTo(401);
        assertThat(wrongKey.get("/api/v1/me").statusCode()).isEqualTo(401);
    }

    private static void directIdentity(String account, String subject, List<String> roles, RSAKey key) throws Exception {
        JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer(EnterpriseSignInIT.platformIssuer())
                .subject(subject).audience(EnterpriseSignInIT.PASSWORD_CLIENT).issueTime(new Date())
                .expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("preferred_username", account).claim("name", "Local test").claim("azp", EnterpriseSignInIT.PASSWORD_CLIENT)
                .claim("tmrkz_roles", roles).build();
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.getKeyID()).type(JOSEObjectType.JWT).build(), claims);
        jwt.sign(new RSASSASigner(key));
        EnterpriseSignInIT.PASSWORDS.put(account, new EnterpriseSignInIT.Grant("local-test-password", jwt.serialize()));
    }

    private static String callback(Map<String, String> request, String subject, String account, String issuer, RSAKey key,
                                   List<String> roles) throws Exception {
        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder().issuer(issuer).subject(subject).audience(EnterpriseSignInIT.CLIENT)
                .issueTime(new Date()).expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("nonce", request.get("nonce")).claim("auth_time", Instant.now().getEpochSecond())
                .claim("preferred_username", account).claim("name", "Test " + account).claim("azp", EnterpriseSignInIT.CLIENT);
        if (roles != null) {
            claims.claim("tmrkz_roles", roles);
        }
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.getKeyID()).type(JOSEObjectType.JWT).build(), claims.build());
        jwt.sign(new RSASSASigner(key));
        String code = UUID.randomUUID().toString();
        EnterpriseSignInIT.CODES.put(code, new EnterpriseSignInIT.Grant(request.get("code_challenge"), jwt.serialize()));
        return "/api/v1/auth/oidc/callback?code=" + code + "&state=" + request.get("state");
    }

    private static Map<String, String> query(String url) {
        Map<String, String> query = EnterpriseSignInIT.parse(URI.create(url).getRawQuery());
        assertThat(query).containsKeys("state", "nonce", "code_challenge");
        return query;
    }

    private static String location(HttpResponse<String> response) {
        assertThat(response.statusCode()).isEqualTo(302);
        return response.headers().firstValue("Location").orElseThrow();
    }

    private final class Browser {
        final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
        final Map<String, String> cookies = new LinkedHashMap<>();

        HttpResponse<String> get(String path) throws Exception {
            return keep(http.send(withCookies(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))).GET().build(),
                    HttpResponse.BodyHandlers.ofString()));
        }

        HttpResponse<String> post(String path, String json) throws Exception {
            return keep(http.send(withCookies(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)))
                    .header("Content-Type", "application/json").header("X-Requested-With", "mover")
                    .POST(HttpRequest.BodyPublishers.ofString(json)).build(), HttpResponse.BodyHandlers.ofString()));
        }

        HttpRequest.Builder withCookies(HttpRequest.Builder b) {
            if (!cookies.isEmpty()) {
                b.header("Cookie", String.join("; ", cookies.entrySet().stream().map(e -> e.getKey() + "=" + e.getValue()).toList()));
            }
            return b;
        }

        HttpResponse<String> keep(HttpResponse<String> response) {
            for (String cookie : response.headers().allValues("Set-Cookie")) {
                String[] pair = cookie.split(";", 2)[0].split("=", 2);
                if (pair[1].isEmpty() || cookie.contains("Max-Age=0")) {
                    cookies.remove(pair[0]);
                } else {
                    cookies.put(pair[0], pair[1]);
                }
            }
            return response;
        }
    }
}
