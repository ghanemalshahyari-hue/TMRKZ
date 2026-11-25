package ae.mover;

import java.io.ByteArrayOutputStream;
import java.io.StringWriter;
import java.math.BigInteger;
import java.net.InetAddress;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

import javax.security.auth.x500.X500Principal;

import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.ExtendedKeyUsage;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.asn1.x509.KeyPurposeId;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.cms.CMSProcessableByteArray;
import org.bouncycastle.cms.CMSSignedDataGenerator;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.openssl.jcajce.JcaPEMWriter;
import org.bouncycastle.openssl.jcajce.JcaPKCS8Generator;
import org.bouncycastle.openssl.jcajce.JceOpenSSLPKCS8EncryptorBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

/** A throw-away test PKI (fictional names only): roots, intermediates and server certificates, in every file format. */
final class TlsTestPki {

    private static final SecureRandom RANDOM = new SecureRandom();

    record Issued(X509Certificate cert, KeyPair keys) {
    }

    private TlsTestPki() {
    }

    static KeyPair rsa() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        return g.generateKeyPair();
    }

    static KeyPair ec() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        return g.generateKeyPair();
    }

    static Issued root(String cn) throws Exception {
        KeyPair k = rsa();
        return new Issued(build(cn, cn, k, k.getPrivate(), true, null, List.of(), List.of(), Instant.now().minus(Duration.ofDays(1)),
                Instant.now().plus(Duration.ofDays(3650))), k);
    }

    static Issued intermediate(String cn, Issued issuer) throws Exception {
        KeyPair k = rsa();
        return new Issued(build(cn, issuer.cert().getSubjectX500Principal().getName(), k, issuer.keys().getPrivate(), true, null, List.of(),
                List.of(), Instant.now().minus(Duration.ofDays(1)), Instant.now().plus(Duration.ofDays(1825))), k);
    }

    static Issued server(String cn, Issued issuer, List<String> dns, List<String> ips, KeyPurposeId purpose, Instant from, Instant to,
                         KeyPair keys) throws Exception {
        KeyPair k = keys != null ? keys : rsa();
        return new Issued(build(cn, issuer.cert().getSubjectX500Principal().getName(), k, issuer.keys().getPrivate(), false, purpose, dns, ips,
                from, to), k);
    }

    static Issued server(String cn, Issued issuer, String... dns) throws Exception {
        return server(cn, issuer, List.of(dns), List.of(), KeyPurposeId.id_kp_serverAuth, Instant.now().minus(Duration.ofDays(1)),
                Instant.now().plus(Duration.ofDays(365)), null);
    }

    private static X509Certificate build(String cn, String issuerDn, KeyPair subject, PrivateKey signer, boolean ca, KeyPurposeId purpose,
                                         List<String> dns, List<String> ips, Instant from, Instant to) throws Exception {
        X500Principal issuerName = issuerDn.contains("=") ? new X500Principal(issuerDn) : new X500Principal("CN=" + issuerDn + ",O=TMRKZ Test");
        X500Principal subjectName = new X500Principal("CN=" + cn + ",O=TMRKZ Test");
        if (issuerDn.equals(cn)) {
            issuerName = subjectName;
        }
        JcaX509v3CertificateBuilder b = new JcaX509v3CertificateBuilder(issuerName, new BigInteger(64, RANDOM), Date.from(from), Date.from(to),
                subjectName, subject.getPublic());
        b.addExtension(Extension.basicConstraints, true, ca ? new BasicConstraints(1) : new BasicConstraints(false));
        b.addExtension(Extension.keyUsage, true, new KeyUsage(ca ? KeyUsage.keyCertSign | KeyUsage.cRLSign : KeyUsage.digitalSignature
                | KeyUsage.keyEncipherment));
        if (purpose != null) {
            b.addExtension(Extension.extendedKeyUsage, false, new ExtendedKeyUsage(purpose));
        }
        List<GeneralName> names = new ArrayList<>();
        dns.forEach(d -> names.add(new GeneralName(GeneralName.dNSName, d)));
        for (String ip : ips) {
            names.add(new GeneralName(GeneralName.iPAddress, ip));
        }
        if (!names.isEmpty()) {
            b.addExtension(Extension.subjectAlternativeName, false, new GeneralNames(names.toArray(new GeneralName[0])));
        }
        String alg = signer.getAlgorithm().equals("EC") ? "SHA256withECDSA" : "SHA256withRSA";
        return new JcaX509CertificateConverter().getCertificate(b.build(new JcaContentSignerBuilder(alg).build(signer)));
    }

    // ---- file formats -----------------------------------------------------------------------------------------------

    static String pem(Object... objects) throws Exception {
        StringWriter w = new StringWriter();
        try (JcaPEMWriter p = new JcaPEMWriter(w)) {
            for (Object o : objects) {
                p.writeObject(o);
            }
        }
        return w.toString();
    }

    /** PKCS#8 "BEGIN PRIVATE KEY". */
    static String pkcs8(PrivateKey k) throws Exception {
        return pem(new JcaPKCS8Generator(k, null));
    }

    /** PKCS#8 encrypted with a password ("BEGIN ENCRYPTED PRIVATE KEY"). */
    static String encryptedPkcs8(PrivateKey k, String password) throws Exception {
        var enc = new JceOpenSSLPKCS8EncryptorBuilder(JcaPKCS8Generator.AES_256_CBC).setProvider(new BouncyCastleProvider())
                .setPassword(password.toCharArray()).build();
        return pem(new JcaPKCS8Generator(k, enc));
    }

    static byte[] pkcs12(PrivateKey key, String password, X509Certificate... chain) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        ks.setKeyEntry("server", key, password.toCharArray(), chain);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ks.store(out, password.toCharArray());
        return out.toByteArray();
    }

    /** A certificates-only PKCS#7 (.p7b) in DER. */
    static byte[] p7b(X509Certificate... certs) throws Exception {
        CMSSignedDataGenerator g = new CMSSignedDataGenerator();
        g.addCertificates(new JcaCertStore(List.of(certs)));
        return g.generate(new CMSProcessableByteArray(new byte[0])).getEncoded();
    }

    static String ip(String a) throws Exception {
        return InetAddress.getByName(a).getHostAddress();
    }
}
