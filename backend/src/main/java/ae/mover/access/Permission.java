package ae.mover.access;

/**
 * Independent actions. Holding one never implies another: CREATE does not allow editing a returned request (EDIT),
 * CONFIGURE does not allow reading request content (VIEW) or deciding (REVIEW/APPROVE), and VIEW_SUMMARY never
 * reveals occupant data or attachments. CLOSE (administrative completion of an approved request) is separate from
 * REVIEW and APPROVE. Stationing (ADR-031): CORRECT_STATIONING records or corrects a unit's authoritative stationing as
 * a data correction, MANAGE_SITE_LINKS creates and ends site links (never stationing), REPLAY_STATIONING_EVENTS puts a
 * failed outbound stationing event back for delivery (an operator action over every organisation, not delegable).
 */
public enum Permission {
    VIEW, VIEW_SUMMARY, CREATE, EDIT, REVIEW, APPROVE, EXPORT, EXECUTE,
    MANAGE_FACILITIES, MANAGE_ACCESS, CONFIGURE, AUDIT, VIEW_SOURCE_IDENTIFIERS, CLOSE,
    CORRECT_STATIONING, MANAGE_SITE_LINKS, REPLAY_STATIONING_EVENTS
}
