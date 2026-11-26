package ae.mover.security;

import java.io.IOException;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.util.HexFormat;
import java.util.Hashtable;
import java.util.Locale;
import java.util.regex.Pattern;

import javax.naming.AuthenticationException;
import javax.naming.CommunicationException;
import javax.naming.Context;
import javax.naming.NameNotFoundException;
import javax.naming.NamingEnumeration;
import javax.naming.NamingException;
import javax.naming.ServiceUnavailableException;
import javax.naming.directory.Attribute;
import javax.naming.directory.Attributes;
import javax.naming.directory.SearchControls;
import javax.naming.directory.SearchResult;
import javax.naming.ldap.InitialLdapContext;
import javax.naming.ldap.LdapContext;
import javax.naming.ldap.LdapName;
import javax.naming.ldap.StartTlsRequest;
import javax.naming.ldap.StartTlsResponse;
import javax.net.SocketFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Verifies a username and password against the enterprise directory, as TNQL's manual sign-in does. Two profiles:
 * <ul>
 * <li>direct user bind (ADR-070, {@link LdapProperties#direct()}): the person binds as the name the installation's pattern makes
 * of the login, then that same authenticated connection finds exactly one entry for the login and reads its stable identifier,
 * login, name and the configured employment attributes;</li>
 * <li>service search (ADR-016): a read-only service account finds exactly one entry for the login name, then the person's own
 * password is checked by binding as that entry.</li>
 * </ul>
 * Every connection is protected (LDAPS or StartTLS) and trusts only the CA certificates in the configured folder; JSSE endpoint
 * identification is set explicitly on both the LDAPS socket and the StartTLS wrapping socket, so a certificate issued for another
 * host name is refused. Credentials are never sent before the channel is secured and an empty password is never bound. A refusal
 * is never an opportunity to try the other profile. TMRKZ keeps no password.
 */
@Component
public class DirectoryAuthenticator {

    private static final Logger log = LoggerFactory.getLogger(DirectoryAuthenticator.class);
    private static final Pattern ATTRIBUTE = Pattern.compile("^[A-Za-z][A-Za-z0-9-]{0,63}$");
    /** Active Directory's own names, read next to the configured ones when people bind as {@code user@domain} (ADR-100). */
    private static final java.util.List<String> AD_NAMES = java.util.List.of("sAMAccountName", "userPrincipalName", "objectGUID", "entryUUID");
    /**
     * A login that may be placed in a direct-bind pattern: letters, digits, dot, hyphen and underscore only, so it can change
     * neither a DN nor a UPN (nothing to escape, nothing to inject); anything else is the uniform wrong-credentials answer.
     */
    private static final Pattern DIRECT_LOGIN = Pattern.compile("^[\\p{L}\\p{N}][\\p{L}\\p{N}._-]{0,127}$");

    private final IntegrationSettingsService settings;
    private final LdapProperties fixed;
    /** The values of a connection test (ADR-092): unsaved settings, for this thread's test only. */
    private static final ThreadLocal<LdapProperties> TESTING = new ThreadLocal<>();

    @org.springframework.beans.factory.annotation.Autowired
    public DirectoryAuthenticator(IntegrationSettingsService settings) {
        this.settings = settings;
        this.fixed = null;
    }

    /** An authenticator for one fixed directory (tests). */
    public DirectoryAuthenticator(LdapProperties fixed) {
        this.settings = null;
        this.fixed = fixed;
    }

    /** The directory in force: the settings saved in «إعدادات التكامل» or the environment (ADR-092). */
    private LdapProperties props() {
        LdapProperties t = TESTING.get();
        return t != null ? t : fixed != null ? fixed : settings.ldap();
    }

    /** The result of a connection test: what was reached, never a credential. */
    public record TestResult(boolean ok, String step, String message, String dn, String displayName) {
    }

    /** One directory attribute of an inspected entry: its name, its value(s) as text, and whether the raw value was binary (hex). */
    public record InspectAttr(String name, java.util.List<String> values, boolean binary) {
    }

    /**
     * The full directory record of one test user (configuration preview, ADR-092 companion). Lets whoever configures the
     * directory see every attribute the entry actually carries and confirm which attribute each mapped field should name,
     * before saving. Never a credential; nothing is stored.
     */
    public record InspectResult(boolean ok, String step, String message, String dn, String displayName,
                                java.util.List<InspectAttr> attributes) {
    }

    /**
     * A test of unsaved settings (ADR-092), as MOVER's «اختبار الاتصال»: the protected channel is opened with the given trust
     * (certificate chain and host name checked); then, with a login and password, that person's own sign-in exactly as the
     * manual form does it; or, with a service account, its bind; nothing is stored.
     */
    public TestResult test(LdapProperties p, String login, String password) {
        TESTING.set(p);
        try {
            if (login != null && !login.isBlank() && password != null && !password.isEmpty()) {
                DirectoryUser u = authenticate(login, password);
                return new TestResult(true, "SIGN_IN", "نجح دخول المستخدم وقراءة سجله من الدليل.", u.dn(), u.displayName());
            }
            if (p.bindDn() != null && p.bindCredential() != null) {
                close(connect(p.bindDn(), p.bindCredential(), false));
                return new TestResult(true, "SERVICE_BIND", "نجح الاتصال المؤمَّن وربط حساب الخدمة.", p.bindDn(), null);
            }
            close(open(p, sslContext()));
            return new TestResult(true, "TLS", "نجح الاتصال المؤمَّن بالدليل (الشهادة موثوقة واسم الخادم مطابق).", null, null);
        } catch (DirectoryException e) {
            String message = switch (e.failure()) {
                case INVALID_CREDENTIALS -> "رفض الدليل اسم المستخدم أو كلمة المرور (الاتصال المؤمَّن نفسه نجح).";
                case AMBIGUOUS -> "اسم المستخدم يطابق أكثر من سجل في الدليل.";
                case TLS -> "رُفض الاتصال المؤمَّن: الشهادة غير موثوقة أو اسم الخادم لا يطابقها.";
                case NOT_CONFIGURED -> "الإعدادات غير مكتملة.";
                case UNAVAILABLE -> "تعذر الوصول إلى الدليل (العنوان، المنفذ أو الجدار الناري).";
            };
            String cause = e.getCause() == null ? null : e.getCause().getMessage();
            return new TestResult(false, e.failure().name(), cause == null ? message : message + " — " + cause.replaceAll("[\\r\\n]+", " "), null, null);
        } catch (NamingException e) {
            return new TestResult(false, "ERROR", "خطأ من الدليل: " + e.getMessage(), null, null);
        } finally {
            TESTING.remove();
        }
    }

    /**
     * Reads one directory entry for {@code login} and returns ALL of its attributes, so whoever configures the directory can
     * see which attribute names actually carry the rank, unit, number and so on, and confirm the mapping before saving
     * (ADR-092 companion). With the test user's own {@code password}: binds as that person (the only mode with no service
     * account) when a bind pattern is known; otherwise the read-only service account searches. Binary values are shown as hex
     * and long values are capped. Nothing is stored; a typed password is used for that one bind and dropped.
     */
    public InspectResult inspect(LdapProperties p, String login, String password) {
        TESTING.set(p);
        try {
            if (!p.configured()) {
                return new InspectResult(false, "NOT_CONFIGURED", "الإعدادات غير مكتملة.", null, null, java.util.List.of());
            }
            if (login == null || login.isBlank()) {
                return new InspectResult(false, "INPUT", "اكتب اسم دخول مستخدم تجريبي للعرض.", null, null, java.util.List.of());
            }
            String target = bare(login.trim());
            if (!DIRECT_LOGIN.matcher(target).matches()) {
                return new InspectResult(false, "INPUT", "اسم الدخول غير صالح.", null, null, java.util.List.of());
            }
            boolean asUser = password != null && !password.isEmpty();
            if (password != null && password.length() > 1024) {
                return new InspectResult(false, "INPUT", "كلمة المرور غير صالحة.", null, null, java.util.List.of());
            }
            boolean canUserBind = p.direct() || p.upnSuffix() != null; // a known bind name for the login
            boolean hasService = p.bindDn() != null && p.bindCredential() != null;
            LdapContext ctx;
            String step;
            try {
                if (asUser && canUserBind) {
                    String principal = p.directBindPattern().replace(LdapProperties.USERNAME_MARKER, target);
                    ctx = connect(principal, password, true);
                    step = "USER_BIND";
                } else if (hasService) {
                    ctx = connect(p.bindDn(), p.bindCredential(), false);
                    step = "SERVICE_BIND";
                } else if (asUser) {
                    return new InspectResult(false, "NO_SERVICE",
                            "هذا الدليل يبحث بحساب خدمة؛ هيّئ حساب خدمة لعرض سجل مستخدم آخر.", null, null, java.util.List.of());
                } else {
                    return new InspectResult(false, "NO_SERVICE",
                            "لا يوجد حساب خدمة: اكتب كلمة مرور المستخدم التجريبي ليُقرأ سجله بحسابه، أو هيّئ حساب خدمة.",
                            null, null, java.util.List.of());
                }
            } catch (DirectoryException e) {
                return inspectFailure(e);
            }
            try {
                SearchResult entry = entryAllAttributes(ctx, target);
                java.util.List<InspectAttr> attrs = readAll(entry.getAttributes());
                String display = null;
                for (InspectAttr at : attrs) {
                    if (at.name().equalsIgnoreCase("displayName") && !at.values().isEmpty()) {
                        display = at.values().get(0);
                        break;
                    }
                    if (display == null && at.name().equalsIgnoreCase("cn") && !at.values().isEmpty()) {
                        display = at.values().get(0);
                    }
                }
                return new InspectResult(true, step, "قُرئ سجل المستخدم من الدليل.", entry.getNameInNamespace(), display, attrs);
            } catch (DirectoryException e) {
                return inspectFailure(e);
            } catch (NamingException e) {
                return new InspectResult(false, "ERROR", "خطأ من الدليل: " + e.getMessage(), null, null, java.util.List.of());
            } finally {
                close(ctx);
            }
        } finally {
            TESTING.remove();
        }
    }

    private static InspectResult inspectFailure(DirectoryException e) {
        String message = switch (e.failure()) {
            case INVALID_CREDENTIALS -> "رفض الدليل اسم المستخدم أو كلمة المرور، أو لا يوجد سجل بهذا الاسم.";
            case AMBIGUOUS -> "اسم المستخدم يطابق أكثر من سجل في الدليل.";
            case TLS -> "رُفض الاتصال المؤمَّن: الشهادة غير موثوقة أو اسم الخادم لا يطابقها.";
            case NOT_CONFIGURED -> "الإعدادات غير مكتملة.";
            case UNAVAILABLE -> "تعذر الوصول إلى الدليل (العنوان، المنفذ أو الجدار الناري).";
        };
        String cause = e.getCause() == null ? null : e.getCause().getMessage();
        return new InspectResult(false, e.failure().name(), cause == null ? message : message + " — " + cause.replaceAll("[\\r\\n]+", " "),
                null, null, java.util.List.of());
    }

    /** Exactly one entry for {@code login} under the users DN, with every attribute returned (not only the mapped ones). */
    private SearchResult entryAllAttributes(LdapContext ctx, String login) throws NamingException, DirectoryException {
        boolean ad = props().upnSuffix() != null;
        String filter;
        Object[] args;
        if (ad) {
            filter = "(&(objectClass=" + props().userObjectClass() + ")(|(sAMAccountName={0})(userPrincipalName={1})))";
            args = new Object[]{login, login + "@" + props().upnSuffix()};
        } else {
            filter = "(&(objectClass=" + props().userObjectClass() + ")(" + props().usernameAttribute() + "={0}))";
            args = new Object[]{login};
        }
        SearchControls controls = new SearchControls();
        controls.setSearchScope(SearchControls.SUBTREE_SCOPE);
        controls.setCountLimit(2);
        controls.setTimeLimit(props().readTimeoutMs());
        controls.setReturningAttributes(null); // every attribute the entry carries
        NamingEnumeration<SearchResult> results = ctx.search(props().usersDn(), filter, args, controls);
        SearchResult first = null;
        int count = 0;
        try {
            while (results.hasMore()) {
                SearchResult r = results.next();
                count++;
                if (first == null) {
                    first = r;
                }
            }
        } catch (javax.naming.SizeLimitExceededException e) {
            count = 2;
        } catch (javax.naming.PartialResultException e) {
            // Active Directory continuation references after this domain's entries (as in search()); ignored.
        }
        if (count == 0) {
            throw invalid();
        }
        if (count > 1) {
            throw new DirectoryException(Failure.AMBIGUOUS, "more than one directory entry for the login name", null);
        }
        return first;
    }

    /** Every attribute of an entry as text (binary values as hex), name-sorted, with caps so a preview cannot dump a huge blob. */
    private static java.util.List<InspectAttr> readAll(Attributes a) throws NamingException {
        java.util.List<InspectAttr> out = new java.util.ArrayList<>();
        NamingEnumeration<? extends Attribute> e = a.getAll();
        int attrs = 0;
        while (e.hasMore() && attrs < 120) {
            Attribute at = e.next();
            attrs++;
            java.util.List<String> values = new java.util.ArrayList<>();
            boolean binary = false;
            for (int i = 0; i < at.size() && i < 25; i++) {
                Object v = at.get(i);
                if (v instanceof byte[] b) {
                    binary = true;
                    values.add(capValue(HexFormat.of().formatHex(b)));
                } else {
                    values.add(capValue(String.valueOf(v)));
                }
            }
            if (at.size() > 25) {
                values.add("… (" + at.size() + ")");
            }
            out.add(new InspectAttr(at.getID(), values, binary));
        }
        out.sort(java.util.Comparator.comparing(x -> x.name().toLowerCase(Locale.ROOT)));
        return out;
    }

    private static String capValue(String s) {
        String t = s == null ? "" : s;
        return t.length() > 512 ? t.substring(0, 512) + "…" : t;
    }

    /**
     * The mapped {@link DirectoryUser} for {@code login} (connecting the user to the app, ADR-092 companion). Binds as the user
     * when a password is given and a bind name is known (direct or AD), otherwise the read-only service account searches. Reads
     * only the mapped attributes; nothing is stored.
     */
    public DirectoryUser read(LdapProperties p, String login, String password) throws DirectoryException {
        TESTING.set(p);
        try {
            if (!p.configured()) {
                throw new DirectoryException(Failure.NOT_CONFIGURED, "directory not configured", null);
            }
            if (login == null || login.isBlank()) {
                throw invalid();
            }
            String target = bare(login.trim());
            if (!DIRECT_LOGIN.matcher(target).matches()) {
                throw invalid();
            }
            boolean asUser = password != null && !password.isEmpty() && password.length() <= 1024;
            if (asUser && (p.direct() || p.upnSuffix() != null)) {
                return authenticate(target, password);
            }
            if (p.bindDn() != null && p.bindCredential() != null) {
                LdapContext ctx = connect(p.bindDn(), p.bindCredential(), false);
                try {
                    SearchResult entry = props().upnSuffix() != null ? uniqueAd(ctx, target, target + "@" + props().upnSuffix())
                            : unique(ctx, props().usernameAttribute(), target);
                    return user(entry);
                } catch (NamingException e) {
                    throw translate(e);
                } finally {
                    close(ctx);
                }
            }
            throw new DirectoryException(Failure.NOT_CONFIGURED, "no service account and no user password to read the entry", null);
        } finally {
            TESTING.remove();
        }
    }

    /** The protected channel with no credentials: LDAPS handshake, or StartTLS negotiated over the plain connection. */
    private LdapContext open(LdapProperties p, SSLContext ssl) throws DirectoryException, NamingException {
        String url = p.url().trim();
        boolean ldaps = url.toLowerCase(Locale.ROOT).startsWith("ldaps://");
        Hashtable<String, Object> env = new Hashtable<>();
        env.put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.ldap.LdapCtxFactory");
        env.put(Context.PROVIDER_URL, url);
        env.put(Context.REFERRAL, "ignore");
        env.put("com.sun.jndi.ldap.connect.timeout", String.valueOf(p.connectTimeoutMs()));
        env.put("com.sun.jndi.ldap.read.timeout", String.valueOf(p.readTimeoutMs()));
        env.put("com.sun.jndi.ldap.connect.pool", "false");
        env.put(Context.SECURITY_AUTHENTICATION, "none");
        LdapContext ctx = null;
        try {
            if (ldaps) {
                env.put("java.naming.ldap.factory.socket", TrustedSocketFactory.class.getName());
                TrustedSocketFactory.CURRENT.set(ssl);
                try {
                    return new InitialLdapContext(env, null);
                } finally {
                    TrustedSocketFactory.CURRENT.remove();
                }
            }
            ctx = new InitialLdapContext(env, null);
            StartTlsResponse tls = (StartTlsResponse) ctx.extendedOperation(new StartTlsRequest());
            tls.negotiate(new TrustedSocketFactory(ssl));
            return ctx;
        } catch (IOException e) {
            close(ctx);
            throw new DirectoryException(Failure.TLS, "TLS negotiation with the directory failed", e);
        } catch (NamingException e) {
            close(ctx);
            throw translate(e);
        }
    }

    public enum Failure { NOT_CONFIGURED, INVALID_CREDENTIALS, AMBIGUOUS, TLS, UNAVAILABLE }

    public static final class DirectoryException extends Exception {
        private final Failure failure;

        DirectoryException(Failure failure, String message, Throwable cause) {
            super(message, cause);
            this.failure = failure;
        }

        public Failure failure() {
            return failure;
        }
    }

    /**
     * The directory entry of a verified person. {@code uuid} is the stable identifier used for the identity link; {@code profile}
     * what the entry states about the person's employment, from the attributes the installation names (ADR-068).
     */
    public record DirectoryUser(String dn, String uuid, String username, String employeeNumber, String displayName,
                                DirectoryProfile profile) {

        public DirectoryUser(String dn, String uuid, String username, String employeeNumber, String displayName) {
            this(dn, uuid, username, employeeNumber, displayName, new DirectoryProfile(employeeNumber, null, null, null, null, null, false));
        }
    }

    public boolean configured() {
        return props().configured();
    }

    public String issuer() {
        return props().issuer();
    }

    /** Verifies the password of the entry whose login attribute equals {@code username}. */
    public DirectoryUser authenticate(String username, String password) throws DirectoryException {
        if (username == null || username.isBlank() || username.length() > 128 || username.chars().anyMatch(c -> c < 0x20)) {
            throw invalid();
        }
        if (props().direct()) {
            return direct(bare(username.trim()), password);
        }
        return verify(props().usernameAttribute(), username.trim(), password);
    }

    /**
     * Re-verifies the password of a linked person (step-up before approval). Service search: the entry is found by the stable
     * identifier. Direct bind: the person binds again with the linked login, and the entry found must carry the linked stable
     * identifier; any other entry is a refusal.
     */
    public DirectoryUser reauthenticate(String uuid, String login, String password) throws DirectoryException {
        if (uuid == null || uuid.isBlank()) {
            throw invalid();
        }
        if (props().direct()) {
            if (login == null || login.isBlank() || login.length() > 128) {
                throw invalid();
            }
            DirectoryUser user = direct(bare(login.trim()), password);
            if (!user.uuid().equalsIgnoreCase(uuid.trim())) {
                log.warn("Directory step-up refused: the linked login now names another directory entry");
                throw invalid();
            }
            return user;
        }
        return verify(props().uuidAttribute(), uuid, password);
    }

    /** How a directory lookup before a first sign-in could be made here (ADR-105). */
    public enum LookupMode { SERVICE_ACCOUNT, OWN_ACCOUNT, UNAVAILABLE }

    /**
     * Which lookup the directory in force allows: its read-only service account when one is configured; otherwise (direct bind,
     * ADR-100: no service account) only a search made with the administrator's own directory account, whose password the
     * administrator types for that one search; a directory that is not configured allows none.
     */
    public LookupMode lookupMode() {
        LdapProperties p = props();
        if (!p.configured()) {
            return LookupMode.UNAVAILABLE;
        }
        if (p.bindDn() != null && p.bindCredential() != null) {
            return LookupMode.SERVICE_ACCOUNT;
        }
        return p.direct() ? LookupMode.OWN_ACCOUNT : LookupMode.UNAVAILABLE;
    }

    /**
     * Finds exactly one directory entry for {@code targetLogin} before that person ever signed in (ADR-105), for an administrator
     * who must confirm who it is. With a service account: that account's read-only search. Without one: the administrator's own
     * bind ({@code asLogin}/{@code asPassword}, their linked login), whose entry must still carry the administrator's linked stable
     * identifier {@code asUuid}; then the same authenticated connection searches. Nothing is stored; the password is used for this
     * bind only. Null when the directory holds no entry for the login; several entries is a refusal.
     */
    public DirectoryUser lookup(String targetLogin, String asLogin, String asUuid, String asPassword) throws DirectoryException {
        if (targetLogin == null || !DIRECT_LOGIN.matcher(targetLogin.trim()).matches()) {
            throw invalid();
        }
        String target = bare(targetLogin.trim().toLowerCase(Locale.ROOT));
        LookupMode mode = lookupMode();
        if (mode == LookupMode.UNAVAILABLE) {
            throw new DirectoryException(Failure.NOT_CONFIGURED, "no directory lookup available", null);
        }
        checkAttributes(props().usernameAttribute());
        LdapContext ctx;
        if (mode == LookupMode.SERVICE_ACCOUNT) {
            ctx = connect(props().bindDn(), props().bindCredential(), false);
        } else {
            if (asLogin == null || asUuid == null || asPassword == null || asPassword.isEmpty() || asPassword.length() > 1024) {
                throw invalid();
            }
            String own = bare(asLogin.trim());
            if (!DIRECT_LOGIN.matcher(own).matches()) {
                throw invalid();
            }
            String principal = props().directBindPattern().replace(LdapProperties.USERNAME_MARKER, own);
            ctx = connect(principal, asPassword, true);
            try {
                SearchResult self = props().upnSuffix() != null ? uniqueAd(ctx, own, principal) : unique(ctx, props().usernameAttribute(), own);
                if (!user(self).uuid().equalsIgnoreCase(asUuid.trim())) {
                    log.warn("Directory lookup refused: the administrator's login now names another directory entry");
                    close(ctx);
                    throw invalid();
                }
            } catch (NamingException e) {
                close(ctx);
                throw translate(e);
            }
        }
        try {
            SearchResult entry;
            try {
                entry = props().upnSuffix() != null ? uniqueAd(ctx, target, target + "@" + props().upnSuffix())
                        : unique(ctx, props().usernameAttribute(), target);
            } catch (DirectoryException e) {
                if (e.failure() == Failure.INVALID_CREDENTIALS) {
                    return null; // the administrator's bind succeeded: no entry for this login
                }
                throw e;
            }
            return user(entry);
        } catch (NamingException e) {
            throw translate(e);
        } finally {
            close(ctx);
        }
    }

    /**
     * Direct user bind (ADR-070): the person's own bind over the protected channel, then, on that same authenticated
     * connection, exactly one entry for the login under the users DN.
     */
    private DirectoryUser direct(String username, String password) throws DirectoryException {
        if (!props().configured()) {
            throw new DirectoryException(Failure.NOT_CONFIGURED, "directory not configured", null);
        }
        // An empty password would be an unauthenticated bind, which many directories accept: never attempted.
        if (password == null || password.isEmpty() || password.length() > 1024) {
            throw invalid();
        }
        if (!DIRECT_LOGIN.matcher(username).matches()) {
            throw invalid();
        }
        checkAttributes(props().usernameAttribute());
        String principal = props().directBindPattern().replace(LdapProperties.USERNAME_MARKER, username);
        LdapContext ctx = connect(principal, password, true);
        try {
            SearchResult entry = props().upnSuffix() != null ? uniqueAd(ctx, username, principal)
                    : unique(ctx, props().usernameAttribute(), username);
            LdapName bound = dn(principal);
            if (bound != null && !bound.equals(dn(entry.getNameInNamespace()))) {
                // a DN pattern: the entry found for the login must be the entry that has just authenticated
                log.warn("Directory direct bind refused: the entry found for the login is not the bound entry");
                throw invalid();
            }
            return user(entry);
        } catch (NamingException e) {
            throw translate(e);
        } finally {
            close(ctx);
        }
    }

    /** Service search (ADR-016): the read-only account finds exactly one entry, then the person binds as that entry. */
    private DirectoryUser verify(String attribute, String value, String password) throws DirectoryException {
        if (!props().configured() || props().bindDn() == null || props().bindCredential() == null) {
            throw new DirectoryException(Failure.NOT_CONFIGURED, "directory not configured", null);
        }
        // An empty password would be an unauthenticated bind, which many directories accept: never allowed.
        if (password == null || password.isEmpty() || password.length() > 1024) {
            throw invalid();
        }
        checkAttributes(attribute);
        DirectoryUser user;
        LdapContext service = connect(props().bindDn(), props().bindCredential(), false);
        try {
            user = user(unique(service, attribute, value));
        } catch (NamingException e) {
            throw translate(e);
        } finally {
            close(service);
        }
        close(connect(user.dn(), password, true)); // the person's own bind: succeeds only with the right password
        return user;
    }

    private void checkAttributes(String attribute) throws DirectoryException {
        for (String a : new String[]{attribute, props().userObjectClass(), props().uuidAttribute(), props().usernameAttribute(),
                props().employeeNumberAttribute()}) {
            if (a == null || !ATTRIBUTE.matcher(a).matches()) {
                throw new DirectoryException(Failure.NOT_CONFIGURED, "invalid directory attribute configuration", null);
            }
        }
    }

    /**
     * The login a person typed, as the {@code {username}@domain} pattern needs it (ADR-100): {@code DOMAIN&#92;user} and
     * {@code user@domain} (this directory's domain) are the same person as {@code user}. Other patterns: unchanged.
     */
    private String bare(String login) {
        String suffix = props().upnSuffix();
        if (suffix == null) {
            return login;
        }
        int slash = login.lastIndexOf('\\');
        String l = slash >= 0 ? login.substring(slash + 1) : login;
        int at = l.lastIndexOf('@');
        return at > 0 && l.substring(at + 1).equalsIgnoreCase(suffix) ? l.substring(0, at) : l;
    }

    /**
     * Active Directory after the person's own {@code user@domain} bind (ADR-100): their one entry, found by the configured login
     * attribute, by {@code sAMAccountName} or by the {@code userPrincipalName} they bound with, of the configured class or any
     * {@code person} (AD's user class descends from it). An installation still on the standard directory's names
     * ({@code uid}, {@code inetOrgPerson}) therefore finds AD's entries too, instead of refusing every correct password.
     */
    private SearchResult uniqueAd(LdapContext ctx, String login, String principal) throws NamingException, DirectoryException {
        String filter = "(&(|(objectClass=" + props().userObjectClass() + ")(objectClass=person))(|(" + props().usernameAttribute()
                + "={0})(sAMAccountName={0})(userPrincipalName={1})))";
        return search(ctx, filter, new Object[]{login, principal});
    }

    /** Exactly one entry of the configured class whose {@code attribute} equals {@code value}; none or several is a refusal. */
    private SearchResult unique(LdapContext ctx, String attribute, String value) throws NamingException, DirectoryException {
        String filter = "(&(objectClass=" + props().userObjectClass() + ")(" + attribute + "={0}))";
        // Active Directory's objectGUID is binary: it is kept as hex text and searched with its bytes.
        Object arg;
        try {
            arg = binaryUuid() && attribute.equalsIgnoreCase(props().uuidAttribute()) ? HexFormat.of().parseHex(value) : value;
        } catch (IllegalArgumentException e) {
            throw invalid();
        }
        return search(ctx, filter, new Object[]{arg});
    }

    /** Exactly one entry for {@code filter} under the users DN; none or several is a refusal. */
    private SearchResult search(LdapContext ctx, String filter, Object[] args) throws NamingException, DirectoryException {
        SearchControls controls = new SearchControls();
        controls.setSearchScope(SearchControls.SUBTREE_SCOPE);
        controls.setCountLimit(2);
        controls.setTimeLimit(props().readTimeoutMs());
        java.util.List<String> returning = new java.util.ArrayList<>(java.util.List.of(props().uuidAttribute(), props().usernameAttribute(),
                props().employeeNumberAttribute(), "displayName", "cn"));
        if (props().upnSuffix() != null) {
            returning.addAll(AD_NAMES);
        }
        returning.addAll(props().employmentAttributes());
        controls.setReturningAttributes(returning.stream().distinct().toArray(String[]::new));
        NamingEnumeration<SearchResult> results = ctx.search(props().usersDn(), filter, args, controls);
        SearchResult first = null;
        int count = 0;
        try {
            while (results.hasMore()) {
                SearchResult r = results.next();
                count++;
                if (first == null) {
                    first = r;
                }
            }
        } catch (javax.naming.SizeLimitExceededException e) {
            count = 2;
        } catch (javax.naming.PartialResultException e) {
            // Active Directory searched from the domain root (MOVER's LDAP_BASE_DN, DC=…,DC=…) adds continuation references to its
            // other partitions (DomainDnsZones, ForestDnsZones, Configuration); with referrals ignored JNDI raises this after
            // this domain's entries, which are the answer (as Spring LDAP's ignorePartialResultException for AD). Found on
            // MOVER's Samba AD, 17 Nov 2026 (ADR-079).
        }
        if (count == 0) {
            throw invalid();
        }
        if (count > 1) {
            throw new DirectoryException(Failure.AMBIGUOUS, "more than one directory entry for the login name", null);
        }
        return first;
    }

    /** The verified person as the entry states them; an entry without its stable identifier or login is refused. */
    private DirectoryUser user(SearchResult entry) throws NamingException, DirectoryException {
        Attributes a = entry.getAttributes();
        boolean ad = props().upnSuffix() != null;
        String uuid = text(a.get(props().uuidAttribute()));
        if (uuid == null && ad) {
            // ADR-100: AD's own stable identifier when the configured one is not on the entry (e.g. entryUUID left from .env)
            uuid = text(a.get("objectGUID"));
            uuid = uuid != null ? uuid : text(a.get("entryUUID"));
        }
        if (uuid == null) {
            throw new DirectoryException(Failure.UNAVAILABLE, "directory entry has no stable identifier", null);
        }
        String login = lower(text(a.get(props().usernameAttribute())));
        if (login == null && ad) {
            login = lower(text(a.get("sAMAccountName")));
        }
        if (login == null) {
            throw new DirectoryException(Failure.UNAVAILABLE, "directory entry has no readable login", null);
        }
        String employeeNumber = text(a.get(props().employeeNumberAttribute()));
        DirectoryProfile profile = new DirectoryProfile(employeeNumber, optional(a, props().rankAttribute()),
                optional(a, props().positionAttribute()), optional(a, props().unitIdAttribute()), optional(a, props().unitNameAttribute()),
                optional(a, props().mainUnitIdAttribute()), !props().employmentAttributes().isEmpty());
        return new DirectoryUser(entry.getNameInNamespace(), uuid, login, employeeNumber,
                text(a.get("displayName")) != null ? text(a.get("displayName")) : text(a.get("cn")), profile);
    }

    /** A DN-shaped bind name (null for a UPN or another name that is not a DN). */
    private static LdapName dn(String name) {
        if (name == null || name.indexOf('=') < 0) {
            return null;
        }
        try {
            return new LdapName(name);
        } catch (javax.naming.InvalidNameException e) {
            return null;
        }
    }

    /** {@code person}: the bind is the person's own, so a name the directory does not hold is the uniform wrong-credentials answer. */
    private LdapContext connect(String principal, String credential, boolean person) throws DirectoryException {
        String url = props().url().trim();
        boolean ldaps = url.toLowerCase(Locale.ROOT).startsWith("ldaps://");
        Hashtable<String, Object> env = new Hashtable<>();
        env.put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.ldap.LdapCtxFactory");
        env.put(Context.PROVIDER_URL, url);
        env.put(Context.REFERRAL, "ignore");
        env.put("com.sun.jndi.ldap.connect.timeout", String.valueOf(props().connectTimeoutMs()));
        env.put("com.sun.jndi.ldap.read.timeout", String.valueOf(props().readTimeoutMs()));
        env.put("com.sun.jndi.ldap.connect.pool", "false");
        if (binaryUuid() || props().upnSuffix() != null) {
            env.put("java.naming.ldap.attributes.binary", binaryUuid() ? props().uuidAttribute() : "objectGUID");
        }
        LdapContext ctx = null;
        try {
            SSLContext ssl = sslContext();
            if (ldaps) {
                env.put("java.naming.ldap.factory.socket", TrustedSocketFactory.class.getName());
                env.put(Context.SECURITY_AUTHENTICATION, "simple");
                env.put(Context.SECURITY_PRINCIPAL, principal);
                env.put(Context.SECURITY_CREDENTIALS, credential);
                // JNDI creates the socket on this thread, inside the constructor, through TrustedSocketFactory.getDefault()
                TrustedSocketFactory.CURRENT.set(ssl);
                try {
                    return new InitialLdapContext(env, null);
                } finally {
                    TrustedSocketFactory.CURRENT.remove();
                }
            }
            // StartTLS: connect without credentials, secure the channel (host name checked by JSSE), then bind.
            env.put(Context.SECURITY_AUTHENTICATION, "none");
            ctx = new InitialLdapContext(env, null);
            StartTlsResponse tls = (StartTlsResponse) ctx.extendedOperation(new StartTlsRequest());
            tls.negotiate(new TrustedSocketFactory(ssl));
            ctx.addToEnvironment(Context.SECURITY_AUTHENTICATION, "simple");
            ctx.addToEnvironment(Context.SECURITY_PRINCIPAL, principal);
            ctx.addToEnvironment(Context.SECURITY_CREDENTIALS, credential);
            ctx.reconnect(null);
            return ctx;
        } catch (IOException e) {
            close(ctx);
            log.warn("Directory TLS negotiation failed: {}", e.getMessage());
            throw new DirectoryException(Failure.TLS, "TLS negotiation with the directory failed", e);
        } catch (NameNotFoundException e) {
            close(ctx);
            throw person ? invalid() : translate(e);
        } catch (NamingException e) {
            close(ctx);
            throw translate(e);
        }
    }

    private DirectoryException translate(NamingException e) {
        if (e instanceof AuthenticationException) {
            return invalid();
        }
        Throwable root = e.getRootCause() != null ? e.getRootCause() : e.getCause();
        for (Throwable t = root; t != null; t = t.getCause()) {
            if (t instanceof SSLHandshakeException || t instanceof javax.net.ssl.SSLException
                    || t instanceof java.security.cert.CertificateException) {
                log.warn("Directory certificate refused: {}", t.getMessage());
                return new DirectoryException(Failure.TLS, "directory certificate not trusted", e);
            }
        }
        if (e instanceof CommunicationException || e instanceof ServiceUnavailableException
                || e instanceof javax.naming.TimeLimitExceededException) {
            log.warn("Directory unreachable: {}", e.getMessage());
            return new DirectoryException(Failure.UNAVAILABLE, "directory unreachable", e);
        }
        log.warn("Directory error: {}", e.getMessage());
        return new DirectoryException(Failure.UNAVAILABLE, "directory error", e);
    }

    private static DirectoryException invalid() {
        return new DirectoryException(Failure.INVALID_CREDENTIALS, "invalid credentials", null);
    }

    /** Trust exactly the PEM certificates of the CA folder and the pasted ones (ADR-092); nothing else. */
    private SSLContext sslContext() throws DirectoryException {
        try {
            LdapProperties p = props();
            return Trust.only(Path.of(p.caDir()), p.caCertificatesPem());
        } catch (IOException | GeneralSecurityException | IllegalArgumentException e) {
            throw new DirectoryException(Failure.TLS, "CA certificates could not be loaded", e);
        }
    }

    private boolean binaryUuid() {
        return "objectGUID".equalsIgnoreCase(props().uuidAttribute());
    }

    private static String text(Attribute a) throws NamingException {
        if (a == null || a.size() == 0) {
            return null;
        }
        Object v = a.get();
        if (v instanceof byte[] b) {
            return HexFormat.of().formatHex(b);
        }
        String s = String.valueOf(v).trim();
        return s.isEmpty() ? null : s;
    }

    /** An employment attribute the installation names (null: not read). A binary value is never one of them. */
    private static String optional(Attributes a, String attribute) throws NamingException {
        if (attribute == null) {
            return null;
        }
        Attribute v = a.get(attribute);
        return v == null || v.size() == 0 || v.get() instanceof byte[] ? null : text(v);
    }

    private static String lower(String s) {
        return s == null ? null : s.toLowerCase(Locale.ROOT);
    }

    private static void close(LdapContext ctx) {
        if (ctx != null) {
            try {
                ctx.close();
            } catch (NamingException ignored) {
                // connection already gone
            }
        }
    }

    /**
     * Socket factory over the configured trust, for LDAPS (JNDI instantiates it through {@code getDefault()}) and for the
     * StartTLS wrapping socket. Every SSL socket it makes has JSSE endpoint identification switched on, so the directory's
     * certificate must name the host that was dialled.
     */
    public static final class TrustedSocketFactory extends SSLSocketFactory {
        /** The trust of the LDAPS connection being opened on this thread. */
        static final ThreadLocal<SSLContext> CURRENT = new ThreadLocal<>();
        private final SSLSocketFactory delegate;

        TrustedSocketFactory(SSLContext context) {
            this.delegate = context.getSocketFactory();
        }

        public static SocketFactory getDefault() {
            SSLContext context = CURRENT.get();
            if (context == null) {
                throw new IllegalStateException("no directory trust for this connection");
            }
            return new TrustedSocketFactory(context);
        }

        private static Socket identified(Socket socket) {
            if (socket instanceof SSLSocket ssl) {
                SSLParameters parameters = ssl.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(parameters);
            }
            return socket;
        }

        @Override
        public Socket createSocket() throws IOException {
            return identified(delegate.createSocket());
        }

        @Override
        public Socket createSocket(String host, int port) throws IOException {
            return identified(delegate.createSocket(host, port));
        }

        @Override
        public Socket createSocket(String host, int port, InetAddress localHost, int localPort) throws IOException {
            return identified(delegate.createSocket(host, port, localHost, localPort));
        }

        @Override
        public Socket createSocket(InetAddress host, int port) throws IOException {
            return identified(delegate.createSocket(host, port));
        }

        @Override
        public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException {
            return identified(delegate.createSocket(address, port, localAddress, localPort));
        }

        /** The StartTLS layer over the plain connection: {@code host} is the name dialled, checked against the certificate. */
        @Override
        public Socket createSocket(Socket socket, String host, int port, boolean autoClose) throws IOException {
            return identified(delegate.createSocket(socket, host, port, autoClose));
        }

        @Override
        public String[] getDefaultCipherSuites() {
            return delegate.getDefaultCipherSuites();
        }

        @Override
        public String[] getSupportedCipherSuites() {
            return delegate.getSupportedCipherSuites();
        }
    }
}
