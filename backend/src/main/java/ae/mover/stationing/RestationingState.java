package ae.mover.stationing;

/** The states of a re-stationing request (docs/STATIONING_MODEL_V3_AR.md §3). */
public enum RestationingState {
    DRAFT,
    UNDER_REVIEW,
    RETURNED_FOR_CHANGES,
    PAUSED_HIERARCHY_CHANGED,
    REJECTED,
    APPROVED_NOT_ACTIVATED,
    ACTIVATED_PERMANENT,
    TEMPORARY_SCHEDULED,
    ACTIVE_TEMPORARY,
    TEMPORARY_RETURNED,
    TEMPORARY_CANCELLED_BEFORE_START;

    /** O-10 / O-16: a hierarchy change of the requesting unit pauses a request in these states. */
    public boolean pausesOnHierarchyChange() {
        return this == UNDER_REVIEW || this == APPROVED_NOT_ACTIVATED;
    }
}
