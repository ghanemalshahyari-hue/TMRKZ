package ae.mover.stationing;

import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.AccessContext;
import ae.mover.access.Grant;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Json;
import ae.mover.stationing.RestationingService.Req;

/**
 * The lifecycle around a re-stationing request (ADR-034; owner-approved model D9, D10, D12, D16, A4, A6): cancellation
 * before activation, cancellation of an activated temporary before its start, early return, and extensions. Each is
 * asked by the requester (the same human) or a holder of «طلب إعادة التمركز» for the requesting unit, and decided by
 * another human holding the action's own right over every moving unit; delegations count for the delegator.
 */
@Service
public class RestationingLifecycle {

    /** Before activation a request may still be cancelled (D9); a pending cancellation blocks decisions and activation. */
    static final Set<String> CANCELLABLE = Set.of("UNDER_REVIEW", "RETURNED_FOR_CHANGES", "PAUSED_HIERARCHY_CHANGED", "APPROVED_NOT_ACTIVATED");
    /** An extension still on its way to activation (only one at a time per temporary stationing). */
    static final Set<String> OPEN_EXTENSION = Set.of("DRAFT", "UNDER_REVIEW", "RETURNED_FOR_CHANGES", "PAUSED_HIERARCHY_CHANGED",
            "APPROVED_NOT_ACTIVATED", "CANCELLATION_PENDING");

    public enum Kind { PRE_ACTIVATION_CANCELLATION, BEFORE_START_CANCELLATION, EARLY_RETURN }

    public record AskInput(String reason) {
    }

    public record ExtensionInput(String end, String reason) {
    }

    public record DecideInput(String decision, String reason) {
    }

    record Action(UUID id, UUID request, Kind kind, String state, UUID requestedBy, String resumeState) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final AuditService audit;
    private final StationingOutbox outbox;
    private final RestationingService service;
    private final TransactionTemplate tx;

    public RestationingLifecycle(JdbcClient jdbc, Json json, AuditService audit, StationingOutbox outbox, RestationingService service,
                                 TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.json = json;
        this.audit = audit;
        this.outbox = outbox;
        this.service = service;
        this.tx = tx;
    }

    // ---- asking -----------------------------------------------------------------------------------------------

    /** D9/D16: the request waits as CANCELLATION_PENDING until another human decides. */
    public void askCancellation(AccessContext ctx, UUID id, AskInput in, Instant now) {
        service.runTemporaryLifecycle(now);
        tx.executeWithoutResult(s -> {
            Req r = askable(ctx, id);
            if (!CANCELLABLE.contains(r.state())) {
                throw ApiException.validation("يُطلب الإلغاء قبل التفعيل فقط.");
            }
            UUID action = insert(r, Kind.PRE_ACTIVATION_CANCELLATION, ctx, reason(in), r.state(), now);
            jdbc.sql("update restationing_request set state = 'CANCELLATION_PENDING', updated_at = :now, version = version + 1 where id = :id")
                    .param("now", Db.ts(now)).param("id", id).update();
            audit.recordAs(ctx.actor(), "RESTATIONING_CANCELLATION_REQUESTED", "RESTATIONING_REQUEST", id.toString(), r.number(),
                    Map.of("action", action.toString(), "from", r.state()), reason(in));
        });
    }

    /** A4: an activated temporary may be cancelled before its start; the request stays scheduled until the decision. */
    public void askStartCancellation(AccessContext ctx, UUID id, AskInput in, Instant now) {
        service.runTemporaryLifecycle(now);
        tx.executeWithoutResult(s -> {
            Req r = askable(ctx, id);
            if (!"TEMPORARY_SCHEDULED".equals(r.state())) {
                throw ApiException.validation("يُطلب إلغاء التمركز المؤقت قبل بدء نفاذه فقط، بعد تفعيله.");
            }
            UUID action = insert(r, Kind.BEFORE_START_CANCELLATION, ctx, reason(in), null, now);
            audit.recordAs(ctx.actor(), "RESTATIONING_START_CANCELLATION_REQUESTED", "RESTATIONING_REQUEST", id.toString(), r.number(),
                    Map.of("action", action.toString(), "plannedStart", r.content().start().toString()), reason(in));
        });
    }

