package ae.mover.hr;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.RequestScope;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.security.Actor;

/**
 * Open tasks after a transfer or departure (owner brief §5). For every open task that an affected person could act on
 * before and cannot now: when exactly one active person holds the task's role over its scope, the task is assigned to
 * that person; when nobody or several do, the task waits for the organisation's access managers, who assign it to one
 * person chosen from the authorised list. Candidates are read in pages with no cap before the scope check, so a large
 * organisation never loses an authorised person. Past decisions and signatures are never re-attributed.
 */
@Component
public class TaskRealignment {

    static final int PAGE = 500;
    /** Start of a keyset scan: PostgreSQL orders uuid as unsigned bytes, so the nil UUID precedes every identifier. */
    private static final UUID FIRST = new UUID(0L, 0L);

    private final JdbcClient jdbc;
    private final AccessService access;
    private final AuditService audit;
    private final Clock clock;

    public TaskRealignment(JdbcClient jdbc, AccessService access, AuditService audit, Clock clock) {
        this.jdbc = jdbc;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    record OpenTask(UUID id, String kind, UUID requestId, String roleCode, UUID targetOrgId, boolean finalStage,
                    UUID assignedPersonId, boolean awaiting) {

        String table() {
            return "REVIEW".equals(kind) ? "task_assignment" : "execution_task";
        }
    }

    private static final String OPEN_TASKS = """
            select t.id, 'REVIEW' as kind, t.request_id, t.role_code, t.target_org_id, t.final, t.assigned_person_id, t.awaiting_assignment
            from task_assignment t join request r on r.id = t.request_id where t.status = 'OPEN' and r.status = 'SUBMITTED'
            union all
            select e.id, 'EXECUTION', e.request_id, e.role_code, e.target_org_id, false, e.assigned_person_id, e.awaiting_assignment
            from execution_task e where e.status = 'OPEN'""";

    private List<OpenTask> openTasks(String where) {
        return jdbc.sql("select * from (" + OPEN_TASKS + ") x " + where)
                .query((rs, n) -> new OpenTask(Db.uuid(rs, "id"), rs.getString("kind"), Db.uuid(rs, "request_id"),
                        rs.getString("role_code"), Db.uuid(rs, "target_org_id"), rs.getBoolean("final"),
                        Db.uuid(rs, "assigned_person_id"), rs.getBoolean("awaiting_assignment"))).list();
    }

    public int realign(Map<UUID, AccessContext> before, String reason, Instant now) {
        List<OpenTask> tasks = openTasks("");
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
                boolean could = eligible(e.getValue(), t, scope)
                        && (t.assignedPersonId() == null || t.assignedPersonId().equals(e.getKey())) && !t.awaiting();
                if (could && !eligible(context(contexts, e.getKey(), now), t, scope)) {
                    departed.add(e.getKey());
                }
            }
            if (departed.isEmpty()) {
                continue;
            }
            List<UUID> holders = holders(t, scope, now, contexts, 2);
            UUID routedOrg = t.targetOrgId() != null ? t.targetOrgId() : scope.ownerOrgId();
            if (holders.size() == 1) {
                UUID sole = holders.get(0);
                jdbc.sql("update " + t.table() + " set assigned_person_id = :p, awaiting_assignment = false where id = :id")
                        .param("p", sole).param("id", t.id()).update();
                insert(t, reason, departed, holders, "SOLE_SUBSTITUTE", null, sole, now);
                notify(sole, "TASK_REALIGNED", "أُسندت إليك مهمة مفتوحة",
                        "أصبحت صاحب الصفة الوحيد لمهمة مفتوحة بعد تغير في الانتماء الوظيفي، فأُسندت إليك.", t.requestId(), now);
            } else {
                jdbc.sql("update " + t.table() + " set assigned_person_id = null, awaiting_assignment = true where id = :id")
                        .param("id", t.id()).update();
                insert(t, reason, departed, holders, "ROUTED_TO_ACCESS_MANAGER", routedOrg, null, now);
                for (UUID manager : accessManagers(routedOrg, now, contexts)) {
                    notify(manager, "TASK_ROUTED", holders.isEmpty() ? "مهمة بلا صاحب صفة" : "مهمة تحتاج اختيار صاحب الصفة",
                            holders.isEmpty()
                                    ? "لم يبق من يملك صفة مهمة مفتوحة بعد تغير في الانتماء الوظيفي؛ امنح الصفة لشخص مخول ثم أسند المهمة إليه."
                                    : "يملك أكثر من شخص صفة مهمة مفتوحة بعد تغير في الانتماء الوظيفي؛ اختر من يتولاها.",
                            t.requestId(), now);
                }
            }
            recorded++;
        }
        return recorded;
    }

    private void insert(OpenTask t, String reason, List<UUID> departed, List<UUID> holders, String outcome, UUID routedOrg,
                        UUID assigned, Instant now) {
        jdbc.sql("""
                insert into task_reassignment(id, task_kind, task_id, request_id, reason, departed, holders, outcome, routed_to_org,
                                              assigned_person_id, resolved_at, created_at)
                values (:id, :k, :t, :r, :reason, string_to_array(:d, ',')::uuid[], string_to_array(:h, ',')::uuid[], :o, :org,
                        :a, :resolved, :now)""")
                .param("id", UUID.randomUUID()).param("k", t.kind()).param("t", t.id()).param("r", t.requestId())
                .param("reason", reason).param("d", Db.ids(departed)).param("h", Db.ids(holders)).param("o", outcome)
                .param("org", routedOrg).param("a", assigned).param("resolved", assigned == null ? null : Db.ts(now))
                .param("now", Db.ts(now)).update();
    }

    private static boolean eligible(AccessContext ctx, OpenTask t, RequestScope scope) {
        return "REVIEW".equals(t.kind())
                ? ctx.taskGrant(t.roleCode(), t.targetOrgId(), scope, t.finalStage()).isPresent()
                : ctx.executionGrant(t.roleCode(), t.targetOrgId(), scope).isPresent();
    }

    private AccessContext context(Map<UUID, AccessContext> cache, UUID person, Instant now) {
        return cache.computeIfAbsent(person, p -> access.load(new Actor(p, null, null, null), now));
    }

    /** People holding the role through a membership, a delegation or a seat; keyset pages, optional name filter. */
    private List<UUID> candidatePage(String roleCode, String nameLike, UUID after, Instant now) {
        return jdbc.sql("""
                select c.person_id from (
                  select m.person_id from membership m
                  where m.role_code = :r and m.valid_from <= :now and (m.valid_to is null or m.valid_to > :now)
                  union
                  select d.delegate_id from delegation d join membership m on m.id = d.membership_id
                  where m.role_code = :r and d.revoked_at is null and d.valid_from <= :now and d.valid_to > :now
                  union
                  select a.person_id from affiliation a
                  join position_seat ps on ps.organization_id = a.organization_id and ps.position_id = a.position_id and ps.active
                  where ps.role_code = :r and a.valid_to is null) c
                join person p on p.id = c.person_id and p.status = 'ACTIVE'
                where c.person_id > :after and (cast(:q as text) is null or p.display_name ilike :q or p.employee_no ilike :q)
                order by c.person_id limit :page""")
                .param("r", roleCode).param("now", Db.ts(now)).param("after", after)
                .param("q", nameLike).param("page", PAGE).query(UUID.class).list();
    }

    /** Eligible holders of the task now, scanning every candidate page; stops after {@code max} (0 = no limit). */
    private List<UUID> holders(OpenTask t, RequestScope scope, Instant now, Map<UUID, AccessContext> cache, int max) {
        List<UUID> out = new ArrayList<>();
        UUID after = FIRST;
        while (true) {
            List<UUID> page = candidatePage(t.roleCode(), null, after, now);
            for (UUID p : page) {
                if (eligible(context(cache, p, now), t, scope)) {
                    out.add(p);
                    if (max > 0 && out.size() >= max) {
                        return out;
                    }
                }
            }
            if (page.size() < PAGE) {
                return out;
            }
            after = page.get(page.size() - 1);
        }
    }

    private List<UUID> accessManagers(UUID orgId, Instant now, Map<UUID, AccessContext> cache) {
        List<UUID> out = new ArrayList<>();
        if (orgId == null) {
            return out;
        }
        UUID after = FIRST;
        while (true) {
            List<UUID> page = jdbc.sql("""
                    select distinct m.person_id from membership m join role_def r on r.code = m.role_code
                    join person p on p.id = m.person_id and p.status = 'ACTIVE'
                    where 'MANAGE_ACCESS' = any(r.permissions) and m.valid_from <= :now and (m.valid_to is null or m.valid_to > :now)
                      and m.person_id > :after
                    order by m.person_id limit :page""")
                    .param("now", Db.ts(now)).param("after", after).param("page", PAGE).query(UUID.class).list();
            for (UUID p : page) {
                if (context(cache, p, now).canFor(Permission.MANAGE_ACCESS, orgId)) {
                    out.add(p);
                }
            }
            if (page.size() < PAGE) {
                return out;
            }
            after = page.get(page.size() - 1);
        }
    }

    private void notify(UUID person, String kind, String title, String body, UUID requestId, Instant now) {
        jdbc.sql("""
                insert into notification(id, person_id, kind, title, body, request_id, created_at)
                values (:id, :p, :k, :t, :b, :r, :now)""")
                .param("id", UUID.randomUUID()).param("p", person).param("k", kind).param("t", title).param("b", body)
                .param("r", requestId).param("now", Db.ts(now)).update();
    }

    // ---- the access manager's choice ----------------------------------------------------------------------------

    private Map<String, Object> routed(UUID id) {
        return jdbc.sql("""
                select tr.*, r.number from task_reassignment tr join request r on r.id = tr.request_id
                where tr.id = :id and tr.outcome = 'ROUTED_TO_ACCESS_MANAGER' and tr.resolved_at is null""")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
    }

    private OpenTask taskOf(Map<String, Object> routed) {
        return openTasks("where x.id = '" + routed.get("task_id") + "'").stream().findFirst()
                .orElseThrow(() -> ApiException.validation("المهمة لم تعد مفتوحة."));
    }

    /** Tasks waiting for a choice, limited to the organisations the access manager covers. */
    public List<Map<String, Object>> pending(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        return jdbc.sql("""
                select tr.id, tr.task_kind, tr.request_id, tr.reason, tr.created_at, tr.routed_to_org, o.name as org_name, r.number,
                       coalesce(t.stage_name, e.name) as task_name, coalesce(t.role_code, e.role_code) as role_code
                from task_reassignment tr join request r on r.id = tr.request_id left join organization o on o.id = tr.routed_to_org
                left join task_assignment t on t.id = tr.task_id left join execution_task e on e.id = tr.task_id
                where tr.outcome = 'ROUTED_TO_ACCESS_MANAGER' and tr.resolved_at is null order by tr.created_at""")
                .query((rs, n) -> {
                    UUID org = Db.uuid(rs, "routed_to_org");
                    if (org == null || !ctx.canFor(Permission.MANAGE_ACCESS, org)) {
                        return null;
                    }
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("requestNumber", rs.getString("number"));
                    m.put("taskName", rs.getString("task_name"));
                    m.put("roleCode", rs.getString("role_code"));
                    m.put("organization", rs.getString("org_name"));
                    m.put("reason", rs.getString("reason"));
                    m.put("createdAt", Db.iso(rs, "created_at"));
                    return m;
                }).list().stream().filter(java.util.Objects::nonNull).toList();
    }

    /** Authorised people who could take the task now, searchable and paged (20 per page). */
    public Map<String, Object> candidates(AccessContext ctx, UUID routedId, String q, int page) {
        ctx.require(Permission.MANAGE_ACCESS);
        Map<String, Object> routed = routed(routedId);
        if (!ctx.canFor(Permission.MANAGE_ACCESS, (UUID) routed.get("routed_to_org"))) {
            throw ApiException.notFound();
        }
        OpenTask t = taskOf(routed);
        RequestScope scope = access.requestScope(t.requestId());
        Instant now = clock.instant();
        Map<UUID, AccessContext> cache = new HashMap<>();
        String like = q == null || q.isBlank() ? null : "%" + q.trim().replace("%", "") + "%";
        int skip = Math.max(0, page) * 20;
        List<Map<String, Object>> items = new ArrayList<>();
        boolean more = false;
        UUID after = FIRST;
        outer:
        while (true) {
            List<UUID> batch = candidatePage(t.roleCode(), like, after, now);
            for (UUID p : batch) {
                if (!eligible(context(cache, p, now), t, scope)) {
                    continue;
                }
                if (skip > 0) {
                    skip--;
                    continue;
                }
                if (items.size() == 20) {
                    more = true;
                    break outer;
                }
                Map<String, Object> person = jdbc.sql("select id, display_name, employee_no from person where id = :id")
                        .param("id", p).query().singleRow();
                items.add(Map.of("id", p.toString(), "displayName", person.get("display_name"), "employeeNo", person.get("employee_no")));
            }
            if (batch.size() < PAGE) {
                break;
            }
            after = batch.get(batch.size() - 1);
        }
        return Map.of("items", items, "page", Math.max(0, page), "hasMore", more);
    }

    public record AssignInput(String personId, String reason) {
    }

    /** The access manager assigns the task to one authorised person, with a reason (audited, person notified). */
    @Transactional
    public void assign(AccessContext ctx, UUID routedId, AssignInput in) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (in == null || in.personId() == null || in.reason() == null || in.reason().trim().length() < 5) {
            throw ApiException.validation("اختر الشخص واذكر سبب الإسناد.");
        }
        Map<String, Object> routed = routed(routedId);
        UUID org = (UUID) routed.get("routed_to_org");
        if (!ctx.canFor(Permission.MANAGE_ACCESS, org)) {
            throw ApiException.notFound();
        }
        OpenTask t = taskOf(routed);
        UUID person = UUID.fromString(in.personId());
        Instant now = clock.instant();
        if (!eligible(access.load(new Actor(person, null, null, null), now), t, access.requestScope(t.requestId()))) {
            throw ApiException.validation("الشخص المختار لا يملك صفة المهمة ونطاقها؛ امنحه الصفة أولاً.");
        }
        jdbc.sql("update " + t.table() + " set assigned_person_id = :p, awaiting_assignment = false where id = :id")
                .param("p", person).param("id", t.id()).update();
        jdbc.sql("""
                update task_reassignment set resolved_at = :now, resolved_by = :by, assigned_person_id = :p, resolution_reason = :r
                where id = :id""")
                .param("now", Db.ts(now)).param("by", ctx.personId()).param("p", person).param("r", in.reason().trim())
                .param("id", routedId).update();
        notify(person, "TASK_ASSIGNED", "أُسندت إليك مهمة مفتوحة", "أسند مسؤول الصلاحيات إليك مهمة مفتوحة.", t.requestId(), now);
        audit.recordAs(ctx.actor(), "TASK_ASSIGNED_BY_ACCESS_MANAGER", "REQUEST", t.requestId().toString(), (String) routed.get("number"),
                Map.of("taskId", t.id().toString(), "assignedPersonId", person.toString()), in.reason().trim());
    }
}
