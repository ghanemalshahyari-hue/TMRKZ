package ae.mover.security;

import java.util.List;
import java.util.Locale;
import java.util.Objects;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Sign-in through OpenID Connect providers (Keycloak). {@code issuer} is the public issuer URL that appears in tokens and serves
 * the browser; {@code internalBaseUrl} is the same realm reached over the internal network for the back channel (token and
 * keys). Endpoint paths follow Keycloak's realm layout.
 *
 * <p>Two independent providers (ADR-071):
 * <ul>
 * <li><b>Automatic</b> ({@code issuer}, {@code clientId}, ...): the employees' sign-in button. It is the external enterprise
 * Keycloak client when an issuer is supplied (TMRKZ_OIDC_*, fed by TMRKZ_ENTERPRISE_OIDC_* in Compose); while no issuer is
 * supplied it is the local provider below, as a whole (never a mix of the two providers' values).</li>
 * <li><b>Platform</b> ({@code platformIssuer}, ...): the local Keycloak realm of the lasting platform accounts, used for their
 * manual password sign-in (the backend-only {@code passwordClientId}, ADR-070), their step-up and their logout. It comes from the
 * stable local values (TMRKZ_LOCAL_OIDC_*), which TMRKZ_PLATFORM_OIDC_* / TMRKZ_PLATFORM_BROWSER_* may override; it never defaults
 * to the enterprise provider while local values exist. Without any local value (a single-provider installation or test) it is
 * the automatic provider, as before.</li>
 * </ul>
 * Every text setting is trimmed and an empty value counts as not supplied, so a Compose file passing {@code VAR=} neither erases a
 * default nor borrows another provider's value.
 */
@ConfigurationProperties(prefix = "tmrkz.oidc")
public record OidcProperties(
        String issuer,
        String internalBaseUrl,
        String clientId,
        String clientSecret,
        String redirectUri,
        String postLogoutRedirectUri,
        String linkKey,
        String enterpriseKeyClaim,
        int reauthMaxAgeSeconds,
        int loginMaxAgeSeconds,
        int httpTimeoutMs,
        List<String> platformAccounts,
        String unitIdClaim,
        String unitNameClaim,
        String mainUnitIdClaim,
        String rankClaim,
        String positionClaim,
        String localIssuer,
        String localInternalBaseUrl,
        String localClientId,
        String localClientSecret,
        String localRedirectUri,
        String localPostLogoutRedirectUri,
        String platformIssuer,
        String platformInternalBaseUrl,
        String platformClientId,
        String platformClientSecret,
        String platformRedirectUri,
        String platformPostLogoutRedirectUri,
        String passwordClientId,
        String passwordClientSecret) {

    /** The realm role a platform account holds in the provider, and the ID token claim that carries realm roles. */
    public static final String PLATFORM_ROLE = "tmrkz-platform";
    public static final String ROLES_CLAIM = "tmrkz_roles";
    private static final java.util.regex.Pattern CLAIM = java.util.regex.Pattern.compile("^[A-Za-z][A-Za-z0-9_.-]{0,63}$");

    /**
     * The employment claims (ADR-068) are the NAMES of the ID-token claims that carry the unit ID, unit name, main unit ID, rank
     * and position (TMRKZ_OIDC_CLAIM_*). Empty means not read; a name that is not a plain claim name stops the application.
     */
    public OidcProperties {
        issuer = text(issuer);
        internalBaseUrl = text(internalBaseUrl);
        clientId = text(clientId);
        clientSecret = text(clientSecret);
        redirectUri = text(redirectUri);
        postLogoutRedirectUri = text(postLogoutRedirectUri);
        localIssuer = text(localIssuer);
        localInternalBaseUrl = text(localInternalBaseUrl);
        localClientId = text(localClientId);
        localClientSecret = text(localClientSecret);
        localRedirectUri = text(localRedirectUri);
        localPostLogoutRedirectUri = text(localPostLogoutRedirectUri);
        passwordClientId = text(passwordClientId);
        passwordClientSecret = text(passwordClientSecret);

        // TMRKZ's own callback and signed-out addresses are the same for every provider.
        String sharedRedirect = first(redirectUri, localRedirectUri);
        String sharedPostLogout = first(postLogoutRedirectUri, localPostLogoutRedirectUri);
        boolean local = localIssuer != null;
        if (issuer == null && local) {
            // no enterprise provider supplied: automatic sign-in is the local provider, taken as a whole
            issuer = localIssuer;
            internalBaseUrl = localInternalBaseUrl;
            clientId = localClientId;
            clientSecret = localClientSecret;
            redirectUri = first(localRedirectUri, redirectUri);
            postLogoutRedirectUri = first(localPostLogoutRedirectUri, postLogoutRedirectUri);
        } else {
            redirectUri = sharedRedirect;
            postLogoutRedirectUri = sharedPostLogout;
        }

        // The platform provider: the local one when it exists, else (a single-provider installation) the automatic one.
        String baseIssuer = local ? localIssuer : issuer;
        String baseInternal = local ? localInternalBaseUrl : internalBaseUrl;
        String baseClient = local ? localClientId : clientId;
        String baseSecret = local ? localClientSecret : clientSecret;
        platformIssuer = text(platformIssuer);
        platformInternalBaseUrl = text(platformInternalBaseUrl);
        platformClientId = text(platformClientId);
        platformClientSecret = text(platformClientSecret);
        if (platformIssuer != null && !platformIssuer.equals(baseIssuer)) {
            // another platform realm: its own back channel and browser client only, never the base provider's credentials
            platformInternalBaseUrl = first(platformInternalBaseUrl, platformIssuer);
        } else {
            platformIssuer = baseIssuer;
            platformInternalBaseUrl = first(platformInternalBaseUrl, baseInternal);
            platformClientId = first(platformClientId, baseClient);
            platformClientSecret = first(platformClientSecret, baseSecret);
        }
        platformRedirectUri = first(text(platformRedirectUri), local ? first(localRedirectUri, sharedRedirect) : sharedRedirect);
        platformPostLogoutRedirectUri = first(text(platformPostLogoutRedirectUri),
                local ? first(localPostLogoutRedirectUri, sharedPostLogout) : sharedPostLogout);

        if (!"EMPLOYEE_NUMBER".equals(text(linkKey))) linkKey = "DOMAIN_ACCOUNT";
        else linkKey = "EMPLOYEE_NUMBER";
        if (enterpriseKeyClaim == null || enterpriseKeyClaim.isBlank()) enterpriseKeyClaim = "employee_number";
        if (reauthMaxAgeSeconds <= 0) reauthMaxAgeSeconds = 300;
        if (loginMaxAgeSeconds <= 0) loginMaxAgeSeconds = 43200;
        if (httpTimeoutMs <= 0) httpTimeoutMs = 10000;
        platformAccounts = platformAccounts == null ? List.of() : platformAccounts.stream()
                .filter(Objects::nonNull).map(s -> s.trim().toLowerCase(Locale.ROOT)).filter(s -> !s.isEmpty()).distinct().toList();
        unitIdClaim = claim("TMRKZ_OIDC_CLAIM_UNIT_ID", unitIdClaim);
        unitNameClaim = claim("TMRKZ_OIDC_CLAIM_UNIT_NAME", unitNameClaim);
        mainUnitIdClaim = claim("TMRKZ_OIDC_CLAIM_MAIN_UNIT_ID", mainUnitIdClaim);
        rankClaim = claim("TMRKZ_OIDC_CLAIM_RANK", rankClaim);
        positionClaim = claim("TMRKZ_OIDC_CLAIM_POSITION", positionClaim);
    }

    private static String claim(String setting, String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        String n = name.trim();
        if (!CLAIM.matcher(n).matches()) {
            throw new IllegalArgumentException(setting + " is not a claim name");
        }
        return n;
    }

    /** Trimmed; empty (a Compose {@code VAR=}) is not supplied. */
    private static String text(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static String first(String a, String b) {
        return a != null ? a : b;
    }

    /** Whether any employment claim is read on this path. */
    public boolean employmentClaims() {
        return unitIdClaim != null || unitNameClaim != null || mainUnitIdClaim != null || rankClaim != null || positionClaim != null;
    }

    /** Never a client secret. */
    @Override
    public String toString() {
        return "OidcProperties[" + issuer + ", " + clientId + ", platform=" + platformIssuer + ", password=" + passwordClientId
                + ", linkKey=" + linkKey + "]";
    }

    /** A login named by the installation as a lasting platform account (TMRKZ_PLATFORM_ACCOUNTS). */
    public boolean platformAccount(String login) {
        return login != null && platformAccounts.contains(login.trim().toLowerCase(Locale.ROOT));
    }

    /**
     * One provider's endpoints and browser client. {@code clientSecret} is used only on its own back channel; {@link #toString}
     * never shows it.
     */
    public record Provider(String issuer, String internalBaseUrl, String clientId, String clientSecret, String redirectUri,
                           String postLogoutRedirectUri) {

        /** The browser (authorization code) client of this provider is usable. */
        public boolean configured() {
            return issuer != null && clientId != null && clientSecret != null && redirectUri != null;
        }

        String backChannel() {
            return internalBaseUrl != null ? internalBaseUrl : issuer;
        }

        String authorizationEndpoint() {
            return issuer + "/protocol/openid-connect/auth";
        }

        String endSessionEndpoint() {
            return issuer + "/protocol/openid-connect/logout";
        }

        String tokenEndpoint() {
            return backChannel() + "/protocol/openid-connect/token";
        }

        String jwksEndpoint() {
            return backChannel() + "/protocol/openid-connect/certs";
        }

        @Override
        public String toString() {
            return "Provider[" + issuer + ", " + clientId + "]";
        }
    }

    /**
     * These properties with another automatic provider (ADR-092: the Keycloak saved in «إعدادات التكامل»), every other value
     * unchanged; the normalisation of the canonical constructor applies again, so the platform provider stays the local one.
     */
    public OidcProperties withAutomatic(String issuer, String internalBaseUrl, String clientId, String clientSecret, String redirectUri,
                                        String postLogoutRedirectUri) {
        return new OidcProperties(issuer, internalBaseUrl, clientId, clientSecret, redirectUri, postLogoutRedirectUri, linkKey,
                enterpriseKeyClaim, reauthMaxAgeSeconds, loginMaxAgeSeconds, httpTimeoutMs, platformAccounts, unitIdClaim, unitNameClaim,
                mainUnitIdClaim, rankClaim, positionClaim, localIssuer, localInternalBaseUrl, localClientId, localClientSecret,
                localRedirectUri, localPostLogoutRedirectUri, platformIssuer, platformInternalBaseUrl, platformClientId,
                platformClientSecret, platformRedirectUri, platformPostLogoutRedirectUri, passwordClientId, passwordClientSecret);
    }

    /** The automatic (employee) provider: external enterprise Keycloak when supplied, else the local one. */
    public Provider automatic() {
        return new Provider(issuer, internalBaseUrl, clientId, clientSecret, redirectUri, postLogoutRedirectUri);
    }

    /** The local platform provider: manual platform password, platform step-up and platform logout. */
    public Provider platform() {
        return new Provider(platformIssuer, platformInternalBaseUrl, platformClientId, platformClientSecret, platformRedirectUri,
                platformPostLogoutRedirectUri);
    }

    /** The two providers are different realms (otherwise a single-provider installation). */
    public boolean separateProviders() {
        return platformIssuer != null && !platformIssuer.equals(issuer);
    }

    /** Automatic sign-in is usable. */
    public boolean configured() {
        return automatic().configured();
    }

    /** The backend-only platform-password client (ADR-070) is usable. */
    public boolean passwordConfigured() {
        return platformIssuer != null && passwordClientId != null && passwordClientSecret != null;
    }

    String backChannel() {
        return automatic().backChannel();
    }

    String authorizationEndpoint() {
        return automatic().authorizationEndpoint();
    }

    String endSessionEndpoint() {
        return automatic().endSessionEndpoint();
    }

    String tokenEndpoint() {
        return automatic().tokenEndpoint();
    }

    String jwksEndpoint() {
        return automatic().jwksEndpoint();
    }

    String platformTokenEndpoint() {
        return platform().tokenEndpoint();
    }

    String platformJwksEndpoint() {
        return platform().jwksEndpoint();
    }
}
