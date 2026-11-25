package ae.mover.security;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.StringReader;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.CertPath;
import java.security.cert.CertPathValidator;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.PKIXParameters;
import java.security.cert.TrustAnchor;
import java.security.cert.X509CertSelector;
import java.security.cert.X509Certificate;
import java.security.interfaces.ECKey;
import java.security.interfaces.RSAKey;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.Date;
import java.util.Enumeration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import javax.naming.InvalidNameException;
import javax.naming.ldap.LdapName;
import javax.naming.ldap.Rdn;

import org.bouncycastle.asn1.cms.ContentInfo;
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo;
import org.bouncycastle.cert.X509CRLHolder;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.openssl.PEMEncryptedKeyPair;
import org.bouncycastle.openssl.PEMKeyPair;
import org.bouncycastle.openssl.PEMParser;
import org.bouncycastle.openssl.jcajce.JcaPEMKeyConverter;
import org.bouncycastle.openssl.jcajce.JceOpenSSLPKCS8DecryptorProviderBuilder;
import org.bouncycastle.openssl.jcajce.JcePEMDecryptorProviderBuilder;
import org.bouncycastle.operator.InputDecryptorProvider;
import org.bouncycastle.pkcs.PKCS10CertificationRequest;
import org.bouncycastle.pkcs.PKCS8EncryptedPrivateKeyInfo;

/**
 * Reads and checks certificate files for «الشهادات» (ADR-105), with the libraries the backend already ships (the JDK and the
 * Bouncy Castle that the signature library brings): PEM (certificates, PKCS#8 / PKCS#1 / SEC1 keys, encrypted keys, PKCS#7),
 * DER certificates and PKCS#7, PKCS#12 (.pfx/.p12). Checks are the ones the HTTPS install script makes (ops/tls/install-cert.sh)
 * plus trust use: the private key matches the certificate (a signature made and verified, so any key type), the validity
 * period, server authentication, the host name against the subject alternative names, the chain to a root (PKIX, the root as the
 * only anchor; revocation is not checked: the server is offline). A private key is never returned or described beyond "matches".
 */
public final class CertificateInspector {

    static final String SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
    static final int MAX_FILES = 20;
    static final int MAX_FILE_BYTES = 1024 * 1024;
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");
    private static final SecureRandom RANDOM = new SecureRandom();

    private CertificateInspector() {
    }

    /** One file the administrator chose (its name only helps tell a PKCS#12 from a DER certificate). */
    public record Upload(String name, byte[] content) {

        @Override
        public String toString() {
            return "Upload[" + name + ", " + (content == null ? 0 : content.length) + " bytes]"; // never the content
        }
    }

    /** What the files hold: the certificates (deduplicated, in file order), at most one private key, and notes about the rest. */
    public record Parsed(List<X509Certificate> certificates, PrivateKey key, List<String> notes) {

        @Override
        public String toString() {
            return "Parsed[" + certificates.size() + " certificates, key " + (key != null) + "]"; // never the key
        }
    }

    /** Reads every file; an unreadable file, a wrong password or a second private key is refused with the reason. */
    public static Parsed parse(List<Upload> files, char[] password) {
        if (files == null || files.isEmpty()) {
            throw new IllegalArgumentException("لم يُختر ملف.");
        }
        if (files.size() > MAX_FILES) {
            throw new IllegalArgumentException("ملفات أكثر من " + MAX_FILES + ".");
        }
        List<X509Certificate> certs = new ArrayList<>();
        List<PrivateKey> keys = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        for (Upload f : files) {
            if (f.content() == null || f.content().length == 0) {
                throw new IllegalArgumentException("الملف فارغ: " + f.name());
            }
            if (f.content().length > MAX_FILE_BYTES) {
                throw new IllegalArgumentException("الملف أكبر من 1 MB: " + f.name());
            }
            String text = pemText(f.content());
            try {
                if (text != null) {
                    pem(f.name(), text, password, certs, keys, notes);
                } else {
                    binary(f.name(), f.content(), password, certs, keys, notes);
                }
            } catch (IOException | GeneralSecurityException | RuntimeException e) {
                if (e instanceof IllegalArgumentException iae) {
                    throw iae;
                }
                throw new IllegalArgumentException("تعذرت قراءة " + f.name() + ": " + reason(e));
            }
        }
        List<X509Certificate> unique = new ArrayList<>();
        List<String> seen = new ArrayList<>();
        for (X509Certificate c : certs) {
            String h = sha256(c);
            if (!seen.contains(h)) {
                seen.add(h);
                unique.add(c);
            }
        }
        if (keys.size() > 1) {
            throw new IllegalArgumentException("في الملفات أكثر من مفتاح خاص واحد؛ اختر مفتاح هذه الشهادة وحده.");
        }
        return new Parsed(List.copyOf(unique), keys.isEmpty() ? null : keys.get(0), List.copyOf(notes));
    }