    /** D12: early return from a temporary in force (never before its start, A4). */
    public void askEarlyReturn(AccessContext ctx, UUID id, AskInput in, Instant now) {
        service.runTemporaryLifecycle(now);
        tx.executeWithoutResult(s -> {
            Req r = askable(ctx, id);
            if (!"ACTIVE_TEMPORARY".equals(r.state())) {
                throw ApiException.validation("العودة المبكرة من تمركز مؤقت نافذ فقط.");
            }
            UUID action = insert(r, Kind.EARLY_RETURN, ctx, reason(in), null, now);
            audit.recordAs(ctx.actor(), "RESTATIONING_EARLY_RETURN_REQUESTED", "RESTATIONING_REQUEST", id.toString(), r.number(),
                    Map.of("action", action.toString(), "plannedEnd", String.valueOf(service.effectiveEnd(id))), reason(in));
        });
    }

    /**
     * D10: an extension is its own request for the same units, site and deployment areas with a later end, prepared as a
     * draft and submitted, decided and activated through the normal workflow.
     */
    public UUID createExtension(AccessContext ctx, UUID parentId, ExtensionInput in, Instant now) {
        Instant end;
        try {
            end = in == null || in.end() == null ? null : Instant.parse(in.end());
        } catch (RuntimeException e) {
            throw ApiException.validation("نهاية التمديد بتاريخ ووقت صالحين.");
        }
        if (end == null) {
            throw ApiException.validation("حدد نهاية التمديد.");
        }
        Instant newEnd = end;
        service.runTemporaryLifecycle(now);
        return tx.execute(s -> {
            Req parent = askable(ctx, parentId);
            if (!"TEMPORARY".equals(parent.kind()) || !Set.of("TEMPORARY_SCHEDULED", "ACTIVE_TEMPORARY").contains(parent.state())) {
                throw ApiException.validation("يُمدَّد تمركز مؤقت مجدول أو نافذ فقط.");
            }
            if (jdbc.sql("select count(*) from restationing_request where parent_request_id = :p and state = any(string_to_array(:st, ','))")
                    .param("p", parentId).param("st", String.join(",", OPEN_EXTENSION)).query(Integer.class).single() > 0) {
                throw ApiException.validation("يوجد تمديد قائم لهذا التمركز المؤقت لم يُحسم بعد.");
            }
            Instant current = service.effectiveEnd(parentId);
            if (!newEnd.isAfter(current)) {
                throw ApiException.validation("نهاية التمديد يجب أن تكون بعد النهاية الفعالة الحالية.");
            }
            RestationingContent c = parent.content();
            RestationingContent ext = new RestationingContent(c.kind(), current, newEnd, c.scope(), c.occupants(), c.site(), c.primary(),
                    c.alternative(), c.exceptions(), reason(in == null ? null : new AskInput(in.reason())));
            long seq = jdbc.sql("select nextval('restationing_request_no')").query(Long.class).single();
            String number = "RS-" + now.atZone(ZoneOffset.UTC).getYear() + "-" + String.format("%04d", seq);
            UUID id = UUID.randomUUID();
            jdbc.sql("""
                    insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind, parent_request_id, start_at, end_at,
                                                     reason, content, created_at, updated_at)
                    values (:id, :n, :by, :unit, 'DRAFT', 'EXTENSION', :parent, :start, :end, :reason, cast(:c as jsonb), :now, :now)""")
                    .param("id", id).param("n", number).param("by", ctx.personId()).param("unit", parent.unit()).param("parent", parentId)
                    .param("start", Db.ts(current)).param("end", Db.ts(newEnd)).param("reason", ext.reason()).param("c", json.write(ext.stored()))
                    .param("now", Db.ts(now)).update();
            audit.recordAs(ctx.actor(), "RESTATIONING_EXTENSION_CREATED", "RESTATIONING_REQUEST", id.toString(), number,
                    Map.of("parent", parent.number(), "currentEnd", current.toString(), "newEnd", newEnd.toString()), ext.reason());
            return id;
        });
    }

    // ---- deciding ---------------------------------------------------------------------------------------------

