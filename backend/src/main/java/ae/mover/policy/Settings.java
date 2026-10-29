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
        String timezone,
        /** Approved standard and edition for unit identity symbols ({@link #UNIT_SYMBOL_STANDARDS}); null = not decided. */
        String unitSymbolStandard) {

    /** Number-based SIDC standards the local renderer (milsymbol 3.0.4) draws. */
    public static final List<String> UNIT_SYMBOL_STANDARDS = List.of("APP6-D", "APP6-E", "2525-D", "2525-E");

    public static final List<String> SUPPORTED_TYPES = List.of(
            "application/pdf", "image/png", "image/jpeg", "text/plain",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    public static Settings defaults() {
        return new Settings(true, true, true, "INTERNAL_ATTESTATION", "DAYS", 10L * 1024 * 1024,
                SUPPORTED_TYPES, "Asia/Dubai", null);
    }
}
