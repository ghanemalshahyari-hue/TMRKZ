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
import javax.naming.NamingEnumeration;
import javax.naming.NamingException;
import javax.naming.ServiceUnavailableException;
import javax.naming.directory.Attribute;
import javax.naming.directory.Attributes;
import javax.naming.directory.SearchControls;
import javax.naming.directory.SearchResult;
import javax.naming.ldap.InitialLdapContext;
import javax.naming.ldap.LdapContext;
import javax.naming.ldap.StartTlsRequest;
import javax.naming.ldap.StartTlsResponse;
import javax.net.SocketFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.TrustManagerFactory;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Verifies a username and password against the enterprise directory, as TNQL's manual sign-in does: a read-only service
 * account finds exactly one entry for the login name, then the person's own password is checked by binding as that entry.
 * Every connection is protected (LDAPS or StartTLS) and trusts only the CA certificates in the configured folder, with
 * host-name checking; credentials are never sent before the channel is secured. TMRKZ keeps no password.
 */
@Component
public class DirectoryAuthenticator {

    private static final Logger log = LoggerFactory.getLogger(DirectoryAuthenticator.class);
    private static final Pattern ATTRIBUTE = Pattern.compile("^[A-Za-z][A-Za-z0-9-]{0,63}$");
    /** SSL context used by {@link TrustedSocketFactory} for LDAPS connections (JNDI instantiates factories by class). */
    private static volatile SSLContext ldapsContext;

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

    /** The directory entry of a verified person. {@code uuid} is the stable identifier used for the identity link. */
    public record DirectoryUser(String dn, String uuid, String username, String employeeNumber, String displayName) {
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
        return verify(props.usernameAttribute(), username.trim(), password);
    }

    /** Re-verifies the password of a linked person, found by the stable identifier (step-up before approval). */
    public DirectoryUser reauthenticate(String uuid, String password) throws DirectoryException {
        return verify(props.uuidAttribute(), uuid, password);
    }

    private DirectoryUser verify(String attribute, String value, String password) throws DirectoryException {
        if (!props.configured()) {
            throw new DirectoryException(Failure.NOT_CONFIGURED, "directory not configured", null);
        }
        // An empty password would be an unauthenticated bind, which many directories accept: never allowed.
        if (password == null || password.isEmpty() || password.length() > 1024) {
            throw invalid();
        }
        if (!ATTRIBUTE.matcher(attribute).matches() || !ATTRIBUTE.matcher(props.userObjectClass()).matches()) {
            throw new DirectoryException(Failure.NOT_CONFIGURED, "invalid directory attribute configuration", null);
        }
        DirectoryUser user;
        LdapContext service = connect(props.bindDn(), props.bindCredential());
        try {
            SearchControls controls = new SearchControls();
            controls.setSearchScope(SearchControls.SUBTREE_SCOPE);
            controls.setCountLimit(2);
            controls.setTimeLimit(props.readTimeoutMs());
            controls.setReturningAttributes(new String[]{props.uuidAttribute(), props.usernameAttribute(),
                    props.employeeNumberAttribute(), "displayName", "cn"});
            String filter = "(&(objectClass=" + props.userObjectClass() + ")(" + attribute + "={0}))";
            // Active Directory's objectGUID is binary: it is kept as hex text and searched with its bytes.
            Object arg = binaryUuid() && attribute.equalsIgnoreCase(props.uuidAttribute()) ? HexFormat.of().parseHex(value) : value;
            NamingEnumeration<SearchResult> results = service.search(props.usersDn(), filter, new Object[]{arg}, controls);
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
            Attributes a = first.getAttributes();
            String uuid = text(a.get(props.uuidAttribute()));
            if (uuid == null) {
                throw new DirectoryException(Failure.UNAVAILABLE, "directory entry has no stable identifier", null);
            }
            user = new DirectoryUser(first.getNameInNamespace(), uuid, lower(text(a.get(props.usernameAttribute()))),
                    text(a.get(props.employeeNumberAttribute())),
                    text(a.get("displayName")) != null ? text(a.get("displayName")) : text(a.get("cn")));
        } catch (NamingException e) {
            throw translate(e);
        } finally {
            close(service);
        }
        close(connect(user.dn(), password)); // the person's own bind: succeeds only with the right password
        return user;
    }

    private LdapContext connect(String principal, String credential) throws DirectoryException {
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
                ldapsContext = ssl;
                env.put("java.naming.ldap.factory.socket", TrustedSocketFactory.class.getName());
                env.put(Context.SECURITY_AUTHENTICATION, "simple");
                env.put(Context.SECURITY_PRINCIPAL, principal);
                env.put(Context.SECURITY_CREDENTIALS, credential);
                return new InitialLdapContext(env, null);
            }
            // StartTLS: connect without credentials, secure the channel (host name checked), then bind.
            env.put(Context.SECURITY_AUTHENTICATION, "none");
            ctx = new InitialLdapContext(env, null);
            StartTlsResponse tls = (StartTlsResponse) ctx.extendedOperation(new StartTlsRequest());
            tls.negotiate(ssl.getSocketFactory());
            ctx.addToEnvironment(Context.SECURITY_AUTHENTICATION, "simple");
            ctx.addToEnvironment(Context.SECURITY_PRINCIPAL, principal);
            ctx.addToEnvironment(Context.SECURITY_CREDENTIALS, credential);
            ctx.reconnect(null);
            return ctx;
        } catch (IOException e) {
            close(ctx);
            log.warn("Directory TLS negotiation failed: {}", e.getMessage());
            throw new DirectoryException(Failure.TLS, "TLS negotiation with the directory failed", e);
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

    /** LDAPS socket factory over the configured trust (JNDI instantiates it through {@code getDefault()}). */
    public static final class TrustedSocketFactory extends SocketFactory {
        private final SocketFactory delegate = ldapsContext.getSocketFactory();

        public static SocketFactory getDefault() {
            return new TrustedSocketFactory();
        }

        @Override
        public Socket createSocket() throws IOException {
            return delegate.createSocket();
        }

        @Override
        public Socket createSocket(String host, int port) throws IOException {
            return delegate.createSocket(host, port);
        }

        @Override
        public Socket createSocket(String host, int port, InetAddress localHost, int localPort) throws IOException {
            return delegate.createSocket(host, port, localHost, localPort);
        }

        @Override
        public Socket createSocket(InetAddress host, int port) throws IOException {
            return delegate.createSocket(host, port);
        }

        @Override
        public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException {
            return delegate.createSocket(address, port, localAddress, localPort);
        }
    }
}
