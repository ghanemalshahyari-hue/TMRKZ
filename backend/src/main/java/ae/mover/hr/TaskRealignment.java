package ae.mover.hr;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.RequestScope;
import ae.mover.common.Db;
import ae.mover.security.Actor;

/**
 * Open tasks are held by a role over a scope, never by a named person, so a transfer cannot strand a task in someone's
 * inbox. What a transfer can do is take away the last person able to act. For every open task that a departing person
 * could act on before and cannot now, this records who can act now: a single holder (the new occupant of the position
 * or role) is notified that the task is theirs; with nobody left the task is routed to the access managers of the
 * organisation, who choose from authorised people; with several holders the pool continues. Past decisions and
 * signatures are never re-attributed.
 */
@Component
public class TaskRealignment {

    private static final int MAX_CANDIDATES = 2000;

    private final JdbcClient jdbc;
    private final AccessService access;

    public TaskRealignment(JdbcClient jdbc, AccessService access) {
        this.jdbc = jdbc;
        this.access = access;
    }

    record OpenTask(UUID id, String kind, UUID requestId, String roleCode, UUID targetOrgId, boolean finalStage) {
    }

    public int realign(Map<UUID, AccessContext> before, String reason, Instant now) {
        List<OpenTask> tasks = jdbc.sql("""
                select t.id, 'REVIEW' as kind, t.request_id, t.role_code, t.target_org_id, t.final
                from task_assignment t join request r on r.id = t.request_id where t.status = 'OPEN' and r.status = 'SUBMITTED'
                union all
                select e.id, 'EXECUTION', e.request_id, e.role_code, e.target_org_id, false from execution_task e where e.status = 'OPEN'""")
                .query((rs, n) -> new OpenTask(Db.uuid(rs, "id"), rs.getString("kind"), Db.uuid(rs, "request_id"),
                        rs.getString("role_code"), Db.uuid(rs, "target_org_id"), rs.getBoolean("final"))).list();
        if (tasks.isEmpty()) {
            return 0;
        }
        Map<UUID, RequestScope> scopes = access.scopes(tasks.stream().map(OpenTask::requestId).distinct().toList());
        Map<UUID, AccessContext> contexts = new HashMap<>();
        int recorded = 0;
        for (OpenTask t : tasks) {
            RequestScope scope = scopes.get(t.requestId());
            if (scope == null) {
                continue;
            }
            List<UUID> departed = new ArrayList<>();
            for (Map.Entry<UUID, AccessContext> e : before.entrySet()) {
                if (eligible(e.getValue(), t, scope) && !eligible(context(contexts, e.getKey(), now), t, scope)) {
                    departed.add(e.getKey());
                }
            }
            if (departed.isEmpty()) {
                continue;
            }
            List<UUID> holders = holders(t, scope, now, contexts);
            String outcome = holders.size() == 1 ? "SOLE_SUBSTITUTE" : holders.isEmpty() ? "ROUTED_TO_ACCESS_MANAGER" : "POOL_CONTINUES";
            UUID routedOrg = t.targetOrgId() != null ? t.targetOrgId() : scope.ownerOrgId();
            jdbc.sql("""
                    insert into task_reassignment(id, task_kind, task_id, request_id, reason, departed, holders, outcome, routed_to_org, created_at)
                    values (:id, :k, :t, :r, :reason, string_to_array(:d, ',')::uuid[], string_to_array(:h, ',')::uuid[], :o, :org, :now)""")
                    .param("id", UUID.randomUUID()).param("k", t.kind()).param("t", t.id()).param("r", t.requestId())
                    .param("reason", reason).param("d", Db.ids(departed)).param("h", Db.ids(holders)).param("o", outcome)
                    .param("org", "ROUTED_TO_ACCESS_MANAGER".equals(outcome) ? routedOrg : null).param("now", Db.ts(now)).update();
            if ("SOLE_SUBSTITUTE".equals(outcome)) {
                notify(holders.get(0), "TASK_REALIGNED", "انتقلت إليك مهمة مفتوحة",
                        "أصبحت صاحب الصفة الوحيد لمهمة مفتوحة بعد تغير في الانتماء الوظيفي.", t.requestId(), now);
            } else if ("ROUTED_TO_ACCESS_MANAGER".equals(outcome)) {
                for (UUID manager : accessManagers(routedOrg, now, contexts)) {
                    notify(manager, "TASK_ROUTED", "مهمة بلا صاحب صفة",
                            "لم يبق من يملك صفة مهمة مفتوحة بعد تغير في الانتماء الوظيفي؛ اختر شخصاً مخولاً وامنحه الصفة.",
                            t.requestId(), now);
                }
            }
            recorded++;
        }
        return recorded;
    }

