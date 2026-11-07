package ae.mover.requests;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.flowable.engine.RuntimeService;
import org.flowable.engine.runtime.ProcessInstance;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import ae.mover.common.Json;
import ae.mover.forms.FormService;
import ae.mover.outbox.OutboxService;
import ae.mover.policy.PolicyService;
import ae.mover.requests.Commands.DecisionInput;
import ae.mover.workflow.TaskSync;
import ae.mover.workflow.WorkflowService;

/**
 * Asking for permissions (ADR-044, as in the movement programme). Any person who signs in may ask for themselves, and only for what
 * the system administrator shows to everyone; the unit's access manager may add what is kept for them. The request runs through the
 * chart drawn for its type: a reviewer advises, and only the final approval grants.
 * What was asked, advised and granted are kept apart. A person has one open request at a time.
 */
@Service
public class AccessRequestService {

    /** What can ever be offered: applies at the person's unit, and hands out no administration. A request never makes a system role. */
    private static final String OFFERABLE = "r.scope <> 'ALL' and not (r.permissions && cast(array['CONFIGURE','MANAGE_ACCESS'] as text[]))";
    private static final String EVERYONE = "EVERYONE";
    private static final String MANAGER = "MANAGER";

    /**
     * Where a permission reaches (ADR-045): UNIT «وحدتي فقط», UNIT_TREE «وحدتي والوحدات التابعة», UNITS «وحدات محددة», SITES
     * «مواقع محددة». ALL «النظام بالكامل» is never asked for: only a global access manager may give it at the final approval.
     */
    public record Scope(String mode, List<UUID> ids) {
    }

    public record NewRequest(List<String> roles, String reason, Scope scope) {
    }

    public record Decide(String taskId, String decision, List<String> roles, String note, Scope scope, Boolean recommendReject) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final FormService forms;
    private final WorkflowService workflows;
    private final PolicyService policies;
    private final RuntimeService runtime;
    private final TaskSync taskSync;
    private final AuditService audit;
    private final OutboxService outbox;
    private final DecisionService decisions;

