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
 *
 * <p>Complete request phase (ADR-045): CREATE_INITIAL_STATIONING, CREATE_DEPLOYMENT_REQUEST and REQUEST_SITE_REGISTRATION
 * open their own request; DECIDE_UNIT_OPERATIONS and FINAL_APPROVE_STATIONING decide their configured stage;
 * MANAGE_FYI_DISTRIBUTION chooses the units informed after final approval; VIEW_OPERATIONAL_POSTURE is read-only and opens
 * nothing else.
 *
 * <p>APPROVE_HIERARCHY (owner decision of 16 Nov 2026, ADR-063): signs a level of the hierarchy climb of a stationing request —
 * held by «معتمد السلسلة الهرمية» only, so a final approver (APPROVE over everything) is never a hierarchy station.
 */
public enum Permission {
    VIEW, VIEW_SUMMARY, CREATE, EDIT, REVIEW, APPROVE, EXPORT, EXECUTE,
    MANAGE_FACILITIES, MANAGE_ACCESS, CONFIGURE, AUDIT, VIEW_SOURCE_IDENTIFIERS, CLOSE,
    CORRECT_STATIONING, MANAGE_SITE_LINKS, REPLAY_STATIONING_EVENTS,
    CREATE_RESTATIONING, ACTIVATE_STATIONING, APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION,
    DECIDE_PRE_ACTIVATION_CANCELLATION, ACTIVATE_TEMPORARY_EXTENSION, DECIDE_EARLY_RETURN, DECIDE_BEFORE_START_CANCELLATION,
    CREATE_INITIAL_STATIONING, CREATE_DEPLOYMENT_REQUEST, REQUEST_SITE_REGISTRATION,
    DECIDE_UNIT_OPERATIONS, FINAL_APPROVE_STATIONING, MANAGE_FYI_DISTRIBUTION, VIEW_OPERATIONAL_POSTURE,
    APPROVE_HIERARCHY;

    /**
     * Permissions that decide a stage of somebody else's request (approve, recommend, decide, distribute for information,
     * activate). A role holding any of them is a responsibility of the unit — a seat its current holder occupies — rather than a
     * personal permission (LDAP first login specification §19–22, owner 16 Nov 2026): «مسؤوليات/مقاعد الوحدة» against
     * «صلاحيات الشخص» in «إدارة الصلاحيات والوحدات». Derived from the role's permissions, never from its name.
     */
    public static final java.util.Set<Permission> STAGE_DECISIONS = java.util.EnumSet.of(APPROVE, REVIEW, APPROVE_HIERARCHY,
            DECIDE_UNIT_OPERATIONS, FINAL_APPROVE_STATIONING, MANAGE_FYI_DISTRIBUTION, ACTIVATE_STATIONING, ACTIVATE_TEMPORARY_EXTENSION,
            APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION, DECIDE_PRE_ACTIVATION_CANCELLATION, DECIDE_EARLY_RETURN, DECIDE_BEFORE_START_CANCELLATION);
}
