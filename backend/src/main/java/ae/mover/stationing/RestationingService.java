package ae.mover.stationing;

import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.AccessContext;
import ae.mover.access.Grant;
import ae.mover.access.Permission;
import ae.mover.access.PersonKeys;
import ae.mover.access.SeparationOfDuties;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Json;
import ae.mover.stationing.RestationingChecks.Result;
import ae.mover.stationing.RouteDerivation.RouteStage;
import ae.mover.stationing.StationingPolicyStore.PolicyVersion;

/**
 * The re-stationing request lifecycle of Model V3 (docs/STATIONING_MODEL_V3_AR.md §1, §3, §7; ADR-033), on the server:
 *
 * <ul>
 *   <li>a draft belongs to its requester and its requesting unit; submission pins the policy version in force, takes
 *       the requesting unit's hierarchy snapshot and derives the route from that unit upward (O-07, O-09, O-03b);</li>
 *   <li>a stage is decided through APPROVE held in the stage unit's own approver seat (the distance exception through
 *       its permission), confirmed by OpenFGA, never by the requester or on the requester's delegation, and one human
 *       decides at most one stage of a request;</li>
 *   <li>a return for changes keeps the request; resubmission takes again only the decisions resting on a changed fact
 *       (V2 D18); a hierarchy change pauses the request, and confirmation rebuilds the route from the same unit with
 *       every stage decided again, the earlier route kept with its decisions (O-10, O-10b);</li>
 *   <li>activation is a separate act by a human who is neither the requester nor the final approver (D1), refused on
 *       a drifted hierarchy (O-16) and on geography occupied since approval; it registers the site, writes the
 *       stationing and the deployment areas and the outbound events in one transaction and never touches site links
 *       (O-14);</li>
 *   <li>a temporary stationing overlays the preserved permanent base (V2 D7), starts at its approved start and returns
 *       automatically at its end.</li>
 * </ul>
 */
@Service
public class RestationingService {

    public static final Set<String> EDITABLE = Set.of("DRAFT", "RETURNED_FOR_CHANGES", "PAUSED_HIERARCHY_CHANGED");
    /** The lifecycle rights (ADR-034): their holders over a moving unit see the request they act on. */
    static final Set<Permission> LIFECYCLE_ACTORS = Set.of(Permission.DECIDE_PRE_ACTIVATION_CANCELLATION, Permission.ACTIVATE_TEMPORARY_EXTENSION,
            Permission.DECIDE_EARLY_RETURN, Permission.DECIDE_BEFORE_START_CANCELLATION);

    public record SiteInput(Map<String, Object> geometry, UUID copiedFrom, String shape) {
    }

    public record ContentInput(String kind, String start, String end, List<UUID> scope, Map<UUID, String> occupants,
                               SiteInput site, Map<String, Object> primary, Map<String, Object> alternative,
                               Map<String, String> exceptions, String reason) {
        RestationingContent toContent() {
            Map<UUID, RestationingContent.OccupantDecision> occ = new LinkedHashMap<>();
            if (occupants != null) {
                occupants.forEach((k, v) -> {
                    if (v != null && !v.isBlank()) {
                        try {
                            occ.put(k, RestationingContent.OccupantDecision.valueOf(v));
                        } catch (IllegalArgumentException e) {
                            throw ApiException.validation("قرار غير معروف لوحدة من فرع آخر: " + v);
                        }
                    }
                });
            }
            return new RestationingContent(kind, time(start), time(end), scope, occ,
                    site == null || site.geometry() == null ? null
                            : new RestationingContent.ProposedSite(site.geometry(), site.copiedFrom(), site.shape()),
                    primary, alternative, exceptions, reason);
        }

        private static Instant time(String s) {
            if (s == null || s.isBlank()) {
                return null;
            }
            try {
                return Instant.parse(s);
            } catch (RuntimeException e) {
                throw ApiException.validation("تاريخ غير مقروء: " + s);
            }
        }
    }

    public record CreateInput(UUID requestingUnitId, ContentInput content) {
    }

    public record ReasonInput(String reason) {
    }

    public record DecisionInput(String decision, String reason) {
    }

    /** A request as stored. */
    record Req(UUID id, String number, UUID requester, UUID unit, String state, RestationingContent content, Integer policyVersion,
               int routeNo, List<UUID> routePath, HierarchySnapshot snapshot, Map<String, Object> returned, Map<String, Object> paused,
               UUID finalApprover, UUID activatedBy, Instant activatedAt, UUID siteId, Instant createdAt, Instant updatedAt,
               String kind, UUID parentId) {
        boolean extension() {
            return "EXTENSION".equals(kind);
        }
    }

