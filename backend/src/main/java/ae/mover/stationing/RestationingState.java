package ae.mover.stationing;

/** The states of a re-stationing request (docs/STATIONING_MODEL_V3_AR.md §3). */
public enum RestationingState {
    DRAFT,
    UNDER_REVIEW,
    RETURNED_FOR_CHANGES,
    PAUSED_HIERARCHY_CHANGED,
    REJECTED,
    APPROVED_NOT_ACTIVATED,
    CANCELLATION_PENDING,
    CANCELLED_BEFORE_ACTIVATION,
    ACTIVATED_PERMANENT,
    TEMPORARY_SCHEDULED,
    START_HELD_PENDING_CANCELLATION,
    ACTIVE_TEMPORARY,
    TEMPORARY_RETURNED,
    TEMPORARY_CANCELLED_BEFORE_START,
    TEMPORARY_WINDOW_EXPIRED_WITHOUT_START,
    EXTENSION_ACTIVATED,
    LAPSED_NOT_ACTIVATED;

    /** O-10 / O-16: a hierarchy change of the requesting unit pauses a request in these states. */
    public boolean pausesOnHierarchyChange() {
        return this == UNDER_REVIEW || this == APPROVED_NOT_ACTIVATED;
    }
}
