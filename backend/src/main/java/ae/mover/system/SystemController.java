package ae.mover.system;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.common.PageResult;
import ae.mover.integrations.IntegrationService;
import ae.mover.notify.DesktopFeed;
import ae.mover.outbox.OutboxProcessor;
import ae.mover.policy.PolicyService;
import ae.mover.policy.Settings;
import ae.mover.reports.ReportService;
import ae.mover.security.Actor;

/** Policies, integrations, audit, indicators, exports, notifications and system information. */
@RestController
@RequestMapping("/api/v1")
public class SystemController {

    private final AccessService access;
    private final PolicyService policies;
    private final IntegrationService integrations;
    private final ReportService reports;
    private final OutboxProcessor outbox;
    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final String version;
    private final DesktopFeed desktop;
    private final AuditService audit;

    public SystemController(AccessService access, PolicyService policies, IntegrationService integrations,
                            ReportService reports, OutboxProcessor outbox, JdbcClient jdbc, Json json, Clock clock, @Value("${mover.version:1.0.0}") String version,
                            DesktopFeed desktop, AuditService audit) {
        this.desktop = desktop;
        this.access = access;
        this.policies = policies;
        this.integrations = integrations;
        this.reports = reports;
        this.outbox = outbox;
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.version = version;
        this.audit = audit;
    }

    // ---- policies -----------------------------------------------------------------------------------

    /** Readable by every signed-in user: the request wizard needs the effective request policies. */
    @GetMapping("/policies/current")
    public PolicyService.PolicyVersion currentPolicy(Actor actor) {
        return policies.current();
    }

    @GetMapping("/policies/history")
    public List<PolicyService.PolicyVersion> policyHistory(Actor actor) {
        access.context(actor).require(Permission.CONFIGURE);
        return policies.history();
    }

    @PostMapping("/policies/drafts")
    public PolicyService.PolicyVersion policyDraft(Actor actor, @RequestBody Map<String, Object> body) {
        return policies.saveDraft(access.context(actor), json.convert(body.get("settings"), Settings.class));
    }

    @PostMapping("/policy-versions/{id}/publish")
    public PolicyService.PolicyVersion publishPolicy(Actor actor, @PathVariable UUID id) {
        return policies.publish(access.context(actor), id);
    }

    // ---- integrations --------------------------------------------------------------------------------

    @GetMapping("/integrations")
    public List<IntegrationService.Connector> integrations(Actor actor) {
        return integrations.list(access.context(actor));
    }

    public record OrgImportInput(List<IntegrationService.OrgRow> rows) {
    }

    @PostMapping("/integrations/org-structure/preview")
    public IntegrationService.PreviewResult previewOrgImport(Actor actor, @RequestBody OrgImportInput in) {
        return integrations.preview(access.context(actor), in.rows());
    }

    @PostMapping("/integrations/org-structure/runs/{id}/commit")
    public Map<String, Object> commitOrgImport(Actor actor, @PathVariable UUID id) {
        return integrations.commit(access.context(actor), id);
    }

    // ---- audit ---------------------------------------------------------------------------------------

