import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * TMRKZ maintenance worker (ADR-104) — the only process that writes application files during a browser update.
 *
 * <p>Runs in the existing image tmrkz/folder-backend:1 as {@code java /install/ops/update/UpdateWorker.java}; no Docker socket,
 * no shell offered to anyone, no network but the application's internal one. It reads requests the backend leaves in the
 * staging volume ({@code /update/sessions/<id>/}) and answers there:
 * <ol>
 *   <li>verifies the release signature (Ed25519, the public key installed once at ops/local/.generated/release-trust.pub)
 *       and that the manifest is the one signed;</li>
 *   <li>classifies every path with the INSTALLED rules (ops/update/managed-paths.conf) plus a hard-coded protected list that
 *       no release can relax, and compares the release with the installed files (added, modified, deleted, conflicts);</li>
 *   <li>after the administrator's approval: re-checks each uploaded file against the signed SHA-256, builds the backend offline
 *       with the image's own libraries when backend sources change (nothing is applied if it does not build), backs up every
 *       file it will touch, applies, and verifies that the backend restarted with the new build and the web was rebuilt;</li>
 *   <li>rolls back from the backup when verification fails, or when the administrator asks.</li>
 * </ol>
 * Persistent data, certificates, maps, .env, the machine's own Compose files and the generated secrets are never written:
 * they are protected here and the most sensitive ones are also mounted read-only into this container.
 */
public class UpdateWorker {

    static final Path INSTALL = Path.of(env("TMRKZ_INSTALL_DIR", "/install"));
    static final Path STAGE = Path.of(env("TMRKZ_UPDATE_DIR", "/update"));
    static final String BACKEND = env("TMRKZ_UPDATE_BACKEND_URL", "http://backend:8080");
    static final String WEB = env("TMRKZ_UPDATE_WEB_URL", "http://web");
    static final long MAX_FILE = 24L * 1024 * 1024;
    static final Duration BUILD_TIMEOUT = Duration.ofMinutes(Long.parseLong(env("TMRKZ_UPDATE_BUILD_MINUTES", "25")));
    static final Duration DEPLOY_TIMEOUT = Duration.ofMinutes(Long.parseLong(env("TMRKZ_UPDATE_DEPLOY_MINUTES", "25")));
    static final Path BASELINE = INSTALL.resolve("backups/updates/installed-MANIFEST.tsv");

    /** Never written by an update whatever the installed rules say (a release cannot relax these). */
    static final List<String> PROTECTED_CORE = List.of(".env", ".env.*", "certs/**", "data/**", "backups/**", "map-data/**",
            "map-runtime/**", "ops/local/.generated/**", ".git/**", "release/**", "tmrkz-images.tar", "tmrkz-images.tar.sha256");
    static final Set<String> CONFIG = Set.of("docker-compose.yml", "docker-compose.override.yml");
    static final Set<String> TRANSFERRED = Set.of("app", "config", "docs");

    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    static String version = "?";

    record Rule(String cls, Pattern re, String glob) {
    }

    record Entry(String cls, String sha, long size, String path) {
    }

    record Change(String path, String cls, String change, String sha, long size, String installedSha, List<String> flags, boolean blocked,
                  String reason) {
    }

    public static void main(String[] args) throws Exception {
        version = sha256(Files.readAllBytes(INSTALL.resolve("ops/update/UpdateWorker.java"))).substring(0, 12);
        Files.createDirectories(STAGE.resolve("sessions"));
        log("worker " + version + " watching " + STAGE + " for " + INSTALL);
        // the heartbeat beats on its own: an update that builds and verifies for minutes must not look like a stopped worker
        Thread.ofVirtual().start(() -> {
            while (true) {
                try {
                    heartbeat();
                    Thread.sleep(5000);
                } catch (InterruptedException e) {
                    return;
                } catch (Exception e) {
                    log("heartbeat: " + e);
                }
            }
        });
        while (true) {
            try {
                try (DirectoryStream<Path> dirs = Files.newDirectoryStream(STAGE.resolve("sessions"))) {
                    List<Path> list = new ArrayList<>();
                    dirs.forEach(list::add);
                    list.sort(null);
                    for (Path s : list) {
                        if (Files.isDirectory(s, LinkOption.NOFOLLOW_LINKS)) {
                            step(s);
                        }
                    }
                }
            } catch (Exception e) {
                log("loop: " + e);
            }
            Thread.sleep(1000);
        }
    }

    // ---- the state machine of one session --------------------------------------------------------------------------

