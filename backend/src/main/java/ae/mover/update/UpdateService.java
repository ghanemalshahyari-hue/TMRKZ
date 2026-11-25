package ae.mover.update;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.ErrorCode;
import ae.mover.common.Json;
import ae.mover.security.AuthService;
import ae.mover.security.OidcProperties;

/**
 * «مركز التحديث» (ADR-104): the browser side of an update, as a broker that is authorised and audited but never writes an
 * application file itself. It keeps what the administrator sends — the signed release, then only the files that differ — in
 * the staging volume shared with the maintenance worker (ops/update/UpdateWorker.java), records the approval, and reports the
 * worker's progress. The worker verifies the signature, compares, builds, backs up, applies, verifies and rolls back.
 *
 * <p>Every operation: configuration AND access management over everything. Approving and rolling back also need a recent
 * interactive sign-in (the step-up rule of decisions). Each file is accepted only when its SHA-256 is the one in the compared,
 * signed list, under a path the comparison named.
 */
@Service
public class UpdateService {

    private static final Logger log = LoggerFactory.getLogger(UpdateService.class);
    static final long MAX_FILE = 24L * 1024 * 1024;
    static final long MAX_LIST = 8L * 1024 * 1024;
    private static final Pattern SESSION = Pattern.compile("[0-9]{8}T[0-9]{6}-[0-9a-f]{8}");
    private static final Set<String> FINAL = Set.of("DONE", "DONE_RESTART_REQUIRED", "FAILED_ROLLED_BACK", "ROLLED_BACK", "REJECTED", "ERROR");
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss").withZone(ZoneOffset.UTC);

    public record CreateInput(String release, String signature, String manifest) {
    }

    public record ApproveInput(List<String> paths, String reason) {
    }

    public record ReasonInput(String reason) {
    }

    private final Path root;
    private final AuditService audit;
    private final AuthService auth;
    private final OidcProperties oidc;
    private final Json json;
    private final Clock clock;
    private final long minFree;
    private final SecureRandom random = new SecureRandom();

    public UpdateService(@Value("${tmrkz.update.dir:/update}") String dir, AuditService audit, AuthService auth, OidcProperties oidc,
                         Json json, Clock clock, @Value("${tmrkz.update.min-free-mb:100}") long minFreeMb) {
        this.minFree = minFreeMb << 20;
        this.root = Path.of(dir);
        this.audit = audit;
        this.auth = auth;
        this.oidc = oidc;
        this.json = json;
        this.clock = clock;
    }

