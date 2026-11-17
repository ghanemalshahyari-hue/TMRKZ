package ae.mover.security;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
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
import javax.net.ssl.TrustManagerFactory;

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
    /**
     * A login that may be placed in a direct-bind pattern: letters, digits, dot, hyphen and underscore only, so it can change
     * neither a DN nor a UPN (nothing to escape, nothing to inject); anything else is the uniform wrong-credentials answer.
     */
    private static final Pattern DIRECT_LOGIN = Pattern.compile("^[\\p{L}\\p{N}][\\p{L}\\p{N}._-]{0,127}$");

    private final LdapProperties props;

    public DirectoryAuthenticator(LdapProperties props) {
        this.props = props;
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
        return props.configured();
    }

    public String issuer() {
        return props.issuer();
    }

    /** Verifies the password of the entry whose login attribute equals {@code username}. */
    public DirectoryUser authenticate(String username, String password) throws DirectoryException {
        if (username == null || username.isBlank() || username.length() > 128 || username.chars().anyMatch(c -> c < 0x20)) {
            throw invalid();
        }
        if (props.direct()) {
            return direct(username.trim(), password);
        }
        return verify(props.usernameAttribute(), username.trim(), password);
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
        if (props.direct()) {
            if (login == null || login.isBlank() || login.length() > 128) {
                throw invalid();
            }
            DirectoryUser user = direct(login.trim(), password);
            if (!user.uuid().equalsIgnoreCase(uuid.trim())) {
                log.warn("Directory step-up refused: the linked login now names another directory entry");
                throw invalid();
            }
            return user;
        }
        return verify(props.uuidAttribute(), uuid, password);
    }

    /**
     * Direct user bind (ADR-070): the person's own bind over the protected channel, then, on that same authenticated
     * connection, exactly one entry for the login under the users DN.
     */
    private DirectoryUser direct(String username, String password) throws DirectoryException {
        if (!props.configured()) {
            throw new DirectoryException(Failure.NOT_CONFIGURED, "directory not configured", null);
        }
        // An empty password would be an unauthenticated bind, which many directories accept: never attempted.
        if (password == null || password.isEmpty() || password.length() > 1024) {
            throw invalid();
        }
        if (!DIRECT_LOGIN.matcher(username).matches()) {
            throw invalid();
        }
        checkAttributes(props.usernameAttribute());
        String principal = props.directBindPattern().replace(LdapProperties.USERNAME_MARKER, username);
        LdapContext ctx = connect(principal, password, true);
        try {
            SearchResult entry = unique(ctx, props.usernameAttribute(), username);
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
        if (!props.configured() || props.bindDn() == null || props.bindCredential() == null) {
            throw new DirectoryException(Failure.NOT_CONFIGURED, "directory not configured", null);
        }
        // An empty password would be an unauthenticated bind, which many directories accept: never allowed.
        if (password == null || password.isEmpty() || password.length() > 1024) {
            throw invalid();
        }
        checkAttributes(attribute);
        DirectoryUser user;
        LdapContext service = connect(props.bindDn(), props.bindCredential(), false);
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
        for (String a : new String[]{attribute, props.userObjectClass(), props.uuidAttribute(), props.usernameAttribute(),
                props.employeeNumberAttribute()}) {
            if (a == null || !ATTRIBUTE.matcher(a).matches()) {
                throw new DirectoryException(Failure.NOT_CONFIGURED, "invalid directory attribute configuration", null);
            }
        }
    }

    /** Exactly one entry of the configured class whose {@code attribute} equals {@code value}; none or several is a refusal. */
    private SearchResult unique(LdapContext ctx, String attribute, String value) throws NamingException, DirectoryException {
        SearchControls controls = new SearchControls();
        controls.setSearchScope(SearchControls.SUBTREE_SCOPE);
        controls.setCountLimit(2);
        controls.setTimeLimit(props.readTimeoutMs());
        java.util.List<String> returning = new java.util.ArrayList<>(java.util.List.of(props.uuidAttribute(), props.usernameAttribute(),
                props.employeeNumberAttribute(), "displayName", "cn"));
        returning.addAll(props.employmentAttributes());
        controls.setReturningAttributes(returning.stream().distinct().toArray(String[]::new));
        String filter = "(&(objectClass=" + props.userObjectClass() + ")(" + attribute + "={0}))";
        // Active Directory's objectGUID is binary: it is kept as hex text and searched with its bytes.
        Object arg;
        try {
            arg = binaryUuid() && attribute.equalsIgnoreCase(props.uuidAttribute()) ? HexFormat.of().parseHex(value) : value;
        } catch (IllegalArgumentException e) {
            throw invalid();
        }
        NamingEnumeration<SearchResult> results = ctx.search(props.usersDn(), filter, new Object[]{arg}, controls);
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
        String uuid = text(a.get(props.uuidAttribute()));
        if (uuid == null) {
            throw new DirectoryException(Failure.UNAVAILABLE, "directory entry has no stable identifier", null);
        }
        String login = lower(text(a.get(props.usernameAttribute())));
        if (login == null) {
            throw new DirectoryException(Failure.UNAVAILABLE, "directory entry has no readable login", null);
        }
        String employeeNumber = text(a.get(props.employeeNumberAttribute()));
        DirectoryProfile profile = new DirectoryProfile(employeeNumber, optional(a, props.rankAttribute()),
                optional(a, props.positionAttribute()), optional(a, props.unitIdAttribute()), optional(a, props.unitNameAttribute()),
                optional(a, props.mainUnitIdAttribute()), !props.employmentAttributes().isEmpty());
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
        String url = props.url().trim();
        boolean ldaps = url.toLowerCase(Locale.ROOT).startsWith("ldaps://");
        Hashtable<String, Object> env = new Hashtable<>();
        env.put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.ldap.LdapCtxFactory");
        env.put(Context.PROVIDER_URL, url);
        env.put(Context.REFERRAL, "ignore");
        env.put("com.sun.jndi.ldap.connect.timeout", String.valueOf(props.connectTimeoutMs()));
        env.put("com.sun.jndi.ldap.read.timeout", String.valueOf(props.readTimeoutMs()));
        env.put("com.sun.jndi.ldap.connect.pool", "false");
        if (binaryUuid()) {
            env.put("java.naming.ldap.attributes.binary", props.uuidAttribute());
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

    /** Trust exactly the PEM certificates in the CA folder; an empty folder trusts nothing. */
    private SSLContext sslContext() throws DirectoryException {
        try {
            KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
            store.load(null, null);
            Path dir = Path.of(props.caDir());
            int n = 0;
            if (Files.isDirectory(dir)) {
                CertificateFactory cf = CertificateFactory.getInstance("X.509");
                try (DirectoryStream<Path> files = Files.newDirectoryStream(dir, "*.{pem,crt,cer}")) {
                    for (Path f : files) {
                        try (InputStream in = Files.newInputStream(f)) {
                            for (Certificate c : cf.generateCertificates(in)) {
                                store.setCertificateEntry("ca-" + (n++), c);
                            }
                        }
                    }
                }
            }
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(store);
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, tmf.getTrustManagers(), null);
            return ctx;
        } catch (IOException | GeneralSecurityException e) {
            throw new DirectoryException(Failure.TLS, "CA certificates could not be loaded", e);
        }
    }

    private boolean binaryUuid() {
        return "objectGUID".equalsIgnoreCase(props.uuidAttribute());
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