    static void step(Path s) throws Exception {
        String state = state(s);
        if (state == null && Files.exists(s.resolve("release/RELEASE.json")) && Files.exists(s.resolve("session.properties"))) {
            compare(s);
        } else if ("COMPARED".equals(state) && Files.exists(s.resolve("approval.properties"))) {
            apply(s);
        } else if (("DONE".equals(state) || "DONE_RESTART_REQUIRED".equals(state)) && Files.exists(s.resolve("rollback.properties"))) {
            rollback(s, "ROLLED_BACK", "أُعيد الإصدار السابق بطلب مدير النظام");
        }
    }

    static void compare(Path s) {
        setState(s, "VERIFYING", "التحقق من توقيع الإصدار ومقارنته بالتثبيت");
        try {
            byte[] release = Files.readAllBytes(s.resolve("release/RELEASE.json"));
            String sig = Files.readString(s.resolve("release/RELEASE.sig")).trim();
            byte[] manifest = Files.readAllBytes(s.resolve("release/MANIFEST.tsv"));
            Path trust = INSTALL.resolve("ops/local/.generated/release-trust.pub");
            if (!Files.exists(trust)) {
                reject(s, "لا يوجد مفتاح الثقة ops/local/.generated/release-trust.pub على هذا الجهاز؛ يُثبت مرة واحدة (تعليمات التهيئة).");
                return;
            }
            if (!verify(Files.readString(trust), release, sig)) {
                reject(s, "توقيع الإصدار غير صحيح أو ليس من المفتاح الموثوق على هذا الجهاز؛ لا يُقبل.");
                return;
            }
            String json = new String(release, StandardCharsets.UTF_8);
            if (!sha256(manifest).equals(field(json, "manifestSha256"))) {
                reject(s, "قائمة ملفات الإصدار لا تطابق القائمة الموقعة؛ لا يُقبل.");
                return;
            }
            progress(s, "التوقيع صحيح: الإصدار " + field(json, "release"));
            List<Rule> rules = rules();
            Map<String, Entry> wanted = new TreeMap<>();
            List<Change> changes = new ArrayList<>();
            for (String line : new String(manifest, StandardCharsets.UTF_8).split("\n")) {
                if (line.isBlank()) {
                    continue;
                }
                String[] f = line.split("\t", 4);
                if (f.length != 4) {
                    reject(s, "سطر غير صالح في قائمة الإصدار.");
                    return;
                }
                Entry e = new Entry(f[0], f[1], Long.parseLong(f[2]), f[3]);
                String bad = badPath(e.path());
                String cls = classify(e.path(), rules);
                if (bad != null || !TRANSFERRED.contains(cls) || !e.sha().matches("[0-9a-f]{64}")) {
                    changes.add(new Change(e.path(), cls, "BLOCKED", e.sha(), e.size(), null, List.of("PROTECTED"), true,
                            bad != null ? bad : "مسار محمي أو غير مُدار على هذا الجهاز (" + cls + ")؛ لا تكتبه التحديثات."));
                    continue;
                }
                wanted.put(e.path(), new Entry(cls, e.sha(), e.size(), e.path()));
            }
            Map<String, String> installed = inventory(rules);
            Map<String, String> baseline = baseline();
            int unchanged = 0;
            for (Entry e : wanted.values()) {
                String have = installed.get(e.path());
                if (e.sha().equals(have)) {
                    unchanged++;
                    continue;
                }
                List<String> flags = new ArrayList<>();
                boolean blocked = false;
                String reason = null;
                if ("config".equals(e.cls())) {
                    flags.add("CONFIG");
                    flags.add("NEEDS_RESTART");
                }
                if (have != null && baseline.containsKey(e.path()) && !have.equals(baseline.get(e.path()))) {
                    flags.add("LOCALLY_MODIFIED");
                }
                if (e.size() > MAX_FILE) {
                    blocked = true;
                    reason = "أكبر من حد الرفع عبر المتصفح (24 MB)؛ ينقله المشغل.";
                    flags.add("TOO_LARGE");
                }
                if (e.path().equals("frontend/package-lock.json")) {
                    blocked = true;
                    reason = "تغيرت مكتبات الواجهة (npm): تحتاج صورة جديدة، والتحديث لا يضيف مكتبات.";
                    flags.add("NEW_DEPENDENCY");
                }
                if (e.path().equals("backend/pom.xml")) {
                    flags.add("BUILD_CHECK");
                }
                changes.add(new Change(e.path(), e.cls(), have == null ? "ADDED" : "MODIFIED", e.sha(), e.size(), have, flags, blocked, reason));
            }
            for (Map.Entry<String, String> i : installed.entrySet()) {
                String cls = classify(i.getKey(), rules);
                if (!wanted.containsKey(i.getKey()) && ("app".equals(cls) || "docs".equals(cls))) {
                    List<String> flags = new ArrayList<>();
                    if (baseline.containsKey(i.getKey()) && !i.getValue().equals(baseline.get(i.getKey()))) {
                        flags.add("LOCALLY_MODIFIED");
                    }
                    changes.add(new Change(i.getKey(), cls, "DELETED", null, 0, i.getValue(), flags, false, null));
                }
            }
            // a release that would delete much of the installation (a partial or wrong folder) never deletes by default
            long deletions = changes.stream().filter(c -> "DELETED".equals(c.change())).count();
            if (deletions > Math.max(50, installed.size() / 10)) {
                for (int i = 0; i < changes.size(); i++) {
                    Change c = changes.get(i);
                    if ("DELETED".equals(c.change())) {
                        List<String> flags = new ArrayList<>(c.flags());
                        flags.add("MASS_DELETION");
                        changes.set(i, new Change(c.path(), c.cls(), c.change(), c.sha(), c.size(), c.installedSha(), flags, c.blocked(), c.reason()));
                    }
                }
                progress(s, "تنبيه: الإصدار يحذف " + deletions + " ملفاً من " + installed.size() + "؛ لا يُختار الحذف إلا يدوياً");
            }
            changes.sort((a, b) -> a.path().compareTo(b.path()));
            Map<String, Integer> counts = new LinkedHashMap<>();
            for (String k : List.of("ADDED", "MODIFIED", "DELETED", "BLOCKED")) {
                counts.put(k, 0);
            }
            for (Change c : changes) {
                counts.merge(c.blocked() && !"BLOCKED".equals(c.change()) ? "BLOCKED" : c.change(), 1, Integer::sum);
            }
            StringBuilder out = new StringBuilder("{");
            out.append("\"release\":").append(json.trim()).append(',');
            out.append("\"signature\":\"VALID\",\"baseline\":").append(!baseline.isEmpty()).append(',');
            out.append("\"unchanged\":").append(unchanged).append(",\"counts\":{");
            int n = 0;
            for (Map.Entry<String, Integer> c : counts.entrySet()) {
                out.append(n++ > 0 ? "," : "").append(q(c.getKey())).append(':').append(c.getValue());
            }
            out.append("},\"changes\":[");
            n = 0;
            for (Change c : changes) {
                out.append(n++ > 0 ? "," : "").append("{\"path\":").append(q(c.path())).append(",\"class\":").append(q(c.cls()))
                        .append(",\"change\":").append(q(c.change())).append(",\"sha256\":").append(q(c.sha())).append(",\"size\":").append(c.size())
                        .append(",\"installedSha256\":").append(q(c.installedSha())).append(",\"blocked\":").append(c.blocked())
                        .append(",\"reason\":").append(q(c.reason())).append(",\"flags\":[");
                for (int i = 0; i < c.flags().size(); i++) {
                    out.append(i > 0 ? "," : "").append(q(c.flags().get(i)));
                }
                out.append("]}");
            }
            out.append("]}");
            write(s.resolve("compare.json"), out.toString());
            progress(s, "المقارنة: " + counts + "، بلا تغيير " + unchanged);
            setState(s, "COMPARED", "قارن الإصدار بالتثبيت؛ بانتظار رفع الملفات المختلفة واعتماد مدير النظام");
        } catch (Exception e) {
            reject(s, "تعذرت قراءة الإصدار: " + e.getMessage());
        }
    }