    public void decide(AccessContext ctx, UUID id, UUID actionId, DecideInput in, Instant now) {
        boolean approve = in != null && "APPROVE".equals(in.decision());
        if (in == null || !approve && !"REJECT".equals(in.decision())) {
            throw ApiException.validation("القرار اعتماد أو رفض.");
        }
        String why = in.reason() == null ? null : in.reason().trim();
        if (!approve && (why == null || why.length() < 5)) {
            throw ApiException.validation("اذكر سبب الرفض (5 أحرف على الأقل).");
        }
        service.runTemporaryLifecycle(now);
        tx.executeWithoutResult(s -> {
            Req r = service.lock(id);
            service.requireVisible(ctx, r);
            Action a = action(actionId).filter(x -> x.request().equals(id)).orElseThrow(ApiException::notFound);
            if (!"REQUESTED".equals(a.state())) {
                throw ApiException.validation("NO_LONGER_ACTIONABLE".equals(a.state()) ? "انقضت نافذة النفاذ دون بدء؛ لم يعد القرار ممكناً."
                        : "SUPERSEDED".equals(a.state()) ? "انتهى التمركز المؤقت قبل القرار؛ لم يعد القرار ممكناً." : "حُسم هذا الإجراء من قبل.");
            }
            Grant g = requireDecider(ctx, r, a);
            switch (a.kind()) {
                case PRE_ACTIVATION_CANCELLATION -> {
                    if (!"CANCELLATION_PENDING".equals(r.state())) {
                        throw ApiException.validation("لم يعد الطلب بانتظار قرار الإلغاء.");
                    }
                    String next = approve ? "CANCELLED_BEFORE_ACTIVATION" : a.resumeState();
                    jdbc.sql("update restationing_request set state = :st, updated_at = :now, version = version + 1 where id = :id")
                            .param("st", next).param("now", Db.ts(now)).param("id", id).update();
                }
                case BEFORE_START_CANCELLATION -> {
                    if (!Set.of("TEMPORARY_SCHEDULED", "START_HELD_PENDING_CANCELLATION").contains(r.state())) {
                        throw ApiException.validation("بدأ التمركز المؤقت أو انتهى؛ لم يعد الإلغاء قبل البدء ممكناً.");
                    }
                    if (approve) {
                        cancelBeforeStart(r, ctx, now);
                    } else if ("START_HELD_PENDING_CANCELLATION".equals(r.state())) {
                        startAfterRefusal(r, why, now);
                    }
                }
                case EARLY_RETURN -> {
                    if (!"ACTIVE_TEMPORARY".equals(r.state())) {
                        throw ApiException.validation("لم يعد التمركز المؤقت نافذاً.");
                    }
                    if (approve) {
                        endEarly(r, ctx, why, now);
                    }
                }
            }
            jdbc.sql("""
                    update restationing_action set state = :st, decided_by = :by, decided_at = :now, decision_reason = :why, via_delegation = :del
                     where id = :a""")
                    .param("st", approve ? "APPROVED" : "REJECTED").param("by", ctx.personId()).param("now", Db.ts(now))
                    .param("why", why == null || why.isEmpty() ? null : why).param("del", g.delegationId()).param("a", actionId).update();
            audit.record(ctx.actor(), new AuditService.Capacity(g.roleName(), g.orgName(), g.delegationId()),
                    "RESTATIONING_" + a.kind().name() + (approve ? "_APPROVED" : "_REJECTED"), "RESTATIONING_REQUEST", id.toString(),
                    r.number(), Map.of("action", actionId.toString(), "state", r.state()), why, null);
        });
    }

    /** A4: the temporary never started; its records keep their dates with an empty window, the permanent one rules. */
    private void cancelBeforeStart(Req r, AccessContext ctx, Instant now) {
        List<Map<String, Object>> closed = jdbc.sql("""
                update org_stationing set valid_to = valid_from, end_reason = 'CANCELLED', ended_by = :by, ended_at = :now
                 where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and (valid_to is null or valid_to > valid_from)
                returning organization_id, site_id, valid_from""")
                .param("by", ctx.personId()).param("now", Db.ts(now)).param("chain", Db.ids(service.chain(r.id()))).query().listOfRows();
        for (Map<String, Object> c : closed) {
            outbox.enqueue(StationingEvent.Type.TEMPORARY_STATIONING_CANCELLED, (UUID) c.get("organization_id"), (UUID) c.get("site_id"),
                    Db.toInstant(c.get("valid_from")), now, "CANCELLED_BEFORE_START", "restationing:" + r.number());
        }
        jdbc.sql("update deployment_area set state = 'RETIRED', valid_to = valid_from where request_id = :id and state = 'ACTIVE'")
                .param("id", r.id()).update();
        jdbc.sql("update restationing_request set state = 'TEMPORARY_CANCELLED_BEFORE_START', updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", r.id()).update();
        service.lapseExtensions(r.id(), "أُلغي التمركز المؤقت قبل بدء نفاذه", now);
    }

