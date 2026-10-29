package ae.mover.requests;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import ae.mover.common.ApiException;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import ae.mover.requests.Commands.SignatureInput;
import ae.mover.security.AuthService;
import ae.mover.security.OidcProperties;

/**
 * Approval signing (decision D-02 is open). Two modes are kept strictly apart:
 * <ul>
 *   <li>{@code INTERNAL_ATTESTATION}: the approver must have authenticated interactively at the identity provider within
 *   the last few minutes (step-up with {@code prompt=login}); the server binds person, capacity, time, that
 *   authentication time and the document hash with an HMAC under a server key. This is internal attestation, <b>not</b>
 *   a certificate-based digital signature, and is never labelled as one. TMRKZ verifies no password itself.</li>
 *   <li>{@code PKI}: delegated to a certificate provider. No provider is connected, so it fails closed with
 *   {@code SIGNATURE_PROVIDER_UNAVAILABLE} and no approval is recorded.</li>
 * </ul>
 */
@Service
public class SignatureService {

    private final AuthService auth;
    private final OidcProperties oidc;
    private final byte[] key;

    public SignatureService(AuthService auth, OidcProperties oidc, @Value("${mover.signature.attestation-key:}") String key) {
        this.auth = auth;
        this.oidc = oidc;
        if (key == null || key.length() < 32) {
            throw new IllegalStateException("mover.signature.attestation-key (MOVER_ATTESTATION_KEY) must be at least 32 characters");
        }
        this.key = key.getBytes(StandardCharsets.UTF_8);
    }

    public record Signed(String mode, String evidence) {
    }

    public Signed sign(String mode, UUID personId, String sessionId, String roleName, String sha256, Instant at, SignatureInput input) {
        if (input == null || !Boolean.TRUE.equals(input.confirm())) {
            throw new ApiException(ErrorCode.SIGNATURE_REQUIRED, "أكد الاعتماد لإتمام التوثيق.");
        }
        if ("PKI".equals(mode)) {
            throw new ApiException(ErrorCode.SIGNATURE_PROVIDER_UNAVAILABLE,
                    "مزود التوقيع الرقمي بشهادة غير مربوط (القرار D-02). لم يُسجل الاعتماد.",
                    Map.of("provider", "NOT_CONNECTED"));
        }
        Instant authenticated = sessionId == null ? null : auth.authenticatedAt(sessionId).orElse(null);
        if (authenticated == null || authenticated.isBefore(at.minusSeconds(oidc.reauthMaxAgeSeconds()))) {
            throw new ApiException(ErrorCode.REAUTHENTICATION_REQUIRED,
                    "أعد التحقق من هويتك لدى مزود الهوية ثم أكد الاعتماد؛ لم يُسجل أي قرار.");
        }
        String evidence = Hashing.hmacSha256(key, String.join("|", "INTERNAL_ATTESTATION", personId.toString(), roleName,
                sha256, at.toString(), authenticated.toString()));
        return new Signed("INTERNAL_ATTESTATION", evidence);
    }
}
