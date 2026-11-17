package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;

/**
 * Enterprise sign-in (PA-07 server side, PA-08 step-up). A stub OpenID provider — a test isolator with its own signing key
 * — stands in for Keycloak so every check runs against the real callback: browser binding, single-use state, PKCE,
 * signature, issuer, audience, nonce, linking rules and the absence of any local or demo sign-in. The LDAP-backed
 * Keycloak itself is exercised by the test environment in {@code ops/test-env}.
 */
class EnterpriseSignInIT extends IntegrationTest {

    static final String CLIENT = "tmrkz-web";
    static final String SECRET = "test-client-secret-0123456789";
    /** The backend-only platform-password client (ADR-070): direct password grant only, its own secret and audience. */
    static final String PASSWORD_CLIENT = "tmrkz-platform-password";
    static final String PASSWORD_SECRET = "test-password-client-secret-0123456789";
    static final HttpServer PROVIDER;
    static final RSAKey KEY;
    static final RSAKey OTHER_KEY;
    /** The signing key of the second realm ({@link #platformIssuer()}): the local platform provider of ADR-071. */
    static final RSAKey PLATFORM_KEY;
    static final Map<String, Grant> CODES = new ConcurrentHashMap<>();
    /** Password grants the stub provider accepts: login -> (password, ID token returned for it). */
    static final Map<String, Grant> PASSWORDS = new ConcurrentHashMap<>();
    /** Every token-endpoint path called, in order (which realm the backend went to). */
    static final List<String> TOKEN_CALLS = new java.util.concurrent.CopyOnWriteArrayList<>();
    static volatile boolean tokenEndpointDown;

    /** {@code challenge}: the PKCE challenge of a code, or the password of a password grant. */
    record Grant(String challenge, String idToken) {
    }