    /**
     * A6: the cancellation of a held start was refused after the approved start: the temporary takes effect from the
     * decision, never backdated; the approved end does not move. A part of the window that already passed never took effect.
     */
    private void startAfterRefusal(Req r, String why, Instant now) {
        String chain = Db.ids(service.chain(r.id()));
        jdbc.sql("""
                update org_stationing set valid_to = valid_from, end_reason = 'WINDOW_EXPIRED', ended_at = :now, start_held_at = null
                 where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and start_held_at is not null
                   and coalesce(valid_to, planned_end) <= :now""").param("now", Db.ts(now)).param("chain", chain).update();
        List<Map<String, Object>> started = jdbc.sql("""
                update org_stationing set valid_from = :now, start_held_at = null
                 where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and start_held_at is not null and valid_from < :now
                returning organization_id, site_id""").param("now", Db.ts(now)).param("chain", chain).query().listOfRows();
        jdbc.sql("""
                update org_stationing set start_held_at = null
                 where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and start_held_at is not null""")
                .param("chain", chain).update();
        for (Map<String, Object> c : started) {
            outbox.enqueue(StationingEvent.Type.TEMPORARY_STATIONING_STARTED, (UUID) c.get("organization_id"), (UUID) c.get("site_id"),
                    now, now, "start-after-refused-cancellation", "restationing:" + r.number());
        }
        jdbc.sql("update restationing_request set state = 'ACTIVE_TEMPORARY', updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", r.id()).update();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("plannedStart", r.content().start().toString());
        detail.put("actualEffectiveStart", now.toString());
        detail.put("decidedAt", now.toString());
        detail.put("decisionReason", why);
        detail.put("effectiveEnd", String.valueOf(service.effectiveEnd(r.id())));
        audit.system("STATIONING_TEMPORARY_STARTED", "RESTATIONING_REQUEST", r.id().toString(), r.number(), detail);
    }

    /** D12: in one transaction the temporary ends now; actor, time, reason, planned and actual end are recorded. */
    private void endEarly(Req r, AccessContext ctx, String why, Instant now) {
        Instant planned = service.effectiveEnd(r.id());
        List<Map<String, Object>> ended = jdbc.sql("""
                update org_stationing set valid_to = greatest(valid_from, :now), end_reason = 'ENDED_EARLY', ended_by = :by, ended_at = :now
                 where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and (valid_to is null or valid_to > :now)
                returning organization_id, site_id, valid_from, valid_to""")
                .param("now", Db.ts(now)).param("by", ctx.personId()).param("chain", Db.ids(service.chain(r.id()))).query().listOfRows();
        for (Map<String, Object> e : ended) {
            if (!Db.toInstant(e.get("valid_from")).isAfter(now)) {
                outbox.enqueue(StationingEvent.Type.TEMPORARY_STATIONING_ENDED, (UUID) e.get("organization_id"), (UUID) e.get("site_id"),
                        now, now, "EARLY_RETURN", "restationing:" + r.number());
            }
        }
        service.retireAreas(r.id(), now);
        jdbc.sql("update restationing_request set state = 'TEMPORARY_RETURNED', updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", r.id()).update();
        service.lapseExtensions(r.id(), "عادت الوحدات مبكراً قبل تفعيل التمديد", now);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("plannedEnd", String.valueOf(planned));
        detail.put("actualEnd", now.toString());
        detail.put("reason", why);
        audit.recordAs(ctx.actor(), "RESTATIONING_RETURNED_EARLY", "RESTATIONING_REQUEST", r.id().toString(), r.number(), detail, why);
    }