    /** When this backend process started: the maintenance worker's proof that a new build is the one running. */
    public static Map<String, Object> liveness() {
        return Map.of("startedAt", Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().getStartTime()).toString());
    }

    private static void require(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("يُحدِّث التطبيق مدير نظام عام فقط (إعداد النظام وإدارة الصلاحيات على كل الوحدات).");
        }
    }

    private void stepUp(AccessContext ctx) {
        Instant at = ctx.actor().sessionId() == null ? null : auth.authenticatedAt(ctx.actor().sessionId()).orElse(null);
        if (at == null || at.isBefore(clock.instant().minusSeconds(oidc.reauthMaxAgeSeconds()))) {
            throw new ApiException(ErrorCode.REAUTHENTICATION_REQUIRED, "سجّل الدخول من جديد ثم اعتمد؛ لم يُسجل أي قرار.");
        }
    }

    // ---- overview -------------------------------------------------------------------------------------------------

    public Map<String, Object> overview(AccessContext ctx) {
        require(ctx);
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> worker = readJson(root.resolve("worker.json"));
        boolean alive = worker != null && worker.get("at") != null
                && Instant.parse((String) worker.get("at")).isAfter(clock.instant().minusSeconds(20));
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("alive", alive);
        w.put("version", worker == null ? null : worker.get("version"));
        w.put("trustInstalled", worker != null && Boolean.TRUE.equals(worker.get("trustInstalled")));
        w.put("baseline", worker != null && Boolean.TRUE.equals(worker.get("baseline")));
        w.put("lastSeen", worker == null ? null : worker.get("at"));
        out.put("worker", w);
        List<Map<String, Object>> sessions = new ArrayList<>();
        for (String id : sessionIds()) {
            Path s = root.resolve("sessions").resolve(id);
            Map<String, Object> st = readJson(s.resolve("state.json"));
            Properties p = props(s.resolve("session.properties"));
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("release", releaseId(s));
            m.put("state", shownState(s));
            m.put("message", st == null ? null : st.get("message"));
            m.put("createdAt", p.getProperty("at"));
            m.put("createdBy", p.getProperty("byName"));
            sessions.add(m);
        }
        out.put("sessions", sessions.size() > 20 ? sessions.subList(0, 20) : sessions);
        return out;
    }

    private List<String> sessionIds() {
        List<String> ids = new ArrayList<>();
        Path dir = root.resolve("sessions");
        if (!Files.isDirectory(dir)) {
            return ids;
        }
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) {
                if (SESSION.matcher(p.getFileName().toString()).matches()) {
                    ids.add(p.getFileName().toString());
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        ids.sort(java.util.Comparator.reverseOrder());
        return ids;
    }

    // ---- a session --------------------------------------------------------------------------------------------------

    public Map<String, Object> create(AccessContext ctx, CreateInput in) {
        require(ctx);
        if (in == null || blank(in.release()) || blank(in.signature()) || blank(in.manifest())) {
            throw ApiException.validation("اختر مجلد TMRKZ الذي فيه release/RELEASE.json و release/RELEASE.sig و release/MANIFEST.tsv.");
        }
        if (in.release().length() > 4096 || in.signature().length() > 1024 || in.manifest().length() > MAX_LIST) {
            throw ApiException.validation("ملفات الإصدار أكبر من المتوقع.");
        }
        byte[] r = new byte[4];
        random.nextBytes(r);
        String id = STAMP.format(clock.instant()) + "-" + HexFormat.of().formatHex(r);
        Path s = root.resolve("sessions").resolve(id);
        try {
            Files.createDirectories(s.resolve("release"));
            Files.writeString(s.resolve("release/RELEASE.json"), in.release(), StandardCharsets.UTF_8);
            Files.writeString(s.resolve("release/RELEASE.sig"), in.signature().trim(), StandardCharsets.UTF_8);
            Files.writeString(s.resolve("release/MANIFEST.tsv"), in.manifest(), StandardCharsets.UTF_8);
            Properties p = new Properties();
            p.setProperty("by", ctx.personId().toString());
            p.setProperty("byName", String.valueOf(ctx.actor().displayName()));
            p.setProperty("at", clock.instant().toString());
            writeProps(s.resolve("session.properties"), p); // last: the worker starts when this file appears
        } catch (IOException e) {
            throw new IllegalStateException("staging volume not writable: " + e.getMessage(), e);
        }
        String release = field(in.release(), "release");
        audit.recordAs(ctx.actor(), "UPDATE_RECEIVED", "UPDATE", id, release, Map.of("release", String.valueOf(release)), null);
        return view(ctx, id);
    }

    public Map<String, Object> view(AccessContext ctx, String id) {
        require(ctx);
        Path s = session(id);
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> st = readJson(s.resolve("state.json"));
        out.put("id", id);
        out.put("release", releaseId(s));
        out.put("state", shownState(s));
        out.put("message", st == null ? null : st.get("message"));
        Map<String, Object> compare = readJson(s.resolve("compare.json"));
        if (compare != null) {
            for (Object o : (List<?>) compare.getOrDefault("changes", List.of())) {
                @SuppressWarnings("unchecked")
                Map<String, Object> c = (Map<String, Object>) o;
                if (!"DELETED".equals(c.get("change")) && !"BLOCKED".equals(c.get("change"))) {
                    c.put("uploaded", staged(s, (String) c.get("path"), c));
                }
            }
        }
        out.put("compare", compare);
        Properties a = props(s.resolve("approval.properties"));
        out.put("approval", a.isEmpty() ? null : Map.of("by", a.getProperty("byName", ""), "at", a.getProperty("at", ""),
                "reason", a.getProperty("reason", "")));
        List<String> lines = new ArrayList<>();
        try {
            if (Files.exists(s.resolve("progress.log"))) {
                List<String> all = Files.readAllLines(s.resolve("progress.log"), StandardCharsets.UTF_8);
                lines = all.subList(Math.max(0, all.size() - 200), all.size());
            }
        } catch (IOException e) {
            log.warn("progress of {} unreadable", id);
        }
        List<Map<String, String>> progress = new ArrayList<>();
        for (String l : lines) {
            int t = l.indexOf('\t');
            progress.add(Map.of("at", t > 0 ? l.substring(0, t) : "", "text", t > 0 ? l.substring(t + 1) : l));
        }
        out.put("progress", progress);
        out.put("buildLog", Files.exists(s.resolve("build.log")));
        return out;
    }

    /** One file of the release, accepted only when it is a compared, unblocked change and its SHA-256 is the signed one. */
    public void upload(AccessContext ctx, String id, String path, InputStream body) {
        require(ctx);
        Path s = session(id);
        if (!"COMPARED".equals(stateOf(s)) || Files.exists(s.resolve("approval.properties"))) {
            throw new ApiException(ErrorCode.STALE_REVISION, "لا يُرفع إلى هذا التحديث الآن (ليس بانتظار الرفع).");
        }
        Map<String, Object> c = change(s, path);
        if (c == null || Boolean.TRUE.equals(c.get("blocked")) || "DELETED".equals(c.get("change"))) {
            throw ApiException.validation("هذا الملف ليس من الملفات المختلفة في هذا التحديث: " + path);
        }
        long size = ((Number) c.get("size")).longValue();
        Path target = s.resolve("files").resolve(path).normalize();
        if (!target.startsWith(s.resolve("files")) || size > MAX_FILE) {
            throw ApiException.validation("مسار أو حجم غير مقبول: " + path);
        }
        Path tmp = target.resolveSibling(target.getFileName() + ".part");
        try {
            Files.createDirectories(target.getParent());
            long free = Files.getFileStore(target.getParent()).getUsableSpace();
            if (free < size + minFree) {
                throw ApiException.validation("مساحة القرص غير كافية لاستلام " + path + ": المتاح " + (free >> 20) + " MB؛ لم يُستلم شيء.");
            }
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long n = 0;
            try (OutputStream out = Files.newOutputStream(tmp)) {
                byte[] buf = new byte[65536];
                for (int r; (r = body.read(buf)) > 0; ) {
                    n += r;
                    if (n > size) {
                        break;
                    }
                    md.update(buf, 0, r);
                    out.write(buf, 0, r);
                }
            }
            if (n != size || !HexFormat.of().formatHex(md.digest()).equals(c.get("sha256"))) {
                throw ApiException.validation(n < size ? "انقطع رفع الملف قبل اكتماله؛ أعد رفعه: " + path
                        : "محتوى الملف لا يطابق الإصدار الموقع (تغير بعد التوقيع؟): " + path);
            }
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            // an interrupted transfer: the part received is dropped, nothing is staged
            throw ApiException.validation("انقطع رفع الملف قبل اكتماله؛ أعد رفعه: " + path);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        } finally {
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException ignored) {
                // removed with the session
            }
        }
    }

    public Map<String, Object> approve(AccessContext ctx, String id, ApproveInput in) {
        require(ctx);
        stepUp(ctx);
        Path s = session(id);
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation("اذكر سبب التحديث.");
        }
        if (!"COMPARED".equals(stateOf(s)) || Files.exists(s.resolve("approval.properties"))) {
            throw new ApiException(ErrorCode.STALE_REVISION, "هذا التحديث ليس بانتظار الاعتماد.");
        }
        List<String> paths = in == null || in.paths() == null ? List.of() : in.paths().stream().distinct().toList();
        if (paths.isEmpty()) {
            throw ApiException.validation("اختر التغييرات المعتمدة.");
        }
        int config = 0;
        int deleted = 0;
        for (String p : paths) {
            Map<String, Object> c = change(s, p);
            if (c == null || Boolean.TRUE.equals(c.get("blocked"))) {
                throw ApiException.validation("تغيير غير معروف أو ممنوع: " + p);
            }
            if ("DELETED".equals(c.get("change"))) {
                deleted++;
            } else if (!staged(s, p, c)) {
                throw ApiException.validation("لم يُرفع بعد: " + p);
            }
            if ("config".equals(c.get("class"))) {
                config++;
            }
        }
        try {
            Files.writeString(s.resolve("approval-paths.txt"), String.join("\n", paths) + "\n", StandardCharsets.UTF_8);
            Properties p = new Properties();
            p.setProperty("by", ctx.personId().toString());
            p.setProperty("byName", String.valueOf(ctx.actor().displayName()));
            p.setProperty("at", clock.instant().toString());
            p.setProperty("reason", reason);
            writeProps(s.resolve("approval.properties"), p); // last: the worker applies when this file appears
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("release", String.valueOf(releaseId(s)));
        detail.put("files", paths.size());
        detail.put("deleted", deleted);
        detail.put("config", config);
        audit.recordAs(ctx.actor(), "UPDATE_APPROVED", "UPDATE", id, String.valueOf(releaseId(s)), detail, reason);
        return view(ctx, id);
    }

    public Map<String, Object> rollback(AccessContext ctx, String id, ReasonInput in) {
        require(ctx);
        stepUp(ctx);
        Path s = session(id);
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation("اذكر سبب الرجوع.");
        }
        String state = stateOf(s);
        if (!"DONE".equals(state) && !"DONE_RESTART_REQUIRED".equals(state) || Files.exists(s.resolve("rollback.properties"))) {
            throw new ApiException(ErrorCode.STALE_REVISION, "يُرجع تحديث مكتمل فقط، مرة واحدة.");
        }
        Properties p = new Properties();
        p.setProperty("by", ctx.personId().toString());
        p.setProperty("byName", String.valueOf(ctx.actor().displayName()));
        p.setProperty("at", clock.instant().toString());
        p.setProperty("reason", reason);
        try {
            writeProps(s.resolve("rollback.properties"), p);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        audit.recordAs(ctx.actor(), "UPDATE_ROLLBACK_REQUESTED", "UPDATE", id, String.valueOf(releaseId(s)), Map.of(), reason);
        return view(ctx, id);
    }

    /** Each outcome the worker reached is audited once (the backend may have been restarting while it happened). */
    @Scheduled(fixedDelayString = "${tmrkz.update.audit-interval-ms:15000}", initialDelay = 20000)
    public void auditOutcomes() {
        for (String id : sessionIds()) {
            Path s = root.resolve("sessions").resolve(id);
            String state = stateOf(s);
            if (state == null || !FINAL.contains(state) || Files.exists(s.resolve("audited-" + state))) {
                continue;
            }
            Map<String, Object> st = readJson(s.resolve("state.json"));
            audit.system("UPDATE_" + state, "UPDATE", id, String.valueOf(releaseId(s)),
                    Map.of("message", String.valueOf(st == null ? "" : st.get("message"))));
            try {
                Files.writeString(s.resolve("audited-" + state), clock.instant().toString());
            } catch (IOException e) {
                log.warn("audit marker of {} not written", id);
            }
        }
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------

    private Path session(String id) {
        if (id == null || !SESSION.matcher(id).matches()) {
            throw ApiException.notFound();
        }
        Path s = root.resolve("sessions").resolve(id);
        if (!Files.isDirectory(s, LinkOption.NOFOLLOW_LINKS)) {
            throw ApiException.notFound();
        }
        return s;
    }

    private String stateOf(Path s) {
        Map<String, Object> st = readJson(s.resolve("state.json"));
        return st == null ? null : (String) st.get("state");
    }

    /**
     * The state as the page follows it: between the administrator's decision and the worker taking it up, «APPROVED» or
     * «ROLLBACK_REQUESTED» — so the page keeps following instead of reading the earlier state as settled.
     */
    private String shownState(Path s) {
        String state = stateOf(s);
        if ("COMPARED".equals(state) && Files.exists(s.resolve("approval.properties"))) {
            return "APPROVED";
        }
        if (("DONE".equals(state) || "DONE_RESTART_REQUIRED".equals(state)) && Files.exists(s.resolve("rollback.properties"))) {
            return "ROLLBACK_REQUESTED";
        }
        return state == null ? "RECEIVED" : state;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> change(Path s, String path) {
        Map<String, Object> compare = readJson(s.resolve("compare.json"));
        if (compare == null || path == null) {
            return null;
        }
        for (Object o : (List<?>) compare.getOrDefault("changes", List.of())) {
            Map<String, Object> c = (Map<String, Object>) o;
            if (path.equals(c.get("path"))) {
                return c;
            }
        }
        return null;
    }

    private static boolean staged(Path s, String path, Map<String, Object> c) {
        Path f = s.resolve("files").resolve(path).normalize();
        try {
            return f.startsWith(s.resolve("files")) && Files.isRegularFile(f, LinkOption.NOFOLLOW_LINKS)
                    && Files.size(f) == ((Number) c.get("size")).longValue();
        } catch (IOException e) {
            return false;
        }
    }

    private String releaseId(Path s) {
        try {
            return field(Files.readString(s.resolve("release/RELEASE.json")), "release");
        } catch (IOException e) {
            return null;
        }
    }

    private Map<String, Object> readJson(Path p) {
        try {
            return Files.exists(p) ? json.map(Files.readString(p, StandardCharsets.UTF_8)) : null;
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private static Properties props(Path p) {
        Properties out = new Properties();
        if (Files.exists(p)) {
            try (var r = Files.newBufferedReader(p, StandardCharsets.UTF_8)) {
                out.load(r);
            } catch (IOException e) {
                return out;
            }
        }
        return out;
    }

    private static void writeProps(Path p, Properties props) throws IOException {
        Path tmp = p.resolveSibling(p.getFileName() + ".tmp");
        try (var w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
            props.store(w, null);
        }
        Files.move(tmp, p, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    private static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(name) + "\"\\s*:\\s*\"([^\"]{1,200})\"").matcher(json == null ? "" : json);
        return m.find() ? m.group(1) : null;
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
