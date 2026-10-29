package ae.mover.signing;

import java.util.List;
import java.util.Optional;

import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.token.DSSPrivateKeyEntry;
import eu.europa.esig.dss.token.SignatureTokenConnection;

/**
 * Where keys and trust material come from. Private keys never leave the provider: TMRKZ hands it the data to be signed
 * and receives the signature value.
 */
public interface SigningProvider {

    /** A signing key with its certificate chain, and the connection that signs with it (closed by the caller). */
    record Key(SignatureTokenConnection token, DSSPrivateKeyEntry entry) implements AutoCloseable {
        @Override
        public void close() {
            token.close();
        }
    }

    String name();

    boolean available();

    /** Why the provider cannot be used (configuration missing or unreadable), for the administrator. */
    String problem();

    Optional<Key> personKey(String employeeNo);

    Optional<Key> sealKey(String organisationCode);

    List<CertificateToken> trustAnchors();

    /** CRL files distributed inside the network; DSS parses them when it validates. */
    List<byte[]> revocationLists();
}