    // ---- the view ---------------------------------------------------------------------------------------------

    /** Adds the lifecycle to a request view: kind, parent, effective end, extensions, actions and what the viewer may do. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> decorate(AccessContext ctx, Map<String, Object> view, Instant now) {
        UUID id = UUID.fromString((String) view.get("id"));
        Req r = service.load(id).orElseThrow(ApiException::notFound);
        view.put("requestKind", r.kind());
        if (r.extension()) {
            view.put("parent", service.load(r.parentId()).map(p -> Map.of("id", p.id().toString(), "number", p.number())).orElse(null));
        }
        if ("TEMPORARY".equals(r.kind())) {
            view.put("effectiveEnd", String.valueOf(service.effectiveEnd(id)));
            view.put("extensions", jdbc.sql("""
                    select id, number, state, end_at, lapse_reason from restationing_request where parent_request_id = :id order by created_at""")
                    .param("id", id).query((rs, n) -> {
                        Map<String, Object> e = new LinkedHashMap<>();
                        e.put("id", rs.getString("id"));
                        e.put("number", rs.getString("number"));
                        e.put("state", rs.getString("state"));
                        e.put("end", Db.iso(rs, "end_at"));
                        e.put("lapseReason", rs.getString("lapse_reason"));
                        return e;
                    }).list());
        }
        List<Map<String, Object>> actions = jdbc.sql("""
                select a.id, a.kind, a.state, a.reason, a.requested_at, rp.display_name as requested_by, a.decided_at, dp.display_name as decided_by,
                       a.decision_reason, a.held_at, a.closed_at, a.close_reason
                  from restationing_action a join person rp on rp.id = a.requested_by left join person dp on dp.id = a.decided_by
                 where a.request_id = :id order by a.requested_at""").param("id", id).query((rs, n) -> {
                    Map<String, Object> a = new LinkedHashMap<>();
                    a.put("id", rs.getString("id"));
                    a.put("kind", rs.getString("kind"));
                    a.put("state", rs.getString("state"));
                    a.put("reason", rs.getString("reason"));
                    a.put("requestedAt", Db.iso(rs, "requested_at"));
                    a.put("requestedBy", rs.getString("requested_by"));
                    a.put("decidedAt", Db.iso(rs, "decided_at"));
                    a.put("decidedBy", rs.getString("decided_by"));
                    a.put("decisionReason", rs.getString("decision_reason"));
                    a.put("heldAt", Db.iso(rs, "held_at"));
                    a.put("closedAt", Db.iso(rs, "closed_at"));
                    a.put("closeReason", rs.getString("close_reason"));
                    return a;
                }).list();
        view.put("actions", actions);
        Map<String, Object> can = (Map<String, Object>) view.computeIfAbsent("can", k -> new LinkedHashMap<>());
        boolean asker = mayAsk(ctx, r);
        boolean open = actions.stream().anyMatch(a -> "REQUESTED".equals(a.get("state")));
        can.put("askCancellation", asker && !open && CANCELLABLE.contains(r.state()));
        can.put("askStartCancellation", asker && !open && "TEMPORARY_SCHEDULED".equals(r.state()));
        can.put("askEarlyReturn", asker && !open && "ACTIVE_TEMPORARY".equals(r.state()));
        can.put("askExtension", asker && "TEMPORARY".equals(r.kind()) && Set.of("TEMPORARY_SCHEDULED", "ACTIVE_TEMPORARY").contains(r.state())
                && ((List<Map<String, Object>>) view.getOrDefault("extensions", List.of())).stream().noneMatch(e -> OPEN_EXTENSION.contains(e.get("state"))));
        String decidable = null;
        for (Map<String, Object> a : actions) {
            if ("REQUESTED".equals(a.get("state")) && action(UUID.fromString((String) a.get("id"))).map(x -> mayDecide(ctx, r, x)).orElse(false)) {
                decidable = (String) a.get("id");
            }
        }
        can.put("decideAction", decidable);
        return view;
    }

    // ---- rules ------------------------------------------------------------------------------------------------

    private boolean mayAsk(AccessContext ctx, Req r) {
        return RestationingService.intersects(service.humans(ctx.personId()), service.humans(r.requester()))
                || ctx.canFor(Permission.CREATE_RESTATIONING, r.unit());
    }

    private Req askable(AccessContext ctx, UUID id) {
        // called inside the asking transaction, after the due transitions ran in their own (see ask*)
        Req r = service.lock(id);
        service.requireVisible(ctx, r);
        if (!mayAsk(ctx, r)) {
            throw ApiException.forbidden("يطلبه مقدم الطلب أو صاحب «طلب إعادة التمركز» للوحدة الطالبة.");
        }
        if (jdbc.sql("select count(*) from restationing_action where request_id = :id and state = 'REQUESTED'").param("id", id)
                .query(Integer.class).single() > 0) {
            throw ApiException.validation("يوجد إجراء قائم على هذا الطلب بانتظار قراره.");
        }
        return r;
    }

    static Permission permission(Kind k) {
        return switch (k) {
            case PRE_ACTIVATION_CANCELLATION -> Permission.DECIDE_PRE_ACTIVATION_CANCELLATION;
            case BEFORE_START_CANCELLATION -> Permission.DECIDE_BEFORE_START_CANCELLATION;
            case EARLY_RETURN -> Permission.DECIDE_EARLY_RETURN;
        };
    }

    private static String label(Kind k) {
        return switch (k) {
            case PRE_ACTIVATION_CANCELLATION -> "قرار الإلغاء قبل التفعيل";
            case BEFORE_START_CANCELLATION -> "قرار إلغاء المؤقت قبل بدء نفاذه";
            case EARLY_RETURN -> "قرار العودة المبكرة";
        };
    }

    /** Another human than the one who asked, holding the action's right over every moving unit (not delegated by the asker). */
    private Grant requireDecider(AccessContext ctx, Req r, Action a) {
        Set<UUID> asker = service.humans(a.requestedBy());
        if (RestationingService.intersects(service.humans(ctx.personId()), asker)) {
            throw new ApiException(ErrorCode.SEPARATION_OF_DUTIES, "من طلب الإجراء لا يقرره.", Map.of());
        }
        Permission p = permission(a.kind());
        Map<UUID, UUID> delegators = service.delegators(ctx);
        Grant used = null;
        for (UUID unit : r.content().scope()) {
            Optional<Grant> g = ctx.grants().stream().filter(x -> x.has(p) && x.actsFor(unit)
                    && (x.delegationId() == null || !asker.contains(delegators.get(x.delegationId())))).findFirst();
            if (g.isEmpty() || !ctx.canFor(p, unit)) {
                throw ApiException.forbidden("يحتاج صلاحية «" + label(a.kind()) + "» على كل الوحدات المنتقلة.");
            }
            used = used == null ? g.get() : used;
        }
        if (used == null) {
            throw ApiException.forbidden("يحتاج صلاحية «" + label(a.kind()) + "».");
        }
        return used;
    }

