package ae.mover.security;

import java.util.regex.Pattern;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The enterprise directory for manual sign-in (username and password checked by an LDAP bind, as in TNQL). A connection is
 * always protected: {@code ldaps://} or StartTLS, trusting only the CA certificates in {@code caDir}, with host-name
 * verification; there is no setting that turns validation off.
 *
 * <p>Two ways to verify the password (ADR-070): with {@code directBindPattern} (exactly one {@code {username}} marker, e.g.
 * {@code {username}@corp.example} or {@code uid={username},ou=people,dc=example}) the person binds as themselves, as TNQL/Duty do,
 * and the same authenticated connection then finds their one entry under {@code usersDn}; without it, a read-only service account
 * ({@code bindDn}) finds exactly one entry and the person's own bind follows (ADR-016).
 *
 * <p>No service account is ever required (ADR-100, owner 24 Nov 2026: «anyone who has LDAP credentials»). {@code domain}
 * ({@code LDAP_DOMAIN}, MOVER's name) gives the pattern {@code {username}@domain}; with neither a pattern, a domain nor a complete
 * service account, the domain is the {@code DC=} parts of {@code usersDn} ({@code OU=Staff,DC=corp,DC=example} →
 * {@code corp.example}), which is how Active Directory accepts {@code sAMAccountName@dnsDomain}. A wrong guess is only a refused
 * bind: the directory still checks every password.
 *
 * <p>{@code caCertificatesPem} (ADR-092): the CA certificates pasted in «إعدادات التكامل», trusted together with the files of
 * {@code caDir}; the settings saved there replace these environment values as a whole ({@link IntegrationSettingsService}).
 *
 * <p>The employment attributes (ADR-068: unit ID, unit name, main unit ID, rank, position) are the NAMES of the directory
 * attributes that carry them in this organisation (LDAP_ATTR_*). Empty means not read; nothing is assumed. A name that is not
 * a plain attribute name, or a direct-bind pattern without exactly one marker, stops the application at start, so a typing
 * mistake is never silently ignored.
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
        String positionAttribute,
        String directBindPattern,
        String caCertificatesPem,
        String domain) {

    static final Pattern ATTRIBUTE = Pattern.compile("^[A-Za-z][A-Za-z0-9-]{0,63}$");
    static final Pattern DOMAIN = Pattern.compile("^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$");
    /** The one place the login goes in a direct-bind pattern. */
    public static final String USERNAME_MARKER = "{username}";

    public LdapProperties {
        url = text(url);
        bindDn = text(bindDn);
        bindCredential = text(bindCredential);
        usersDn = text(usersDn);
        directBindPattern = text(directBindPattern);
        if (usernameAttribute == null || usernameAttribute.isBlank()) usernameAttribute = "uid";
        if (uuidAttribute == null || uuidAttribute.isBlank()) uuidAttribute = "entryUUID";
        if (employeeNumberAttribute == null || employeeNumberAttribute.isBlank()) employeeNumberAttribute = "employeeNumber";
        if (userObjectClass == null || userObjectClass.isBlank()) userObjectClass = "inetOrgPerson";
        usernameAttribute = usernameAttribute.trim();
        uuidAttribute = uuidAttribute.trim();
        employeeNumberAttribute = employeeNumberAttribute.trim();
        userObjectClass = userObjectClass.trim();
        if (caDir == null || caDir.isBlank()) caDir = "/etc/tmrkz/ldap-ca";
        caCertificatesPem = text(caCertificatesPem);
        if (issuer == null || issuer.isBlank()) issuer = "urn:tmrkz:directory";
        if (connectTimeoutMs <= 0) connectTimeoutMs = 5000;
        if (readTimeoutMs <= 0) readTimeoutMs = 10000;
        if (maxFailures <= 0) maxFailures = 5;
        if (lockMinutes <= 0) lockMinutes = 15;
        directBindPattern = pattern(directBindPattern);
        domain = text(domain);
        if (domain != null && !DOMAIN.matcher(domain).matches()) {
            throw new IllegalArgumentException("LDAP_DOMAIN is not a domain name");
        }
        if (directBindPattern == null) {
            // ADR-100: each person binds as themselves unless a complete service account is given
            String d = domain != null ? domain : bindDn == null || bindCredential == null ? domainOf(usersDn) : null;
            if (d != null) {
                directBindPattern = USERNAME_MARKER + "@" + d;
            }
        }
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

    /** Exactly one {@code {username}} marker, no control character; the pattern itself is not secret but is not echoed. */
    private static String pattern(String p) {
        if (p == null) {
            return null;
        }
        int first = p.indexOf(USERNAME_MARKER);
        boolean controls = p.chars().anyMatch(Character::isISOControl);
        if (first < 0 || p.indexOf(USERNAME_MARKER, first + 1) >= 0 || controls || p.length() > 512) {
            throw new IllegalArgumentException("LDAP_DIRECT_BIND_PATTERN must contain exactly one " + USERNAME_MARKER
                    + " marker and no control character");
        }
        return p;
    }

    /** The {@code DC=} parts of a DN as a DNS domain ({@code OU=x,DC=corp,DC=example} → {@code corp.example}); null if none. */
    public static String domainOf(String dn) {
        if (dn == null || dn.isBlank()) {
            return null;
        }
        try {
            java.util.List<javax.naming.ldap.Rdn> rdns = new javax.naming.ldap.LdapName(dn.trim()).getRdns();
            java.util.List<String> parts = new java.util.ArrayList<>();
            for (int i = rdns.size() - 1; i >= 0; i--) { // getRdns() lists the rightmost first
                javax.naming.ldap.Rdn r = rdns.get(i);
                if ("dc".equalsIgnoreCase(r.getType())) {
                    parts.add(String.valueOf(r.getValue()).trim());
                }
            }
            String d = String.join(".", parts);
            return parts.isEmpty() || !DOMAIN.matcher(d).matches() ? null : d;
        } catch (javax.naming.InvalidNameException e) {
            return null;
        }
    }

    /**
     * The domain of a {@code {username}@domain} pattern: the person signs in to Active Directory with their own account, and
     * the directory's own names (sAMAccountName, userPrincipalName, objectGUID) are accepted next to the configured ones.
     */
    public String upnSuffix() {
        String m = USERNAME_MARKER + "@";
        return directBindPattern != null && directBindPattern.startsWith(m) ? directBindPattern.substring(m.length()) : null;
    }

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

    /** The person binds as themselves (ADR-070) rather than being found first by a service account. */
    public boolean direct() {
        return directBindPattern != null;
    }

    public boolean configured() {
        return notBlank(url) && notBlank(usersDn) && secure() && (direct() || (notBlank(bindDn) && notBlank(bindCredential)));
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
        return "LdapProperties[" + url + ", startTls=" + startTls + ", usersDn=" + usersDn + ", direct=" + direct() + "]";
    }
}
