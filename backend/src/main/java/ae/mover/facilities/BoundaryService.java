package ae.mover.facilities;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import ae.mover.common.Json;
import ae.mover.common.Ref;

/**
 * Versioned site boundaries. A boundary is registered by an authorised facility manager — drawn, entered as coordinates
 * or imported from a declared file format — and every change creates a new version with its reason, author and
 * original input. A save based on a version that has since changed is refused. Sites without a registered boundary keep
 * only their marker; nothing here ever produces a shape around a point.
 */
@Service
public class BoundaryService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final SiteService sites;
    private final AuditService audit;

    public BoundaryService(JdbcClient jdbc, Json json, Clock clock, SiteService sites, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.sites = sites;
        this.audit = audit;
    }

    // ---- validation ---------------------------------------------------------------------------------------

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Check(boolean valid, String type, int vertices, Double areaM2, List<String> problems, JsonNode normalized,
                        List<Double> bbox, String crs, String transform) {
    }

    /**
     * Structural check in Java, then validity, transformation to EPSG:4326 and area in PostGIS. Invalid geometry is
     * reported with PostGIS's reason so it can be fixed at the source; it is never repaired silently.
     */
    public Check check(JsonNode geometry, String crs) {
        String key;
        try {
            key = GeoInput.normaliseCrs(crs);
        } catch (IllegalArgumentException e) {
            return new Check(false, null, 0, null, List.of(e.getMessage()), null, null, crs, null);
        }
        if (key == null) {
            return new Check(false, null, 0, null,
                    List.of("لم يُحدَّد نظام الإحداثيات (CRS). اختره صراحةً؛ لا يُستنتج من شكل الأرقام."), null, null, null, null);
        }
        GeoInput.Candidate c = GeoInput.candidate(0, null, null, geometry);
        if (!c.problems().isEmpty()) {
            return new Check(false, c.type(), c.vertices(), null, c.problems(), null, null, key, null);
        }
        return checkClean(c.geometry(), key, c.vertices());
    }

    private Check checkClean(JsonNode clean, String crsKey, int vertices) {
        int srid = GeoInput.SUPPORTED_CRS.get(crsKey);
        String transform = srid == 4326 ? "لا تحويل (EPSG:4326)"
                : "تحويل " + crsKey + " ← EPSG:4326 عبر PostGIS ST_Transform (PROJ، بيانات محلية)";
        Map<String, Object> r;
        try {
            r = jdbc.sql("""
                    with raw as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), :srid) as g)
                    select GeometryType(g) as t, ST_IsValid(g) as ok, ST_IsValidReason(g) as why
                    from raw""").param("g", json.write(clean)).param("srid", srid).query().singleRow();
        } catch (DataAccessException e) {
            return new Check(false, clean.path("type").asText(), vertices, null,
                    List.of("تعذر قراءة الهندسة في PostGIS؛ تحقق من بنية الإحداثيات."), null, null, crsKey, transform);
        }
        if (!Boolean.TRUE.equals(r.get("ok"))) {
            return new Check(false, clean.path("type").asText(), vertices, null,
                    List.of("هندسة غير صالحة: " + explainInvalid((String) r.get("why"))), null, null, crsKey, transform);
        }
        Map<String, Object> t;
        try {
            t = jdbc.sql("""
                    with g as (select ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(:g), :srid), 4326) as g)
                    select ST_AsGeoJSON(g, 9) as gj, ST_Area(g::geography) as area,
                           ST_XMin(g) as x1, ST_YMin(g) as y1, ST_XMax(g) as x2, ST_YMax(g) as y2 from g""")
                    .param("g", json.write(clean)).param("srid", srid).query().singleRow();
        } catch (DataAccessException e) {
            return new Check(false, clean.path("type").asText(), vertices, null,
                    List.of("تعذر تحويل الإحداثيات من " + crsKey + "؛ القيم خارج نطاق هذا النظام."), null, null, crsKey, transform);
        }
        double x1 = ((Number) t.get("x1")).doubleValue();
        double y1 = ((Number) t.get("y1")).doubleValue();
        double x2 = ((Number) t.get("x2")).doubleValue();
        double y2 = ((Number) t.get("y2")).doubleValue();
        if (x1 < -180 || x2 > 180 || y1 < -90 || y2 > 90) {
            return new Check(false, clean.path("type").asText(), vertices, null,
                    List.of("الإحداثيات خارج نطاق خطوط الطول والعرض بعد التفسير بنظام " + crsKey
                            + ". تحقق من النظام المعلن وترتيب المحاور (x = خط الطول، y = خط العرض)."), null, null, crsKey, transform);
        }
        double area = ((Number) t.get("area")).doubleValue();
        if (area <= 0) {
            return new Check(false, clean.path("type").asText(), vertices, null, List.of("مساحة المضلع صفرية."), null, null, crsKey, transform);
        }
        return new Check(true, clean.path("type").asText(), vertices, area, List.of(), json.tree((String) t.get("gj")),
                List.of(x1, y1, x2, y2), crsKey, transform);
    }

    private static String explainInvalid(String reason) {
        if (reason == null) {
            return "سبب غير معروف";
        }
        if (reason.startsWith("Self-intersection")) {
            return "تقاطع ذاتي في حدود المضلع " + reason.substring("Self-intersection".length()).trim() + " (Self-intersection)";
        }
        if (reason.startsWith("Ring Self-intersection")) {
            return "حلقة تتقاطع مع نفسها " + reason.substring("Ring Self-intersection".length()).trim();
        }
        if (reason.startsWith("Too few points")) {
            return "عدد نقاط غير كافٍ (Too few points)";
        }
        if (reason.startsWith("Hole lies outside shell")) {
            return "فراغ داخلي خارج الحد الخارجي (Hole lies outside shell)";
        }
        if (reason.startsWith("Nested shells")) {
            return "جزء من الحدود يقع داخل جزء آخر؛ احذف أحدهما أو ابدأ رسماً جديداً (Nested shells)";
        }
        if (reason.startsWith("Nested holes")) {
            return "فراغ داخلي يقع داخل فراغ آخر (Nested holes)";
        }
        if (reason.startsWith("Interior is disconnected")) {
            return "الفراغات تقسم المضلع إلى أجزاء منفصلة (Interior is disconnected)";
        }
        if (reason.startsWith("Duplicate Rings")) {
            return "حلقات مكررة في الشكل (Duplicate Rings)";
        }
        return reason;
    }

    // ---- publish one site ---------------------------------------------------------------------------------

    /** Geometry arrives as a plain GeoJSON object (HTTP bodies are read with Jackson 3; see ADR-011). */
    public record SaveInput(Map<String, Object> geometry, String crs, Integer expectedVersion, String reason, String method) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record VersionView(String siteId, int version, String type, String crs, String source, String format,
                              String originalCrs, String transform, String reason, Ref createdBy, String createdAt,
                              String importJobId, JsonNode geojson, Double areaM2) {
    }

    /** Draw/edit/coordinate entry: one site, one new version, compared against the version the editor started from. */
    @Transactional
    public VersionView save(AccessContext ctx, UUID siteId, SaveInput in) {
        if (in == null || in.geometry() == null) {
            throw ApiException.validation("أرسل حدود الموقع.");
        }
        String method = in.method() == null ? "DRAWN" : in.method();
        if (!Set.of("DRAWN", "COORDINATES").contains(method)) {
            throw ApiException.validation("طريقة الإدخال يجب أن تكون DRAWN أو COORDINATES.");
        }
        Check c = check(json.tree((Object) in.geometry()), in.crs());
        if (!c.valid()) {
            throw ApiException.validation(c.problems().get(0), Map.of("problems", c.problems()));
        }
        return publishVersion(ctx, siteId, c, in.expectedVersion(), in.reason(), method, in.crs(),
                json.write(in.geometry()), null, null);
    }

    private VersionView publishVersion(AccessContext ctx, UUID siteId, Check c, Integer expectedVersion, String reason,
                                       String format, String originalCrs, String originalContent, String fileName, UUID jobId) {
        String why = reason == null ? "" : reason.trim();
        if (why.length() < 5) {
            throw ApiException.validation("اكتب سبب تغيير الحدود (5 أحرف على الأقل).");
        }
        if (expectedVersion == null) {
            throw ApiException.validation("حدد إصدار الحدود الذي بدأ منه التعديل (0 إن لم توجد حدود).");
        }
        Map<String, Object> site = jdbc.sql("""
                select s.id, s.code, s.name, s.status, coalesce(s.geometry_version, 0) as gv, sr.organization_id
                from site s left join site_responsibility sr on sr.site_id = s.id and sr.valid_to is null
                where s.id = :id for update of s""").param("id", siteId).query().listOfRows().stream().findFirst()
                .orElseThrow(ApiException::notFound);
        UUID org = (UUID) site.get("organization_id");
        if (ctx.siteView(siteId, Set.of(), org) == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        SiteService.requireFacilityManager(ctx, org);
        if (!"ACTIVE".equals(site.get("status"))) {
            throw ApiException.validation("الموقع موقوف؛ لا تُسجل له حدود جديدة.");
        }
        int current = ((Number) site.get("gv")).intValue();
        if (current != expectedVersion) {
            throw new ApiException(ErrorCode.GEOMETRY_STALE, "تغيّرت حدود «" + site.get("name") + "» في الخادم (الإصدار الحالي "
                    + current + ") بعد بدء التعديل من الإصدار " + expectedVersion
                    + ". لم يُحفظ شيء؛ أعد تحميل الحدود الحالية ثم كرر التعديل.",
                    Map.of("siteId", siteId.toString(), "currentVersion", current, "expectedVersion", expectedVersion));
        }
        int next = jdbc.sql("select coalesce(max(version), 0) + 1 from site_geometry_version where site_id = :s")
                .param("s", siteId).query(Integer.class).single();
        Instant now = clock.instant();
        String source = switch (format) {
            case "DRAWN" -> "رسم إداري على الخريطة";
            case "COORDINATES" -> "إدخال إحداثيات";
            case "GEOJSON" -> "استيراد GeoJSON" + (fileName == null ? "" : " — " + fileName);
            case "KML" -> "استيراد KML" + (fileName == null ? "" : " — " + fileName);
            default -> format;
        };
        jdbc.sql("""
                insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type,
                    original_format, original_crs, original_content, original_sha256, source_file_name, transform, reason,
                    created_by, import_job_id)
                values (:id, :s, :v, cast(:g as jsonb), 'EPSG:4326', :src, :now, ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326), :t,
                    :fmt, :ocrs, :orig, :osha, :fname, :tr, :why, :by, :job)""")
                .param("id", UUID.randomUUID()).param("s", siteId).param("v", next).param("g", json.write(c.normalized()))
                .param("src", source).param("now", Db.ts(now)).param("t", c.type()).param("fmt", format)
                .param("ocrs", originalCrs).param("orig", originalContent)
                .param("osha", originalContent == null ? null : Hashing.sha256(originalContent))
                .param("fname", fileName).param("tr", c.transform()).param("why", why).param("by", ctx.personId())
                .param("job", jobId).update();
        jdbc.sql("update site set geometry_version = :v, version = version + 1 where id = :id")
                .param("v", next).param("id", siteId).update();
        audit.recordAs(ctx.actor(), "SITE_BOUNDARY_PUBLISHED", "SITE", siteId.toString(), (String) site.get("name"),
                Map.of("version", next, "previousVersion", current, "type", c.type(), "method", format,
                        "vertices", c.vertices(), "areaM2", Math.round(c.areaM2())), why);
        return version(ctx, siteId, next);
    }

    // ---- read ---------------------------------------------------------------------------------------------

    /** A stored version (immutable). Visible to anyone who can view the site; author names only to its managers. */
    public VersionView version(AccessContext ctx, UUID siteId, int version) {
        Map<String, Object> s = requireVisible(ctx, siteId);
        boolean manager = canManage(ctx, (UUID) s.get("organization_id"));
        return jdbc.sql("""
                select g.*, ST_Area(g.geom::geography) as area, p.display_name from site_geometry_version g
                left join person p on p.id = g.created_by where g.site_id = :s and g.version = :v""")
                .param("s", siteId).param("v", version)
                .query((rs, n) -> new VersionView(siteId.toString(), rs.getInt("version"), rs.getString("geometry_type"),
                        rs.getString("crs"), rs.getString("source"), rs.getString("original_format"),
                        rs.getString("original_crs"), rs.getString("transform"), manager ? rs.getString("reason") : null,
                        manager && rs.getString("created_by") != null ? Ref.of(Db.uuid(rs, "created_by"), rs.getString("display_name")) : null,
                        Db.iso(rs, "valid_from"), manager ? rs.getString("import_job_id") : null,
                        json.tree(rs.getString("geojson")), "Point".equals(rs.getString("geometry_type")) ? null : rs.getDouble("area")))
                .optional().orElseThrow(ApiException::notFound);
    }

    /** Version history without coordinates (newest first). */
    public List<VersionView> history(AccessContext ctx, UUID siteId) {
        Map<String, Object> s = requireVisible(ctx, siteId);
        boolean manager = canManage(ctx, (UUID) s.get("organization_id"));
        return jdbc.sql("""
                select g.version, g.geometry_type, g.crs, g.source, g.original_format, g.original_crs, g.transform, g.reason,
                       g.created_by, g.valid_from, g.import_job_id, ST_Area(g.geom::geography) as area, p.display_name
                from site_geometry_version g left join person p on p.id = g.created_by
                where g.site_id = :s order by g.version desc""").param("s", siteId)
                .query((rs, n) -> new VersionView(siteId.toString(), rs.getInt("version"), rs.getString("geometry_type"),
                        rs.getString("crs"), rs.getString("source"), rs.getString("original_format"), rs.getString("original_crs"),
                        rs.getString("transform"), manager ? rs.getString("reason") : null,
                        manager && rs.getString("created_by") != null ? Ref.of(Db.uuid(rs, "created_by"), rs.getString("display_name")) : null,
                        Db.iso(rs, "valid_from"), manager ? rs.getString("import_job_id") : null, null,
                        "Point".equals(rs.getString("geometry_type")) ? null : rs.getDouble("area"))).list();
    }

    private Map<String, Object> requireVisible(AccessContext ctx, UUID siteId) {
        Map<String, Object> s = jdbc.sql("""
                select s.id, sr.organization_id from site s
                left join site_responsibility sr on sr.site_id = s.id and sr.valid_to is null where s.id = :id""")
                .param("id", siteId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (ctx.siteView(siteId, Set.of(), (UUID) s.get("organization_id")) == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        return s;
    }

    static boolean canManage(AccessContext ctx, UUID orgId) {
        try {
            SiteService.requireFacilityManager(ctx, orgId);
            return true;
        } catch (ApiException e) {
            return false;
        }
    }

    /**
     * Boundary versions recorded in a request revision, read from the immutable version rows. Later edits of the site
     * record do not change what the revision shows.
     */
    public List<Map<String, Object>> pinned(List<Map<String, Object>> snapshot) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> b : snapshot) {
            Map<String, Object> m = new LinkedHashMap<>(b);
            Object v = b.get("version");
            m.put("geojson", null);
            if (v != null && !"Point".equals(b.get("type"))) {
                jdbc.sql("select geojson::text from site_geometry_version where site_id = :s and version = :v")
                        .param("s", UUID.fromString((String) b.get("siteId"))).param("v", ((Number) v).intValue())
                        .query(String.class).optional().ifPresent(g -> m.put("geojson", json.tree(g)));
            }
            Integer now = jdbc.sql("select geometry_version from site where id = :s")
                    .param("s", UUID.fromString((String) b.get("siteId"))).query(Integer.class).optional().orElse(null);
            m.put("currentVersion", now);
            out.add(m);
        }
        return out;
    }

    /** Boundary versions in force for the sites of the given resources (stored with each submitted revision). */
    public List<Map<String, Object>> snapshot(List<UUID> resourceIds) {
        if (resourceIds.isEmpty()) {
            return List.of();
        }
        return jdbc.sql("""
                select distinct s.id, s.code, s.name, s.geometry_version, g.geometry_type from resource r
                join site s on s.id = r.site_id
                left join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version
                where r.id = any(string_to_array(:ids, ',')::uuid[]) order by s.code""")
                .param("ids", Db.ids(resourceIds)).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("siteId", rs.getString("id"));
                    m.put("siteCode", rs.getString("code"));
                    m.put("siteName", rs.getString("name"));
                    m.put("version", rs.getObject("geometry_version"));
                    m.put("type", rs.getString("geometry_type") == null ? "NONE" : rs.getString("geometry_type"));
                    return m;
                }).list();
    }

    // ---- imports --------------------------------------------------------------------------------------------

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ImportFeature(int index, String siteCode, String label, String siteId, String siteName, String type,
                                int vertices, Double areaM2, Integer currentVersion, List<String> problems, JsonNode geojson) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ImportJob(String id, String fileName, String format, String declaredCrs, String fileCrs, String effectiveCrs,
                            String axisOrder, String status, boolean publishable, List<String> fileProblems,
                            List<ImportFeature> features, String createdAt, String decidedAt, String reason) {
    }

    /**
     * Preview: parse, resolve the CRS (from the file, or the explicit declaration when the file has none), link each
     * shape to a site record by its code and validate it. A file with any problem is REJECTED as a whole. Not one
     * transaction: a PostGIS error on one shape is reported for that shape instead of aborting the others.
     */
    public ImportJob preview(AccessContext ctx, String fileName, byte[] bytes, String declaredCrs, UUID targetSiteId) {
        ctx.require(Permission.MANAGE_FACILITIES);
        if (bytes == null || bytes.length == 0) {
            throw ApiException.validation("اختر ملف الحدود.");
        }
        if (bytes.length > GeoInput.MAX_BYTES) {
            throw ApiException.validation("حجم ملف الحدود يتجاوز 5 ميغابايت.");
        }
        String safeName = fileName == null ? "boundaries" : fileName.replaceAll("[\\\\/]", "_");
        if (safeName.length() > 120) {
            safeName = safeName.substring(0, 120);
        }
        String format;
        try {
            format = GeoInput.format(safeName);
        } catch (IllegalArgumentException e) {
            throw ApiException.validation(e.getMessage(), Map.of("problems", List.of(e.getMessage())));
        }
        GeoInput.Parsed parsed = GeoInput.parse(format, bytes);
        List<String> fileProblems = new ArrayList<>(parsed.fileProblems());
        String declared = null;
        try {
            declared = GeoInput.normaliseCrs(declaredCrs);
        } catch (IllegalArgumentException e) {
            fileProblems.add(e.getMessage());
        }
        String effective = parsed.fileCrs() != null ? parsed.fileCrs() : declared;
        if (parsed.fileCrs() != null && declared != null && !parsed.fileCrs().equals(declared)) {
            fileProblems.add("النظام المعلن (" + declared + ") يختلف عن النظام المعرّف في الملف (" + parsed.fileCrs() + ").");
        }
        if (effective == null && fileProblems.isEmpty()) {
            fileProblems.add("نظام الإحداثيات (CRS) غير معرّف في الملف ولم يُعلن عند الرفع. اختره صراحةً؛ لا يُخمَّن من الأرقام.");
        }
        if (targetSiteId != null && parsed.candidates().size() > 1) {
            fileProblems.add("الملف يحتوي أكثر من شكل؛ استخدم رمز الموقع site_code لكل شكل بدلاً من ربطه بموقع واحد.");
        }
        List<ImportFeature> features = new ArrayList<>();
        List<Map<String, Object>> candidates = new ArrayList<>();
        Set<UUID> seen = new HashSet<>();
        for (GeoInput.Candidate c : parsed.candidates()) {
            List<String> problems = new ArrayList<>(c.problems());
            Map<String, Object> site = null;
            if (targetSiteId != null && parsed.candidates().size() == 1) {
                site = siteForImport(ctx, "id", targetSiteId, problems);
            } else if (c.siteCode() == null) {
                problems.add("لا يحمل الشكل رمز موقع (site_code) يربطه بسجل.");
            } else {
                site = siteForImport(ctx, "code", c.siteCode(), problems);
            }
            if (site != null && !seen.add((UUID) site.get("id"))) {
                problems.add("الموقع مذكور في أكثر من شكل في الملف نفسه.");
            }
            Check check = null;
            if (problems.isEmpty() && c.geometry() != null && effective != null && fileProblems.isEmpty()) {
                check = checkClean(c.geometry(), effective, c.vertices());
                problems.addAll(check.problems());
            }
            Integer currentVersion = site == null ? null : ((Number) site.get("gv")).intValue();
            features.add(new ImportFeature(c.index(), c.siteCode(), c.label(), site == null ? null : site.get("id").toString(),
                    site == null ? null : (String) site.get("name"), c.type(), c.vertices(),
                    check != null && check.valid() ? check.areaM2() : null, currentVersion, problems,
                    check != null && check.valid() ? check.normalized() : null));
            if (check != null && check.valid() && site != null) {
                Map<String, Object> cand = new LinkedHashMap<>();
                cand.put("siteId", site.get("id").toString());
                cand.put("expectedVersion", currentVersion);
                cand.put("geometry", check.normalized());
                cand.put("type", check.type());
                cand.put("vertices", check.vertices());
                cand.put("areaM2", check.areaM2());
                cand.put("transform", check.transform());
                cand.put("original", c.geometry());
                candidates.add(cand);
            }
        }
        boolean publishable = fileProblems.isEmpty() && !features.isEmpty()
                && features.stream().allMatch(f -> f.problems().isEmpty()) && candidates.size() == features.size();
        UUID id = UUID.randomUUID();
        String status = publishable ? "PREVIEWED" : "REJECTED";
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("fileProblems", fileProblems);
        report.put("features", features.stream().map(f -> {
            Map<String, Object> m = json.map(f);
            m.remove("geojson");
            return m;
        }).toList());
        report.put("declaredCrs", declared);
        report.put("fileCrs", parsed.fileCrs());
        String text = new String(bytes, StandardCharsets.UTF_8);
        jdbc.sql("""
                insert into map_import_job(id, file_name, format, declared_crs, effective_crs, status, report, candidates,
                    original_sha256, original_content, target_site_id, created_by, created_at)
                values (:id, :f, :fmt, :d, :e, :st, cast(:r as jsonb), cast(:c as jsonb), :sha, :orig, :target, :by, :now)""")
                .param("id", id).param("f", safeName).param("fmt", format).param("d", declared).param("e", effective)
                .param("st", status).param("r", json.write(report)).param("c", json.write(candidates))
                .param("sha", Hashing.sha256(bytes)).param("orig", text.length() <= 1_000_000 ? text : null)
                .param("target", targetSiteId).param("by", ctx.personId()).param("now", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), publishable ? "MAP_IMPORT_PREVIEWED" : "MAP_IMPORT_REJECTED", "MAP_IMPORT", id.toString(),
                safeName, Map.of("format", format, "features", features.size(),
                        "problems", fileProblems.size() + features.stream().mapToInt(f -> f.problems().size()).sum()), null);
        return job(ctx, id, features);
    }

    private Map<String, Object> siteForImport(AccessContext ctx, String by, Object value, List<String> problems) {
        Map<String, Object> s = jdbc.sql("""
                select s.id, s.code, s.name, s.status, coalesce(s.geometry_version, 0) as gv, sr.organization_id
                from site s left join site_responsibility sr on sr.site_id = s.id and sr.valid_to is null
                where s.""" + ("id".equals(by) ? "id" : "code") + " = :v").param("v", value).query().listOfRows().stream()
                .findFirst().orElse(null);
        if (s == null || ctx.siteView((UUID) s.get("id"), Set.of(), (UUID) s.get("organization_id")) == ViewLevel.NONE) {
            problems.add("رمز الموقع «" + value + "» غير موجود أو خارج نطاقك.");
            return null;
        }
        if (!canManage(ctx, (UUID) s.get("organization_id"))) {
            problems.add("لا تملك إدارة مرافق الموقع «" + s.get("name") + "».");
            return null;
        }
        if (!"ACTIVE".equals(s.get("status"))) {
            problems.add("الموقع «" + s.get("name") + "» موقوف.");
            return null;
        }
        return s;
    }

    public ImportJob job(AccessContext ctx, UUID id) {
        return job(ctx, id, null);
    }

    private ImportJob job(AccessContext ctx, UUID id, List<ImportFeature> withGeometry) {
        Map<String, Object> j = jdbc.sql("select *, report::text as r, candidates::text as c from map_import_job where id = :id")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.personId().equals(j.get("created_by"))
                && ctx.grants().stream().noneMatch(g -> g.has(Permission.MANAGE_FACILITIES) && g.isAll())) {
            throw ApiException.notFound();
        }
        JsonNode report = json.tree((String) j.get("r"));
        List<ImportFeature> features = withGeometry;
        if (features == null) {
            Map<String, JsonNode> geo = new HashMap<>();
            json.tree((String) j.get("c")).forEach(c -> geo.put(c.path("siteId").asText(), c.path("geometry")));
            features = new ArrayList<>();
            for (JsonNode f : report.path("features")) {
                List<String> problems = new ArrayList<>();
                f.path("problems").forEach(p -> problems.add(p.asText()));
                String siteId = f.path("siteId").isTextual() ? f.path("siteId").asText() : null;
                features.add(new ImportFeature(f.path("index").asInt(), text(f, "siteCode"), text(f, "label"), siteId,
                        text(f, "siteName"), text(f, "type"), f.path("vertices").asInt(),
                        f.path("areaM2").isNumber() ? f.path("areaM2").asDouble() : null,
                        f.path("currentVersion").isNumber() ? f.path("currentVersion").asInt() : null, problems,
                        siteId == null ? null : geo.get(siteId)));
            }
        }
        List<String> fileProblems = new ArrayList<>();
        report.path("fileProblems").forEach(p -> fileProblems.add(p.asText()));
        String status = (String) j.get("status");
        return new ImportJob(id.toString(), (String) j.get("file_name"), (String) j.get("format"), (String) j.get("declared_crs"),
                text(report, "fileCrs"), (String) j.get("effective_crs"), "GeoJSON/KML: x = خط الطول (أو الإحداثي الشرقي)، y = خط العرض (أو الشمالي)",
                status, "PREVIEWED".equals(status), fileProblems, features, Db.toInstant(j.get("created_at")).toString(),
                j.get("decided_at") == null ? null : Db.toInstant(j.get("decided_at")).toString(), (String) j.get("reason"));
    }

    private static String text(JsonNode n, String key) {
        return n.path(key).isTextual() ? n.path(key).asText() : null;
    }

    /** All shapes of a previewed job, or none: any stale version or lost permission aborts the whole publish. */
    @Transactional
    public ImportJob publish(AccessContext ctx, UUID id, String reason) {
        Map<String, Object> j = jdbc.sql("select id, status, created_by, file_name, format, effective_crs, candidates::text as c "
                        + "from map_import_job where id = :id for update").param("id", id).query().listOfRows().stream().findFirst()
                .orElseThrow(ApiException::notFound);
        if (!ctx.personId().equals(j.get("created_by"))
                && ctx.grants().stream().noneMatch(g -> g.has(Permission.MANAGE_FACILITIES) && g.isAll())) {
            throw ApiException.notFound();
        }
        if (!"PREVIEWED".equals(j.get("status"))) {
            throw ApiException.validation("لا يمكن نشر هذا الاستيراد في حالته الحالية (" + j.get("status") + ").");
        }
        String format = (String) j.get("format");
        int count = 0;
        for (JsonNode c : json.tree((String) j.get("c"))) {
            Check check = new Check(true, c.path("type").asText(), c.path("vertices").asInt(), c.path("areaM2").asDouble(),
                    List.of(), c.path("geometry"), null, (String) j.get("effective_crs"), c.path("transform").asText());
            publishVersion(ctx, UUID.fromString(c.path("siteId").asText()), check, c.path("expectedVersion").asInt(), reason,
                    format, (String) j.get("effective_crs"), json.write(c.path("original")), (String) j.get("file_name"), id);
            count++;
        }
        jdbc.sql("update map_import_job set status = 'PUBLISHED', decided_by = :by, decided_at = :now, reason = :r where id = :id")
                .param("by", ctx.personId()).param("now", Db.ts(clock.instant())).param("r", reason.trim()).param("id", id).update();
        audit.recordAs(ctx.actor(), "MAP_IMPORT_PUBLISHED", "MAP_IMPORT", id.toString(), (String) j.get("file_name"),
                Map.of("sites", count), reason);
        return job(ctx, id);
    }

    @Transactional
    public ImportJob cancel(AccessContext ctx, UUID id) {
        ImportJob current = job(ctx, id);
        if (!"PREVIEWED".equals(current.status()) && !"REJECTED".equals(current.status())) {
            throw ApiException.validation("لا يمكن إلغاء هذا الاستيراد في حالته الحالية.");
        }
        jdbc.sql("update map_import_job set status = 'CANCELLED', decided_by = :by, decided_at = :now where id = :id")
                .param("by", ctx.personId()).param("now", Db.ts(clock.instant())).param("id", id).update();
        audit.recordAs(ctx.actor(), "MAP_IMPORT_CANCELLED", "MAP_IMPORT", id.toString(), current.fileName(), Map.of(), null);
        return job(ctx, id);
    }

    // ---- export ---------------------------------------------------------------------------------------------

    /** Current boundaries of the sites the actor may view, as GeoJSON (EXPORT right required, audited). */
    public Map<String, Object> export(AccessContext ctx) {
        ctx.require(Permission.EXPORT);
        List<Map<String, Object>> features = new ArrayList<>();
        Set<String> visible = new HashSet<>();
        for (SiteService.SiteView s : sites.list(ctx)) {
            if (!SiteService.CONTEXT.equals(s.view())) {
                visible.add(s.id());
            }
        }
        jdbc.sql("""
                select s.id, s.code, s.name, g.version, g.geometry_type, g.geojson::text as gj from site s
                join site_geometry_version g on g.site_id = s.id and g.version = s.geometry_version
                where s.status = 'ACTIVE' and g.geometry_type <> 'Point' order by s.code""").query((rs, n) -> {
            if (visible.contains(rs.getString("id"))) {
                Map<String, Object> props = new LinkedHashMap<>();
                props.put("site_code", rs.getString("code"));
                props.put("name", rs.getString("name"));
                props.put("boundary_version", rs.getInt("version"));
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("type", "Feature");
                f.put("properties", props);
                f.put("geometry", json.tree(rs.getString("gj")));
                features.add(f);
            }
            return null;
        }).list();
        audit.recordAs(ctx.actor(), "MAP_BOUNDARIES_EXPORTED", "MAP", "boundaries", null, Map.of("features", features.size()), null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("type", "FeatureCollection");
        out.put("crs", Map.of("type", "name", "properties", Map.of("name", "urn:ogc:def:crs:OGC:1.3:CRS84")));
        out.put("features", features);
        return out;
    }
}
