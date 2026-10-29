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
 * people everywhere at once, and hand open tasks to {@link TaskRealignment}.
 */
@Component
public class HrProjection {

    /** Source people whose employee number is unique in the snapshot (FROM-clause fragment over alias {@code h}). */
    private static final String UNIQUE_NUMBER = "hr_person h where h.snapshot_id = :s"
            + " and (select count(*) from hr_person d where d.snapshot_id = :s and d.employee_number = h.employee_number) = 1";

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AccessService access;
    private final TaskRealignment realignment;
    private final AuditService audit;

    public HrProjection(JdbcClient jdbc, Clock clock, AccessService access, TaskRealignment realignment, AuditService audit) {
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

        // ---- organisations -------------------------------------------------------------------------------------
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

        // ---- who changes: computed before people and affiliations move -------------------------------------------
        List<Map<String, Object>> changes = jdbc.sql("""
                select p.id as person_id, a.organization_id as old_org, o.id as new_org,
                       coalesce(h.active, false) as active, h.external_id is not null as present
                from person p
                left join affiliation a on a.person_id = p.id and a.valid_to is null
                left join hr_person h on h.snapshot_id = :s and h.external_id = p.source_external_id
                left join organization o on o.source = 'HR' and o.source_external_id = h.unit_external_id
                where p.source = 'HR'
                  and ((p.status = 'ACTIVE' and (h.external_id is null or not h.active))
                       or (a.id is not null and h.active
                           and (o.id is distinct from a.organization_id or h.position_id is distinct from a.position_id)))""")
                .params(s).query().listOfRows();
        Map<UUID, AccessContext> before = new HashMap<>();
        for (Map<String, Object> c : changes) {
            UUID pid = (UUID) c.get("person_id");
            before.put(pid, access.load(new Actor(pid, null, null, null), now));
        }

        // ---- people (an employee number held by two source records links to neither) -----------------------------
        int adopted = jdbc.sql("""
                update person p set source = 'HR', source_external_id = h.external_id
                from %s
                  and p.source = 'LOCAL' and p.source_external_id is null and p.employee_no = h.employee_number
                  and not exists (select 1 from person x where x.source = 'HR' and x.source_external_id = h.external_id)"""
                .formatted(UNIQUE_NUMBER)).params(s).update();
        int created = jdbc.sql("""
                insert into person(id, employee_no, display_name, status, source, source_external_id)
                select gen_random_uuid(), h.employee_number, h.full_name, case when h.active then 'ACTIVE' else 'DISABLED' end,
                       'HR', h.external_id
                from %s
                  and not exists (select 1 from person x where x.source = 'HR' and x.source_external_id = h.external_id)
                  and not exists (select 1 from person x where x.employee_no = h.employee_number)"""
                .formatted(UNIQUE_NUMBER)).params(s).update();
        int updated = jdbc.sql("""
                update person p set display_name = h.full_name, status = case when h.active then 'ACTIVE' else 'DISABLED' end,
                       employee_no = case when exists (select 1 from person x where x.employee_no = h.employee_number and x.id <> p.id)
                                          then p.employee_no else h.employee_number end
                from %s
                  and p.source = 'HR' and p.source_external_id = h.external_id
                  and (p.display_name <> h.full_name or p.employee_no <> h.employee_number
                       or p.status <> case when h.active then 'ACTIVE' else 'DISABLED' end)"""
                .formatted(UNIQUE_NUMBER)).params(s).update();
        int disabled = jdbc.sql("""
                update person p set status = 'DISABLED'
                where p.source = 'HR' and p.status = 'ACTIVE'
                  and not exists (select 1 from hr_person h where h.snapshot_id = :s and h.external_id = p.source_external_id)""")
                .params(s).update();

        // ---- affiliations ------------------------------------------------------------------------------------------
        jdbc.sql("""
                update affiliation a set valid_to = :now,
                       ended_reason = case when not coalesce(t.active, false) then 'HR_DEACTIVATED'
                                           when t.org is distinct from a.organization_id then 'HR_TRANSFER' else 'HR_POSITION_CHANGE' end
                from (select p.id as person_id, h.active, o.id as org, h.position_id from person p
                      left join hr_person h on h.snapshot_id = :s and h.external_id = p.source_external_id
                      left join organization o on o.source = 'HR' and o.source_external_id = h.unit_external_id
                      where p.source = 'HR') t
                where a.person_id = t.person_id and a.valid_to is null
                  and (not coalesce(t.active, false) or t.org is distinct from a.organization_id or t.position_id is distinct from a.position_id)""")
                .params(s).update();
        jdbc.sql("""
                insert into affiliation(id, person_id, organization_id, position_id, position_title, valid_from)
                select gen_random_uuid(), p.id, o.id, h.position_id, h.position_title, :now
                from person p
                join hr_person h on h.snapshot_id = :s and h.external_id = p.source_external_id and h.active
                join organization o on o.source = 'HR' and o.source_external_id = h.unit_external_id
                where p.source = 'HR' and not exists (select 1 from affiliation a where a.person_id = p.id and a.valid_to is null)""")
                .params(s).update();

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
                grantsEnded += jdbc.sql("""
                        update membership m set valid_to = greatest(:now, m.valid_from + interval '1 second'), ended_reason = 'HR_TRANSFER'
                        where m.person_id = :p and m.follows_affiliation and (m.valid_to is null or m.valid_to > :now)
                          and not exists (
                            with recursive up(id, parent_id) as (
                              select id, parent_id from organization where id = :org
                              union all select o.id, o.parent_id from organization o join up on o.id = up.parent_id)
                            select 1 from up where up.id = m.organization_id)""")
                        .param("p", pid).param("now", Db.ts(now)).param("org", c.get("new_org")).update();
            }
            audit.system(gone ? "HR_PERSON_DEPARTED" : "HR_AFFILIATION_CHANGED", "PERSON", pid.toString(), null,
                    Map.of("transfer", !gone && c.get("new_org") != null && !c.get("new_org").equals(c.get("old_org"))));
        }
        int realigned = before.isEmpty() ? 0 : realignment.realign(before, "HR_SYNC", now);
        return new Result(orgCreated, orgUpdated, orgRetired, created, adopted, updated, disabled, transfers, grantsEnded, realigned);
    }
}
