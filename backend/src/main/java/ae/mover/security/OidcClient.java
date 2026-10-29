package ae.mover.security;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jose.util.DefaultResourceRetriever;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;

import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import ae.mover.common.Json;

/**
 * OpenID Connect Authorization Code flow with PKCE (S256), run by the server: the browser never holds provider tokens.
 * Each attempt is single use, expires after ten minutes, and is bound to the browser that started it by an HttpOnly
 * cookie, so a stolen callback URL cannot complete someone else's sign-in. The ID token is verified against the
 * provider's published keys, issuer, audience, expiry and the nonce of this attempt.
 */
@Component
public class OidcClient {

    private static final Logger log = LoggerFactory.getLogger(OidcClient.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Duration ATTEMPT_LIFETIME = Duration.ofMinutes(10);
    private static final Duration CLOCK_SKEW = Duration.ofSeconds(60);

    private final JdbcClient jdbc;
    private final Clock clock;
    private final OidcProperties props;
    private final Json json;
    private final HttpClient http;
    private volatile JWKSource<SecurityContext> keys;

    public OidcClient(JdbcClient jdbc, Clock clock, OidcProperties props, Json json) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.props = props;
        this.json = json;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(props.httpTimeoutMs()))
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    public boolean configured() {
        return props.configured();
    }

    public record Started(String redirectUrl, String browserBinding) {
    }

    public record Identity(String issuer, String subject, String enterpriseKey, String displayName, String username,
                           Instant authTime, String idToken, String purpose, String returnTo, String sessionId) {

        @Override
        public String toString() {
            return "Identity[" + issuer + ", " + subject + "]"; // never the token
        }
    }

    public Started start(String purpose, String returnTo, String sessionId) {
        if (!props.configured()) {
            throw new ApiException(ErrorCode.IDENTITY_PROVIDER_NOT_CONFIGURED,
                    "الدخول المؤسسي غير مهيأ في بيئة التشغيل؛ لا يوجد دخول بديل.");
        }
        String state = random(32);
        String browser = random(32);
        String verifier = random(48);
        String nonce = random(24);
        Instant now = clock.instant();
        jdbc.sql("delete from oidc_login where expires_at < :now").param("now", Db.ts(now)).update();
        jdbc.sql("""
                insert into oidc_login(state_hash, browser_hash, code_verifier, nonce, purpose, return_to, session_id, created_at, expires_at)
                values (:s, :b, :v, :n, :p, :r, :sid, :now, :exp)""")
                .param("s", Hashing.sha256(state)).param("b", Hashing.sha256(browser)).param("v", verifier).param("n", nonce)
                .param("p", purpose).param("r", safeReturn(returnTo)).param("sid", sessionId).param("now", Db.ts(now))
                .param("exp", Db.ts(now.plus(ATTEMPT_LIFETIME))).update();
        Map<String, String> q = new LinkedHashMap<>();
        q.put("response_type", "code");
        q.put("client_id", props.clientId());
        q.put("redirect_uri", props.redirectUri());
        q.put("scope", "openid profile");
        q.put("state", state);
        q.put("nonce", nonce);
        q.put("code_challenge", challenge(verifier));
        q.put("code_challenge_method", "S256");
        q.put("ui_locales", "ar");
        // max_age obliges the provider to return auth_time (OIDC Core 3.1.2.1); a step-up asks for a fresh authentication.
        if ("REAUTH".equals(purpose)) {
            q.put("prompt", "login");
            q.put("max_age", "0");
        } else {
            q.put("max_age", String.valueOf(props.loginMaxAgeSeconds()));
        }
        return new Started(props.authorizationEndpoint() + "?" + form(q), browser);
    }

