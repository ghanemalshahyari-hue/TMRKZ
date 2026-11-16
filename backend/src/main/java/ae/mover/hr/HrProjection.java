package ae.mover.hr;

import java.time.Clock;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.audit.AuditService;
import ae.mover.common.Db;
import ae.mover.security.Actor;

/**
 * Applies a validated snapshot to the local projection inside the publish transaction: organisations and people keep
 * their TMRKZ identity (matched by source identifier, never by name), HR fields are overwritten only here, local
 * additions live elsewhere and are untouched. Affiliation changes end grants that no longer fit, disable departed
 * people everywhere at once, and hand open tasks to {@link TaskRealignment}. Since ADR-065 the whole unit tree is applied
 * but only the people the snapshot asked HR for (its scope): the linked people of a sync, or one imported person.
 */
@Component
public class HrProjection {

    /** Source people whose employee number is unique in the snapshot (FROM-clause fragment over alias {@code h}). */
    // a grouped semi-join, not a count per person: with 200,000 people the per-row count could fall into a full scan per row
    private static final String UNIQUE_NUMBER = "hr_person h where h.snapshot_id = :s"
            + " and h.employee_number in (select employee_number from hr_person where snapshot_id = :s group by employee_number having count(*) = 1)";
    /**
     * The people this projection may touch (ADR-065): the source identifiers the snapshot asked HR for — the linked people of a
     * sync, or the one person of an import ({@code :one}). Someone the sync no longer reads is never updated or marked departed.
     */
    private static final String SCOPE = "(select sc.external_id from hr_snapshot_scope sc where sc.snapshot_id = :s"
            + " and (cast(:one as text) is null or sc.external_id = cast(:one as text)))";

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AccessService access;
    private final TaskRealignment realignment;
    private final AuditService audit;
    private final SeatRelease seats;

    public HrProjection(JdbcClient jdbc, Clock clock, AccessService access, TaskRealignment realignment, AuditService audit, SeatRelease seats) {
        this.seats = seats;
        this.jdbc = jdbc;
        this.clock = clock;
        this.access = access;
        this.realignment = realignment;
        this.audit = audit;
    }

