package ae.mover.policy;

import java.util.List;

/** Organisation policy settings. Changes are published as new immutable policy versions. */
public record Settings(
        boolean multiSites,
        boolean multiOrgs,
        boolean signatureRequired,
        String signatureMode,
        String defaultUnit,
        long attachmentMaxBytes,
        List<String> allowedAttachmentTypes,
        String timezone) {

    public static final List<String> SUPPORTED_TYPES = List.of(
            "application/pdf", "image/png", "image/jpeg", "text/plain",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    public static Settings defaults() {
        return new Settings(true, true, true, "INTERNAL_ATTESTATION", "DAYS", 10L * 1024 * 1024,
                SUPPORTED_TYPES, "Asia/Dubai");
    }
}
