package ae.mover;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.CRLReason;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509CRLHolder;
import org.bouncycastle.cert.X509v2CRLBuilder;
import org.bouncycastle.cert.X509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

/**
 * A throw-away certificate authority for the signing tests (test scope only): signing certificates for people and
 * organisation seals as PKCS#12 key stores, a CRL, and certificates that are revoked, expired or from an unknown CA.
 */
final class TestPki {

    static final String PASSWORD = "test-pki-password";
    private static final AtomicLong SERIAL = new AtomicLong(System.currentTimeMillis());

    final Path keystores;
    final Path trust;
    final Path crls;
    final Path passwordFile;
    private final KeyPair caKeys;
    private final X509Certificate ca;
    private final X509v2CRLBuilder crl;

    TestPki(Path root) throws Exception {
        keystores = Files.createDirectories(root.resolve("keystores"));
        trust = Files.createDirectories(root.resolve("trust"));
        crls = Files.createDirectories(root.resolve("crl"));
        passwordFile = root.resolve("password");
        Files.writeString(passwordFile, PASSWORD);
        caKeys = keys();
        Instant now = Instant.now();
        X500Name caName = new X500Name("CN=TMRKZ Test Signing CA, O=Test");
        X509v3CertificateBuilder b = new JcaX509v3CertificateBuilder(caName, serial(), Date.from(now.minus(1, ChronoUnit.DAYS)),
                Date.from(now.plus(3650, ChronoUnit.DAYS)), caName, caKeys.getPublic());
        b.addExtension(Extension.basicConstraints, true, new BasicConstraints(true));
        b.addExtension(Extension.keyUsage, true, new KeyUsage(KeyUsage.keyCertSign | KeyUsage.cRLSign));
        ca = cert(b, caKeys.getPrivate());
        Files.writeString(trust.resolve("ca.pem"), pem(ca));
        crl = new X509v2CRLBuilder(caName, Date.from(now.minus(1, ChronoUnit.HOURS)));
        crl.setNextUpdate(Date.from(now.plus(7, ChronoUnit.DAYS)));
        writeCrl();
    }

    /** A signing certificate valid now, stored as {@code <file>.p12}. */
    X509Certificate issue(String file, String commonName) throws Exception {
        Instant now = Instant.now();
        return issue(file, commonName, now.minus(1, ChronoUnit.DAYS), now.plus(365, ChronoUnit.DAYS), caKeys.getPrivate(), ca);
    }

    X509Certificate issueExpired(String file, String commonName) throws Exception {
        Instant now = Instant.now();
        return issue(file, commonName, now.minus(400, ChronoUnit.DAYS), now.minus(30, ChronoUnit.DAYS), caKeys.getPrivate(), ca);
    }

    /** Issued by a CA that is not in the trust folder. */
    X509Certificate issueUntrusted(String file, String commonName) throws Exception {
        KeyPair other = keys();
        X500Name otherName = new X500Name("CN=Unknown CA, O=Elsewhere");
        Instant now = Instant.now();
        X509v3CertificateBuilder b = new JcaX509v3CertificateBuilder(otherName, serial(), Date.from(now.minus(1, ChronoUnit.DAYS)),
                Date.from(now.plus(3650, ChronoUnit.DAYS)), otherName, other.getPublic());
        b.addExtension(Extension.basicConstraints, true, new BasicConstraints(true));
        X509Certificate otherCa = cert(b, other.getPrivate());
        return issue(file, commonName, now.minus(1, ChronoUnit.DAYS), now.plus(365, ChronoUnit.DAYS), other.getPrivate(), otherCa);
    }

    void revoke(X509Certificate c) throws Exception {
        crl.addCRLEntry(c.getSerialNumber(), Date.from(Instant.now().minus(1, ChronoUnit.HOURS)), CRLReason.keyCompromise);
        writeCrl();
    }

    private X509Certificate issue(String file, String commonName, Instant from, Instant to, PrivateKey issuerKey,
                                  X509Certificate issuer) throws Exception {
        KeyPair kp = keys();
        X509v3CertificateBuilder b = new JcaX509v3CertificateBuilder(issuer, serial(), Date.from(from), Date.from(to),
                new X500Name("CN=" + commonName + ", O=Test"), kp.getPublic());
        b.addExtension(Extension.keyUsage, true, new KeyUsage(KeyUsage.digitalSignature | KeyUsage.nonRepudiation));
        X509Certificate c = cert(b, issuerKey);
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        ks.setKeyEntry("signing", kp.getPrivate(), PASSWORD.toCharArray(), new Certificate[] {c, issuer});
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ks.store(out, PASSWORD.toCharArray());
        Files.write(keystores.resolve(file + ".p12"), out.toByteArray());
        return c;
    }

    private void writeCrl() throws Exception {
        X509CRLHolder holder = crl.build(signer(caKeys.getPrivate()));
        Files.write(crls.resolve("ca.crl"), holder.getEncoded());
    }

    private static KeyPair keys() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        return g.generateKeyPair();
    }

    private static BigInteger serial() {
        return BigInteger.valueOf(SERIAL.incrementAndGet());
    }

    private static ContentSigner signer(PrivateKey key) throws Exception {
        return new JcaContentSignerBuilder("SHA256withRSA").build(key);
    }

    private static X509Certificate cert(X509v3CertificateBuilder b, PrivateKey key) throws Exception {
        return new JcaX509CertificateConverter().getCertificate(b.build(signer(key)));
    }

    static String pem(X509Certificate c) throws IOException {
        try {
            return "-----BEGIN CERTIFICATE-----\n" + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII))
                    .encodeToString(c.getEncoded()) + "\n-----END CERTIFICATE-----\n";
        } catch (java.security.cert.CertificateEncodingException e) {
            throw new IOException(e);
        }
    }

    @SuppressWarnings("unused")
    static List<Path> all(Path... p) {
        return List.of(p);
    }
}