    static void apply(Path s) throws Exception {
        Properties approval = props(s.resolve("approval.properties"));
        List<String> approved = Files.readAllLines(s.resolve("approval-paths.txt"), StandardCharsets.UTF_8).stream()
                .map(String::strip).filter(x -> !x.isEmpty()).toList();
        Map<String, Map<String, String>> changes = changes(Files.readString(s.resolve("compare.json")));
        List<Rule> rules = rules();
        setState(s, "VALIDATING", "التحقق من الملفات المعتمدة (" + approved.size() + ") قبل التطبيق");
        progress(s, "اعتمده " + approval.getProperty("byName", "?") + ": " + approval.getProperty("reason", ""));
        boolean backend = false;
        boolean frontend = false;
        boolean config = false;
        boolean self = false;
        for (String p : approved) {
            Map<String, String> c = changes.get(p);
            String cls = classify(p, rules);
            if (c == null || "true".equals(c.get("blocked")) || badPath(p) != null || !TRANSFERRED.contains(cls)) {
                fail(s, "مسار غير مسموح في الاعتماد: " + p);
                return;
            }
            if (!"DELETED".equals(c.get("change"))) {
                Path staged = s.resolve("files").resolve(p).normalize();
                if (!staged.startsWith(s.resolve("files")) || !Files.isRegularFile(staged, LinkOption.NOFOLLOW_LINKS)
                        || !sha256(Files.readAllBytes(staged)).equals(c.get("sha256"))) {
                    fail(s, "الملف المرفوع لا يطابق الإصدار الموقع: " + p);
                    return;
                }
            }
            backend |= p.equals("backend/pom.xml") || p.startsWith("backend/src/main/");
            frontend |= p.startsWith("frontend/");
            config |= "config".equals(cls);
            self |= p.equals("ops/update/UpdateWorker.java");
        }
        if (backend && !buildCheck(s, approved, changes)) {
            return;
        }
        String startedBefore = backendStartedAt();
        String webBefore = webIndex();
        setState(s, "APPLYING", "نسخ احتياطي للملفات المتأثرة ثم التطبيق");
        Path backup = INSTALL.resolve("backups/updates").resolve(s.getFileName());
        Files.createDirectories(backup.resolve("before"));
        if (Files.exists(BASELINE)) {
            Files.copy(BASELINE, backup.resolve("baseline-before.tsv"), StandardCopyOption.REPLACE_EXISTING);
        }
        Set<String> inPlace = singleFileMounts();
        List<String> added = new ArrayList<>();
        for (String p : approved) {
            Path target = target(p);
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                Path b = backup.resolve("before").resolve(p);
                Files.createDirectories(b.getParent());
                Files.copy(target, b, StandardCopyOption.REPLACE_EXISTING);
            } else {
                added.add(p);
            }
        }
        write(backup.resolve("added.txt"), String.join("\n", added));
        write(backup.resolve("approved.txt"), String.join("\n", approved));
        Map<String, String> base = baseline();
        for (String p : approved) {
            Map<String, String> c = changes.get(p);
            Path target = target(p);
            if ("DELETED".equals(c.get("change"))) {
                Files.deleteIfExists(target);
                base.remove(p);
            } else {
                put(target, Files.readAllBytes(s.resolve("files").resolve(p)), inPlace.contains(p));
                base.put(p, c.get("sha256"));
            }
        }
        saveBaseline(base);
        progress(s, "طُبق " + approved.size() + " ملفاً؛ النسخة الاحتياطية في backups/updates/" + s.getFileName());
        setState(s, "VERIFYING_DEPLOY", "التحقق من إعادة البناء والتشغيل");
        String problem = verifyDeploy(s, backend, startedBefore, frontend, webBefore);
        if (problem != null) {
            progress(s, "فشل التحقق: " + problem);
            rollback(s, "FAILED_ROLLED_BACK", "فشل التحقق بعد التطبيق (" + problem + ")؛ أُعيد الإصدار السابق تلقائياً");
            return;
        }
        if (config) {
            setState(s, "DONE_RESTART_REQUIRED", "طُبق التحديث وتحقق؛ تغير ملف إعداد الحاويات: يلزم «docker compose up -d» مرة واحدة ليسري");
        } else {
            setState(s, "DONE", "طُبق التحديث وتحقق التشغيل");
        }
        if (self) {
            progress(s, "تغير عامل الصيانة نفسه؛ يُعاد تشغيله بالإصدار الجديد");
            System.exit(0); // restart: unless-stopped starts the new code
        }
    }

    static void rollback(Path s, String finalState, String message) throws Exception {
        setState(s, "ROLLING_BACK", "استعادة الملفات من النسخة الاحتياطية");
        Path backup = INSTALL.resolve("backups/updates").resolve(s.getFileName());
        List<String> approved = Files.readAllLines(backup.resolve("approved.txt"), StandardCharsets.UTF_8).stream()
                .map(String::strip).filter(x -> !x.isEmpty()).toList();
        Set<String> added = new HashSet<>(Files.readAllLines(backup.resolve("added.txt"), StandardCharsets.UTF_8));
        Set<String> inPlace = singleFileMounts();
        String startedBefore = backendStartedAt();
        String webBefore = webIndex();
        boolean backend = false;
        boolean frontend = false;
        for (String p : approved) {
            Path target = target(p);
            if (added.contains(p)) {
                Files.deleteIfExists(target);
            } else {
                put(target, Files.readAllBytes(backup.resolve("before").resolve(p)), inPlace.contains(p));
            }
            backend |= p.equals("backend/pom.xml") || p.startsWith("backend/src/main/");
            frontend |= p.startsWith("frontend/");
        }
        if (Files.exists(backup.resolve("baseline-before.tsv"))) {
            Files.copy(backup.resolve("baseline-before.tsv"), BASELINE, StandardCopyOption.REPLACE_EXISTING);
        } else {
            Files.deleteIfExists(BASELINE);
        }
        progress(s, "استُعيد " + approved.size() + " ملفاً من النسخة الاحتياطية");
        String problem = verifyDeploy(s, backend, startedBefore, frontend, webBefore);
        setState(s, problem == null ? finalState : "ERROR", problem == null ? message : "استُعيدت الملفات لكن التحقق لم يكتمل: " + problem
                + " — راجع الحالة بأداة التشخيص (ops/diagnose.sh)");
    }

    // ---- checks ---------------------------------------------------------------------------------------------------------

    /** The backend as it would be after the update, built offline with the image's own libraries; nothing applied if it fails. */
    static boolean buildCheck(Path s, List<String> approved, Map<String, Map<String, String>> changes) throws Exception {
        progress(s, "بناء الخادم بالمكتبات الموجودة (دون إنترنت) قبل التطبيق …");
        Path work = Path.of("/tmp/tmrkz-validate").resolve(s.getFileName());
        deleteTree(work);
        Files.createDirectories(work.resolve("src"));
        Files.copy(INSTALL.resolve("backend/pom.xml"), work.resolve("pom.xml"));
        copyTree(INSTALL.resolve("backend/src/main"), work.resolve("src/main"));
        for (String p : approved) {
            if (!p.equals("backend/pom.xml") && !p.startsWith("backend/src/main/")) {
                continue;
            }
            Path t = work.resolve(p.substring("backend/".length()));
            if ("DELETED".equals(changes.get(p).get("change"))) {
                Files.deleteIfExists(t);
            } else {
                Files.createDirectories(t.getParent());
                Files.copy(s.resolve("files").resolve(p), t, StandardCopyOption.REPLACE_EXISTING);
            }
        }
        Process proc = new ProcessBuilder("mvn", "-B", "-q", "-o", "-Dmaven.test.skip=true", "package").directory(work.toFile())
                .redirectErrorStream(true).start();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Thread reader = Thread.ofVirtual().start(() -> {
            try (InputStream in = proc.getInputStream()) {
                in.transferTo(output);
            } catch (IOException ignored) {
                // the process ended
            }
        });
        boolean finished = proc.waitFor(BUILD_TIMEOUT.toMinutes(), TimeUnit.MINUTES);
        if (!finished) {
            proc.destroyForcibly();
        }
        reader.join(5000);
        deleteTree(work);
        if (!finished || proc.exitValue() != 0) {
            String text = output.toString(StandardCharsets.UTF_8);
            List<String> lines = List.of(text.split("\n"));
            String tail = String.join("\n", lines.subList(Math.max(0, lines.size() - 25), lines.size()));
            write(s.resolve("build.log"), text);
            fail(s, (finished ? "لا يُبنى الخادم بهذا الإصدار بالمكتبات الموجودة؛ لم يُطبق شيء.\n" : "تجاوز بناء الخادم المهلة؛ لم يُطبق شيء.\n") + tail);
            return false;
        }
        progress(s, "بُني الخادم بنجاح بالمكتبات الموجودة");
        return true;
    }

    /** Null when the new build is running: the backend restarted after the change, the web republished, both answer. */
    static String verifyDeploy(Path s, boolean backend, String startedBefore, boolean frontend, String webBefore) throws Exception {
        Instant until = Instant.now().plus(DEPLOY_TIMEOUT);
        if (backend) {
            progress(s, "انتظار إعادة بناء الخادم وتشغيله …");
            while (true) {
                String now = backendStartedAt();
                if (now != null && !now.equals(startedBefore) && status(BACKEND + "/api/v1/auth/status") == 200) {
                    break;
                }
                if (Instant.now().isAfter(until)) {
                    return "لم يعمل الخادم بالبناء الجديد خلال المهلة";
                }
                Thread.sleep(3000);
            }
            progress(s, "يعمل الخادم بالبناء الجديد");
        }
        if (frontend) {
            progress(s, "انتظار إعادة بناء الواجهة ونشرها …");
            while (true) {
                String now = webIndex();
                if (now != null && !now.equals(webBefore)) {
                    break;
                }
                if (Instant.now().isAfter(until)) {
                    return "لم تُنشر الواجهة الجديدة خلال المهلة";
                }
                Thread.sleep(3000);
            }
            progress(s, "نُشرت الواجهة الجديدة");
        }
        for (int i = 0; i < 40; i++) {
            if (status(WEB + "/healthz") == 200 && status(WEB + "/api/v1/auth/status") == 200) {
                progress(s, "التطبيق يجيب عبر خادم الويب");
                return null;
            }
            Thread.sleep(3000);
        }
        return "لا يجيب التطبيق عبر خادم الويب";
    }

    static String backendStartedAt() {
        try {
            HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create(BACKEND + "/api/v1/system/liveness"))
                    .timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString());
            return r.statusCode() == 200 ? field(r.body(), "startedAt") : null;
        } catch (Exception e) {
            return null;
        }
    }

    static String webIndex() {
        try {
            HttpResponse<byte[]> r = HTTP.send(HttpRequest.newBuilder(URI.create(WEB + "/index.html")).timeout(Duration.ofSeconds(5)).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            return r.statusCode() == 200 ? sha256(r.body()) : null;
        } catch (Exception e) {
            return null;
        }
    }

    static int status(String url) {
        try {
            return HTTP.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(5)).GET().build(),
                    HttpResponse.BodyHandlers.discarding()).statusCode();
        } catch (Exception e) {
            return 0;
        }
    }

    // ---- rules, paths and the installed files -------------------------------------------------------------------------

    static List<Rule> rules() throws IOException {
        List<Rule> out = new ArrayList<>();
        for (String g : PROTECTED_CORE) {
            out.add(new Rule("protected", glob(g), g));
        }
        for (String line : Files.readAllLines(INSTALL.resolve("ops/update/managed-paths.conf"), StandardCharsets.UTF_8)) {
            String t = line.strip();
            if (t.isEmpty() || t.startsWith("#")) {
                continue;
            }
            String[] f = t.split("\\s+");
            if (f.length >= 2) {
                out.add(new Rule(f[0], glob(f[1]), f[1]));
            }
        }
        return out;
    }

    static String classify(String path, List<Rule> rules) {
        if (path.startsWith("docker-compose.") && path.endsWith(".yml") && !CONFIG.contains(path)) {
            return "protected";
        }
        for (Rule r : rules) {
            if (r.re().matcher(path).matches()) {
                return r.cls();
            }
        }
        return "dev";
    }

    static Pattern glob(String g) {
        StringBuilder r = new StringBuilder();
        for (int i = 0; i < g.length(); i++) {
            char c = g.charAt(i);
            if (c == '*' && i + 1 < g.length() && g.charAt(i + 1) == '*') {
                if (i + 2 < g.length() && g.charAt(i + 2) == '/') {
                    r.append("(.*/)?");
                    i += 2;
                } else {
                    r.append(".*");
                    i++;
                }
            } else if (c == '*') {
                r.append("[^/]*");
            } else if (c == '?') {
                r.append("[^/]");
            } else {
                r.append(Pattern.quote(String.valueOf(c)));
            }
        }
        String re = r.toString();
        String tail = Pattern.quote("/") + ".*";
        if (re.endsWith(tail)) {
            re = re.substring(0, re.length() - tail.length()) + "(/.*)?";
        }
        return Pattern.compile(re);
    }

    /** Null for an acceptable relative path; otherwise why it is refused. */
    static String badPath(String p) {
        if (p == null || p.isEmpty() || p.length() > 400 || p.startsWith("/") || p.contains("\\") || p.contains("\0") || p.contains(":")) {
            return "مسار غير صالح: " + p;
        }
        for (String seg : p.split("/", -1)) {
            if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) {
                return "مسار غير صالح: " + p;
            }
            for (char c : seg.toCharArray()) {
                if (c < 0x20) {
                    return "مسار غير صالح: " + p;
                }
            }
        }
        return null;
    }

    /** The installed file for a path, refusing any symbolic link on the way (nothing outside the folder is reached). */
    static Path target(String p) throws IOException {
        if (badPath(p) != null) {
            throw new IOException("refused path " + p);
        }
        Path t = INSTALL.resolve(p).normalize();
        if (!t.startsWith(INSTALL)) {
            throw new IOException("outside the folder " + p);
        }
        for (Path at = t; at != null && !at.equals(INSTALL); at = at.getParent()) {
            if (Files.isSymbolicLink(at)) {
                throw new IOException("symbolic link on the way " + p);
            }
        }
        return t;
    }

    /** SHA-256 of every installed app, config and docs file; protected and development trees are not even entered. */
    static Map<String, String> inventory(List<Rule> rules) throws IOException {
        Map<String, String> out = new TreeMap<>();
        Files.walkFileTree(INSTALL, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (dir.equals(INSTALL)) {
                    return FileVisitResult.CONTINUE;
                }
                String rel = INSTALL.relativize(dir).toString().replace('\\', '/');
                String cls = classify(rel + "/__probe__", rules);
                return attrs.isSymbolicLink() || "protected".equals(cls) && fullyCovered(rel, rules) || "dev".equals(cls) && fullyCovered(rel, rules)
                        || rel.equals(".git") || rel.endsWith("/node_modules") ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (!attrs.isRegularFile()) {
                    return FileVisitResult.CONTINUE;
                }
                String rel = INSTALL.relativize(file).toString().replace('\\', '/');
                if (TRANSFERRED.contains(classify(rel, rules))) {
                    out.put(rel, sha256(file));
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException exc) {
                return FileVisitResult.CONTINUE;
            }
        });
        return out;
    }

    /** True when a «dir/**» rule (or a wider one) decides everything below this directory. */
    static boolean fullyCovered(String dir, List<Rule> rules) {
        for (Rule r : rules) {
            if (r.glob().endsWith("/**") && (dir + "/").startsWith(r.glob().substring(0, r.glob().length() - 2)) && !r.glob().contains("*/")
                    && r.glob().indexOf('*') == r.glob().length() - 2) {
                return true;
            }
        }
        return false;
    }

    /** Files bind-mounted one by one into a container (written in place: a renamed file would not be seen there). */
    static Set<String> singleFileMounts() {
        Set<String> out = new HashSet<>();
        Pattern p = Pattern.compile("-\\s+\\./([A-Za-z0-9_./-]+\\.[A-Za-z0-9]+):/");
        for (String f : List.of("docker-compose.yml", "docker-compose.override.yml")) {
            try {
                Matcher m = p.matcher(Files.readString(INSTALL.resolve(f)));
                while (m.find()) {
                    out.add(m.group(1));
                }
            } catch (IOException ignored) {
                // a missing file mounts nothing
            }
        }
        return out;
    }

    static void put(Path target, byte[] content, boolean inPlace) throws IOException {
        Files.createDirectories(target.getParent());
        if (inPlace && Files.exists(target)) {
            try (OutputStream o = Files.newOutputStream(target, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
                o.write(content);
            }
            return;
        }
        Path tmp = target.resolveSibling("." + target.getFileName() + ".tmrkz-update");
        Files.write(tmp, content);
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    static Map<String, String> baseline() throws IOException {
        Map<String, String> out = new TreeMap<>();
        if (Files.exists(BASELINE)) {
            for (String l : Files.readAllLines(BASELINE, StandardCharsets.UTF_8)) {
                int t = l.indexOf('\t');
                if (t == 64) {
                    out.put(l.substring(65), l.substring(0, 64));
                }
            }
        }
        return out;
    }

    static void saveBaseline(Map<String, String> base) throws IOException {
        StringBuilder b = new StringBuilder();
        base.forEach((p, h) -> b.append(h).append('\t').append(p).append('\n'));
        Files.createDirectories(BASELINE.getParent());
        write(BASELINE, b.toString());
    }

    // ---- session files ----------------------------------------------------------------------------------------------

    static void heartbeat() throws IOException {
        Path trust = INSTALL.resolve("ops/local/.generated/release-trust.pub");
        write(STAGE.resolve("worker.json"), "{\"at\":" + q(Instant.now().toString()) + ",\"version\":" + q(version) + ",\"trustInstalled\":"
                + Files.exists(trust) + ",\"baseline\":" + Files.exists(BASELINE) + "}");
    }

    static String state(Path s) {
        try {
            return field(Files.readString(s.resolve("state.json")), "state");
        } catch (IOException e) {
            return null;
        }
    }

    static void setState(Path s, String state, String message) {
        try {
            write(s.resolve("state.json"), "{\"state\":" + q(state) + ",\"message\":" + q(message) + ",\"at\":" + q(Instant.now().toString()) + "}");
            progress(s, message);
        } catch (IOException e) {
            log("state " + s + ": " + e);
        }
    }

    static void reject(Path s, String why) {
        setState(s, "REJECTED", why);
    }

    static void fail(Path s, String why) {
        setState(s, "REJECTED", why);
    }

    static void progress(Path s, String text) {
        try {
            Files.writeString(s.resolve("progress.log"), Instant.now() + "\t" + text.replace('\n', ' ') + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log("progress: " + e);
        }
        log(s.getFileName() + ": " + text);
    }

    /** The compare result as path → its fields (the worker's own JSON, read back with a small parser of that shape). */
    static Map<String, Map<String, String>> changes(String json) {
        Map<String, Map<String, String>> out = new HashMap<>();
        Matcher m = Pattern.compile("\\{\"path\":(\"(?:[^\"\\\\]|\\\\.)*\"),\"class\":\"([a-z]+)\",\"change\":\"([A-Z]+)\",\"sha256\":(null|\"[0-9a-f]*\"),"
                + "\"size\":(\\d+),\"installedSha256\":(null|\"[0-9a-f]*\"),\"blocked\":(true|false)").matcher(json);
        while (m.find()) {
            Map<String, String> c = new HashMap<>();
            c.put("class", m.group(2));
            c.put("change", m.group(3));
            c.put("sha256", m.group(4).equals("null") ? null : m.group(4).replace("\"", ""));
            c.put("blocked", m.group(7));
            out.put(unq(m.group(1)), c);
        }
        return out;
    }

    // ---- small helpers ------------------------------------------------------------------------------------------------

    static boolean verify(String pem, byte[] data, String signatureB64) throws Exception {
        String body = pem.replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "");
        PublicKey key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(body)));
        Signature v = Signature.getInstance("Ed25519");
        v.initVerify(key);
        v.update(data);
        try {
            return v.verify(Base64.getDecoder().decode(signatureB64.replaceAll("\\s", "")));
        } catch (IllegalArgumentException | java.security.SignatureException e) {
            return false;
        }
    }

    static Properties props(Path p) throws IOException {
        Properties out = new Properties();
        try (var r = Files.newBufferedReader(p, StandardCharsets.UTF_8)) {
            out.load(r);
        }
        return out;
    }

    static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(name) + "\"\\s*:\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|[^,}\\s]+)").matcher(json);
        return m.find() ? (m.group(1).startsWith("\"") ? unq(m.group(1)) : m.group(1)) : null;
    }

    static String q(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
                }
            }
        }
        return b.append('"').toString();
    }

    static String unq(String quoted) {
        String s = quoted.substring(1, quoted.length() - 1);
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char n = s.charAt(++i);
                switch (n) {
                    case 'n' -> b.append('\n');
                    case 'r' -> b.append('\r');
                    case 't' -> b.append('\t');
                    case 'u' -> {
                        b.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                        i += 4;
                    }
                    default -> b.append(n);
                }
            } else {
                b.append(c);
            }
        }
        return b.toString();
    }

    static void write(Path p, String text) throws IOException {
        Files.createDirectories(p.getParent());
        Path tmp = p.resolveSibling(p.getFileName() + ".tmp");
        Files.writeString(tmp, text, StandardCharsets.UTF_8);
        Files.move(tmp, p, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    static String sha256(byte[] b) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String sha256(Path p) throws IOException {
        try (InputStream in = Files.newInputStream(p)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) {
                md.update(buf, 0, n);
            }
            return HexFormat.of().formatHex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static void copyTree(Path from, Path to) throws IOException {
        Files.walkFileTree(from, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                Files.createDirectories(to.resolve(from.relativize(dir).toString()));
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (attrs.isRegularFile()) {
                    Files.copy(file, to.resolve(from.relativize(file).toString()), StandardCopyOption.REPLACE_EXISTING);
                }
                return FileVisitResult.CONTINUE;
            }
        });
    }

    static void deleteTree(Path p) throws IOException {
        if (!Files.exists(p, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        Files.walkFileTree(p, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, IOException exc) throws IOException {
                Files.delete(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    static String env(String name, String fallback) {
        String v = System.getenv(name);
        return v == null || v.isBlank() ? fallback : v;
    }

    static void log(String s) {
        System.out.println("[update-worker] " + Instant.now() + " " + s);
    }
}
