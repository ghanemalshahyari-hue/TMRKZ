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
    static final HttpServer PROVIDER;
    static final RSAKey KEY;
    static final RSAKey OTHER_KEY;
    static final Map<String, Grant> CODES = new ConcurrentHashMap<>();
    static volatile boolean tokenEndpointDown;

    record Grant(String challenge, String idToken) {
    }

    static {
        try {
            KEY = new RSAKeyGenerator(2048).keyID("k1").generate();
            OTHER_KEY = new RSAKeyGenerator(2048).keyID("k1").generate();
            PROVIDER = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
            PROVIDER.createContext("/realms/test/protocol/openid-connect/certs", ex -> {
                byte[] b = new JWKSet(KEY.toPublicJWK()).toString().getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().add("Content-Type", "application/json");
                ex.sendResponseHeaders(200, b.length);
                ex.getResponseBody().write(b);
                ex.close();
            });
            PROVIDER.createContext("/realms/test/protocol/openid-connect/token", ex -> {
                Map<String, String> form = parse(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                String basic = "Basic " + Base64.getEncoder().encodeToString((CLIENT + ":" + SECRET).getBytes(StandardCharsets.UTF_8));
                Grant g = CODES.remove(form.getOrDefault("code", ""));
                boolean ok = !tokenEndpointDown && basic.equals(ex.getRequestHeaders().getFirst("Authorization")) && g != null
                        && "authorization_code".equals(form.get("grant_type"))
                        && g.challenge().equals(s256(form.getOrDefault("code_verifier", "")));
                byte[] b = (ok ? "{\"token_type\":\"Bearer\",\"access_token\":\"opaque\",\"id_token\":\"" + g.idToken() + "\"}"
                        : "{\"error\":\"invalid_grant\"}").getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().add("Content-Type", "application/json");
                ex.sendResponseHeaders(tokenEndpointDown ? 500 : ok ? 200 : 400, b.length);
                ex.getResponseBody().write(b);
                ex.close();
            });
            PROVIDER.start();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String issuer() {
        return "http://localhost:" + PROVIDER.getAddress().getPort() + "/realms/test";
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
        jdbc.sql("insert into hr_source(id, name, last_success_at) values (:id, 'مصدر اختبار', now())").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'PUBLISHED', '[]', '{}')")
                .param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, source_id, mapping_version_id, trigger, status, started_at) values (:id, :s, :m, 'SCHEDULED', 'SUCCEEDED', now())")
                .param("id", run).param("s", source).param("m", mapping).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())")
                .param("id", snapshot).param("r", run).param("m", mapping).update();
        org = org("ORG", null);
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
