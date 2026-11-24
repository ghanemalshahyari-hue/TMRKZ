package ae.mover.security;

import java.net.URI;
import java.net.http.HttpClient;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.hr.HrSettingsCipher;

/**
 * «إعدادات التكامل» (owner, 20 Nov 2026; ADR-092), as MOVER's integration settings page: the enterprise directory of the
 * manual sign-in and the Keycloak of the automatic button, entered by whoever configures the system, kept in the database
 * (secrets encrypted with TMRKZ's own key) and applied at once — no restart, no edit of {@code .env}. Nothing saved, or a
 * saved section switched off: the {@code .env} values apply as before, so an installation that was configured through
 * {@code .env} keeps working. The platform accounts' local Keycloak and the HR source are not here.
 *
 * <p>The directory is described as MOVER describes it — server, port, LDAPS or StartTLS, the sign-in domain (each person
 * binds as {@code user@domain}), the search base, the CA certificate — and turned into TMRKZ's {@link LdapProperties}
 * (a direct-bind pattern {@code {username}@domain}; or, with no domain, a read-only service account that finds the entry
 * first). Keycloak is described as MOVER describes it — server address, realm, client, secret, internal address, issuer,
 * return address, CA — and turned into the automatic provider of {@link OidcProperties}.
 */
@Service
public class IntegrationSettingsService {

    private static final Logger log = LoggerFactory.getLogger(IntegrationSettingsService.class);
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$");
    private static final Pattern DOMAIN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$");
    private static final Pattern REALM = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$");
    private static final Set<String> MODES = Set.of("ldaps", "starttls");

    /** The directory section as the screen shows it; {@code bindPassword} is write-only (null keeps the stored one). */
    public record Directory(Boolean enabled, String server, Integer port, String securityMode, String domain, String baseDn,
                            String bindDn, String bindPassword, String usernameAttribute, String uuidAttribute,
                            String employeeNumberAttribute, String userObjectClass, String rankAttribute, String positionAttribute,
                            String unitIdAttribute, String unitNameAttribute, String mainUnitIdAttribute, String caCertificatesPem,
                            Integer timeoutSeconds) {

        @Override
        public String toString() {
            return "Directory[" + server + ":" + port + " " + securityMode + "]"; // never the password
        }
    }

    /** The Keycloak section as the screen shows it; {@code clientSecret} is write-only (null keeps the stored one). */
    public record Oidc(Boolean enabled, String serverUrl, String realm, String clientId, String clientSecret, String internalUrl,
                       String issuer, String redirectUri, String caCertificatesPem) {

        @Override
        public String toString() {
            return "Oidc[" + serverUrl + " " + realm + " " + clientId + "]"; // never the secret
        }
    }

    /**
     * «المساعد الذكي» (ADR-056, owner 20 Nov 2026): the OpenAI-compatible server the assistant asks, replacing the
     * {@code TMRKZ_AI_*} environment values without a restart. {@code apiKey} is write-only (null keeps the stored one);
     * the saved {@code enabled} wins over the environment.
     */
    public record Assistant(Boolean enabled, String baseUrl, String model, String apiKey, Integer timeoutSeconds) {

        @Override
        public String toString() {
            return "Assistant[" + baseUrl + " " + model + "]"; // never the api key
        }
    }

    private record Stored<T>(T form, String secret, UUID updatedBy, java.time.Instant updatedAt, String secretError) {
    }

    private record Effective(long version, LdapProperties ldap, OidcProperties oidc, SSLContext ssl, HttpClient http) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final HrSettingsCipher cipher;
    private final LdapProperties envLdap;
    private final OidcProperties envOidc;
    private final AssistantEnv envAssistant;
    private final AtomicLong version = new AtomicLong(1);
    private volatile Effective effective;

