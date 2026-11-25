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
            try {
                certificates();
            } catch (Exception e) {
                log("certificates: " + e);
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
        long need = 0;
        for (String p : approved) {
            Map<String, String> c = changes.get(p);
            if (!"DELETED".equals(c.get("change"))) {
                need += Files.size(s.resolve("files").resolve(p));
            }
        }
        // the backup of what is replaced and the new files, plus a margin (and the offline build's copy when the backend changes)
        String space = freeSpaceProblem(INSTALL, 2 * need + (backend ? 300L << 20 : 0));
        if (space != null) {
            fail(s, space);
            return;
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

    /** Null when the folder's file system keeps at least {@code bytes} plus the minimum free space; else why not (nothing applied). */
    static String freeSpaceProblem(Path where, long bytes) {
        long min = Long.parseLong(env("TMRKZ_UPDATE_MIN_FREE_MB", "200")) << 20;
        try {
            long free = Files.getFileStore(where).getUsableSpace();
            if (free < bytes + min) {
                return "مساحة القرص غير كافية: المتاح " + (free >> 20) + " MB، ويلزم " + ((bytes + min) >> 20)
                        + " MB (النسخة الاحتياطية والملفات الجديدة وهامش " + (min >> 20) + " MB)؛ لم يُطبق شيء.";
            }
            return null;
        } catch (IOException e) {
            return "تعذرت معرفة المساحة المتاحة: " + e.getMessage() + "؛ لم يُطبق شيء.";
        }
    }

    // ---- certificates (ADR-105) ---------------------------------------------------------------------------------------

    static final Path CERT_STAGE = STAGE.resolve("certificates");
    static final String PROXY_HOST = env("TMRKZ_UPDATE_PROXY_HOST", "proxy");
    static final int PROXY_PORT = Integer.parseInt(env("TMRKZ_UPDATE_PROXY_PORT", "8443"));
    static final Duration TLS_VERIFY = Duration.ofSeconds(Long.parseLong(env("TMRKZ_UPDATE_TLS_VERIFY_SECONDS", "90")));
    static Instant lastInventory = Instant.EPOCH;

    /** The inventory every 30 s (or when the backend asks), then each certificate request the administrator approved. */
    static void certificates() throws Exception {
        if (Instant.now().isAfter(lastInventory.plusSeconds(30)) || Files.exists(STAGE.resolve("certificate-inventory.request"))) {
            lastInventory = Instant.now();
            Files.deleteIfExists(STAGE.resolve("certificate-inventory.request"));
            inventoryCertificates();
        }
        if (!Files.isDirectory(CERT_STAGE)) {
            return;
        }
        List<Path> list = new ArrayList<>();
        try (DirectoryStream<Path> dirs = Files.newDirectoryStream(CERT_STAGE)) {
            dirs.forEach(list::add);
        }
        list.sort(null);
        for (Path s : list) {
            if (!Files.isDirectory(s, LinkOption.NOFOLLOW_LINKS) || !s.getFileName().toString().matches("[0-9]{8}T[0-9]{6}-[0-9a-f]{8}")) {
                continue;
            }
            if (!"HTTPS".equals(props(s.resolve("request.properties")).getProperty("target"))) {
                continue; // the directory's and Keycloak's trust are applied by the backend itself (database settings)
            }
            String st = state(s);
            if ("CHECKED".equals(st) && Files.exists(s.resolve("approval.properties"))) {
                certApply(s);
            } else if (("APPLIED".equals(st) || "APPLIED_INACTIVE".equals(st)) && Files.exists(s.resolve("rollback.properties"))) {
                certRestore(s, "RESTORED", "أُعيدت شهادة الخادم السابقة بطلب مدير النظام");
            }
        }
    }

    /** The values of .env the certificates depend on (and only those: no secret is read). */
    static Map<String, String> envValues() {
        Set<String> wanted = Set.of("TMRKZ_TLS_DIR", "TMRKZ_TRUSTSTORE_DIR", "COMPOSE_PROFILES", "TMRKZ_PUBLIC_URL", "TMRKZ_IP", "TMRKZ_PORT",
                "TMRKZ_HTTPS_PORT");
        Map<String, String> out = new HashMap<>();
        try {
            for (String l : Files.readAllLines(INSTALL.resolve(".env"), StandardCharsets.UTF_8)) {
                String t = l.strip();
                if (t.startsWith("export ")) {
                    t = t.substring(7).strip();
                }
                int eq = t.indexOf('=');
                if (t.startsWith("#") || eq <= 0 || !wanted.contains(t.substring(0, eq).strip())) {
                    continue;
                }
                String v = t.substring(eq + 1).strip();
                if (v.length() >= 2 && (v.startsWith("\"") && v.endsWith("\"") || v.startsWith("'") && v.endsWith("'"))) {
                    v = v.substring(1, v.length() - 1);
                }
                out.put(t.substring(0, eq).strip(), v);
            }
        } catch (IOException e) {
            out.put("_error", "تعذرت قراءة .env");
        }
        return out;
    }

    static String tlsDir(Map<String, String> env) {
        return clean(env.getOrDefault("TMRKZ_TLS_DIR", "./ops/tls/private"));
    }

    static String clean(String d) {
        String s = d.strip().replace('\\', '/');
        while (s.startsWith("./")) {
            s = s.substring(2);
        }
        while (s.endsWith("/") && s.length() > 1) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    /** A certificate folder inside this installation, or null (absolute elsewhere, outside, through a link). */
    static Path folder(String rel) {
        if (rel.startsWith("/") || rel.contains("..") || rel.isEmpty() || rel.equals(".")) {
            return null;
        }
        Path p = INSTALL.resolve(rel).normalize();
        if (!p.startsWith(INSTALL)) {
            return null;
        }
        for (Path at = p; at != null && !at.equals(INSTALL); at = at.getParent()) {
            if (Files.isSymbolicLink(at)) {
                return null;
            }
        }
        return p;
    }

    /** Folders a certificate may be written to: the https folder only when it is one of these (never data, code or backups). */
    static boolean certificateFolder(String rel) {
        return rel.equals("ops/tls/private") || rel.startsWith("ops/tls/") || rel.equals("certs") || rel.startsWith("certs/");
    }

    static void inventoryCertificates() throws IOException {
        Map<String, String> env = envValues();
        String tls = tlsDir(env);
        boolean override = Files.exists(INSTALL.resolve("docker-compose.override.yml"));
        String trust = clean(env.getOrDefault("TMRKZ_TRUSTSTORE_DIR", override ? "./ops/local/.generated/truststore" : "./ops/keycloak/truststores"));
        boolean https = (env.getOrDefault("COMPOSE_PROFILES", "")).matches("(^|.*,)\\s*tls\\s*(,.*|$)");
        String publicUrl = env.get("TMRKZ_PUBLIC_URL");
        if (publicUrl == null && env.get("TMRKZ_IP") != null) {
            publicUrl = "http://" + env.get("TMRKZ_IP") + ":" + env.getOrDefault("TMRKZ_PORT", "8088");
        }
        String host = null;
        try {
            host = publicUrl == null ? null : URI.create(publicUrl).getHost();
        } catch (RuntimeException ignored) {
            // no host to show
        }
        StringBuilder out = new StringBuilder("{\"at\":").append(q(Instant.now().toString())).append(",\"config\":{");
        out.append("\"tlsDir\":").append(q(tls)).append(",\"tlsDirSource\":").append(q(env.containsKey("TMRKZ_TLS_DIR") ? ".env" : "default"));
        out.append(",\"trustDir\":").append(q(trust)).append(",\"trustDirSource\":").append(q(env.containsKey("TMRKZ_TRUSTSTORE_DIR") ? ".env" : "default"));
        out.append(",\"certsDir\":\"certs\",\"httpsEnabled\":").append(https).append(",\"publicUrl\":").append(q(publicUrl));
        out.append(",\"publicHost\":").append(q(host)).append(",\"envError\":").append(q(env.get("_error"))).append("},\"stores\":[");
        List<String[]> stores = new ArrayList<>();
        stores.add(new String[]{"HTTPS", tls, "نقطة https (proxy)"});
        stores.add(new String[]{"TRUST_FOLDER", trust, "الخادم (الدليل وKeycloak المؤسسة) وKeycloak المحلي عند بدء تشغيله"});
        if (!tls.equals("certs") && !trust.equals("certs")) {
            stores.add(new String[]{"CERTS", "certs", "مجلد الشهادات على هذا الجهاز (مصدر للاستيراد)"});
        }
        int n = 0;
        for (String[] st : stores) {
            out.append(n++ > 0 ? "," : "").append(store(st[0], st[1], st[2]));
        }
        out.append("]}");
        write(STAGE.resolve("certificate-inventory.json"), out.toString());
    }

    static String store(String id, String rel, String usedBy) {
        StringBuilder b = new StringBuilder("{\"id\":").append(q(id)).append(",\"path\":").append(q(rel)).append(",\"usedBy\":").append(q(usedBy));
        Path dir = folder(rel);
        if (dir == null) {
            return b.append(",\"exists\":false,\"visible\":false,\"writable\":false,\"note\":")
                    .append(q("خارج مجلد التطبيق أو عبر رابط؛ لا يراه عامل الصيانة (يُدار من الخادم مباشرة)")).append(",\"files\":[]}").toString();
        }
        boolean exists = Files.isDirectory(dir);
        boolean writable = exists && Files.isWritable(dir) && "HTTPS".equals(id) && certificateFolder(rel);
        b.append(",\"exists\":").append(exists).append(",\"visible\":true,\"writable\":").append(writable);
        if (exists && "HTTPS".equals(id) && !certificateFolder(rel)) {
            b.append(",\"note\":").append(q("لا يكتب العامل الشهادات إلا في ops/tls/… أو certs/…"));
        }
        b.append(",\"files\":[");
        if (exists) {
            List<Path> files = new ArrayList<>();
            try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
                for (Path f : ds) {
                    if (Files.isRegularFile(f, LinkOption.NOFOLLOW_LINKS) && files.size() < 100) {
                        files.add(f);
                    }
                }
            } catch (IOException e) {
                // an unreadable folder lists nothing
            }
            files.sort(null);
            List<java.security.cert.X509Certificate> all = new ArrayList<>();
            Map<Path, List<java.security.cert.X509Certificate>> certs = new HashMap<>();
            for (Path f : files) {
                List<java.security.cert.X509Certificate> cs = readCertificates(f);
                certs.put(f, cs);
                all.addAll(cs);
            }
            int i = 0;
            for (Path f : files) {
                b.append(i++ > 0 ? "," : "").append("{\"name\":").append(q(f.getFileName().toString()));
                long size = 0;
                try {
                    size = Files.size(f);
                } catch (IOException ignored) {
                    // shown as 0
                }
                b.append(",\"size\":").append(size);
                List<java.security.cert.X509Certificate> cs = certs.get(f);
                java.security.PrivateKey key = cs.isEmpty() ? readKey(f) : null;
                if (!cs.isEmpty()) {
                    StringBuilder pem = new StringBuilder();
                    for (java.security.cert.X509Certificate c : cs) {
                        pem.append(pem(c));
                    }
                    b.append(",\"kind\":\"CERTIFICATES\",\"pem\":").append(q(pem.toString()));
                } else if (key != null || isKeyFile(f)) {
                    b.append(",\"kind\":\"KEY\",\"keyAlgorithm\":").append(q(key == null ? null : key.getAlgorithm()));
                    b.append(",\"publicKeySha256\":").append(q(key == null ? null : publicKeySha256(key, all)));
                    if (key == null) {
                        b.append(",\"note\":").append(q("مفتاح لا يقرؤه العامل (مشفر أو بصيغة EC قديمة)"));
                    }
                    b.append(",\"permissions\":").append(q(permissions(f)));
                } else {
                    b.append(",\"kind\":\"OTHER\"");
                }
                b.append('}');
            }
        }
        return b.append("]}").toString();
    }

    static String permissions(Path f) {
        try {
            return java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(f));
        } catch (Exception e) {
            return null;
        }
    }

    static boolean isKeyFile(Path f) {
        try {
            return Files.size(f) < 64 * 1024 && new String(Files.readAllBytes(f), StandardCharsets.ISO_8859_1).contains("PRIVATE KEY");
        } catch (IOException e) {
            return false;
        }
    }

    /** Every certificate of a PEM, DER or PKCS#7 file (none for anything else). */
    static List<java.security.cert.X509Certificate> readCertificates(Path f) {
        List<java.security.cert.X509Certificate> out = new ArrayList<>();
        try {
            if (Files.size(f) > 1024 * 1024) {
                return out;
            }
            byte[] b = Files.readAllBytes(f);
            if (new String(b, StandardCharsets.ISO_8859_1).contains("PRIVATE KEY")) {
                return out;
            }
            for (java.security.cert.Certificate c : java.security.cert.CertificateFactory.getInstance("X.509")
                    .generateCertificates(new java.io.ByteArrayInputStream(b))) {
                out.add((java.security.cert.X509Certificate) c);
            }
        } catch (Exception e) {
            out.clear();
        }
        return out;
    }

    /** A PEM private key (PKCS#8, or PKCS#1 RSA); null for anything else, encrypted keys included. */
    static java.security.PrivateKey readKey(Path f) {
        try {
            if (Files.size(f) > 64 * 1024) {
                return null;
            }
            String t = Files.readString(f, StandardCharsets.ISO_8859_1);
            byte[] der;
            if (t.contains("-----BEGIN PRIVATE KEY-----")) {
                der = Base64.getMimeDecoder().decode(between(t, "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"));
            } else if (t.contains("-----BEGIN RSA PRIVATE KEY-----") && !t.contains("ENCRYPTED")) {
                byte[] pkcs1 = Base64.getMimeDecoder().decode(between(t, "-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"));
                byte[] alg = HexFormat.of().parseHex("300d06092a864886f70d0101010500");
                der = derSequence(concat(HexFormat.of().parseHex("020100"), alg, derTag(0x04, pkcs1)));
            } else {
                return null;
            }
            for (String a : List.of("RSA", "EC", "Ed25519", "Ed448")) {
                try {
                    return KeyFactory.getInstance(a).generatePrivate(new java.security.spec.PKCS8EncodedKeySpec(der));
                } catch (Exception ignored) {
                    // another algorithm
                }
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    static String between(String t, String a, String b) {
        int i = t.indexOf(a) + a.length();
        int j = t.indexOf(b, i);
        return t.substring(i, j).replaceAll("\\s", "");
    }

    static byte[] derSequence(byte[] content) {
        return derTag(0x30, content);
    }

    static byte[] derTag(int tag, byte[] content) {
        int n = content.length;
        byte[] len;
        if (n < 128) {
            len = new byte[]{(byte) n};
        } else if (n < 256) {
            len = new byte[]{(byte) 0x81, (byte) n};
        } else if (n < 65536) {
            len = new byte[]{(byte) 0x82, (byte) (n >> 8), (byte) n};
        } else {
            len = new byte[]{(byte) 0x83, (byte) (n >> 16), (byte) (n >> 8), (byte) n};
        }
        return concat(new byte[]{(byte) tag}, len, content);
    }

    static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) {
            n += p.length;
        }
        byte[] out = new byte[n];
        int at = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, at, p.length);
            at += p.length;
        }
        return out;
    }

    /** The SHA-256 of the key's public half: from an RSA key itself, else from the certificate beside it that it signs for. */
    static String publicKeySha256(java.security.PrivateKey key, List<java.security.cert.X509Certificate> certs) {
        try {
            if (key instanceof java.security.interfaces.RSAPrivateCrtKey r) {
                PublicKey pub = KeyFactory.getInstance("RSA").generatePublic(new java.security.spec.RSAPublicKeySpec(r.getModulus(), r.getPublicExponent()));
                return sha256(pub.getEncoded());
            }
            for (java.security.cert.X509Certificate c : certs) {
                if (matches(key, c)) {
                    return sha256(c.getPublicKey().getEncoded());
                }
            }
        } catch (Exception ignored) {
            // unknown
        }
        return null;
    }

    static boolean matches(java.security.PrivateKey key, java.security.cert.X509Certificate cert) {
        String alg = switch (key.getAlgorithm().toUpperCase(java.util.Locale.ROOT)) {
            case "RSA" -> "SHA256withRSA";
            case "EC" -> "SHA256withECDSA";
            case "ED25519", "EDDSA" -> "Ed25519";
            case "ED448" -> "Ed448";
            default -> null;
        };
        if (alg == null) {
            return false;
        }
        try {
            byte[] challenge = new byte[32];
            new java.security.SecureRandom().nextBytes(challenge);
            Signature s = Signature.getInstance(alg);
            s.initSign(key);
            s.update(challenge);
            byte[] sig = s.sign();
            Signature v = Signature.getInstance(alg);
            v.initVerify(cert.getPublicKey());
            v.update(challenge);
            return v.verify(sig);
        } catch (Exception e) {
            return false;
        }
    }

    static String pem(java.security.cert.X509Certificate c) {
        try {
            return "-----BEGIN CERTIFICATE-----\n" + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(c.getEncoded())
                    + "\n-----END CERTIFICATE-----\n";
        } catch (Exception e) {
            return "";
        }
    }

    static final List<String> TLS_FILES = List.of("server.crt", "server.key", "ca-chain.pem");

    /** Re-checks what the backend staged, backs up the https folder's files, installs, and verifies what the https entry serves. */
    static void certApply(Path s) {
        setState(s, "APPLYING", "التحقق من الشهادة المعتمدة ثم نسخ احتياطي وتثبيت");
        Path stagedKey = s.resolve("new/server.key");
        try {
            Properties plan = props(s.resolve("plan.properties"));
            Properties approval = props(s.resolve("approval.properties"));
            progress(s, "اعتمدها " + approval.getProperty("byName", "?") + ": " + approval.getProperty("reason", ""));
            Map<String, String> env = envValues();
            String rel = tlsDir(env);
            if (!rel.equals(clean(plan.getProperty("folder", "")))) {
                certReject(s, "تغير مجلد شهادة https في .env منذ الفحص (" + plan.getProperty("folder") + " → " + rel + ")؛ افحص من جديد.");
                return;
            }
            Path dir = folder(rel);
            if (dir == null || !certificateFolder(rel)) {
                certReject(s, "مجلد شهادة https غير مسموح للكتابة: " + rel);
                return;
            }
            List<java.security.cert.X509Certificate> crt = readCertificates(s.resolve("new/server.crt"));
            if (crt.isEmpty() || !sha256(crt.get(0).getEncoded()).equals(plan.getProperty("leafSha256"))) {
                certReject(s, "الشهادة المجهزة لا تطابق ما فُحص (تغيرت بعد الفحص)؛ لم يُكتب شيء.");
                return;
            }
            java.security.cert.X509Certificate leaf = crt.get(0);
            boolean newKey = Files.exists(stagedKey);
            java.security.PrivateKey key = newKey ? readKey(stagedKey) : readKey(dir.resolve("server.key"));
            if (key == null) {
                certReject(s, newKey ? "تعذرت قراءة المفتاح المجهز." : "لا يقرأ العامل server.key الحالي (غير موجود أو مشفر)؛ ارفع المفتاح مع الشهادة.");
                return;
            }
            if (!matches(key, leaf)) {
                certReject(s, "المفتاح الخاص لا يطابق الشهادة؛ لم يُكتب شيء.");
                return;
            }
            progress(s, "المفتاح يطابق الشهادة");
            if (Instant.now().isAfter(leaf.getNotAfter().toInstant()) || Instant.now().isBefore(leaf.getNotBefore().toInstant())) {
                certReject(s, "الشهادة ليست سارية الآن؛ لم يُكتب شيء.");
                return;
            }
            String space = freeSpaceProblem(INSTALL, 1L << 20);
            if (space != null) {
                certReject(s, space);
                return;
            }
            Files.createDirectories(dir);
            Path backup = INSTALL.resolve("backups/certificates").resolve(s.getFileName());
            Files.createDirectories(backup);
            List<String> had = new ArrayList<>();
            for (String f : TLS_FILES) {
                if (Files.isRegularFile(dir.resolve(f), LinkOption.NOFOLLOW_LINKS)) {
                    copyKeepingPrivate(dir.resolve(f), backup.resolve(f));
                    had.add(f);
                }
            }
            write(backup.resolve("had.txt"), String.join("\n", had));
            putPrivate(dir.resolve("server.crt"), Files.readAllBytes(s.resolve("new/server.crt")), false);
            putPrivate(dir.resolve("ca-chain.pem"), Files.readAllBytes(s.resolve("new/ca-chain.pem")), false);
            if (newKey) {
                putPrivate(dir.resolve("server.key"), Files.readAllBytes(stagedKey), true);
            }
            Files.deleteIfExists(stagedKey);
            progress(s, "ثُبتت الشهادة في " + rel + (newKey ? " مع مفتاحها" : " (المفتاح الحالي باقٍ)") + "؛ النسخة الاحتياطية في backups/certificates/"
                    + s.getFileName());
            if (!https(env)) {
                setState(s, "APPLIED_INACTIVE", "ثُبتت الشهادة وتحقق مفتاحها؛ https غير مفعل الآن، وتُستخدم عند تفعيله (ops/tls/enable.sh).");
                return;
            }
            setState(s, "VERIFYING", "انتظار أن تقدم نقطة https الشهادة الجديدة …");
            String served = waitServed(sha256(leaf.getEncoded()), plan.getProperty("host"));
            if (served == null) {
                setState(s, "APPLIED", "تقدم نقطة https الشهادة الجديدة الآن.");
                return;
            }
            progress(s, "فشل التحقق: " + served);
            certRestore(s, "FAILED_ROLLED_BACK", "لم تقدم نقطة https الشهادة الجديدة (" + served + ")؛ أُعيدت الشهادة السابقة تلقائياً");
        } catch (Exception e) {
            setState(s, "ERROR", "تعذر التثبيت: " + e.getMessage() + " — راجع backups/certificates/" + s.getFileName());
        } finally {
            try {
                Files.deleteIfExists(stagedKey);
            } catch (IOException ignored) {
                // the backend removes it with the session's staged files
            }
        }
    }

    static void certReject(Path s, String why) {
        setState(s, "REJECTED", why);
        try {
            Files.deleteIfExists(s.resolve("new/server.key"));
        } catch (IOException ignored) {
            // the backend removes it with the session's staged files
        }
    }

    static boolean https(Map<String, String> env) {
        return env.getOrDefault("COMPOSE_PROFILES", "").matches("(^|.*,)\\s*tls\\s*(,.*|$)");
    }

    static void certRestore(Path s, String finalState, String message) {
        try {
            Map<String, String> env = envValues();
            String rel = tlsDir(env);
            Path dir = folder(rel);
            Path backup = INSTALL.resolve("backups/certificates").resolve(s.getFileName());
            if (dir == null || !Files.exists(backup.resolve("had.txt"))) {
                setState(s, "ERROR", "لا نسخة احتياطية لهذا الطلب في backups/certificates/" + s.getFileName());
                return;
            }
            setState(s, "RESTORING", "استعادة الشهادة السابقة من النسخة الاحتياطية");
            Set<String> had = new HashSet<>(Files.readAllLines(backup.resolve("had.txt"), StandardCharsets.UTF_8));
            for (String f : TLS_FILES) {
                if (had.contains(f)) {
                    putPrivate(dir.resolve(f), Files.readAllBytes(backup.resolve(f)), f.endsWith(".key"));
                } else if (!f.equals("server.key")) {
                    Files.deleteIfExists(dir.resolve(f));
                }
            }
            List<java.security.cert.X509Certificate> old = had.contains("server.crt") ? readCertificates(dir.resolve("server.crt")) : List.of();
            if (https(env) && !old.isEmpty()) {
                String served = waitServed(sha256(old.get(0).getEncoded()), props(s.resolve("plan.properties")).getProperty("host"));
                if (served != null) {
                    setState(s, "ERROR", message + "، لكن نقطة https لا تقدمها بعد: " + served + " — راجع ops/diagnose.sh");
                    return;
                }
            }
            setState(s, finalState, message);
        } catch (Exception e) {
            setState(s, "ERROR", "تعذرت الاستعادة: " + e.getMessage());
        }
    }

    /** Null once the https entry point serves the certificate {@code sha}; else what it serves (or why it cannot be reached). */
    static String waitServed(String sha, String host) throws InterruptedException {
        Instant until = Instant.now().plus(TLS_VERIFY);
        String last = "لا اتصال";
        while (Instant.now().isBefore(until)) {
            last = servedCertificate(host);
            if (sha.equals(last)) {
                return null;
            }
            Thread.sleep(3000);
        }
        return last.matches("[0-9a-f]{64}") ? "ما زالت تقدم شهادة أخرى (" + last.substring(0, 12) + "…)" : last;
    }

    /** The SHA-256 of the certificate the https entry point presents (any trust: only its identity is compared). */
    static String servedCertificate(String host) {
        try {
            javax.net.ssl.SSLContext ctx = javax.net.ssl.SSLContext.getInstance("TLS");
            ctx.init(null, new javax.net.ssl.TrustManager[]{new javax.net.ssl.X509TrustManager() {
                public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) {
                }

                public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) {
                }

                public java.security.cert.X509Certificate[] getAcceptedIssuers() {
                    return new java.security.cert.X509Certificate[0];
                }
            }}, null);
            try (javax.net.ssl.SSLSocket socket = (javax.net.ssl.SSLSocket) ctx.getSocketFactory().createSocket()) {
                socket.connect(new java.net.InetSocketAddress(PROXY_HOST, PROXY_PORT), 3000);
                socket.setSoTimeout(5000);
                if (host != null && !host.isBlank() && !host.matches("[0-9.:]+")) {
                    javax.net.ssl.SSLParameters p = socket.getSSLParameters();
                    p.setServerNames(List.of(new javax.net.ssl.SNIHostName(host)));
                    socket.setSSLParameters(p);
                }
                socket.startHandshake();
                return sha256(socket.getSession().getPeerCertificates()[0].getEncoded());
            }
        } catch (Exception e) {
            return "تعذر الاتصال بنقطة https (" + PROXY_HOST + ":" + PROXY_PORT + "): " + e.getClass().getSimpleName();
        }
    }

    static void copyKeepingPrivate(Path from, Path to) throws IOException {
        putPrivate(to, Files.readAllBytes(from), from.getFileName().toString().endsWith(".key"));
    }

    /** Written beside the target then moved over it; a key file is readable by its owner only. */
    static void putPrivate(Path target, byte[] content, boolean secret) throws IOException {
        Files.createDirectories(target.getParent());
        Path tmp = target.resolveSibling("." + target.getFileName() + ".tmrkz-cert");
        Files.deleteIfExists(tmp);
        if (secret) {
            try {
                Files.createFile(tmp, java.nio.file.attribute.PosixFilePermissions.asFileAttribute(
                        java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")));
            } catch (UnsupportedOperationException e) {
                Files.createFile(tmp);
            }
            Files.write(tmp, content, StandardOpenOption.TRUNCATE_EXISTING);
        } else {
            Files.write(tmp, content);
        }
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
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
