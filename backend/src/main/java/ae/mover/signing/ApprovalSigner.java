package ae.mover.signing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.Optional;

import org.springframework.stereotype.Component;

import eu.europa.esig.dss.diagnostic.CertificateWrapper;
import eu.europa.esig.dss.diagnostic.DiagnosticData;
import eu.europa.esig.dss.diagnostic.SignatureWrapper;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import eu.europa.esig.dss.enumerations.Indication;
import eu.europa.esig.dss.enumerations.JWSSerializationType;
import eu.europa.esig.dss.enumerations.SignatureLevel;
import eu.europa.esig.dss.enumerations.SignaturePackaging;
import eu.europa.esig.dss.enumerations.SubIndication;
import eu.europa.esig.dss.jades.JAdESSignatureParameters;
import eu.europa.esig.dss.jades.signature.JAdESService;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.simplereport.SimpleReport;
import eu.europa.esig.dss.spi.DSSUtils;
import eu.europa.esig.dss.spi.validation.CommonCertificateVerifier;
import eu.europa.esig.dss.spi.x509.CommonTrustedCertificateSource;
import eu.europa.esig.dss.spi.x509.revocation.crl.ExternalResourcesCRLSource;
import eu.europa.esig.dss.validation.SignedDocumentValidator;
import eu.europa.esig.dss.validation.reports.Reports;

/**
 * Signs the approval document with DSS (JAdES, JSON serialisation, enveloping the canonical document): first the
 * approver's certificate, then the organisation's seal as a parallel signature, so adding the seal leaves the person's
 * signature intact. Both are validated before anything is published: trusted chain, validity period and revocation
 * from the CRLs distributed inside the network. Only TOTAL_PASSED is accepted. No network call is made.
 */
@Component
public class ApprovalSigner {

    /** One validated signature. {@code role} is PERSON or SEAL (or UNKNOWN when re-validating a foreign document). */
    public record Check(String role, String signatureId, String subject, String issuer, String serial, Instant notBefore,
                        Instant notAfter, Instant signingTime, String indication, String subIndication, String certificate,
                        boolean passed, String reason) {
    }

    public record Outcome(boolean ok, String failureCode, String failureMessage, byte[] signed, List<Check> checks) {
    }

    private final SigningProvider provider;

    public ApprovalSigner(SigningProvider provider) {
        this.provider = provider;
    }

    public SigningProvider provider() {
        return provider;
    }

    public Outcome sign(byte[] document, String employeeNo, String organisationCode, Instant at) {
        if (!provider.available()) {
            return new Outcome(false, "PROVIDER_UNAVAILABLE", provider.problem(), null, List.of());
        }
        Optional<SigningProvider.Key> person = provider.personKey(employeeNo);
        if (person.isEmpty()) {
            return new Outcome(false, "PERSON_CERTIFICATE_MISSING",
                    "لا توجد لدى مزود التوقيع شهادة توقيع للمعتمد (الرقم الوظيفي " + employeeNo + ").", null, List.of());
        }
        Optional<SigningProvider.Key> seal = provider.sealKey(organisationCode);
        if (seal.isEmpty()) {
            person.get().close();
            return new Outcome(false, "SEAL_CERTIFICATE_MISSING",
                    "لا توجد لدى مزود التوقيع شهادة ختم للجهة (" + organisationCode + ").", null, List.of());
        }
        byte[] signed;
        String personCert;
        String sealCert;
        try (SigningProvider.Key p = person.get(); SigningProvider.Key s = seal.get()) {
            // a certificate outside its validity period is refused before anything is signed
            for (SigningProvider.Key k : List.of(p, s)) {
                CertificateToken c = k.entry().getCertificate();
                if (at.isBefore(c.getNotBefore().toInstant()) || !at.isBefore(c.getNotAfter().toInstant())) {
                    String who = k == p ? "شهادة المعتمد" : "شهادة ختم الجهة";
                    return new Outcome(false, "CERTIFICATE_EXPIRED", who + " خارج مدة صلاحيتها.", null, List.of());
                }
            }
            JAdESService service = new JAdESService(verifier());
            DSSDocument withPerson = signWith(service, new InMemoryDocument(document, "approval.json"), p, at);
            DSSDocument withSeal = signWith(service, withPerson, s, at);
            signed = withSeal.openStream().readAllBytes();
            personCert = base64(p.entry().getCertificate().getEncoded());
            sealCert = base64(s.entry().getCertificate().getEncoded());
        } catch (java.io.IOException | RuntimeException e) {
            return new Outcome(false, "SIGNING_FAILED", "تعذر إنتاج التوقيع لدى المزود: " + e.getClass().getSimpleName(), null, List.of());
        }
        List<Check> checks = validate(signed, personCert, sealCert);
        for (Check c : checks) {
            if (!c.passed()) {
                return new Outcome(false, failureCode(c), c.reason(), signed, checks);
            }
        }
        if (checks.size() != 2) {
            return new Outcome(false, "INVALID", "لم يُعثر على توقيع الشخص وختم الجهة معاً في المستند.", signed, checks);
        }
        return new Outcome(true, null, null, signed, checks);
    }