    private boolean mayDecide(AccessContext ctx, Req r, Action a) {
        try {
            requireDecider(ctx, r, a);
            return true;
        } catch (ApiException e) {
            return false;
        }
    }

    private UUID insert(Req r, Kind kind, AccessContext ctx, String reason, String resume, Instant now) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into restationing_action(id, request_id, kind, state, requested_by, requested_at, reason, resume_state)
                values (:id, :req, :kind, 'REQUESTED', :by, :now, :reason, :resume)""")
                .param("id", id).param("req", r.id()).param("kind", kind.name()).param("by", ctx.personId()).param("now", Db.ts(now))
                .param("reason", reason).param("resume", resume).update();
        return id;
    }

    private Optional<Action> action(UUID id) {
        return jdbc.sql("select id, request_id, kind, state, requested_by, resume_state from restationing_action where id = :id")
                .param("id", id).query((rs, n) -> new Action(Db.uuid(rs, "id"), Db.uuid(rs, "request_id"), Kind.valueOf(rs.getString("kind")),
                        rs.getString("state"), Db.uuid(rs, "requested_by"), rs.getString("resume_state"))).optional();
    }

    private static String reason(AskInput in) {
        String s = in == null || in.reason() == null ? "" : in.reason().trim();
        if (s.length() < 5) {
            throw ApiException.validation("اذكر السبب (5 أحرف على الأقل).");
        }
        return s;
    }
}
