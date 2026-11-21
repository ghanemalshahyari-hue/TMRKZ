package ae.mover.access;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Independent actions. Holding one never implies another: CREATE does not allow editing a returned request (EDIT),
 * CONFIGURE does not allow reading request content (VIEW) or deciding (REVIEW/APPROVE), and VIEW_SUMMARY never
 * reveals occupant data or attachments. CLOSE (administrative completion of an approved request) is separate from
 * REVIEW and APPROVE. Stationing (ADR-031): CORRECT_STATIONING records or corrects a unit's authoritative stationing as
 * a data correction (site setup only, ADR-078), MANAGE_SITE_LINKS creates and ends site links (never stationing),
 * REPLAY_STATIONING_EVENTS puts a failed outbound stationing event back for delivery (an operator action over every
 * organisation, held by «مدير النظام» since ADR-078).
 *
 * <p>Stationing requests (ADR-033, ADR-045, simplified by ADR-078, further simplified by ADR-095): CREATE_RESTATIONING
 * prepares and submits a re-stationing or a deployment-area request for a requesting unit and starts the lifecycle actions
 * of the unit's requests (cancellation, extension, early return); REQUEST_SITE_REGISTRATION asks for a new site. There is
 * no separate activation right since ADR-095: a finally approved request activates as part of the final approver's decision,
 * inside the same transaction, with the same server checks that a separate activation used to apply (every unit, geography
 * re-check, atomic conflict prevention). The hierarchy stages are decided through APPROVE_HIERARCHY held in the stage unit's
 * own approver seat; DECIDE_UNIT_OPERATIONS and FINAL_APPROVE_STATIONING decide their configured stage. The final approver
 * also decides a request that exceeds the policy's deployment range (no separate exception stage) and the lifecycle actions
 * started by a requester. The units informed after final approval are read from the requesting unit's FYI target list
 * («تحديد وحدات العلم», a per-unit configuration under the owning unit's access manager, not a per-request human action).
 * VIEW_OPERATIONAL_POSTURE is read-only and opens nothing else. Initial stationing is recorded only by site setup
 * («تهيئة المواقع», ADR-067/076/078).
 *
 * <p>APPROVE_HIERARCHY (owner decision of 16 Nov 2026, ADR-063): signs a level of the hierarchy climb of a stationing request —
 * held by «معتمد السلسلة الهرمية» only, so a final approver (APPROVE over everything) is never a hierarchy station.
 */
public enum Permission {
    VIEW, VIEW_SUMMARY, CREATE, EDIT, REVIEW, APPROVE, EXPORT, EXECUTE,
    MANAGE_FACILITIES, MANAGE_ACCESS, CONFIGURE, AUDIT, VIEW_SOURCE_IDENTIFIERS, CLOSE,
    CORRECT_STATIONING, MANAGE_SITE_LINKS, REPLAY_STATIONING_EVENTS,
    CREATE_RESTATIONING, REQUEST_SITE_REGISTRATION,
    DECIDE_UNIT_OPERATIONS, FINAL_APPROVE_STATIONING, VIEW_OPERATIONAL_POSTURE,
    APPROVE_HIERARCHY;

    /**
     * Permissions that decide a stage of somebody else's request (approve, recommend, decide). A role holding any of them is a
     * responsibility of the unit — a seat its current holder occupies — rather than a personal permission (LDAP first login
     * specification §19–22, owner 16 Nov 2026): «مسؤوليات/مقاعد الوحدة» against «صلاحيات الشخص» in
     * «إدارة الصلاحيات والوحدات». Derived from the role's permissions, never from its name. Since ADR-095 there is no
     * separate activation right and no human «توزيع للعلم» step; activation runs as part of the final approver's decision
     * and the units informed are read from the requesting unit's FYI target configuration.
     */
    public static final java.util.Set<Permission> STAGE_DECISIONS = java.util.EnumSet.of(APPROVE, REVIEW, APPROVE_HIERARCHY,
            DECIDE_UNIT_OPERATIONS, FINAL_APPROVE_STATIONING);

    /** The action a stored name stands for, or empty for an unknown one (never an exception on historical data). */
    public static Optional<Permission> parse(String name) {
        if (name == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(valueOf(name));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    /**
     * A stored list of action names as today's actions: an unknown name is dropped. ACTIVATE_STATIONING and
     * MANAGE_FYI_DISTRIBUTION are dropped since ADR-095 (activation is part of final approval; FYI is a per-unit
     * configuration). Order is kept and duplicates removed. Used where a policy version is restored.
     */
    public static List<String> current(List<String> names) {
        Set<String> out = new LinkedHashSet<>();
        for (String n : names == null ? List.<String>of() : names) {
            parse(n).ifPresent(x -> out.add(x.name()));
        }
        return new ArrayList<>(out);
    }
}