    public IntegrationSettingsService(JdbcClient jdbc, Json json, Clock clock, AuditService audit, HrSettingsCipher cipher,
                                      LdapProperties envLdap, OidcProperties envOidc, AssistantEnv envAssistant) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.cipher = cipher;
        this.envLdap = envLdap;
        this.envOidc = envOidc;
        this.envAssistant = envAssistant;
    }

    /**
     * The {@code TMRKZ_AI_*} environment values, read once at startup; the saved assistant settings sit in front of them
     * (owner, 20 Nov 2026). Defined as a bean so tests can rebind it; the default reads the usual property names.
     */
    @org.springframework.stereotype.Component
    public static class AssistantEnv {
        private final boolean enabled;
        private final String baseUrl;
        private final String model;
        private final String apiKey;
        private final int timeoutSeconds;

        public AssistantEnv(@Value("${TMRKZ_AI_ENABLED:false}") boolean enabled,
                            @Value("${TMRKZ_AI_BASE_URL:http://host.docker.internal:11434/v1}") String baseUrl,
                            @Value("${TMRKZ_AI_MODEL:qwen2.5:7b}") String model,
                            @Value("${TMRKZ_AI_API_KEY:}") String apiKey,
                            @Value("${TMRKZ_AI_TIMEOUT_SECONDS:60}") int timeoutSeconds) {
            this.enabled = enabled;
            this.baseUrl = baseUrl == null ? null : (baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl);
            this.model = model;
            this.apiKey = apiKey == null || apiKey.isBlank() ? null : apiKey;
            this.timeoutSeconds = Math.max(5, Math.min(300, timeoutSeconds));
        }

        public boolean enabled() { return enabled; }
        public String baseUrl() { return baseUrl; }
        public String model() { return model; }
        public String apiKey() { return apiKey; }
        public int timeoutSeconds() { return timeoutSeconds; }
    }

    // ---- what the application uses -------------------------------------------------------------------------------

    /** The directory of the manual sign-in: the saved and enabled section, else the environment. */
    public LdapProperties ldap() {
        return current().ldap();
    }

    /** The providers of the automatic sign-in and the platform accounts: the saved and enabled Keycloak, else the environment. */
    public OidcProperties oidc() {
        return current().oidc();
    }

    /** The HTTP client of the Keycloak back channel, trusting the runtime's CAs, the CA folder and the pasted certificates. */
    public HttpClient http() {
        return current().http();
    }

    public SSLContext ssl() {
        return current().ssl();
    }

    /** Changes with every save: a cache keyed on it is renewed. */
    public long version() {
        return version.get();
    }

    private Effective current() {
        Effective e = effective;
        long v = version.get();
        if (e == null || e.version() != v) {
            synchronized (this) {
                e = effective;
                if (e == null || e.version() != v) {
                    e = build(v);
                    effective = e;
                }
            }
        }
        return e;
    }

    private Effective build(long v) {
        LdapProperties ldap = envLdap;
        OidcProperties oidc = envOidc;
        String pem = null;
        try {
            Stored<Directory> d = stored("DIRECTORY", Directory.class);
            if (d != null && Boolean.TRUE.equals(d.form().enabled())) {
                ldap = toLdap(d.form(), d.secret());
            }
        } catch (RuntimeException e) {
            log.warn("Saved directory settings not applied; the environment's apply: {}", e.getMessage());
        }
        try {
            Stored<Oidc> o = stored("OIDC", Oidc.class);
            if (o != null && Boolean.TRUE.equals(o.form().enabled())) {
                oidc = toOidc(o.form(), o.secret());
                pem = o.form().caCertificatesPem();
            }
        } catch (RuntimeException e) {
            log.warn("Saved Keycloak settings not applied; the environment's apply: {}", e.getMessage());
        }
        SSLContext ssl;
        try {
            ssl = Trust.withDefaults(Path.of(envLdap.caDir()), pem);
        } catch (Exception e) {
            log.warn("Keycloak trust could not include the CA folder or the pasted certificates: {}", e.getMessage());
            try {
                ssl = SSLContext.getDefault();
            } catch (java.security.NoSuchAlgorithmException x) {
                throw new IllegalStateException(x);
            }
        }
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(oidc.httpTimeoutMs()))
                .followRedirects(HttpClient.Redirect.NEVER).sslContext(ssl).build();
        return new Effective(v, ldap, oidc, ssl, http);
    }

    /**
     * Renewed at once — so the saving transaction's own view shows what it wrote — and again after the commit, so a build
     * another thread made in between from the committed state is replaced.
     */
    private void renew() {
        version.incrementAndGet();
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    version.incrementAndGet();
                }
            });
        }
    }

    // ---- storage ---------------------------------------------------------------------------------------------------

    private <T> Stored<T> stored(String kind, Class<T> type) {
        Map<String, Object> row = jdbc.sql("select settings::text as s, secret_ciphertext, secret_key_id, updated_by, updated_at from integration_setting where kind = :k")
                .param("k", kind).query().listOfRows().stream().findFirst().orElse(null);
        if (row == null) {
            return null;
        }
        T form = json.read((String) row.get("s"), type);
        String secret = null;
        String error = null;
        if (row.get("secret_ciphertext") != null) {
            try {
                secret = cipher.decrypt((String) row.get("secret_ciphertext"), (String) row.get("secret_key_id"));
            } catch (ApiException e) {
                error = e.getMessage();
            }
        }
        Object by = row.get("updated_by");
        Object at = row.get("updated_at");
        return new Stored<>(form, secret, by == null ? null : UUID.fromString(by.toString()),
                at instanceof java.sql.Timestamp t ? t.toInstant() : at instanceof java.time.OffsetDateTime o ? o.toInstant() : null, error);
    }

    private void write(String kind, Object form, String secret, UUID by) {
        String cipherText = secret == null ? null : cipher.encrypt(secret);
        jdbc.sql("""
                insert into integration_setting(kind, settings, secret_ciphertext, secret_key_id, updated_by, updated_at)
                values (:k, cast(:s as jsonb), :c, :kid, :by, :now)
                on conflict (kind) do update set settings = excluded.settings, secret_ciphertext = excluded.secret_ciphertext,
                  secret_key_id = excluded.secret_key_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at""")
                .param("k", kind).param("s", json.write(form)).param("c", cipherText)
                .param("kid", cipherText == null ? null : cipher.keyId()).param("by", by).param("now", Db.ts(clock.instant())).update();
        renew();
    }

    // ---- the directory ---------------------------------------------------------------------------------------------

    /** The directory section for the screen: what is saved (no secret), what {@code .env} holds, and what is in force. */
    public Map<String, Object> directoryView(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Stored<Directory> d = null;
        String error = null;
        try {
            d = stored("DIRECTORY", Directory.class);
        } catch (RuntimeException e) {
            error = "تعذرت قراءة الإعدادات المحفوظة: " + e.getMessage();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("keyConfigured", cipher.configured());
        out.put("source", d != null && Boolean.TRUE.equals(d.form().enabled()) ? "SAVED" : envLdap.configured() ? "ENV" : "NONE");
        out.put("saved", d == null ? null : withoutSecret(d.form(), d.secret() != null));
        if (d != null) {
            out.put("updatedAt", d.updatedAt() == null ? null : d.updatedAt().toString());
            out.put("updatedBy", d.updatedBy() == null ? null : d.updatedBy().toString());
            if (d.secretError() != null) {
                out.put("secretError", d.secretError());
            }
        }
        if (error != null) {
            out.put("error", error);
        }
        out.put("env", envDirectory());
        LdapProperties l = ldap();
        Map<String, Object> eff = new LinkedHashMap<>();
        eff.put("configured", l.configured());
        eff.put("url", l.url());
        eff.put("direct", l.direct());
        eff.put("domain", l.upnSuffix());
        eff.put("usersDn", l.usersDn());
        eff.put("caDir", l.caDir());
        out.put("effective", eff);
        return out;
    }

    /** MOVER's shape of the environment's directory, for the screen's «from .env» column. */
    private Map<String, Object> envDirectory() {
        Map<String, Object> m = new LinkedHashMap<>();
        if (envLdap.url() == null) {
            return m;
        }
        URI u = URI.create(envLdap.url());
        boolean ldaps = "ldaps".equalsIgnoreCase(u.getScheme());
        m.put("server", u.getHost());
        m.put("port", u.getPort() > 0 ? u.getPort() : ldaps ? 636 : 389);
        m.put("securityMode", ldaps ? "ldaps" : "starttls");
        String p = envLdap.directBindPattern();
        m.put("domain", p != null && p.startsWith(LdapProperties.USERNAME_MARKER + "@") ? p.substring(LdapProperties.USERNAME_MARKER.length() + 1) : null);
        m.put("directBindPattern", p);
        m.put("baseDn", envLdap.usersDn());
        m.put("bindDn", envLdap.bindDn());
        m.put("bindPasswordSet", envLdap.bindCredential() != null);
        m.put("usernameAttribute", envLdap.usernameAttribute());
        m.put("uuidAttribute", envLdap.uuidAttribute());
        m.put("employeeNumberAttribute", envLdap.employeeNumberAttribute());
        m.put("userObjectClass", envLdap.userObjectClass());
        m.put("rankAttribute", envLdap.rankAttribute());
        m.put("positionAttribute", envLdap.positionAttribute());
        m.put("unitIdAttribute", envLdap.unitIdAttribute());
        m.put("unitNameAttribute", envLdap.unitNameAttribute());
        m.put("mainUnitIdAttribute", envLdap.mainUnitIdAttribute());
        m.put("caDir", envLdap.caDir());
        m.put("configured", envLdap.configured());
        return m;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> asMap(Object form) {
        return json.read(json.write(form), LinkedHashMap.class);
    }

    private Map<String, Object> withoutSecret(Directory d, boolean passwordSet) {
        Map<String, Object> m = asMap(d);
        m.remove("bindPassword");
        m.put("bindPasswordSet", passwordSet);
        return m;
    }

    /** The complete directory the form describes, with the stored password when the form leaves it blank; validated. */
    public LdapProperties toLdap(Directory in, String storedPassword) {
        Directory d = normalise(in);
        String password = d.bindPassword() != null ? d.bindPassword() : storedPassword;
        if (d.server() == null) {
            throw ApiException.validation("اكتب اسم خادم الدليل (الاسم الذي صدرت له الشهادة).");
        }
        if (!HOST.matcher(d.server()).matches()) {
            throw ApiException.validation("اسم الخادم ليس اسم مضيف صالحاً.");
        }
        if (!MODES.contains(d.securityMode())) {
            throw ApiException.validation("وضع التأمين إما LDAPS أو StartTLS.");
        }
        if (d.port() < 1 || d.port() > 65535) {
            throw ApiException.validation("المنفذ بين 1 و65535.");
        }
        if (d.baseDn() == null) {
            throw ApiException.validation("اكتب قاعدة البحث (Base DN)، مثل DC=example,DC=local.");
        }
        if (d.domain() != null && !DOMAIN.matcher(d.domain()).matches()) {
            throw ApiException.validation("نطاق الدخول ليس اسم نطاق صالحاً.");
        }
        // ADR-100: no service account is required; without a domain, each person binds as {username}@<the DC= parts of the base DN>
        if (d.domain() == null && d.bindDn() != null && password == null) {
            throw ApiException.validation("اكتب كلمة مرور حساب الخدمة، أو امسح اسمه ليدخل كل شخص بحسابه.");
        }
        if (d.domain() == null && d.bindDn() == null && LdapProperties.domainOf(d.baseDn()) == null) {
            throw ApiException.validation("اكتب نطاق الدخول (مثل corp.example): قاعدة البحث لا تحوي DC=… يُستنتج منها.");
        }
        if (d.timeoutSeconds() < 1 || d.timeoutSeconds() > 120) {
            throw ApiException.validation("المهلة بين 1 و120 ثانية.");
        }
        try {
            Trust.parse(d.caCertificatesPem());
        } catch (IllegalArgumentException e) {
            throw ApiException.validation("شهادة الجهة المصدرة: " + e.getMessage());
        }
        boolean ldaps = "ldaps".equals(d.securityMode());
        String url = (ldaps ? "ldaps://" : "ldap://") + d.server().toLowerCase(Locale.ROOT) + ":" + d.port();
        try {
            return new LdapProperties(url, !ldaps, d.bindDn(), password, d.baseDn(), d.usernameAttribute(), d.uuidAttribute(),
                    d.employeeNumberAttribute(), d.userObjectClass(), envLdap.caDir(), envLdap.issuer(), d.timeoutSeconds() * 1000,
                    d.timeoutSeconds() * 1000, envLdap.maxFailures(), envLdap.lockMinutes(), d.unitIdAttribute(), d.unitNameAttribute(),
                    d.mainUnitIdAttribute(), d.rankAttribute(), d.positionAttribute(), null, d.caCertificatesPem(),
                    d.domain());
        } catch (IllegalArgumentException e) {
            throw ApiException.validation("أسماء السمات: " + e.getMessage());
        }
    }

    private static Directory normalise(Directory in) {
        if (in == null) {
            throw ApiException.validation("لا إعدادات.");
        }
        String mode = text(in.securityMode()) == null ? "ldaps" : in.securityMode().trim().toLowerCase(Locale.ROOT);
        int port = in.port() == null ? ("ldaps".equals(mode) ? 636 : 389) : in.port();
        return new Directory(in.enabled() == null ? Boolean.TRUE : in.enabled(), text(in.server()), port, mode, text(in.domain()),
                text(in.baseDn()), text(in.bindDn()), in.bindPassword() == null || in.bindPassword().isEmpty() ? null : in.bindPassword(),
                text(in.usernameAttribute()), text(in.uuidAttribute()), text(in.employeeNumberAttribute()), text(in.userObjectClass()),
                text(in.rankAttribute()), text(in.positionAttribute()), text(in.unitIdAttribute()), text(in.unitNameAttribute()),
                text(in.mainUnitIdAttribute()), text(in.caCertificatesPem()), in.timeoutSeconds() == null ? 10 : in.timeoutSeconds());
    }

    /** The stored directory password, for a test or a save that leaves the password field blank. */
    public String storedDirectoryPassword() {
        Stored<Directory> d = stored("DIRECTORY", Directory.class);
        return d == null ? null : d.secret();
    }

    @Transactional
    public Map<String, Object> saveDirectory(AccessContext ctx, Directory in) {
        ctx.require(Permission.CONFIGURE);
        Directory d = normalise(in);
        String stored = storedDirectoryPassword();
        toLdap(d, stored); // validated as a whole; the password kept when the field is blank
        String password = d.bindPassword() != null ? d.bindPassword() : d.bindDn() == null ? null : stored;
        Directory kept = new Directory(d.enabled(), d.server(), d.port(), d.securityMode(), d.domain(), d.baseDn(), d.bindDn(), null,
                d.usernameAttribute(), d.uuidAttribute(), d.employeeNumberAttribute(), d.userObjectClass(), d.rankAttribute(),
                d.positionAttribute(), d.unitIdAttribute(), d.unitNameAttribute(), d.mainUnitIdAttribute(), d.caCertificatesPem(),
                d.timeoutSeconds());
        write("DIRECTORY", kept, password, ctx.personId());
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("enabled", d.enabled());
        detail.put("server", d.server());
        detail.put("port", d.port());
        detail.put("securityMode", d.securityMode());
        detail.put("domain", d.domain());
        detail.put("baseDn", d.baseDn());
        detail.put("serviceAccount", d.bindDn() != null);
        detail.put("caCertificates", Trust.parse(d.caCertificatesPem()).size());
        audit.recordAs(ctx.actor(), "INTEGRATION_DIRECTORY_SAVED", "SETTINGS", "integration/directory", "إعدادات التكامل — الدليل المؤسسي",
                detail, "حفظ إعدادات الدليل المؤسسي");
        return directoryView(ctx);
    }

    /** Back to the environment's values: the saved section is removed. */
    @Transactional
    public Map<String, Object> clearDirectory(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        jdbc.sql("delete from integration_setting where kind = 'DIRECTORY'").update();
        renew();
        audit.recordAs(ctx.actor(), "INTEGRATION_DIRECTORY_CLEARED", "SETTINGS", "integration/directory", "إعدادات التكامل — الدليل المؤسسي",
                Map.of(), "العودة إلى إعدادات ملف البيئة");
        return directoryView(ctx);
    }

    // ---- Keycloak ----------------------------------------------------------------------------------------------------

    public Map<String, Object> oidcView(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Stored<Oidc> o = null;
        String error = null;
        try {
            o = stored("OIDC", Oidc.class);
        } catch (RuntimeException e) {
            error = "تعذرت قراءة الإعدادات المحفوظة: " + e.getMessage();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("keyConfigured", cipher.configured());
        out.put("source", o != null && Boolean.TRUE.equals(o.form().enabled()) ? "SAVED" : envOidc.configured() ? "ENV" : "NONE");
        if (o != null) {
            Map<String, Object> m = asMap(o.form());
            m.remove("clientSecret");
            m.put("clientSecretSet", o.secret() != null);
            out.put("saved", m);
            out.put("updatedAt", o.updatedAt() == null ? null : o.updatedAt().toString());
            out.put("updatedBy", o.updatedBy() == null ? null : o.updatedBy().toString());
            if (o.secretError() != null) {
                out.put("secretError", o.secretError());
            }
        } else {
            out.put("saved", null);
        }
        if (error != null) {
            out.put("error", error);
        }
        Map<String, Object> env = new LinkedHashMap<>();
        OidcProperties.Provider a = envOidc.automatic();
        env.put("issuer", a.issuer());
        env.put("internalUrl", a.internalBaseUrl());
        env.put("clientId", a.clientId());
        env.put("clientSecretSet", a.clientSecret() != null);
        env.put("redirectUri", a.redirectUri());
        env.put("configured", a.configured());
        env.put("local", envOidc.localIssuer() != null && envOidc.localIssuer().equals(a.issuer()));
        out.put("env", env);
        OidcProperties.Provider e = oidc().automatic();
        Map<String, Object> eff = new LinkedHashMap<>();
        eff.put("configured", e.configured());
        eff.put("issuer", e.issuer());
        eff.put("internalUrl", e.internalBaseUrl());
        eff.put("clientId", e.clientId());
        eff.put("redirectUri", e.redirectUri());
        eff.put("platformIssuer", oidc().platformIssuer());
        out.put("effective", eff);
        return out;
    }

    /** The automatic provider the form describes, over the environment's other values; validated. */
    public OidcProperties toOidc(Oidc in, String storedSecret) {
        Oidc o = normaliseOidc(in);
        String secret = o.clientSecret() != null ? o.clientSecret() : storedSecret;
        if (o.serverUrl() == null || !(o.serverUrl().startsWith("https://") || o.serverUrl().startsWith("http://"))) {
            throw ApiException.validation("اكتب عنوان خادم Keycloak الذي يفتحه المتصفح (https://…).");
        }
        try {
            URI.create(o.serverUrl()).toURL();
        } catch (Exception e) {
            throw ApiException.validation("عنوان الخادم ليس عنواناً صالحاً.");
        }
        if (o.realm() == null || !REALM.matcher(o.realm()).matches()) {
            throw ApiException.validation("اكتب اسم المجال (Realm).");
        }
        if (o.clientId() == null) {
            throw ApiException.validation("اكتب معرّف العميل (Client ID).");
        }
        if (secret == null) {
            throw ApiException.validation("اكتب سر العميل (Client Secret) الذي أصدره فريق Keycloak.");
        }
        if (o.internalUrl() != null && !(o.internalUrl().startsWith("https://") || o.internalUrl().startsWith("http://"))) {
            throw ApiException.validation("العنوان الداخلي يبدأ بـ http:// أو https://.");
        }
        if (o.redirectUri() != null && !(o.redirectUri().startsWith("https://") || o.redirectUri().startsWith("http://"))) {
            throw ApiException.validation("عنوان العودة يبدأ بـ http:// أو https://.");
        }
        try {
            Trust.parse(o.caCertificatesPem());
        } catch (IllegalArgumentException e) {
            throw ApiException.validation("شهادة الجهة المصدرة: " + e.getMessage());
        }
        String issuer = o.issuer() != null ? o.issuer() : o.serverUrl() + "/realms/" + o.realm();
        // the back channel (token, keys, discovery) is the internal address when given, else the server address — as MOVER;
        // the issuer is only what every token must state
        String internal = (o.internalUrl() != null ? o.internalUrl() : o.serverUrl()) + "/realms/" + o.realm();
        String redirect = o.redirectUri() != null ? o.redirectUri() : envOidc.redirectUri();
        if (redirect == null) {
            throw ApiException.validation("عنوان العودة غير معروف: اكتبه، أو اضبط TMRKZ_PUBLIC_URL في ملف البيئة.");
        }
        return envOidc.withAutomatic(issuer, internal, o.clientId(), secret, redirect, envOidc.postLogoutRedirectUri());
    }

    private static Oidc normaliseOidc(Oidc in) {
        if (in == null) {
            throw ApiException.validation("لا إعدادات.");
        }
        return new Oidc(in.enabled() == null ? Boolean.TRUE : in.enabled(), strip(text(in.serverUrl())), text(in.realm()), text(in.clientId()),
                in.clientSecret() == null || in.clientSecret().isEmpty() ? null : in.clientSecret(), strip(text(in.internalUrl())),
                strip(text(in.issuer())), text(in.redirectUri()), text(in.caCertificatesPem()));
    }

    public String storedClientSecret() {
        Stored<Oidc> o = stored("OIDC", Oidc.class);
        return o == null ? null : o.secret();
    }

    @Transactional
    public Map<String, Object> saveOidc(AccessContext ctx, Oidc in) {
        ctx.require(Permission.CONFIGURE);
        Oidc o = normaliseOidc(in);
        String stored = storedClientSecret();
        toOidc(o, stored);
        String secret = o.clientSecret() != null ? o.clientSecret() : stored;
        Oidc kept = new Oidc(o.enabled(), o.serverUrl(), o.realm(), o.clientId(), null, o.internalUrl(), o.issuer(), o.redirectUri(),
                o.caCertificatesPem());
        write("OIDC", kept, secret, ctx.personId());
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("enabled", o.enabled());
        detail.put("serverUrl", o.serverUrl());
        detail.put("realm", o.realm());
        detail.put("clientId", o.clientId());
        detail.put("internalUrl", o.internalUrl());
        detail.put("issuer", o.issuer());
        detail.put("redirectUri", o.redirectUri());
        detail.put("caCertificates", Trust.parse(o.caCertificatesPem()).size());
        audit.recordAs(ctx.actor(), "INTEGRATION_OIDC_SAVED", "SETTINGS", "integration/oidc", "إعدادات التكامل — Keycloak", detail,
                "حفظ إعدادات الدخول الآلي");
        return oidcView(ctx);
    }

    @Transactional
    public Map<String, Object> clearOidc(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        jdbc.sql("delete from integration_setting where kind = 'OIDC'").update();
        renew();
        audit.recordAs(ctx.actor(), "INTEGRATION_OIDC_CLEARED", "SETTINGS", "integration/oidc", "إعدادات التكامل — Keycloak", Map.of(),
                "العودة إلى إعدادات ملف البيئة");
        return oidcView(ctx);
    }

    /** A trust for a test of unsaved Keycloak values. */
    SSLContext sslFor(String pem) {
        try {
            return Trust.withDefaults(Path.of(envLdap.caDir()), pem);
        } catch (Exception e) {
            throw ApiException.validation("شهادة الجهة المصدرة: " + e.getMessage());
        }
    }

    /** The audit detail of a test: which endpoint, never a credential. */
    void audited(AccessContext ctx, String what, Map<String, Object> detail) {
        audit.recordAs(ctx.actor(), what, "SETTINGS", "integration", "إعدادات التكامل", detail, "اختبار اتصال");
    }

    private static String text(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    // ---- the assistant (ADR-056) -------------------------------------------------------------------------------------

    /** Saved AI settings when enabled, otherwise the environment's. */
    public Assistant assistant() {
        Assistant saved = null;
        try {
            Stored<Assistant> s = stored("ASSISTANT", Assistant.class);
            if (s != null && Boolean.TRUE.equals(s.form().enabled())) {
                saved = new Assistant(true, s.form().baseUrl(), s.form().model(),
                        s.secret() == null ? envAssistant.apiKey() : s.secret(),
                        s.form().timeoutSeconds() == null ? envAssistant.timeoutSeconds() : s.form().timeoutSeconds());
            }
        } catch (RuntimeException ignore) {
            // the environment answers below
        }
        if (saved != null) {
            return saved;
        }
        return new Assistant(envAssistant.enabled(), envAssistant.baseUrl(), envAssistant.model(),
                envAssistant.apiKey(), envAssistant.timeoutSeconds());
    }

    public Map<String, Object> assistantView(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Stored<Assistant> a = null;
        String error = null;
        try {
            a = stored("ASSISTANT", Assistant.class);
        } catch (RuntimeException e) {
            error = "تعذرت قراءة الإعدادات المحفوظة: " + e.getMessage();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("keyConfigured", cipher.configured());
        out.put("source", a != null && Boolean.TRUE.equals(a.form().enabled()) ? "SAVED" : envAssistant.enabled() ? "ENV" : "NONE");
        if (a != null) {
            Map<String, Object> saved = new LinkedHashMap<>();
            saved.put("enabled", a.form().enabled());
            saved.put("baseUrl", a.form().baseUrl());
            saved.put("model", a.form().model());
            saved.put("timeoutSeconds", a.form().timeoutSeconds());
            saved.put("apiKeySet", a.secret() != null);
            out.put("saved", saved);
            out.put("updatedAt", a.updatedAt() == null ? null : a.updatedAt().toString());
            out.put("updatedBy", a.updatedBy() == null ? null : a.updatedBy().toString());
            if (a.secretError() != null) {
                out.put("secretError", a.secretError());
            }
        } else {
            out.put("saved", null);
        }
        if (error != null) {
            out.put("error", error);
        }
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("enabled", envAssistant.enabled());
        env.put("baseUrl", envAssistant.baseUrl());
        env.put("model", envAssistant.model());
        env.put("apiKeySet", envAssistant.apiKey() != null && !envAssistant.apiKey().isBlank());
        env.put("timeoutSeconds", envAssistant.timeoutSeconds());
        out.put("env", env);
        Assistant eff = assistant();
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("enabled", eff.enabled());
        e.put("baseUrl", eff.baseUrl());
        e.put("model", eff.model());
        e.put("apiKeySet", eff.apiKey() != null && !eff.apiKey().isBlank());
        e.put("timeoutSeconds", eff.timeoutSeconds());
        out.put("effective", e);
        return out;
    }

    @Transactional
    public Map<String, Object> saveAssistant(AccessContext ctx, Assistant in) {
        ctx.require(Permission.CONFIGURE);
        if (in == null) {
            throw ApiException.validation("لا إعدادات.");
        }
        Boolean enabled = in.enabled() == null ? Boolean.FALSE : in.enabled();
        String baseUrl = strip(text(in.baseUrl()));
        String model = text(in.model());
        Integer timeout = in.timeoutSeconds() == null ? 60 : Math.max(5, Math.min(300, in.timeoutSeconds()));
        if (Boolean.TRUE.equals(enabled)) {
            if (baseUrl == null || !(baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))) {
                throw ApiException.validation("اكتب عنوان خادم النموذج الذي يبدأ بـ http:// أو https:// .");
            }
            if (model == null) {
                throw ApiException.validation("اكتب اسم النموذج.");
            }
        }
        String stored = storedAssistantKey();
        String apiKey = in.apiKey() == null ? stored : (in.apiKey().isEmpty() ? null : in.apiKey());
        Assistant kept = new Assistant(enabled, baseUrl, model, null, timeout);
        write("ASSISTANT", kept, apiKey, ctx.personId());
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("enabled", enabled);
        detail.put("baseUrl", baseUrl);
        detail.put("model", model);
        detail.put("timeoutSeconds", timeout);
        detail.put("apiKeyChanged", in.apiKey() != null);
        audit.recordAs(ctx.actor(), "INTEGRATION_ASSISTANT_SAVED", "SETTINGS", "integration/assistant",
                "إعدادات التكامل — المساعد الذكي", detail, "حفظ إعدادات المساعد");
        return assistantView(ctx);
    }

    @Transactional
    public Map<String, Object> clearAssistant(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        jdbc.sql("delete from integration_setting where kind = 'ASSISTANT'").update();
        renew();
        audit.recordAs(ctx.actor(), "INTEGRATION_ASSISTANT_CLEARED", "SETTINGS", "integration/assistant",
                "إعدادات التكامل — المساعد الذكي", Map.of(), "العودة إلى إعدادات ملف البيئة");
        return assistantView(ctx);
    }

    public String storedAssistantKey() {
        Stored<Assistant> a = stored("ASSISTANT", Assistant.class);
        return a == null ? null : a.secret();
    }

    // ---- common --------------------------------------------------------------------------------------------------

    /** A URL without its trailing slash. */
    private static String strip(String url) {
        if (url == null) {
            return null;
        }
        String u = url;
        while (u.endsWith("/")) {
            u = u.substring(0, u.length() - 1);
        }
        return u;
    }
}
