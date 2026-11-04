package ae.mover.stationing;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The outbound integration contract (owner decision O-01): one authoritative stationing or site-link change, for
 * consumers of the read API or event feed. Written with the change in the same transaction (outbox) and delivered
 * asynchronously; TMRKZ never writes the Oracle hierarchy. The event id is derived from the change itself, so the same
 * change always carries the same id (idempotent delivery). The unit is identified by its Oracle id and its code; a unit
 * created locally in TMRKZ (no Oracle id) is identified by its code alone. {@code seq} is the delivery sequence.
 */
public record StationingEvent(
        UUID eventId,
        Type type,
        String orgExternalId,
        String orgCode,
        UUID siteId,
        String siteExternalId,
        Instant effectiveAt,
        Instant recordedAt,
        String sourceVersion,
        String auditRef) {

    public static final String SOURCE = "TMRKZ";
    public static final String SCHEMA = "tmrkz.stationing.v1";

    public enum Type {
        STATIONING_ACTIVATED,
        TEMPORARY_STATIONING_SCHEDULED,
        TEMPORARY_STATIONING_STARTED,
        TEMPORARY_STATIONING_ENDED,
        TEMPORARY_STATIONING_CANCELLED,
        STATIONING_RETURNED,
        STATIONING_CORRECTED,
        SITE_LINK_CREATED,
        SITE_LINK_ENDED
    }

    public static StationingEvent of(Type type, String orgExternalId, String orgCode, UUID siteId, String siteExternalId,
                                     Instant effectiveAt, Instant recordedAt, String sourceVersion, String auditRef) {
        boolean oracle = orgExternalId != null && !orgExternalId.isBlank();
        if (!oracle && (orgCode == null || orgCode.isBlank()) || siteId == null || effectiveAt == null || auditRef == null) {
            throw new IllegalArgumentException("a stationing event needs the unit (Oracle id or code), the site, the effective time and an audit reference");
        }
        String unit = oracle ? orgExternalId : "code:" + orgCode;
        String key = String.join("|", SCHEMA, type.name(), auditRef, unit, siteId.toString(), effectiveAt.toString());
        return new StationingEvent(UUID.nameUUIDFromBytes(key.getBytes(StandardCharsets.UTF_8)), type, oracle ? orgExternalId : null,
                orgCode, siteId, siteExternalId, effectiveAt, recordedAt, sourceVersion, auditRef);
    }

    /** The published payload (field names are the contract). */
    public Map<String, Object> payload() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("eventId", eventId.toString());
        m.put("schema", SCHEMA);
        m.put("source", SOURCE);
        m.put("type", type.name());
        m.put("orgExternalId", orgExternalId);
        m.put("orgCode", orgCode);
        m.put("siteId", siteId.toString());
        m.put("siteExternalId", siteExternalId);
        m.put("effectiveAt", effectiveAt.toString());
        m.put("recordedAt", recordedAt.toString());
        m.put("sourceVersion", sourceVersion);
        m.put("auditRef", auditRef);
        return m;
    }
}