    /** A stage as stored. */
    record StageRow(UUID id, int routeNo, int position, String key, String kind, UUID unit, String permission, String label,
                    List<Map<String, Object>> satisfies, Set<Fact> dependsOn, boolean finalStage, String independentOf, String mark,
                    UUID decidedBy, UUID viaDelegation, Instant decidedAt) {
        boolean marked() {
            return mark != null;
        }
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final AuditService audit;
    private final StationingPolicyStore policies;
    private final RestationingChecks checks;
    private final OrgHierarchy hierarchy;
    private final StationingOutbox outbox;
    private final PersonKeys keys;
    private final TransactionTemplate tx;

    public RestationingService(JdbcClient jdbc, Json json, AuditService audit, StationingPolicyStore policies, RestationingChecks checks,
                               OrgHierarchy hierarchy, StationingOutbox outbox, PersonKeys keys, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.json = json;
        this.audit = audit;
        this.policies = policies;
        this.checks = checks;
        this.hierarchy = hierarchy;
        this.outbox = outbox;
        this.keys = keys;
        this.tx = tx;
    }

    // ---- draft ----------------------------------------------------------------------------------------------

    public UUID create(AccessContext ctx, CreateInput in, Instant now) {
        if (in == null || in.requestingUnitId() == null || in.content() == null) {
            throw ApiException.validation("حدد الوحدة الطالبة ومحتوى الطلب.");
        }
        if (!ctx.canFor(Permission.CREATE_RESTATIONING, in.requestingUnitId())) {
            throw ApiException.forbidden("إنشاء طلب إعادة تمركز يحتاج صلاحية «طلب إعادة التمركز» للوحدة الطالبة.");
        }
        RestationingContent c = in.content().toContent();
        return tx.execute(s -> {
            long seq = jdbc.sql("select nextval('restationing_request_no')").query(Long.class).single();
            String number = "RS-" + now.atZone(ZoneOffset.UTC).getYear() + "-" + String.format("%04d", seq);
            UUID id = UUID.randomUUID();
            jdbc.sql("""
                    insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind, start_at, end_at, reason,
                                                     content, created_at, updated_at)
                    values (:id, :n, :by, :unit, 'DRAFT', :kind, :start, :end, :reason, cast(:c as jsonb), :now, :now)""")
                    .param("id", id).param("n", number).param("by", ctx.personId()).param("unit", in.requestingUnitId())
                    .param("kind", c.kind()).param("start", Db.ts(c.start() == null ? now : c.start()))
                    .param("end", c.end() == null ? null : Db.ts(c.end())).param("reason", c.reason())
                    .param("c", json.write(c.stored())).param("now", Db.ts(now)).update();
            audit.recordAs(ctx.actor(), "RESTATIONING_CREATED", "RESTATIONING_REQUEST", id.toString(), number, c.summary(), null);
            return id;
        });
    }

    public void edit(AccessContext ctx, UUID id, ContentInput in, Instant now) {
        if (in == null) {
            throw ApiException.validation("محتوى الطلب مطلوب.");
        }
        RestationingContent c = in.toContent();
        tx.executeWithoutResult(s -> {
            Req r = lock(id);
            requireOwnerEditable(ctx, r);
            if (r.extension()) {
                editExtension(ctx, r, c, now);
                return;
            }
            jdbc.sql("""
                    update restationing_request set content = cast(:c as jsonb), kind = :kind, start_at = :start, end_at = :end,
                           reason = :reason, updated_at = :now, version = version + 1 where id = :id""")
                    .param("c", json.write(c.stored())).param("kind", c.kind()).param("start", Db.ts(c.start() == null ? now : c.start()))
                    .param("end", c.end() == null ? null : Db.ts(c.end())).param("reason", c.reason()).param("now", Db.ts(now))
                    .param("id", id).update();
            Map<String, Object> edited = new LinkedHashMap<>(c.summary());
            edited.put("site", siteFacts(c));
            audit.recordAs(ctx.actor(), "RESTATIONING_EDITED", "RESTATIONING_REQUEST", id.toString(), r.number(), edited, null);
        });
    }

    /** The checks of the current content against the pinned policy version, or the one in force for a draft. */
    public Map<String, Object> checks(AccessContext ctx, UUID id, Instant now) {
        Req r = load(id).orElseThrow(ApiException::notFound);
        requireVisible(ctx, r);
        Optional<PolicyVersion> pv = r.policyVersion() == null ? policies.inForce(now) : policies.byVersion(r.policyVersion());
        if (pv.isEmpty()) {
            Map<String, Object> none = new LinkedHashMap<>();
            none.put("ok", false);
            none.put("problems", List.of("لا توجد سياسة تمركز نافذة؛ ينشرها مسؤول النظام قبل إرسال أي طلب."));
            none.put("policyVersion", null);
            return none;
        }
        Result res = r.extension() ? extensionChecks(r, pv.get().values(), now)
                : checks.evaluate(r.unit(), r.content(), pv.get().values(), pv.get().version(), now);
        return checkView(res, pv.get().version());
    }

    // ---- submission -----------------------------------------------------------------------------------------

    public void submit(AccessContext ctx, UUID id, ReasonInput in, Instant now) {
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        tx.executeWithoutResult(s -> {
            Req r = lock(id);
            requireOwnerEditable(ctx, r);
            boolean first = "DRAFT".equals(r.state());
            boolean wasPaused = "PAUSED_HIERARCHY_CHANGED".equals(r.state());
            PolicyVersion pv = first
                    ? policies.inForce(now).orElseThrow(() -> ApiException.validation("لا توجد سياسة تمركز نافذة؛ ينشرها مسؤول النظام قبل إرسال أي طلب."))
                    : policies.byVersion(r.policyVersion()).orElseThrow();
            Result res = r.extension() ? extensionChecks(r, pv.values(), now) : checks.evaluate(r.unit(), r.content(), pv.values(), pv.version(), now);
            if (!res.ok()) {
                throw ApiException.validation(res.problems().get(0), Map.of("problems", res.problems()));
            }
            if (!first && reason.length() < 5) {
                throw ApiException.validation(wasPaused ? "أكّد الطلب بسبب مكتوب لإعادة بناء المسار (5 أحرف على الأقل)."
                        : "اذكر ما عدّلته عند إعادة الإرسال (5 أحرف على الأقل).");
            }
            List<RouteStage> fresh = res.route();
            Map<String, Object> prev = lastRevision(id);
            Set<Fact> changed = prev == null ? EnumSet.allOf(Fact.class)
                    : RestationingContent.changed(RestationingContent.fromStored(json.map(prev.get("content").toString())), r.content());
            List<StageRow> old = stages(id, r.routeNo());
            int routeNo;
            List<StageRow> next = new ArrayList<>();
            List<Map<String, Object>> invalidated = new ArrayList<>();
            List<String> carried = new ArrayList<>();
            if (first || wasPaused) {
                routeNo = r.routeNo() + 1;
                // O-10b: after a hierarchy change every stage is decided again; the earlier route stays as route_no - 1
                old.stream().filter(StageRow::marked).forEach(o -> invalidated.add(decisionOf(o)));
                for (int i = 0; i < fresh.size(); i++) {
                    next.add(row(fresh.get(i), routeNo, i, null, null, null, null));
                }
            } else {
                routeNo = r.routeNo();
                reconcile(old, fresh, changed, routeNo, next, invalidated, carried);
                jdbc.sql("delete from restationing_stage where request_id = :id and route_no = :r").param("id", id).param("r", routeNo).update();
            }
            for (StageRow st : next) {
                insertStage(id, st);
            }
            HierarchySnapshot snap = HierarchySnapshot.take(hierarchy, r.unit(), now);
            jdbc.sql("""
                    update restationing_request set state = 'UNDER_REVIEW', policy_version = :pv, route_no = :route,
                           route_path = string_to_array(:path, ',')::uuid[], hierarchy_snapshot = cast(:snap as jsonb), returned = null,
                           paused = null, updated_at = :now, version = version + 1 where id = :id""")
                    .param("pv", pv.version()).param("route", routeNo).param("path", Db.ids(snap.path()))
                    .param("snap", json.write(snapshot(snap))).param("now", Db.ts(now)).param("id", id).update();
            int n = prev == null ? 1 : ((Number) prev.get("n")).intValue() + 1;
            Map<String, Object> view = checkView(res, pv.version());
            jdbc.sql("""
                    insert into restationing_revision(request_id, n, submitted_by, submitted_at, content, changed, reason, invalidated,
                                                      carried, route_no, policy_version, checks)
                    values (:id, :n, :by, :now, cast(:c as jsonb), string_to_array(:changed, ',')::text[], :reason, cast(:inv as jsonb),
                            string_to_array(:carried, ',')::text[], :route, :pv, cast(:checks as jsonb))""")
                    .param("id", id).param("n", n).param("by", ctx.personId()).param("now", Db.ts(now))
                    .param("c", json.write(r.content().stored())).param("changed", String.join(",", RestationingContent.names(changed)))
                    .param("reason", first ? null : reason).param("inv", json.write(invalidated)).param("carried", String.join(",", carried))
                    .param("route", routeNo).param("pv", pv.version()).param("checks", json.write(view)).update();
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("policyVersion", pv.version());
            detail.put("revision", n);
            detail.put("route", routeNo);
            detail.put("stages", next.size());
            detail.put("changed", RestationingContent.names(changed));
            detail.put("invalidated", invalidated.size());
            detail.put("carried", carried.size());
            detail.put("terrain", view.get("terrain"));
            detail.put("site", siteFacts(r.content()));
            if (res.needsDistanceException()) {
                // O-17: the written reason of every distance exception, with the submission it belongs to
                detail.put("distanceExceptions", r.content().exceptions());
            }
            audit.recordAs(ctx.actor(), first ? "RESTATIONING_SUBMITTED" : wasPaused ? "RESTATIONING_RECONFIRMED" : "RESTATIONING_RESUBMITTED",
                    "RESTATIONING_REQUEST", id.toString(), r.number(), detail, first ? null : reason);
            settle(ctx, id, r.number(), routeNo, now);
        });
    }

    /** V2 D18: decisions resting on a changed fact are taken again; later decided stages wait as CARRIED. */
    private static void reconcile(List<StageRow> old, List<RouteStage> fresh, Set<Fact> changed, int routeNo, List<StageRow> next,
                                  List<Map<String, Object>> invalidated, List<String> carried) {
        Map<String, StageRow> prev = new LinkedHashMap<>();
        old.forEach(o -> prev.put(o.key(), o));
        int reopen = -1;
        for (int i = 0; i < fresh.size(); i++) {
            StageRow p = prev.get(fresh.get(i).key());
            if (hits(fresh.get(i), changed) || p == null || !p.marked()) {
                reopen = i;
                break;
            }
        }
        for (int i = 0; i < fresh.size(); i++) {
            RouteStage s = fresh.get(i);
            StageRow p = prev.get(s.key());
            if (p == null || !p.marked()) {
                next.add(row(s, routeNo, i, null, null, null, null));
            } else if (hits(s, changed)) {
                invalidated.add(decisionOf(p));
                next.add(row(s, routeNo, i, null, null, null, null));
            } else if (reopen >= 0 && i > reopen) {
                carried.add(s.key());
                next.add(row(s, routeNo, i, "CARRIED", p.decidedBy(), p.viaDelegation(), p.decidedAt()));
            } else {
                next.add(row(s, routeNo, i, p.mark(), p.decidedBy(), p.viaDelegation(), p.decidedAt()));
            }
        }
    }

    private static boolean hits(RouteStage s, Set<Fact> changed) {
        return s.dependsOn().stream().anyMatch(changed::contains);
    }

    // ---- decisions ------------------------------------------------------------------------------------------

    public void decide(AccessContext ctx, UUID id, DecisionInput in, Instant now) {
        String decision = in == null || in.decision() == null ? "" : in.decision();
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (!Set.of("APPROVE", "RETURN", "REJECT").contains(decision)) {
            throw ApiException.validation("القرار اعتماد أو إرجاع أو رفض.");
        }
        if (!"APPROVE".equals(decision) && reason.length() < 5) {
            throw ApiException.validation("اكتب سبب القرار (5 أحرف على الأقل).");
        }
        // O-10: a drifted hierarchy pauses the request before anyone decides on it (committed on its own)
        if (pauseIfDrifted(id, now)) {
            throw ApiException.validation("الطلب موقوف: " + HierarchyDrift.MESSAGE);
        }
        tx.executeWithoutResult(s -> {
            Req r = lock(id);
            requireVisible(ctx, r);
            if (!"UNDER_REVIEW".equals(r.state())) {
                throw ApiException.validation("PAUSED_HIERARCHY_CHANGED".equals(r.state()) ? "الطلب موقوف: " + HierarchyDrift.MESSAGE
                        : "الطلب ليس قيد المراجعة.");
            }
            List<StageRow> route = stages(id, r.routeNo());
            StageRow stage = route.stream().filter(x -> !x.marked()).findFirst().orElseThrow();
            Grant g = requireDecider(ctx, r, stage, route);
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("stage", stage.key());
            detail.put("stageLabel", stage.label());
            detail.put("route", r.routeNo());
            switch (decision) {
                case "APPROVE" -> {
                    jdbc.sql("""
                            update restationing_stage set mark = 'APPROVED', decided_by = :by, via_delegation = :via, decided_at = :now
                             where id = :sid and mark is null""")
                            .param("by", ctx.personId()).param("via", g.delegationId()).param("now", Db.ts(now)).param("sid", stage.id()).update();
                    detail.put("satisfies", stage.satisfies().stream().map(m -> m.get("label")).toList());
                    detail.put("viaDelegation", g.delegationId() == null ? null : g.delegationId().toString());
                    audit.record(ctx.actor(), new AuditService.Capacity(g.roleName(), g.orgName(), g.delegationId()),
                            "RESTATIONING_STAGE_APPROVED", "RESTATIONING_REQUEST", id.toString(), r.number(), detail, null, null);
                    touch(id, now);
                    settle(ctx, id, r.number(), r.routeNo(), now);
                }
                case "RETURN" -> {
                    Map<String, Object> ret = new LinkedHashMap<>();
                    ret.put("by", ctx.personId().toString());
                    ret.put("byName", ctx.actor().displayName());
                    ret.put("stage", stage.key());
                    ret.put("stageLabel", stage.label());
                    ret.put("reason", reason);
                    ret.put("at", now.toString());
                    jdbc.sql("""
                            update restationing_request set state = 'RETURNED_FOR_CHANGES', returned = cast(:ret as jsonb), updated_at = :now,
                                   version = version + 1 where id = :id""")
                            .param("ret", json.write(ret)).param("now", Db.ts(now)).param("id", id).update();
                    audit.record(ctx.actor(), new AuditService.Capacity(g.roleName(), g.orgName(), g.delegationId()),
                            "RESTATIONING_RETURNED", "RESTATIONING_REQUEST", id.toString(), r.number(), detail, reason, null);
                }
                default -> {
                    jdbc.sql("update restationing_request set state = 'REJECTED', updated_at = :now, version = version + 1 where id = :id")
                            .param("now", Db.ts(now)).param("id", id).update();
                    audit.record(ctx.actor(), new AuditService.Capacity(g.roleName(), g.orgName(), g.delegationId()),
                            "RESTATIONING_REJECTED", "RESTATIONING_REQUEST", id.toString(), r.number(), detail, reason, null);
                }
            }
        });
    }

    /**
     * The grant through which the actor decides this stage, or a refusal. Separation of duties by the human
     * (PersonKeys): never the requester or someone acting on the requester's delegation, and never a human who decided
     * another stage of the current route — which also gives the independence O-03b requires.
     */
    private Grant requireDecider(AccessContext ctx, Req r, StageRow stage, List<StageRow> route) {
        Set<UUID> actor = humans(ctx.personId());
        Set<UUID> requester = humans(r.requester());
        if (intersects(actor, requester)) {
            throw new ApiException(ErrorCode.SEPARATION_OF_DUTIES, "مقدم الطلب لا يقرر مراحل طلبه.", Map.of());
        }
        Set<UUID> others = new HashSet<>();
        route.stream().filter(x -> x.marked() && !x.key().equals(stage.key())).forEach(x -> others.addAll(humans(x.decidedBy())));
        if (intersects(actor, others)) {
            throw new ApiException(ErrorCode.SEPARATION_OF_DUTIES,
                    "قرر هذا الشخص مرحلة أخرى في الطلب نفسه؛ يقرر «" + stage.label() + "» إنسان آخر.", Map.of());
        }
        Set<UUID> excluded = new HashSet<>(requester);
        excluded.addAll(others);
        Map<UUID, UUID> delegators = delegators(ctx);
        Permission p = Permission.valueOf(stage.permission());
        Optional<Grant> g = ctx.grants().stream()
                .filter(x -> x.has(p) && seat(x, stage, r))
                .filter(x -> x.delegationId() == null || !excluded.contains(delegators.get(x.delegationId())))
                .findFirst();
        UUID target = stage.unit() != null ? stage.unit() : r.unit();
        if (g.isEmpty() || !ctx.canFor(p, target)) {
            throw ApiException.forbidden("ليس صاحب قرار المرحلة الحالية («" + stage.label() + "»).");
        }
        return g.get();
    }

    /** A hierarchy or cross-branch stage is the stage unit's own approver seat; the exception acts for the requesting unit. */
    private static boolean seat(Grant g, StageRow stage, Req r) {
        if (stage.unit() != null) {
            return !g.isAll() && stage.unit().equals(g.orgId());
        }
        return g.actsFor(r.unit());
    }

    private void settle(AccessContext ctx, UUID id, String number, int routeNo, Instant now) {
        List<StageRow> route = stages(id, routeNo);
        if (route.stream().anyMatch(x -> !x.marked())) {
            return;
        }
        UUID last = route.stream().filter(x -> "APPROVED".equals(x.mark())).reduce((a, b) -> b).map(StageRow::decidedBy).orElse(null);
        jdbc.sql("""
                update restationing_request set state = 'APPROVED_NOT_ACTIVATED', final_approver_id = :fa, updated_at = :now,
                       version = version + 1 where id = :id""")
                .param("fa", last).param("now", Db.ts(now)).param("id", id).update();
        audit.recordAs(ctx.actor(), "RESTATIONING_FINAL_APPROVAL", "RESTATIONING_REQUEST", id.toString(), number,
                Map.of("finalApprover", last == null ? "" : last.toString(), "awaiting", "تفعيل مستقل"), null);
    }

    // ---- hierarchy drift ------------------------------------------------------------------------------------

    /**
     * O-10 / O-16: pauses a request in review or approved-not-activated whose requesting unit's hierarchy differs from
     * its submission snapshot. Its own transaction; true when the request is (now) paused.
     */
    public boolean pauseIfDrifted(UUID id, Instant now) {
        return Boolean.TRUE.equals(tx.execute(s -> {
            Req r = lock(id);
            if ("PAUSED_HIERARCHY_CHANGED".equals(r.state())) {
                return true;
            }
            if (!RestationingState.valueOf(r.state()).pausesOnHierarchyChange() || r.snapshot() == null) {
                return false;
            }
            HierarchyDrift.Drift d = HierarchyDrift.detect(r.snapshot(), hierarchy);
            if (!d.drifted()) {
                return false;
            }
            Map<String, Object> paused = new LinkedHashMap<>();
            paused.put("at", now.toString());
            paused.put("reason", HierarchyDrift.MESSAGE);
            paused.put("from", r.state());
            paused.put("submittedPath", d.submitted().stream().map(UUID::toString).toList());
            paused.put("currentPath", d.current().stream().map(UUID::toString).toList());
            jdbc.sql("""
                    update restationing_request set state = 'PAUSED_HIERARCHY_CHANGED', paused = cast(:p as jsonb), updated_at = :now,
                           version = version + 1 where id = :id""")
                    .param("p", json.write(paused)).param("now", Db.ts(now)).param("id", id).update();
            audit.system("RESTATIONING_PAUSED", "RESTATIONING_REQUEST", id.toString(), r.number(), paused);
            return true;
        }));
    }

    /** Pauses every drifted request (after each HR publication and periodically). Returns how many were paused. */
    public int pauseDrifted(Instant now) {
        List<UUID> ids = jdbc.sql("select id from restationing_request where state in ('UNDER_REVIEW', 'APPROVED_NOT_ACTIVATED')")
                .query(UUID.class).list();
        int n = 0;
        for (UUID id : ids) {
            if (pauseIfDrifted(id, now)) {
                n++;
            }
        }
        return n;
    }

    // ---- activation -----------------------------------------------------------------------------------------

    public void activate(AccessContext ctx, UUID id, ReasonInput in, Instant now) {
        if (pauseIfDrifted(id, now)) {
            throw ApiException.validation(HierarchyDrift.MESSAGE + " — التفعيل ممنوع حتى إعادة التأكيد وإعادة الاعتماد.");
        }
        if (load(id).map(Req::extension).orElse(false)) {
            activateExtension(ctx, id, in, now);
            return;
        }
        tx.executeWithoutResult(s -> {
            Req r = lock(id);
            requireVisible(ctx, r);
            Optional<String> refusal = HierarchyDrift.activationRefusal(RestationingState.valueOf(r.state()), r.snapshot(), hierarchy);
            if (refusal.isPresent()) {
                throw ApiException.validation(refusal.get());
            }
            RestationingContent c = r.content();
            requireActivator(ctx, r, Permission.ACTIVATE_STATIONING, "التفعيل يحتاج صلاحية «تفعيل التمركز» على كل الوحدات المنتقلة.");
            // atomic conflict prevention: activations are serialised and the geography is checked again now
            jdbc.sql("select pg_advisory_xact_lock(hashtext('tmrkz.restationing.activation'))").query().singleRow();
            String siteGeo = json.write(c.site().geometry());
            List<String> taken = new ArrayList<>(checks.occupiedIntersecting(siteGeo, c.scope(), now));
            for (Map<String, Object> area : areas(c)) {
                taken.addAll(checks.occupiedIntersecting(json.write(area), c.scope(), now));
            }
            if (!taken.isEmpty()) {
                throw ApiException.validation("تغيّر إشغال الأرض منذ الاعتماد: " + String.join("، ", new java.util.LinkedHashSet<>(taken))
                        + " — لا يُفعّل الطلب.");
            }
            Instant from = c.temporary() && c.start().isAfter(now) ? c.start() : now;
            if (c.temporary() && !c.end().isAfter(from)) {
                throw ApiException.validation("انتهت مدة التمركز المؤقت قبل التفعيل.");
            }
            UUID site = registerSite(ctx, r, siteGeo, now);
            String sourceVersion = "policy-" + r.policyVersion() + "/rev-" + revisions(id);
            String ref = "restationing:" + r.number();
            try {
                for (UUID unit : c.scope()) {
                    if (c.temporary()) {
                        UUID base = checks.permanentSite(unit, now);
                        if (base == null) {
                            throw ApiException.validation("لا تمركز دائم حالياً لإحدى الوحدات؛ لا يُحفظ أصل للمؤقت.");
                        }
                        jdbc.sql("""
                                insert into org_stationing(id, organization_id, site_id, kind, base_id, valid_from, planned_end, origin,
                                                           request_id, reason, reference, recorded_by, recorded_at)
                                values (:id, :org, :site, 'TEMPORARY', :base, :from, :end, 'REQUEST', :req, :reason, :ref, :by, :now)""")
                                .param("id", UUID.randomUUID()).param("org", unit).param("site", site).param("base", base)
                                .param("from", Db.ts(from)).param("end", Db.ts(c.end())).param("req", id).param("reason", c.reason().trim())
                                .param("ref", r.number()).param("by", ctx.personId()).param("now", Db.ts(now)).update();
                        outbox.enqueue(from.isAfter(now) ? StationingEvent.Type.TEMPORARY_STATIONING_SCHEDULED
                                : StationingEvent.Type.TEMPORARY_STATIONING_STARTED, unit, site, from, now, sourceVersion, ref);
                    } else {
                        jdbc.sql("""
                                update org_stationing set valid_to = :now, end_reason = 'SUPERSEDED', ended_by = :by, ended_at = :now
                                 where organization_id = :org and valid_to is null and valid_from <= :now""")
                                .param("now", Db.ts(now)).param("by", ctx.personId()).param("org", unit).update();
                        // a temporary scheduled for later never starts after a permanent move
                        jdbc.sql("""
                                update org_stationing set valid_to = valid_from, end_reason = 'CANCELLED', ended_by = :by, ended_at = :now
                                 where organization_id = :org and valid_to is null and valid_from > :now""")
                                .param("now", Db.ts(now)).param("by", ctx.personId()).param("org", unit).update();
                        jdbc.sql("""
                                insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, request_id, reason,
                                                           reference, recorded_by, recorded_at)
                                values (:id, :org, :site, 'PERMANENT', :now, 'REQUEST', :req, :reason, :ref, :by, :now)""")
                                .param("id", UUID.randomUUID()).param("org", unit).param("site", site).param("now", Db.ts(now))
                                .param("req", id).param("reason", c.reason().trim()).param("ref", r.number()).param("by", ctx.personId())
                                .update();
                        outbox.enqueue(StationingEvent.Type.STATIONING_ACTIVATED, unit, site, now, now, sourceVersion, ref);
                    }
                }
            } catch (DataAccessException e) {
                if (Db.isExclusionViolation(e)) {
                    throw ApiException.validation("يتداخل التفعيل مع تمركز مسجل لإحدى الوحدات في الفترة نفسها.");
                }
                throw e;
            }
            for (String role : List.of("PRIMARY", "ALTERNATIVE")) {
                Map<String, Object> area = "PRIMARY".equals(role) ? c.primary() : c.alternative();
                if (area != null) {
                    jdbc.sql("""
                            insert into deployment_area(id, request_id, site_id, role, geom, state, valid_from)
                            values (:id, :req, :site, :role, ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326), 'ACTIVE', :from)""")
                            .param("id", UUID.randomUUID()).param("req", id).param("site", site).param("role", role)
                            .param("g", json.write(area)).param("from", Db.ts(from)).update();
                }
            }
            String state = !c.temporary() ? "ACTIVATED_PERMANENT" : from.isAfter(now) ? "TEMPORARY_SCHEDULED" : "ACTIVE_TEMPORARY";
            jdbc.sql("""
                    update restationing_request set state = :st, activated_by = :by, activated_at = :now, site_id = :site, updated_at = :now,
                           version = version + 1 where id = :id""")
                    .param("st", state).param("by", ctx.personId()).param("now", Db.ts(now)).param("site", site).param("id", id).update();
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("state", state);
            detail.put("siteId", site.toString());
            detail.put("units", c.scope().size());
            detail.put("from", from.toString());
            detail.put("siteLinks", "لم تتغير روابط المواقع ولا المسؤولية عن المرافق (O-14)");
            audit.recordAs(ctx.actor(), "RESTATIONING_ACTIVATED", "RESTATIONING_REQUEST", id.toString(), r.number(), detail,
                    in == null ? null : in.reason());
        });
    }

    /** D1/D10: neither the requester nor the final approver activates, and the activator's right covers every unit. */
    private void requireActivator(AccessContext ctx, Req r, Permission p, String missing) {
        Set<UUID> actor = humans(ctx.personId());
        Set<UUID> requester = humans(r.requester());
        Set<UUID> finalApprover = r.finalApprover() == null ? Set.of() : humans(r.finalApprover());
        if (intersects(actor, requester)) {
            throw new ApiException(ErrorCode.SEPARATION_OF_DUTIES, "مقدم الطلب لا يفعّل طلبه.", Map.of());
        }
        if (intersects(actor, finalApprover)) {
            throw new ApiException(ErrorCode.SEPARATION_OF_DUTIES, "صاحب الاعتماد النهائي لا يفعّل (D1).", Map.of());
        }
        Set<UUID> excluded = new HashSet<>(requester);
        excluded.addAll(finalApprover);
        Map<UUID, UUID> delegators = delegators(ctx);
        for (UUID unit : r.content().scope()) {
            boolean held = ctx.grants().stream().anyMatch(g -> g.has(p) && g.actsFor(unit)
                    && (g.delegationId() == null || !excluded.contains(delegators.get(g.delegationId()))));
            if (!held || !ctx.canFor(p, unit)) {
                throw ApiException.forbidden(missing);
            }
        }
    }

    /**
     * D10: an approved extension opens the following validity period of its temporary stationing. The open temporary
     * record ends at the current effective end (SUPERSEDED) and a following record runs to the new end; no earlier date
     * is edited. Activated apart, by ACTIVATE_TEMPORARY_EXTENSION, never by the extension's requester or final approver.
     */
    private void activateExtension(AccessContext ctx, UUID id, ReasonInput in, Instant now) {
        tx.executeWithoutResult(s -> {
            Req e = lock(id);
            requireVisible(ctx, e);
            if (!"APPROVED_NOT_ACTIVATED".equals(e.state())) {
                throw ApiException.validation("التفعيل بعد الاعتماد النهائي فقط");
            }
            Req parent = lock(e.parentId());
            Instant end = effectiveEnd(parent.id());
            if (!Set.of("TEMPORARY_SCHEDULED", "ACTIVE_TEMPORARY").contains(parent.state()) || end == null || !end.isAfter(now)) {
                throw ApiException.validation("التمركز المؤقت " + parent.number() + " لم يعد مجدولاً أو نافذاً؛ لا يُفعَّل التمديد.");
            }
            if (!e.content().end().isAfter(end)) {
                throw ApiException.validation("نهاية التمديد ليست بعد النهاية الفعالة الحالية.");
            }
            requireActivator(ctx, e, Permission.ACTIVATE_TEMPORARY_EXTENSION, "تفعيل التمديد يحتاج صلاحية «تفعيل تمديد التمركز المؤقت» على كل الوحدات.");
            String ref = "restationing:" + e.number();
            List<Map<String, Object>> open = jdbc.sql("""
                    update org_stationing set valid_to = planned_end, end_reason = 'SUPERSEDED', ended_by = :by, ended_at = :now
                     where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and valid_to is null
                    returning organization_id, site_id, base_id, planned_end""")
                    .param("by", ctx.personId()).param("now", Db.ts(now)).param("chain", Db.ids(chain(parent.id()))).query().listOfRows();
            for (Map<String, Object> o : open) {
                Instant from = Db.toInstant(o.get("planned_end"));
                jdbc.sql("""
                        insert into org_stationing(id, organization_id, site_id, kind, base_id, valid_from, planned_end, origin,
                                                   request_id, reason, reference, recorded_by, recorded_at)
                        values (:id, :org, :site, 'TEMPORARY', :base, :from, :end, 'REQUEST', :req, :reason, :ref, :by, :now)""")
                        .param("id", UUID.randomUUID()).param("org", o.get("organization_id")).param("site", o.get("site_id"))
                        .param("base", o.get("base_id")).param("from", Db.ts(from)).param("end", Db.ts(e.content().end()))
                        .param("req", e.id()).param("reason", e.content().reason().trim()).param("ref", e.number())
                        .param("by", ctx.personId()).param("now", Db.ts(now)).update();
                outbox.enqueue(StationingEvent.Type.TEMPORARY_STATIONING_SCHEDULED, (UUID) o.get("organization_id"), (UUID) o.get("site_id"),
                        from, now, "extension", ref);
            }
            jdbc.sql("""
                    update restationing_request set state = 'EXTENSION_ACTIVATED', activated_by = :by, activated_at = :now, site_id = :site,
                           updated_at = :now, version = version + 1 where id = :id""")
                    .param("by", ctx.personId()).param("now", Db.ts(now)).param("site", parent.siteId()).param("id", id).update();
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("parent", parent.number());
            detail.put("previousEnd", end.toString());
            detail.put("newEnd", e.content().end().toString());
            detail.put("units", open.size());
            audit.recordAs(ctx.actor(), "RESTATIONING_EXTENSION_ACTIVATED", "RESTATIONING_REQUEST", id.toString(), e.number(), detail,
                    in == null ? null : in.reason());
        });
    }

    /** An extension is checked against its temporary stationing, which must still be scheduled or in force. */
    private Result extensionChecks(Req r, StationingPolicy policy, Instant now) {
        Req parent = load(r.parentId()).orElseThrow();
        Result res = checks.evaluateExtension(r.unit(), r.content(), effectiveEnd(parent.id()), policy, now);
        if (Set.of("TEMPORARY_SCHEDULED", "ACTIVE_TEMPORARY").contains(parent.state())) {
            return res;
        }
        List<String> problems = new ArrayList<>(res.problems());
        problems.add(0, "التمركز المؤقت " + parent.number() + " ليس مجدولاً ولا نافذاً؛ لا يُمدَّد.");
        return new Result(problems, res.siteAreaM2(), res.maxFootprintAreaM2(), res.siteConflicts(), res.legs(), res.otherBranch(),
                res.route(), res.needsDistanceException(), res.currentSites());
    }

    /** A returned extension changes only its end and reason; the stationing it extends stays as it is. */
    private void editExtension(AccessContext ctx, Req r, RestationingContent in, Instant now) {
        RestationingContent c = r.content();
        RestationingContent next = new RestationingContent(c.kind(), c.start(), in.end(), c.scope(), c.occupants(), c.site(), c.primary(),
                c.alternative(), c.exceptions(), in.reason() == null ? "" : in.reason());
        jdbc.sql("""
                update restationing_request set content = cast(:c as jsonb), end_at = :end, reason = :reason, updated_at = :now,
                       version = version + 1 where id = :id""")
                .param("c", json.write(next.stored())).param("end", next.end() == null ? null : Db.ts(next.end()))
                .param("reason", next.reason()).param("now", Db.ts(now)).param("id", r.id()).update();
        audit.recordAs(ctx.actor(), "RESTATIONING_EDITED", "RESTATIONING_REQUEST", r.id().toString(), r.number(), next.summary(), null);
    }

    /**
     * What an audit entry needs to name a site geometry without copying it: its type, number of parts, area (when valid)
     * and a SHA-256 of its GeoJSON. The geometry itself is in the content and in every submitted revision.
     */
    private Map<String, Object> siteFacts(RestationingContent c) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (c.site() == null || c.site().geometry() == null) {
            m.put("type", null);
            return m;
        }
        Map<String, Object> g = c.site().geometry();
        String geo = json.write(g);
        m.put("type", g.get("type"));
        m.put("parts", "MultiPolygon".equals(g.get("type")) && g.get("coordinates") instanceof List<?> l ? l.size() : 1);
        m.put("shape", c.site().shape());
        m.put("areaM2", checks.siteProblem(geo) == null ? (Object) Math.round(jdbc.sql("select ST_Area(ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326)::geography)")
                .param("g", geo).query(Double.class).single()) : null);
        try {
            m.put("sha256", java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(geo.getBytes(java.nio.charset.StandardCharsets.UTF_8))));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        return m;
    }