    private static boolean eligible(AccessContext ctx, OpenTask t, RequestScope scope) {
        return "REVIEW".equals(t.kind())
                ? ctx.taskGrant(t.roleCode(), t.targetOrgId(), scope, t.finalStage()).isPresent()
                : ctx.executionGrant(t.roleCode(), t.targetOrgId(), scope).isPresent();
    }

    private AccessContext context(Map<UUID, AccessContext> cache, UUID person, Instant now) {
        return cache.computeIfAbsent(person, p -> access.load(new Actor(p, null, null, null), now));
    }

    /** People who can act on the task now: holders of the role through a membership, a delegation or a seat. */
    private List<UUID> holders(OpenTask t, RequestScope scope, Instant now, Map<UUID, AccessContext> cache) {
        List<UUID> out = new ArrayList<>();
        for (UUID p : candidates(t.roleCode(), now)) {
            if (eligible(context(cache, p, now), t, scope)) {
                out.add(p);
            }
        }
        return out;
    }

    private Set<UUID> candidates(String roleCode, Instant now) {
        return new LinkedHashSet<>(jdbc.sql("""
                select m.person_id from membership m join person p on p.id = m.person_id and p.status = 'ACTIVE'
                where m.role_code = :r and m.valid_from <= :now and (m.valid_to is null or m.valid_to > :now)
                union
                select d.delegate_id from delegation d join membership m on m.id = d.membership_id
                where m.role_code = :r and d.revoked_at is null and d.valid_from <= :now and d.valid_to > :now
                union
                select a.person_id from affiliation a
                join position_seat ps on ps.organization_id = a.organization_id and ps.position_id = a.position_id and ps.active
                where ps.role_code = :r and a.valid_to is null
                limit :max""")
                .param("r", roleCode).param("now", Db.ts(now)).param("max", MAX_CANDIDATES).query(UUID.class).list());
    }

    private List<UUID> accessManagers(UUID orgId, Instant now, Map<UUID, AccessContext> cache) {
        List<UUID> out = new ArrayList<>();
        if (orgId == null) {
            return out;
        }
        List<UUID> people = jdbc.sql("""
                select distinct m.person_id from membership m join role_def r on r.code = m.role_code
                join person p on p.id = m.person_id and p.status = 'ACTIVE'
                where 'MANAGE_ACCESS' = any(r.permissions) and m.valid_from <= :now and (m.valid_to is null or m.valid_to > :now)""")
                .param("now", Db.ts(now)).query(UUID.class).list();
        for (UUID p : people) {
            if (context(cache, p, now).canFor(Permission.MANAGE_ACCESS, orgId)) {
                out.add(p);
            }
        }
        return out;
    }

    private void notify(UUID person, String kind, String title, String body, UUID requestId, Instant now) {
        jdbc.sql("""
                insert into notification(id, person_id, kind, title, body, request_id, created_at)
                values (:id, :p, :k, :t, :b, :r, :now)""")
                .param("id", UUID.randomUUID()).param("p", person).param("k", kind).param("t", title).param("b", body)
                .param("r", requestId).param("now", Db.ts(now)).update();
    }
}
