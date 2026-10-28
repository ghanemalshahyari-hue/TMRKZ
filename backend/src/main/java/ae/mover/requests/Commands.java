package ae.mover.requests;

import java.util.List;
import java.util.Map;

/** Request bodies accepted by the request and task endpoints. Actor identity is never part of a body. */
public final class Commands {

    private Commands() {
    }

    public record PeriodInput(String start, String end) {
    }

    public record DraftInput(
            String typeCode,
            String origin,
            String ownerOrgId,
            List<String> resourceIds,
            List<String> participantOrgIds,
            List<String> infoOrgIds,
            String subject,
            String unit,
            PeriodInput period,
            Map<String, Object> values,
            String targetReservationId,
            Integer expectedVersion) {
    }

    public record SubmitInput(Integer expectedVersion, String resubmissionReason) {
    }

    public record SignatureInput(String password, Boolean confirm) {
    }

    public record DecisionInput(String decision, String note, String reasonCode, Integer expectedRevision,
                                SignatureInput signature) {
    }

    public record CloseInput(String note) {
    }

    public record CompleteInput(String note, String evidenceAttachmentId) {
    }

    public record ChangeRequestInput(String typeCode) {
    }
}