    /** The temporary request and its activated extensions, whose records together make the stationing. */
    List<UUID> chain(UUID request) {
        List<UUID> out = new ArrayList<>(List.of(request));
        out.addAll(jdbc.sql("select id from restationing_request where parent_request_id = :id and state = 'EXTENSION_ACTIVATED' order by activated_at")
                .param("id", request).query(UUID.class).list());
        return out;
    }

    /** The end of a temporary stationing: its planned end, or the end of its latest activated extension. */
    Instant effectiveEnd(UUID request) {
        return jdbc.sql("""
                select coalesce((select max(e.end_at) from restationing_request e where e.parent_request_id = r.id and e.state = 'EXTENSION_ACTIVATED'),
                                r.end_at) as e
                  from restationing_request r where r.id = :id""")
                .param("id", request).query((rs, n) -> Db.instant(rs, "e")).optional().orElse(null);
    }

    /** A5: extensions not yet activated lapse when their temporary stationing ends, is cancelled or never starts. */
    void lapseExtensions(UUID parent, String reason, Instant now) {
        for (Map<String, Object> e : jdbc.sql("""
                update restationing_request set state = 'LAPSED_NOT_ACTIVATED', lapsed_at = :now, lapse_reason = :why, updated_at = :now,
                       version = version + 1
                 where parent_request_id = :p and state in ('DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED',
                                                            'APPROVED_NOT_ACTIVATED', 'CANCELLATION_PENDING')
                returning id, number""").param("now", Db.ts(now)).param("why", reason).param("p", parent).query().listOfRows()) {
            jdbc.sql("""
                    update restationing_action set state = 'SUPERSEDED', closed_at = :now, close_reason = :why
                     where request_id = :id and state = 'REQUESTED'""").param("now", Db.ts(now)).param("why", reason).param("id", e.get("id")).update();
            audit.system("RESTATIONING_EXTENSION_LAPSED", "RESTATIONING_REQUEST", e.get("id").toString(), (String) e.get("number"), Map.of("reason", reason));
        }
    }