    public record Result(int organizationsCreated, int organizationsUpdated, int organizationsRetired, int peopleCreated,
                         int peopleAdopted, int peopleUpdated, int peopleDisabled, int transfers, int grantsEnded,
                         int tasksRealigned) {

        public Map<String, Object> asMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("organizationsCreated", organizationsCreated);
            m.put("organizationsUpdated", organizationsUpdated);
            m.put("organizationsRetired", organizationsRetired);
            m.put("peopleCreated", peopleCreated);
            m.put("peopleAdopted", peopleAdopted);
            m.put("peopleUpdated", peopleUpdated);
            m.put("peopleDisabled", peopleDisabled);
            m.put("transfers", transfers);
            m.put("grantsEnded", grantsEnded);
            m.put("tasksRealigned", tasksRealigned);
            return m;
        }
    }

    /** Must run inside the publish transaction. {@code cycleUnits}: source units on a parent cycle, kept as roots. */
    public Result apply(UUID snapshot, Set<String> cycleUnits) {
        Instant now = clock.instant();
        jdbc.sql("select set_config('tmrkz.hr_projection', 'on', true)").query().singleRow();
        Map<String, Object> s = Map.of("s", snapshot, "now", Db.ts(now), "cycles", String.join(",", cycleUnits));
        int[] orgs = organizations(s);
        Result people = people(snapshot, null, now);
        return new Result(orgs[0], orgs[1], orgs[2], people.peopleCreated(), people.peopleAdopted(), people.peopleUpdated(),
                people.peopleDisabled(), people.transfers(), people.grantsEnded(), people.tasksRealigned());
    }

    /**
     * One person imported from HR (ADR-065, «إضافة مستخدم» or a first sign-in): the same rules as the sync, for that source
     * identifier only, over the snapshot row the import just stored. Must run inside the caller's transaction.
     */
    public Result applyPerson(UUID snapshot, String externalId) {
        jdbc.sql("select set_config('tmrkz.hr_projection', 'on', true)").query().singleRow();
        return people(snapshot, java.util.Objects.requireNonNull(externalId), clock.instant());
    }

    private int[] organizations(Map<String, Object> s) {
        // ---- organisations -------------------------------------------------------------------------------------
        // A unit TMRKZ already holds under the same Unit ID (resolved from the directory before Oracle was in force, ADR-068 §25)
        // becomes Oracle's: the Unit ID is the join, so a second node is never made for it.
        int orgAdopted = jdbc.sql("""
                update organization o set source = 'HR', version = o.version + 1
                from hr_unit u where u.snapshot_id = :s and o.source = 'LOCAL' and o.source_external_id = u.external_id
                  and not exists (select 1 from organization x where x.source = 'HR' and x.source_external_id = u.external_id)""")
                .params(s).update();
        if (orgAdopted > 0) {
            audit.system("HR_UNITS_ADOPTED", "HR_SNAPSHOT", String.valueOf(s.get("s")), null, Map.of("count", orgAdopted));
        }
        int orgCreated = jdbc.sql("""
                insert into organization(id, code, name, parent_id, status, valid_from, source, source_external_id)
                select gen_random_uuid(), 'HR-' || u.external_id, u.name, null, case when u.active then 'ACTIVE' else 'RETIRED' end,
                       :now, 'HR', u.external_id
                from hr_unit u where u.snapshot_id = :s
                  and not exists (select 1 from organization o where o.source = 'HR' and o.source_external_id = u.external_id)""")
                .params(s).update();
        int orgUpdated = jdbc.sql("""
                update organization o set name = u.name, status = case when u.active then 'ACTIVE' else 'RETIRED' end,
                       version = o.version + 1
                from hr_unit u where u.snapshot_id = :s and o.source = 'HR' and o.source_external_id = u.external_id
                  and (o.name <> u.name or o.status <> case when u.active then 'ACTIVE' else 'RETIRED' end)""")
                .params(s).update();
        int orgRetired = jdbc.sql("""
                update organization o set status = 'RETIRED', version = o.version + 1
                where o.source = 'HR' and o.status = 'ACTIVE'
                  and not exists (select 1 from hr_unit u where u.snapshot_id = :s and u.external_id = o.source_external_id)""")
                .params(s).update();
        // Re-parent in two steps so an intermediate state never forms a cycle: detach every node whose parent changes,
        // then attach the new parents (any subset of an acyclic final tree is acyclic). Orphans and cycle members stay
        // roots; no parent is ever invented.
        String target = """
                select o.id, p.id as parent from organization o
                join hr_unit u on u.snapshot_id = :s and u.external_id = o.source_external_id
                left join organization p on p.source = 'HR' and p.source_external_id = u.parent_external_id
                  and u.external_id <> all(string_to_array(:cycles, ','))
                where o.source = 'HR'""";
        jdbc.sql("update organization o set parent_id = null from (" + target + ") t where o.id = t.id and o.parent_id is distinct from t.parent and o.parent_id is not null")
                .params(s).update();
        jdbc.sql("update organization o set parent_id = t.parent from (" + target + ") t where o.id = t.id and o.parent_id is distinct from t.parent")
                .params(s).update();
        return new int[] {orgCreated, orgUpdated + orgAdopted, orgRetired};
    }

    private Result people(UUID snapshot, String one, Instant now) {
        Map<String, Object> s = new HashMap<>();
        s.put("s", snapshot);
        s.put("now", Db.ts(now));
        s.put("one", one);

        // ---- who changes: computed before people and affiliations move -------------------------------------------
        List<Map<String, Object>> changes = jdbc.sql("""
                select p.id as person_id, a.organization_id as old_org, o.id as new_org,
                       coalesce(h.active, false) as active, h.external_id is not null as present
                from person p
                left join affiliation a on a.person_id = p.id and a.valid_to is null
                left join hr_person h on h.snapshot_id = :s and h.external_id = p.source_external_id
                left join organization o on o.source = 'HR' and o.source_external_id = h.unit_external_id
                where p.source = 'HR' and p.source_external_id in %s
                  and ((p.status = 'ACTIVE' and (h.external_id is null or not h.active))
                       or (a.id is not null and h.active
                           and (o.id is distinct from a.organization_id or h.position_id is distinct from a.position_id)))"""
                .formatted(SCOPE)).params(s).query().listOfRows();
        Map<UUID, AccessContext> before = new HashMap<>();
        for (Map<String, Object> c : changes) {
            UUID pid = (UUID) c.get("person_id");
            before.put(pid, access.load(new Actor(pid, null, null, null), now));
        }

        // ---- people (an employee number held by two source records links to neither) -----------------------------
        int adopted = jdbc.sql("""
                update person p set source = 'HR', source_external_id = h.external_id
                from %s
                  and h.external_id in %s
                  and p.source = 'LOCAL' and p.source_external_id is null and p.employee_no = h.employee_number
                  and not exists (select 1 from person x where x.source = 'HR' and x.source_external_id = h.external_id)"""
                .formatted(UNIQUE_NUMBER, SCOPE)).params(s).update();
        int created = jdbc.sql("""
                insert into person(id, employee_no, display_name, status, source, source_external_id)
                select gen_random_uuid(), h.employee_number, h.full_name, case when h.active then 'ACTIVE' else 'DISABLED' end,
                       'HR', h.external_id
                from %s
                  and h.external_id in %s
                  and not exists (select 1 from person x where x.source = 'HR' and x.source_external_id = h.external_id)
                  and not exists (select 1 from person x where x.employee_no = h.employee_number)"""
                .formatted(UNIQUE_NUMBER, SCOPE)).params(s).update();
        int updated = jdbc.sql("""
                update person p set display_name = h.full_name, status = case when h.active then 'ACTIVE' else 'DISABLED' end,
                       employee_no = case when exists (select 1 from person x where x.employee_no = h.employee_number and x.id <> p.id)
                                          then p.employee_no else h.employee_number end
                from %s
                  and h.external_id in %s
                  and p.source = 'HR' and p.source_external_id = h.external_id
                  and (p.display_name <> h.full_name or p.employee_no <> h.employee_number
                       or p.status <> case when h.active then 'ACTIVE' else 'DISABLED' end)"""
                .formatted(UNIQUE_NUMBER, SCOPE)).params(s).update();
        // away per HR (leave, absence): left out of who a step goes to, still appointed (ADR-059)
        jdbc.sql("""
                update person p set hr_unavailable = nullif(btrim(h.leave_status), '')
                from hr_person h where h.snapshot_id = :s and h.external_id in %s and p.source = 'HR' and p.source_external_id = h.external_id
                  and p.hr_unavailable is distinct from nullif(btrim(h.leave_status), '')""".formatted(SCOPE)).params(s).update();
        int disabled = jdbc.sql("""
                update person p set status = 'DISABLED'
                where p.source = 'HR' and p.status = 'ACTIVE' and p.source_external_id in %s
                  and not exists (select 1 from hr_person h where h.snapshot_id = :s and h.external_id = p.source_external_id)"""
                .formatted(SCOPE)).params(s).update();

        // ---- affiliations ------------------------------------------------------------------------------------------
        jdbc.sql("""
                update affiliation a set valid_to = :now,
                       ended_reason = case when not coalesce(t.active, false) then 'HR_DEACTIVATED'
                                           when t.org is distinct from a.organization_id then 'HR_TRANSFER' else 'HR_POSITION_CHANGE' end
                from (select p.id as person_id, h.active, o.id as org, h.position_id from person p
                      left join hr_person h on h.snapshot_id = :s and h.external_id = p.source_external_id
                      left join organization o on o.source = 'HR' and o.source_external_id = h.unit_external_id
                      where p.source = 'HR' and p.source_external_id in %s) t
                where a.person_id = t.person_id and a.valid_to is null
                  and (not coalesce(t.active, false) or t.org is distinct from a.organization_id or t.position_id is distinct from a.position_id)"""
                .formatted(SCOPE)).params(s).update();
        jdbc.sql("""
                insert into affiliation(id, person_id, organization_id, position_id, position_title, valid_from)
                select gen_random_uuid(), p.id, o.id, h.position_id, h.position_title, :now
                from person p
                join hr_person h on h.snapshot_id = :s and h.external_id = p.source_external_id and h.active
                join organization o on o.source = 'HR' and o.source_external_id = h.unit_external_id
                where p.source = 'HR' and p.source_external_id in %s
                  and not exists (select 1 from affiliation a where a.person_id = p.id and a.valid_to is null)"""
                .formatted(SCOPE)).params(s).update();

        // ---- consequences ------------------------------------------------------------------------------------------
        int grantsEnded = 0;
        int transfers = 0;
        for (Map<String, Object> c : changes) {
            UUID pid = (UUID) c.get("person_id");
            boolean gone = !(Boolean) c.get("present") || !(Boolean) c.get("active");
            if (gone) {
                grantsEnded += jdbc.sql("""
                        update membership set valid_to = greatest(:now, valid_from + interval '1 second'), ended_reason = 'HR_DEACTIVATED'
                        where person_id = :p and (valid_to is null or valid_to > :now)""")
                        .param("p", pid).param("now", Db.ts(now)).update();
                jdbc.sql("""
                        update delegation set revoked_at = :now, revoke_reason = 'HR_DEACTIVATED'
                        where (delegator_id = :p or delegate_id = :p) and revoked_at is null and valid_to > :now""")
                        .param("p", pid).param("now", Db.ts(now)).update();
                jdbc.sql("delete from user_session where person_id = :p").param("p", pid).update();
            } else if (c.get("new_org") != null && !c.get("new_org").equals(c.get("old_org"))) {
                transfers++;
                // first the unit's responsibilities the person held for the unit they left: they stay with that unit, released to
                // its next holder and audited as such (ADR-069, §20/§23); then every other grant that follows the posting
                grantsEnded += seats.release(pid, (UUID) c.get("old_org"), (UUID) c.get("new_org"), "ORACLE", now);
                grantsEnded += jdbc.sql("""
                        update membership m set valid_to = greatest(:now, m.valid_from + interval '1 second'), ended_reason = 'HR_TRANSFER'
                        where m.person_id = :p and m.follows_affiliation and (m.valid_to is null or m.valid_to > :now)
                          and not exists (
                            with recursive up(id, parent_id) as (
                              select id, parent_id from organization where id = :org
                              union all select o.id, o.parent_id from organization o join up on o.id = up.parent_id)
                            select 1 from up where up.id = m.organization_id)""")
                        .param("p", pid).param("now", Db.ts(now)).param("org", c.get("new_org")).update();
                // a user of the old unit (added there, not acting) is a user of the new one (owner, 16 Nov 2026, as TNQL's
                // reconciliation): the old entry ends so the old unit's grants given to all stop reaching them; an acting entry
                // (added on purpose while posted elsewhere) stays
                if (c.get("old_org") != null && jdbc.sql("""
                        update unit_member set ended_at = :now, ended_by = :p, ended_reason = 'HR_TRANSFER'
                        where person_id = :p and organization_id = :old and not acting and ended_at is null""")
                        .param("p", pid).param("old", c.get("old_org")).param("now", Db.ts(now)).update() > 0) {
                    jdbc.sql("""
                            insert into unit_member(id, person_id, organization_id, acting, added_by, added_at)
                            select :id, :p, :org, false, :p, :now
                            where not exists (select 1 from unit_member where person_id = :p and organization_id = :org and ended_at is null)""")
                            .param("id", UUID.randomUUID()).param("p", pid).param("org", c.get("new_org")).param("now", Db.ts(now)).update();
                }
            }
            audit.system(gone ? "HR_PERSON_DEPARTED" : "HR_AFFILIATION_CHANGED", "PERSON", pid.toString(), null,
                    Map.of("transfer", !gone && c.get("new_org") != null && !c.get("new_org").equals(c.get("old_org"))));
        }
        int realigned = before.isEmpty() ? 0 : realignment.realign(before, "HR_SYNC", now);
        return new Result(0, 0, 0, created, adopted, updated, disabled, transfers, grantsEnded, realigned);
    }
}
