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
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
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
import com.nimbusds.jwt.SignedJWT;
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
 *
 * <p>Two independent providers (ADR-071): the automatic one ({@link Provider#ENTERPRISE}: the external enterprise realm once
 * configured) and the local platform one ({@link Provider#PLATFORM}). Each has its own endpoints, client, expected issuer and
 * audience, and its own key cache, so a token is never accepted through the other provider. The provider of an attempt is kept
 * in the namespace of its generated nonce ({@code enterprise.} / {@code platform.}): the stored attempt selects the exchange and
 * the checks, and the whole nonce is verified exactly in the signed ID token. Purposes stay LOGIN / REAUTH (no migration).
 *
 * <p>The lasting platform accounts may also sign in with the manual form through the backend-only platform-password client
 * (ADR-070, {@link #platformPassword}); never the browser client.
 */
@Component
public class OidcClient {

    private static final Logger log = LoggerFactory.getLogger(OidcClient.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Duration ATTEMPT_LIFETIME = Duration.ofMinutes(10);
    private static final Duration CLOCK_SKEW = Duration.ofSeconds(60);

    private final JdbcClient jdbc;
    private final Clock clock;
    private final IntegrationSettingsService settings;
    private final Json json;
    /** One key cache per provider: the platform verifier never sees the enterprise keys, and the reverse. */
    private final Map<Provider, JWKSource<SecurityContext>> keys = new EnumMap<>(Provider.class);
    /** The settings version the key caches were built for (ADR-092): a saved Keycloak renews them. */
    private long keysVersion = -1;

    public OidcClient(JdbcClient jdbc, Clock clock, IntegrationSettingsService settings, Json json) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.settings = settings;
        this.json = json;
    }

    /** The providers in force: the Keycloak saved in «إعدادات التكامل» as the automatic one, else the environment (ADR-092). */
    private OidcProperties props() {
        return settings.oidc();
    }

    /** The back channel's HTTP client, with the trust of the CA folder and the pasted certificates. */
    private HttpClient http() {
        return settings.http();
    }

    /** The provider an attempt or a session belongs to; its name is the namespace of the attempt's nonce. */
    public enum Provider {
        ENTERPRISE("enterprise."), PLATFORM("platform.");

        private final String namespace;

        Provider(String namespace) {
            this.namespace = namespace;
        }

        /** The provider of a stored attempt; an attempt from before the namespaces is the automatic provider's. */
        static Provider ofNonce(String nonce) {
            return nonce != null && nonce.startsWith(PLATFORM.namespace) ? PLATFORM : ENTERPRISE;
        }
    }

    private OidcProperties.Provider endpoints(Provider p) {
        return p == Provider.PLATFORM ? props().platform() : props().automatic();
    }

    /** Automatic sign-in is configured. */
    public boolean configured() {
        return props().configured();
    }

    /** The manual form can sign in a lasting platform account (the platform-password client exists and accounts are named). */
    public boolean passwordConfigured() {
        return props().passwordConfigured() && !props().platformAccounts().isEmpty();
    }

    /**
     * The provider of a TMRKZ session, from the issuer stored with it: the platform provider when it is a separate realm and
     * issued this session; otherwise the automatic one.
     */
    public Provider providerOf(String sessionIssuer) {
        return props().separateProviders() && props().platformIssuer().equals(sessionIssuer) ? Provider.PLATFORM : Provider.ENTERPRISE;
    }

    public record Started(String redirectUrl, String browserBinding) {
    }

    /**
     * {@code platformRole}: the provider states the realm role of a platform account (never true on the directory path).
     * {@code profile}: what the directory states about the person's employment (ADR-068), never null.
     */
    public record Identity(String issuer, String subject, String enterpriseKey, String displayName, String username,
                           Instant authTime, String idToken, String purpose, String returnTo, String sessionId, boolean platformRole,
                           DirectoryProfile profile) {

        public Identity {
            profile = profile == null ? DirectoryProfile.EMPTY : profile;
        }

        public Identity(String issuer, String subject, String enterpriseKey, String displayName, String username, Instant authTime,
                        String idToken, String purpose, String returnTo, String sessionId, boolean platformRole) {
            this(issuer, subject, enterpriseKey, displayName, username, authTime, idToken, purpose, returnTo, sessionId, platformRole, null);
        }

        @Override
        public String toString() {
            return "Identity[" + issuer + ", " + subject + "]"; // never the token
        }
    }

    /** The provider refused the submitted platform password (the caller counts it like a wrong directory password). */
    public static final class PasswordRejected extends Exception {
        PasswordRejected() {
            super("platform password rejected", null, false, false);
        }
    }

    /** Automatic sign-in or step-up through the automatic provider. */
    public Started start(String purpose, String returnTo, String sessionId) {
        return start(purpose, returnTo, sessionId, Provider.ENTERPRISE);
    }

    public Started start(String purpose, String returnTo, String sessionId, Provider provider) {
        OidcProperties.Provider p = endpoints(provider);
        if (!p.configured()) {
            throw new ApiException(ErrorCode.IDENTITY_PROVIDER_NOT_CONFIGURED,
                    "الدخول المؤسسي غير مهيأ في بيئة التشغيل؛ لا يوجد دخول بديل.");
        }
        String state = random(32);
        String browser = random(32);
        String verifier = random(48);
        String nonce = provider.namespace + random(24);
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
        q.put("client_id", p.clientId());
        q.put("redirect_uri", p.redirectUri());
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
            q.put("max_age", String.valueOf(props().loginMaxAgeSeconds()));
        }
        return new Started(p.authorizationEndpoint() + "?" + form(q), browser);
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
        String nonce = (String) attempt.get("nonce");
        Provider provider = Provider.ofNonce(nonce);
        OidcProperties.Provider p = endpoints(provider);
        if (!p.configured()) {
            throw failed("مزود الهوية الذي بدأت معه المحاولة لم يعد مهيأً؛ ابدأ الدخول من جديد.");
        }
        Map<String, String> body = new LinkedHashMap<>();
        body.put("grant_type", "authorization_code");
        body.put("code", code);
        body.put("redirect_uri", p.redirectUri());
        body.put("code_verifier", (String) attempt.get("code_verifier"));
        HttpResponse<String> res = post(p.tokenEndpoint(), p.clientId(), p.clientSecret(), body);
        if (res.statusCode() != 200) {
            log.warn("OIDC token exchange refused with HTTP {}", res.statusCode());
            throw failed("رفض مزود الهوية إتمام الدخول.");
        }
        String idToken = json.tree(res.body()).path("id_token").asText(null);
        if (idToken == null) {
            throw failed("لم يُرجع مزود الهوية رمز الهوية.");
        }
        JWTClaimsSet claims = verify(provider, idToken, nonce, p.clientId());
        try {
            Instant at = authenticationTime(claims, (String) attempt.get("purpose"), Db.toInstant(attempt.get("created_at")));
            return identity(claims, at, idToken, (String) attempt.get("purpose"), (String) attempt.get("return_to"),
                    (String) attempt.get("session_id"));
        } catch (java.text.ParseException e) {
            throw failed("رمز الهوية يحمل بيانات غير صالحة.");
        }
    }

    /**
     * Manual sign-in of a lasting platform account (ADR-070): the submitted login and password go only to the local provider's
     * backend-only confidential client (direct password grant). A login the installation does not name never reaches that client.
     * The returned ID token is verified with the platform provider's own keys, issuer and the dedicated client as audience; its
     * user must be the submitted login, named by the installation, and hold the provider's {@code tmrkz-platform} role.
     *
     * @throws PasswordRejected the provider refused the login and password (to be counted by the caller's throttle)
     */
    public Identity platformPassword(String login, String password) throws PasswordRejected {
        if (!passwordConfigured()) {
            throw new ApiException(ErrorCode.IDENTITY_PROVIDER_NOT_CONFIGURED, "دخول حسابات المنصة اليدوي غير مهيأ في هذه البيئة.");
        }
        String account = login == null ? null : login.trim().toLowerCase(Locale.ROOT);
        if (account == null || !props().platformAccount(account)) {
            throw failed("اسم المستخدم أو كلمة المرور غير صحيحة.");
        }
        if (password == null || password.isEmpty() || password.length() > 1024) {
            throw new PasswordRejected();
        }
        OidcProperties.Provider p = props().platform();
        Instant started = clock.instant();
        Map<String, String> body = new LinkedHashMap<>();
        body.put("grant_type", "password");
        body.put("username", account);
        body.put("password", password);
        body.put("scope", "openid profile");
        HttpResponse<String> res = post(p.tokenEndpoint(), props().passwordClientId(), props().passwordClientSecret(), body);
        if (res.statusCode() >= 500) {
            log.warn("Platform password grant: provider answered HTTP {}", res.statusCode());
            throw new ApiException(ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, "تعذر الوصول إلى مزود الهوية؛ لا يوجد دخول بديل.");
        }
        if (res.statusCode() != 200) {
            String error = json.tree(res.body()).path("error").asText("");
            if ("invalid_grant".equals(error)) {
                throw new PasswordRejected();
            }
            log.warn("Platform password grant refused with HTTP {} ({})", res.statusCode(), safeError(error));
            throw failed("رفض مزود الهوية إتمام الدخول.");
        }
        String idToken = json.tree(res.body()).path("id_token").asText(null);
        if (idToken == null) {
            throw failed("لم يُرجع مزود الهوية رمز الهوية.");
        }
        JWTClaimsSet claims = verify(Provider.PLATFORM, idToken, null, props().passwordClientId());
        try {
            String azp = claims.getStringClaim("azp");
            if (azp != null && !props().passwordClientId().equals(azp)) {
                throw failed("رمز الهوية صادر لتطبيق آخر.");
            }
            String username = claims.getStringClaim("preferred_username");
            String stated = username == null ? null : username.trim().toLowerCase(Locale.ROOT);
            if (!account.equals(stated) || !props().platformAccount(stated)) {
                log.warn("Platform password grant refused: the ID token names another user");
                throw failed("رمز الهوية لا يخص الحساب المُدخل.");
            }
            Instant at = directGrantTime(claims, started);
            Identity id = identity(claims, at, idToken, "LOGIN", "/", null);
            if (!id.platformRole()) {
                // the provider no longer states the platform role: entry refused, never an ordinary sign-in through this client
                throw new ApiException(ErrorCode.IDENTITY_NOT_LINKED, "لم يعد هذا الحساب من حسابات المنصة الدائمة.",
                        Map.of("reason", "PLATFORM_REVOKED"));
            }
            return id;
        } catch (java.text.ParseException e) {
            throw failed("رمز الهوية يحمل بيانات غير صالحة.");
        }
    }

    private Identity identity(JWTClaimsSet claims, Instant at, String idToken, String purpose, String returnTo, String sessionId)
            throws java.text.ParseException {
        String name = claims.getStringClaim("name");
        String username = claims.getStringClaim("preferred_username");
        Object key = "DOMAIN_ACCOUNT".equals(props().linkKey()) ? username : claims.getClaim(props().enterpriseKeyClaim());
        String enterpriseKey = key instanceof List<?> l ? (l.size() == 1 ? String.valueOf(l.get(0)) : null)
                : key == null ? null : String.valueOf(key).trim();
        Object roles = claims.getClaim(OidcProperties.ROLES_CLAIM);
        boolean platform = roles instanceof List<?> r ? r.contains(OidcProperties.PLATFORM_ROLE) : OidcProperties.PLATFORM_ROLE.equals(roles);
        DirectoryProfile profile = new DirectoryProfile(single(claims, props().enterpriseKeyClaim()), single(claims, props().rankClaim()),
                single(claims, props().positionClaim()), single(claims, props().unitIdClaim()), single(claims, props().unitNameClaim()),
                single(claims, props().mainUnitIdClaim()), props().employmentClaims());
        return new Identity(claims.getIssuer(), claims.getSubject(), enterpriseKey == null || enterpriseKey.isEmpty() ? null : enterpriseKey,
                name, username, at, idToken, purpose, returnTo, sessionId, platform, profile);
    }

    private HttpResponse<String> post(String endpoint, String clientId, String clientSecret, Map<String, String> body) {
        String basic = Base64.getEncoder().encodeToString((enc(clientId) + ":" + enc(clientSecret)).getBytes(StandardCharsets.UTF_8));
        try {
            return http().send(HttpRequest.newBuilder(URI.create(endpoint))
                    .timeout(Duration.ofMillis(props().httpTimeoutMs()))
                    .header("Content-Type", "application/x-www-form-urlencoded").header("Authorization", "Basic " + basic)
                    .POST(HttpRequest.BodyPublishers.ofString(form(body))).build(), HttpResponse.BodyHandlers.ofString());
        } catch (java.io.IOException e) {
            log.warn("OIDC token endpoint unreachable: {}", e.getMessage());
            throw new ApiException(ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, "تعذر الوصول إلى مزود الهوية؛ لا يوجد دخول بديل.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ApiException(ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, "انقطع الاتصال بمزود الهوية.");
        }
    }

    private static String safeError(String error) {
        return error == null ? "" : error.replaceAll("[^A-Za-z_]", "");
    }

    /** One text value of a configured claim (null name: not read); a list counts only when it holds exactly one value. */
    static String single(JWTClaimsSet claims, String name) {
        if (name == null) {
            return null;
        }
        Object v = claims.getClaim(name);
        if (v instanceof List<?> l) {
            v = l.size() == 1 ? l.get(0) : null;
        }
        return v instanceof String || v instanceof Number ? String.valueOf(v) : null;
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
        Instant earliest = "REAUTH".equals(purpose) ? attemptStarted : now.minusSeconds(props().loginMaxAgeSeconds());
        if (at.isBefore(earliest.minus(CLOCK_SKEW))) {
            throw failed("REAUTH".equals(purpose) ? "لم تُجرَ إعادة تحقق جديدة لدى مزود الهوية." : "انقضت مدة المصادقة المسموحة؛ سجّل الدخول من جديد.");
        }
        return at;
    }

    /**
     * The password verification time of the synchronous direct password grant ONLY (ADR-070). Keycloak issues this ID token only
     * after it has checked the submitted password, and omits {@code auth_time}; so the verified {@code iat} of a token issued for
     * this very attempt is that time: it must be no earlier than the attempt began and not in the future (60 s clock skew each
     * way). When the provider does state {@code auth_time}, it is mandatory and must be just as fresh. Never used for an
     * authorization-code response or a step-up, which always require {@code auth_time}.
     */
    Instant directGrantTime(JWTClaimsSet claims, Instant attemptStarted) {
        Instant now = clock.instant();
        java.util.Date iat = claims.getIssueTime();
        if (iat == null) {
            throw failed("لم يُثبت مزود الهوية وقت إصدار رمز الهوية؛ رُفض الدخول.");
        }
        Instant issued = iat.toInstant();
        Instant at = issued;
        if (claims.getClaims().containsKey("auth_time")) {
            if (!(claims.getClaim("auth_time") instanceof Number n)) {
                throw failed("وقت المصادقة في رمز الهوية غير صالح؛ رُفض الدخول.");
            }
            at = Instant.ofEpochSecond(n.longValue());
        }
        for (Instant t : List.of(issued, at)) {
            if (t.isAfter(now.plus(CLOCK_SKEW))) {
                throw failed("وقت المصادقة في رمز الهوية لاحق للوقت الحالي؛ رُفض الدخول.");
            }
            if (t.isBefore(attemptStarted.minus(CLOCK_SKEW))) {
                throw failed("رمز الهوية لم يصدر لهذه المحاولة؛ رُفض الدخول.");
            }
        }
        return at;
    }

    /**
     * The signed ID token of {@code provider}: its own keys, its issuer, {@code audience} among the audiences, expiry, and — for a
     * browser attempt — exactly this attempt's nonce.
     */
    JWTClaimsSet verify(Provider provider, String idToken, String nonce, String audience) {
        OidcProperties.Provider p = endpoints(provider);
        if (p.issuer() == null || audience == null) {
            throw failed("مزود الهوية غير مهيأ؛ رُفض الدخول.");
        }
        try {
            DefaultJWTProcessor<SecurityContext> proc = new DefaultJWTProcessor<>();
            proc.setJWSKeySelector(new JWSVerificationKeySelector<>(Set.of(JWSAlgorithm.RS256, JWSAlgorithm.PS256, JWSAlgorithm.ES256),
                    keys(provider)));
            JWTClaimsSet.Builder exact = new JWTClaimsSet.Builder().issuer(p.issuer());
            if (nonce != null) {
                exact.claim("nonce", nonce);
            }
            proc.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(audience, exact.build(), Set.of("sub", "iat", "exp")));
            JWTClaimsSet claims = proc.process(idToken, null);
            String azp = claims.getStringClaim("azp");
            if (claims.getAudience().size() > 1 && !audience.equals(azp)) {
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

    private JWKSource<SecurityContext> keys(Provider provider) throws java.net.MalformedURLException {
        synchronized (keys) {
            long v = settings.version();
            if (v != keysVersion) {
                keys.clear();
                keysVersion = v;
            }
            JWKSource<SecurityContext> k = keys.get(provider);
            if (k == null) {
                DefaultResourceRetriever retriever = new DefaultResourceRetriever(props().httpTimeoutMs(), props().httpTimeoutMs(), 512 * 1024,
                        true, settings.ssl().getSocketFactory());
                k = JWKSourceBuilder.create(URI.create(endpoints(provider).jwksEndpoint()).toURL(), retriever).retrying(true).build();
                keys.put(provider, k);
            }
            return k;
        }
    }

    /** The outcome of a test of unsaved Keycloak values (ADR-092); never a secret. */
    public record Probe(boolean ok, String step, String message, String issuer, Integer keys) {
    }

    /**
     * A test of Keycloak settings before they are saved, as MOVER's «اختبار الاتصال»: the realm's discovery document over the
     * back channel (TLS verified with the given trust), the issuer it states compared with the expected one, and the key set.
     */
    public Probe probe(OidcProperties.Provider p, javax.net.ssl.SSLContext ssl, int timeoutMs) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(timeoutMs)).followRedirects(HttpClient.Redirect.NEVER)
                .sslContext(ssl).build();
        try {
            HttpResponse<String> d = client.send(HttpRequest.newBuilder(URI.create(p.backChannel() + "/.well-known/openid-configuration"))
                    .timeout(Duration.ofMillis(timeoutMs)).GET().build(), HttpResponse.BodyHandlers.ofString());
            if (d.statusCode() != 200) {
                return new Probe(false, "DISCOVERY", "لم يُجب المجال عن وثيقة الاكتشاف (HTTP " + d.statusCode() + ").", null, null);
            }
            String stated = json.tree(d.body()).path("issuer").asText(null);
            if (stated == null) {
                return new Probe(false, "DISCOVERY", "وثيقة الاكتشاف لا تذكر المُصدر (issuer).", null, null);
            }
            if (!stated.equals(p.issuer())) {
                return new Probe(false, "ISSUER", "المُصدر الذي يعلنه Keycloak يختلف عن المتوقع: " + stated, stated, null);
            }
            HttpResponse<String> k = client.send(HttpRequest.newBuilder(URI.create(p.jwksEndpoint())).timeout(Duration.ofMillis(timeoutMs))
                    .GET().build(), HttpResponse.BodyHandlers.ofString());
            if (k.statusCode() != 200) {
                return new Probe(false, "KEYS", "لم تُقرأ مفاتيح التوقيع (HTTP " + k.statusCode() + ").", stated, null);
            }
            int n = json.tree(k.body()).path("keys").size();
            return new Probe(true, "OK", "نجح الاتصال: المُصدر مطابق و" + n + " مفتاح توقيع.", stated, n);
        } catch (javax.net.ssl.SSLException e) {
            return new Probe(false, "TLS", "رُفض الاتصال المؤمَّن: الشهادة غير موثوقة أو اسم الخادم لا يطابقها — " + e.getMessage(), null, null);
        } catch (java.io.IOException e) {
            return new Probe(false, "UNREACHABLE", "تعذر الوصول إلى Keycloak: " + e.getMessage(), null, null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Probe(false, "UNREACHABLE", "انقطع الاتصال.", null, null);
        } catch (RuntimeException e) {
            return new Probe(false, "ERROR", "إجابة غير مفهومة: " + e.getMessage(), null, null);
        }
    }

    /**
     * The end-session address of the provider that issued this session's ID token (the session's own issuer), or null when the
     * session's issuer is no configured provider: then only the TMRKZ session ends. A platform session signed in with the
     * password client logs out with that client and its token; no browser client is required for it.
     */
    public String endSessionUrl(String sessionIssuer, String idToken) {
        if (sessionIssuer == null) {
            return null;
        }
        Provider provider = providerOf(sessionIssuer);
        OidcProperties.Provider p = endpoints(provider);
        if (p.issuer() == null || !p.issuer().equals(sessionIssuer)) {
            return null;
        }
        // a platform session opened by the manual form holds the password client's token: that client ends it
        String client = props().passwordClientId() != null && sessionIssuer.equals(props().platformIssuer())
                && audience(idToken).contains(props().passwordClientId()) ? props().passwordClientId() : p.clientId();
        if (client == null) {
            return null;
        }
        Map<String, String> q = new LinkedHashMap<>();
        q.put("client_id", client);
        q.put("post_logout_redirect_uri", p.postLogoutRedirectUri() == null ? "/" : p.postLogoutRedirectUri());
        if (idToken != null) {
            q.put("id_token_hint", idToken);
        }
        return p.endSessionEndpoint() + "?" + form(q);
    }

    /** The audiences of a token this server stored after verifying it (read only to choose the logout client). */
    private static List<String> audience(String idToken) {
        if (idToken == null) {
            return List.of();
        }
        try {
            List<String> aud = SignedJWT.parse(idToken).getJWTClaimsSet().getAudience();
            return aud == null ? List.of() : aud;
        } catch (java.text.ParseException e) {
            return List.of();
        }
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

    /** For the health of the automatic sign-in path: the provider's key set answers over the back channel. */
    public boolean reachable() {
        if (!props().configured()) {
            return false;
        }
        try {
            HttpResponse<Void> r = http().send(HttpRequest.newBuilder(URI.create(props().jwksEndpoint()))
                    .timeout(Duration.ofMillis(Math.min(3000, props().httpTimeoutMs()))).GET().build(), HttpResponse.BodyHandlers.discarding());
            return r.statusCode() == 200;
        } catch (Exception e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        }
    }
}