    /** Read-only view of the audit trail. There is deliberately no API to modify or delete audit events. */
    @GetMapping("/audit-events")
    public PageResult<Map<String, Object>> audit(Actor actor, @RequestParam(required = false) Integer page,
                                                 @RequestParam(required = false) Integer size,
                                                 @RequestParam(required = false) String action,
                                                 @RequestParam(required = false) String entityType) {
        AccessContext ctx = access.context(actor);
        ctx.require(Permission.AUDIT);
        int p = PageResult.page(page);
        int s = PageResult.size(size);
        String where = "(cast(:action as text) is null or action = :action) and (cast(:etype as text) is null or entity_type = :etype)";
        long total = jdbc.sql("select count(*) from audit_event where " + where).param("action", action).param("etype", entityType)
                .query(Long.class).single();
        List<Map<String, Object>> items = jdbc.sql("select * from audit_event where " + where + " order by id desc limit :l offset :o")
                .param("action", action).param("etype", entityType).param("l", s).param("o", p * s)
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getLong("id"));
                    m.put("at", Db.iso(rs, "occurred_at"));
                    Map<String, Object> who = rs.getString("actor_name") == null ? null : mapOf("name", rs.getString("actor_name"),
                            "role", rs.getString("actor_role"), "org", rs.getString("actor_org"));
                    if (who != null) {
                        who.put("personId", rs.getString("actor_person_id"));
                    }
                    m.put("actor", who);
                    m.put("action", rs.getString("action"));
                    m.put("actionLabel", AuditService.LABELS.getOrDefault(rs.getString("action"), rs.getString("action")));
                    m.put("entityType", rs.getString("entity_type"));
                    m.put("entityId", rs.getString("entity_id"));
                    m.put("entityLabel", rs.getString("entity_label"));
                    Map<String, Object> data = json.map(rs.getString("detail"));
                    m.put("detail", describe(rs.getString("entity_label"), data));
                    m.put("data", data);
                    m.put("reason", rs.getString("reason"));
                    m.put("revision", rs.getObject("revision"));
                    m.put("viaDelegation", rs.getString("via_delegation_id") != null);
                    return m;
                }).list();
        return new PageResult<>(items, p, s, total);
    }

    private static final Map<String, String> DETAIL_KEYS = Map.ofEntries(
            Map.entry("stage", "المرحلة"), Map.entry("reasonCode", "رمز السبب"), Map.entry("type", "النوع"),
            Map.entry("origin", "المصدر"), Map.entry("fileName", "الملف"), Map.entry("signatureMode", "نمط التوثيق"),
            Map.entry("kind", "النوع"), Map.entry("period", "الفترة"), Map.entry("formVersion", "إصدار النموذج"),
            Map.entry("workflowVersion", "إصدار التدفق"), Map.entry("rows", "الصفوف"), Map.entry("role", "الدور"),
            Map.entry("task", "المهمة"), Map.entry("stages", "المراحل"), Map.entry("openTasks", "مهام مفتوحة"),
            Map.entry("endAt", "تاريخ الانتهاء"), Map.entry("validTo", "صالح حتى"), Map.entry("version", "الإصدار"),
            Map.entry("errors", "الأخطاء"), Map.entry("valid", "صالح"), Map.entry("locked", "إيقاف مؤقت"),
            Map.entry("note", "ملاحظة"), Map.entry("releasedAt", "وقت الإخلاء"));

    /** Human-readable Arabic summary of an audit event's structured detail (the raw data is returned separately). */
    static String describe(String label, Map<String, Object> data) {
        StringBuilder sb = new StringBuilder(label == null ? "" : label);
        data.forEach((k, v) -> {
            String name = DETAIL_KEYS.get(k);
            if (name == null || v == null) {
                return;
            }
            String value = v instanceof java.util.Collection<?> c ? c.size() + " عنصر" : String.valueOf(v);
            if (value.length() > 80) {
                value = value.substring(0, 80) + "…";
            }
            sb.append(sb.isEmpty() ? "" : " · ").append(name).append(": ").append(value);
        });
        return sb.toString();
    }

    private static Map<String, Object> mapOf(String k1, Object v1, String k2, Object v2, String k3, Object v3) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(k1, v1);
        m.put(k2, v2);
        m.put(k3, v3);
        return m;
    }

    // ---- reports & exports ---------------------------------------------------------------------------

    @GetMapping("/reports/kpis")
    public Map<String, Object> kpis(Actor actor, @RequestParam(required = false) String from, @RequestParam(required = false) String to) {
        return reports.kpis(access.context(actor), from, to);
    }

    @PostMapping("/exports")
    public ReportService.ExportJob createExport(Actor actor, @RequestBody Map<String, Object> body) {
        Object filter = body.get("filter");
        return reports.createExport(access.context(actor), (String) body.get("kind"), filter == null ? Map.of() : json.map(filter));
    }

    @GetMapping("/exports/{id}")
    public ReportService.ExportJob export(Actor actor, @PathVariable UUID id) {
        return reports.export(access.context(actor), id);
    }

    @GetMapping("/exports/{id}/content")
    public ResponseEntity<byte[]> exportContent(Actor actor, @PathVariable UUID id) {
        byte[] bytes = reports.exportContent(access.context(actor), id);
        return ResponseEntity.ok().contentType(new MediaType("text", "csv", StandardCharsets.UTF_8))
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename("mover-requests-" + id + ".csv").build().toString())
                .body(bytes);
    }

    // ---- notifications -------------------------------------------------------------------------------

    @GetMapping("/notifications")
    public List<Map<String, Object>> notifications(Actor actor) {
        return jdbc.sql("select * from notification where person_id = :p order by created_at desc limit 100")
                .param("p", actor.personId()).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("kind", rs.getString("kind"));
                    m.put("title", rs.getString("title"));
                    m.put("body", rs.getString("body"));
                    m.put("requestId", rs.getString("request_id"));
                    m.put("link", rs.getString("link"));
                    m.put("createdAt", Db.iso(rs, "created_at"));
                    m.put("readAt", Db.iso(rs, "read_at"));
                    return m;
                }).list();
    }

    /** Desktop notifications (ADR-050): new unread items after the browser's cursor, with lock-screen-safe text. */
    @GetMapping("/notifications/desktop-feed")
    public Map<String, Object> desktopFeed(Actor actor, @RequestParam(required = false) Long since) {
        return desktop.feed(actor.personId(), since);
    }

    @PostMapping("/notifications/{id}/read")
    public ResponseEntity<Void> markRead(Actor actor, @PathVariable UUID id) {
        int n = jdbc.sql("update notification set read_at = coalesce(read_at, now()) where id = :id and person_id = :p")
                .param("id", id).param("p", actor.personId()).update();
        if (n == 0) {
            throw ApiException.notFound();
        }
        return ResponseEntity.noContent().build();
    }

    // ---- system --------------------------------------------------------------------------------------

    @GetMapping("/system/info")
    public Map<String, Object> info(Actor actor) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("version", version);
        m.put("timezone", policies.settings().timezone());
        m.put("serverTime", clock.instant().toString());
        m.put("database", jdbc.sql("select 1").query(Integer.class).single() == 1 ? "UP" : "DOWN");
        m.put("outboxPending", outbox.pending());
        m.put("mapPackages", jdbc.sql("select count(*) from map_package where status = 'ACTIVE'").query(Long.class).single());
        return m;
    }

    /**
     * ADR-094: whether the installation holds any data yet. An empty one shows nothing in the middle of its screens — no map,
     * no tiles of zeros — until units are imported or a site, a stationing or a request exists. Open to zero access.
     */
    @GetMapping("/system/state")
    public Map<String, Object> state(Actor actor) {
        Map<String, Object> m = new LinkedHashMap<>();
        long units = jdbc.sql("select count(*) from organization where status = 'ACTIVE'").query(Long.class).single();
        long sites = jdbc.sql("select count(*) from site where status <> 'RETIRED'").query(Long.class).single();
        long stationed = jdbc.sql("select count(*) from org_stationing where valid_from <= :at and (valid_to is null or valid_to > :at)")
                .param("at", ae.mover.common.Db.ts(clock.instant())).query(Long.class).single();
        long requests = jdbc.sql("select count(*) from request").query(Long.class).single();
        long people = jdbc.sql("select count(*) from person where status = 'ACTIVE'").query(Long.class).single();
        m.put("units", units);
        m.put("sites", sites);
        m.put("stationed", stationed);
        m.put("requests", requests);
        m.put("people", people);
        m.put("unitsImported", units > 0);
        m.put("empty", units == 0 && sites == 0 && stationed == 0 && requests == 0);
        return m;
    }

    @GetMapping("/system/health")
    public Map<String, Object> health() {
        return Map.of("status", jdbc.sql("select 1").query(Integer.class).single() == 1 ? "UP" : "DOWN");
    }

    @GetMapping(value = "/openapi.json", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<byte[]> openapi() throws java.io.IOException {
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON)
                .body(new ClassPathResource("openapi.json").getContentAsByteArray());
    }

    // ---- management center (§3B) ---------------------------------------------------------------

    @GetMapping("/system/management")
    public Map<String, Object> management(Actor actor) {
        access.context(actor).require(Permission.CONFIGURE);
        Map<String, Object> m = new LinkedHashMap<>();
        Integer schema = jdbc.sql("select max(cast(version as integer)) from flyway_schema_history where success and version is not null")
                .query(Integer.class).optional().orElse(null);
        m.put("schemaVersion", schema);
        m.put("organizations", jdbc.sql("select count(*) from organization where status = 'ACTIVE'").query(Long.class).single());
        m.put("people", jdbc.sql("select count(*) from person where status = 'ACTIVE'").query(Long.class).single());
        m.put("requests", jdbc.sql("select count(*) from request").query(Long.class).single());
        m.put("sites", jdbc.sql("select count(*) from site where status <> 'RETIRED'").query(Long.class).single());

        java.io.File backupsDir = new java.io.File("backups");
        if (backupsDir.isDirectory()) {
            String[] dirs = backupsDir.list();
            m.put("backupCount", dirs != null ? dirs.length : 0);
        } else {
            m.put("backupCount", 0);
        }

        String tlsDir = System.getenv("TMRKZ_TLS_DIR");
        if (tlsDir == null || tlsDir.isBlank()) tlsDir = "ops/tls/private";
        java.io.File certFile = new java.io.File(tlsDir, "server.crt");
        if (certFile.exists()) {
            m.put("tlsConfigured", true);
            try {
                var cf = java.security.cert.CertificateFactory.getInstance("X.509");
                try (var fis = new java.io.FileInputStream(certFile)) {
                    var cert = (java.security.cert.X509Certificate) cf.generateCertificate(fis);
                    m.put("tlsSubject", cert.getSubjectX500Principal().getName());
                    m.put("tlsIssuer", cert.getIssuerX500Principal().getName());
                    m.put("tlsExpiry", cert.getNotAfter().toInstant().toString());
                    m.put("tlsNotBefore", cert.getNotBefore().toInstant().toString());
                    var sans = cert.getSubjectAlternativeNames();
                    if (sans != null) {
                        m.put("tlsSAN", sans.stream().map(e -> String.valueOf(e.get(1))).toList());
                    }
                }
            } catch (Exception e) {
                m.put("tlsError", e.getMessage());
            }
        } else {
            m.put("tlsConfigured", false);
        }

        m.put("embeddingAllowedOrigins", embeddingOrigins());
        m.put("version", version);
        m.put("serverTime", clock.instant().toString());
        m.put("database", jdbc.sql("select 1").query(Integer.class).single() == 1 ? "UP" : "DOWN");
        m.put("mapPackages", jdbc.sql("select count(*) from map_package where status = 'ACTIVE'").query(Long.class).single());
        return m;
    }

    @GetMapping("/system/embedding")
    public Map<String, Object> getEmbedding(Actor actor) {
        access.context(actor).require(Permission.CONFIGURE);
        return Map.of("allowedOrigins", embeddingOrigins());
    }

    @PutMapping("/system/embedding")
    public Map<String, Object> setEmbedding(Actor actor, @RequestBody Map<String, Object> body) {
        var ctx = access.context(actor);
        ctx.require(Permission.CONFIGURE);
        @SuppressWarnings("unchecked")
        var origins = (List<String>) body.get("allowedOrigins");
        if (origins == null) origins = List.of();
        var validated = new java.util.ArrayList<String>();
        for (String o : origins) {
            if (o == null || o.isBlank()) continue;
            o = o.strip();
            if (!o.matches("^https://[a-zA-Z0-9._-]+(:[0-9]+)?$")) {
                throw ApiException.validation("مصدر غير صالح: " + o + " — يجب أن يكون https://host أو https://host:port فقط");
            }
            validated.add(o);
        }
        if (validated.isEmpty()) {
            jdbc.sql("delete from system_setting where key = 'EMBEDDING_ALLOWED_ORIGINS'").update();
        } else {
            jdbc.sql("""
                insert into system_setting (key, value) values ('EMBEDDING_ALLOWED_ORIGINS', :v)
                on conflict (key) do update set value = excluded.value""")
                .param("v", String.join(",", validated)).update();
        }
        audit.recordAs(ctx.actor(), "EMBEDDING_ORIGINS_CHANGED", "SYSTEM", "embedding", null,
                Map.of("origins", validated), null);
        return Map.of("allowedOrigins", validated);
    }

    @GetMapping(value = "/system/embedding/csp", produces = "text/plain")
    public String embeddingCsp() {
        List<String> origins = embeddingOrigins();
        return origins.isEmpty() ? "'none'" : "'self' " + String.join(" ", origins);
    }

    private List<String> embeddingOrigins() {
        try {
            String raw = jdbc.sql("select value from system_setting where key = 'EMBEDDING_ALLOWED_ORIGINS'")
                    .query(String.class).optional().orElse("");
            if (raw == null || raw.isBlank()) return List.of();
            return java.util.Arrays.stream(raw.split(",")).filter(s -> !s.isBlank()).map(String::strip).toList();
        } catch (Exception e) {
            return List.of();
        }
    }
}