    private static DSSDocument signWith(JAdESService service, DSSDocument doc, SigningProvider.Key key, Instant at) {
        JAdESSignatureParameters p = new JAdESSignatureParameters();
        p.setSignatureLevel(SignatureLevel.JAdES_BASELINE_B);
        p.setSignaturePackaging(SignaturePackaging.ENVELOPING);
        p.setJwsSerializationType(JWSSerializationType.JSON_SERIALIZATION);
        p.setDigestAlgorithm(DigestAlgorithm.SHA256);
        p.setSigningCertificate(key.entry().getCertificate());
        p.setCertificateChain(key.entry().getCertificateChain());
        p.bLevel().setSigningDate(Date.from(at));
        ToBeSigned data = service.getDataToSign(doc, p);
        SignatureValue value = key.token().sign(data, p.getDigestAlgorithm(), key.entry());
        return service.signDocument(doc, p, value);
    }

    /** Validates every signature of a signed approval document now, labelling the person's and the seal's. */
    public List<Check> validate(byte[] signed, String personCert, String sealCert) {
        String personId = dssId(personCert);
        String sealId = dssId(sealCert);
        SignedDocumentValidator validator = SignedDocumentValidator.fromDocument(new InMemoryDocument(signed));
        validator.setCertificateVerifier(verifier());
        Reports reports = validator.validateDocument();
        SimpleReport simple = reports.getSimpleReport();
        DiagnosticData diagnostic = reports.getDiagnosticData();
        List<Check> out = new ArrayList<>();
        for (String id : simple.getSignatureIdList()) {
            SignatureWrapper sig = diagnostic.getSignatureById(id);
            CertificateWrapper cert = sig == null ? null : sig.getSigningCertificate();
            String certId = cert == null ? null : cert.getId();
            String role = certId == null ? "UNKNOWN" : certId.equals(personId) ? "PERSON" : certId.equals(sealId) ? "SEAL" : "UNKNOWN";
            String der = "PERSON".equals(role) ? personCert : "SEAL".equals(role) ? sealCert : null;
            Indication ind = simple.getIndication(id);
            SubIndication sub = simple.getSubIndication(id);
            boolean passed = ind == Indication.TOTAL_PASSED;
            out.add(new Check(role, id, cert == null ? null : cert.getCertificateDN(), cert == null ? null : cert.getCertificateIssuerDN(),
                    cert == null ? null : cert.getSerialNumber(), instant(cert == null ? null : cert.getNotBefore()),
                    instant(cert == null ? null : cert.getNotAfter()), instant(simple.getSigningTime(id)),
                    ind == null ? null : ind.name(), sub == null ? null : sub.name(), der, passed,
                    passed ? null : reason(role, sub, ind)));
        }
        return out;
    }

    private static String dssId(String base64Der) {
        if (base64Der == null) {
            return null;
        }
        try {
            return DSSUtils.loadCertificate(Base64.getDecoder().decode(base64Der)).getDSSIdAsString();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private CommonCertificateVerifier verifier() {
        CommonCertificateVerifier cv = new CommonCertificateVerifier();
        CommonTrustedCertificateSource trusted = new CommonTrustedCertificateSource();
        provider.trustAnchors().forEach(trusted::addCertificate);
        cv.setTrustedCertSources(trusted);
        List<byte[]> crls = provider.revocationLists();
        if (!crls.isEmpty()) {
            cv.setCrlSource(new ExternalResourcesCRLSource(crls.stream().map(b -> (DSSDocument) new InMemoryDocument(b)).toArray(DSSDocument[]::new)));
        }
        cv.setOcspSource(null);
        cv.setAIASource(null);
        return cv;
    }

    private static String failureCode(Check c) {
        String sub = c.subIndication() == null ? "" : c.subIndication();
        if (sub.startsWith("REVOKED")) {
            return "CERTIFICATE_REVOKED";
        }
        if (sub.startsWith("OUT_OF_BOUNDS") || sub.equals("EXPIRED") || sub.equals("NOT_YET_VALID")) {
            return "CERTIFICATE_EXPIRED";
        }
        if (sub.equals("NO_CERTIFICATE_CHAIN_FOUND") || sub.startsWith("CHAIN_CONSTRAINTS")) {
            return "CERTIFICATE_UNTRUSTED";
        }
        if (sub.equals("TRY_LATER") || sub.equals("REVOCATION_OUT_OF_BOUNDS_NO_POE")) {
            return "REVOCATION_UNAVAILABLE";
        }
        return "SIGNATURE_INVALID";
    }

    private static String reason(String role, SubIndication sub, Indication ind) {
        String who = "PERSON".equals(role) ? "شهادة المعتمد" : "SEAL".equals(role) ? "شهادة ختم الجهة" : "شهادة التوقيع";
        String s = sub == null ? "" : sub.name();
        if (s.startsWith("REVOKED")) {
            return who + " ملغاة لدى الجهة المصدرة.";
        }
        if (s.startsWith("OUT_OF_BOUNDS") || s.equals("EXPIRED") || s.equals("NOT_YET_VALID")) {
            return who + " خارج مدة صلاحيتها.";
        }
        if (s.equals("NO_CERTIFICATE_CHAIN_FOUND") || s.startsWith("CHAIN_CONSTRAINTS")) {
            return who + " لا تنتهي إلى جهة إصدار موثوقة.";
        }
        if (s.equals("TRY_LATER")) {
            return "معلومات إلغاء " + who + " غير متاحة داخل الشبكة.";
        }
        return who + ": التحقق لم ينجح (" + (ind == null ? "" : ind.name()) + (s.isEmpty() ? "" : " / " + s) + ").";
    }

    private static Instant instant(Date d) {
        return d == null ? null : d.toInstant();
    }

    private static String base64(byte[] b) {
        return Base64.getEncoder().encodeToString(b);
    }
}
