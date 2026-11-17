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
 *   <li>a stage is decided through the permission of its kind — a hierarchy level through APPROVE_HIERARCHY held in the
 *       stage unit's own approver seat, unit operations and the final approval by the nearest holder — confirmed by OpenFGA,
 *       never by the requester or on the requester's delegation, and one human decides at most one stage of a request; a
 *       request whose deployment areas lie beyond the policy's range is flagged on every stage and its final stage decides
 *       the excess with the request (ADR-078, no exception stage of its own);</li>
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

    public record SiteInput(Map<String, Object> geometry, UUID copiedFrom, String shape) {
    }

    public record ContentInput(String kind, String start, String end, List<UUID> scope, Map<UUID, String> occupants,
                               SiteInput site, Map<String, Object> primary, Map<String, Object> alternative,
                               Map<String, String> exceptions, String reason, UUID existingSite, RestationingContent.SiteInfo siteInfo) {
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
                    primary, alternative, exceptions, reason, existingSite, siteInfo);
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

    public record CreateInput(UUID requestingUnitId, ContentInput content, String purpose) {
    }

    /** The units informed after final approval (ADR-045): none is a recorded choice too. */
    public record FyiInput(List<UUID> units, String note) {
    }

    public record ReasonInput(String reason) {
    }

    /**
     * APPROVE, RETURN or REJECT — or, with {@code parts} (part → APPROVE or CHANGES), the stage's decision part by part
     * («الاعتماد الجزئي», ADR-090): RETURN when a part needs changes, APPROVE when every part is approved.
     */
    public record DecisionInput(String decision, String reason, Map<String, String> parts, Map<String, String> partNotes) {
        public DecisionInput(String decision, String reason) {
            this(decision, reason, null, null);
        }

        boolean byParts() {
            return parts != null && !parts.isEmpty();
        }
    }

    /** A request as stored. */
    record Req(UUID id, String number, UUID requester, UUID unit, String state, RestationingContent content, Integer policyVersion,
               int routeNo, List<UUID> routePath, HierarchySnapshot snapshot, Map<String, Object> returned, Map<String, Object> paused,
               UUID finalApprover, UUID activatedBy, Instant activatedAt, UUID siteId, Instant createdAt, Instant updatedAt,
               String kind, UUID parentId, String purpose, UUID routeVersion) {
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

        /** Decided by a person (approved, or carried from an earlier decision) — a skipped hierarchy stage is not (ADR-062). */
        boolean decided() {
            return mark != null && !SKIPPED.equals(mark);
        }

        StageRow withMark(String m) {
            return new StageRow(id, routeNo, position, key, kind, unit, permission, label, satisfies, dependsOn, finalStage, independentOf, m,
                    decidedBy, viaDelegation, decidedAt);
        }
    }

    /** A hierarchy stage whose level has no approver, own or inherited (ADR-058), is passed and recorded (owner, 16 Nov 2026, ADR-062). */
    static final String SKIPPED = "SKIPPED";
    static final String NO_HIERARCHY_APPROVER = "NO_HIERARCHY_APPROVER";
    static final String NO_HIERARCHY_APPROVER_TEXT = "تم تجاوز هذه الجهة لعدم وجود معتمد للسلسلة الهرمية";

    private final JdbcClient jdbc;
    private final Json json;
    private final AuditService audit;
    private final StationingPolicyStore policies;
    private final RestationingChecks checks;
    private final OrgHierarchy hierarchy;
    private final StationingOutbox outbox;
    private final PersonKeys keys;
    @org.springframework.beans.factory.annotation.Autowired
    private PartReviews partReviews;
    private final TransactionTemplate tx;
    private final PlaceInfo placeInfo;
    private final StationingRoutes routes;
    private final ae.mover.access.Stations stations;

    public RestationingService(JdbcClient jdbc, Json json, AuditService audit, StationingPolicyStore policies, RestationingChecks checks,
                               OrgHierarchy hierarchy, StationingOutbox outbox, PersonKeys keys, TransactionTemplate tx, PlaceInfo placeInfo,
                               StationingRoutes routes, ae.mover.access.Stations stations) {
        this.stations = stations;
        this.routes = routes;
        this.placeInfo = placeInfo;
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
        String purpose = in.purpose() == null || in.purpose().isBlank() ? RestationingChecks.RESTATIONING : in.purpose();
        if (RestationingChecks.INITIAL_STATIONING.equals(purpose)) {
            throw ApiException.validation(INITIAL_IN_SETUP);
        }
        Permission create = createPermission(purpose);
        if (!ctx.canFor(create, in.requestingUnitId())) {
            throw ApiException.forbidden(RestationingChecks.RESTATIONING.equals(purpose)
                    ? "إنشاء طلب إعادة تمركز يحتاج صلاحية «طلب إعادة التمركز» للوحدة الطالبة."
                    : "هذا الطلب يحتاج صلاحيته الخاصة للوحدة الطالبة.");
        }
        RestationingContent c = in.content().toContent();
        return tx.execute(s -> {
            refuseDuplicate(purpose, c.scope(), null);
            long seq = jdbc.sql("select nextval('restationing_request_no')").query(Long.class).single();
            String number = "RS-" + now.atZone(ZoneOffset.UTC).getYear() + "-" + String.format("%04d", seq);
            UUID id = UUID.randomUUID();
            jdbc.sql("""
                    insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind, start_at, end_at, reason,
                                                     content, created_at, updated_at, purpose)
                    values (:id, :n, :by, :unit, 'DRAFT', :kind, :start, :end, :reason, cast(:c as jsonb), :now, :now, :purpose)""")
                    .param("id", id).param("n", number).param("by", ctx.personId()).param("unit", in.requestingUnitId())
                    .param("kind", c.kind()).param("start", Db.ts(c.start() == null ? now : c.start()))
                    .param("end", c.end() == null ? null : Db.ts(c.end())).param("reason", c.reason())
                    .param("c", json.write(c.stored())).param("now", Db.ts(now)).param("purpose", purpose).update();
            Map<String, Object> created = new LinkedHashMap<>(c.summary());
            created.put("purpose", purpose);
            audit.recordAs(ctx.actor(), "RESTATIONING_CREATED", "RESTATIONING_REQUEST", id.toString(), number, created, null);
            return id;
        });
    }

    /**
     * Which right opens a request of this purpose — and so whose request it is, for the requesting unit (RULE A, ADR-069):
     * «طلب إعادة التمركز ومناطق الانتشار» for a re-stationing and a deployment-area request (one right since ADR-078), «طلب
     * اعتماد موقع» for a site. An initial stationing can no longer be asked for; an old one belongs to the same requesters as a
     * re-stationing, who may follow it and cancel it.
     */
    static Permission createPermission(String purpose) {
        return switch (purpose) {
            case RestationingChecks.RESTATIONING, RestationingChecks.DEPLOYMENT_AREAS, RestationingChecks.INITIAL_STATIONING -> Permission.CREATE_RESTATIONING;
            case RestationingChecks.SITE_REGISTRATION -> Permission.REQUEST_SITE_REGISTRATION;
            default -> throw ApiException.validation("نوع طلب غير معروف.");
        };
    }

    /** Initial stationing is recorded with its site in «تهيئة المواقع» (ADR-067, ADR-076), never asked for (ADR-078). */
    static final String INITIAL_IN_SETUP = "طلب التمركز الأولي أُلغي بقرار المالك: يُسجَّل التمركز الأولي للوحدة مع موقعها من «تهيئة المواقع».";

    /**
     * The path a request follows (ADR-046): the version it was pinned to when first sent; a draft takes the one in force now. A
     * request sent while its type had none stays on the policy's route, as does a type with none.
     */
    private StationingRoutes.RouteRule pathOf(Req r) {
        if (r.routeVersion() != null) {
            return routes.byId(r.routeVersion()).orElse(null);
        }
        return "DRAFT".equals(r.state()) ? routes.published(r.purpose()).map(Map.Entry::getValue).orElse(null) : null;
    }

    /** One open initial-stationing or deployment request at a time for a unit: another would overwrite what the first decides. */
    private void refuseDuplicate(String purpose, List<UUID> units, UUID self) {
        if (!RestationingChecks.INITIAL_STATIONING.equals(purpose) && !RestationingChecks.DEPLOYMENT_AREAS.equals(purpose)) {
            return;
        }
        for (UUID unit : units) {
            String open = openRequest(purpose, unit, self);
            if (open != null) {
                throw ApiException.validation("يوجد طلب مفتوح لهذه الوحدة (" + open + "). أكمله أو انتظر القرار فيه.");
            }
        }
    }

    /** The number of an open request of this purpose covering a unit, or null. */
    String openRequest(String purpose, UUID unit, UUID self) {
        return jdbc.sql("""
                select number from restationing_request
                 where purpose = :p and jsonb_exists(content->'scope', :u) and (cast(:self as uuid) is null or id <> cast(:self as uuid))
                   and state in ('DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED', 'APPROVED_NOT_ACTIVATED', 'CANCELLATION_PENDING')
                 order by created_at desc limit 1""")
                .param("p", purpose).param("u", unit.toString()).param("self", self == null ? null : self.toString())
                .query(String.class).optional().orElse(null);
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
                : checks.evaluate(r.purpose(), r.unit(), r.content(), pv.get().values(), pv.get().version(), now, pathOf(r));
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
            refuseDuplicate(r.purpose(), r.content().scope(), r.id());
            Result res = r.extension() ? extensionChecks(r, pv.values(), now) : checks.evaluate(r.purpose(), r.unit(), r.content(), pv.values(), pv.version(), now, pathOf(r));
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
                old.stream().filter(StageRow::decided).forEach(o -> invalidated.add(decisionOf(o)));
                for (int i = 0; i < fresh.size(); i++) {
                    next.add(row(fresh.get(i), routeNo, i, null, null, null, null));
                }
            } else {
                routeNo = r.routeNo();
                reconcile(old, fresh, changed, routeNo, next, invalidated, carried);
                jdbc.sql("delete from restationing_stage where request_id = :id and route_no = :r").param("id", id).param("r", routeNo).update();
            }
            // ADR-062: every hierarchy stage is looked at again for this submission; nobody there, own or inherited → skipped
            List<StageRow> resolved = new ArrayList<>();
            List<StageRow> skippedNow = new ArrayList<>();
            for (StageRow st : next) {
                StageRow x = st;
                if ("HIERARCHY".equals(st.kind()) && (st.mark() == null || SKIPPED.equals(st.mark()))) {
                    boolean nobody = stations.byPermission(Permission.parse(st.permission()).orElse(Permission.APPROVE_HIERARCHY), st.unit()).empty();
                    x = st.withMark(nobody ? SKIPPED : null);
                    if (nobody) {
                        skippedNow.add(x);
                    }
                }
                resolved.add(x);
            }
            next = resolved;
            for (StageRow st : next) {
                insertStage(id, st);
            }
            HierarchySnapshot snap = HierarchySnapshot.take(hierarchy, r.unit(), now);
            jdbc.sql("""
                    update restationing_request set state = 'UNDER_REVIEW', policy_version = :pv, route_no = :route,
                           route_path = string_to_array(:path, ',')::uuid[], hierarchy_snapshot = cast(:snap as jsonb), returned = null,
                           paused = null, updated_at = :now, version = version + 1, route_version_id = :rv where id = :id""")
                    .param("rv", first ? routes.published(r.purpose()).map(Map.Entry::getKey).orElse(null) : r.routeVersion())
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
            recordSkipped(id, r.number(), n, routeNo, pv.version(), r.unit(), skippedNow, now);
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("policyVersion", pv.version());
            detail.put("purpose", r.purpose());
            detail.put("revision", n);
            detail.put("route", routeNo);
            detail.put("stages", next.size());
            detail.put("changed", RestationingContent.names(changed));
            detail.put("invalidated", invalidated.size());
            detail.put("carried", carried.size());
            detail.put("terrain", view.get("terrain"));
            detail.put("site", siteFacts(r.content()));
            if (res.areaOverMax()) {
                // the area beyond the maximum, sent for the final approver to decide (ADR-087)
                detail.put("areaOverMax", Map.of("areaM2", Math.round(res.siteAreaM2()), "maxM2", Math.round(res.maxFootprintAreaM2())));
            }
            if (res.needsDistanceException()) {
                // O-17: the written reason of every distance exception, with the submission it belongs to; the final approver
                // decides the excess with the request (ADR-078)
                detail.put("distanceExceptions", r.content().exceptions());
                detail.put("exceedsPolicy", exceeds(view, r.content()));
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
            if (hits(fresh.get(i), changed) || p == null || !p.decided()) {
                reopen = i;
                break;
            }
        }
        for (int i = 0; i < fresh.size(); i++) {
            RouteStage s = fresh.get(i);
            StageRow p = prev.get(s.key());
            if (p == null || !p.decided()) {
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
        boolean byParts = in != null && in.byParts();
        String asked = in == null || in.decision() == null ? "" : in.decision();
        String given = in == null || in.reason() == null ? "" : in.reason().trim();
        if (!byParts && !Set.of("APPROVE", "RETURN", "REJECT").contains(asked)) {
            throw ApiException.validation("القرار اعتماد أو إرجاع أو رفض.");
        }
        if (!byParts && !"APPROVE".equals(asked) && given.length() < 5) {
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
            detail.put("stageKind", stage.kind());
            detail.put("purpose", r.purpose());
            detail.put("route", r.routeNo());
            List<Map<String, Object>> excess = exceeds(r);
            if (stage.finalStage() && !excess.isEmpty()) {
                // the final approver decides the excess with the request (ADR-078): the decision records what it covered
                detail.put("exceedsPolicy", excess);
            }
            // «الاعتماد الجزئي» (ADR-090): the stage decides each part; a part it approved and that is unchanged is kept
            String decision = asked;
            String reason = given;
            List<String> returnedParts = List.of();
            if (byParts) {
                PartReviews.Outcome o = partReviews.apply(id, r.purpose(), r.content(), stage.key(), stage.label(), in.parts(), in.partNotes(),
                        ctx.personId(), ctx.actor().displayName(), now);
                decision = o.decision();
                returnedParts = o.changes();
                detail.put("parts", o.parts());
                if ("RETURN".equals(decision) && reason.length() < 5) {
                    reason = PartReviews.reasonOf(o.changes(), in.partNotes());
                }
            }
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
                    if (!returnedParts.isEmpty()) {
                        ret.put("parts", returnedParts);
                    }
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
        Set<UUID> requester = requesters(r);
        if (intersects(actor, requester)) {
            throw new ApiException(ErrorCode.SEPARATION_OF_DUTIES, "مقدم الطلب لا يقرر مراحل طلبه.", Map.of());
        }
        Set<UUID> others = new HashSet<>();
        // the approver who signed a lower station because it had nobody of its own still signs his own (ADR-058, as in TNQL)
        route.stream().filter(x -> x.decided() && !x.key().equals(stage.key()) && !inheritedBy(x, stage))
                .forEach(x -> others.addAll(humans(x.decidedBy())));
        if (intersects(actor, others)) {
            throw new ApiException(ErrorCode.SEPARATION_OF_DUTIES,
                    "قرر هذا الشخص مرحلة أخرى في الطلب نفسه؛ يقرر «" + stage.label() + "» إنسان آخر.", Map.of());
        }
        Set<UUID> excluded = new HashSet<>(requester);
        excluded.addAll(others);
        Map<UUID, UUID> delegators = delegators(ctx);
        // a stage of an old request routed to an action removed since (an undecided distance-exception stage, ADR-078) has nobody
        Permission p = Permission.parse(stage.permission()).orElseThrow(() -> ApiException.forbidden(
                "مرحلة «" + stage.label() + "» من مسار قديم لم تعد تُقرر؛ يقرر المعتمد النهائي الطلب، أو أعد إرساله."));
        ae.mover.access.Stations.Station station = stage.unit() == null ? null : stations.byPermission(p, stage.unit());
        // unit operations and the final approval: the nearest scope covering the requesting unit decides (owner, 16 Nov 2026)
        Set<UUID> nearest = NEAREST_SCOPE.contains(stage.kind()) ? stations.nearestGrants(p, r.unit(), excluded) : null;
        Optional<Grant> g = ctx.grants().stream()
                .filter(x -> x.has(p) && seat(x, stage, r, station, ctx.personId()) && (nearest == null || nearest.contains(x.grantId())))
                .filter(x -> x.delegationId() == null || !excluded.contains(delegators.get(x.delegationId())))
                .findFirst();
        UUID target = stage.unit() != null ? stage.unit() : r.unit();
        if (g.isEmpty() || !ctx.canFor(p, target)) {
            throw ApiException.forbidden("ليس صاحب قرار المرحلة الحالية («" + stage.label() + "»).");
        }
        return g.get();
    }

    /** Stages with no unit of their own decided by the nearest scope covering the requesting unit (owner, 16 Nov 2026). */
    private static final Set<String> NEAREST_SCOPE = Set.of("UNIT_OPERATIONS", "FINAL");

    /**
     * A hierarchy or cross-branch stage is the stage unit's own approver seat — or, when the unit has no approver of its own,
     * the seat of the nearest unit above it whose approver's grant covers its branch (ADR-058, TNQL's inherited station). The
     * exception acts for the requesting unit.
     */
    private static boolean seat(Grant g, StageRow stage, Req r, ae.mover.access.Stations.Station station, UUID actor) {
        if (stage.unit() != null) {
            if (g.isAll() || station == null || !station.people().contains(actor)) {
                return false;
            }
            boolean inherited = station.via() == ae.mover.access.Stations.Via.INHERITED;
            UUID at = inherited ? station.from() : stage.unit();
            return at.equals(g.orgId()) || g.targets().stream().anyMatch(t -> ae.mover.access.GrantTarget.ORGANIZATION.equals(t.kind())
                    && (t.id().equals(at) || (!inherited && t.reached().contains(at))));
        }
        return g.actsFor(r.unit());
    }

    /** Whether {@code earlier} is a lower hierarchy station that had no approver of its own and was inherited from {@code stage}'s unit. */
    private boolean inheritedBy(StageRow earlier, StageRow stage) {
        if (!"HIERARCHY".equals(earlier.kind()) || !"HIERARCHY".equals(stage.kind()) || earlier.unit() == null || stage.unit() == null) {
            return false;
        }
        var st = stations.byPermission(Permission.parse(earlier.permission()).orElse(Permission.APPROVE_HIERARCHY), earlier.unit());
        return st.via() == ae.mover.access.Stations.Via.INHERITED && stage.unit().equals(st.from());
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
            if (fyiPending(r)) {
                throw ApiException.validation("حدد وحدات العلم أولاً: تشترط السياسة تسجيلها قبل التفعيل.");
            }
            // atomic conflict prevention: activations are serialised and the geography is checked again now
            jdbc.sql("select pg_advisory_xact_lock(hashtext('tmrkz.restationing.activation'))").query().singleRow();
            if (!RestationingChecks.RESTATIONING.equals(r.purpose())) {
                activatePurpose(ctx, r, in, now);
                return;
            }
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
            Map<UUID, UUID> records = new LinkedHashMap<>();
            try {
                for (UUID unit : c.scope()) {
                    UUID record = UUID.randomUUID();
                    records.put(unit, record);
                    if (c.temporary()) {
                        UUID base = checks.permanentSite(unit, now);
                        if (base == null) {
                            throw ApiException.validation("لا تمركز دائم حالياً لإحدى الوحدات؛ لا يُحفظ أصل للمؤقت.");
                        }
                        jdbc.sql("""
                                insert into org_stationing(id, organization_id, site_id, kind, base_id, valid_from, planned_end, origin,
                                                           request_id, reason, reference, recorded_by, recorded_at)
                                values (:id, :org, :site, 'TEMPORARY', :base, :from, :end, 'REQUEST', :req, :reason, :ref, :by, :now)""")
                                .param("id", record).param("org", unit).param("site", site).param("base", base)
                                .param("from", Db.ts(from)).param("end", Db.ts(c.end())).param("req", id).param("reason", c.reason().trim())
                                .param("ref", r.number()).param("by", ctx.personId()).param("now", Db.ts(now)).update();
                        outbox.enqueue(from.isAfter(now) ? StationingEvent.Type.TEMPORARY_STATIONING_SCHEDULED
                                : StationingEvent.Type.TEMPORARY_STATIONING_STARTED, unit, site, from, now, sourceVersion, ref);
                    } else {
                        retireUnitAreas(unit, now);
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
                                .param("id", record).param("org", unit).param("site", site).param("now", Db.ts(now))
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
            records.forEach((unit, record) -> insertAreas(r, unit, record, site, from));
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
            placeInfo.noticeStationed(c.scope(), site, r.number()); // for information: who is now here, and their main unit (ADR-042)
        });
    }

    /** The deployment areas of a request for one unit, on that unit's stationing record (ADR-045): another unit's stay as they are. */
    private void insertAreas(Req r, UUID unit, UUID stationing, UUID site, Instant from) {
        for (String role : List.of("PRIMARY", "ALTERNATIVE")) {
            Map<String, Object> area = "PRIMARY".equals(role) ? r.content().primary() : r.content().alternative();
            if (area != null) {
                jdbc.sql("""
                        insert into deployment_area(id, request_id, site_id, role, geom, state, valid_from, organization_id, stationing_id)
                        values (:id, :req, :site, :role, ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326), 'ACTIVE', :from, :org, :st)""")
                        .param("id", UUID.randomUUID()).param("req", r.id()).param("site", site).param("role", role)
                        .param("g", json.write(area)).param("from", Db.ts(from)).param("org", unit).param("st", stationing).update();
            }
        }
    }

    /** A permanent move leaves the unit's areas behind with the site: they retire with the record they belong to. */
    private void retireUnitAreas(UUID unit, Instant now) {
        jdbc.sql("""
                update deployment_area a set state = 'RETIRED', valid_to = greatest(:now, a.valid_from)
                  from org_stationing s
                 where s.id = a.stationing_id and a.organization_id = :org and a.state = 'ACTIVE' and s.kind = 'PERMANENT'""")
                .param("now", Db.ts(now)).param("org", unit).update();
    }

    /** Whether the policy version this request is pinned to wants FYI units chosen before activation, and they were not. */
    boolean fyiPending(Req r) {
        if (r.policyVersion() == null || !"APPROVED_NOT_ACTIVATED".equals(r.state()) || r.extension()) {
            return false;
        }
        StationingRoutes.RouteRule path = pathOf(r);
        var stages = path != null ? path.stages() : policies.byVersion(r.policyVersion()).map(v -> v.values().approvalStages()).orElse(null);
        if (stages == null || !stages.fyiBeforeActivation()) {
            return false;
        }
        return jdbc.sql("select count(*) from restationing_request where id = :id and fyi_done_at is null").param("id", r.id()).query(Long.class).single() > 0;
    }

    /**
     * Activation of the other purposes (ADR-045). Whatever was approved is checked against the register again now: a unit
     * that was stationed meanwhile, or a site registered meanwhile, refuses rather than overwrites. Nothing in Oracle's
     * hierarchy changes, no unit moves unless it was named, and a site link never becomes stationing.
     */
    private void activatePurpose(AccessContext ctx, Req r, ReasonInput in, Instant now) {
        RestationingContent c = r.content();
        UUID id = r.id();
        String ref = "restationing:" + r.number();
        String sourceVersion = "policy-" + r.policyVersion() + "/rev-" + revisions(id);
        UUID site;
        String action;
        Map<String, Object> detail = new LinkedHashMap<>();
        for (Map<String, Object> area : areas(c)) {
            List<String> taken = checks.occupiedIntersecting(json.write(area), c.scope(), now);
            if (!taken.isEmpty()) {
                throw ApiException.validation("تغيّر إشغال الأرض منذ الاعتماد: " + String.join("، ", taken) + " — لا يُفعّل الطلب.");
            }
        }
        switch (r.purpose()) {
            case RestationingChecks.INITIAL_STATIONING -> {
                if (!checks.currentSites(c.scope(), now).isEmpty()) {
                    throw ApiException.validation("صار لإحدى الوحدات تمركز حالي منذ الاعتماد؛ لا يُفعّل الطلب.");
                }
                site = c.existingSite();
                if (checks.siteGeoJson(site) == null) {
                    throw ApiException.validation("لم يعد الموقع المختار نشطاً؛ لا يُفعّل الطلب.");
                }
                for (UUID unit : c.scope()) {
                    UUID record = UUID.randomUUID();
                    jdbc.sql("""
                            insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, request_id, reason,
                                                       reference, recorded_by, recorded_at)
                            values (:id, :org, :site, 'PERMANENT', :now, 'REQUEST', :req, :reason, :ref, :by, :now)""")
                            .param("id", record).param("org", unit).param("site", site).param("now", Db.ts(now))
                            .param("req", id).param("reason", c.reason().trim()).param("ref", r.number()).param("by", ctx.personId()).update();
                    outbox.enqueue(StationingEvent.Type.STATIONING_ACTIVATED, unit, site, now, now, sourceVersion, ref);
                    insertAreas(r, unit, record, site, now);
                }
                placeInfo.noticeStationed(c.scope(), site, r.number());
                action = "INITIAL_STATIONING_ACTIVATED";
            }
            case RestationingChecks.DEPLOYMENT_AREAS -> {
                UUID unit = c.scope().get(0);
                UUID record = checks.effectiveStationing(unit, now);
                site = record == null ? null : checks.currentSites(List.of(unit), now).get(unit);
                if (record == null) {
                    throw ApiException.validation("لم يعد للوحدة تمركز حالي؛ لا يُفعّل الطلب.");
                }
                if (checks.activeAreas(unit, now) > 0) {
                    throw ApiException.validation("صارت للوحدة مناطق انتشار نافذة منذ الاعتماد؛ لا يُفعّل الطلب.");
                }
                insertAreas(r, unit, record, site, now);
                detail.put("unit", unit.toString());
                detail.put("stationing", record.toString());
                action = "DEPLOYMENT_AREAS_ACTIVATED";
            }
            case RestationingChecks.SITE_REGISTRATION -> {
                String geo = json.write(c.site().geometry());
                List<String> duplicates = checks.overlappingSites(geo, c.siteInfo().parentId());
                if (!duplicates.isEmpty()) {
                    throw ApiException.validation("سُجل موقع يتداخل معه منذ الاعتماد: " + String.join("، ", duplicates) + " — لا يُسجَّل مرة أخرى.");
                }
                site = registerSite(ctx, r, geo, now);
                action = "SITE_REGISTERED";
            }
            default -> throw ApiException.validation("نوع طلب غير معروف.");
        }
        jdbc.sql("""
                update restationing_request set state = 'ACTIVATED_PERMANENT', activated_by = :by, activated_at = :now, site_id = :site, updated_at = :now,
                       version = version + 1 where id = :id""")
                .param("by", ctx.personId()).param("now", Db.ts(now)).param("site", site).param("id", id).update();
        detail.put("purpose", r.purpose());
        detail.put("siteId", site.toString());
        detail.put("units", c.scope().size());
        audit.recordAs(ctx.actor(), action, "RESTATIONING_REQUEST", id.toString(), r.number(), detail, in == null ? null : in.reason());
    }

    // ---- FYI distribution -------------------------------------------------------------------------------------

    /** The units this holder may inform: what their right reaches, never the whole organisation by default. */
    public List<Map<String, Object>> fyiOptions(AccessContext ctx, UUID id) {
        Req r = load(id).orElseThrow(ApiException::notFound);
        requireVisible(ctx, r);
        if (!ctx.canFor(Permission.MANAGE_FYI_DISTRIBUTION, r.unit())) {
            throw ApiException.forbidden("تحديد وحدات العلم يحتاج صلاحيته للوحدة الطالبة.");
        }
        return unitTree(reach(ctx, Permission.MANAGE_FYI_DISTRIBUTION));
    }

    /**
     * «تحديد وحدات العلم» after final approval. Not a vote: it opens this one request, read-only, to the people of the chosen
     * units and tells them so. It writes no grant, and nobody gains a lasting right from it.
     */
    public void distributeFyi(AccessContext ctx, UUID id, FyiInput in, Instant now) {
        tx.executeWithoutResult(s -> {
            Req r = lock(id);
            requireVisible(ctx, r);
            if (!ctx.canFor(Permission.MANAGE_FYI_DISTRIBUTION, r.unit())) {
                throw ApiException.forbidden("تحديد وحدات العلم يحتاج صلاحيته للوحدة الطالبة.");
            }
            if (!Set.of("APPROVED_NOT_ACTIVATED", "ACTIVATED_PERMANENT", "TEMPORARY_SCHEDULED", "ACTIVE_TEMPORARY").contains(r.state())) {
                throw ApiException.validation("تُحدد وحدات العلم بعد الاعتماد النهائي.");
            }
            List<UUID> units = in == null || in.units() == null ? List.of() : in.units().stream().distinct().toList();
            Set<UUID> allowed = reach(ctx, Permission.MANAGE_FYI_DISTRIBUTION);
            if (!allowed.containsAll(units)) {
                throw ApiException.forbidden("وحدة خارج نطاق صلاحيتك في توزيع العلم.");
            }
            for (UUID unit : units) {
                jdbc.sql("""
                        insert into restationing_fyi(request_id, organization_id, selected_by, selected_at)
                        values (:r, :o, :by, :now)
                        on conflict (request_id, organization_id) do update
                           set selected_by = :by, selected_at = :now, ended_at = null, ended_by = null, end_reason = null
                         where restationing_fyi.ended_at is not null""")
                        .param("r", id).param("o", unit).param("by", ctx.personId()).param("now", Db.ts(now)).update();
            }
            String note = in == null || in.note() == null ? null : in.note().trim();
            jdbc.sql("update restationing_request set fyi_done_at = :now, fyi_done_by = :by, fyi_note = :note, updated_at = :now, version = version + 1 where id = :id")
                    .param("now", Db.ts(now)).param("by", ctx.personId()).param("note", note).param("id", id).update();
            List<UUID> recipients = new ArrayList<>();
            if (!units.isEmpty()) {
                recipients = jdbc.sql("""
                        select distinct a.person_id from (select person_id, organization_id from affiliation where valid_to is null union select person_id, organization_id from unit_member where ended_at is null) a where a.organization_id = any(string_to_array(:u, ',')::uuid[])""")
                        .param("u", Db.ids(units)).query(UUID.class).list();
                for (UUID person : recipients) {
                    jdbc.sql("""
                            insert into notification(id, person_id, kind, title, body, created_at)
                            values (:id, :p, 'INFO_COPY', :t, :b, :now)""")
                            .param("id", UUID.randomUUID()).param("p", person).param("t", "للعلم: الطلب " + r.number())
                            .param("b", "#restationing/" + id + (note == null || note.isBlank() ? "" : " — " + note)).param("now", Db.ts(now)).update();
                }
            }
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("units", units.stream().map(UUID::toString).toList());
            detail.put("recipients", recipients.stream().map(UUID::toString).toList());
            detail.put("access", "قراءة هذا الطلب فقط");
            detail.put("purpose", r.purpose());
            audit.recordAs(ctx.actor(), "RESTATIONING_FYI_DISTRIBUTED", "RESTATIONING_REQUEST", id.toString(), r.number(), detail, note);
        });
    }

    /**
     * Ends one unit's read access to this one request, with a reason (ADR-045). The record stays, and choosing the unit again
     * opens it again. Nothing else the people of that unit hold changes.
     */
    public void endFyi(AccessContext ctx, UUID id, UUID unit, ReasonInput in, Instant now) {
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 5) {
            throw ApiException.validation("اكتب سبب إنهاء الاطلاع (5 أحرف على الأقل).");
        }
        tx.executeWithoutResult(s -> {
            Req r = lock(id);
            requireVisible(ctx, r);
            if (!ctx.canFor(Permission.MANAGE_FYI_DISTRIBUTION, r.unit()) || !reach(ctx, Permission.MANAGE_FYI_DISTRIBUTION).contains(unit)) {
                throw ApiException.forbidden("إنهاء الاطلاع يحتاج صلاحية توزيع العلم لهذه الوحدة.");
            }
            int n = jdbc.sql("""
                    update restationing_fyi set ended_at = :now, ended_by = :by, end_reason = :why
                     where request_id = :r and organization_id = :o and ended_at is null""")
                    .param("now", Db.ts(now)).param("by", ctx.personId()).param("why", reason).param("r", id).param("o", unit).update();
            if (n == 0) {
                throw ApiException.notFound();
            }
            List<String> recipients = jdbc.sql("select distinct a.person_id::text from (select person_id, organization_id from affiliation where valid_to is null union select person_id, organization_id from unit_member where ended_at is null) a where a.organization_id = :o")
                    .param("o", unit).query(String.class).list();
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("unit", unit.toString());
            detail.put("recipients", recipients);
            audit.recordAs(ctx.actor(), "RESTATIONING_FYI_ACCESS_ENDED", "RESTATIONING_REQUEST", id.toString(), r.number(), detail, reason);
        });
    }

    /**
     * Whether this person may read this one request because the unit they belong to now was chosen for information (ADR-045).
     * Only that unit: no parent, child or sibling inherits it. It ends when a holder ends it, when the person leaves the unit in
     * HR, and when the request is cancelled before activation or lapses, because nothing is left to be informed of.
     */
    boolean fyiReader(AccessContext ctx, UUID request) {
        return ctx.remember("restationing-fyi:" + request, () -> jdbc.sql("""
                select count(*) from restationing_fyi f join restationing_request q on q.id = f.request_id
                 where f.request_id = :r and f.ended_at is null and q.state not in ('CANCELLED_BEFORE_ACTIVATION', 'LAPSED_NOT_ACTIVATED')
                   and f.organization_id in (select a.organization_id from affiliation a where a.person_id = :p and a.valid_to is null
                       union select um.organization_id from unit_member um where um.person_id = :p and um.ended_at is null)""")
                .param("r", request).param("p", ctx.personId()).query(Long.class).single() > 0);
    }

    /** D1/D10: neither the requester nor the final approver activates, and the activator's right covers every unit. */
    private void requireActivator(AccessContext ctx, Req r, Permission p, String missing) {
        Set<UUID> actor = humans(ctx.personId());
        Set<UUID> requester = requesters(r);
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
     * is edited. Activated apart, with the activation right (ACTIVATE_STATIONING, ADR-078), never by the extension's requester or
     * final approver.
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
            requireActivator(ctx, e, Permission.ACTIVATE_STATIONING, "تفعيل التمديد يحتاج صلاحية «تفعيل التمركز» على كل الوحدات.");
            String ref = "restationing:" + e.number();
            List<Map<String, Object>> open = jdbc.sql("""
                    update org_stationing set valid_to = planned_end, end_reason = 'SUPERSEDED', ended_by = :by, ended_at = :now
                     where request_id = any(string_to_array(:chain, ',')::uuid[]) and kind = 'TEMPORARY' and valid_to is null
                    returning id, organization_id, site_id, base_id, planned_end""")
                    .param("by", ctx.personId()).param("now", Db.ts(now)).param("chain", Db.ids(chain(parent.id()))).query().listOfRows();
            for (Map<String, Object> o : open) {
                Instant from = Db.toInstant(o.get("planned_end"));
                UUID following = UUID.randomUUID();
                jdbc.sql("""
                        insert into org_stationing(id, organization_id, site_id, kind, base_id, valid_from, planned_end, origin,
                                                   request_id, reason, reference, recorded_by, recorded_at)
                        values (:id, :org, :site, 'TEMPORARY', :base, :from, :end, 'REQUEST', :req, :reason, :ref, :by, :now)""")
                        .param("id", following).param("org", o.get("organization_id")).param("site", o.get("site_id"))
                        .param("base", o.get("base_id")).param("from", Db.ts(from)).param("end", Db.ts(e.content().end()))
                        .param("req", e.id()).param("reason", e.content().reason().trim()).param("ref", e.number())
                        .param("by", ctx.personId()).param("now", Db.ts(now)).update();
                // the unit's deployment areas follow its stationing into the following period
                jdbc.sql("update deployment_area set stationing_id = :next where stationing_id = :prev").param("next", following).param("prev", o.get("id")).update();
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
        StationingRoutes.RouteRule path = pathOf(r);
        Result res = path != null ? checks.evaluateExtension(r.unit(), r.content(), effectiveEnd(parent.id()), policy, now, path)
                : checks.evaluateExtension(r.unit(), r.content(), effectiveEnd(parent.id()), policy, now);
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

    /**
     * The proposed site registered as a TMRKZ site with its boundary as version 1 (no responsibility, no links). A site
     * asked for by «طلب اعتماد موقع» carries its own fields, the approved unit's administrative context and one link; a
     * point is its marker, with no boundary version.
     */
    private UUID registerSite(AccessContext ctx, Req r, String geo, Instant now) {
        RestationingContent.SiteInfo info = r.content().siteInfo();
        boolean point = "Point".equals(r.content().site().geometry().get("type"));
        UUID site = UUID.randomUUID();
        Map<String, Object> centre = jdbc.sql("select ST_Y(c) as lat, ST_X(c) as lng from (select ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326)) as c) x")
                .param("g", geo).query().singleRow();
        boolean named = info != null;
        jdbc.sql("""
                insert into site(id, code, name, kind, parent_id, capacity, lat, lng, created_at, geometry_version, notes)
                values (:id, :code, :name, :kind, :parent, null, :lat, :lng, :now, :gv, :notes)""")
                .param("id", site).param("code", named ? info.code().trim() : r.number()).param("name", named ? info.name().trim() : "موقع " + r.number())
                .param("kind", named ? info.kind().trim() : "موقع تمركز").param("parent", named ? info.parentId() : null)
                .param("lat", centre.get("lat")).param("lng", centre.get("lng")).param("now", Db.ts(now))
                .param("gv", point ? null : (Object) 1).param("notes", named ? info.notes() : null).update();
        if (named) {
            jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, :now)")
                    .param("id", UUID.randomUUID()).param("s", site).param("o", r.unit()).param("now", Db.ts(now)).update();
            jdbc.sql("""
                    insert into site_link(id, site_id, organization_id, valid_from, source, reason, created_by, created_at)
                    values (:id, :s, :o, :now, 'REQUEST', :why, :by, :now)""")
                    .param("id", UUID.randomUUID()).param("s", site).param("o", r.unit()).param("now", Db.ts(now))
                    .param("why", "طلب اعتماد موقع " + r.number()).param("by", ctx.personId()).update();
        }
        if (point) {
            return site;
        }
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, original_format,
                                                  reason, created_by)
                values (:id, :s, 1, cast(:g as jsonb), 'EPSG:4326', :src, :now, ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326), :type,
                        'RESTATIONING', :why, :by)""")
                .param("id", UUID.randomUUID()).param("s", site).param("g", geo).param("type", String.valueOf(r.content().site().geometry().get("type")))
                .param("src", (named ? "طلب اعتماد موقع " : "طلب إعادة تمركز ") + r.number())
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
        return unitTree(reach(ctx, Permission.CREATE_RESTATIONING));
    }

    /** The units a right reaches through the actor's grants, each confirmed like every other check. */
    public Set<UUID> reach(AccessContext ctx, Permission permission) {
        if (ctx.canEverywhere(permission)) {
            // a grant over everything, confirmed once, reaches every unit: no per-unit confirmation over the whole tree
            // (a system administrator's «طلب إعادة التمركز», ADR-073)
            return new HashSet<>(jdbc.sql("select id from organization").query(UUID.class).list());
        }
        Set<UUID> ids = new HashSet<>();
        for (Grant g : ctx.grants()) {
            if (!g.has(permission)) {
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
        ids.removeIf(u -> !ctx.canFor(permission, u));
        return ids;
    }

    /** Units as a depth-ordered tree. */
    public List<Map<String, Object>> unitTree(Set<UUID> ids) {
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
            m.put("purpose", r.purpose());
            m.put("requestingUnit", ref(r.unit()));
            m.put("requester", person(r.requester()));
            m.put("units", r.content().scope().size());
            m.put("updatedAt", r.updatedAt().toString());
            List<StageRow> route = stages(id, r.routeNo());
            route.stream().filter(x -> !x.marked()).findFirst().ifPresent(x -> {
                m.put("currentStage", x.label());
                m.put("currentStageKind", x.kind());
                m.put("currentStageUnit", x.unit() == null ? null : ref(x.unit()).get("name"));
                m.put("myTurn", "UNDER_REVIEW".equals(r.state()) && mayDecide(ctx, r, x, route));
            });
            m.put("mine", r.requester().equals(ctx.personId()));
            m.put("fyi", fyiReader(ctx, r.id()));
            m.put("fyiPending", fyiPending(r) && ctx.canFor(Permission.MANAGE_FYI_DISTRIBUTION, r.unit()));
            m.put("activatable", "APPROVED_NOT_ACTIVATED".equals(r.state()) && !fyiPending(r) && mayActivate(ctx, r));
            m.put("exceedsPolicy", !exceeds(r).isEmpty());
            out.add(m);
        }
        return out;
    }

    /**
     * The two approval stamps of a request, as TNQL's «ختم عمليات الوحدة» and «ختم الاعتماد النهائي» (owner, 11 Nov 2026;
     * ADR-055): for each of the stages UNIT_OPERATIONS and FINAL of the current route that was approved, who approved it, in
     * which capacity and unit (as recorded at that moment in the audit), and when. Visual only: no signature, never the
     * certificate seal of ADR-020. Null for a stage not approved (yet). The person sees them only on a request they may see.
     */
    public Map<String, Object> stamps(AccessContext ctx, UUID id) {
        Req r = load(id).orElseThrow(ApiException::notFound);
        requireVisible(ctx, r);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("number", r.number());
        out.put("state", r.state());
        out.put("requestingUnit", jdbc.sql("select name from organization where id = :o").param("o", r.unit()).query(String.class).optional().orElse(null));
        // the main unit: the requesting unit's ancestor right under the root (itself when it is one)
        out.put("mainUnit", jdbc.sql("""
                with recursive up(id, parent_id, name, depth) as (
                  select id, parent_id, name, 0 from organization where id = :o
                  union all select o.id, o.parent_id, o.name, up.depth + 1 from organization o join up on o.id = up.parent_id)
                select name from up where parent_id is null or parent_id in (select id from organization where parent_id is null)
                order by depth limit 1""").param("o", r.unit()).query(String.class).optional().orElse(null));
        for (String kind : List.of("UNIT_OPERATIONS", "FINAL")) {
            Map<String, Object> s = jdbc.sql("""
                    select st.stage_key, st.decided_by, st.decided_at, st.via_delegation, p.display_name,
                           (select a.position_title from affiliation a where a.person_id = st.decided_by and a.valid_to is null
                             order by a.valid_from desc limit 1) as position_title
                    from restationing_stage st join person p on p.id = st.decided_by
                    where st.request_id = :id and st.route_no = :route and st.kind = :k and st.mark = 'APPROVED'
                    order by st.decided_at desc limit 1""")
                    .param("id", id).param("route", r.routeNo()).param("k", kind).query().listOfRows().stream().findFirst().orElse(null);
            if (s == null) {
                out.put(kind.equals("FINAL") ? "final" : "unitOperations", null);
                continue;
            }
            Map<String, Object> audit = jdbc.sql("""
                    select actor_name, actor_role, actor_org from audit_event
                    where action = 'RESTATIONING_STAGE_APPROVED' and entity_id = :id and detail->>'stage' = :stage
                    order by id desc limit 1""")
                    .param("id", id.toString()).param("stage", s.get("stage_key")).query().listOfRows().stream().findFirst().orElse(Map.of());
            Map<String, Object> stamp = new LinkedHashMap<>();
            stamp.put("name", audit.get("actor_name") != null ? audit.get("actor_name") : s.get("display_name"));
            stamp.put("position", s.get("position_title"));
            stamp.put("role", audit.get("actor_role"));
            stamp.put("unit", audit.get("actor_org"));
            stamp.put("at", ((java.sql.Timestamp) s.get("decided_at")).toInstant().toString());
            stamp.put("onBehalf", s.get("via_delegation") != null);
            out.put(kind.equals("FINAL") ? "final" : "unitOperations", stamp);
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
        m.put("purpose", r.purpose());
        m.put("requestingUnit", ref(r.unit()));
        m.put("requester", person(r.requester()));
        m.put("content", r.content().stored());
        if (r.content().existingSite() != null) {
            Map<String, Object> target = new LinkedHashMap<>(siteRef(r.content().existingSite()));
            String geo = checks.siteGeoJson(r.content().existingSite());
            target.put("geometry", geo == null ? null : json.map(geo));
            m.put("targetSite", target);
        }
        m.put("units", units(r.content().scope()));
        m.put("currentSites", sites(checks.currentSites(r.content().scope(), now)));
        m.put("policyVersion", r.policyVersion());
        m.put("routeNo", r.routeNo());
        List<StageRow> route = stages(id, r.routeNo());
        StageRow current = "UNDER_REVIEW".equals(r.state()) ? route.stream().filter(x -> !x.marked()).findFirst().orElse(null) : null;
        m.put("route", route.stream().map(x -> stageView(x, current)).toList());
        // «الاعتماد الجزئي» (ADR-090): each part, what the current stage decided on it, and the latest decision of any stage
        m.put("parts", partReviews.view(r.id(), r.purpose(), r.content(), current == null ? null : current.key()));
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
        // beyond the policy's range: shown on every stage; the final approver decides it with the request (ADR-078)
        m.put("exceedsPolicy", exceeds(r));
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
        // the request belongs to the requesting unit: whoever may make this request for it edits and sends it (owner, 16 Nov 2026)
        boolean owner = ctx.canFor(createPermission(r.purpose()), r.unit());
        boolean askable = !RestationingChecks.INITIAL_STATIONING.equals(r.purpose());
        can.put("edit", owner && askable && EDITABLE.contains(r.state()));
        can.put("submit", owner && askable && EDITABLE.contains(r.state()));
        can.put("decide", current != null && mayDecide(ctx, r, current, route));
        can.put("decideAs", current == null ? null : decisionLabel(current));
        can.put("activate", "APPROVED_NOT_ACTIVATED".equals(r.state()) && !fyiPending(r) && mayActivate(ctx, r));
        can.put("fyi", Set.of("APPROVED_NOT_ACTIVATED", "ACTIVATED_PERMANENT", "TEMPORARY_SCHEDULED", "ACTIVE_TEMPORARY").contains(r.state())
                && ctx.canFor(Permission.MANAGE_FYI_DISTRIBUTION, r.unit()));
        m.put("can", can);
        Map<String, Object> fyi = new LinkedHashMap<>();
        Map<String, Object> done = jdbc.sql("""
                select q.fyi_done_at, p.display_name, q.fyi_note from restationing_request q left join person p on p.id = q.fyi_done_by where q.id = :id""")
                .param("id", id).query().singleRow();
        fyi.put("required", fyiPending(r));
        fyi.put("doneAt", done.get("fyi_done_at") == null ? null : Db.toInstant(done.get("fyi_done_at")).toString());
        fyi.put("doneBy", done.get("display_name"));
        fyi.put("note", done.get("fyi_note"));
        fyi.put("units", jdbc.sql("select o.name from restationing_fyi f join organization o on o.id = f.organization_id where f.request_id = :id and f.ended_at is null order by o.name")
                .param("id", id).query(String.class).list());
        fyi.put("active", jdbc.sql("select f.organization_id::text as id, o.name from restationing_fyi f join organization o on o.id = f.organization_id where f.request_id = :id and f.ended_at is null order by o.name")
                .param("id", id).query().listOfRows());
        m.put("fyi", fyi);
        // read only by a chosen unit: no other right reaches this person's page, and the page says so
        m.put("readOnlyFyi", fyiReader(ctx, r.id()) && !owner && !mayAct(ctx, r));
        return m;
    }

    /** Whether any right other than a chosen unit's reading reaches this request. */
    private boolean mayAct(AccessContext ctx, Req r) {
        return ctx.canFor(Permission.VIEW, r.unit()) || ctx.canFor(Permission.MANAGE_FYI_DISTRIBUTION, r.unit())
                || ctx.canFor(Permission.DECIDE_UNIT_OPERATIONS, r.unit()) || ctx.canFor(Permission.FINAL_APPROVE_STATIONING, r.unit());
    }

    /** The words on the button of a stage (as in the movement programme): each stage says what it decides. */
    private static String decisionLabel(StageRow stage) {
        return switch (stage.kind()) {
            case "UNIT_OPERATIONS" -> "اعتماد عمليات الوحدة";
            case "FINAL" -> "اعتماد نهائي";
            case "EXCEPTION" -> "اعتماد الاستثناء";
            default -> stage.finalStage() ? "اعتماد نهائي" : "اعتماد";
        };
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
        if (intersects(actor, requesters(r)) || r.finalApprover() != null && intersects(actor, humans(r.finalApprover()))) {
            return false;
        }
        return r.content().scope().stream().allMatch(u -> ctx.canFor(Permission.ACTIVATE_STATIONING, u));
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
        if (SKIPPED.equals(x.mark())) {
            s.put("skipReasonCode", NO_HIERARCHY_APPROVER);
            s.put("skipReason", "لا يوجد معتمد للسلسلة الهرمية");
        }
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
        // the final approver of the requesting unit also decides its excess and its lifecycle actions (ADR-078)
        if (ctx.canFor(Permission.VIEW, r.unit()) || ctx.canFor(Permission.CREATE_RESTATIONING, r.unit())
                || ctx.canFor(createPermission(r.purpose()), r.unit())
                || ctx.canFor(Permission.DECIDE_UNIT_OPERATIONS, r.unit()) || ctx.canFor(Permission.FINAL_APPROVE_STATIONING, r.unit())
                || ctx.canFor(Permission.MANAGE_FYI_DISTRIBUTION, r.unit())) {
            return true;
        }
        if (fyiReader(ctx, r.id())) {
            return true;
        }
        for (UUID u : r.content().scope()) {
            if (ctx.canFor(Permission.VIEW, u) || ctx.canFor(Permission.ACTIVATE_STATIONING, u)) {
                return true;
            }
        }
        for (StageRow s : stages(r.id(), r.routeNo())) {
            Optional<Permission> sp = Permission.parse(s.permission());
            if (s.unit() != null && sp.isPresent() && ctx.grants().stream().anyMatch(g -> g.has(sp.get()) && !g.isAll() && s.unit().equals(g.orgId()))) {
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

    /**
     * The request belongs to the requesting unit, not to the person who started it (owner, 16 Nov 2026): anyone who holds this
     * request's right for that unit edits and sends it — the one who started it is kept for the history; one who no longer holds
     * the right no longer edits it.
     */
    private void requireOwnerEditable(AccessContext ctx, Req r) {
        if (!ctx.canFor(createPermission(r.purpose()), r.unit())) {
            throw ApiException.forbidden("يحتاج صلاحية هذا الطلب للوحدة الطالبة.");
        }
        if (RestationingChecks.INITIAL_STATIONING.equals(r.purpose())) {
            // an old initial-stationing request is neither edited nor sent again; it may still be cancelled (ADR-078)
            throw ApiException.validation(INITIAL_IN_SETUP);
        }
        if (!EDITABLE.contains(r.state())) {
            throw ApiException.validation("لا يُعدّل الطلب في حالته الحالية؛ الحركة اللاحقة تحتاج طلباً جديداً.");
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
                       kind, parent_request_id, purpose, route_version_id
                  from restationing_request where id = :id""")
                .param("id", id).query((rs, n) -> new Req(Db.uuid(rs, "id"), rs.getString("number"), Db.uuid(rs, "requester_id"),
                        Db.uuid(rs, "requesting_unit_id"), rs.getString("state"),
                        RestationingContent.fromStored(json.map(rs.getString("content"))), (Integer) rs.getObject("policy_version"),
                        rs.getInt("route_no"), uuids(rs.getString("path")), snapshotOf(rs.getString("snap")),
                        rs.getString("ret") == null ? null : json.map(rs.getString("ret")),
                        rs.getString("paused") == null ? null : json.map(rs.getString("paused")),
                        Db.uuid(rs, "final_approver_id"), Db.uuid(rs, "activated_by"), Db.instant(rs, "activated_at"), Db.uuid(rs, "site_id"),
                        Db.instant(rs, "created_at"), Db.instant(rs, "updated_at"), rs.getString("kind"), Db.uuid(rs, "parent_request_id"), rs.getString("purpose"), Db.uuid(rs, "route_version_id")))
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
        String perm = switch (s.kind()) {
            case UNIT_OPERATIONS -> Permission.DECIDE_UNIT_OPERATIONS.name();
            case FINAL -> Permission.FINAL_APPROVE_STATIONING.name();
            // a level of the climb, or a unit added from another branch: its hierarchy approver (ADR-063), never APPROVE alone
            default -> Permission.APPROVE_HIERARCHY.name();
        };
        return new StageRow(null, routeNo, position, s.key(), s.kind().name(), s.unit(), perm, s.label(), sat, s.dependsOn(),
                s.finalStage(), s.independentOf(), mark, by, via, at);
    }

    /**
     * The hierarchy stages this submission skipped, kept per revision with the unit's name and level as they are now (ADR-062):
     * the history never depends on today's hierarchy, and one grouped audit event says what was passed and why.
     */
    private void recordSkipped(UUID id, String number, int revision, int routeNo, int policyVersion, UUID requestUnit,
                               List<StageRow> skipped, Instant now) {
        if (skipped.isEmpty()) {
            return;
        }
        List<OrgUnit> path = hierarchy.path(requestUnit);
        List<Map<String, Object>> units = new ArrayList<>();
        for (StageRow st : skipped) {
            OrgUnit u = path.stream().filter(x -> x.id().equals(st.unit())).findFirst().orElse(null);
            int order = u == null ? st.position() + 1 : path.indexOf(u);
            String name = u != null ? u.name() : jdbc.sql("select name from organization where id = :o").param("o", st.unit()).query(String.class).single();
            jdbc.sql("""
                    insert into restationing_route_skip(request_id, revision, route_no, stage_key, organization_id, organization_name,
                                                        organization_level, hierarchy_order, reason_code, reason_text, policy_version, created_at)
                    values (:r, :n, :route, :k, :o, :name, :lvl, :ord, :code, :text, :pv, :now) on conflict do nothing""")
                    .param("r", id).param("n", revision).param("route", routeNo).param("k", st.key()).param("o", st.unit())
                    .param("name", name).param("lvl", u == null ? null : u.level()).param("ord", order).param("code", NO_HIERARCHY_APPROVER)
                    .param("text", NO_HIERARCHY_APPROVER_TEXT).param("pv", policyVersion).param("now", Db.ts(now)).update();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("organizationId", st.unit().toString());
            m.put("organizationName", name);
            m.put("level", u == null ? null : u.level());
            m.put("order", order);
            m.put("reasonCode", NO_HIERARCHY_APPROVER);
            units.add(m);
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("revision", revision);
        detail.put("route", routeNo);
        detail.put("policyVersion", policyVersion);
        detail.put("units", units);
        audit.record(null, ae.mover.audit.AuditService.Capacity.NONE, "HIERARCHY_LEVEL_SKIPPED", "RESTATIONING_REQUEST", id.toString(),
                number, detail, NO_HIERARCHY_APPROVER_TEXT, revision);
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

    /**
     * The deployment legs a request asks beyond the policy's range (within the exception margin), as checked when it was last
     * sent: leg, label, distance, the allowed maximum, the excess and the written reason. Empty for a draft and for a request
     * within the range. Shown on every stage; the final approver decides it with the request (owner, 17 Nov 2026; ADR-078).
     */
    List<Map<String, Object>> exceeds(Req r) {
        String checksText = jdbc.sql("select checks::text from restationing_revision where request_id = :id order by n desc limit 1")
                .param("id", r.id()).query(String.class).optional().orElse(null);
        return checksText == null ? List.of() : exceeds(json.map(checksText), r.content());
    }

    private static List<Map<String, Object>> exceeds(Map<String, Object> checks, RestationingContent c) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (!(checks.get("legs") instanceof List<?> legs)) {
            return out;
        }
        for (Object o : legs) {
            if (!(o instanceof Map<?, ?> l) || !DeploymentRules.LegStatus.NEEDS_EXCEPTION.name().equals(l.get("status"))
                    || !(l.get("distanceM") instanceof Number d) || !(l.get("effectiveMaxM") instanceof Number max)) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            String leg = String.valueOf(l.get("leg"));
            m.put("leg", leg);
            m.put("label", l.get("label"));
            m.put("distanceM", Math.round(d.doubleValue()));
            m.put("allowedMaxM", Math.round(max.doubleValue()));
            m.put("excessM", Math.round(d.doubleValue() - max.doubleValue()));
            String why = c == null ? "" : c.exception(leg);
            m.put("reason", why.isEmpty() ? null : why);
            out.add(m);
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
        m.put("areaOverMax", res.areaOverMax());
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
                t.put("allowanceM", Math.max(0, l.check().effectiveMaxM() - l.check().baseMaxM()));
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

    /**
     * Everyone on the requesting side of a request: the person who started it and everyone who submitted a revision of it. The
     * request belongs to the requesting unit (owner, 16 Nov 2026), so any of its requesters may have edited and sent it; none of
     * them decides or activates it.
     */
    Set<UUID> requesters(Req r) {
        Set<UUID> out = new HashSet<>(humans(r.requester()));
        jdbc.sql("select distinct submitted_by from restationing_revision where request_id = :id and submitted_by is not null")
                .param("id", r.id()).query(UUID.class).list().forEach(p -> out.addAll(humans(p)));
        return out;
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
