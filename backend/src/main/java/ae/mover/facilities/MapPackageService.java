package ae.mover.facilities;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Hashing;
import ae.mover.common.Json;

/**
 * Local map packages. Built-in packages ship with the image; further packages are uploaded by an authorised map manager,
 * checked (manifest, checksums, safe archive, renderable format), reviewed and only then activated. Every package states
 * source, licence, date, coverage, zoom range, CRS, version and checksums. Nothing is fetched from a network.
 */
@Service
public class MapPackageService {

    private static final Logger log = LoggerFactory.getLogger(MapPackageService.class);

    /** Formats with an implemented renderer in the web client; anything else is refused at upload. */
    static final Set<String> FORMATS = Set.of("SVG_OVERLAY", "RASTER_IMAGE", "GEOJSON");
    static final Set<String> KINDS = Set.of("ROADS", "AERIAL", "FACILITY_PLAN");
    private static final Pattern CODE = Pattern.compile("[a-z0-9][a-z0-9-]{1,59}");
    private static final Pattern VERSION = Pattern.compile("[A-Za-z0-9._-]{1,30}");
    private static final Pattern FILE = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,99}");
    static final long MAX_UPLOAD = 25L * 1024 * 1024;
    static final long MAX_ENTRY = 50L * 1024 * 1024;
    static final long MAX_TOTAL = 120L * 1024 * 1024;
    static final int MAX_ENTRIES = 20;
    static final int MAX_RATIO = 100;

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final Path builtinRoot;
    private final Path managedRoot;

    public MapPackageService(JdbcClient jdbc, Json json, Clock clock, AuditService audit,
                             @Value("${mover.map.root}") String mapRoot,
                             @Value("${mover.map.managed-root:${mover.storage.root}/map-packages}") String managedRoot) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.builtinRoot = Path.of(mapRoot).toAbsolutePath().normalize();
        this.managedRoot = Path.of(managedRoot).toAbsolutePath().normalize();
    }

    public record Coverage(double minLat, double minLng, double maxLat, double maxLng) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MapPackage(String id, String code, String name, String source, String license, String attributionHtml,
                             Coverage coverage, String crs, String version, String dataDate, String format, String role,
                             String kind, Double minZoom, Double maxZoom, String status, String storage, String sha256,
                             String statusReason, String contentUrl) {
    }

    // ---- built-in -------------------------------------------------------------------------------------------

    /** Registers built-in packages whose checksums verify and refreshes their declared metadata (not their status). */
    @Transactional
    public void installBuiltin() {
        if (!Files.isDirectory(builtinRoot)) {
            log.warn("Map package directory {} not found; built-in map backgrounds unavailable", builtinRoot);
            return;
        }
        try (Stream<Path> dirs = Files.list(builtinRoot)) {
            for (Path dir : dirs.filter(Files::isDirectory).toList()) {
                Path manifest = dir.resolve("manifest.json");
                if (!Files.exists(manifest)) {
                    continue;
                }
                JsonNode m = json.tree(Files.readString(manifest));
                for (JsonNode f : m.path("files")) {
                    Path file = dir.resolve(f.path("path").asText()).normalize();
                    if (!file.startsWith(dir) || !Files.exists(file)) {
                        log.warn("Map package file missing: {}", file);
                        continue;
                    }
                    String sha = Hashing.sha256(Files.readAllBytes(file));
                    if (!sha.equals(f.path("sha256").asText())) {
                        log.error("Map package checksum mismatch for {} — not installed", file);
                        continue;
                    }
                    String format = f.path("format").asText();
                    String role = "source".equals(f.path("role").asText()) ? "source" : "overlay";
                    String kind = "source".equals(role) ? "SOURCE_DATA" : m.path("kind").asText("ROADS");
                    int exists = jdbc.sql("select count(*) from map_package where code = :c and version = :v and format = :f")
                            .param("c", m.path("code").asText()).param("v", m.path("version").asText()).param("f", format)
                            .query(Integer.class).single();
                    if (exists > 0) {
                        jdbc.sql("""
                                update map_package set role = :role, kind = :kind, min_zoom = :z1, max_zoom = :z2,
                                       manifest = cast(:m as jsonb) where code = :c and version = :v and format = :f and storage = 'BUILTIN'""")
                                .param("role", role).param("kind", kind).param("z1", zoom(m, "minZoom")).param("z2", zoom(m, "maxZoom"))
                                .param("m", json.write(m)).param("c", m.path("code").asText()).param("v", m.path("version").asText())
                                .param("f", format).update();
                        continue;
                    }
                    UUID id = UUID.randomUUID();
                    insert(id, m, format, role, kind, builtinRoot.relativize(file).toString().replace('\\', '/'), sha, "BUILTIN",
                            "ACTIVE", null);
                    audit.system("MAP_PACKAGE_INSTALLED", "MAP_PACKAGE", id.toString(), m.path("name").asText(),
                            Map.of("version", m.path("version").asText(), "format", format, "sha256", sha));
                }
            }
        } catch (IOException e) {
            log.error("Failed to scan map packages", e);
        }
    }

    private static Double zoom(JsonNode m, String key) {
        return m.path(key).isNumber() ? m.path(key).asDouble() : null;
    }

    private void insert(UUID id, JsonNode m, String format, String role, String kind, String path, String sha, String storage,
                        String status, UUID by) {
        JsonNode cov = m.path("coverage");
        jdbc.sql("""
                insert into map_package(id, code, name, version, data_date, source, license, attribution_html, crs,
                    min_lat, min_lng, max_lat, max_lng, format, local_path, content_sha256, status, role, kind, min_zoom, max_zoom,
                    storage, manifest, uploaded_by)
                values (:id, :code, :name, :ver, :date, :src, :lic, :attr, :crs, :a, :b, :c, :d, :fmt, :path, :sha, :st, :role,
                    :kind, :z1, :z2, :storage, cast(:m as jsonb), :by)""")
                .param("id", id).param("code", m.path("code").asText()).param("name", m.path("name").asText())
                .param("ver", m.path("version").asText()).param("date", LocalDate.parse(m.path("dataDate").asText()))
                .param("src", m.path("source").asText()).param("lic", m.path("license").asText())
                .param("attr", m.path("attributionHtml").asText("")).param("crs", m.path("crs").asText())
                .param("a", cov.path("minLat").asDouble()).param("b", cov.path("minLng").asDouble())
                .param("c", cov.path("maxLat").asDouble()).param("d", cov.path("maxLng").asDouble())
                .param("fmt", format).param("path", path).param("sha", sha).param("st", status).param("role", role)
                .param("kind", kind).param("z1", zoom(m, "minZoom")).param("z2", zoom(m, "maxZoom")).param("storage", storage)
                .param("m", json.write(m)).param("by", by).update();
    }

    // ---- read -----------------------------------------------------------------------------------------------

    /** Map manager: facility management over the whole organisation (packages are not scoped to one organisation). */
    static boolean manager(AccessContext ctx) {
        return ctx.grants().stream().anyMatch(g -> g.has(Permission.MANAGE_FACILITIES) && g.isAll());
    }

    public List<MapPackage> list(AccessContext ctx, boolean all) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        boolean everything = all && manager(ctx);
        return jdbc.sql("select * from map_package " + (everything ? "" : "where status = 'ACTIVE' ")
                        + "order by case status when 'ACTIVE' then 0 when 'PENDING_REVIEW' then 1 else 2 end, kind, code, version desc, format desc")
                .query((rs, n) -> new MapPackage(rs.getString("id"), rs.getString("code"), rs.getString("name"),
                        rs.getString("source"), rs.getString("license"), rs.getString("attribution_html"),
                        new Coverage(rs.getDouble("min_lat"), rs.getDouble("min_lng"), rs.getDouble("max_lat"), rs.getDouble("max_lng")),
                        rs.getString("crs"), rs.getString("version"), rs.getString("data_date"), rs.getString("format"),
                        rs.getString("role"), rs.getString("kind"), (Double) num(rs.getObject("min_zoom")), (Double) num(rs.getObject("max_zoom")),
                        rs.getString("status"), rs.getString("storage"), everything ? rs.getString("content_sha256") : null,
                        everything ? rs.getString("status_reason") : null,
                        "/api/v1/map/packages/" + rs.getString("id") + "/content")).list();
    }

    private static Object num(Object v) {
        return v == null ? null : ((Number) v).doubleValue();
    }

    public record PackageContent(byte[] bytes, String contentType, String fileName) {
    }

    /** Active packages for every map reader; packages under review or disabled only for the map manager (preview). */
    public PackageContent content(AccessContext ctx, UUID id) {
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        Map<String, Object> row = jdbc.sql("select local_path, format, status, storage, content_sha256 from map_package where id = :id")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!"ACTIVE".equals(row.get("status")) && !manager(ctx)) {
            throw ApiException.notFound();
        }
        Path root = "MANAGED".equals(row.get("storage")) ? managedRoot : builtinRoot;
        Path file = root.resolve((String) row.get("local_path")).normalize();
        if (!file.startsWith(root)) {
            throw ApiException.notFound();
        }
        try {
            byte[] bytes = Files.readAllBytes(file);
            String type = switch ((String) row.get("format")) {
                case "SVG_OVERLAY" -> "image/svg+xml";
                case "RASTER_IMAGE" -> file.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".png") ? "image/png" : "image/jpeg";
                default -> "application/geo+json";
            };
            return new PackageContent(bytes, type, file.getFileName().toString());
        } catch (IOException e) {
            throw ApiException.notFound();
        }
    }

    // ---- upload, review, activation ------------------------------------------------------------------------

    public record UploadResult(String code, String version, String status, List<MapPackage> packages, List<String> checks) {
    }

    /**
     * Uploads a ZIP with manifest.json and the files it lists. The archive is read in memory with limits on size, entry
     * count and compression ratio; names are flat and checked, so no entry can escape the package directory. A package
     * passes only if every listed file exists, matches its SHA-256 and has a renderer; it then waits for review.
     */
    @Transactional
    public UploadResult upload(AccessContext ctx, String fileName, byte[] zip) {
        if (!manager(ctx)) {
            throw ApiException.forbidden("رفع حزم الخرائط لمدير الخرائط المخول (إدارة المرافق على كامل النطاق).");
        }
        if (zip == null || zip.length == 0) {
            throw ApiException.validation("اختر ملف الحزمة (ZIP).");
        }
        if (zip.length > MAX_UPLOAD) {
            throw ApiException.validation("حجم الحزمة يتجاوز 25 ميغابايت.");
        }
        Map<String, byte[]> entries = unzip(zip);
        byte[] manifestBytes = entries.get("manifest.json");
        if (manifestBytes == null) {
            throw ApiException.validation("الحزمة لا تحتوي manifest.json في جذرها.");
        }
        JsonNode m = json.tree(new String(manifestBytes, StandardCharsets.UTF_8));
        List<String> checks = new ArrayList<>();
        List<String> problems = validateManifest(m);
        String code = m.path("code").asText();
        String version = m.path("version").asText();
        if (problems.isEmpty()) {
            int existing = jdbc.sql("select count(*) from map_package where code = :c and version = :v")
                    .param("c", code).param("v", version).query(Integer.class).single();
            if (existing > 0) {
                problems.add("الحزمة " + code + " بالإصدار " + version + " مسجلة مسبقاً؛ ارفع إصداراً جديداً.");
            }
        }
        for (JsonNode f : m.path("files")) {
            String path = f.path("path").asText();
            byte[] bytes = entries.get(path);
            if (bytes == null) {
                problems.add("الملف «" + path + "» المذكور في manifest غير موجود في الحزمة.");
                continue;
            }
            String sha = Hashing.sha256(bytes);
            if (!sha.equals(f.path("sha256").asText())) {
                problems.add("بصمة SHA-256 للملف «" + path + "» لا تطابق manifest.");
                continue;
            }
            checks.add("SHA-256 مطابق: " + path);
            problems.addAll(checkContent(f.path("format").asText(), path, bytes));
        }
        if (!problems.isEmpty()) {
            audit.recordAs(ctx.actor(), "MAP_PACKAGE_REJECTED", "MAP_PACKAGE", code + "@" + version, m.path("name").asText(null),
                    Map.of("problems", problems), null);
            throw ApiException.validation(problems.get(0), Map.of("problems", problems));
        }
        Path dir = managedRoot.resolve(code + "-" + version).normalize();
        if (!dir.startsWith(managedRoot)) {
            throw ApiException.validation("اسم الحزمة غير صالح.");
        }
        try {
            Files.createDirectories(dir);
            Path tmp = Files.createTempFile(managedRoot, "upload", ".tmp");
            for (JsonNode f : m.path("files")) {
                String path = f.path("path").asText();
                Files.write(tmp, entries.get(path));
                Files.move(tmp, dir.resolve(path), StandardCopyOption.REPLACE_EXISTING);
            }
            Files.write(dir.resolve("manifest.json"), manifestBytes);
            Files.deleteIfExists(tmp);
        } catch (IOException e) {
            throw new IllegalStateException("map package storage failed", e);
        }
        for (JsonNode f : m.path("files")) {
            String role = "source".equals(f.path("role").asText()) ? "source" : "overlay";
            insert(UUID.randomUUID(), m, f.path("format").asText(), role, "source".equals(role) ? "SOURCE_DATA" : m.path("kind").asText(),
                    managedRoot.relativize(dir.resolve(f.path("path").asText())).toString().replace('\\', '/'),
                    f.path("sha256").asText(), "MANAGED", "PENDING_REVIEW", ctx.personId());
        }
        audit.recordAs(ctx.actor(), "MAP_PACKAGE_UPLOADED", "MAP_PACKAGE", code + "@" + version, m.path("name").asText(),
                Map.of("files", m.path("files").size(), "kind", m.path("kind").asText(), "license", m.path("license").asText()), null);
        return new UploadResult(code, version, "PENDING_REVIEW", group(ctx, code, version), checks);
    }

    private List<MapPackage> group(AccessContext ctx, String code, String version) {
        return list(ctx, true).stream().filter(p -> p.code().equals(code) && p.version().equals(version)).toList();
    }

    private static Map<String, byte[]> unzip(byte[] zip) {
        Map<String, byte[]> out = new LinkedHashMap<>();
        long total = 0;
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                if (e.isDirectory()) {
                    throw ApiException.validation("الحزمة يجب أن تكون مسطحة: لا مجلدات داخل الأرشيف.");
                }
                String name = e.getName();
                if (!FILE.matcher(name).matches() || name.contains("..")) {
                    throw ApiException.validation("اسم ملف غير مسموح في الحزمة: «" + name + "».");
                }
                if (out.size() >= MAX_ENTRIES) {
                    throw ApiException.validation("عدد الملفات في الحزمة يتجاوز " + MAX_ENTRIES + ".");
                }
                if (out.containsKey(name)) {
                    throw ApiException.validation("الملف «" + name + "» مكرر في الأرشيف.");
                }
                byte[] bytes = readLimited(in, MAX_ENTRY);
                total += bytes.length;
                if (total > MAX_TOTAL || total > (long) zip.length * MAX_RATIO) {
                    throw ApiException.validation("حجم الحزمة بعد فك الضغط يتجاوز الحد المسموح (أرشيف غير آمن).");
                }
                out.put(name, bytes);
            }
        } catch (IOException ex) {
            throw ApiException.validation("تعذر قراءة الأرشيف؛ يجب أن يكون ملف ZIP صالحاً.");
        }
        if (out.isEmpty()) {
            throw ApiException.validation("الأرشيف فارغ أو ليس ZIP.");
        }
        return out;
    }

    private static byte[] readLimited(InputStream in, long limit) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        int r;
        while ((r = in.read(chunk)) > 0) {
            buf.write(chunk, 0, r);
            if (buf.size() > limit) {
                throw ApiException.validation("ملف داخل الحزمة يتجاوز الحد المسموح.");
            }
        }
        return buf.toByteArray();
    }

    List<String> validateManifest(JsonNode m) {
        List<String> p = new ArrayList<>();
        if (!CODE.matcher(m.path("code").asText()).matches()) {
            p.add("رمز الحزمة code يجب أن يكون أحرفاً لاتينية صغيرة وأرقاماً وشرطات (2–60).");
        }
        if (!VERSION.matcher(m.path("version").asText()).matches()) {
            p.add("الإصدار version غير صالح.");
        }
        for (String k : List.of("name", "source", "license", "crs")) {
            if (m.path(k).asText("").isBlank()) {
                p.add("الحقل «" + k + "» مطلوب في manifest.");
            }
        }
        try {
            LocalDate.parse(m.path("dataDate").asText());
        } catch (RuntimeException e) {
            p.add("تاريخ البيانات dataDate مطلوب بصيغة YYYY-MM-DD.");
        }
        if (!m.path("crs").asText("").startsWith("EPSG:4326")) {
            p.add("نظام الحزمة يجب أن يكون EPSG:4326 بحدود زوايا (العارض المثبت يرسم الطبقات بحدود خطوط الطول والعرض).");
        }
        if (!KINDS.contains(m.path("kind").asText())) {
            p.add("نوع الخلفية kind يجب أن يكون ROADS أو AERIAL أو FACILITY_PLAN.");
        }
        JsonNode c = m.path("coverage");
        double a = c.path("minLat").asDouble(Double.NaN), b = c.path("minLng").asDouble(Double.NaN);
        double cc = c.path("maxLat").asDouble(Double.NaN), d = c.path("maxLng").asDouble(Double.NaN);
        if (!(a >= -90 && cc <= 90 && b >= -180 && d <= 180 && a < cc && b < d)) {
            p.add("نطاق التغطية coverage غير صالح (minLat < maxLat، minLng < maxLng ضمن حدود الإحداثيات).");
        }
        Double z1 = zoom(m, "minZoom"), z2 = zoom(m, "maxZoom");
        if (z1 == null || z2 == null || z1 < 0 || z2 > 22 || z1 >= z2) {
            p.add("مستويات التكبير minZoom وmaxZoom مطلوبة (0–22، والأدنى أقل من الأعلى).");
        }
        String attr = m.path("attributionHtml").asText("");
        if (attr.matches("(?is).*<(?!/?a[\\s>]).*") || attr.matches("(?is).*(javascript:|on\\w+\\s*=).*")) {
            p.add("نص الإسناد attributionHtml يسمح بروابط <a> فقط.");
        }
        if (!m.path("files").isArray() || m.path("files").isEmpty()) {
            p.add("قائمة الملفات files مطلوبة.");
        }
        int overlays = 0;
        for (JsonNode f : m.path("files")) {
            String fmt = f.path("format").asText();
            if (!FORMATS.contains(fmt)) {
                p.add("الصيغة «" + fmt + "» لا يوجد لها عارض مثبت (المدعوم: SVG_OVERLAY وRASTER_IMAGE، وGEOJSON بيانات مصدر). "
                        + "حزم PMTiles وMBTiles وXYZ غير مدعومة في هذا الإصدار.");
            }
            if (!FILE.matcher(f.path("path").asText()).matches()) {
                p.add("مسار ملف غير صالح في manifest: «" + f.path("path").asText() + "».");
            }
            if (!f.path("sha256").asText("").matches("[0-9a-f]{64}")) {
                p.add("بصمة sha256 مطلوبة لكل ملف.");
            }
            if (!"source".equals(f.path("role").asText()) && !"GEOJSON".equals(fmt)) {
                overlays++;
            }
            if ("GEOJSON".equals(fmt) && !"source".equals(f.path("role").asText())) {
                p.add("ملف GeoJSON في الحزمة بيانات مصدر (role = source) وليس خلفية معروضة.");
            }
        }
        if (overlays != 1) {
            p.add("يجب أن تحتوي الحزمة ملف خلفية واحداً (SVG_OVERLAY أو RASTER_IMAGE).");
        }
        return p;
    }

    /** Content checks per renderer: images by signature; SVG without scripts, event handlers or external references. */
    static List<String> checkContent(String format, String path, byte[] bytes) {
        List<String> p = new ArrayList<>();
        switch (format) {
            case "SVG_OVERLAY" -> {
                String s = new String(bytes, StandardCharsets.UTF_8);
                String lower = s.toLowerCase(Locale.ROOT);
                if (!lower.contains("<svg")) {
                    p.add("«" + path + "» ليس ملف SVG.");
                }
                if (lower.contains("<script") || lower.contains("<foreignobject") || lower.contains("javascript:")
                        || Pattern.compile("\\son[a-z]+\\s*=").matcher(lower).find() || lower.contains("<!entity")) {
                    p.add("«" + path + "» يحتوي نصوصاً برمجية أو معالجات أحداث أو كائنات مضمنة؛ غير مسموح في الخلفيات.");
                }
                if (Pattern.compile("(href|src)\\s*=\\s*[\"'](https?:|//)").matcher(lower).find()
                        || Pattern.compile("url\\(\\s*[\"']?(https?:|//)").matcher(lower).find()) {
                    p.add("«" + path + "» يشير إلى موارد خارجية؛ الخلفيات تعمل دون إنترنت.");
                }
            }
            case "RASTER_IMAGE" -> {
                boolean png = bytes.length > 8 && (bytes[0] & 0xff) == 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G';
                boolean jpeg = bytes.length > 3 && (bytes[0] & 0xff) == 0xff && (bytes[1] & 0xff) == 0xd8;
                String lower = path.toLowerCase(Locale.ROOT);
                if (!(png && lower.endsWith(".png")) && !(jpeg && (lower.endsWith(".jpg") || lower.endsWith(".jpeg")))) {
                    p.add("«" + path + "» ليس صورة PNG/JPEG مطابقة لامتدادها.");
                }
            }
            case "GEOJSON" -> {
                try {
                    JsonNode n = new com.fasterxml.jackson.databind.ObjectMapper().readTree(bytes);
                    if (n == null || !n.has("type")) {
                        p.add("«" + path + "» ليس GeoJSON.");
                    }
                } catch (IOException e) {
                    p.add("«" + path + "» ليس GeoJSON صالحاً.");
                }
            }
            default -> {
            }
        }
        return p;
    }

    /** ACTIVE (after review), DISABLED or REJECTED for all files of one package version; recorded with a reason. */
    @Transactional
    public List<MapPackage> setStatus(AccessContext ctx, String code, String version, String status, String reason) {
        if (!manager(ctx)) {
            throw ApiException.forbidden("تفعيل الحزم وتعطيلها لمدير الخرائط المخول.");
        }
        if (!Set.of("ACTIVE", "DISABLED", "REJECTED").contains(status)) {
            throw ApiException.validation("الحالة يجب أن تكون ACTIVE أو DISABLED أو REJECTED.");
        }
        String why = reason == null ? "" : reason.trim();
        if (why.length() < 5) {
            throw ApiException.validation("اكتب سبب القرار (5 أحرف على الأقل).");
        }
        List<Map<String, Object>> rows = jdbc.sql("select id, status, storage, local_path, content_sha256, name from map_package "
                        + "where code = :c and version = :v for update").param("c", code).param("v", version).query().listOfRows();
        if (rows.isEmpty()) {
            throw ApiException.notFound();
        }
        for (Map<String, Object> r : rows) {
            String from = (String) r.get("status");
            boolean allowed = switch (status) {
                case "ACTIVE" -> "PENDING_REVIEW".equals(from) || "DISABLED".equals(from);
                case "DISABLED" -> "ACTIVE".equals(from);
                default -> "PENDING_REVIEW".equals(from);
            };
            if (!allowed) {
                throw ApiException.validation("لا يمكن الانتقال من الحالة " + from + " إلى " + status + ".");
            }
            if ("ACTIVE".equals(status)) {
                Path root = "MANAGED".equals(r.get("storage")) ? managedRoot : builtinRoot;
                try {
                    String sha = Hashing.sha256(Files.readAllBytes(root.resolve((String) r.get("local_path")).normalize()));
                    if (!sha.equals(r.get("content_sha256"))) {
                        throw ApiException.validation("تغيّر ملف الحزمة منذ رفعها (بصمة مختلفة)؛ لا يمكن تفعيلها.");
                    }
                } catch (IOException e) {
                    throw ApiException.validation("ملف الحزمة غير موجود على وحدة التخزين.");
                }
            }
        }
        jdbc.sql("""
                update map_package set status = :s, status_changed_by = :by, status_changed_at = :now, status_reason = :why
                where code = :c and version = :v""")
                .param("s", status).param("by", ctx.personId()).param("now", Db.ts(clock.instant())).param("why", why)
                .param("c", code).param("v", version).update();
        String action = switch (status) {
            case "ACTIVE" -> "MAP_PACKAGE_ACTIVATED";
            case "DISABLED" -> "MAP_PACKAGE_DISABLED";
            default -> "MAP_PACKAGE_REJECTED";
        };
        audit.recordAs(ctx.actor(), action, "MAP_PACKAGE", code + "@" + version, (String) rows.get(0).get("name"),
                Map.of("status", status), why);
        return group(ctx, code, version);
    }

    /** Active background overlays (ROADS, AERIAL, FACILITY_PLAN) with their coverage, for coverage computation. */
    List<MapPackage> activeBackgrounds() {
        return jdbc.sql("select * from map_package where status = 'ACTIVE' and role = 'overlay' order by kind, code")
                .query((rs, n) -> new MapPackage(rs.getString("id"), rs.getString("code"), rs.getString("name"), rs.getString("source"),
                        rs.getString("license"), rs.getString("attribution_html"),
                        new Coverage(rs.getDouble("min_lat"), rs.getDouble("min_lng"), rs.getDouble("max_lat"), rs.getDouble("max_lng")),
                        rs.getString("crs"), rs.getString("version"), rs.getString("data_date"), rs.getString("format"),
                        rs.getString("role"), rs.getString("kind"), (Double) num(rs.getObject("min_zoom")), (Double) num(rs.getObject("max_zoom")),
                        rs.getString("status"), rs.getString("storage"), null, null,
                        "/api/v1/map/packages/" + rs.getString("id") + "/content")).list();
    }
}
