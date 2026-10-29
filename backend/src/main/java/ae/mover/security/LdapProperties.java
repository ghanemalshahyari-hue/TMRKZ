package ae.mover.security;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The enterprise directory for manual sign-in (username and password checked by an LDAP bind, as in TNQL). The same
 * values configure Keycloak's federation. A connection is always protected: {@code ldaps://} or StartTLS, trusting only
 * the CA certificates in {@code caDir}; there is no setting that turns validation off.
 */
@ConfigurationProperties(prefix = "tmrkz.ldap")
public record LdapProperties(
        String url,
        boolean startTls,
        String bindDn,
        String bindCredential,
        String usersDn,
        String usernameAttribute,
        String uuidAttribute,
        String employeeNumberAttribute,
        String userObjectClass,
        String caDir,
        String issuer,
        int connectTimeoutMs,
        int readTimeoutMs,
        int maxFailures,
        int lockMinutes) {

    public LdapProperties {
        if (usernameAttribute == null || usernameAttribute.isBlank()) usernameAttribute = "uid";
        if (uuidAttribute == null || uuidAttribute.isBlank()) uuidAttribute = "entryUUID";
        if (employeeNumberAttribute == null || employeeNumberAttribute.isBlank()) employeeNumberAttribute = "employeeNumber";
        if (userObjectClass == null || userObjectClass.isBlank()) userObjectClass = "inetOrgPerson";
        if (caDir == null || caDir.isBlank()) caDir = "/etc/tmrkz/ldap-ca";
        if (issuer == null || issuer.isBlank()) issuer = "urn:tmrkz:directory";
        if (connectTimeoutMs <= 0) connectTimeoutMs = 5000;
        if (readTimeoutMs <= 0) readTimeoutMs = 10000;
        if (maxFailures <= 0) maxFailures = 5;
        if (lockMinutes <= 0) lockMinutes = 15;
    }

    public boolean configured() {
        return notBlank(url) && notBlank(bindDn) && notBlank(bindCredential) && notBlank(usersDn) && secure();
    }

    /** Only protected channels are accepted. */
    public boolean secure() {
        return notBlank(url) && (url.trim().toLowerCase(java.util.Locale.ROOT).startsWith("ldaps://") || startTls);
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
