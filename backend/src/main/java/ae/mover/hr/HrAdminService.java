package ae.mover.hr;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Json;
import ae.mover.hr.HrMapping.Entity;

/** Administration of the HR source, its mapping versions, runs and position seats. */
@Service
public class HrAdminService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final HrProperties props;
    private final HrSettingsCipher cipher;
    private final HrSourceAdapter adapter;
    private final HrSyncService sync;
    private final AuditService audit;

    public HrAdminService(JdbcClient jdbc, Json json, Clock clock, HrProperties props, HrSettingsCipher cipher,
                          HrSourceAdapter adapter, HrSyncService sync, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.props = props;
        this.cipher = cipher;
        this.adapter = adapter;
        this.sync = sync;
        this.audit = audit;
    }

    // ---- status -----------------------------------------------------------------------------------------------

    public Map<String, Object> status(AccessContext ctx) {
        ctx.requireAny(Permission.CONFIGURE, Permission.VIEW_SOURCE_IDENTIFIERS);
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> src = source();
        Instant now = clock.instant();
        out.put("keyConfigured", cipher.configured());
        out.put("configured", src != null && src.get("settings_ciphertext") != null);
        out.put("enabled", src != null && (Boolean) src.get("enabled"));
        out.put("sourceName", src == null ? null : src.get("name"));
        out.put("intervalSeconds", props.syncIntervalSeconds());
        out.put("running", sync.running());
        Map<String, Object> mapping = src == null ? null : jdbc.sql(
                "select version from hr_mapping_version where source_id = :s and status = 'PUBLISHED'")
                .param("s", src.get("id")).query().listOfRows().stream().findFirst().orElse(null);
        out.put("mappingVersion", mapping == null ? null : mapping.get("version"));
        Instant lastSuccess = src == null ? null : Db.toInstant(src.get("last_success_at"));
        out.put("lastSuccessAt", lastSuccess == null ? null : lastSuccess.toString());
        out.put("dataAgeMinutes", lastSuccess == null ? null : Duration.between(lastSuccess, now).toMinutes());
        int maxAge = src == null ? 720 : ((Number) src.get("max_age_hours")).intValue();
        out.put("maxAgeHours", maxAge);
        out.put("stale", lastSuccess == null || Duration.between(lastSuccess, now).toHours() >= maxAge);
        Map<String, Object> snap = jdbc.sql("select * from hr_snapshot where status = 'PUBLISHED'").query().listOfRows()
                .stream().findFirst().orElse(null);
        out.put("published", snap == null ? null : Map.of("units", snap.get("unit_count"), "people", snap.get("person_count"),
                "activeUnits", snap.get("active_unit_count"), "activePeople", snap.get("active_person_count"),
                "publishedAt", Db.toInstant(snap.get("published_at")).toString()));
        List<Map<String, Object>> runs = runs(ctx, 1);
        Map<String, Object> last = runs.isEmpty() ? null : runs.get(0);
        out.put("lastRun", last);
        Instant lastFinished = last == null || last.get("finishedAt") == null ? null : Instant.parse((String) last.get("finishedAt"));
        out.put("nextRunAt", lastFinished == null ? null : lastFinished.plusSeconds(props.syncIntervalSeconds()).toString());
        return out;
    }

    /** Whether the mirror is too old for actions that require current source data (policy: max_age_hours). */
    public boolean stale() {
        Map<String, Object> src = source();
        if (src == null || src.get("last_success_at") == null) {
            return true;
        }
        return Duration.between(Db.toInstant(src.get("last_success_at")), clock.instant()).toHours()
                >= ((Number) src.get("max_age_hours")).intValue();
    }

    public List<Map<String, Object>> runs(AccessContext ctx, int size) {
        ctx.requireAny(Permission.CONFIGURE, Permission.VIEW_SOURCE_IDENTIFIERS);
        return jdbc.sql("""
                select r.*, r.counts::text as counts_text, p.display_name as requested_by_name,
                       (select count(*) from hr_sync_issue i where i.run_id = r.id) as issues
                from hr_sync_run r left join person p on p.id = r.requested_by order by r.started_at desc limit :n""")
                .param("n", Math.max(1, Math.min(size, 200))).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("trigger", rs.getString("trigger"));
                    m.put("status", rs.getString("status"));
                    m.put("startedAt", Db.iso(rs, "started_at"));
                    m.put("finishedAt", Db.iso(rs, "finished_at"));
                    m.put("requestedBy", rs.getString("requested_by_name"));
                    m.put("errorCode", rs.getString("error_code"));
                    m.put("errorMessage", rs.getString("error_message"));
                    m.put("overrideReason", rs.getString("override_reason"));
                    m.put("counts", json.tree(rs.getString("counts_text")));
                    m.put("issues", rs.getInt("issues"));
                    return m;
                }).list();
    }

    /** Issues carry source identifiers: only holders of VIEW_SOURCE_IDENTIFIERS receive them. */
    public List<Map<String, Object>> issues(AccessContext ctx, UUID runId) {
        ctx.require(Permission.VIEW_SOURCE_IDENTIFIERS);
        return jdbc.sql("select kind, entity, external_id, detail from hr_sync_issue where run_id = :r order by id limit 500")
                .param("r", runId).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("kind", rs.getString("kind"));
                    m.put("entity", rs.getString("entity"));
                    m.put("externalId", rs.getString("external_id"));
                    m.put("detail", rs.getString("detail"));
                    return m;
                }).list();
    }

    public Map<String, Object> runNow(AccessContext ctx, String overrideReason) {
        ctx.require(Permission.CONFIGURE);
        UUID id = sync.requestManual(ctx.personId(), overrideReason);
        audit.recordAs(ctx.actor(), "HR_SYNC_REQUESTED", "HR_SYNC_RUN", id.toString(), null,
                overrideReason == null || overrideReason.isBlank() ? Map.of() : Map.of("override", true), overrideReason);
        return Map.of("runId", id.toString(), "accepted", true);
    }

    // ---- source -----------------------------------------------------------------------------------------------

    private Map<String, Object> source() {
        return jdbc.sql("select * from hr_source order by created_at limit 1").query().listOfRows().stream().findFirst().orElse(null);
    }

    public Map<String, Object> sourceView(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> src = source();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("keyConfigured", cipher.configured());
        if (src == null) {
            out.put("exists", false);
            return out;
        }
        out.put("exists", true);
        out.put("id", src.get("id").toString());
        out.put("name", src.get("name"));
        out.put("enabled", src.get("enabled"));
        out.put("unitView", src.get("unit_view"));
        out.put("personView", src.get("person_view"));
        out.put("connectTimeoutS", src.get("connect_timeout_s"));
        out.put("callTimeoutMs", src.get("call_timeout_ms"));
        out.put("dropPercent", src.get("drop_percent"));
        out.put("dropMinimum", src.get("drop_minimum"));
        out.put("maxAgeHours", src.get("max_age_hours"));
        out.put("lastConnectionOk", src.get("last_connection_ok"));
        out.put("lastConnectionAt", src.get("last_connection_at") == null ? null : Db.toInstant(src.get("last_connection_at")).toString());
        boolean readable = false;
        if (src.get("settings_ciphertext") != null && cipher.configured()) {
            try {
                JsonNode s = json.tree(cipher.decrypt((String) src.get("settings_ciphertext"), (String) src.get("settings_key_id")));
                out.put("hostOrUrl", s.path("hostOrUrl").asText());
                out.put("port", s.path("port").asInt(1521));
                out.put("serverName", s.path("serverName").asText());
                out.put("nameType", s.path("nameType").asText("service_name"));
                out.put("username", s.path("username").asText());
                out.put("passwordSet", !s.path("password").asText("").isEmpty());
                readable = true;
            } catch (ApiException e) {
                out.put("settingsError", e.getMessage());
            }
        }
        out.put("settingsReadable", readable);
        return out;
    }

    public record SourceInput(String name, Boolean enabled, String hostOrUrl, Integer port, String serverName, String nameType,
                              String username, String password, String unitView, String personView, Integer connectTimeoutS,
                              Integer callTimeoutMs, Integer dropPercent, Integer dropMinimum, Integer maxAgeHours) {

        @Override
        public String toString() {
            return "SourceInput[" + name + "]"; // never the password
        }
    }

    @Transactional
    public Map<String, Object> saveSource(AccessContext ctx, SourceInput in) {
        ctx.require(Permission.CONFIGURE);
        if (in == null) {
            throw ApiException.validation("أدخل إعدادات المصدر.");
        }
        Map<String, Object> src = source();
        String password = in.password();
        if ((password == null || password.isEmpty()) && src != null && src.get("settings_ciphertext") != null) {
            password = json.tree(cipher.decrypt((String) src.get("settings_ciphertext"), (String) src.get("settings_key_id")))
                    .path("password").asText();
        }
        List<String> problems = new ArrayList<>();
        if (in.name() == null || in.name().isBlank() || in.name().length() > 100) problems.add("اسم المصدر مطلوب.");
        if (in.serverName() == null || in.serverName().isBlank()) problems.add("اسم الخدمة أو SID مطلوب.");
        if (!"service_name".equals(in.nameType()) && !"sid".equals(in.nameType())) problems.add("نوع الاسم: service_name أو sid.");
        if (in.username() == null || in.username().isBlank() || in.username().length() > 256) problems.add("اسم المستخدم مطلوب.");
        if (password == null || password.isEmpty()) problems.add("كلمة المرور مطلوبة عند أول حفظ.");
        if (password != null && password.length() > 2048) problems.add("كلمة المرور أطول من المسموح.");
        for (String v : new String[]{in.unitView(), in.personView()}) {
            if (v == null || !HrMapping.VIEW_NAME.matcher(v).matches()) problems.add("اسم العرض غير صالح: يقبل اسم مخطط اختيارياً ثم اسم العرض.");
        }
        HrSourceAdapter.Config probe = new HrSourceAdapter.Config(in.hostOrUrl(), in.port() == null ? 1521 : in.port(), in.serverName(),
                in.nameType(), in.username(), password, in.unitView(), in.personView(), 10, 30000);
        try {
            HrConnectionFactory.url(probe);
        } catch (IllegalArgumentException e) {
            problems.add(e.getMessage());
        }
        if (!problems.isEmpty()) {
            throw ApiException.validation(String.join(" ", problems), Map.of("problems", problems));
        }
        Map<String, Object> settings = new LinkedHashMap<>();
        settings.put("hostOrUrl", in.hostOrUrl().trim());
        settings.put("port", in.port() == null ? 1521 : in.port());
        settings.put("serverName", in.serverName().trim());
        settings.put("nameType", in.nameType());
        settings.put("username", in.username().trim());
        settings.put("password", password);
        String cipherText = cipher.encrypt(json.write(settings));
        Instant now = clock.instant();
        UUID id = src == null ? UUID.randomUUID() : (UUID) src.get("id");
        jdbc.sql("""
                insert into hr_source(id, name, enabled, settings_ciphertext, settings_key_id, unit_view, person_view,
                                      connect_timeout_s, call_timeout_ms, drop_percent, drop_minimum, max_age_hours, updated_at)
                values (:id, :n, :en, :c, :k, :uv, :pv, :ct, :cl, :dp, :dm, :ma, :now)
                on conflict (id) do update set name = :n, enabled = :en, settings_ciphertext = :c, settings_key_id = :k,
                    unit_view = :uv, person_view = :pv, connect_timeout_s = :ct, call_timeout_ms = :cl, drop_percent = :dp,
                    drop_minimum = :dm, max_age_hours = :ma, updated_at = :now""")
                .param("id", id).param("n", in.name().trim()).param("en", Boolean.TRUE.equals(in.enabled()))
                .param("c", cipherText).param("k", cipher.keyId()).param("uv", in.unitView()).param("pv", in.personView())
                .param("ct", clamp(in.connectTimeoutS(), 10, 1, 300)).param("cl", clamp(in.callTimeoutMs(), 30000, 1000, 300000))
                .param("dp", clamp(in.dropPercent(), 10, 0, 100)).param("dm", clamp(in.dropMinimum(), 3, 0, 1_000_000))
                .param("ma", clamp(in.maxAgeHours(), 720, 1, 8760)).param("now", Db.ts(now)).update();
        audit.recordAs(ctx.actor(), "HR_SOURCE_CHANGED", "HR_SOURCE", id.toString(), in.name(),
                Map.of("enabled", Boolean.TRUE.equals(in.enabled()), "passwordChanged", in.password() != null && !in.password().isEmpty()), null);
        return sourceView(ctx);
    }

    private static int clamp(Integer v, int dflt, int min, int max) {
        int x = v == null ? dflt : v;
        return Math.max(min, Math.min(max, x));
    }

    public Map<String, Object> testConnection(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> src = source();
        if (src == null || src.get("settings_ciphertext") == null) {
            throw new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED, "احفظ إعدادات المصدر أولاً.");
        }
        HrSourceAdapter.Config cfg = sync.config(src);
        Map<String, Object> out = new LinkedHashMap<>();
        long t0 = System.nanoTime();
        boolean ok;
        try (HrSourceAdapter.Session s = adapter.open(cfg)) {
            out.put("databaseVersion", s.databaseVersion());
            out.put("unitColumns", s.columns(cfg.unitView()).size());
            out.put("personColumns", s.columns(cfg.personView()).size());
            ok = true;
        } catch (HrSourceAdapter.SourceException e) {
            out.put("failure", e.failure().name());
            out.put("message", e.getMessage());
            ok = false;
        }
        out.put("ok", ok);
        out.put("elapsedMs", (System.nanoTime() - t0) / 1_000_000);
        jdbc.sql("update hr_source set last_connection_ok = :ok, last_connection_at = :now where id = :id")
                .param("ok", ok).param("now", Db.ts(clock.instant())).param("id", src.get("id")).update();
        audit.recordAs(ctx.actor(), "HR_CONNECTION_TESTED", "HR_SOURCE", src.get("id").toString(), (String) src.get("name"),
                Map.of("ok", ok), null);
        return out;
    }

    // ---- mapping versions -------------------------------------------------------------------------------------

    public List<Map<String, Object>> contract() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (HrMapping.Canonical c : HrMapping.CANONICAL) {
            out.add(Map.of("entity", c.entity().name(), "field", c.field(), "required", c.required(), "label", c.label()));
        }
        return out;
    }

    public List<Map<String, Object>> mappings(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        return jdbc.sql("""
                select m.*, m.fields::text as f, m.active_rules::text as r, m.discovered_columns::text as d
                from hr_mapping_version m order by version desc limit 20""").query((rs, n) -> mappingView(rs)).list();
    }

    private Map<String, Object> mappingView(java.sql.ResultSet rs) throws java.sql.SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getString("id"));
        m.put("version", rs.getInt("version"));
        m.put("status", rs.getString("status"));
        m.put("fields", json.tree(rs.getString("f")));
        m.put("activeRules", json.tree(rs.getString("r")));
        m.put("discoveredColumns", rs.getString("d") == null ? null : json.tree(rs.getString("d")));
        m.put("discoveredAt", Db.iso(rs, "discovered_at"));
        m.put("publishedAt", Db.iso(rs, "published_at"));
        return m;
    }

    public record MappingInput(List<Map<String, Object>> fields, Map<String, Object> activeRules) {
    }

    /** Creates or replaces the single open draft. Without a body it copies the published version. */
    @Transactional
    public Map<String, Object> saveDraft(AccessContext ctx, MappingInput in) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> src = source();
        if (src == null) {
            throw new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED, "احفظ إعدادات المصدر أولاً.");
        }
        UUID sourceId = (UUID) src.get("id");
        Map<String, Object> published = jdbc.sql("""
                select fields::text as f, active_rules::text as r from hr_mapping_version where source_id = :s and status = 'PUBLISHED'""")
                .param("s", sourceId).query().listOfRows().stream().findFirst().orElse(null);
        String fields = in != null && in.fields() != null ? json.write(in.fields()) : published == null ? "[]" : (String) published.get("f");
        String rules = in != null && in.activeRules() != null ? json.write(in.activeRules()) : published == null ? "{}" : (String) published.get("r");
        HrMapping.Definition def = sync.definition(fields, rules);
        List<String> problems = HrMapping.structuralProblems(def);
        if (def.fields().stream().anyMatch(f -> HrMapping.canonical(f.entity(), f.field()) == null)) {
            throw ApiException.validation(String.join(" ", problems), Map.of("problems", problems));
        }
        Instant now = clock.instant();
        Map<String, Object> draft = jdbc.sql("select id from hr_mapping_version where source_id = :s and status = 'DRAFT'")
                .param("s", sourceId).query().listOfRows().stream().findFirst().orElse(null);
        UUID id;
        if (draft == null) {
            id = UUID.randomUUID();
            int version = jdbc.sql("select coalesce(max(version), 0) + 1 from hr_mapping_version where source_id = :s")
                    .param("s", sourceId).query(Integer.class).single();
            jdbc.sql("""
                    insert into hr_mapping_version(id, source_id, version, status, fields, active_rules, created_by, created_at)
                    values (:id, :s, :v, 'DRAFT', cast(:f as jsonb), cast(:r as jsonb), :by, :now)""")
                    .param("id", id).param("s", sourceId).param("v", version).param("f", fields).param("r", rules)
                    .param("by", ctx.personId()).param("now", Db.ts(now)).update();
        } else {
            id = (UUID) draft.get("id");
            jdbc.sql("update hr_mapping_version set fields = cast(:f as jsonb), active_rules = cast(:r as jsonb) where id = :id")
                    .param("f", fields).param("r", rules).param("id", id).update();
        }
        audit.recordAs(ctx.actor(), "HR_MAPPING_CHANGED", "HR_MAPPING", id.toString(), null, Map.of("problems", problems.size()), null);
        return mapping(id, problems);
    }

    private Map<String, Object> mapping(UUID id, List<String> problems) {
        Map<String, Object> m = jdbc.sql("""
                select m.*, m.fields::text as f, m.active_rules::text as r, m.discovered_columns::text as d
                from hr_mapping_version m where id = :id""").param("id", id).query((rs, n) -> mappingView(rs)).single();
        m.put("problems", problems);
        return m;
    }

    /** Reads the column names of both views from the source metadata and stores them on the draft. */
    @Transactional
    public Map<String, Object> discover(AccessContext ctx, UUID id) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> row = draftRow(id);
        Map<String, Object> src = jdbc.sql("select * from hr_source where id = :id").param("id", row.get("source_id")).query().singleRow();
        HrSourceAdapter.Config cfg = sync.config(src);
        Map<Entity, List<String>> discovered = new EnumMap<>(Entity.class);
        try (HrSourceAdapter.Session s = adapter.open(cfg)) {
            discovered.put(Entity.UNIT, s.columns(cfg.unitView()));
            discovered.put(Entity.PERSON, s.columns(cfg.personView()));
        } catch (HrSourceAdapter.SourceException e) {
            throw new ApiException(ErrorCode.HR_SOURCE_UNAVAILABLE, e.getMessage(), Map.of("failure", e.failure().name()));
        }
        jdbc.sql("update hr_mapping_version set discovered_columns = cast(:d as jsonb), discovered_at = :now where id = :id")
                .param("d", json.write(discovered)).param("now", Db.ts(clock.instant())).param("id", id).update();
        audit.recordAs(ctx.actor(), "HR_FIELDS_DISCOVERED", "HR_MAPPING", id.toString(), null,
                Map.of("unitColumns", discovered.get(Entity.UNIT).size(), "personColumns", discovered.get(Entity.PERSON).size()), null);
        return mapping(id, problemsOf(id));
    }

    private List<String> problemsOf(UUID id) {
        Map<String, Object> row = jdbc.sql("""
                select fields::text as f, active_rules::text as r, discovered_columns::text as d from hr_mapping_version where id = :id""")
                .param("id", id).query().singleRow();
        HrMapping.Definition def = sync.definition((String) row.get("f"), (String) row.get("r"));
        Map<Entity, List<String>> discovered = new EnumMap<>(Entity.class);
        if (row.get("d") != null) {
            JsonNode d = json.tree((String) row.get("d"));
            for (Entity e : Entity.values()) {
                List<String> cols = new ArrayList<>();
                d.path(e.name()).forEach(c -> cols.add(c.asText()));
                discovered.put(e, cols);
            }
        }
        return HrMapping.metadataProblems(def, discovered);
    }

    @Transactional
    public Map<String, Object> publish(AccessContext ctx, UUID id) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> row = draftRow(id);
        List<String> problems = problemsOf(id);
        if (!problems.isEmpty()) {
            throw new ApiException(ErrorCode.HR_CONTRACT_MISMATCH, "لا يمكن نشر التعيين: " + String.join("؛ ", problems),
                    Map.of("problems", problems));
        }
        Instant now = clock.instant();
        jdbc.sql("update hr_mapping_version set status = 'SUPERSEDED' where source_id = :s and status = 'PUBLISHED'")
                .param("s", row.get("source_id")).update();
        jdbc.sql("update hr_mapping_version set status = 'PUBLISHED', published_by = :by, published_at = :now where id = :id")
                .param("by", ctx.personId()).param("now", Db.ts(now)).param("id", id).update();
        audit.recordAs(ctx.actor(), "HR_MAPPING_PUBLISHED", "HR_MAPPING", id.toString(), null, Map.of(), null);
        return mapping(id, List.of());
    }

    private Map<String, Object> draftRow(UUID id) {
        Map<String, Object> row = jdbc.sql("select id, source_id, status from hr_mapping_version where id = :id")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!"DRAFT".equals(row.get("status"))) {
            throw ApiException.validation("الإصدارات المنشورة لا تُعدل؛ أنشئ مسودة جديدة.");
        }
        return row;
    }

    // ---- position seats ---------------------------------------------------------------------------------------

    public List<Map<String, Object>> seats(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        return jdbc.sql("""
                select ps.*, o.name as org_name, r.name as role_name,
                       (select count(*) from affiliation a where a.organization_id = ps.organization_id
                          and a.position_id = ps.position_id and a.valid_to is null) as occupants
                from position_seat ps join organization o on o.id = ps.organization_id join role_def r on r.code = ps.role_code
                order by o.name, ps.name""").query((rs, n) -> {
                    UUID org = Db.uuid(rs, "organization_id");
                    if (!ctx.canFor(Permission.MANAGE_ACCESS, org)) {
                        return null;
                    }
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("organization", Map.of("id", org.toString(), "name", rs.getString("org_name")));
                    m.put("positionId", rs.getString("position_id"));
                    m.put("name", rs.getString("name"));
                    m.put("role", Map.of("code", rs.getString("role_code"), "name", rs.getString("role_name")));
                    m.put("active", rs.getBoolean("active"));
                    m.put("occupants", rs.getInt("occupants"));
                    return m;
                }).list().stream().filter(java.util.Objects::nonNull).toList();
    }

    public record SeatInput(String organizationId, String positionId, String name, String roleCode, String siteScopeId) {
    }

    @Transactional
    public Map<String, Object> createSeat(AccessContext ctx, SeatInput in) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (in == null || in.organizationId() == null || in.positionId() == null || in.positionId().isBlank()
                || in.name() == null || in.name().isBlank() || in.roleCode() == null) {
            throw ApiException.validation("حدد الجهة والمنصب والاسم والدور.");
        }
        UUID org = UUID.fromString(in.organizationId());
        if (!ctx.canFor(Permission.MANAGE_ACCESS, org)) {
            throw ApiException.forbidden("لا تملك إدارة الصلاحيات على هذه الجهة.");
        }
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("""
                    insert into position_seat(id, organization_id, position_id, name, role_code, site_scope_id, created_by)
                    values (:id, :o, :p, :n, :r, :s, :by)""")
                    .param("id", id).param("o", org).param("p", in.positionId().trim()).param("n", in.name().trim())
                    .param("r", in.roleCode()).param("s", in.siteScopeId() == null ? null : UUID.fromString(in.siteScopeId()))
                    .param("by", ctx.personId()).update();
        } catch (org.springframework.dao.DataAccessException e) {
            throw ApiException.validation("تعذر حفظ مقعد المسؤولية: الدور غير موجود أو المقعد مكرر.");
        }
        audit.recordAs(ctx.actor(), "POSITION_SEAT_CREATED", "POSITION_SEAT", id.toString(), in.name(),
                Map.of("role", in.roleCode(), "organizationId", org.toString()), null);
        return Map.of("id", id.toString());
    }

    @Transactional
    public void deactivateSeat(AccessContext ctx, UUID id, String reason) {
        ctx.require(Permission.MANAGE_ACCESS);
        Map<String, Object> seat = jdbc.sql("select organization_id from position_seat where id = :id and active").param("id", id)
                .query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.canFor(Permission.MANAGE_ACCESS, (UUID) seat.get("organization_id"))) {
            throw ApiException.notFound();
        }
        jdbc.sql("update position_seat set active = false where id = :id").param("id", id).update();
        audit.recordAs(ctx.actor(), "POSITION_SEAT_DEACTIVATED", "POSITION_SEAT", id.toString(), null, Map.of(), reason);
    }

    // ---- local additions --------------------------------------------------------------------------------------

    public record LocalInput(String displayName, List<String> tags, String note) {
    }

    /** Local display name, tags and note for an organisation; HR originals are untouched and survive every sync. */
    @Transactional
    public Map<String, Object> saveLocal(AccessContext ctx, UUID orgId, LocalInput in) {
        ctx.require(Permission.CONFIGURE);
        jdbc.sql("select id from organization where id = :id").param("id", orgId).query().listOfRows().stream().findFirst()
                .orElseThrow(ApiException::notFound);
        String name = in == null || in.displayName() == null || in.displayName().isBlank() ? null : in.displayName().trim();
        jdbc.sql("""
                insert into local_metadata(entity_type, entity_id, display_name, tags, note, updated_by, updated_at)
                values ('ORGANIZATION', :id, :n, string_to_array(:t, ','), :note, :by, :now)
                on conflict (entity_type, entity_id) do update set display_name = :n, tags = string_to_array(:t, ','), note = :note,
                    updated_by = :by, updated_at = :now""")
                .param("id", orgId).param("n", name).param("t", in == null || in.tags() == null ? "" : String.join(",", in.tags()))
                .param("note", in == null ? null : in.note()).param("by", ctx.personId()).param("now", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), "LOCAL_METADATA_CHANGED", "ORGANIZATION", orgId.toString(), name, Map.of(), null);
        return Map.of("organizationId", orgId.toString(), "displayName", name == null ? "" : name);
    }
}
