package ae.mover.signing;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Certificate signing (D-02, ADR-020). {@code provider}: NONE (nothing connected — PKI mode fails closed) or
 * PKCS12_DIRECTORY (key stores in a mounted folder: {@code person-<employeeNo>.p12} for approvers and
 * {@code seal-<organisationCode>.p12} for organisation seals, one password from a secret file). An enterprise HSM or
 * signing service plugs in behind {@link SigningProvider}. {@code trustDir} holds the organisation's CA certificates
 * (PEM) and {@code crlDir} its certificate revocation lists, distributed inside the network.
 */
@ConfigurationProperties(prefix = "tmrkz.signing")
public record SigningProperties(
        String provider,
        String keystoreDir,
        String keystorePasswordFile,
        String trustDir,
        String crlDir) {

    public SigningProperties {
        if (provider == null || provider.isBlank()) provider = "NONE";
    }
}
