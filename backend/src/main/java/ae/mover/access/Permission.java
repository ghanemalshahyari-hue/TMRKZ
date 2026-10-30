package ae.mover.access;

/**
 * Independent actions. Holding one never implies another: CREATE does not allow editing a returned request (EDIT),
 * CONFIGURE does not allow reading request content (VIEW) or deciding (REVIEW/APPROVE), and VIEW_SUMMARY never
 * reveals occupant data or attachments. CLOSE (administrative completion of an approved request) is separate from
 * REVIEW and APPROVE.
 */
public enum Permission {
    VIEW, VIEW_SUMMARY, CREATE, EDIT, REVIEW, APPROVE, EXPORT, EXECUTE,
    MANAGE_FACILITIES, MANAGE_ACCESS, CONFIGURE, AUDIT, VIEW_SOURCE_IDENTIFIERS, CLOSE
}
