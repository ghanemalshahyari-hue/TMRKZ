package ae.mover.hr;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.Db;

/**
 * Approval responsibilities belong to the unit, a human is their current holder (owner decision «UNIT-OWNED APPROVAL SEATS»,
 * 16 Nov 2026, §19–23; ADR-069). A seat — a role whose permissions decide a stage of somebody else's request
 * ({@link Permission#STAGE_DECISIONS}: hierarchy, unit operations, final approval, FYI distribution, activation, access review,
 * ADR-066) — held at the unit the person was posted in, or above it, is released when the person's posting leaves that unit's
 * branch: the grant ends (reason {@link #REASON}), the seat itself stays with the unit, and its open steps go to the current
 * holders (the caller realigns them). Nothing moves to the new unit. It runs before the existing safe rule of an HR transfer
 * (V3: a grant that follows the posting ends when the person leaves its unit's branch, {@code HR_TRANSFER}), so a seat is told
 * apart in the history from a personal permission ending under that same rule. A grant marked as not following the posting
 * (an explicit cross-organisation grant) is never released here.
 */
@Component
public class SeatRelease {

    public static final String REASON = "SEAT_UNIT_LEFT";

    private final JdbcClient jdbc;
    private final AuditService audit;
    private final ae.mover.access.AccessService access;
    private final org.springframework.beans.factory.ObjectProvider<TaskRealignment> realignment;

    public SeatRelease(JdbcClient jdbc, AuditService audit, ae.mover.access.AccessService access,
                       org.springframework.beans.factory.ObjectProvider<TaskRealignment> realignment) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.access = access;
        this.realignment = realignment;
    }

    /**
     * The directory (Mode A, before Oracle) reports a different Unit ID at a sign-in (owner §23): the same consequences as an HR
     * transfer — the old unit's user entry ends and the person becomes a user of the new one (an acting entry stays), seats held
     * for the old unit are released, open steps go to their current holders, and personal grants and submitted requests stay
     * where they are. Audited {@code IDENTITY_UNIT_CHANGED}.
     */
    public void directoryMove(UUID person, UUID oldOrg, UUID newOrg, Instant now) {
        Map<UUID, ae.mover.access.AccessContext> before = Map.of(person,
                access.load(new ae.mover.security.Actor(person, null, null, null), now));
        if (jdbc.sql("""
                update unit_member set ended_at = :now, ended_by = :p, ended_reason = 'DIRECTORY_UNIT_CHANGED'
                where person_id = :p and organization_id = :old and not acting and ended_at is null""")
                .param("p", person).param("old", oldOrg).param("now", Db.ts(now)).update() > 0) {
            jdbc.sql("""
                    insert into unit_member(id, person_id, organization_id, acting, added_by, added_at)
                    select :id, :p, :org, false, :p, :now
                    where not exists (select 1 from unit_member where person_id = :p and organization_id = :org and ended_at is null)""")
                    .param("id", UUID.randomUUID()).param("p", person).param("org", newOrg).param("now", Db.ts(now)).update();
        }
        int released = release(person, oldOrg, newOrg, "LDAP", now);
        // the same safe rule as an HR transfer: a grant that follows the person's posting ends when they leave its unit's branch
        // (never moved to the new unit); a grant marked as not following the posting stays
        int ended = jdbc.sql("""
                with recursive up(id, parent_id) as (
                  select id, parent_id from organization where id = :org
                  union all select o.id, o.parent_id from organization o join up on o.id = up.parent_id)
                update membership m set valid_to = greatest(:now, m.valid_from + interval '1 second'), ended_reason = 'DIRECTORY_UNIT_CHANGED'
                where m.person_id = :p and m.follows_affiliation and (m.valid_to is null or m.valid_to > :now)
                  and m.organization_id not in (select id from up)""")
                .param("p", person).param("now", Db.ts(now)).param("org", newOrg).update();
        int realigned = realignment.getObject().realign(before, "DIRECTORY_UNIT_CHANGED", now);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("from", oldOrg.toString());
        detail.put("to", newOrg.toString());
        detail.put("source", "LDAP");
        detail.put("seatsReleased", released);
        detail.put("grantsEnded", ended);
        detail.put("tasksRealigned", realigned);
        audit.system("IDENTITY_UNIT_CHANGED", "PERSON", person.toString(), null, detail);
    }

    /**
     * Ends the person's seats held for {@code oldOrg}'s branch that do not also cover {@code newOrg}; audited once per seat
     * ({@code UNIT_SEAT_RELEASED}). {@code source}: ORACLE (HR synchronisation) or LDAP (the directory, before Oracle).
     *
     * @return how many seats were released
     */
    public int release(UUID person, UUID oldOrg, UUID newOrg, String source, Instant now) {
        if (oldOrg == null || oldOrg.equals(newOrg)) {
            return 0;
        }
        String seatPermissions = String.join(",", Permission.STAGE_DECISIONS.stream().map(Enum::name).toList());
        List<Map<String, Object>> released = jdbc.sql("""
                with recursive was(id, parent_id) as (
                  select id, parent_id from organization where id = :old
                  union all select o.id, o.parent_id from organization o join was on o.id = was.parent_id),
                now_(id, parent_id) as (
                  select id, parent_id from organization where id = :new
                  union all select o.id, o.parent_id from organization o join now_ on o.id = now_.parent_id)
                update membership m set valid_to = greatest(:now, m.valid_from + interval '1 second'), ended_reason = :reason
                where m.person_id = :p and m.follows_affiliation and (m.valid_to is null or m.valid_to > :now)
                  and exists (select 1 from role_def r where r.code = m.role_code and r.permissions && string_to_array(:seat, ',')::text[])
                  and m.organization_id in (select id from was)
                  and m.organization_id not in (select id from now_)
                returning m.id, m.role_code, m.organization_id""")
                .param("old", oldOrg).param("new", newOrg).param("now", Db.ts(now)).param("reason", REASON)
                .param("p", person).param("seat", seatPermissions).query().listOfRows();
        for (Map<String, Object> r : released) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("membershipId", r.get("id").toString());
            detail.put("role", r.get("role_code"));
            detail.put("organizationId", r.get("organization_id").toString());
            detail.put("from", oldOrg.toString());
            detail.put("to", newOrg == null ? null : newOrg.toString());
            detail.put("source", source);
            audit.system("UNIT_SEAT_RELEASED", "PERSON", person.toString(), null, detail);
        }
        if (!released.isEmpty()) {
            // what was made and ends with a released grant: its tied final step and what was delegated from it (as GrantAdminService.end)
            jdbc.sql("""
                    update membership set valid_to = greatest(:now, valid_from + interval '1 second'), ended_reason = :reason
                    where sponsor_id = any(string_to_array(:ids, ',')::uuid[]) and (valid_to is null or valid_to > :now)""")
                    .param("now", Db.ts(now)).param("reason", REASON)
                    .param("ids", Db.ids(released.stream().map(r -> (UUID) r.get("id")).toList())).update();
        }
        return released.size();
    }
}