    /** The deployment areas of a temporary stationing retire with it (at its actual end). */
    void retireAreas(UUID request, Instant end) {
        jdbc.sql("""
                update deployment_area set state = 'RETIRED', valid_to = greatest(:end, valid_from) where request_id = :id and state = 'ACTIVE'""")
                .param("end", Db.ts(end)).param("id", request).update();
    }

    /** The proposed site registered as a TMRKZ site with its boundary as version 1 (no responsibility, no links). */
    private UUID registerSite(AccessContext ctx, Req r, String geo, Instant now) {
        UUID site = UUID.randomUUID();
        Map<String, Object> centre = jdbc.sql("select ST_Y(c) as lat, ST_X(c) as lng from (select ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326)) as c) x")
                .param("g", geo).query().singleRow();
        jdbc.sql("""
                insert into site(id, code, name, kind, capacity, lat, lng, created_at, geometry_version)
                values (:id, :code, :name, 'موقع تمركز', null, :lat, :lng, :now, 1)""")
                .param("id", site).param("code", r.number()).param("name", "موقع " + r.number())
                .param("lat", centre.get("lat")).param("lng", centre.get("lng")).param("now", Db.ts(now)).update();
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, original_format,
                                                  reason, created_by)
                values (:id, :s, 1, cast(:g as jsonb), 'EPSG:4326', :src, :now, ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326), :type,
                        'RESTATIONING', :why, :by)""")
                .param("id", UUID.randomUUID()).param("s", site).param("g", geo).param("type", String.valueOf(r.content().site().geometry().get("type")))
                .param("src", "طلب إعادة تمركز " + r.number())
                .param("now", Db.ts(now)).param("why", r.content().reason().trim()).param("by", ctx.personId()).update();
        return site;
    }

    // ---- temporary lifecycle ----------------------------------------------------------------------------------

    /**
     * A6: the window of a held start ended with the cancellation still pending. The temporary never started: its records
     * close with an empty window (WINDOW_EXPIRED), the request ends TEMPORARY_WINDOW_EXPIRED_WITHOUT_START, the
     * cancellation is no longer actionable, and extensions lapse. Both records and their reasons stay in history.
     */
    void windowExpired(Req r, Instant now) {
        String why = "انقضت نافذة النفاذ دون بدء";
        List<Map<String, Object>> closed = jdbc.sql("""
                update org_stationing set valid_to = valid_from, end_reason = 'WINDOW_EXPIRED', ended_at = :now
                 where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY'
                   and (valid_to is null or valid_to > valid_from) and start_held_at is not null
                returning organization_id, site_id, valid_from""")
                .param("chain", Db.ids(chain(r.id()))).param("now", Db.ts(now)).query().listOfRows();
        for (Map<String, Object> c : closed) {
            outbox.enqueue(StationingEvent.Type.TEMPORARY_STATIONING_CANCELLED, (UUID) c.get("organization_id"), (UUID) c.get("site_id"),
                    Db.toInstant(c.get("valid_from")), now, "WINDOW_EXPIRED_WITHOUT_START", "restationing:" + r.number());
        }
        jdbc.sql("""
                update deployment_area set state = 'RETIRED', valid_to = valid_from where request_id = :id and state = 'ACTIVE'""")
                .param("id", r.id()).update();
        jdbc.sql("update restationing_request set state = 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START', updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", r.id()).update();
        jdbc.sql("""
                update restationing_action set state = 'NO_LONGER_ACTIONABLE', closed_at = :now, close_reason = :why
                 where request_id = :id and state = 'REQUESTED'""").param("now", Db.ts(now)).param("why", why).param("id", r.id()).update();
        audit.system("STATIONING_TEMPORARY_WINDOW_EXPIRED_WITHOUT_START", "RESTATIONING_REQUEST", r.id().toString(), r.number(),
                Map.of("units", closed.size(), "reason", why));
        lapseExtensions(r.id(), why, now);
    }

    /** Starts due temporaries and returns expired ones; each request in its own transaction. Returns {started, returned}. */
    public int[] runTemporaryLifecycle(Instant now) {
        int started = 0;
        int returned = 0;
        for (UUID id : jdbc.sql("select id from restationing_request where state = 'TEMPORARY_SCHEDULED' and start_at <= :now")
                .param("now", Db.ts(now)).query(UUID.class).list()) {
            if (Boolean.TRUE.equals(tx.execute(s -> start(id, now)))) {
                started++;
            }
        }
        for (UUID id : jdbc.sql("""
                select r.id from restationing_request r where r.state in ('ACTIVE_TEMPORARY', 'START_HELD_PENDING_CANCELLATION')
                   and coalesce((select max(e.end_at) from restationing_request e where e.parent_request_id = r.id and e.state = 'EXTENSION_ACTIVATED'),
                                r.end_at) <= :now""")
                .param("now", Db.ts(now)).query(UUID.class).list()) {
            if (Boolean.TRUE.equals(tx.execute(s -> expire(id, now)))) {
                returned++;
            }
        }
        return new int[] {started, returned};
    }

    private boolean start(UUID id, Instant now) {
        Req r = lock(id);
        if (!"TEMPORARY_SCHEDULED".equals(r.state())) {
            return false;
        }
        // A6: a cancellation still pending at the start holds it; the permanent stationing stays the authoritative one
        UUID pending = jdbc.sql("select id from restationing_action where request_id = :id and kind = 'BEFORE_START_CANCELLATION' and state = 'REQUESTED'")
                .param("id", id).query(UUID.class).optional().orElse(null);
        if (pending != null) {
            jdbc.sql("""
                    update org_stationing set start_held_at = :now
                     where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and (valid_to is null or valid_to > :now)""")
                    .param("now", Db.ts(now)).param("chain", Db.ids(chain(id))).update();
            jdbc.sql("update restationing_action set held_at = :now where id = :a").param("now", Db.ts(now)).param("a", pending).update();
            jdbc.sql("update restationing_request set state = 'START_HELD_PENDING_CANCELLATION', updated_at = :now, version = version + 1 where id = :id")
                    .param("now", Db.ts(now)).param("id", id).update();
            Map<String, Object> held = new LinkedHashMap<>();
            held.put("plannedStart", r.content().start().toString());
            held.put("plannedEnd", effectiveEnd(id).toString());
            held.put("cancellation", pending.toString());
            held.put("heldAt", now.toString());
            audit.system("STATIONING_START_HELD", "RESTATIONING_REQUEST", id.toString(), r.number(), held);
            return false;
        }
        String ref = "restationing:" + r.number();
        jdbc.sql("""
                select organization_id, site_id, valid_from from org_stationing
                 where request_id = :id and kind = 'TEMPORARY' and (valid_to is null or valid_to > :now) and valid_from <= :now""")
                .param("id", id).param("now", Db.ts(now)).query((rs, n) -> {
                    outbox.enqueue(StationingEvent.Type.TEMPORARY_STATIONING_STARTED, Db.uuid(rs, "organization_id"), Db.uuid(rs, "site_id"),
                            Db.instant(rs, "valid_from"), now, "start", ref);
                    return null;
                }).list();
        jdbc.sql("update restationing_request set state = 'ACTIVE_TEMPORARY', updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", id).update();
        audit.system("RESTATIONING_TEMPORARY_STARTED", "RESTATIONING_REQUEST", id.toString(), r.number(), Map.of("at", now.toString()));
        return true;
    }

    private boolean expire(UUID id, Instant now) {
        Req r = lock(id);
        if ("START_HELD_PENDING_CANCELLATION".equals(r.state())) {
            windowExpired(r, now);
            return true;
        }
        if (!"ACTIVE_TEMPORARY".equals(r.state())) {
            return false;
        }
        String ref = "restationing:" + r.number();
        Instant end = effectiveEnd(id);
        List<Map<String, Object>> ended = jdbc.sql("""
                update org_stationing set valid_to = greatest(planned_end, valid_from), end_reason = 'RETURNED', ended_at = :now
                 where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and valid_to is null
                returning organization_id, site_id, valid_to""")
                .param("chain", Db.ids(chain(id))).param("now", Db.ts(now)).query().listOfRows();
        for (Map<String, Object> e : ended) {
            outbox.enqueue(StationingEvent.Type.TEMPORARY_STATIONING_ENDED, (UUID) e.get("organization_id"), (UUID) e.get("site_id"),
                    Db.toInstant(e.get("valid_to")), now, "EXPIRED_RETURNED", ref);
        }
        retireAreas(id, end);
        jdbc.sql("update restationing_request set state = 'TEMPORARY_RETURNED', updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", id).update();
        // an early return still pending is overtaken by the end itself; extensions not activated lapse (A5)
        jdbc.sql("""
                update restationing_action set state = 'SUPERSEDED', closed_at = :now, close_reason = 'انتهى التمركز المؤقت في نهايته قبل القرار'
                 where request_id = :id and state = 'REQUESTED'""").param("now", Db.ts(now)).param("id", id).update();
        lapseExtensions(id, "انتهى التمركز المؤقت قبل تفعيل التمديد", now);
        audit.system("RESTATIONING_TEMPORARY_RETURNED", "RESTATIONING_REQUEST", id.toString(), r.number(),
                Map.of("units", ended.size(), "note", "عادت الوحدات إلى تمركزها الأصلي المحفوظ"));
        return true;
    }

    // ---- reads ----------------------------------------------------------------------------------------------

    /**
     * The units the actor may request a re-stationing for — the editor's choices — as a depth-ordered tree: exactly
     * where «طلب إعادة التمركز» acts (subtrees of the actor's grants, confirmed like every other check). Nothing else of
     * the organisation is disclosed, so a requester needs no general view right; without the right the list is empty.
     */
    public List<Map<String, Object>> requestableUnits(AccessContext ctx) {
        Set<UUID> ids = new HashSet<>();
        for (Grant g : ctx.grants()) {
            if (!g.has(Permission.CREATE_RESTATIONING)) {
                continue;
            }
            if (g.isAll()) {
                ids.addAll(jdbc.sql("select id from organization").query(UUID.class).list());
            } else if (!g.orgSubtree().isEmpty()) {
                ids.addAll(g.orgSubtree());
            } else if (g.orgId() != null) {
                ids.add(g.orgId());
            }
        }
        ids.removeIf(u -> !ctx.canFor(Permission.CREATE_RESTATIONING, u));
        if (ids.isEmpty()) {
            return List.of();
        }
        return jdbc.sql("""
                with recursive t(id, code, name, parent_id, depth, path) as (
                  select o.id, o.code, o.name, o.parent_id, 0, array[o.name::text] from organization o
                   where o.id = any(string_to_array(:ids, ',')::uuid[])
                     and (o.parent_id is null or not o.parent_id = any(string_to_array(:ids, ',')::uuid[]))
                  union all
                  select o.id, o.code, o.name, o.parent_id, t.depth + 1, t.path || o.name::text from organization o join t on o.parent_id = t.id
                   where o.id = any(string_to_array(:ids, ',')::uuid[]))
                select id, code, name, parent_id, depth from t order by path""")
                .param("ids", Db.ids(ids)).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("code", rs.getString("code"));
                    m.put("name", rs.getString("name"));
                    m.put("parentId", rs.getString("parent_id"));
                    m.put("depth", rs.getInt("depth"));
                    return m;
                }).list();
    }

    public List<Map<String, Object>> list(AccessContext ctx, String state) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (UUID id : jdbc.sql("select id from restationing_request where (cast(:st as text) is null or state = cast(:st as text)) order by created_at desc limit 500")
                .param("st", state == null || state.isBlank() ? null : state).query(UUID.class).list()) {
            Req r = load(id).orElseThrow();
            if (!visible(ctx, r)) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.id().toString());
            m.put("number", r.number());
            m.put("state", r.state());
            m.put("kind", r.extension() ? "EXTENSION" : r.content().kind());
            m.put("requestingUnit", ref(r.unit()));
            m.put("requester", person(r.requester()));
            m.put("units", r.content().scope().size());
            m.put("updatedAt", r.updatedAt().toString());
            List<StageRow> route = stages(id, r.routeNo());
            route.stream().filter(x -> !x.marked()).findFirst().ifPresent(x -> {
                m.put("currentStage", x.label());
                m.put("currentStageUnit", x.unit() == null ? null : ref(x.unit()).get("name"));
            });
            m.put("mine", r.requester().equals(ctx.personId()));
            out.add(m);
        }
        return out;
    }

    public Map<String, Object> view(AccessContext ctx, UUID id, Instant now) {
        Req r = load(id).orElseThrow(ApiException::notFound);
        requireVisible(ctx, r);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", r.id().toString());
        m.put("number", r.number());
        m.put("state", r.state());
        m.put("requestingUnit", ref(r.unit()));
        m.put("requester", person(r.requester()));
        m.put("content", r.content().stored());
        m.put("units", units(r.content().scope()));
        m.put("currentSites", sites(checks.currentSites(r.content().scope(), now)));
        m.put("policyVersion", r.policyVersion());
        m.put("routeNo", r.routeNo());
        List<StageRow> route = stages(id, r.routeNo());
        StageRow current = "UNDER_REVIEW".equals(r.state()) ? route.stream().filter(x -> !x.marked()).findFirst().orElse(null) : null;
        m.put("route", route.stream().map(x -> stageView(x, current)).toList());
        List<Map<String, Object>> previous = new ArrayList<>();
        for (int n = 1; n < r.routeNo(); n++) {
            Map<String, Object> pr = new LinkedHashMap<>();
            pr.put("routeNo", n);
            pr.put("stages", stages(id, n).stream().map(x -> stageView(x, null)).toList());
            previous.add(pr);
        }
        m.put("previousRoutes", previous);
        m.put("revisions", jdbc.sql("""
                select n, submitted_at, p.display_name, changed, reason, invalidated::text as inv, carried, route_no, policy_version
                  from restationing_revision v join person p on p.id = v.submitted_by where request_id = :id order by n""")
                .param("id", id).query((rs, i) -> {
                    Map<String, Object> v = new LinkedHashMap<>();
                    v.put("n", rs.getInt("n"));
                    v.put("submittedAt", Db.iso(rs, "submitted_at"));
                    v.put("submittedBy", rs.getString("display_name"));
                    v.put("changed", Db.strings(rs, "changed"));
                    v.put("reason", rs.getString("reason"));
                    v.put("invalidated", json.list(json.tree(rs.getString("inv"))));
                    v.put("carried", Db.strings(rs, "carried"));
                    v.put("routeNo", rs.getInt("route_no"));
                    v.put("policyVersion", rs.getInt("policy_version"));
                    return v;
                }).list());
        m.put("returned", r.returned());
        m.put("paused", r.paused());
        m.put("finalApprover", r.finalApprover() == null ? null : person(r.finalApprover()));
        if (r.activatedAt() != null) {
            Map<String, Object> a = new LinkedHashMap<>();
            a.put("by", person(r.activatedBy()));
            a.put("at", r.activatedAt().toString());
            a.put("site", siteRef(r.siteId()));
            m.put("activation", a);
        }
        Map<String, Object> can = new LinkedHashMap<>();
        boolean owner = r.requester().equals(ctx.personId());
        can.put("edit", owner && EDITABLE.contains(r.state()));
        can.put("submit", owner && EDITABLE.contains(r.state()));
        can.put("decide", current != null && mayDecide(ctx, r, current, route));
        can.put("activate", "APPROVED_NOT_ACTIVATED".equals(r.state()) && mayActivate(ctx, r));
        m.put("can", can);
        return m;
    }

    private boolean mayDecide(AccessContext ctx, Req r, StageRow stage, List<StageRow> route) {
        try {
            requireDecider(ctx, r, stage, route);
            return true;
        } catch (ApiException e) {
            return false;
        }
    }

    private boolean mayActivate(AccessContext ctx, Req r) {
        Set<UUID> actor = humans(ctx.personId());
        if (intersects(actor, humans(r.requester())) || r.finalApprover() != null && intersects(actor, humans(r.finalApprover()))) {
            return false;
        }
        Permission p = r.extension() ? Permission.ACTIVATE_TEMPORARY_EXTENSION : Permission.ACTIVATE_STATIONING;
        return r.content().scope().stream().allMatch(u -> ctx.canFor(p, u));
    }

    private Map<String, Object> stageView(StageRow x, StageRow current) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("key", x.key());
        s.put("kind", x.kind());
        s.put("label", x.label());
        s.put("unit", x.unit() == null ? null : ref(x.unit()));
        s.put("permission", x.permission());
        s.put("satisfies", x.satisfies().stream().map(m -> m.get("label")).toList());
        s.put("final", x.finalStage());
        s.put("mark", x.mark());
        s.put("current", current != null && current.key().equals(x.key()));
        s.put("decidedBy", x.decidedBy() == null ? null : person(x.decidedBy()));
        s.put("decidedAt", x.decidedAt() == null ? null : x.decidedAt().toString());
        return s;
    }

    /** Visible to the requester, to viewers of the requesting unit or a moving unit, and to the people who act on it. */
    boolean visible(AccessContext ctx, Req r) {
        if (r.requester().equals(ctx.personId())) {
            return true;
        }
        if (ctx.canFor(Permission.VIEW, r.unit()) || ctx.canFor(Permission.CREATE_RESTATIONING, r.unit())
                || ctx.canFor(Permission.APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION, r.unit())) {
            return true;
        }
        for (UUID u : r.content().scope()) {
            if (ctx.canFor(Permission.VIEW, u) || ctx.canFor(Permission.ACTIVATE_STATIONING, u)
                    || LIFECYCLE_ACTORS.stream().anyMatch(p -> ctx.canFor(p, u))) {
                return true;
            }
        }
        for (StageRow s : stages(r.id(), r.routeNo())) {
            if (s.unit() != null && ctx.grants().stream().anyMatch(g -> g.has(Permission.APPROVE) && !g.isAll() && s.unit().equals(g.orgId()))) {
                return true;
            }
        }
        return false;
    }

    void requireVisible(AccessContext ctx, Req r) {
        if (!visible(ctx, r)) {
            throw ApiException.notFound();
        }
    }

    private void requireOwnerEditable(AccessContext ctx, Req r) {
        if (!r.requester().equals(ctx.personId())) {
            throw ApiException.forbidden("يعدّل الطلبَ ويرسله مقدمُه فقط.");
        }
        if (!EDITABLE.contains(r.state())) {
            throw ApiException.validation("لا يُعدّل الطلب في حالته الحالية؛ الحركة اللاحقة تحتاج طلباً جديداً.");
        }
        if (!ctx.canFor(Permission.CREATE_RESTATIONING, r.unit())) {
            throw ApiException.forbidden("يحتاج صلاحية «طلب إعادة التمركز» للوحدة الطالبة.");
        }
    }

    // ---- storage --------------------------------------------------------------------------------------------

    Req lock(UUID id) {
        jdbc.sql("select id from restationing_request where id = :id for update").param("id", id).query().listOfRows();
        return load(id).orElseThrow(ApiException::notFound);
    }

    Optional<Req> load(UUID id) {
        return jdbc.sql("""
                select id, number, requester_id, requesting_unit_id, state, content::text as content, policy_version, route_no,
                       array_to_string(route_path, ',') as path, hierarchy_snapshot::text as snap, returned::text as ret,
                       paused::text as paused, final_approver_id, activated_by, activated_at, site_id, created_at, updated_at,
                       kind, parent_request_id
                  from restationing_request where id = :id""")
                .param("id", id).query((rs, n) -> new Req(Db.uuid(rs, "id"), rs.getString("number"), Db.uuid(rs, "requester_id"),
                        Db.uuid(rs, "requesting_unit_id"), rs.getString("state"),
                        RestationingContent.fromStored(json.map(rs.getString("content"))), (Integer) rs.getObject("policy_version"),
                        rs.getInt("route_no"), uuids(rs.getString("path")), snapshotOf(rs.getString("snap")),
                        rs.getString("ret") == null ? null : json.map(rs.getString("ret")),
                        rs.getString("paused") == null ? null : json.map(rs.getString("paused")),
                        Db.uuid(rs, "final_approver_id"), Db.uuid(rs, "activated_by"), Db.instant(rs, "activated_at"), Db.uuid(rs, "site_id"),
                        Db.instant(rs, "created_at"), Db.instant(rs, "updated_at"), rs.getString("kind"), Db.uuid(rs, "parent_request_id")))
                .optional();
    }

    @SuppressWarnings("unchecked")
    private List<StageRow> stages(UUID id, int routeNo) {
        return jdbc.sql("""
                select id, route_no, position, stage_key, kind, unit_id, permission, label, satisfies::text as sat,
                       array_to_string(depends_on, ',') as deps, final_stage, independent_of, mark, decided_by, via_delegation, decided_at
                  from restationing_stage where request_id = :id and route_no = :r order by position""")
                .param("id", id).param("r", routeNo)
                .query((rs, n) -> {
                    Set<Fact> deps = EnumSet.noneOf(Fact.class);
                    String d = rs.getString("deps");
                    if (d != null && !d.isBlank()) {
                        for (String f : d.split(",")) {
                            deps.add(Fact.valueOf(f));
                        }
                    }
                    List<Map<String, Object>> sat = (List<Map<String, Object>>) (List<?>) json.list(json.tree(rs.getString("sat")));
                    return new StageRow(Db.uuid(rs, "id"), rs.getInt("route_no"), rs.getInt("position"), rs.getString("stage_key"),
                            rs.getString("kind"), Db.uuid(rs, "unit_id"), rs.getString("permission"), rs.getString("label"), sat, deps,
                            rs.getBoolean("final_stage"), rs.getString("independent_of"), rs.getString("mark"), Db.uuid(rs, "decided_by"),
                            Db.uuid(rs, "via_delegation"), Db.instant(rs, "decided_at"));
                }).list();
    }

    private void insertStage(UUID request, StageRow st) {
        jdbc.sql("""
                insert into restationing_stage(id, request_id, route_no, position, stage_key, kind, unit_id, permission, label, satisfies,
                                               depends_on, final_stage, independent_of, mark, decided_by, via_delegation, decided_at)
                values (:id, :req, :route, :pos, :key, :kind, :unit, :perm, :label, cast(:sat as jsonb),
                        string_to_array(:deps, ',')::text[], :fin, :ind, :mark, :by, :via, :at)""")
                .param("id", UUID.randomUUID()).param("req", request).param("route", st.routeNo()).param("pos", st.position())
                .param("key", st.key()).param("kind", st.kind()).param("unit", st.unit()).param("perm", st.permission())
                .param("label", st.label()).param("sat", json.write(st.satisfies()))
                .param("deps", String.join(",", RestationingContent.names(st.dependsOn()))).param("fin", st.finalStage())
                .param("ind", st.independentOf()).param("mark", st.mark()).param("by", st.decidedBy()).param("via", st.viaDelegation())
                .param("at", st.decidedAt() == null ? null : Db.ts(st.decidedAt())).update();
    }

    private static StageRow row(RouteStage s, int routeNo, int position, String mark, UUID by, UUID via, Instant at) {
        List<Map<String, Object>> sat = s.satisfies().stream().map(q -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("code", q.code());
            m.put("label", q.label());
            return m;
        }).toList();
        String perm = s.kind() == RouteDerivation.Kind.EXCEPTION ? Permission.APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION.name() : Permission.APPROVE.name();
        return new StageRow(null, routeNo, position, s.key(), s.kind().name(), s.unit(), perm, s.label(), sat, s.dependsOn(),
                s.finalStage(), s.independentOf(), mark, by, via, at);
    }

    private static Map<String, Object> decisionOf(StageRow o) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("stage", o.key());
        m.put("label", o.label());
        m.put("decidedBy", o.decidedBy() == null ? null : o.decidedBy().toString());
        m.put("decidedAt", o.decidedAt() == null ? null : o.decidedAt().toString());
        return m;
    }

    private Map<String, Object> lastRevision(UUID id) {
        return jdbc.sql("select n, content::text as content from restationing_revision where request_id = :id order by n desc limit 1")
                .param("id", id).query().listOfRows().stream().findFirst().orElse(null);
    }

    private int revisions(UUID id) {
        return jdbc.sql("select count(*) from restationing_revision where request_id = :id").param("id", id).query(Integer.class).single();
    }

    private void touch(UUID id, Instant now) {
        jdbc.sql("update restationing_request set updated_at = :now, version = version + 1 where id = :id")
                .param("now", Db.ts(now)).param("id", id).update();
    }

    private static List<Map<String, Object>> areas(RestationingContent c) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (c.primary() != null) {
            out.add(c.primary());
        }
        if (c.alternative() != null) {
            out.add(c.alternative());
        }
        return out;
    }

    private Map<String, Object> checkView(Result res, int policyVersion) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", res.ok());
        m.put("problems", res.problems());
        m.put("policyVersion", policyVersion);
        m.put("siteAreaM2", res.siteAreaM2() == null ? null : Math.round(res.siteAreaM2()));
        m.put("maxFootprintAreaM2", Math.round(res.maxFootprintAreaM2()));
        m.put("siteConflicts", res.siteConflicts());
        List<Map<String, Object>> legs = new ArrayList<>();
        List<Map<String, Object>> terrainAudit = new ArrayList<>();
        for (RestationingChecks.Leg l : res.legs()) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("leg", l.leg());
            v.put("label", l.label());
            v.put("status", l.check().status().name());
            v.put("distanceM", l.check().distanceM() == null ? null : Math.round(l.check().distanceM()));
            v.put("baseMinM", l.check().baseMinM());
            v.put("baseMaxM", l.check().baseMaxM());
            v.put("effectiveMinM", l.check().effectiveMinM());
            v.put("effectiveMaxM", l.check().effectiveMaxM());
            v.put("exceptionMaxM", l.check().exceptionMaxM());
            v.put("method", "CENTROID_TO_CENTROID");
            v.put("conflicts", l.conflicts());
            if (l.terrain() != null) {
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("controllingClass", l.terrain().controllingClass());
                t.put("controllingLabel", l.terrain().controllingLabel());
                t.put("shares", l.terrain().shares());
                t.put("tie", l.terrain().tie());
                t.put("tied", l.terrain().tied());
                t.put("resolved", l.terrain().resolved());
                t.put("priority", l.terrain().priority());
                t.put("allowanceM", l.terrain().allowanceM());
                t.put("dataset", l.terrain().datasetCode() + " " + l.terrain().datasetVersion());
                t.put("surfaceModel", l.terrain().surfaceModel());
                v.put("terrain", t);
                Map<String, Object> a = new LinkedHashMap<>(t);
                a.remove("shares");
                a.put("leg", l.leg());
                a.put("policyVersion", policyVersion);
                terrainAudit.add(a);
            }
            legs.add(v);
        }
        m.put("legs", legs);
        m.put("terrain", terrainAudit);
        m.put("otherBranch", res.otherBranch().stream().map(o -> {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("unit", o.unit().toString());
            v.put("name", o.name());
            v.put("siteId", o.siteId().toString());
            v.put("siteName", o.siteName());
            v.put("decisionRequired", o.decisionRequired());
            v.put("decision", o.decision());
            return v;
        }).toList());
        m.put("route", res.route().stream().map(s -> {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("key", s.key());
            v.put("kind", s.kind().name());
            v.put("label", s.label());
            v.put("unit", s.unit() == null ? null : ref(s.unit()));
            v.put("satisfies", s.satisfies().stream().map(RouteDerivation.Requirement::label).toList());
            v.put("final", s.finalStage());
            return v;
        }).toList());
        m.put("needsDistanceException", res.needsDistanceException());
        return m;
    }

    Set<UUID> humans(UUID person) {
        return person == null ? Set.of() : keys.samePeople(List.of(person)).get(person);
    }

    static boolean intersects(Set<UUID> a, Set<UUID> b) {
        return a.stream().anyMatch(b::contains);
    }

    Map<UUID, UUID> delegators(AccessContext ctx) {
        List<UUID> ids = ctx.grants().stream().map(Grant::delegationId).filter(java.util.Objects::nonNull).distinct().toList();
        Map<UUID, UUID> out = new LinkedHashMap<>();
        if (!ids.isEmpty()) {
            jdbc.sql("select id, delegator_id from delegation where id = any(string_to_array(:ids, ',')::uuid[])")
                    .param("ids", Db.ids(ids)).query((rs, n) -> out.put(Db.uuid(rs, "id"), Db.uuid(rs, "delegator_id"))).list();
        }
        return out;
    }

    private Map<String, Object> ref(UUID org) {
        return jdbc.sql("select id, code, name from organization where id = :id").param("id", org).query((rs, n) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", rs.getString("id"));
            m.put("code", rs.getString("code"));
            m.put("name", rs.getString("name"));
            return m;
        }).optional().orElse(Map.of("id", org.toString()));
    }

    private Map<String, Object> siteRef(UUID site) {
        return jdbc.sql("select id, code, name from site where id = :id").param("id", site).query((rs, n) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", rs.getString("id"));
            m.put("code", rs.getString("code"));
            m.put("name", rs.getString("name"));
            return m;
        }).optional().orElse(Map.of("id", site.toString()));
    }

    private Map<String, Object> person(UUID p) {
        return jdbc.sql("select id, display_name from person where id = :id").param("id", p).query((rs, n) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", rs.getString("id"));
            m.put("name", rs.getString("display_name"));
            return m;
        }).optional().orElse(Map.of("id", p.toString()));
    }

    private List<Map<String, Object>> units(List<UUID> scope) {
        return scope.stream().map(this::ref).toList();
    }

    /** Where each moving unit is stationed now, with the site's current boundary (or marker) for the map. */
    private List<Map<String, Object>> sites(Map<UUID, UUID> current) {
        List<Map<String, Object>> out = new ArrayList<>();
        current.forEach((org, site) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("unit", org.toString());
            m.put("site", siteRef(site));
            m.put("geometry", jdbc.sql("""
                    select ST_AsGeoJSON(coalesce(g.geom, s.marker)) from site s
                      left join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version where s.id = :id""")
                    .param("id", site).query(String.class).optional().map(json::map).orElse(null));
            out.add(m);
        });
        return out;
    }

    private static Map<String, Object> snapshot(HierarchySnapshot s) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("requestingUnit", s.requestingUnit().toString());
        m.put("path", s.path().stream().map(UUID::toString).toList());
        m.put("externalPath", s.externalPath());
        m.put("takenAt", s.takenAt().toString());
        return m;
    }

    @SuppressWarnings("unchecked")
    private HierarchySnapshot snapshotOf(String text) {
        if (text == null) {
            return null;
        }
        Map<String, Object> m = json.map(text);
        return new HierarchySnapshot(UUID.fromString(m.get("requestingUnit").toString()),
                ((List<Object>) m.get("path")).stream().map(x -> UUID.fromString(x.toString())).toList(),
                ((List<Object>) m.get("externalPath")).stream().map(Object::toString).toList(), Instant.parse(m.get("takenAt").toString()));
    }

    private static List<UUID> uuids(String csv) {
        if (csv == null || csv.isBlank()) {
            return List.of();
        }
        List<UUID> out = new ArrayList<>();
        for (String s : csv.split(",")) {
            out.add(UUID.fromString(s));
        }
        return out;
    }
}
