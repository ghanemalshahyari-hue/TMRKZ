package ae.mover.signing;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.stereotype.Component;

import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.spi.DSSUtils;
import eu.europa.esig.dss.token.DSSPrivateKeyEntry;
import eu.europa.esig.dss.token.Pkcs12SignatureToken;

/**
 * Key stores in a mounted folder (PKCS12_DIRECTORY): {@code person-<employeeNo>.p12} and {@code seal-<code>.p12}, one
 * password read from a secret file. Meant for the acceptance environment and for organisations that issue soft
 * certificates; an HSM or signing service replaces it behind {@link SigningProvider}. File names are built from
 * identifiers checked against a strict pattern, never from free text.
 */
@Component
@EnableConfigurationProperties(SigningProperties.class)
public class Pkcs12DirectoryProvider implements SigningProvider {

    private static final String SAFE = "[A-Za-z0-9._-]{1,64}";

    private final SigningProperties props;

    public Pkcs12DirectoryProvider(SigningProperties props) {
        this.props = props;
    }

    @Override
    public String name() {
        return props.provider();
    }

    @Override
    public boolean available() {
        return problem() == null;
    }

    @Override
    public String problem() {
        if (!"PKCS12_DIRECTORY".equals(props.provider())) {
            return "لا مزود توقيع مربوط (TMRKZ_SIGNING_PROVIDER=" + props.provider() + ").";
        }
        if (blank(props.keystoreDir()) || !Files.isDirectory(Path.of(props.keystoreDir()))) {
            return "مجلد الشهادات غير موجود.";
        }
        if (blank(props.keystorePasswordFile()) || !Files.isReadable(Path.of(props.keystorePasswordFile()))) {
            return "ملف كلمة سر مخازن الشهادات غير مقروء.";
        }
        if (trustAnchors().isEmpty()) {
            return "لا شهادات جذر موثوقة في مجلد الثقة.";
        }
        return null;
    }

    @Override
    public Optional<Key> personKey(String employeeNo) {
        return key("person-" + employeeNo);
    }

    @Override
    public Optional<Key> sealKey(String organisationCode) {
        return key("seal-" + organisationCode);
    }

    private Optional<Key> key(String base) {
        if (!available() || base == null || !base.matches(SAFE)) {
            return Optional.empty();
        }
        Path file = Path.of(props.keystoreDir(), base + ".p12");
        if (!Files.isReadable(file)) {
            return Optional.empty();
        }
        try {
            char[] password = Files.readString(Path.of(props.keystorePasswordFile()), StandardCharsets.UTF_8).trim().toCharArray();
            Pkcs12SignatureToken token = new Pkcs12SignatureToken(Files.readAllBytes(file), new KeyStore.PasswordProtection(password));
            List<DSSPrivateKeyEntry> keys = token.getKeys();
            if (keys.isEmpty()) {
                token.close();
                return Optional.empty();
            }
            return Optional.of(new Key(token, keys.get(0)));
        } catch (IOException | RuntimeException e) {
            return Optional.empty();
        }
    }

    @Override
    public List<CertificateToken> trustAnchors() {
        List<CertificateToken> out = new ArrayList<>();
        for (byte[] pem : files(props.trustDir(), ".pem", ".crt")) {
            try {
                out.add(DSSUtils.loadCertificate(pem));
            } catch (RuntimeException ignored) {
                // not a certificate: skipped (the status names the folder, not each file)
            }
        }
        return out;
    }

    @Override
    public List<byte[]> revocationLists() {
        return files(props.crlDir(), ".crl", ".pem");
    }

    private static List<byte[]> files(String dir, String... suffixes) {
        if (blank(dir) || !Files.isDirectory(Path.of(dir))) {
            return List.of();
        }
        List<byte[]> out = new ArrayList<>();
        try (Stream<Path> s = Files.list(Path.of(dir))) {
            for (Path p : s.sorted().toList()) {
                String name = p.getFileName().toString().toLowerCase();
                if (Files.isRegularFile(p) && Stream.of(suffixes).anyMatch(name::endsWith)) {
                    out.add(Files.readAllBytes(p));
                }
            }
        } catch (IOException e) {
            return List.of();
        }
        return out;
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