    /** Completes the attempt identified by {@code state}; any failure is a refusal, never a fallback. */
    public Identity complete(String code, String state, String browserBinding) {
        if (code == null || state == null || browserBinding == null) {
            throw failed("بيانات العودة من مزود الهوية ناقصة.");
        }
        Map<String, Object> attempt = jdbc.sql("delete from oidc_login where state_hash = :s returning *")
                .param("s", Hashing.sha256(state)).query().listOfRows().stream().findFirst().orElse(null);
        if (attempt == null || Db.toInstant(attempt.get("expires_at")).isBefore(clock.instant())) {
            throw failed("انتهت صلاحية محاولة الدخول أو استُخدمت من قبل؛ ابدأ الدخول من جديد.");
        }
        if (!MessageDigest.isEqual(Hashing.sha256(browserBinding).getBytes(StandardCharsets.US_ASCII),
                ((String) attempt.get("browser_hash")).getBytes(StandardCharsets.US_ASCII))) {
            throw failed("لم تبدأ محاولة الدخول من هذا المتصفح.");
        }
        Map<String, String> body = new LinkedHashMap<>();
        body.put("grant_type", "authorization_code");
        body.put("code", code);
        body.put("redirect_uri", props.redirectUri());
        body.put("code_verifier", (String) attempt.get("code_verifier"));
        String basic = Base64.getEncoder().encodeToString((enc(props.clientId()) + ":" + enc(props.clientSecret()))
                .getBytes(StandardCharsets.UTF_8));
        HttpResponse<String> res;
        try {
            res = http.send(HttpRequest.newBuilder(URI.create(props.tokenEndpoint()))
                    .timeout(Duration.ofMillis(props.httpTimeoutMs()))
                    .header("Content-Type", "application/x-www-form-urlencoded").header("Authorization", "Basic " + basic)
                    .POST(HttpRequest.BodyPublishers.ofString(form(body))).build(), HttpResponse.BodyHandlers.ofString());
        } catch (java.io.IOException e) {
            log.warn("OIDC token endpoint unreachable: {}", e.getMessage());
            throw new ApiException(ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, "تعذر الوصول إلى مزود الهوية؛ لا يوجد دخول بديل.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ApiException(ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, "انقطع الاتصال بمزود الهوية.");
        }
        if (res.statusCode() != 200) {
            log.warn("OIDC token exchange refused with HTTP {}", res.statusCode());
            throw failed("رفض مزود الهوية إتمام الدخول.");
        }
        String idToken = json.tree(res.body()).path("id_token").asText(null);
        if (idToken == null) {
            throw failed("لم يُرجع مزود الهوية رمز الهوية.");
        }
        JWTClaimsSet claims = verify(idToken, (String) attempt.get("nonce"));
        try {
            Instant at = authenticationTime(claims, (String) attempt.get("purpose"), Db.toInstant(attempt.get("created_at")));
            String name = claims.getStringClaim("name");
            String username = claims.getStringClaim("preferred_username");
            Object key = "DOMAIN_ACCOUNT".equals(props.linkKey()) ? username : claims.getClaim(props.enterpriseKeyClaim());
            String enterpriseKey = key instanceof List<?> l ? (l.size() == 1 ? String.valueOf(l.get(0)) : null)
                    : key == null ? null : String.valueOf(key).trim();
            return new Identity(claims.getIssuer(), claims.getSubject(), enterpriseKey == null || enterpriseKey.isEmpty() ? null : enterpriseKey,
                    name, username, at, idToken, (String) attempt.get("purpose"), (String) attempt.get("return_to"),
                    (String) attempt.get("session_id"));
        } catch (java.text.ParseException e) {
            throw failed("رمز الهوية يحمل بيانات غير صالحة.");
        }
    }

    /**
     * When the person authenticated (OIDC {@code auth_time}). The token's issue time proves nothing about that and is never
     * used instead. Every request carries {@code max_age}, so {@code auth_time} is mandatory: missing, in the future or
     * older than the requested age, the response is refused. A step-up ({@code max_age=0}) must have authenticated after
     * the step-up began.
     */
    Instant authenticationTime(JWTClaimsSet claims, String purpose, Instant attemptStarted) {
        Object value = claims.getClaim("auth_time");
        if (!(value instanceof Number n)) {
            throw failed("لم يُثبت مزود الهوية وقت المصادقة؛ رُفض الدخول.");
        }
        Instant at = Instant.ofEpochSecond(n.longValue());
        Instant now = clock.instant();
        if (at.isAfter(now.plus(CLOCK_SKEW))) {
            throw failed("وقت المصادقة في رمز الهوية لاحق للوقت الحالي؛ رُفض الدخول.");
        }
        Instant earliest = "REAUTH".equals(purpose) ? attemptStarted : now.minusSeconds(props.loginMaxAgeSeconds());
        if (at.isBefore(earliest.minus(CLOCK_SKEW))) {
            throw failed("REAUTH".equals(purpose) ? "لم تُجرَ إعادة تحقق جديدة لدى مزود الهوية." : "انقضت مدة المصادقة المسموحة؛ سجّل الدخول من جديد.");
        }
        return at;
    }

    JWTClaimsSet verify(String idToken, String nonce) {
        try {
            DefaultJWTProcessor<SecurityContext> p = new DefaultJWTProcessor<>();
            p.setJWSKeySelector(new JWSVerificationKeySelector<>(Set.of(JWSAlgorithm.RS256, JWSAlgorithm.PS256, JWSAlgorithm.ES256), keys()));
            p.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(props.clientId(),
                    new JWTClaimsSet.Builder().issuer(props.issuer()).claim("nonce", nonce).build(), Set.of("sub", "iat", "exp")));
            JWTClaimsSet claims = p.process(idToken, null);
            String azp = claims.getStringClaim("azp");
            if (claims.getAudience().size() > 1 && !props.clientId().equals(azp)) {
                throw failed("رمز الهوية صادر لتطبيق آخر.");
            }
            return claims;
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            log.warn("ID token rejected: {}", e.getMessage());
            throw failed("تعذر التحقق من رمز الهوية الصادر من المزود.");
        }
    }

