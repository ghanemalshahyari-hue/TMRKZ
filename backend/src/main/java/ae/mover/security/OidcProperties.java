package ae.mover.security;

import java.util.List;
import java.util.Locale;
import java.util.Objects;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Enterprise sign-in through an OpenID Connect provider (Keycloak federating LDAP). {@code issuer} is the public issuer
 * URL that appears in tokens and serves the browser; {@code internalBaseUrl} is the same realm reached over the
 * internal network for the back channel (token and keys). Endpoint paths follow Keycloak's realm layout.
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
        String positionClaim) {

    /** The realm role a platform account holds in the provider, and the ID token claim that carries realm roles. */
    public static final String PLATFORM_ROLE = "tmrkz-platform";
    public static final String ROLES_CLAIM = "tmrkz_roles";
    private static final java.util.regex.Pattern CLAIM = java.util.regex.Pattern.compile("^[A-Za-z][A-Za-z0-9_.-]{0,63}$");

    /**
     * The employment claims (ADR-068) are the NAMES of the ID-token claims that carry the unit ID, unit name, main unit ID, rank
     * and position (TMRKZ_OIDC_CLAIM_*). Empty means not read; a name that is not a plain claim name stops the application.
     */
    public OidcProperties {
        if (!"EMPLOYEE_NUMBER".equals(linkKey)) linkKey = "DOMAIN_ACCOUNT";
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

    /** Whether any employment claim is read on this path. */
    public boolean employmentClaims() {
        return unitIdClaim != null || unitNameClaim != null || mainUnitIdClaim != null || rankClaim != null || positionClaim != null;
    }

    /** Never the client secret. */
    @Override
    public String toString() {
        return "OidcProperties[" + issuer + ", " + clientId + ", linkKey=" + linkKey + "]";
    }

    /** A login named by the installation as a lasting platform account (TMRKZ_PLATFORM_ACCOUNTS). */
    public boolean platformAccount(String login) {
        return login != null && platformAccounts.contains(login.trim().toLowerCase(Locale.ROOT));
    }

    public boolean configured() {
        return notBlank(issuer) && notBlank(clientId) && notBlank(clientSecret) && notBlank(redirectUri);
    }

    String backChannel() {
        return notBlank(internalBaseUrl) ? internalBaseUrl : issuer;
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

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
