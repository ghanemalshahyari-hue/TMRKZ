package ae.mover.reservations;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.ViewLevel;
import ae.mover.common.Db;
import ae.mover.common.Ref;
import ae.mover.common.Times;
import ae.mover.requests.Commands.CompleteInput;
import ae.mover.requests.RequestViews;
import ae.mover.security.Actor;

@RestController
@RequestMapping("/api/v1")
public class ReservationController {

    private final JdbcClient jdbc;
    private final AccessService access;
    private final ExecutionService execution;

    public ReservationController(JdbcClient jdbc, AccessService access, ExecutionService execution) {
        this.jdbc = jdbc;
        this.access = access;
        this.execution = execution;
    }

    /** Approved reservations visible through the actor's site/organisation scope; occupant omitted for summary viewers. */
    @GetMapping("/reservations")
    public List<Map<String, Object>> list(Actor actor, @RequestParam(required = false) String from,
                                          @RequestParam(required = false) String to,
                                          @RequestParam(required = false) UUID resourceId,
                                          @RequestParam(required = false) String status) {
        AccessContext ctx = access.context(actor);
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        StringBuilder where = new StringBuilder("true");
        Map<String, Object> params = new HashMap<>();
        if (resourceId != null) {
            where.append(" and v.resource_id = :res");
            params.put("res", resourceId);
        }
        if (status != null && !status.isBlank()) {
            where.append(" and v.status = :st");
            params.put("st", status);
        }
        Instant a = from == null ? null : Times.parse(from.length() == 10 ? from + "T00:00:00Z" : from, "from");
        Instant b = to == null ? null : Times.parse(to.length() == 10 ? to + "T00:00:00Z" : to, "to");
        if (a != null || b != null) {
            where.append(" and tstzrange(v.period_start, v.period_end, '[)') && tstzrange(:a, :b, '[)')");
            params.put("a", Db.ts(a));
            params.put("b", Db.ts(b));
        }
        List<Map<String, Object>> out = new ArrayList<>();
        jdbc.sql("""
                select v.*, res.name as resource_name, res.site_id, o.name as org_name, q.number as request_number,
                       sr.organization_id as site_org
                from reservation v join resource res on res.id = v.resource_id join organization o on o.id = v.organization_id
                left join request q on q.id = v.request_id
                left join site_responsibility sr on sr.site_id = res.site_id and sr.valid_to is null
                where""" + " " + where + " order by v.period_start limit 1000").params(params)
                .query((rs, n) -> {
                    UUID siteId = Db.uuid(rs, "site_id");
                    ViewLevel level = ctx.siteView(siteId, java.util.Set.of(), Db.uuid(rs, "site_org"));
                    boolean own = ctx.canFor(Permission.CREATE, Db.uuid(rs, "organization_id"));
                    if (level == ViewLevel.NONE && !own) {
                        return null;
                    }
                    boolean full = level == ViewLevel.FULL || own;
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("resource", Map.of("id", rs.getString("resource_id"), "name", rs.getString("resource_name"),
                            "siteId", siteId.toString()));
                    if (full) {
                        m.put("org", Ref.of(Db.uuid(rs, "organization_id"), rs.getString("org_name")));
                    }
                    Map<String, String> period = new LinkedHashMap<>();
                    period.put("start", Db.iso(rs, "period_start"));
                    period.put("end", Db.iso(rs, "period_end"));
                    m.put("period", period);
                    m.put("status", rs.getString("status"));
                    m.put("requestId", full ? rs.getString("request_id") : null);
                    m.put("requestNumber", full ? rs.getString("request_number") : null);
                    m.put("source", rs.getString("source"));
                    out.add(m);
                    return null;
                }).list();
        return out;
    }

    @GetMapping("/resources/{id}/reservations")
    public List<Map<String, Object>> byResource(Actor actor, @PathVariable UUID id, @RequestParam(required = false) String from,
                                                @RequestParam(required = false) String to) {
        return list(actor, from, to, id, null);
    }

    @GetMapping("/execution-tasks")
    public List<Map<String, Object>> executionTasks(Actor actor) {
        return execution.mine(access.context(actor));
    }

    @PostMapping("/execution-tasks/{id}/complete")
    public RequestViews.ExecutionTaskView complete(Actor actor, @PathVariable UUID id, @RequestBody CompleteInput in,
                                                   @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return execution.complete(access.context(actor), id, in, key);
    }
}
