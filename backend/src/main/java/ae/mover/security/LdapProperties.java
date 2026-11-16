package ae.mover.security;

import java.util.regex.Pattern;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The enterprise directory for manual sign-in (username and password checked by an LDAP bind, as in TNQL). The same
 * values configure Keycloak's federation. A connection is always protected: {@code ldaps://} or StartTLS, trusting only
 * the CA certificates in {@code caDir}; there is no setting that turns validation off.
 *
 * <p>The employment attributes (ADR-068: unit ID, unit name, main unit ID, rank, position) are the NAMES of the directory
 * attributes that carry them in this organisation (LDAP_ATTR_*). Empty means not read; nothing is assumed. A name that is not
 * a plain attribute name stops the application at start, so a typing mistake is never silently ignored.
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
        int lockMinutes,
        String unitIdAttribute,
        String unitNameAttribute,
        String mainUnitIdAttribute,
        String rankAttribute,
        String positionAttribute) {

    static final Pattern ATTRIBUTE = Pattern.compile("^[A-Za-z][A-Za-z0-9-]{0,63}$");

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
        unitIdAttribute = optional("LDAP_ATTR_UNIT_ID", unitIdAttribute);
        unitNameAttribute = optional("LDAP_ATTR_UNIT_NAME", unitNameAttribute);
        mainUnitIdAttribute = optional("LDAP_ATTR_MAIN_UNIT_ID", mainUnitIdAttribute);
        rankAttribute = optional("LDAP_ATTR_RANK", rankAttribute);
        positionAttribute = optional("LDAP_ATTR_POSITION", positionAttribute);
    }

    /** An optional attribute name: blank is "not read"; anything that is not a plain attribute name is refused. */
    private static String optional(String setting, String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        String n = name.trim();
        if (!ATTRIBUTE.matcher(n).matches()) {
            throw new IllegalArgumentException(setting + " is not a directory attribute name");
        }
        return n;
    }

    public boolean configured() {
        return notBlank(url) && notBlank(bindDn) && notBlank(bindCredential) && notBlank(usersDn) && secure();
    }

    /** Only protected channels are accepted. */
    public boolean secure() {
        return notBlank(url) && (url.trim().toLowerCase(java.util.Locale.ROOT).startsWith("ldaps://") || startTls);
    }

    /** The employment attributes this installation reads (none by default). */
    public java.util.List<String> employmentAttributes() {
        return java.util.stream.Stream.of(unitIdAttribute, unitNameAttribute, mainUnitIdAttribute, rankAttribute, positionAttribute)
                .filter(java.util.Objects::nonNull).distinct().toList();
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }

    /** Never the bind credential (LDAP specification §27). */
    @Override
    public String toString() {
        return "LdapProperties[" + url + ", startTls=" + startTls + ", usersDn=" + usersDn + "]";
    }
}
