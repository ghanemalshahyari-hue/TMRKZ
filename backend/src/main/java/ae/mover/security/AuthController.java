package ae.mover.security;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.time.Instant;
import java.util.UUID;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Grant;
import ae.mover.common.ApiException;
import ae.mover.common.ErrorCode;
import ae.mover.common.Ref;
import ae.mover.policy.PolicyService;
import jakarta.servlet.http.HttpServletRequest;

/**
 * Enterprise sign-in only (ADR-015): the browser is sent to the identity provider and comes back to the callback,
 * which links the identity and opens a server-side session. There is no local password form, demo switch or any other
 * fallback; when the provider is not configured or unreachable the sign-in page says so.
 */
@RestController
@RequestMapping("/api/v1")
public class AuthController {

    static final String OIDC_COOKIE = "TMRKZ_OIDC";
    private static final String OIDC_PATH = "/api/v1/auth/oidc";

    private final AuthService auth;
    private final OidcClient oidc;
    private final DirectoryAuthenticator directory;
    private final LoginThrottle throttle;
    private final OidcProperties oidcProps;
    private final IdentityService identities;
    private final AccessService access;
    private final JdbcClient jdbc;
    private final SecurityProperties props;
    private final PolicyService policies;
    private final Clock clock;

    public AuthController(AuthService auth, OidcClient oidc, DirectoryAuthenticator directory, LoginThrottle throttle,
                          OidcProperties oidcProps, IdentityService identities, AccessService access, JdbcClient jdbc,
                          SecurityProperties props, PolicyService policies, Clock clock) {
        this.auth = auth;
        this.oidc = oidc;
        this.directory = directory;
        this.throttle = throttle;
        this.oidcProps = oidcProps;
        this.identities = identities;
        this.access = access;
        this.jdbc = jdbc;
        this.props = props;
        this.policies = policies;
        this.clock = clock;
    }

    /**
     * Public: the two sign-in paths, as in TNQL — automatic through the identity provider (Keycloak) and manual with the
     * directory username and password — and whether each is configured (and the provider answers).
     */
    @GetMapping("/auth/status")
    public Map<String, Object> status() {
        boolean configured = oidc.configured();
        return Map.of("provider", "OIDC", "configured", configured, "reachable", configured && oidc.reachable(),
                "manual", directory.configured());
    }

    public record DirectoryLogin(String username, String password) {

        @Override
        public String toString() {
            return "DirectoryLogin[" + username + "]"; // never the password
        }
    }

