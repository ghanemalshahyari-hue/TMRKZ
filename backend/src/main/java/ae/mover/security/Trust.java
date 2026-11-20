package ae.mover.security;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * The CA certificates TMRKZ trusts when it talks to the enterprise directory and to the automatic sign-in's Keycloak
 * (ADR-092): the PEM files of the mounted CA folder and the certificates pasted in «إعدادات التكامل». Only public
 * certificates: a pasted private key is refused. Host-name verification is the caller's (JSSE endpoint identification on
 * the directory sockets; the HTTP client checks it by itself).
 */
final class Trust {

    private Trust() {
    }

    /** The certificates of a PEM text (several, concatenated, are fine); empty text gives none; a key or garbage is refused. */
    static List<X509Certificate> parse(String pem) {
        if (pem == null || pem.isBlank()) {
            return List.of();
        }
        if (pem.contains("PRIVATE KEY")) {
            throw new IllegalArgumentException("a private key was pasted; only CA certificates are accepted");
        }
        if (!pem.contains("BEGIN CERTIFICATE")) {
            throw new IllegalArgumentException("no PEM certificate (-----BEGIN CERTIFICATE-----) in the text");
        }
        try {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            List<X509Certificate> out = new ArrayList<>();
            for (Certificate c : cf.generateCertificates(new ByteArrayInputStream(pem.getBytes(StandardCharsets.UTF_8)))) {
                out.add((X509Certificate) c);
            }
            if (out.isEmpty()) {
                throw new IllegalArgumentException("no certificate could be read from the text");
            }
            return out;
        } catch (CertificateException e) {
            throw new IllegalArgumentException("the pasted text is not a readable PEM certificate: " + e.getMessage(), e);
        }
    }

    /** Exactly the certificates of the folder's PEM files and of the pasted text; nothing else. */
    static KeyStore store(Path caDir, String pem) throws IOException, GeneralSecurityException {
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        store.load(null, null);
        int n = 0;
        if (caDir != null && Files.isDirectory(caDir)) {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            try (DirectoryStream<Path> files = Files.newDirectoryStream(caDir, "*.{pem,crt,cer}")) {
                for (Path f : files) {
                    try (InputStream in = Files.newInputStream(f)) {
                        for (Certificate c : cf.generateCertificates(in)) {
                            store.setCertificateEntry("ca-" + (n++), c);
                        }
                    }
                }
            }
        }
        for (X509Certificate c : parse(pem)) {
            store.setCertificateEntry("ca-" + (n++), c);
        }
        return store;
    }

    /** A context trusting only {@link #store}: the directory connections. */
    static SSLContext only(Path caDir, String pem) throws IOException, GeneralSecurityException {
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(store(caDir, pem));
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tmf.getTrustManagers(), null);
        return ctx;
    }

    /**
     * A context trusting the Java runtime's own CAs and, in addition, {@link #store}: the HTTPS calls to Keycloak, whose
     * certificate may come from the organisation's CA (pasted) or from a public one.
     */
    static SSLContext withDefaults(Path caDir, String pem) throws IOException, GeneralSecurityException {
        TrustManagerFactory defaults = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        defaults.init((KeyStore) null);
        KeyStore extra = store(caDir, pem);
        List<X509TrustManager> managers = new ArrayList<>();
        for (TrustManager t : defaults.getTrustManagers()) {
            if (t instanceof X509TrustManager x) {
                managers.add(x);
            }
        }
        if (extra.size() > 0) {
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(extra);
            for (TrustManager t : tmf.getTrustManagers()) {
                if (t instanceof X509TrustManager x) {
                    managers.add(x);
                }
            }
        }
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{new AnyOf(managers)}, null);
        return ctx;
    }

    /** Accepts a chain that any one of the managers accepts. */
    private static final class AnyOf implements X509TrustManager {
        private final List<X509TrustManager> managers;

        AnyOf(List<X509TrustManager> managers) {
            this.managers = managers;
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            check(chain, authType, true);
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            check(chain, authType, false);
        }

        private void check(X509Certificate[] chain, String authType, boolean client) throws CertificateException {
            CertificateException last = null;
            for (X509TrustManager m : managers) {
                try {
                    if (client) {
                        m.checkClientTrusted(chain, authType);
                    } else {
                        m.checkServerTrusted(chain, authType);
                    }
                    return;
                } catch (CertificateException e) {
                    last = e;
                }
            }
            throw last != null ? last : new CertificateException("no trust manager");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            List<X509Certificate> all = new ArrayList<>();
            for (X509TrustManager m : managers) {
                all.addAll(List.of(m.getAcceptedIssuers()));
            }
            return all.toArray(new X509Certificate[0]);
        }
    }
}
