package ae.mover.security;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;

/**
 * «إعدادات التكامل» (ADR-092): the enterprise directory and the automatic sign-in's Keycloak, read, tested, saved and
 * cleared by whoever configures the system. A test uses the values on the screen, saved or not, and stores nothing; the
 * password typed for a test is used for that one bind and dropped.
 */
@RestController
@RequestMapping("/api/v1/settings/integration")
public class IntegrationSettingsController {

    /** The directory form plus, for a test only, a login and password to try as the manual form would. */
    public record DirectoryTest(IntegrationSettingsService.Directory settings, String testLogin, String testPassword) {

        @Override
        public String toString() {
            return "DirectoryTest[" + settings + "]";
        }
    }

    private final AccessService access;
    private final IntegrationSettingsService settings;
    private final DirectoryAuthenticator directory;
    private final ae.mover.assistant.AssistantTester assistantTester;
    private final OidcClient oidc;

    public IntegrationSettingsController(AccessService access, IntegrationSettingsService settings, DirectoryAuthenticator directory,
                                         OidcClient oidc, ae.mover.assistant.AssistantTester assistantTester) {
        this.access = access;
        this.settings = settings;
        this.directory = directory;
        this.assistantTester = assistantTester;
        this.oidc = oidc;
    }

    @GetMapping("/directory")
    public Map<String, Object> directory(Actor actor) {
        return settings.directoryView(access.context(actor));
    }

    @PutMapping("/directory")
    public Map<String, Object> saveDirectory(Actor actor, @RequestBody IntegrationSettingsService.Directory in) {
        return settings.saveDirectory(access.context(actor), in);
    }

    @DeleteMapping("/directory")
    public Map<String, Object> clearDirectory(Actor actor) {
        return settings.clearDirectory(access.context(actor));
    }

    @PostMapping("/directory/test")
    public Map<String, Object> testDirectory(Actor actor, @RequestBody DirectoryTest in) {
        AccessContext ctx = access.context(actor);
        ctx.require(Permission.CONFIGURE);
        DirectoryTest t = in == null ? new DirectoryTest(null, null, null) : in;
        LdapProperties p = settings.toLdap(t.settings(), settings.storedDirectoryPassword());
        long started = System.nanoTime();
        DirectoryAuthenticator.TestResult r = directory.test(p, t.testLogin(), t.testPassword());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", r.ok());
        out.put("step", r.step());
        out.put("message", r.message());
        out.put("dn", r.dn());
        out.put("displayName", r.displayName());
        out.put("url", p.url());
        out.put("direct", p.direct());
        out.put("elapsedMs", (System.nanoTime() - started) / 1_000_000);
        settings.audited(ctx, "INTEGRATION_DIRECTORY_TESTED", Map.of("url", p.url(), "ok", r.ok(), "step", r.step(),
                "withLogin", t.testLogin() != null && !t.testLogin().isBlank()));
        return out;
    }

    /**
     * The live state of both sections (owner, 20 Nov 2026): the directory's secured channel opened (and the service account bound
     * when there is one), Keycloak's discovery document read — with the settings in force, saved or from the environment.
     */
    @GetMapping("/status")
    public Map<String, Object> status(Actor actor) {
        AccessContext ctx = access.context(actor);
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> out = new LinkedHashMap<>();
        LdapProperties l = settings.ldap();
        Map<String, Object> d = new LinkedHashMap<>();
        if (!l.configured()) {
            d.put("state", "NOT_CONFIGURED");
            d.put("message", "لم يُهيأ الدليل المؤسسي بعد.");
        } else {
            DirectoryAuthenticator.TestResult r = directory.test(l, null, null);
            d.put("state", r.ok() ? "UP" : "DOWN");
            d.put("message", r.message());
            d.put("url", l.url());
        }
        out.put("directory", d);
        OidcProperties.Provider p = settings.oidc().automatic();
        Map<String, Object> k = new LinkedHashMap<>();
        if (!p.configured()) {
            k.put("state", "NOT_CONFIGURED");
            k.put("message", "لم يُهيأ الدخول الآلي بعد.");
        } else {
            OidcClient.Probe r = oidc.probe(p, settings.ssl(), 4000);
            k.put("state", r.ok() ? "UP" : "DOWN");
            k.put("message", r.message());
            k.put("issuer", p.issuer());
        }
        out.put("oidc", k);
        out.put("checkedAt", java.time.Instant.now().toString());
        return out;
    }

    @GetMapping("/oidc")
    public Map<String, Object> oidc(Actor actor) {
        return settings.oidcView(access.context(actor));
    }

    @PutMapping("/oidc")
    public Map<String, Object> saveOidc(Actor actor, @RequestBody IntegrationSettingsService.Oidc in) {
        return settings.saveOidc(access.context(actor), in);
    }

    @DeleteMapping("/oidc")
    public Map<String, Object> clearOidc(Actor actor) {
        return settings.clearOidc(access.context(actor));
    }

    @PostMapping("/oidc/test")
    public Map<String, Object> testOidc(Actor actor, @RequestBody IntegrationSettingsService.Oidc in) {
        AccessContext ctx = access.context(actor);
        ctx.require(Permission.CONFIGURE);
        OidcProperties props = settings.toOidc(in, settings.storedClientSecret());
        OidcProperties.Provider p = props.automatic();
        long started = System.nanoTime();
        OidcClient.Probe r = oidc.probe(p, settings.sslFor(in == null ? null : in.caCertificatesPem()), Math.min(8000, props.httpTimeoutMs()));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", r.ok());
        out.put("step", r.step());
        out.put("message", r.message());
        out.put("issuer", p.issuer());
        out.put("statedIssuer", r.issuer());
        out.put("keys", r.keys());
        out.put("redirectUri", p.redirectUri());
        out.put("elapsedMs", (System.nanoTime() - started) / 1_000_000);
        settings.audited(ctx, "INTEGRATION_OIDC_TESTED", Map.of("issuer", p.issuer(), "ok", r.ok(), "step", r.step()));
        return out;
    }

    // ---- the assistant (ADR-056) ----------------------------------------------------------------------------------

    @GetMapping("/assistant")
    public Map<String, Object> assistant(Actor actor) {
        return settings.assistantView(access.context(actor));
    }

    @PutMapping("/assistant")
    public Map<String, Object> saveAssistant(Actor actor, @RequestBody IntegrationSettingsService.Assistant in) {
        return settings.saveAssistant(access.context(actor), in);
    }

    @DeleteMapping("/assistant")
    public Map<String, Object> clearAssistant(Actor actor) {
        return settings.clearAssistant(access.context(actor));
    }

    @PostMapping("/assistant/test")
    public Map<String, Object> testAssistant(Actor actor, @RequestBody IntegrationSettingsService.Assistant in) {
        AccessContext ctx = access.context(actor);
        ctx.require(Permission.CONFIGURE);
        return assistantTester.test(in == null ? settings.assistant() : merge(in));
    }

    /** Fills a blank API key with the stored one so the screen can test what it just saved. */
    private IntegrationSettingsService.Assistant merge(IntegrationSettingsService.Assistant in) {
        String key = in.apiKey();
        if (key == null) {
            key = settings.storedAssistantKey();
        }
        return new IntegrationSettingsService.Assistant(in.enabled(), in.baseUrl(), in.model(), key,
                in.timeoutSeconds() == null ? 60 : in.timeoutSeconds());
    }
}