    /** Manual sign-in: the directory verifies the password (LDAP bind over TLS); TMRKZ links and opens a session. */
    @PostMapping("/auth/directory/login")
    public ResponseEntity<Map<String, Object>> directoryLogin(@RequestBody(required = false) DirectoryLogin in, HttpServletRequest request) {
        String username = in == null ? null : in.username();
        String ip = request.getRemoteAddr();
        throttle.check(username, ip);
        DirectoryAuthenticator.DirectoryUser user;
        try {
            user = directory.authenticate(username, in == null ? null : in.password());
        } catch (DirectoryAuthenticator.DirectoryException e) {
            if (e.failure() == DirectoryAuthenticator.Failure.INVALID_CREDENTIALS) {
                throttle.failed(username, ip);
            }
            throw directoryError(e);
        }
        Instant now = clock.instant();
        OidcClient.Identity id = new OidcClient.Identity(directory.issuer(), user.uuid(),
                "EMPLOYEE_NUMBER".equals(oidcProps.linkKey()) ? user.employeeNumber() : user.username(),
                user.displayName(), user.username(), now, null, "LOGIN", "/", null);
        UUID person = identities.resolve(id);
        throttle.succeeded(username);
        AuthService.LoginResult r = auth.issueSession(person, directory.issuer(), null, now, ip, request.getHeader("User-Agent"));
        ResponseCookie session = ResponseCookie.from(SessionFilter.COOKIE, r.token()).httpOnly(true)
                .secure(props.secureCookie()).sameSite("Strict").path("/").maxAge(auth.sessionLifetime()).build();
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, session.toString()).body(me(r.actor()));
    }

    public record PasswordInput(String password) {

        @Override
        public String toString() {
            return "PasswordInput[***]";
        }
    }

    /** Step-up for a session opened with the directory password: the same password, verified again by the directory. */
    @PostMapping("/auth/directory/reauth")
    public ResponseEntity<Void> directoryReauth(Actor actor, @RequestBody(required = false) PasswordInput in) {
        String subject = jdbc.sql("select subject from identity_link where person_id = :p and issuer = :i")
                .param("p", actor.personId()).param("i", directory.issuer()).query(String.class).optional()
                .orElseThrow(() -> new ApiException(ErrorCode.REAUTHENTICATION_FAILED, "حسابك غير مربوط بالدليل المؤسسي."));
        throttle.check("id:" + subject, null);
        try {
            directory.reauthenticate(subject, in == null ? null : in.password());
        } catch (DirectoryAuthenticator.DirectoryException e) {
            if (e.failure() == DirectoryAuthenticator.Failure.INVALID_CREDENTIALS) {
                throttle.failed("id:" + subject, null);
                throw new ApiException(ErrorCode.REAUTHENTICATION_FAILED, "كلمة المرور غير صحيحة؛ لم يُسجل أي قرار.");
            }
            throw directoryError(e);
        }
        throttle.succeeded("id:" + subject);
        auth.markReauthenticated(actor.sessionId(), actor.personId(), clock.instant(), null);
        return ResponseEntity.noContent().build();
    }

    private static ApiException directoryError(DirectoryAuthenticator.DirectoryException e) {
        return switch (e.failure()) {
            case INVALID_CREDENTIALS -> new ApiException(ErrorCode.IDENTITY_SIGN_IN_FAILED, "اسم المستخدم أو كلمة المرور غير صحيحة.");
            case AMBIGUOUS -> new ApiException(ErrorCode.IDENTITY_NOT_LINKED,
                    "اسم المستخدم يطابق أكثر من حساب في الدليل؛ أُحيل الأمر إلى مسؤول الصلاحيات.", Map.of("reason", "AMBIGUOUS"));
            case TLS -> new ApiException(ErrorCode.DIRECTORY_TLS_FAILED,
                    "تعذر تأمين الاتصال بالدليل المؤسسي؛ لم تُرسل بيانات الدخول. أبلغ الدعم الفني.");
            case NOT_CONFIGURED -> new ApiException(ErrorCode.IDENTITY_PROVIDER_NOT_CONFIGURED, "الدخول اليدوي غير مهيأ في هذه البيئة.");
            case UNAVAILABLE -> new ApiException(ErrorCode.DIRECTORY_UNAVAILABLE, "الدليل المؤسسي غير متاح الآن؛ حاول لاحقاً.");
        };
    }

    @GetMapping("/auth/oidc/start")
    public ResponseEntity<Void> start(@RequestParam(name = "return", required = false) String returnTo) {
        try {
            OidcClient.Started s = oidc.start("LOGIN", returnTo, null);
            return redirect(s.redirectUrl(), browserCookie(s.browserBinding(), 600));
        } catch (ApiException e) {
            return redirect(errorTarget(e), null);
        }
    }

    public record ReauthInput(String returnTo) {
    }

    /** Step-up before a sensitive action: the provider asks for the credentials again (prompt=login, max_age=0). */
    @PostMapping("/auth/reauth")
    public ResponseEntity<Map<String, Object>> reauth(Actor actor, @RequestBody(required = false) ReauthInput in) {
        OidcClient.Started s = oidc.start("REAUTH", in == null ? "/" : in.returnTo(), actor.sessionId());
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, browserCookie(s.browserBinding(), 600).toString())
                .body(Map.of("redirect", s.redirectUrl()));
    }

    @GetMapping("/auth/oidc/callback")
    public ResponseEntity<Void> callback(@RequestParam(required = false) String code, @RequestParam(required = false) String state,
                                         @RequestParam(required = false) String error,
                                         @CookieValue(name = OIDC_COOKIE, required = false) String browser,
                                         HttpServletRequest request) {
        ResponseCookie clear = browserCookie("", 0);
        if (error != null) {
            return redirect("/#auth-error=PROVIDER_" + safeCode(error), clear);
        }
        try {
            OidcClient.Identity id = oidc.complete(code, state, browser);
            UUID person = identities.resolve(id);
            if ("REAUTH".equals(id.purpose())) {
                auth.markReauthenticated(id.sessionId(), person, id.authTime(), id.idToken());
                return redirect(id.returnTo() + (id.returnTo().contains("#") ? "" : "#reauthenticated"), clear);
            }
            AuthService.LoginResult r = auth.issueSession(person, id.issuer(), id.idToken(), id.authTime(),
                    request.getRemoteAddr(), request.getHeader("User-Agent"));
            ResponseCookie session = ResponseCookie.from(SessionFilter.COOKIE, r.token()).httpOnly(true)
                    .secure(props.secureCookie()).sameSite("Strict").path("/").maxAge(auth.sessionLifetime()).build();
            return ResponseEntity.status(HttpStatus.FOUND).header(HttpHeaders.LOCATION, id.returnTo())
                    .header(HttpHeaders.SET_COOKIE, session.toString()).header(HttpHeaders.SET_COOKIE, clear.toString()).build();
        } catch (ApiException e) {
            return redirect(errorTarget(e), clear);
        }
    }

    @PostMapping("/auth/logout")
    public ResponseEntity<Map<String, Object>> logout(Actor actor) {
        AuthService.Ended ended = auth.logout(actor);
        ResponseCookie cookie = ResponseCookie.from(SessionFilter.COOKIE, "").httpOnly(true).secure(props.secureCookie())
                .sameSite("Strict").path("/").maxAge(0).build();
        // A provider session is ended at the provider, which returns to the sign-in page; a directory session returns directly.
        String redirect = ended.idToken() != null && !directory.issuer().equals(ended.issuer())
                ? oidc.endSessionUrl(ended.idToken()) : SIGNED_OUT;
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, cookie.toString()).body(Map.of("redirect", redirect));
    }

    static final String SIGNED_OUT = "/?signed-out=1";

    // ---- identities waiting for an access manager ---------------------------------------------------------------

    @GetMapping("/identity-issues")
    public List<Map<String, Object>> identityIssues(Actor actor) {
        return identities.issues(access.context(actor));
    }

    @PostMapping("/identity-issues/{id}/resolve")
    public ResponseEntity<Void> resolveIdentityIssue(Actor actor, @PathVariable UUID id, @RequestBody IdentityService.ResolveInput in) {
        identities.resolveIssue(access.context(actor), id, in);
        return ResponseEntity.noContent().build();
    }

    // ---- current person -------------------------------------------------------------------------------------------

    @GetMapping("/me")
    public Map<String, Object> me(Actor actor) {
        AccessContext ctx = access.context(actor);
        Map<String, Object> me = new LinkedHashMap<>();
        Map<String, Object> person = jdbc.sql("select employee_no from person where id = :id").param("id", actor.personId())
                .query().singleRow();
        me.put("id", actor.personId().toString());
        me.put("username", actor.username());
        me.put("displayName", actor.displayName());
        me.put("employeeNo", person.get("employee_no"));
        me.put("initials", initials(actor.displayName()));
        Grant primary = ctx.primaryGrant().orElse(null);
        me.put("primaryRole", primary == null ? null : Map.of("code", primary.roleCode(), "name", primary.roleName()));
        me.put("primaryOrg", primary == null ? null : Ref.of(primary.orgId(), primary.orgName()));
        me.put("permissions", ctx.permissions());
        me.put("summaryOnly", ctx.summaryOnly());
        me.put("grants", grants(ctx));
        me.put("signInMethod", directory.issuer().equals(auth.issuer(actor.sessionId()).orElse(null)) ? "DIRECTORY" : "PROVIDER");
        me.put("serverTime", clock.instant().toString());
        me.put("timezone", policies.settings().timezone());
        return me;
    }

    @GetMapping("/me/capabilities")
    public Map<String, Object> capabilities(Actor actor) {
        AccessContext ctx = access.context(actor);
        return Map.of("permissions", ctx.permissions(), "grants", grants(ctx));
    }

    private static List<Map<String, Object>> grants(AccessContext ctx) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Grant g : ctx.grants()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("roleCode", g.roleCode());
            m.put("roleName", g.roleName());
            m.put("permissions", g.permissions());
            m.put("scope", g.scope());
            m.put("summaryOnly", g.summaryOnly());
            m.put("organization", Ref.of(g.orgId(), g.orgName()));
            m.put("site", Ref.of(g.siteId(), g.siteName()));
            m.put("validTo", g.validTo() == null ? null : g.validTo().toString());
            m.put("viaDelegation", g.delegationId() == null ? null : Map.of("id", g.delegationId().toString(),
                    "delegatorName", g.delegatorName(), "validTo", String.valueOf(g.validTo())));
            out.add(m);
        }
        return out;
    }

    // ---- helpers --------------------------------------------------------------------------------------------------

    private ResponseCookie browserCookie(String value, long maxAge) {
        // Lax: the provider sends the browser back with a top-level navigation that may cross sites.
        return ResponseCookie.from(OIDC_COOKIE, value).httpOnly(true).secure(props.secureCookie()).sameSite("Lax")
                .path(OIDC_PATH).maxAge(maxAge).build();
    }

    private static ResponseEntity<Void> redirect(String location, ResponseCookie cookie) {
        ResponseEntity.BodyBuilder b = ResponseEntity.status(HttpStatus.FOUND).header(HttpHeaders.LOCATION, location);
        if (cookie != null) {
            b.header(HttpHeaders.SET_COOKIE, cookie.toString());
        }
        return b.build();
    }

    private static String errorTarget(ApiException e) {
        Object reason = e.details() == null ? null : e.details().get("reason");
        return "/#auth-error=" + e.code().name() + (reason == null ? "" : "&reason=" + URLEncoder.encode(String.valueOf(reason), StandardCharsets.UTF_8));
    }

    private static String safeCode(String error) {
        return error.replaceAll("[^A-Za-z_]", "").toUpperCase(java.util.Locale.ROOT);
    }

    static String initials(String name) {
        if (name == null || name.isBlank()) {
            return "؟";
        }
        String[] parts = name.trim().split("\\s+");
        return parts.length == 1 ? parts[0].substring(0, 1) : parts[0].substring(0, 1) + " " + parts[1].substring(0, 1);
    }
}