    private static String reason(Exception e) {
        String m = e.getMessage();
        Throwable c = e.getCause();
        while ((m == null || m.isBlank()) && c != null) {
            m = c.getMessage();
            c = c.getCause();
        }
        return m == null ? e.getClass().getSimpleName() : m.replaceAll("[\\r\\n]+", " ");
    }

    /** The text of a PEM file, or null for a binary one. */
    private static String pemText(byte[] b) {
        String s = new String(b, StandardCharsets.ISO_8859_1);
        return s.contains("-----BEGIN ") ? s : null;
    }

    private static void pem(String name, String text, char[] password, List<X509Certificate> certs, List<PrivateKey> keys, List<String> notes)
            throws IOException, GeneralSecurityException {
        JcaX509CertificateConverter certificates = new JcaX509CertificateConverter();
        int read = 0;
        try (PEMParser parser = new PEMParser(new StringReader(text))) {
            for (Object o; (o = parser.readObject()) != null; ) {
                read++;
                if (o instanceof X509CertificateHolder h) {
                    certs.add(certificates.getCertificate(h));
                } else if (o instanceof PEMKeyPair kp) {
                    // PKCS#1 RSA or SEC1 EC: the private part is enough here (an EC key may carry no public half)
                    keys.add(key(kp.getPrivateKeyInfo()));
                } else if (o instanceof PrivateKeyInfo pki) {
                    keys.add(key(pki));
                } else if (o instanceof PEMEncryptedKeyPair ekp) {
                    try {
                        keys.add(key(ekp.decryptKeyPair(new JcePEMDecryptorProviderBuilder().build(needPassword(name, password))).getPrivateKeyInfo()));
                    } catch (IOException e) {
                        throw new IllegalArgumentException("كلمة مرور المفتاح في " + name + " غير صحيحة.");
                    }
                } else if (o instanceof PKCS8EncryptedPrivateKeyInfo epki) {
                    try {
                        InputDecryptorProvider d = new JceOpenSSLPKCS8DecryptorProviderBuilder().setProvider(new BouncyCastleProvider())
                                .build(needPassword(name, password));
                        keys.add(key(epki.decryptPrivateKeyInfo(d)));
                    } catch (org.bouncycastle.operator.OperatorCreationException | org.bouncycastle.pkcs.PKCSException e) {
                        throw new IllegalArgumentException("كلمة مرور المفتاح في " + name + " غير صحيحة.");
                    }
                } else if (o instanceof ContentInfo ci) {
                    for (Certificate c : CertificateFactory.getInstance("X.509").generateCertificates(new ByteArrayInputStream(ci.getEncoded()))) {
                        certs.add((X509Certificate) c);
                    }
                } else if (o instanceof X509CRLHolder) {
                    notes.add(name + ": قائمة إلغاء (CRL) — لا تُستخدم هنا.");
                } else if (o instanceof PKCS10CertificationRequest) {
                    notes.add(name + ": طلب شهادة (CSR) وليس شهادة — يُرسل إلى فريق الشهادات، ولا يُثبت.");
                } else {
                    notes.add(name + ": جزء غير مستخدم (" + o.getClass().getSimpleName() + ").");
                }
            }
        }
        if (read == 0) {
            throw new IllegalArgumentException("لا شيء مقروء في " + name + ".");
        }
    }