    public AccessRequestService(JdbcClient jdbc, Json json, Clock clock, FormService forms, WorkflowService workflows, PolicyService policies,
                                RuntimeService runtime, TaskSync taskSync, AuditService audit, OutboxService outbox, DecisionService decisions) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.forms = forms;
        this.workflows = workflows;
        this.policies = policies;
        this.runtime = runtime;
        this.taskSync = taskSync;
        this.audit = audit;
        this.outbox = outbox;
        this.decisions = decisions;
    }

    private String accessType() {
        return jdbc.sql("select code from request_type where active and kind = 'ACCESS' order by sort_order limit 1").query(String.class).optional().orElse(null);
    }

    private UUID unitOf(UUID person) {
        return jdbc.sql("""
                select a.organization_id from affiliation a join organization o on o.id = a.organization_id and o.status = 'ACTIVE'
                where a.person_id = :p and a.valid_to is null order by a.valid_from desc limit 1""")
                .param("p", person).query(UUID.class).optional().orElse(null);
    }

    private String orgName(UUID id) {
        return id == null ? null : jdbc.sql("select name from organization where id = :id").param("id", id).query(String.class).optional().orElse(null);
    }

    private List<Map<String, String>> labelled(List<String> codes) {
        Map<String, String> names = new HashMap<>();
        if (!codes.isEmpty()) {
            jdbc.sql("select code, name from role_def where code = any(string_to_array(:c, ','))").param("c", String.join(",", codes))
                    .query((rs, n) -> names.put(rs.getString(1), rs.getString(2))).list();
        }
        return codes.stream().filter(names::containsKey).map(c -> Map.of("code", c, "name", names.get(c))).toList();
    }

    private List<String> offered(String audience) {
        return jdbc.sql("select r.code from access_request_offer o join role_def r on r.code = o.role_code where o.audience = :a and " + OFFERABLE + " order by r.sort_order, r.code")
                .param("a", audience).query(String.class).list();
    }

    /** The system administrator's list: every role that can be offered, and to whom it is now. */
    public List<Map<String, Object>> offer(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        List<Map<String, Object>> out = new ArrayList<>();
        jdbc.sql("select r.code, r.name, o.audience from role_def r left join access_request_offer o on o.role_code = r.code where " + OFFERABLE + " order by r.sort_order, r.code")
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("code", rs.getString("code"));
                    m.put("name", rs.getString("name"));
                    m.put("audience", rs.getString("audience"));
                    return m;
                }).list().forEach(out::add);
        return out;
    }

    /** Replaces the list. Applies to new requests; what a person already asked for stays on their request. */
    @Transactional
    public List<Map<String, Object>> saveOffer(AccessContext ctx, Map<String, String> audiences) {
        ctx.require(Permission.CONFIGURE);
        Map<String, String> in = audiences == null ? Map.of() : audiences;
        List<String> offerable = jdbc.sql("select r.code from role_def r where " + OFFERABLE).query(String.class).list();
        in.forEach((code, audience) -> {
            if (!offerable.contains(code)) {
                throw ApiException.validation("هذه الصلاحية لا تُعرض للطلب.");
            }
            if (!EVERYONE.equals(audience) && !MANAGER.equals(audience)) {
                throw ApiException.validation("اختر لمن تظهر الصلاحية.");
            }
        });
        if (!in.containsValue(EVERYONE)) {
            throw ApiException.validation("اختر صلاحية واحدة على الأقل تظهر لأي شخص جديد، وإلا فلن يستطيع أحد الطلب.");
        }
        jdbc.sql("delete from access_request_offer").update();
        in.forEach((code, audience) -> jdbc.sql("insert into access_request_offer(role_code, audience) values (:c, :a)")
                .param("c", code).param("a", audience).update());
        audit.recordAs(ctx.actor(), "ACCESS_OFFER_CHANGED", "ACCESS_OFFER", "offer", null, Map.of("audiences", in), null);
        return offer(ctx);
    }

    private static List<String> list(Object text) {
        return text == null || text.toString().isBlank() ? List.of() : List.of(text.toString().split(","));
    }

    /** The page of the person asking: their unit, what they may ask for, what they hold, and their requests. */
    public Map<String, Object> mine(AccessContext ctx) {
        UUID unit = unitOf(ctx.personId());
        String type = accessType();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("unit", orgName(unit));
        out.put("available", type != null && workflows.latestPublished(type) != null);
        out.put("requestable", labelled(offered(EVERYONE)));
        out.put("scopeUnits", unit == null ? List.of() : orgTree(unit));
        out.put("scopeSites", unit == null ? List.of() : linkedSites(unit));
        out.put("held", jdbc.sql("""
                select distinct role_code from membership where person_id = :p and valid_from <= now() and (valid_to is null or valid_to > now())""")
                .param("p", ctx.personId()).query(String.class).list());
        List<Map<String, Object>> requests = new ArrayList<>();
        for (Map<String, Object> r : jdbc.sql("""
                select r.id, r.number, r.status, r.last_note, r.submitted_at, a.reason, a.unit_org_id, o.name as unit, array_to_string(a.requested, ',') as requested,
                       array_to_string(a.granted, ',') as granted, array_to_string(a.recommended, ',') as recommended, a.recommend_reject,
                       a.requested_scope::text as requested_scope, a.granted_scope::text as granted_scope,
                       (select bool_or(t.final) from task_assignment t where t.request_id = r.id and t.status = 'OPEN') as at_final,
                       (select string_agg(t.stage_name, '، ') from task_assignment t where t.request_id = r.id and t.status = 'OPEN') as waiting
                from access_request a join request r on r.id = a.request_id join organization o on o.id = a.unit_org_id
                where a.person_id = :p order by r.submitted_at desc limit 50""").param("p", ctx.personId()).query().listOfRows()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.get("id").toString());
            m.put("number", r.get("number"));
            m.put("status", r.get("status"));
            m.put("note", r.get("last_note"));
            m.put("submittedAt", Db.toInstant(r.get("submitted_at")).toString());
            m.put("reason", r.get("reason"));
            m.put("unit", r.get("unit"));
            m.put("requested", labelled(list(r.get("requested"))));
            m.put("granted", labelled(list(r.get("granted"))));
            m.put("waiting", r.get("waiting"));
            m.put("recommended", labelled(list(r.get("recommended"))));
            m.put("scope", r.get("requested_scope") == null ? null : json.map(r.get("requested_scope").toString()));
            m.put("grantedScope", r.get("granted_scope") == null ? null : json.map(r.get("granted_scope").toString()));
            m.put("statusLabel", statusLabel(r, ctx.personId()));
            requests.add(m);
        }
        out.put("requests", requests);
        return out;
    }

    /** The state in the owner's words: where the request stands now, read from what the engine and the request hold. */
    private String statusLabel(Map<String, Object> r, UUID person) {
        return switch (String.valueOf(r.get("status"))) {
            case "APPROVED" -> "معتمد ومفعّل";
            case "REJECTED" -> "مرفوض";
            case "RETURNED" -> "أعيد للتعديل";
            default -> {
                UUID now = unitOf(person);
                if (now != null && !now.equals(r.get("unit_org_id"))) {
                    yield "قديم بسبب تغير بيانات الجهة";
                }
                if (!Boolean.TRUE.equals(r.get("at_final"))) {
                    yield "بانتظار التوصية";
                }
                yield Boolean.TRUE.equals(r.get("recommend_reject")) ? "موصى بالرفض — بانتظار الاعتماد النهائي"
                        : r.get("recommended") != null ? "موصى بالموافقة — بانتظار الاعتماد النهائي" : "بانتظار الاعتماد النهائي";
            }
        };
    }

    private List<Map<String, Object>> orgTree(UUID unit) {
        return jdbc.sql("""
                with recursive t(id, name, depth) as (
                  select id, name, 0 from organization where id = :u
                  union all select o.id, o.name, t.depth + 1 from organization o join t on o.parent_id = t.id where o.status = 'ACTIVE')
                select id, name, depth from t order by depth, name limit 200""").param("u", unit).query().listOfRows().stream().map(r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.get("id").toString());
            m.put("name", r.get("name"));
            m.put("depth", r.get("depth"));
            return m;
        }).toList();
    }

    private List<Map<String, Object>> linkedSites(UUID unit) {
        return jdbc.sql("""
                select s.id, s.name from site s join site_link l on l.site_id = s.id and l.valid_to is null
                 where l.organization_id = :u and s.status = 'ACTIVE' order by s.name""").param("u", unit).query().listOfRows().stream().map(r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.get("id").toString());
            m.put("name", r.get("name"));
            return m;
        }).toList();
    }

    /** A valid scope for this unit, or a refusal. No scope sent: the role's own default reach, as before. */
    private Scope checkScope(Scope scope, UUID unit, AccessContext ctx, boolean finalStage) {
        if (scope == null || scope.mode() == null || scope.mode().isBlank()) {
            return null;
        }
        List<UUID> ids = scope.ids() == null ? List.of() : scope.ids().stream().distinct().toList();
        switch (scope.mode()) {
            case "UNIT", "UNIT_TREE" -> {
                return new Scope(scope.mode(), List.of());
            }
            case "UNITS" -> {
                Set<String> tree = new HashSet<>(orgTree(unit).stream().map(m -> m.get("id").toString()).toList());
                if (ids.isEmpty() || !ids.stream().allMatch(i -> tree.contains(i.toString()))) {
                    throw ApiException.validation("اختر وحدات من وحدتك وما يتبعها.");
                }
                return new Scope("UNITS", ids);
            }
            case "SITES" -> {
                if (ids.isEmpty() || jdbc.sql("select count(*) from site where status = 'ACTIVE' and id = any(string_to_array(:i, ',')::uuid[])")
                        .param("i", ae.mover.common.Db.ids(ids)).query(Long.class).single() != ids.size()) {
                    throw ApiException.validation("اختر مواقع مسجلة.");
                }
                return new Scope("SITES", ids);
            }
            case "ALL" -> {
                if (!finalStage || !ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
                    throw ApiException.forbidden("النطاق الشامل يمنحه مدير صلاحيات عام عند الاعتماد النهائي فقط.");
                }
                return new Scope("ALL", List.of());
            }
            default -> throw ApiException.validation("نطاق غير معروف.");
        }
    }

    private Scope storedScope(Object text) {
        if (text == null) {
            return null;
        }
        Map<String, Object> m = json.map(text.toString());
        List<UUID> ids = new ArrayList<>();
        if (m.get("ids") instanceof List<?> l) {
            l.forEach(x -> ids.add(UUID.fromString(x.toString())));
        }
        return new Scope(String.valueOf(m.get("mode")), ids);
    }

    private String scopeJson(Scope s) {
        return s == null ? null : json.write(Map.of("mode", s.mode(), "ids", s.ids().stream().map(UUID::toString).toList()));
    }

    @Transactional
    public Map<String, Object> submit(AccessContext ctx, NewRequest in) {
        String type = accessType();
        WorkflowService.PublishedWorkflow wf = type == null ? null : workflows.latestPublished(type);
        if (wf == null) {
            throw new ApiException(ErrorCode.WORKFLOW_NOT_PUBLISHED, "لم يُفعَّل بعد مسار طلب الصلاحيات؛ راجع مدير النظام.");
        }
        UUID unit = unitOf(ctx.personId());
        if (unit == null) {
            throw ApiException.validation("لا توجد لك وحدة في سجل الموارد البشرية؛ راجع مدير النظام.");
        }
        List<String> roles = in == null || in.roles() == null ? List.of() : in.roles().stream().distinct().toList();
        if (roles.isEmpty() || !offered(EVERYONE).containsAll(roles)) {
            throw ApiException.validation("اختر صلاحية واحدة على الأقل من القائمة.");
        }
        String reason = in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 5) {
            throw ApiException.validation("اكتب سبب الطلب.");
        }
        if (jdbc.sql("select count(*) from access_request where person_id = :p and open").param("p", ctx.personId()).query(Long.class).single() > 0) {
            throw ApiException.validation("لديك طلب صلاحية قيد المراجعة؛ انتظر القرار فيه.");
        }
        Scope scope = checkScope(in.scope(), unit, ctx, false);
        UUID id = UUID.randomUUID();
        Instant now = clock.instant();
        long seq = jdbc.sql("select nextval('request_number_seq')").query(Long.class).single();
        String number = "MV-" + now.atZone(ZoneOffset.UTC).getYear() + "-" + String.format("%04d", seq);
        UUID form = forms.latestPublished(type).id();
        UUID policy = policies.current().id();
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("roles", roles);
        values.put("reason", reason);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("subject", "طلب صلاحيات");
        Map<String, Object> noPeriod = new LinkedHashMap<>();
        noPeriod.put("start", null);
        noPeriod.put("end", null);
        data.put("period", noPeriod);
        data.put("ownerOrgId", unit.toString());
        data.put("resourceIds", List.of());
        data.put("participantOrgIds", List.of());
        data.put("infoOrgIds", List.of());
        data.put("values", values);
        data.put("formVersionId", form.toString());
        data.put("workflowVersionId", wf.id().toString());
        jdbc.sql("""
                insert into request(id, number, type_code, status, origin, owner_org_id, created_by, created_at, updated_at, draft, form_version_id)
                values (:id, :num, :type, 'DRAFT', 'LIST', :owner, :by, :now, :now, cast(:d as jsonb), :form)""")
                .param("id", id).param("num", number).param("type", type).param("owner", unit).param("by", ctx.personId())
                .param("now", Db.ts(now)).param("d", json.write(Map.of("values", values))).param("form", form).update();
        jdbc.sql("""
                insert into request_revision(id, request_id, revision, data, form_version_id, workflow_version_id, policy_version_id,
                    submitted_by, submitted_at, content_sha256, carried_stages)
                values (:id, :req, 1, cast(:data as jsonb), :form, :wf, :pol, :by, :now, :sha, '{}')""")
                .param("id", UUID.randomUUID()).param("req", id).param("data", json.write(data)).param("form", form).param("wf", wf.id())
                .param("pol", policy).param("by", ctx.personId()).param("now", Db.ts(now)).param("sha", Hashing.sha256(json.canonical(data))).update();
        jdbc.sql("""
                insert into access_request(request_id, person_id, unit_org_id, requested, reason, requested_scope)
                values (:r, :p, :u, string_to_array(:roles, ','), :why, cast(:scope as jsonb))""")
                .param("r", id).param("p", ctx.personId()).param("u", unit).param("roles", String.join(",", roles)).param("why", reason)
                .param("scope", scopeJson(scope)).update();
        Map<String, Object> vars = new HashMap<>();
        vars.put("requestId", id.toString());
        vars.put("revision", 1);
        ProcessInstance pi = runtime.startProcessInstanceById(wf.processDefinitionId(), id.toString(), vars);
        jdbc.sql("""
                update request set status = 'SUBMITTED', submitted_at = :now, updated_at = :now, current_revision = 1, version = version + 1,
                       workflow_version_id = :wf, policy_version_id = :pol, process_instance_id = :pid where id = :id""")
                .param("now", Db.ts(now)).param("wf", wf.id()).param("pol", policy).param("pid", pi.getId()).param("id", id).update();
        if (!pi.isEnded()) {
            taskSync.sync(id, 1, pi.getId(), wf.definition());
        }
        audit.record(ctx.actor(), AuditService.Capacity.NONE, "ACCESS_REQUEST_SUBMITTED", "REQUEST", id.toString(), number, Map.of("roles", roles), reason, 1);
        outbox.enqueue("REQUEST", id.toString(), "REQUEST_SUBMITTED", Map.of("requestId", id.toString(), "revision", 1));
        return Map.of("id", id.toString(), "number", number);
    }

    /** A returned request is the same request (as in re-stationing): the person changes it and sends it again; it starts over. */
    @Transactional
    public Map<String, Object> resubmit(AccessContext ctx, UUID requestId, NewRequest in) {
        Map<String, Object> a = jdbc.sql("""
                select a.person_id, a.unit_org_id, r.status, r.current_revision, r.number, r.type_code, r.owner_org_id from access_request a join request r on r.id = a.request_id
                 where a.request_id = :r for update of a""").param("r", requestId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.personId().equals(a.get("person_id"))) {
            throw ApiException.notFound();
        }
        if (!"RETURNED".equals(a.get("status"))) {
            throw ApiException.validation("يُعاد إرسال الطلب بعد إرجاعه للتعديل فقط.");
        }
        UUID unit = unitOf(ctx.personId());
        if (unit == null || !unit.equals(a.get("unit_org_id"))) {
            throw ApiException.validation("تغيرت وحدتك منذ تقديم الطلب؛ قدّم طلباً جديداً لوحدتك الحالية.");
        }
        List<String> roles = in == null || in.roles() == null ? List.of() : in.roles().stream().distinct().toList();
        if (roles.isEmpty() || !offered(EVERYONE).containsAll(roles)) {
            throw ApiException.validation("اختر صلاحية واحدة على الأقل من القائمة.");
        }
        String reason = in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 5) {
            throw ApiException.validation("اكتب سبب الطلب.");
        }
        Scope scope = checkScope(in.scope(), unit, ctx, false);
        String type = (String) a.get("type_code");
        WorkflowService.PublishedWorkflow wf = workflows.latestPublished(type);
        if (wf == null) {
            throw new ApiException(ErrorCode.WORKFLOW_NOT_PUBLISHED, "لم يُفعَّل بعد مسار طلب الصلاحيات؛ راجع مدير النظام.");
        }
        Instant now = clock.instant();
        int revision = ((Number) a.get("current_revision")).intValue() + 1;
        UUID form = forms.latestPublished(type).id();
        UUID policy = policies.current().id();
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("roles", roles);
        values.put("reason", reason);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("subject", "طلب صلاحيات");
        Map<String, Object> noPeriod = new LinkedHashMap<>();
        noPeriod.put("start", null);
        noPeriod.put("end", null);
        data.put("period", noPeriod);
        data.put("ownerOrgId", unit.toString());
        data.put("resourceIds", List.of());
        data.put("participantOrgIds", List.of());
        data.put("infoOrgIds", List.of());
        data.put("values", values);
        data.put("formVersionId", form.toString());
        data.put("workflowVersionId", wf.id().toString());
        jdbc.sql("""
                insert into request_revision(id, request_id, revision, data, form_version_id, workflow_version_id, policy_version_id,
                    submitted_by, submitted_at, content_sha256, carried_stages)
                values (:id, :req, :rev, cast(:data as jsonb), :form, :wf, :pol, :by, :now, :sha, '{}')""")
                .param("id", UUID.randomUUID()).param("req", requestId).param("rev", revision).param("data", json.write(data)).param("form", form).param("wf", wf.id())
                .param("pol", policy).param("by", ctx.personId()).param("now", Db.ts(now)).param("sha", Hashing.sha256(json.canonical(data))).update();
        jdbc.sql("""
                update access_request set requested = string_to_array(:roles, ','), reason = :why, requested_scope = cast(:scope as jsonb), granted_scope = null,
                       recommended = null, recommend_reject = false, reviewed_name = null, reviewed_at = null, review_note = null where request_id = :r""")
                .param("roles", String.join(",", roles)).param("why", reason).param("scope", scopeJson(scope)).param("r", requestId).update();
        Map<String, Object> vars = new HashMap<>();
        vars.put("requestId", requestId.toString());
        vars.put("revision", revision);
        ProcessInstance pi = runtime.startProcessInstanceById(wf.processDefinitionId(), requestId.toString(), vars);
        jdbc.sql("""
                update request set status = 'SUBMITTED', submitted_at = :now, updated_at = :now, current_revision = :rev, version = version + 1, decided_at = null,
                       workflow_version_id = :wf, policy_version_id = :pol, process_instance_id = :pid where id = :id""")
                .param("now", Db.ts(now)).param("rev", revision).param("wf", wf.id()).param("pol", policy).param("pid", pi.getId()).param("id", requestId).update();
        if (!pi.isEnded()) {
            taskSync.sync(requestId, revision, pi.getId(), wf.definition());
        }
        audit.record(ctx.actor(), AuditService.Capacity.NONE, "ACCESS_REQUEST_RESUBMITTED", "REQUEST", requestId.toString(), (String) a.get("number"), Map.of("roles", roles), reason, revision);
        outbox.enqueue("REQUEST", requestId.toString(), "REQUEST_SUBMITTED", Map.of("requestId", requestId.toString(), "revision", revision));
        return Map.of("id", requestId.toString(), "number", (String) a.get("number"));
    }

    /** The requests waiting for this person's decision. */
    public List<Map<String, Object>> inbox(AccessContext ctx) {
        ctx.require(Permission.REVIEW);
        List<Map<String, Object>> out = new ArrayList<>();
        for (DecisionService.TaskItem t : decisions.accessTasks(ctx)) {
            UUID requestId = UUID.fromString(t.requestId());
            Map<String, Object> r = jdbc.sql("""
                    select a.reason, a.person_id, a.unit_org_id, a.reviewed_name, a.reviewed_at, array_to_string(a.requested, ',') as requested,
                           array_to_string(a.recommended, ',') as recommended, a.recommend_reject, a.review_note, a.requested_scope::text as requested_scope,
                           a.granted_scope::text as granted_scope, p.display_name, p.employee_no, p.status as person_status, o.name as unit, q.submitted_at
                    from access_request a join person p on p.id = a.person_id join organization o on o.id = a.unit_org_id
                    join request q on q.id = a.request_id where a.request_id = :r""").param("r", requestId).query().singleRow();
            UUID now = unitOf((UUID) r.get("person_id"));
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("taskId", t.id());
            m.put("requestId", t.requestId());
            m.put("number", t.requestNumber());
            m.put("stage", t.stageName());
            m.put("final", t.isFinal());
            m.put("person", r.get("display_name"));
            m.put("employeeNo", r.get("employee_no"));
            m.put("unit", r.get("unit"));
            m.put("movedTo", now != null && !now.equals(r.get("unit_org_id")) ? orgName(now) : null);
            m.put("reason", r.get("reason"));
            m.put("submittedAt", Db.toInstant(r.get("submitted_at")).toString());
            m.put("requested", labelled(list(r.get("requested"))));
            m.put("recommended", r.get("recommended") == null ? null : labelled(list(r.get("recommended"))));
            m.put("reviewedBy", r.get("reviewed_name"));
            List<String> shown = new ArrayList<>(offered(EVERYONE));
            List.of(list(r.get("requested")), list(r.get("recommended"))).forEach(l -> l.stream().filter(c -> !shown.contains(c)).forEach(shown::add));
            m.put("offered", labelled(shown));
            m.put("recommendReject", r.get("recommend_reject"));
            m.put("reviewNote", r.get("review_note"));
            m.put("personActive", "ACTIVE".equals(r.get("person_status")));
            m.put("scope", r.get("requested_scope") == null ? null : json.map(r.get("requested_scope").toString()));
            m.put("proposedScope", r.get("granted_scope") == null ? null : json.map(r.get("granted_scope").toString()));
            m.put("scopeUnits", orgTree((UUID) r.get("unit_org_id")));
            m.put("scopeSites", linkedSites((UUID) r.get("unit_org_id")));
            m.put("scopeNames", scopeNames(r.get("requested_scope")));
            m.put("extras", labelled(offered(MANAGER).stream().filter(c -> !shown.contains(c)).toList()));
            out.add(m);
        }
        return out;
    }

    private List<String> scopeNames(Object text) {
        Scope s = storedScope(text);
        if (s == null || s.ids().isEmpty()) {
            return List.of();
        }
        return jdbc.sql("select name from " + ("SITES".equals(s.mode()) ? "site" : "organization") + " where id = any(string_to_array(:i, ',')::uuid[]) order by name")
                .param("i", Db.ids(s.ids())).query(String.class).list();
    }

    /** A reviewer's decision advises; the final approver's grants. The engine checks who may decide this task, and rolls all of it back. */
    @Transactional
    public Map<String, Object> decide(AccessContext ctx, UUID requestId, Decide in) {
        if (in == null || in.taskId() == null || !List.of("APPROVE", "REJECT", "RETURN").contains(String.valueOf(in.decision()))) {
            throw ApiException.validation("القرار يجب أن يكون اعتماداً أو رفضاً أو إرجاعاً.");
        }
        Map<String, Object> a = jdbc.sql("select person_id, unit_org_id, array_to_string(requested, ',') as asked, array_to_string(recommended, ',') as advised, requested_scope::text as asked_scope, granted_scope::text as advised_scope from access_request where request_id = :r and open for update")
                .param("r", requestId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        Map<String, Object> task = jdbc.sql("select final from task_assignment where id = cast(:t as uuid) and request_id = :r and status = 'OPEN'")
                .param("t", in.taskId()).param("r", requestId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        boolean isFinal = (Boolean) task.get("final");
        Instant now = clock.instant();
        boolean rejectAdvice = !isFinal && Boolean.TRUE.equals(in.recommendReject());
        if ("APPROVE".equals(in.decision())) {
            // the final approval checks the person, the unit, the scope and each permission against today, not against the request
            String personStatus = jdbc.sql("select status from person where id = :p").param("p", a.get("person_id")).query(String.class).single();
            if (!"ACTIVE".equals(personStatus)) {
                throw ApiException.validation("مقدم الطلب لم يعد نشطاً في الموارد البشرية؛ لا يُعتمد الطلب.");
            }
            UUID current = unitOf((UUID) a.get("person_id"));
            if (current == null || !current.equals(a.get("unit_org_id"))) {
                throw ApiException.validation((current == null ? "لم يعد لمقدم الطلب وحدة" : "نُقل مقدم الطلب إلى «" + orgName(current) + "» بعد تقديمه")
                        + "؛ ارفض الطلب ليقدّم طلباً جديداً لوحدته الجديدة.");
            }
            List<String> roles = in.roles() == null ? List.of() : in.roles().stream().distinct().toList();
            List<String> allowed = new ArrayList<>(offered(EVERYONE));
            allowed.addAll(offered(MANAGER));
            allowed.addAll(list(a.get("asked")));
            allowed.addAll(list(a.get("advised")));
            if (!rejectAdvice && (roles.isEmpty() || !allowed.containsAll(roles))) {
                throw ApiException.validation("اختر صلاحية واحدة على الأقل من القائمة.");
            }
            UUID unit = (UUID) a.get("unit_org_id");
            Scope scope = in.scope() != null ? checkScope(in.scope(), unit, ctx, isFinal)
                    : checkScope(storedScope(a.get(a.get("advised_scope") != null ? "advised_scope" : "asked_scope")), unit, ctx, isFinal);
            if (isFinal) {
                jdbc.sql("update access_request set granted = string_to_array(:roles, ','), granted_scope = cast(:scope as jsonb) where request_id = :r")
                        .param("roles", String.join(",", roles)).param("scope", scopeJson(scope)).param("r", requestId).update();
            } else {
                jdbc.sql("""
                        update access_request set recommended = string_to_array(:roles, ','), reviewed_name = :by, reviewed_at = :now, recommend_reject = :rej,
                               review_note = :note, granted_scope = cast(:scope as jsonb) where request_id = :r""")
                        .param("roles", rejectAdvice ? "" : String.join(",", roles)).param("by", ctx.actor().displayName()).param("now", Db.ts(now))
                        .param("rej", rejectAdvice).param("note", in.note()).param("scope", scopeJson(scope)).param("r", requestId).update();
            }
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("roles", roles);
            detail.put("scope", scope == null ? "ROLE" : scope.mode());
            detail.put("recommendReject", rejectAdvice);
            audit.recordAs(ctx.actor(), isFinal ? "ACCESS_REQUEST_FINAL_APPROVED" : "ACCESS_REQUEST_RECOMMENDED", "REQUEST", requestId.toString(), null, detail, in.note());
        }
        int revision = jdbc.sql("select current_revision from request where id = :r").param("r", requestId).query(Integer.class).single();
        decisions.decideAccess(ctx, UUID.fromString(in.taskId()), new DecisionInput(in.decision(), in.note(), null, revision, null, null));
        String status = jdbc.sql("select status from request where id = :r").param("r", requestId).query(String.class).single();
        // returned stays open: it is the same request, sent again after the person changes it
        if (!"SUBMITTED".equals(status) && !"RETURNED".equals(status)) {
            jdbc.sql("update access_request set open = false where request_id = :r").param("r", requestId).update();
        }
        return Map.of("status", status);
    }
}
