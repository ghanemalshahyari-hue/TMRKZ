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
 * <p>{@code manual} holds the backend-only TMRKZ_MANUAL_LDAP_* overrides: each one supplied replaces the shared LDAP_* value for
 * this authenticator only (Keycloak's federation keeps the shared values). When the manual URL points elsewhere, the shared
 * directory's service credential is never sent to it: the bind DN and credential then come from the manual values alone.
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
        Manual manual) {

    static final Pattern ATTRIBUTE = Pattern.compile("^[A-Za-z][A-Za-z0-9-]{0,63}$");
    /** The one place the login goes in a direct-bind pattern. */
    public static final String USERNAME_MARKER = "{username}";

    /** TMRKZ_MANUAL_LDAP_*: overrides of the manual authenticator only; empty means "use the shared value". */
    public record Manual(String url, Boolean startTls, String bindDn, String bindCredential, String usersDn, String usernameAttribute,
                         String uuidAttribute, String employeeNumberAttribute, String userObjectClass, String directBindPattern) {

        @Override
        public String toString() {
            return "Manual[" + url + "]"; // never the bind credential
        }
    }

    public LdapProperties {
        url = text(url);
        bindDn = text(bindDn);
        bindCredential = text(bindCredential);
        usersDn = text(usersDn);
        directBindPattern = text(directBindPattern);
        if (manual != null) {
            String manualUrl = text(manual.url());
            if (manualUrl != null) {
                url = manualUrl;
                // another directory: never the shared directory's service account
                bindDn = text(manual.bindDn());
                bindCredential = text(manual.bindCredential());
            } else {
                bindDn = first(text(manual.bindDn()), bindDn);
                bindCredential = first(text(manual.bindCredential()), bindCredential);
            }
            if (manual.startTls() != null) startTls = manual.startTls();
            usersDn = first(text(manual.usersDn()), usersDn);
            usernameAttribute = first(text(manual.usernameAttribute()), usernameAttribute);
            uuidAttribute = first(text(manual.uuidAttribute()), uuidAttribute);
            employeeNumberAttribute = first(text(manual.employeeNumberAttribute()), employeeNumberAttribute);
            userObjectClass = first(text(manual.userObjectClass()), userObjectClass);
            directBindPattern = first(text(manual.directBindPattern()), directBindPattern);
        }
        if (usernameAttribute == null || usernameAttribute.isBlank()) usernameAttribute = "uid";
        if (uuidAttribute == null || uuidAttribute.isBlank()) uuidAttribute = "entryUUID";
        if (employeeNumberAttribute == null || employeeNumberAttribute.isBlank()) employeeNumberAttribute = "employeeNumber";
        if (userObjectClass == null || userObjectClass.isBlank()) userObjectClass = "inetOrgPerson";
        usernameAttribute = usernameAttribute.trim();
        uuidAttribute = uuidAttribute.trim();
        employeeNumberAttribute = employeeNumberAttribute.trim();
        userObjectClass = userObjectClass.trim();
        if (caDir == null || caDir.isBlank()) caDir = "/etc/tmrkz/ldap-ca";
        if (issuer == null || issuer.isBlank()) issuer = "urn:tmrkz:directory";
        if (connectTimeoutMs <= 0) connectTimeoutMs = 5000;
        if (readTimeoutMs <= 0) readTimeoutMs = 10000;
        if (maxFailures <= 0) maxFailures = 5;
        if (lockMinutes <= 0) lockMinutes = 15;
        directBindPattern = pattern(directBindPattern);
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