    /**
     * A private key the JDK can use. An EC key from SEC1 names its curve inside the key, not in the algorithm identifier the
     * JDK reads: Bouncy Castle reads it, and it is re-encoded as standard PKCS#8 (with the curve named) for the JDK.
     */
    private static PrivateKey key(PrivateKeyInfo pki) throws IOException {
        try {
            return new JcaPEMKeyConverter().getPrivateKey(pki);
        } catch (org.bouncycastle.openssl.PEMException e) {
            PrivateKey bc = new JcaPEMKeyConverter().setProvider(new BouncyCastleProvider()).getPrivateKey(pki);
            String alg = "ECDSA".equalsIgnoreCase(bc.getAlgorithm()) ? "EC" : bc.getAlgorithm();
            try {
                return java.security.KeyFactory.getInstance(alg).generatePrivate(new java.security.spec.PKCS8EncodedKeySpec(bc.getEncoded()));
            } catch (GeneralSecurityException x) {
                return bc;
            }
        }
    }

    private static char[] needPassword(String name, char[] password) {
        if (password == null || password.length == 0) {
            throw new IllegalArgumentException("المفتاح في " + name + " محمي بكلمة مرور؛ اكتبها.");
        }
        return password;
    }

    private static void binary(String name, byte[] content, char[] password, List<X509Certificate> certs, List<PrivateKey> keys,
                               List<String> notes) throws IOException, GeneralSecurityException {
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        boolean pkcs12 = lower.endsWith(".p12") || lower.endsWith(".pfx");
        if (!pkcs12) {
            try {
                Collection<? extends Certificate> all = CertificateFactory.getInstance("X.509").generateCertificates(new ByteArrayInputStream(content));
                if (!all.isEmpty()) {
                    all.forEach(c -> certs.add((X509Certificate) c));
                    return;
                }
            } catch (java.security.cert.CertificateException ignored) {
                // not a DER certificate or PKCS#7: a DER key or a PKCS#12 below
            }
            try {
                keys.add(key(PrivateKeyInfo.getInstance(content)));
                return;
            } catch (RuntimeException | IOException ignored) {
                // not a DER PKCS#8 key either
            }
        }
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try {
            ks.load(new ByteArrayInputStream(content), password == null ? new char[0] : password);
        } catch (IOException e) {
            if (e.getCause() instanceof java.security.UnrecoverableKeyException || String.valueOf(e.getMessage()).contains("password")) {
                throw new IllegalArgumentException(password == null || password.length == 0 ? "الملف " + name + " محمي بكلمة مرور؛ اكتبها."
                        : "كلمة مرور الملف " + name + " غير صحيحة.");
            }
            throw new IllegalArgumentException("الملف " + name + " ليس شهادة (PEM/DER/PKCS#7) ولا PKCS#12.");
        }
        for (Enumeration<String> aliases = ks.aliases(); aliases.hasMoreElements(); ) {
            String alias = aliases.nextElement();
            if (ks.isKeyEntry(alias)) {
                java.security.Key k = ks.getKey(alias, password == null ? new char[0] : password);
                if (k instanceof PrivateKey pk) {
                    keys.add(pk);
                }
                Certificate[] chain = ks.getCertificateChain(alias);
                if (chain != null) {
                    for (Certificate c : chain) {
                        certs.add((X509Certificate) c);
                    }
                }
            } else if (ks.getCertificate(alias) instanceof X509Certificate c) {
                certs.add(c);
            }
        }
    }

    // ---- describing ----------------------------------------------------------------------------------------------

