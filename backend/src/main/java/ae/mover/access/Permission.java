package ae.mover.access;

/**
 * Independent actions. Holding one never implies another: CREATE does not allow editing a returned request (EDIT),
 * CONFIGURE does not allow reading request content (VIEW) or deciding (REVIEW/APPROVE), and VIEW_SUMMARY never
 * reveals occupant data or attachments. CLOSE (administrative completion of an approved request) is separate from
 * REVIEW and APPROVE. Stationing (ADR-031): CORRECT_STATIONING records or corrects a unit's authoritative stationing as
 * a data correction, MANAGE_SITE_LINKS creates and ends site links (never stationing), REPLAY_STATIONING_EVENTS puts a
 * failed outbound stationing event back for delivery (an operator action over every organisation, not delegable).
 * Re-stationing requests (ADR-033): CREATE_RESTATIONING prepares and submits a request for a requesting unit,
 * ACTIVATE_STATIONING activates a finally approved request (never by its requester or final approver),
 * APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION decides the distance-exception stage; the hierarchy stages are decided through
 * APPROVE held in the stage unit's own approver seat. Lifecycle (ADR-034, model D10, D12, D16, A4): each decision is
 * its own action and is never taken by the human who asked for it — DECIDE_PRE_ACTIVATION_CANCELLATION (cancel a
 * request before activation), ACTIVATE_TEMPORARY_EXTENSION (activate an approved extension; never its requester or final
 * approver), DECIDE_EARLY_RETURN (end an active temporary early), DECIDE_BEFORE_START_CANCELLATION (cancel an
 * activated temporary before its start; never carried by DECIDE_EARLY_RETURN).
 */
public enum Permission {
    VIEW, VIEW_SUMMARY, CREATE, EDIT, REVIEW, APPROVE, EXPORT, EXECUTE,
    MANAGE_FACILITIES, MANAGE_ACCESS, CONFIGURE, AUDIT, VIEW_SOURCE_IDENTIFIERS, CLOSE,
    CORRECT_STATIONING, MANAGE_SITE_LINKS, REPLAY_STATIONING_EVENTS,
    CREATE_RESTATIONING, ACTIVATE_STATIONING, APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION,
    DECIDE_PRE_ACTIVATION_CANCELLATION, ACTIVATE_TEMPORARY_EXTENSION, DECIDE_EARLY_RETURN, DECIDE_BEFORE_START_CANCELLATION
}
