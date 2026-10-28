package ae.mover.system;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.audit.AuditService;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.common.Times;
import ae.mover.facilities.MapService;
import ae.mover.forms.FormService;
import ae.mover.policy.PolicyService;
import ae.mover.requests.Commands;
import ae.mover.requests.DecisionService;
import ae.mover.requests.RequestService;
import ae.mover.reservations.ReservationService;
import ae.mover.security.Actor;
import ae.mover.security.AuthService;
import ae.mover.security.DemoProperties;
import ae.mover.workflow.WorkflowService;

/**
 * Startup tasks: baseline configuration (roles, request types, first published form/workflow/policy versions),
 * local map package registration, and — only when {@code mover.demo.seed=true} — a fictional demonstration dataset.
 * Every step is idempotent.
 */
@Component
@Order(1)
public class Bootstrap implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(Bootstrap.class);

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final TransactionTemplate tx;
    private final PolicyService policies;
    private final FormService forms;
    private final WorkflowService workflows;
    private final MapService maps;
    private final DemoProperties demo;
    private final AuthService auth;
    private final AccessService access;
    private final RequestService requests;
    private final DecisionService decisions;
    private final ReservationService reservations;
    private final AuditService audit;

    public Bootstrap(JdbcClient jdbc, Json json, Clock clock, TransactionTemplate tx, PolicyService policies,
                     FormService forms, WorkflowService workflows, MapService maps, DemoProperties demo, AuthService auth,
                     AccessService access, RequestService requests, DecisionService decisions,
                     ReservationService reservations, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.tx = tx;
        this.policies = policies;
        this.forms = forms;
        this.workflows = workflows;
        this.maps = maps;
        this.demo = demo;
        this.auth = auth;
        this.access = access;
        this.requests = requests;
        this.decisions = decisions;
        this.reservations = reservations;
        this.audit = audit;
    }

    @Override
    public void run(ApplicationArguments args) {
        tx.executeWithoutResult(s -> {
            policies.ensureInitial();
            seedRoles();
            seedRequestTypes();
        });
        maps.installLocalPackages();
        if (demo.seed()) {
            Integer orgs = jdbc.sql("select count(*) from organization").query(Integer.class).single();
            if (orgs == 0) {
                if (demo.password() == null || demo.password().length() < 8) {
                    log.error("MOVER_DEMO_PASSWORD must be set (8+ characters) to seed demo users; demo data skipped");
                    return;
                }
                tx.executeWithoutResult(s -> seedDemo());
                tx.executeWithoutResult(s -> seedDemoRequests());
                log.info("Fictional demonstration data seeded");
            }
        }
    }

    // ---- baseline configuration -----------------------------------------------------------------------

    private void seedRoles() {
        Object[][] roles = {
                {"SYSTEM_ADMIN", "مدير النظام", "VIEW,CREATE,REVIEW,APPROVE,EXPORT,CONFIGURE,AUDIT,EXECUTE", "ALL", false, true, 1},
                {"REQUESTER", "مقدم الطلب", "VIEW,CREATE,EXECUTE", "ORGANIZATION", false, false, 2},
                {"FACILITIES_REVIEWER", "مراجع المرافق", "VIEW,REVIEW,EXPORT,EXECUTE", "ALL", false, false, 3},
                {"ORG_MANAGER", "مدير الجهة", "VIEW,CREATE,REVIEW,EXPORT", "ORGANIZATION", false, false, 4},
                {"APPROVER", "صاحب الاعتماد", "VIEW,REVIEW,APPROVE,EXPORT", "ALL", false, false, 5},
                {"LIMITED_VIEWER", "اطلاع محدود", "VIEW", "SITE", true, false, 6},
                {"AUDITOR", "مدقق السجلات", "VIEW,AUDIT", "ALL", false, false, 7}};
        for (Object[] r : roles) {
            jdbc.sql("""
                    insert into role_def(code, name, permissions, scope, summary_only, system, sort_order)
                    values (:c, :n, string_to_array(:p, ','), :s, :so, :sys, :o) on conflict (code) do nothing""")
                    .param("c", r[0]).param("n", r[1]).param("p", r[2]).param("s", r[3]).param("so", r[4])
                    .param("sys", r[5]).param("o", r[6]).update();
        }
    }

    private void seedRequestTypes() {
        Object[][] types = {
                {"TEMP_OCCUPANCY", "إشغال مؤقت", "NEW_RESERVATION", true, 1},
                {"ADMIN_TRANSFER", "نقل إداري", "NEW_RESERVATION", true, 2},
                {"EXTENSION", "تمديد", "EXTENSION", false, 3},
                {"MODIFICATION", "تعديل", "MODIFICATION", false, 4},
                {"CANCELLATION", "إلغاء", "CANCELLATION", false, 5},
                {"EVACUATION", "إخلاء", "EVACUATION", false, 6}};
        for (Object[] t : types) {
            int inserted = jdbc.sql("""
                    insert into request_type(code, name, kind, multi_sites, multi_orgs, sort_order)
                    values (:c, :n, :k, :ms, true, :o) on conflict (code) do nothing""")
                    .param("c", t[0]).param("n", t[1]).param("k", t[2]).param("ms", t[3]).param("o", t[4]).update();
            if (inserted == 0) {
                continue;
            }
            String code = (String) t[0];
            UUID formId = UUID.randomUUID();
            jdbc.sql("insert into form_definition(id, request_type_code) values (:id, :t)").param("id", formId).param("t", code).update();
            UUID formVersion = UUID.randomUUID();
            jdbc.sql("insert into form_version(id, form_id, version, status, schema) values (:id, :f, 1, 'DRAFT', cast(:s as jsonb))")
                    .param("id", formVersion).param("f", formId).param("s", json.write(defaultForm())).update();
            forms.publishInternal(null, formVersion, null);
            UUID wfId = UUID.randomUUID();
            jdbc.sql("insert into workflow_definition(id, request_type_code) values (:id, :t)").param("id", wfId).param("t", code).update();
            UUID wfVersion = UUID.randomUUID();
            jdbc.sql("insert into workflow_version(id, workflow_id, version, status, definition) values (:id, :w, 1, 'DRAFT', cast(:d as jsonb))")
                    .param("id", wfVersion).param("w", wfId).param("d", json.write(defaultWorkflow((String) t[2]))).update();
            workflows.publishInternal(null, wfVersion);
        }
    }

    public static Map<String, Object> defaultForm() {
        List<Map<String, Object>> fields = new ArrayList<>();
        fields.add(field("reason", "مبرر الطلب", "textarea", true, Map.of("minLength", 10, "maxLength", 2000), "DESCRIPTIVE", null));
        fields.add(field("headcount", "عدد المستفيدين", "number", false, Map.of("min", 1, "max", 100000), "RESTART_STAGES",
                List.of("facilities_review")));
        fields.add(field("reference", "المرجع الإداري", "text", false, Map.of("maxLength", 100), "DESCRIPTIVE", null));
        fields.add(field("attachments", "المرفقات", "files", false, Map.of(), "FULL_REAPPROVAL", null));
        return Map.of("fields", fields);
    }

    private static Map<String, Object> field(String id, String label, String kind, boolean required, Map<String, Object> extra,
                                             String policy, List<String> stages) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("id", id);
        f.put("label", label);
        f.put("kind", kind);
        f.put("required", required);
        f.put("visible", true);
        f.putAll(extra);
        f.put("changePolicy", policy);
        if (stages != null) {
            f.put("affectsStages", stages);
        }
        return f;
    }

    public static Map<String, Object> defaultWorkflow(String kind) {
        List<Map<String, Object>> stages = List.of(
                stage("facilities_review", "دراسة المرفق", "FACILITIES_REVIEWER", "RESOURCE_ORG", 2, false),
                stage("org_approval", "موافقة الجهة", "ORG_MANAGER", "REQUEST_ORG", 2, false),
                stage("final_approval", "الاعتماد النهائي", "APPROVER", "ANY", 1, true));
        List<Map<String, Object>> execution = switch (kind) {
            case "NEW_RESERVATION" -> List.of(
                    exec("handover", "تسليم المرفق", "FACILITIES_REVIEWER", "RESOURCE_ORG", 1, true),
                    exec("receipt", "استلام المرفق", "REQUESTER", "REQUEST_ORG", 1, false));
            case "EVACUATION" -> List.of(exec("handover", "تسليم المرفق وإثبات الإخلاء", "FACILITIES_REVIEWER", "RESOURCE_ORG", 1, true));
            default -> List.of();
        };
        Map<String, Object> def = new LinkedHashMap<>();
        def.put("name", "مراجعة إدارية قياسية");
        def.put("stages", stages);
        def.put("execution", execution);
        return def;
    }

    private static Map<String, Object> stage(String key, String name, String role, String orgFrom, int sla, boolean fin) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("key", key);
        s.put("name", name);
        s.put("mode", "ALL");
        s.put("slaDays", sla);
        s.put("assignees", List.of(Map.of("role", role, "orgFrom", orgFrom)));
        s.put("final", fin);
        s.put("requiresSignature", fin);
        return s;
    }

    private static Map<String, Object> exec(String key, String name, String role, String orgFrom, int due, boolean evidence) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("key", key);
        e.put("name", name);
        e.put("role", role);
        e.put("orgFrom", orgFrom);
        e.put("dueDays", due);
        e.put("evidenceRequired", evidence);
        return e;
    }

    // ---- fictional demo data ------------------------------------------------------------------------

    private final Map<String, UUID> orgIds = new LinkedHashMap<>();
    private final Map<String, UUID> siteIds = new LinkedHashMap<>();
    private final Map<String, UUID> resourceIds = new LinkedHashMap<>();
    private final Map<String, UUID> people = new LinkedHashMap<>();

    private void seedDemo() {
        Instant from = Instant.parse("2026-01-01T00:00:00Z");
        org("ORG", "المؤسسة", null);
        org("GA", "الإدارة العامة", "ORG");
        org("SS", "الخدمات المشتركة", "ORG");
        org("IT", "إدارة التقنية", "ORG");
        org("PM", "إدارة المشاريع", "ORG");

        site("00", "مجمع المؤسسة", "موقع رئيسي", null, "GA", null, 25.207, 55.31, from);
        Object[][] sites = {
                {"01", "المقر الإداري", "مبنى إداري", "GA", 120, 25.224, 55.277},
                {"02", "مركز الخدمات", "مرفق خدمات", "SS", 65, 25.207, 55.316},
                {"03", "مجمع الأعمال الشرقي", "مكاتب إدارية", "PM", 90, 25.221, 55.357},
                {"04", "قاعة الاجتماعات", "قاعة مشتركة", "GA", 40, 25.189, 55.283},
                {"05", "مركز التدريب الإداري", "قاعات تدريب", "SS", 80, 25.176, 55.330},
                {"06", "مكتب التقنية", "مكاتب مشتركة", "IT", 35, 25.239, 55.325},
                {"07", "مركز الدعم", "مرفق دعم إداري", "IT", 30, 25.198, 55.365},
                {"08", "مبنى الخدمات الغربية", "مبنى خدمات", "SS", 55, 25.211, 55.247}};
        for (Object[] s : sites) {
            String code = (String) s[0];
            site(code, (String) s[1], (String) s[2], "00", (String) s[3], (Integer) s[4], (Double) s[5], (Double) s[6], from);
            resource("R-" + code, siteIds.get(code), (String) s[1], (String) s[2], (Integer) s[4], null);
        }
        resource("R-05A", siteIds.get("05"), "قاعة التدريب أ", "قاعة تدريب", 40, resourceIds.get("R-05"));
        resource("R-05B", siteIds.get("05"), "قاعة التدريب ب", "قاعة تدريب", 40, resourceIds.get("R-05"));

        String hash = auth.hash(demo.password());
        person("admin", "مدير النظام", "E-0001", hash, "SYSTEM_ADMIN", "GA", null, "مدير النظام");
        person("requester", "مقدم طلب تجريبي", "E-0002", hash, "REQUESTER", "SS", null, "منسق الطلبات");
        person("requester2", "مقدم طلب — التقنية", "E-0003", hash, "REQUESTER", "IT", null, "منسق الطلبات");
        person("facilities", "مراجع المرافق التجريبي", "E-0004", hash, "FACILITIES_REVIEWER", "SS", null, "منسق المرافق");
        person("manager", "مدير الخدمات المشتركة", "E-0005", hash, "ORG_MANAGER", "SS", null, "مدير الجهة");
        person("manager_it", "مدير إدارة التقنية", "E-0006", hash, "ORG_MANAGER", "IT", null, "مدير الجهة");
        person("manager_ga", "مدير الإدارة العامة", "E-0007", hash, "ORG_MANAGER", "GA", null, "مدير الجهة");
        person("approver", "صاحب الاعتماد التجريبي", "E-0008", hash, "APPROVER", "GA", null, "صاحب الاعتماد");
        person("approver2", "صاحب اعتماد بديل", "E-0009", hash, "APPROVER", "GA", null, "نائب صاحب الاعتماد");
        person("limited", "مستخدم اطلاع محدود", "E-0010", hash, "LIMITED_VIEWER", "SS", "02", "اطلاع على المرافق");
        membership(people.get("limited"), "LIMITED_VIEWER", "SS", "05", "اطلاع على المرافق");
        membership(people.get("limited"), "LIMITED_VIEWER", "SS", "08", "اطلاع على المرافق");
        person("auditor", "مدقق السجلات", "E-0011", hash, "AUDITOR", "GA", null, "مدقق");

        Object[][] bookings = {
                {"R-01", "GA", "2026-11-01", "2026-12-01"},
                {"R-03", "PM", "2026-11-01", "2026-11-05"},
                {"R-06", "IT", "2026-11-01", "2026-11-04"}};
        for (Object[] b : bookings) {
            reservations.create(resourceIds.get((String) b[0]), orgIds.get((String) b[1]), null, null, "SEED_IMPORT",
                    Times.startOfDay(LocalDate.parse((String) b[2])), Times.startOfDay(LocalDate.parse((String) b[3])),
                    "حجز مستورد من بيانات العرض", null);
        }
        audit.system("DEMO_DATA_SEEDED", "SYSTEM", null, "بيانات افتراضية",
                Map.of("organizations", orgIds.size(), "sites", siteIds.size(), "people", people.size()));
    }

    private void seedDemoRequests() {
        AccessContext requester = ctx("requester");
        UUID first = requests.create(requester, new Commands.DraftInput("TEMP_OCCUPANCY", "MAP", orgIds.get("SS").toString(),
                List.of(resourceIds.get("R-02").toString()), List.of(), List.of(orgIds.get("GA").toString()),
                "إشغال مؤقت — مركز الخدمات", "DAYS", period("2026-11-02", "2026-11-04"),
                Map.of("reason", "استخدام المرفق لاستقبال الموظفين خلال البرنامج الإداري.", "headcount", 45), null, null));
        requests.submit(requester, first, new Commands.SubmitInput(0, null), null);
        AccessContext facilities = ctx("facilities");
        decisions.myTasks(facilities).stream().filter(t -> t.requestId().equals(first.toString())).findFirst()
                .ifPresent(t -> decisions.decide(facilities, UUID.fromString(t.id()),
                        new Commands.DecisionInput("APPROVE", "المرفق مناسب للفترة المطلوبة.", null, 1, null), null));

        AccessContext admin = ctx("admin");
        UUID second = requests.create(admin, new Commands.DraftInput("TEMP_OCCUPANCY", "LIST", orgIds.get("GA").toString(),
                List.of(resourceIds.get("R-04").toString()), List.of(), List.of(), "إشغال مؤقت — قاعة الاجتماعات", "DAYS",
                period("2026-11-05", "2026-11-06"), Map.of("reason", "تنظيم اجتماع إداري خلال الفترة المطلوبة."), null, null));
        requests.submit(admin, second, new Commands.SubmitInput(0, null), null);
    }

    private static Commands.PeriodInput period(String start, String end) {
        return new Commands.PeriodInput(Times.startOfDay(LocalDate.parse(start)).toString(),
                Times.startOfDay(LocalDate.parse(end)).toString());
    }

    private AccessContext ctx(String username) {
        Map<String, Object> p = jdbc.sql("select id, display_name from person where username = :u").param("u", username).query().singleRow();
        return access.load(new Actor((UUID) p.get("id"), username, (String) p.get("display_name"), null), clock.instant());
    }

    private void org(String code, String name, String parent) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into organization(id, code, name, parent_id, valid_from) values (:id, :c, :n, :p, '2026-01-01T00:00:00Z')")
                .param("id", id).param("c", code).param("n", name).param("p", parent == null ? null : orgIds.get(parent)).update();
        orgIds.put(code, id);
    }

    private void site(String code, String name, String kind, String parent, String org, Integer capacity, double lat,
                      double lng, Instant from) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into site(id, code, name, kind, parent_id, capacity, lat, lng) values (:id, :c, :n, :k, :p, :cap, :lat, :lng)""")
                .param("id", id).param("c", code).param("n", name).param("k", kind)
                .param("p", parent == null ? null : siteIds.get(parent)).param("cap", capacity).param("lat", lat).param("lng", lng)
                .update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, :f)")
                .param("id", UUID.randomUUID()).param("s", id).param("o", orgIds.get(org)).param("f", Db.ts(from)).update();
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from)
                values (:id, :s, 1, cast(:g as jsonb), 'EPSG:4326', 'بيانات افتراضية للعرض', :f)""")
                .param("id", UUID.randomUUID()).param("s", id)
                .param("g", json.write(Map.of("type", "Point", "coordinates", List.of(lng, lat)))).param("f", Db.ts(from)).update();
        siteIds.put(code, id);
    }

    private void resource(String code, UUID site, String name, String kind, Integer capacity, UUID parent) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into resource(id, site_id, code, name, kind, policy, parent_resource_id, capacity)
                values (:id, :s, :c, :n, :k, 'EXCLUSIVE', :p, :cap)""")
                .param("id", id).param("s", site).param("c", code).param("n", name).param("k", kind).param("p", parent)
                .param("cap", capacity).update();
        resourceIds.put(code, id);
    }

    private void person(String username, String name, String employeeNo, String hash, String role, String org,
                        String siteCode, String title) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username, password_hash) values (:id, :e, :n, :u, :h)")
                .param("id", id).param("e", employeeNo).param("n", name).param("u", username).param("h", hash).update();
        people.put(username, id);
        membership(id, role, org, siteCode, title);
    }

    private void membership(UUID person, String role, String org, String siteCode, String title) {
        jdbc.sql("""
                insert into membership(id, person_id, organization_id, role_code, position_title, site_scope_id, valid_from)
                values (:id, :p, :o, :r, :t, :s, '2026-01-01T00:00:00Z')""")
                .param("id", UUID.randomUUID()).param("p", person).param("o", orgIds.get(org)).param("r", role)
                .param("t", title).param("s", siteCode == null ? null : siteIds.get(siteCode)).update();
    }
}