    /** A certificate as the screen shows it (public facts only). */
    public static Map<String, Object> describe(X509Certificate c, Instant now) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("subject", c.getSubjectX500Principal().getName());
        m.put("subjectCn", cn(c.getSubjectX500Principal().getName()));
        m.put("issuer", c.getIssuerX500Principal().getName());
        m.put("issuerCn", cn(c.getIssuerX500Principal().getName()));
        m.put("serial", c.getSerialNumber().toString(16));
        m.put("notBefore", c.getNotBefore().toInstant().toString());
        m.put("notAfter", c.getNotAfter().toInstant().toString());
        m.put("daysLeft", Duration.between(now, c.getNotAfter().toInstant()).toDays());
        m.put("health", health(c, now));
        m.put("dnsNames", names(c, 2));
        m.put("ipAddresses", names(c, 7));
        m.put("sha256", sha256(c));
        m.put("publicKeySha256", spki(c.getPublicKey()));
        m.put("ca", c.getBasicConstraints() >= 0);
        m.put("selfSigned", selfSigned(c));
        m.put("serverAuth", serverAuth(c));
        m.put("keyAlgorithm", c.getPublicKey().getAlgorithm());
        m.put("keyBits", bits(c.getPublicKey()));
        m.put("role", selfSigned(c) ? "ROOT" : c.getBasicConstraints() >= 0 ? "INTERMEDIATE" : "LEAF");
        return m;
    }

    /** EXPIRED, NOT_YET_VALID, EXPIRING (30 days or less) or VALID. */
    public static String health(X509Certificate c, Instant now) {
        if (now.isAfter(c.getNotAfter().toInstant())) {
            return "EXPIRED";
        }
        if (now.isBefore(c.getNotBefore().toInstant())) {
            return "NOT_YET_VALID";
        }
        return Duration.between(now, c.getNotAfter().toInstant()).toDays() <= 30 ? "EXPIRING" : "VALID";
    }

    public static String cn(String dn) {
        try {
            for (Rdn r : new LdapName(dn).getRdns()) {
                if ("CN".equalsIgnoreCase(r.getType())) {
                    return String.valueOf(r.getValue());
                }
            }
        } catch (InvalidNameException ignored) {
            // shown as the full name
        }
        return dn;
    }

    /** Subject alternative names of one type (2 DNS, 7 IP). */
    public static List<String> names(X509Certificate c, int type) {
        List<String> out = new ArrayList<>();
        try {
            Collection<List<?>> all = c.getSubjectAlternativeNames();
            if (all != null) {
                for (List<?> n : all) {
                    if (n.size() >= 2 && n.get(0) instanceof Integer t && t == type) {
                        out.add(String.valueOf(n.get(1)));
                    }
                }
            }
        } catch (java.security.cert.CertificateParsingException ignored) {
            // no readable names
        }
        return out;
    }

    /** True, false, or null when the certificate states no extended key usage (any purpose). */
    public static Boolean serverAuth(X509Certificate c) {
        try {
            List<String> eku = c.getExtendedKeyUsage();
            return eku == null ? null : eku.contains(SERVER_AUTH) || eku.contains("2.5.29.37.0");
        } catch (java.security.cert.CertificateParsingException e) {
            return false;
        }
    }

    public static boolean selfSigned(X509Certificate c) {
        if (!c.getSubjectX500Principal().equals(c.getIssuerX500Principal())) {
            return false;
        }
        try {
            c.verify(c.getPublicKey());
            return true;
        } catch (GeneralSecurityException e) {
            return false;
        }
    }

    public static int bits(PublicKey k) {
        if (k instanceof RSAKey r) {
            return r.getModulus().bitLength();
        }
        if (k instanceof ECKey e) {
            return e.getParams().getOrder().bitLength();
        }
        return "Ed25519".equalsIgnoreCase(k.getAlgorithm()) || "EdDSA".equalsIgnoreCase(k.getAlgorithm()) ? 255 : 0;
    }

    // ---- checking --------------------------------------------------------------------------------------------------

    /** The private key belongs to the certificate: a signature made with it verifies with the certificate's public key. */
    public static boolean matches(PrivateKey key, X509Certificate cert) {
        if (key == null || cert == null) {
            return false;
        }
        String alg = switch (key.getAlgorithm().toUpperCase(Locale.ROOT)) {
            case "RSA" -> "SHA256withRSA";
            case "EC", "ECDSA" -> "SHA256withECDSA";
            case "ED25519", "EDDSA" -> "Ed25519";
            case "ED448" -> "Ed448";
            default -> null;
        };
        // no comparison of algorithm names: providers name the same key differently (EC / ECDSA, Ed25519 / EdDSA); the signature
        // below decides, and a key of another type simply fails to verify
        if (alg == null) {
            return false;
        }
        try {
            byte[] challenge = new byte[32];
            RANDOM.nextBytes(challenge);
            Signature s = Signature.getInstance(alg);
            s.initSign(key);
            s.update(challenge);
            byte[] sig = s.sign();
            Signature v = Signature.getInstance(alg);
            v.initVerify(cert.getPublicKey());
            v.update(challenge);
            return v.verify(sig);
        } catch (GeneralSecurityException e) {
            return false;
        }
    }

    /** The host name (or IP address) is one of the certificate's alternative names; a wildcard covers exactly one label. */
    public static boolean hostMatches(X509Certificate c, String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = host.trim().toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) {
            h = h.substring(1, h.length() - 1);
        }
        if (IPV4.matcher(h).matches() || h.contains(":")) {
            try {
                InetAddress want = InetAddress.getByName(h);
                for (String ip : names(c, 7)) {
                    if (InetAddress.getByName(ip).equals(want)) {
                        return true;
                    }
                }
            } catch (IOException e) {
                return false;
            }
            return false;
        }
        for (String n : names(c, 2)) {
            String d = n.toLowerCase(Locale.ROOT);
            if (d.equals(h)) {
                return true;
            }
            if (d.startsWith("*.") && h.indexOf('.') > 0 && h.substring(h.indexOf('.')).equals(d.substring(1))) {
                return true;
            }
        }
        return false;
    }

    /** The certificate and, as far as the pool allows, its issuers in order (each verified by the next); ends at a root. */
    public static List<X509Certificate> chainOf(X509Certificate leaf, Collection<X509Certificate> pool) {
        List<X509Certificate> path = new ArrayList<>(List.of(leaf));
        X509Certificate cur = leaf;
        for (int i = 0; i < 10 && !selfSigned(cur); i++) {
            X509Certificate next = null;
            for (X509Certificate p : pool) {
                if (p.getSubjectX500Principal().equals(cur.getIssuerX500Principal()) && !path.contains(p)) {
                    try {
                        cur.verify(p.getPublicKey());
                        next = p;
                        break;
                    } catch (GeneralSecurityException ignored) {
                        // same name, another key
                    }
                }
            }
            if (next == null) {
                break;
            }
            path.add(next);
            cur = next;
        }
        return path;
    }

    /** Null when the path validates (PKIX) to its own last certificate as the only anchor at {@code at}; else why not. */
    public static String validate(List<X509Certificate> path, Instant at, boolean serverAuth) {
        if (path.isEmpty() || !selfSigned(path.get(path.size() - 1))) {
            return "لا تنتهي السلسلة بجهة جذرية";
        }
        try {
            X509Certificate root = path.get(path.size() - 1);
            CertPath cp = CertificateFactory.getInstance("X.509").generateCertPath(path.subList(0, Math.max(1, path.size() - 1)));
            if (path.size() == 1) {
                cp = CertificateFactory.getInstance("X.509").generateCertPath(List.of(root));
            }
            PKIXParameters params = new PKIXParameters(Set.of(new TrustAnchor(root, null)));
            params.setRevocationEnabled(false);
            params.setDate(Date.from(at));
            if (serverAuth) {
                X509CertSelector target = new X509CertSelector();
                target.setExtendedKeyUsage(Set.of(SERVER_AUTH));
                params.setTargetCertConstraints(target);
            }
            CertPathValidator.getInstance("PKIX").validate(cp, params);
            return null;
        } catch (GeneralSecurityException | IOException e) {
            return reason(e);
        }
    }

    // ---- small helpers --------------------------------------------------------------------------------------------

    public static String pem(X509Certificate c) {
        try {
            return "-----BEGIN CERTIFICATE-----\n" + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(c.getEncoded())
                    + "\n-----END CERTIFICATE-----\n";
        } catch (java.security.cert.CertificateEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The private key as PKCS#8 PEM, for the staging file the maintenance worker installs; never shown or logged. */
    static String keyPem(PrivateKey k) {
        return "-----BEGIN PRIVATE KEY-----\n" + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(k.getEncoded())
                + "\n-----END PRIVATE KEY-----\n";
    }

    public static String sha256(X509Certificate c) {
        try {
            return sha256(c.getEncoded());
        } catch (java.security.cert.CertificateEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String spki(PublicKey k) {
        return sha256(k.getEncoded());
    }

    static String sha256(byte[] b) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The certificates of a PEM text (none for blank); a key in it is refused as {@link Trust#parse} does. */
    public static List<X509Certificate> certificates(String pem) {
        return Trust.parse(pem);
    }
}