    private JWKSource<SecurityContext> keys() throws java.net.MalformedURLException {
        JWKSource<SecurityContext> k = keys;
        if (k == null) {
            k = JWKSourceBuilder.create(URI.create(props.jwksEndpoint()).toURL(),
                    new DefaultResourceRetriever(props.httpTimeoutMs(), props.httpTimeoutMs(), 512 * 1024)).retrying(true).build();
            keys = k;
        }
        return k;
    }

    public String endSessionUrl(String idToken) {
        if (!props.configured()) {
            return "/";
        }
        Map<String, String> q = new LinkedHashMap<>();
        q.put("client_id", props.clientId());
        q.put("post_logout_redirect_uri", props.postLogoutRedirectUri() == null ? "/" : props.postLogoutRedirectUri());
        if (idToken != null) {
            q.put("id_token_hint", idToken);
        }
        return props.endSessionEndpoint() + "?" + form(q);
    }

    /** Only local absolute paths are accepted as return targets (no scheme, host or protocol-relative path). */
    static String safeReturn(String returnTo) {
        if (returnTo == null || !returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.contains("\\")
                || returnTo.length() > 300 || returnTo.chars().anyMatch(c -> c < 0x20)) {
            return "/";
        }
        return returnTo;
    }

    private static ApiException failed(String message) {
        return new ApiException(ErrorCode.IDENTITY_SIGN_IN_FAILED, message);
    }

    private static String random(int bytes) {
        byte[] b = new byte[bytes];
        RANDOM.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    static String challenge(String verifier) {
        try {
            return Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static String form(Map<String, String> params) {
        return params.entrySet().stream().map(e -> enc(e.getKey()) + "=" + enc(e.getValue())).collect(Collectors.joining("&"));
    }

    /** For the health of the sign-in path: the provider's key set answers over the back channel. */
    public boolean reachable() {
        if (!props.configured()) {
            return false;
        }
        try {
            HttpResponse<Void> r = http.send(HttpRequest.newBuilder(URI.create(props.jwksEndpoint()))
                    .timeout(Duration.ofMillis(Math.min(3000, props.httpTimeoutMs()))).GET().build(), HttpResponse.BodyHandlers.discarding());
            return r.statusCode() == 200;
        } catch (Exception e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        }
    }
}