    static {
        try {
            KEY = new RSAKeyGenerator(2048).keyID("k1").generate();
            OTHER_KEY = new RSAKeyGenerator(2048).keyID("k1").generate();
            PLATFORM_KEY = new RSAKeyGenerator(2048).keyID("p1").generate();
            PROVIDER = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
            for (Map.Entry<String, RSAKey> realm : Map.of("test", KEY, "platform", PLATFORM_KEY).entrySet()) {
                PROVIDER.createContext("/realms/" + realm.getKey() + "/protocol/openid-connect/certs", ex -> {
                    byte[] b = new JWKSet(realm.getValue().toPublicJWK()).toString().getBytes(StandardCharsets.UTF_8);
                    ex.getResponseHeaders().add("Content-Type", "application/json");
                    ex.sendResponseHeaders(200, b.length);
                    ex.getResponseBody().write(b);
                    ex.close();
                });
                PROVIDER.createContext("/realms/" + realm.getKey() + "/protocol/openid-connect/token", EnterpriseSignInIT::token);
            }
            PROVIDER.start();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * The stub's token endpoint, the same in both realms: the browser client's authorization code (PKCE) and, like Keycloak's
     * direct grant, the platform-password client's password grant (HTTP 401 invalid_grant for wrong credentials).
     */
    private static void token(com.sun.net.httpserver.HttpExchange ex) throws java.io.IOException {
        TOKEN_CALLS.add(ex.getRequestURI().getPath());
        Map<String, String> form = parse(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        String authorization = ex.getRequestHeaders().getFirst("Authorization");
        String idToken = null;
        int status;
        String error = "invalid_grant";
        if ("password".equals(form.get("grant_type"))) {
            boolean client = basic(PASSWORD_CLIENT, PASSWORD_SECRET).equals(authorization);
            Grant g = PASSWORDS.get(form.getOrDefault("username", ""));
            boolean ok = client && g != null && g.challenge().equals(form.get("password"))
                    && List.of(form.getOrDefault("scope", "").split(" ")).contains("openid");
            if (!client) {
                error = "invalid_client";
            }
            idToken = ok ? g.idToken() : null;
            status = ok ? 200 : 401;
        } else {
            Grant g = CODES.remove(form.getOrDefault("code", ""));
            boolean ok = basic(CLIENT, SECRET).equals(authorization) && g != null && "authorization_code".equals(form.get("grant_type"))
                    && g.challenge().equals(s256(form.getOrDefault("code_verifier", "")));
            idToken = ok ? g.idToken() : null;
            status = ok ? 200 : 400;
        }
        if (tokenEndpointDown) {
            status = 500;
        }
        byte[] b = (status == 200 ? "{\"token_type\":\"Bearer\",\"access_token\":\"opaque\",\"id_token\":\"" + idToken + "\"}"
                : "{\"error\":\"" + error + "\"}").getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, b.length);
        ex.getResponseBody().write(b);
        ex.close();
    }

    private static String basic(String client, String secret) {
        return "Basic " + Base64.getEncoder().encodeToString((client + ":" + secret).getBytes(StandardCharsets.UTF_8));
    }

    static String issuer() {
        return "http://localhost:" + PROVIDER.getAddress().getPort() + "/realms/test";
    }

    /** A second realm of the same stub with its own key: the local platform provider when a test separates the two. */
    static String platformIssuer() {
        return "http://localhost:" + PROVIDER.getAddress().getPort() + "/realms/platform";
    }

    @DynamicPropertySource
    static void oidc(DynamicPropertyRegistry r) {
        r.add("tmrkz.oidc.issuer", EnterpriseSignInIT::issuer);
        r.add("tmrkz.oidc.internal-base-url", EnterpriseSignInIT::issuer);
        r.add("tmrkz.oidc.client-id", () -> CLIENT);
        r.add("tmrkz.oidc.client-secret", () -> SECRET);
        r.add("tmrkz.oidc.redirect-uri", () -> "http://tmrkz.test/api/v1/auth/oidc/callback");
        r.add("tmrkz.oidc.post-logout-redirect-uri", () -> "http://tmrkz.test/");
        r.add("tmrkz.oidc.link-key", () -> "DOMAIN_ACCOUNT");
        r.add("tmrkz.oidc.platform-accounts", () -> "platform.admin.it, Platform.Dev.IT");
        // ADR-070: the platform accounts' manual form goes to this provider's backend-only password client
        r.add("tmrkz.oidc.password-client-id", () -> PASSWORD_CLIENT);
        r.add("tmrkz.oidc.password-client-secret", () -> PASSWORD_SECRET);
        // ADR-068: the claims the identity provider maps from the directory (names as in ops/keycloak/set-employment-attributes.sh)
        r.add("tmrkz.oidc.unit-id-claim", () -> "tmrkz_unit_id");
        r.add("tmrkz.oidc.unit-name-claim", () -> "tmrkz_unit_name");
        r.add("tmrkz.oidc.main-unit-id-claim", () -> "tmrkz_main_unit_id");
        r.add("tmrkz.oidc.rank-claim", () -> "tmrkz_rank");
        r.add("tmrkz.oidc.position-claim", () -> "tmrkz_position");
    }

    // ---- fixtures -------------------------------------------------------------------------------------------

    UUID org;
    UUID snapshot;

    @BeforeEach
    void hrMirror() {
        tokenEndpointDown = false;
        jdbc.sql("delete from hr_sync_issue").update();
        jdbc.sql("delete from hr_unit").update();
        jdbc.sql("delete from hr_person").update();
        jdbc.sql("delete from hr_snapshot").update();
        jdbc.sql("delete from hr_sync_run").update();
        jdbc.sql("delete from hr_mapping_version").update();
        jdbc.sql("delete from hr_source").update();
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        snapshot = UUID.randomUUID();
        // Oracle in force (ADR-068: an enabled source with a published snapshot): the HR linking rules below apply. No settings are
        // saved, so HR is never asked live here.
        jdbc.sql("insert into hr_source(id, name, last_success_at, enabled) values (:id, 'مصدر اختبار', now(), true)").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'PUBLISHED', '[]', '{}')")
                .param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, source_id, mapping_version_id, trigger, status, started_at) values (:id, :s, :m, 'SCHEDULED', 'SUCCEEDED', now())")
                .param("id", run).param("s", source).param("m", mapping).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())")
                .param("id", snapshot).param("r", run).param("m", mapping).update();
        org = org("ORG", null);
    }

    /** A source left enabled would put later classes under Oracle (ADR-068). */
    @org.junit.jupiter.api.AfterEach
    void sourceOff() {
        jdbc.sql("update hr_source set enabled = false").update();
    }

    /** Like the provider, with extra ID-token claims (the employment claims of ADR-068). */
    private String callbackWithClaims(Authorization a, String subject, String account, Map<String, Object> extra) throws Exception {
        JWTClaimsSet.Builder c = new JWTClaimsSet.Builder().issuer(issuer()).subject(subject).audience(CLIENT)
                .issueTime(new Date()).expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("nonce", a.nonce()).claim("auth_time", Instant.now().getEpochSecond())
                .claim("preferred_username", account).claim("name", "موظف " + account).claim("azp", CLIENT);
        extra.forEach(c::claim);
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(KEY.getKeyID()).type(JOSEObjectType.JWT).build(), c.build());
        jwt.sign(new RSASSASigner(KEY));
        String code = UUID.randomUUID().toString();
        CODES.put(code, new Grant(a.challenge(), jwt.serialize()));
        return "/api/v1/auth/oidc/callback?code=" + code + "&state=" + a.state();
    }

    /** An HR person (projected and in the published snapshot) with the given domain account. */
    private UUID hrPerson(String account, boolean active) {
        UUID id = UUID.randomUUID();
        String ext = "X-" + account;
        jdbc.sql("insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, unit_external_id, active) values (:s, :x, :n, :a, :f, null, :ac)")
                .param("s", snapshot).param("x", ext).param("n", "N-" + account).param("a", account.toUpperCase())
                .param("f", "موظف " + account).param("ac", active).update();
        jdbc.sql("insert into person(id, employee_no, display_name, status, source, source_external_id, username) values (:id, :n, :f, :st, 'HR', :x, :u)")
                .param("id", id).param("n", "N-" + account).param("f", "موظف " + account).param("st", active ? "ACTIVE" : "DISABLED")
                .param("x", ext).param("u", account).update();
        membership(id, "REQUESTER", org, null);
        return id;
    }

    /** The browser: keeps cookies per name, never follows redirects (each hop is asserted). */
    final class Browser {
        final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
        final Map<String, String> cookies = new LinkedHashMap<>();

        HttpResponse<String> get(String pathOrUrl) throws Exception {
            String url = pathOrUrl.startsWith("http") ? pathOrUrl : "http://localhost:" + port + pathOrUrl;
            return keep(http.send(withCookies(HttpRequest.newBuilder(URI.create(url))).GET().build(), HttpResponse.BodyHandlers.ofString()));
        }

        HttpResponse<String> post(String path, String json) throws Exception {
            return keep(http.send(withCookies(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)))
                    .header("Content-Type", "application/json").header("X-Requested-With", "mover")
                    .POST(HttpRequest.BodyPublishers.ofString(json)).build(), HttpResponse.BodyHandlers.ofString()));
        }

        private HttpRequest.Builder withCookies(HttpRequest.Builder b) {
            if (!cookies.isEmpty()) {
                b.header("Cookie", String.join("; ", cookies.entrySet().stream().map(e -> e.getKey() + "=" + e.getValue()).toList()));
            }
            return b;
        }

        private HttpResponse<String> keep(HttpResponse<String> r) {
            for (String c : r.headers().allValues("Set-Cookie")) {
                String[] kv = c.split(";", 2)[0].split("=", 2);
                if (kv[1].isEmpty() || c.contains("Max-Age=0")) {
                    cookies.remove(kv[0]);
                } else {
                    cookies.put(kv[0], kv[1]);
                }
            }
            return r;
        }
    }

    record Authorization(String state, String nonce, String challenge, Map<String, String> query) {
    }

    private Authorization authorizationOf(HttpResponse<String> start) {
        assertThat(start.statusCode()).isEqualTo(302);
        String location = start.headers().firstValue("Location").orElseThrow();
        assertThat(location).startsWith(issuer() + "/protocol/openid-connect/auth?");
        Map<String, String> q = parse(URI.create(location).getRawQuery());
        return new Authorization(q.get("state"), q.get("nonce"), q.get("code_challenge"), q);
    }

    /** The provider authenticates the user and redirects back with a code bound to the PKCE challenge. */
    private String callbackFor(Authorization a, String subject, String account, RSAKey signer, String nonce, String audience, String issuer)
            throws Exception {
        JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer(issuer).subject(subject).audience(audience)
                .issueTime(new Date()).expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("nonce", nonce).claim("auth_time", Instant.now().getEpochSecond())
                .claim("preferred_username", account).claim("name", "موظف " + account).claim("azp", CLIENT).build();
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(signer.getKeyID()).type(JOSEObjectType.JWT).build(), claims);
        jwt.sign(new RSASSASigner(signer));
        String code = UUID.randomUUID().toString();
        CODES.put(code, new Grant(a.challenge(), jwt.serialize()));
        return "/api/v1/auth/oidc/callback?code=" + code + "&state=" + a.state();
    }

    /** Like the provider, but with a chosen auth_time (null leaves the claim out). */
    private String callbackWithAuthTime(Authorization a, String subject, String account, Long authTime) throws Exception {
        JWTClaimsSet.Builder b = new JWTClaimsSet.Builder().issuer(issuer()).subject(subject).audience(CLIENT)
                .issueTime(new Date()).expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("nonce", a.nonce()).claim("preferred_username", account).claim("name", "موظف " + account).claim("azp", CLIENT);
        if (authTime != null) {
            b.claim("auth_time", authTime);
        }
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(KEY.getKeyID()).type(JOSEObjectType.JWT).build(), b.build());
        jwt.sign(new RSASSASigner(KEY));
        String code = UUID.randomUUID().toString();
        CODES.put(code, new Grant(a.challenge(), jwt.serialize()));
        return "/api/v1/auth/oidc/callback?code=" + code + "&state=" + a.state();
    }

    /** Like the provider for a local Keycloak user: the realm roles it holds travel in the tmrkz_roles claim. */
    private String callbackWithRoles(Authorization a, String subject, String account, List<String> roles) throws Exception {
        JWTClaimsSet.Builder c = new JWTClaimsSet.Builder().issuer(issuer()).subject(subject).audience(CLIENT)
                .issueTime(new Date()).expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("nonce", a.nonce()).claim("auth_time", Instant.now().getEpochSecond())
                .claim("preferred_username", account).claim("name", "حساب " + account).claim("azp", CLIENT);
        if (roles != null) {
            c.claim("tmrkz_roles", roles);
        }
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(KEY.getKeyID()).type(JOSEObjectType.JWT).build(), c.build());
        jwt.sign(new RSASSASigner(KEY));
        String code = UUID.randomUUID().toString();
        CODES.put(code, new Grant(a.challenge(), jwt.serialize()));
        return "/api/v1/auth/oidc/callback?code=" + code + "&state=" + a.state();
    }

    private Authorization reauthOf(Browser b) throws Exception {
        String redirect = JSON.readTree(b.post("/api/v1/auth/reauth", "{\"returnTo\":\"/#review\"}").body()).path("redirect").asText();
        Map<String, String> q = parse(URI.create(redirect).getRawQuery());
        return new Authorization(q.get("state"), q.get("nonce"), q.get("code_challenge"), q);
    }

    private String callbackFor(Authorization a, String subject, String account) throws Exception {
        return callbackFor(a, subject, account, KEY, a.nonce(), CLIENT, issuer());
    }

    private static String location(HttpResponse<String> r) {
        assertThat(r.statusCode()).isEqualTo(302);
        return r.headers().firstValue("Location").orElseThrow();
    }

    // ---- tests ----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("PA-07: sign-in through the provider (PKCE, browser-bound state) links on the domain account and opens a server session")
    void signInLinksAndOpensSession() throws Exception {
        UUID person = hrPerson("u1" + sfx, true);
        Browser b = new Browser();
        HttpResponse<String> start = b.get("/api/v1/auth/oidc/start?return=/%23requests");
        Authorization a = authorizationOf(start);
        assertThat(a.query()).containsEntry("code_challenge_method", "S256").containsEntry("response_type", "code")
                .containsEntry("client_id", CLIENT).containsEntry("max_age", "43200").containsKey("nonce");
        assertThat(start.headers().allValues("Set-Cookie")).anyMatch(c -> c.startsWith("TMRKZ_OIDC=") && c.contains("HttpOnly") && c.contains("SameSite=Lax"));

        String subject = UUID.randomUUID().toString();
        HttpResponse<String> back = b.get(callbackFor(a, subject, "u1" + sfx));
        assertThat(location(back)).isEqualTo("/#requests");
        assertThat(back.headers().allValues("Set-Cookie")).anyMatch(c -> c.startsWith("MOVER_SESSION=") && c.contains("HttpOnly") && c.contains("SameSite=Strict"));
        HttpResponse<String> me = b.get("/api/v1/me");
        assertThat(me.statusCode()).isEqualTo(200);
        assertThat(JSON.readTree(me.body()).path("id").asText()).isEqualTo(person.toString());
        assertThat(JSON.readTree(me.body()).path("permissions").toString()).contains("CREATE");
        assertThat(jdbc.sql("select method from identity_link where person_id = :p").param("p", person).query(String.class).single())
                .isEqualTo("ENTERPRISE_KEY");

        // The link is (issuer, subject): a later sign-in finds the same person even if the directory name changed.
        Browser again = new Browser();
        Authorization a2 = authorizationOf(again.get("/api/v1/auth/oidc/start"));
        again.get(callbackFor(a2, subject, "renamed" + sfx));
        assertThat(JSON.readTree(again.get("/api/v1/me").body()).path("id").asText()).isEqualTo(person.toString());

        // Logout ends the TMRKZ session and returns the provider's end-session address with the ID token hint.
        HttpResponse<String> out = again.post("/api/v1/auth/logout", "{}");
        assertThat(JSON.readTree(out.body()).path("redirect").asText()).startsWith(issuer() + "/protocol/openid-connect/logout?")
                .contains("id_token_hint=");
        assertThat(again.get("/api/v1/me").statusCode()).isEqualTo(401);
    }

    @Test
    @DisplayName("PA-07: forged, replayed, foreign or mis-addressed responses are refused; nothing falls back to another sign-in")
    void refusals() throws Exception {
        hrPerson("u2" + sfx, true);
        String subject = UUID.randomUUID().toString();

        // Started in another browser: the callback lacks the binding cookie.
        Authorization stolen = authorizationOf(new Browser().get("/api/v1/auth/oidc/start"));
        assertThat(location(new Browser().get(callbackFor(stolen, subject, "u2" + sfx)))).startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");

        // Replay: the same state can be used once.
        Browser b = new Browser();
        Authorization a = authorizationOf(b.get("/api/v1/auth/oidc/start"));
        String cb = callbackFor(a, subject, "u2" + sfx);
        String binding = b.cookies.get("TMRKZ_OIDC");
        assertThat(location(b.get(cb))).isEqualTo("/");
        b.cookies.put("TMRKZ_OIDC", binding);
        assertThat(location(b.get(cb))).startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");

        for (String bad : List.of("key", "nonce", "audience", "issuer")) {
            Browser x = new Browser();
            Authorization ax = authorizationOf(x.get("/api/v1/auth/oidc/start"));
            String url = callbackFor(ax, subject, "u2" + sfx, bad.equals("key") ? OTHER_KEY : KEY, bad.equals("nonce") ? "other" : ax.nonce(),
                    bad.equals("audience") ? "another-app" : CLIENT, bad.equals("issuer") ? "http://evil.test/realms/test" : issuer());
            HttpResponse<String> r = x.get(url);
            assertThat(location(r)).as(bad).startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");
            assertThat(r.headers().allValues("Set-Cookie")).as(bad).noneMatch(c -> c.startsWith("MOVER_SESSION=") && !c.contains("Max-Age=0"));
        }

        // The provider says no, or is down: a clear error and no session.
        Browser denied = new Browser();
        authorizationOf(denied.get("/api/v1/auth/oidc/start"));
        assertThat(location(denied.get("/api/v1/auth/oidc/callback?error=access_denied&state=x"))).isEqualTo("/#auth-error=PROVIDER_ACCESS_DENIED");
        tokenEndpointDown = true;
        Browser down = new Browser();
        Authorization ad = authorizationOf(down.get("/api/v1/auth/oidc/start"));
        assertThat(location(down.get(callbackFor(ad, subject, "u2" + sfx)))).startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");
        tokenEndpointDown = false;
    }

    @Test
    @DisplayName("PA-07: unknown, inactive, ambiguous or stale-source identities are not linked; an access manager resolves them")
    void linkingRules() throws Exception {
        hrPerson("gone" + sfx, false);
        person("access", "SYSTEM_ADMIN", org);
        Api admin = login("access");

        Browser unknown = new Browser();
        String sub = UUID.randomUUID().toString();
        assertThat(location(unknown.get(callbackFor(authorizationOf(unknown.get("/api/v1/auth/oidc/start")), sub, "nobody" + sfx))))
                .isEqualTo("/#auth-error=IDENTITY_NOT_LINKED&reason=NO_MATCH");
        Browser inactive = new Browser();
        assertThat(location(inactive.get(callbackFor(authorizationOf(inactive.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(), "gone" + sfx))))
                .isEqualTo("/#auth-error=IDENTITY_NOT_LINKED&reason=INACTIVE");
        // A second source record with the same domain account makes the key ambiguous: never linked automatically.
        UUID first = hrPerson("dup" + sfx, true);
        jdbc.sql("insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, active) values (:s, :x, 'N-dup2', :a, 'موظف آخر', true)")
                .param("s", snapshot).param("x", "X-dup2-" + sfx).param("a", "dup" + sfx).update();
        jdbc.sql("insert into person(id, employee_no, display_name, source, source_external_id) values (gen_random_uuid(), :n, 'موظف آخر', 'HR', :x)")
                .param("n", "N-dup2-" + sfx).param("x", "X-dup2-" + sfx).update();
        Browser dup = new Browser();
        assertThat(location(dup.get(callbackFor(authorizationOf(dup.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(), "dup" + sfx))))
                .isEqualTo("/#auth-error=IDENTITY_NOT_LINKED&reason=AMBIGUOUS");
        // A mirror older than its age policy links nobody new.
        hrPerson("late" + sfx, true);
        jdbc.sql("update hr_source set last_success_at = now() - interval '40 days'").update();
        Browser late = new Browser();
        assertThat(location(late.get(callbackFor(authorizationOf(late.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(), "late" + sfx))))
                .isEqualTo("/#auth-error=IDENTITY_NOT_LINKED&reason=STALE_SOURCE");
        jdbc.sql("update hr_source set last_success_at = now()").update();

        // The access manager links the unknown identity to the right person, with a reason; the next sign-in succeeds.
        String issue = null;
        for (var i : admin.get("/identity-issues").body()) {
            if ("NO_MATCH".equals(i.path("reason").asText()) && i.path("subject").asText().equals(sub)) {
                issue = i.path("id").asText();
            }
        }
        assertThat(issue).isNotNull();
        assertThat(admin.post("/identity-issues/" + issue + "/resolve", Map.of("personId", first.toString(), "reason", "تحقق يدوي من الهوية")).status())
                .isEqualTo(204);
        Browser now = new Browser();
        now.get(callbackFor(authorizationOf(now.get("/api/v1/auth/oidc/start")), sub, "nobody" + sfx));
        assertThat(JSON.readTree(now.get("/api/v1/me").body()).path("id").asText()).isEqualTo(first.toString());
        person("plain", "REQUESTER", org);
        assertThat(login("plain").get("/identity-issues").status()).isEqualTo(403);
    }

    @Test
    @DisplayName("V21: a platform account (named login + the provider's tmrkz-platform role) signs in as a lasting local administrator")
    void platformAccounts() throws Exception {
        List<String> platformRole = List.of("default-roles-tmrkz", "tmrkz-platform");
        String adminSub = UUID.randomUUID().toString();
        Browser b = new Browser();
        assertThat(location(b.get(callbackWithRoles(authorizationOf(b.get("/api/v1/auth/oidc/start")), adminSub, "platform.admin.it", platformRole))))
                .isEqualTo("/");
        HttpResponse<String> me = b.get("/api/v1/me");
        assertThat(me.statusCode()).isEqualTo(200);
        String perms = JSON.readTree(me.body()).path("permissions").toString();
        assertThat(perms).contains("CONFIGURE", "MANAGE_ACCESS", "MANAGE_FACILITIES", "VIEW_SOURCE_IDENTIFIERS", "AUDIT");
        UUID admin = UUID.fromString(JSON.readTree(me.body()).path("id").asText());
        Map<String, Object> p = jdbc.sql("select source, employee_no, bootstrap, status from person where id = :p").param("p", admin).query().singleRow();
        assertThat(p).containsEntry("source", "LOCAL").containsEntry("employee_no", "PLATFORM-platform.admin.it")
                .containsEntry("bootstrap", false).containsEntry("status", "ACTIVE");
        assertThat(jdbc.sql("select method from identity_link where person_id = :p").param("p", admin).query(String.class).single()).isEqualTo("PLATFORM");
        assertThat(jdbc.sql("select string_agg(role_code, ',' order by role_code) from membership where person_id = :p and valid_to is null")
                .param("p", admin).query(String.class).single()).isEqualTo("AUDITOR,SYSTEM_ADMIN");

        // A directory user of the same name holds no platform role: it is an ordinary sign-in (no HR record here).
        Browser same = new Browser();
        assertThat(location(same.get(callbackWithRoles(authorizationOf(same.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(),
                "platform.admin.it", null)))).startsWith("/#auth-error=IDENTITY_NOT_LINKED");
        // The role alone is not enough: the installation must name the login.
        Browser unnamed = new Browser();
        assertThat(location(unnamed.get(callbackWithRoles(authorizationOf(unnamed.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(),
                "someone" + sfx, platformRole)))).startsWith("/#auth-error=IDENTITY_NOT_LINKED");
        // counted for this class's two logins only: other classes (DualProviderSignInIT) keep platform accounts of their own
        assertThat(jdbc.sql("select count(*) from person where employee_no like 'PLATFORM-%' and employee_no in " + OWN_PLATFORM)
                .query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'PLATFORM_GRANT_RENEWED' and entity_id in " + OWN_PLATFORM_IDS)
                .query(Long.class).single()).isZero();

        // Lasting: a grant ended by someone is current again at the next sign-in; the same person, the same link.
        jdbc.sql("update membership set valid_to = now(), ended_reason = 'TEST' where person_id = :p and role_code = 'SYSTEM_ADMIN' and valid_to is null")
                .param("p", admin).update();
        Browser again = new Browser();
        again.get(callbackWithRoles(authorizationOf(again.get("/api/v1/auth/oidc/start")), adminSub, "platform.admin.it", platformRole));
        assertThat(JSON.readTree(again.get("/api/v1/me").body()).path("id").asText()).isEqualTo(admin.toString());
        assertThat(JSON.readTree(again.get("/api/v1/me").body()).path("permissions").toString()).contains("MANAGE_ACCESS");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'PLATFORM_GRANT_RENEWED' and entity_id in " + OWN_PLATFORM_IDS)
                .query(Long.class).single()).isEqualTo(1);

        // The developer (named in another case) is a person of its own with the same rights.
        Browser dev = new Browser();
        dev.get(callbackWithRoles(authorizationOf(dev.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(), "platform.dev.it", platformRole));
        String devId = JSON.readTree(dev.get("/api/v1/me").body()).path("id").asText();
        assertThat(devId).isNotEqualTo(admin.toString());
        assertThat(JSON.readTree(dev.get("/api/v1/me").body()).path("permissions").toString()).contains("CONFIGURE", "MANAGE_ACCESS", "AUDIT");

        // Revoked in the provider (role removed): the linked identity no longer signs in.
        Browser revoked = new Browser();
        assertThat(location(revoked.get(callbackWithRoles(authorizationOf(revoked.get("/api/v1/auth/oidc/start")), adminSub, "platform.admin.it",
                List.of("default-roles-tmrkz"))))).isEqualTo("/#auth-error=IDENTITY_NOT_LINKED&reason=PLATFORM_REVOKED");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'PLATFORM_ACCOUNT_CREATED' and entity_id in " + OWN_PLATFORM_IDS)
                .query(Long.class).single()).isEqualTo(2);
    }

    private static final String OWN_PLATFORM = "('PLATFORM-platform.admin.it', 'PLATFORM-platform.dev.it')";
    private static final String OWN_PLATFORM_IDS = "(select id::text from person where employee_no in " + OWN_PLATFORM + ")";

    /** The ID token the provider returns for a direct password grant (Keycloak: no auth_time unless stated, fresh iat). */
    private static String passwordToken(String subject, String account, List<String> roles, RSAKey signer, String issuer, String audience,
                                        Instant issuedAt, Long authTime) throws Exception {
        JWTClaimsSet.Builder c = new JWTClaimsSet.Builder().issuer(issuer).subject(subject).audience(audience)
                .issueTime(Date.from(issuedAt)).expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("preferred_username", account).claim("name", "حساب " + account).claim("azp", audience);
        if (roles != null) {
            c.claim("tmrkz_roles", roles);
        }
        if (authTime != null) {
            c.claim("auth_time", authTime);
        }
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(signer.getKeyID()).type(JOSEObjectType.JWT).build(), c.build());
        jwt.sign(new RSASSASigner(signer));
        return jwt.serialize();
    }

    private static boolean session(HttpResponse<String> r) {
        return r.headers().allValues("Set-Cookie").stream().anyMatch(c -> c.startsWith("MOVER_SESSION=") && !c.contains("Max-Age=0"));
    }

    @Test
    @DisplayName("ADR-070: a platform account signs in with the manual form only through the platform-password client — verified token, never the directory")
    void manualPlatformAccounts() throws Exception {
        List<String> platformRole = List.of("default-roles-tmrkz", "tmrkz-platform");
        String admin = "platform.admin.it";
        String subject = "manual-" + sfx;
        String password = "Platform#Manual-" + sfx;
        PASSWORDS.put(admin, new Grant(password, passwordToken(subject, admin, platformRole, KEY, issuer(), PASSWORD_CLIENT, Instant.now(), null)));
        TOKEN_CALLS.clear();

        // The named account, typed in any case: the provider checks the password; TMRKZ opens a provider-backed session.
        Browser b = new Browser();
        HttpResponse<String> ok = b.post("/api/v1/auth/directory/login", write(Map.of("username", " Platform.Admin.IT ", "password", password)));
        assertThat(ok.statusCode()).as(ok.body()).isEqualTo(200);
        assertThat(session(ok)).isTrue();
        assertThat(TOKEN_CALLS).containsExactly("/realms/test/protocol/openid-connect/token");
        com.fasterxml.jackson.databind.JsonNode me = JSON.readTree(b.get("/api/v1/me").body());
        assertThat(me.path("signInMethod").asText()).as("provider-backed, not DIRECTORY").isEqualTo("PROVIDER");
        assertThat(me.path("permissions").toString()).contains("CONFIGURE", "MANAGE_ACCESS", "AUDIT");
        UUID person = UUID.fromString(me.path("id").asText());
        assertThat(jdbc.sql("select employee_no from person where id = :p").param("p", person).query(String.class).single())
                .isEqualTo("PLATFORM-platform.admin.it");
        Map<String, Object> link = jdbc.sql("select issuer, subject, method from identity_link where person_id = :p").param("p", person)
                .query().singleRow();
        assertThat(link).containsEntry("issuer", issuer()).containsEntry("subject", subject).containsEntry("method", "PLATFORM");
        Map<String, Object> stored = jdbc.sql("""
                select issuer, authenticated_at is not null as fresh, id_token is not null as token from user_session
                where person_id = :p order by created_at desc limit 1""").param("p", person).query().singleRow();
        assertThat(stored).containsEntry("issuer", issuer()).containsEntry("fresh", true).containsEntry("token", true);
        // the session ends at the provider with the password client's own token
        String out = JSON.readTree(b.post("/api/v1/auth/logout", "{}").body()).path("redirect").asText();
        assertThat(out).startsWith(issuer() + "/protocol/openid-connect/logout?").contains("client_id=" + PASSWORD_CLIENT).contains("id_token_hint=");
        assertThat(b.get("/api/v1/me").statusCode()).isEqualTo(401);

        // A wrong platform password is refused by the provider and never tried against the directory (none is configured
        // here: a directory attempt would answer IDENTITY_PROVIDER_NOT_CONFIGURED); it counts toward the login's lock.
        TOKEN_CALLS.clear();
        HttpResponse<String> wrong = new Browser().post("/api/v1/auth/directory/login", write(Map.of("username", admin, "password", "not-the-password")));
        assertThat(wrong.statusCode()).isEqualTo(401);
        assertThat(JSON.readTree(wrong.body()).path("code").asText()).isEqualTo("IDENTITY_SIGN_IN_FAILED");
        assertThat(session(wrong)).isFalse();
        assertThat(TOKEN_CALLS).hasSize(1);
        assertThat(jdbc.sql("select failures from login_throttle where key = :k").param("k", "u:" + admin).query(Integer.class).single()).isEqualTo(1);

        // A login the installation does not name never reaches the password client, even if the provider would accept it.
        String unnamed = "someone" + sfx;
        PASSWORDS.put(unnamed, new Grant(password, passwordToken("unnamed-" + sfx, unnamed, platformRole, KEY, issuer(), PASSWORD_CLIENT, Instant.now(), null)));
        TOKEN_CALLS.clear();
        HttpResponse<String> other = new Browser().post("/api/v1/auth/directory/login", write(Map.of("username", unnamed, "password", password)));
        assertThat(other.statusCode()).as("the directory's answer: not configured here").isEqualTo(503);
        assertThat(JSON.readTree(other.body()).path("code").asText()).isEqualTo("IDENTITY_PROVIDER_NOT_CONFIGURED");
        assertThat(TOKEN_CALLS).isEmpty();
        assertThat(jdbc.sql("select count(*) from person where username = :u").param("u", unnamed).query(Long.class).single()).isZero();

        // What the provider returns must be this account's signed, fresh token for the dedicated client.
        long now = Instant.now().getEpochSecond();
        Map<String, String> refused = new LinkedHashMap<>();
        refused.put("another user", passwordToken("dev-" + sfx, "platform.dev.it", platformRole, KEY, issuer(), PASSWORD_CLIENT, Instant.now(), null));
        refused.put("browser client audience", passwordToken(subject, admin, platformRole, KEY, issuer(), CLIENT, Instant.now(), null));
        refused.put("another issuer", passwordToken(subject, admin, platformRole, KEY, "http://evil.test/realms/test", PASSWORD_CLIENT, Instant.now(), null));
        refused.put("another key", passwordToken(subject, admin, platformRole, OTHER_KEY, issuer(), PASSWORD_CLIENT, Instant.now(), null));
        refused.put("stale iat", passwordToken(subject, admin, platformRole, KEY, issuer(), PASSWORD_CLIENT, Instant.now().minusSeconds(600), null));
        refused.put("future iat", passwordToken(subject, admin, platformRole, KEY, issuer(), PASSWORD_CLIENT, Instant.now().plusSeconds(600), null));
        refused.put("stale auth_time", passwordToken(subject, admin, platformRole, KEY, issuer(), PASSWORD_CLIENT, Instant.now(), now - 3600));
        for (Map.Entry<String, String> bad : refused.entrySet()) {
            PASSWORDS.put(admin, new Grant(password, bad.getValue()));
            Browser x = new Browser();
            HttpResponse<String> r = x.post("/api/v1/auth/directory/login", write(Map.of("username", admin, "password", password)));
            assertThat(r.statusCode()).as(bad.getKey()).isEqualTo(401);
            assertThat(JSON.readTree(r.body()).path("code").asText()).as(bad.getKey()).isEqualTo("IDENTITY_SIGN_IN_FAILED");
            assertThat(session(r)).as(bad.getKey()).isFalse();
            assertThat(x.get("/api/v1/me").statusCode()).as(bad.getKey()).isEqualTo(401);
        }
        assertThat(jdbc.sql("select count(*) from person where employee_no = 'PLATFORM-platform.dev.it' and id in "
                + "(select person_id from identity_link where subject = :s)").param("s", "dev-" + sfx).query(Long.class).single()).isZero();

        // When the provider does state auth_time, a fresh one is accepted.
        PASSWORDS.put(admin, new Grant(password, passwordToken(subject, admin, platformRole, KEY, issuer(), PASSWORD_CLIENT, Instant.now(), now)));
        assertThat(new Browser().post("/api/v1/auth/directory/login", write(Map.of("username", admin, "password", password))).statusCode()).isEqualTo(200);

        // Losing the provider's platform role refuses entry; it never becomes an ordinary sign-in through this client.
        PASSWORDS.put(admin, new Grant(password, passwordToken(subject, admin, List.of("default-roles-tmrkz"), KEY, issuer(), PASSWORD_CLIENT,
                Instant.now(), null)));
        HttpResponse<String> revoked = new Browser().post("/api/v1/auth/directory/login", write(Map.of("username", admin, "password", password)));
        assertThat(revoked.statusCode()).isEqualTo(403);
        assertThat(JSON.readTree(revoked.body()).path("details").path("reason").asText()).isEqualTo("PLATFORM_REVOKED");
        assertThat(session(revoked)).isFalse();
        PASSWORDS.remove(admin);
        PASSWORDS.remove(unnamed);
    }

    @Test
    @DisplayName("A User ID added without HR (ADR-049) links on its first directory sign-in; a second identity for it is refused")
    void localUserFirstSignIn() throws Exception {
        String login = "local" + sfx;
        UUID local = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username, source) values (:id, :e, :l, :l, 'LOCAL')")
                .param("id", local).param("e", "USER-" + login).param("l", login).update();
        Browser b = new Browser();
        assertThat(location(b.get(callbackWithRoles(authorizationOf(b.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(),
                login.toUpperCase(), null)))).isEqualTo("/");
        com.fasterxml.jackson.databind.JsonNode me = JSON.readTree(b.get("/api/v1/me").body());
        assertThat(me.path("id").asText()).isEqualTo(local.toString());
        assertThat(me.path("permissions").size()).as("nothing until an access manager ticks a cell").isZero();
        assertThat(jdbc.sql("select method from identity_link where person_id = :p").param("p", local).query(String.class).single()).isEqualTo("LOCAL_USER");
        assertThat(jdbc.sql("select display_name from person where id = :p").param("p", local).query(String.class).single())
                .as("the placeholder name takes the directory's").isEqualTo("حساب " + login.toUpperCase());

        Browser other = new Browser();
        assertThat(location(other.get(callbackWithRoles(authorizationOf(other.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(),
                login, null)))).startsWith("/#auth-error=IDENTITY_NOT_LINKED");
        // a LOCAL person not created through «إضافة مستخدم» never links this way
        String plain = "plain" + sfx;
        jdbc.sql("insert into person(id, employee_no, display_name, username, source) values (:id, :e, :l, :l, 'LOCAL')")
                .param("id", UUID.randomUUID()).param("e", "T-" + plain).param("l", plain).update();
        Browser p = new Browser();
        assertThat(location(p.get(callbackWithRoles(authorizationOf(p.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(),
                plain, null)))).startsWith("/#auth-error=IDENTITY_NOT_LINKED");
    }

    @Test
    @DisplayName("No local password or demo sign-in exists in the build; approval needs a fresh provider authentication")
    void noLocalSignInAndStepUp() throws Exception {
        Browser anon = new Browser();
        assertThat(anon.post("/api/v1/auth/login", "{\"username\":\"x\",\"password\":\"y\"}").statusCode()).isEqualTo(401);
        assertThat(anon.get("/api/v1/auth/demo-users").statusCode()).isEqualTo(401);
        assertThat(anon.post("/api/v1/auth/demo-switch", "{\"username\":\"x\"}").statusCode()).isEqualTo(401);
        assertThatThrownBy(() -> Class.forName("ae.mover.security.DemoProperties")).isInstanceOf(ClassNotFoundException.class);
        assertThat(JSON.readTree(anon.get("/api/v1/auth/status").body()).path("configured").asBoolean()).isTrue();

        // An approver whose sign-in is older than the step-up window must re-authenticate before the decision.
        UUID approver = hrPerson("apr" + sfx, true);
        membership(approver, "APPROVER", org, null);
        UUID siteId = site("S", null, org);
        UUID res = resource("R", siteId, null, 0);
        person("req", "REQUESTER", org);
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        UUID request = login("req").submitted(type, org, List.of(res), day("2029-03-01"), day("2029-03-02"));

        Browser b = new Browser();
        String sub = UUID.randomUUID().toString();
        b.get(callbackFor(authorizationOf(b.get("/api/v1/auth/oidc/start")), sub, "apr" + sfx));
        jdbc.sql("update user_session set authenticated_at = now() - interval '1 hour' where person_id = :p").param("p", approver).update();
        String task = jdbc.sql("select id::text from task_assignment where request_id = :r").param("r", request).query(String.class).single();
        String decision = "{\"decision\":\"APPROVE\",\"expectedRevision\":1,\"signature\":{\"confirm\":true}}";
        HttpResponse<String> stale = b.post("/api/v1/tasks/" + task + "/decision", decision);
        assertThat(stale.statusCode()).isEqualTo(403);
        assertThat(JSON.readTree(stale.body()).path("code").asText()).isEqualTo("REAUTHENTICATION_REQUIRED");
        assertThat(jdbc.sql("select count(*) from decision where request_id = :r").param("r", request).query(Long.class).single()).isZero();

        // Step-up asks the provider to authenticate again (prompt=login, max_age=0) for the same session and person.
        String redirect = JSON.readTree(b.post("/api/v1/auth/reauth", "{\"returnTo\":\"/#review\"}").body()).path("redirect").asText();
        Map<String, String> q = parse(URI.create(redirect).getRawQuery());
        assertThat(q).containsEntry("prompt", "login").containsEntry("max_age", "0");
        Authorization ra = new Authorization(q.get("state"), q.get("nonce"), q.get("code_challenge"), q);
        // Someone else authenticating cannot refresh this session.
        UUID other = hrPerson("oth" + sfx, true);
        Browser ob = new Browser();
        ob.get(callbackFor(authorizationOf(ob.get("/api/v1/auth/oidc/start")), "other-" + sfx, "oth" + sfx));
        assertThat(other).isNotNull();
        String wrong = callbackFor(ra, "other-" + sfx, "oth" + sfx);
        assertThat(location(b.get(wrong))).startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");
        assertThat(b.post("/api/v1/tasks/" + task + "/decision", decision).statusCode()).isEqualTo(403);

        String redirect2 = JSON.readTree(b.post("/api/v1/auth/reauth", "{\"returnTo\":\"/#review\"}").body()).path("redirect").asText();
        Map<String, String> q2 = parse(URI.create(redirect2).getRawQuery());
        Authorization ra2 = new Authorization(q2.get("state"), q2.get("nonce"), q2.get("code_challenge"), q2);
        assertThat(location(b.get(callbackFor(ra2, sub, "apr" + sfx)))).isEqualTo("/#review");
        HttpResponse<String> ok = b.post("/api/v1/tasks/" + task + "/decision", decision);
        assertThat(ok.statusCode()).as(ok.body()).isEqualTo(200);
        assertThat(activeReservations(res)).isEqualTo(1);
    }

    @Test
    @DisplayName("auth_time: required (max_age is always sent), never replaced by iat; future, too old or pre-step-up values are refused")
    void authenticationTime() throws Exception {
        UUID person = hrPerson("at" + sfx, true);
        membership(person, "APPROVER", org, null);
        String sub = "sub-at-" + sfx;
        long now = Instant.now().getEpochSecond();

        Browser future = new Browser();
        assertThat(location(future.get(callbackWithAuthTime(authorizationOf(future.get("/api/v1/auth/oidc/start")), sub, "at" + sfx, now + 600))))
                .startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");

        Browser missing = new Browser();
        assertThat(location(missing.get(callbackWithAuthTime(authorizationOf(missing.get("/api/v1/auth/oidc/start")), sub, "at" + sfx, null))))
                .startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");
        Browser tooOld = new Browser();
        assertThat(location(tooOld.get(callbackWithAuthTime(authorizationOf(tooOld.get("/api/v1/auth/oidc/start")), sub, "at" + sfx, now - 50000))))
                .startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");

        // Authenticated an hour ago (a reused provider session): signed in, but approvals ask for a step-up.
        Browser b = new Browser();
        assertThat(location(b.get(callbackWithAuthTime(authorizationOf(b.get("/api/v1/auth/oidc/start")), sub, "at" + sfx, now - 3600)))).isEqualTo("/");
        assertThat(jdbc.sql("select count(*) from user_session where person_id = :p").param("p", person).query(Long.class).single()).isEqualTo(1);
        UUID siteId = site("S", null, org);
        UUID res = resource("R", siteId, null, 0);
        person("req", "REQUESTER", org);
        UUID request = login("req").submitted(requestType("NEW_RESERVATION", finalOnly(), null), org, List.of(res), day("2029-05-01"), day("2029-05-02"));
        String task = jdbc.sql("select id::text from task_assignment where request_id = :r").param("r", request).query(String.class).single();
        String decision = "{\"decision\":\"APPROVE\",\"expectedRevision\":1,\"signature\":{\"confirm\":true}}";
        assertThat(JSON.readTree(b.post("/api/v1/tasks/" + task + "/decision", decision).body()).path("code").asText())
                .isEqualTo("REAUTHENTICATION_REQUIRED");

        // max_age=0 makes auth_time mandatory, and it must not predate the step-up (a reused old session).
        assertThat(location(b.get(callbackWithAuthTime(reauthOf(b), sub, "at" + sfx, null)))).startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");
        assertThat(location(b.get(callbackWithAuthTime(reauthOf(b), sub, "at" + sfx, now - 3600)))).startsWith("/#auth-error=IDENTITY_SIGN_IN_FAILED");
        assertThat(b.post("/api/v1/tasks/" + task + "/decision", decision).statusCode()).isEqualTo(403);
        assertThat(location(b.get(callbackWithAuthTime(reauthOf(b), sub, "at" + sfx, Instant.now().getEpochSecond())))).isEqualTo("/#review");
        assertThat(b.post("/api/v1/tasks/" + task + "/decision", decision).statusCode()).isEqualTo(200);
        assertThat(activeReservations(res)).isEqualTo(1);
    }

    @Test
    @DisplayName("AUTH-01, SOURCE-01 (provider path): before Oracle, the provider's claims make a zero-access person placed by Unit ID; a platform-looking or conflicting identity gets no record")
    void firstSignInFromClaimsBeforeOracle() throws Exception {
        jdbc.sql("update hr_source set enabled = false").update(); // Oracle not in force: the directory decides
        UUID unit = org("CLM", null);
        jdbc.sql("update organization set source_external_id = :x where id = :id").param("x", "CU-" + sfx).param("id", unit).update();
        String account = "claims" + sfx;
        Map<String, Object> claims = Map.of("employee_number", "CN-" + sfx, "tmrkz_unit_id", "CU-" + sfx, "tmrkz_unit_name", "نص الوحدة",
                "tmrkz_rank", "رائد", "tmrkz_position", "ركن عمليات");
        Browser b = new Browser();
        assertThat(location(b.get(callbackWithClaims(authorizationOf(b.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(), account, claims))))
                .isEqualTo("/");
        com.fasterxml.jackson.databind.JsonNode me = JSON.readTree(b.get("/api/v1/me").body());
        assertThat(me.path("permissions").size()).as("nothing until granted").isZero();
        UUID person = UUID.fromString(me.path("id").asText());
        assertThat(jdbc.sql("select employee_no from person where id = :p").param("p", person).query(String.class).single()).isEqualTo("CN-" + sfx);
        assertThat(jdbc.sql("select method from identity_link where person_id = :p").param("p", person).query(String.class).single()).isEqualTo("DIRECTORY");
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", person).query(Long.class).single()).isZero();
        com.fasterxml.jackson.databind.JsonNode who = JSON.readTree(b.get("/api/v1/access-requests/mine").body()).path("identity");
        assertThat(who.path("sourceCode").asText()).isEqualTo("LDAP");
        assertThat(who.path("unit").asText()).isEqualTo("جهة CLM");
        assertThat(who.path("rank").asText()).isEqualTo("رائد");
        assertThat(who.path("position").asText()).isEqualTo("ركن عمليات");
        assertThat(b.get("/api/v1/sites").statusCode()).isEqualTo(403);

        // an identity stating the platform role that the installation does not name never gets a record
        Browser unnamed = new Browser();
        assertThat(location(unnamed.get(callbackWithRoles(authorizationOf(unnamed.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(),
                "platformish" + sfx, List.of("tmrkz-platform"))))).startsWith("/#auth-error=IDENTITY_NOT_LINKED");
        assertThat(jdbc.sql("select count(*) from person where username = :u").param("u", "platformish" + sfx).query(Long.class).single()).isZero();
        // a login another TMRKZ record already holds never gets a second record: an access manager decides
        String taken = "taken" + sfx;
        jdbc.sql("insert into person(id, employee_no, display_name, username, source) values (gen_random_uuid(), :e, :l, :l, 'LOCAL')")
                .param("e", "T-" + taken).param("l", taken).update();
        Browser dup = new Browser();
        assertThat(location(dup.get(callbackWithRoles(authorizationOf(dup.get("/api/v1/auth/oidc/start")), UUID.randomUUID().toString(), taken, null))))
                .isEqualTo("/#auth-error=IDENTITY_NOT_LINKED&reason=DIRECTORY_CONFLICT");
        assertThat(jdbc.sql("select count(*) from person where lower(username) = :u").param("u", taken).query(Long.class).single()).isEqualTo(1);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------

    static Map<String, String> parse(String query) {
        Map<String, String> out = new LinkedHashMap<>();
        if (query == null || query.isEmpty()) {
            return out;
        }
        for (String part : query.split("&")) {
            String[] kv = part.split("=", 2);
            out.put(URLDecoder.decode(kv[0], StandardCharsets.UTF_8), kv.length > 1 ? URLDecoder.decode(kv[1], StandardCharsets.UTF_8) : "");
        }
        return out;
    }

    static String s256(String verifier) {
        try {
            return Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
