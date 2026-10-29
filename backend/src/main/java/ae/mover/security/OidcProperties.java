package ae.mover.security;

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
        int httpTimeoutMs) {

    public OidcProperties {
        if (!"EMPLOYEE_NUMBER".equals(linkKey)) linkKey = "DOMAIN_ACCOUNT";
        if (enterpriseKeyClaim == null || enterpriseKeyClaim.isBlank()) enterpriseKeyClaim = "employee_number";
        if (reauthMaxAgeSeconds <= 0) reauthMaxAgeSeconds = 300;
        if (loginMaxAgeSeconds <= 0) loginMaxAgeSeconds = 43200;
        if (httpTimeoutMs <= 0) httpTimeoutMs = 10000;
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
