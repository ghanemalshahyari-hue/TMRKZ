package ae.mover.security;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
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

/**
 * «الشهادات» (ADR-105): the certificates this installation uses, and their replacement from the browser — checked, shown,
 * applied only on an explicit, reasoned and recently re-authenticated approval, health-checked, recoverable.
 *
 * <ul>
 *   <li>{@code DIRECTORY} and {@code OIDC}: the CA certificates the enterprise directory and the enterprise Keycloak are trusted
 *       through — each service its own list, kept in its saved section of «إعدادات التكامل» and applied at once (no restart).
 *       Before anything is applied, a live protected connection to that server is made with the new list (certificate chain and
 *       host name); a list that would break a connection that works now is refused. After applying, the same connection is
 *       made again and the previous list comes back by itself when it fails.</li>
 *   <li>{@code HTTPS}: the server certificate of the https entry point (TMRKZ_TLS_DIR: server.crt, server.key, ca-chain.pem).
 *       The backend never writes it: it checks (key, validity, server authentication, host name, chain) and stages the files in
 *       the update volume; the maintenance worker re-checks, backs up, installs, verifies what the https entry point serves, and
 *       restores the backup when that fails or when asked.</li>
 * </ul>
 *
 * The certificate folders the running configuration actually uses (TMRKZ_TLS_DIR, TMRKZ_TRUSTSTORE_DIR, the {@code certs/}
 * folder) are listed from the maintenance worker's read-only inventory, and any certificate in them can be the source of an
 * import. A private key is accepted only for HTTPS, held only in the staging volume (owner-only file) until the worker installs
 * it, and never appears in a response, the audit log or a log line.
 */
@Service
public class CertificateService {

    private static final Logger log = LoggerFactory.getLogger(CertificateService.class);
    static final Set<String> TARGETS = Set.of("HTTPS", "DIRECTORY", "OIDC");
    private static final Pattern SESSION = Pattern.compile("[0-9]{8}T[0-9]{6}-[0-9a-f]{8}");
    private static final Set<String> WORKER_FINAL = Set.of("APPLIED", "APPLIED_INACTIVE", "FAILED_ROLLED_BACK", "RESTORED", "REJECTED", "ERROR");
    private static final Set<String> FINAL = Set.of("APPLIED", "APPLIED_INACTIVE", "FAILED_ROLLED_BACK", "RESTORED", "REJECTED", "ERROR",
            "BLOCKED", "DISCARDED");
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss").withZone(ZoneOffset.UTC);
    private static final long MAX_UPLOAD = 6L * 1024 * 1024;

    public record FileInput(String name, String contentBase64) {

        @Override
        public String toString() {
            return "FileInput[" + name + "]"; // never the content
        }
    }

    /** A certificate file the inventory lists: {@code store} HTTPS, TRUST_FOLDER or CERTS, and its file name. */
    public record InventoryRef(String store, String file) {
    }

    public record CheckInput(String target, String mode, String hostname, String password, List<FileInput> files, List<InventoryRef> fromInventory) {

        @Override
        public String toString() {
            return "CheckInput[" + target + " " + mode + "]"; // never the password or the files
        }
    }

    public record ReasonInput(String reason) {
    }

    private final Path updateRoot;
    private final Path root;
    private final IntegrationSettingsService settings;
    private final DirectoryAuthenticator directory;
    private final OidcClient oidc;
    private final AuditService audit;
    private final AuthService auth;
    private final OidcProperties oidcProps;
    private final Json json;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    public CertificateService(@Value("${tmrkz.update.dir:/update}") String dir, IntegrationSettingsService settings,
                              DirectoryAuthenticator directory, OidcClient oidc, AuditService audit, AuthService auth, OidcProperties oidcProps,
                              Json json, Clock clock) {
        this.updateRoot = Path.of(dir);
        this.root = updateRoot.resolve("certificates");
        this.settings = settings;
        this.directory = directory;
        this.oidc = oidc;
        this.audit = audit;
        this.auth = auth;
        this.oidcProps = oidcProps;
        this.json = json;
        this.clock = clock;
    }

    private static void require(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("يدير الشهادات مدير نظام عام فقط (إعداد النظام وإدارة الصلاحيات على كل الوحدات).");
        }
    }

    private void stepUp(AccessContext ctx) {
        Instant at = ctx.actor().sessionId() == null ? null : auth.authenticatedAt(ctx.actor().sessionId()).orElse(null);
        if (at == null || at.isBefore(clock.instant().minusSeconds(oidcProps.reauthMaxAgeSeconds()))) {
            throw new ApiException(ErrorCode.REAUTHENTICATION_REQUIRED, "سجّل الدخول من جديد ثم طبّق؛ لم يتغير شيء.");
        }
    }

    // ---- the inventory ----------------------------------------------------------------------------------------------

    public Map<String, Object> overview(AccessContext ctx) {
        require(ctx);
        Instant now = clock.instant();
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> inv = readJson(updateRoot.resolve("certificate-inventory.json"));
        Map<String, Object> worker = readJson(updateRoot.resolve("worker.json"));
        boolean alive = worker != null && worker.get("at") != null && Instant.parse((String) worker.get("at")).isAfter(now.minusSeconds(20));
        if (inv == null || inv.get("at") == null || Instant.parse(String.valueOf(inv.get("at"))).isBefore(now.minusSeconds(10))) {
            try {
                Files.writeString(updateRoot.resolve("certificate-inventory.request"), now.toString()); // the worker lists again within a second
            } catch (IOException e) {
                log.debug("inventory request not written: {}", e.getClass().getSimpleName());
            }
        }
        out.put("worker", Map.of("alive", alive, "inventoryAt", inv == null ? "" : String.valueOf(inv.get("at"))));
        out.put("config", inv == null ? Map.of() : inv.getOrDefault("config", Map.of()));
        List<Map<String, Object>> stores = new ArrayList<>();
        int expired = 0;
        int expiring = 0;
        if (inv != null) {
            for (Object o : (List<?>) inv.getOrDefault("stores", List.of())) {
                @SuppressWarnings("unchecked")
                Map<String, Object> st = (Map<String, Object>) o;
                Map<String, Object> view = new LinkedHashMap<>(st);
                List<Map<String, Object>> files = new ArrayList<>();
                for (Object fo : (List<?>) st.getOrDefault("files", List.of())) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> f = new LinkedHashMap<>((Map<String, Object>) fo);
                    Object pem = f.remove("pem");
                    if (pem instanceof String p && !p.isBlank()) {
                        List<Map<String, Object>> certs = new ArrayList<>();
                        try {
                            for (X509Certificate c : CertificateInspector.certificates(p)) {
                                Map<String, Object> d = CertificateInspector.describe(c, now);
                                certs.add(d);
                                expired += "EXPIRED".equals(d.get("health")) ? 1 : 0;
                                expiring += "EXPIRING".equals(d.get("health")) ? 1 : 0;
                            }
                        } catch (IllegalArgumentException e) {
                            f.put("error", e.getMessage());
                        }
                        f.put("certificates", certs);
                    }
                    files.add(f);
                }
                // the key of this folder, matched by its public key against the certificates beside it (never its content)
                for (Map<String, Object> f : files) {
                    if ("KEY".equals(f.get("kind")) && f.get("publicKeySha256") != null) {
                        List<String> matching = new ArrayList<>();
                        for (Map<String, Object> g : files) {
                            for (Object c : (List<?>) g.getOrDefault("certificates", List.of())) {
                                @SuppressWarnings("unchecked")
                                Map<String, Object> cm = (Map<String, Object>) c;
                                if (f.get("publicKeySha256").equals(cm.get("publicKeySha256"))) {
                                    matching.add(g.get("name") + ":" + cm.get("subjectCn"));
                                }
                            }
                        }
                        f.put("matches", matching);
                    }
                }
                view.put("files", files);
                stores.add(view);
            }
        }
        for (String kind : List.of("DIRECTORY", "OIDC")) {
            Map<String, Object> st = new LinkedHashMap<>();
            st.put("id", kind);
            st.put("saved", settings.sectionSaved(kind));
            st.put("server", settings.savedServer(kind));
            List<Map<String, Object>> certs = new ArrayList<>();
            try {
                for (X509Certificate c : CertificateInspector.certificates(settings.savedCaPem(kind))) {
                    Map<String, Object> d = CertificateInspector.describe(c, now);
                    certs.add(d);
                    expired += "EXPIRED".equals(d.get("health")) ? 1 : 0;
                    expiring += "EXPIRING".equals(d.get("health")) ? 1 : 0;
                }
            } catch (RuntimeException e) {
                st.put("error", e.getMessage());
            }
            st.put("certificates", certs);
            stores.add(st);
        }
        out.put("stores", stores);
        out.put("summary", Map.of("expired", expired, "expiring", expiring));
        List<Map<String, Object>> sessions = new ArrayList<>();
        // newest first by the time each request was made (two made within the same second keep their real order)
        List<String> ids = new ArrayList<>(sessionIds());
        ids.sort(java.util.Comparator.comparing((String id) -> props(root.resolve(id).resolve("request.properties")).getProperty("at", ""))
                .reversed());
        for (String id : ids) {
            Path s = root.resolve(id);
            Properties r = props(s.resolve("request.properties"));
            Map<String, Object> st = readJson(s.resolve("state.json"));
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("target", r.getProperty("target"));
            m.put("state", shownState(s));
            m.put("message", st == null ? null : st.get("message"));
            m.put("createdAt", r.getProperty("at"));
            m.put("createdBy", r.getProperty("byName"));
            sessions.add(m);
            if (sessions.size() >= 20) {
                break;
            }
        }
        out.put("sessions", sessions);
        return out;
    }

    // ---- check and preview --------------------------------------------------------------------------------------------

    public Map<String, Object> check(AccessContext ctx, CheckInput in) {
        require(ctx);
        String target = in == null || in.target() == null ? "" : in.target().trim().toUpperCase(Locale.ROOT);
        if (!TARGETS.contains(target)) {
            throw ApiException.validation("اختر الخدمة: شهادة https للخادم، أو ثقة الدليل المؤسسي، أو ثقة Keycloak.");
        }
        String mode = in.mode() == null ? "ADD" : in.mode().trim().toUpperCase(Locale.ROOT);
        if (!Set.of("ADD", "REPLACE").contains(mode)) {
            throw ApiException.validation("طريقة غير معروفة: إضافة أو استبدال.");
        }
        List<CertificateInspector.Upload> uploads = uploads(in);
        char[] password = in.password() == null || in.password().isEmpty() ? null : in.password().toCharArray();
        CertificateInspector.Parsed parsed;
        try {
            parsed = CertificateInspector.parse(uploads, password);
        } catch (IllegalArgumentException e) {
            throw ApiException.validation(e.getMessage());
        } finally {
            if (password != null) {
                Arrays.fill(password, '\0');
            }
        }
        Instant now = clock.instant();
        List<Map<String, Object>> checks = new ArrayList<>();
        Map<String, Object> plan = new LinkedHashMap<>();
        for (String n : parsed.notes()) {
            add(checks, "NOTE", "INFO", n);
        }
        if (parsed.certificates().isEmpty()) {
            add(checks, "CERTIFICATE", "FAIL", "لا شهادة في الملفات المختارة.");
        }
        String id = newId();
        Path s = root.resolve(id);
        Staged staged = null;
        if (!parsed.certificates().isEmpty()) {
            staged = "HTTPS".equals(target) ? https(parsed, in.hostname(), checks, plan, now) : trust(target, mode, parsed, checks, plan, now);
        }
        boolean blocked = checks.stream().anyMatch(c -> "FAIL".equals(c.get("status")));
        List<Map<String, Object>> described = new ArrayList<>();
        for (X509Certificate c : parsed.certificates()) {
            described.add(CertificateInspector.describe(c, now));
        }
        try {
            Files.createDirectories(s);
            Properties r = new Properties();
            r.setProperty("target", target);
            r.setProperty("mode", mode);
            r.setProperty("by", ctx.personId().toString());
            r.setProperty("byName", String.valueOf(ctx.actor().displayName()));
            r.setProperty("at", now.toString());
            r.setProperty("files", String.join(", ", uploads.stream().map(CertificateInspector.Upload::name).toList()));
            r.setProperty("keyProvided", String.valueOf(parsed.key() != null));
            writeProps(s.resolve("request.properties"), r);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("checks", checks);
            result.put("plan", plan);
            result.put("certificates", described);
            Files.writeString(s.resolve("check.json"), json.write(result), StandardCharsets.UTF_8);
            if (!blocked && staged != null) {
                staged.write(s, parsed);
            }
            setState(s, blocked ? "BLOCKED" : "CHECKED", blocked ? "لا يُطبق: فشل فحص أو أكثر؛ لم يُحفظ شيء من الملفات." : "فُحص؛ بانتظار التطبيق الصريح.");
        } catch (IOException e) {
            throw new IllegalStateException("staging volume not writable: " + e.getMessage(), e);
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("target", target);
        detail.put("mode", mode);
        detail.put("certificates", parsed.certificates().stream().map(CertificateInspector::sha256).toList());
        detail.put("privateKeyProvided", parsed.key() != null);
        detail.put("failed", checks.stream().filter(c -> "FAIL".equals(c.get("status"))).map(c -> c.get("code")).toList());
        audit.recordAs(ctx.actor(), "CERT_CHECKED", "CERTIFICATE", id, target, detail, null);
        return view(ctx, id);
    }

    /** What an applicable check leaves in the session for its application. */
    private interface Staged {
        void write(Path session, CertificateInspector.Parsed parsed) throws IOException;
    }

    private List<CertificateInspector.Upload> uploads(CheckInput in) {
        List<CertificateInspector.Upload> out = new ArrayList<>();
        long total = 0;
        if (in.files() != null) {
            for (FileInput f : in.files()) {
                if (f == null || f.contentBase64() == null) {
                    continue;
                }
                byte[] b;
                try {
                    b = Base64.getMimeDecoder().decode(f.contentBase64());
                } catch (IllegalArgumentException e) {
                    throw ApiException.validation("تعذرت قراءة الملف " + f.name() + ".");
                }
                total += b.length;
                out.add(new CertificateInspector.Upload(safeName(f.name()), b));
            }
        }
        if (in.fromInventory() != null && !in.fromInventory().isEmpty()) {
            Map<String, Object> inv = readJson(updateRoot.resolve("certificate-inventory.json"));
            for (InventoryRef ref : in.fromInventory()) {
                String pem = inventoryPem(inv, ref);
                if (pem == null) {
                    throw ApiException.validation("الملف غير موجود في قائمة الشهادات الحالية: " + ref.file());
                }
                byte[] b = pem.getBytes(StandardCharsets.US_ASCII);
                total += b.length;
                out.add(new CertificateInspector.Upload(safeName(ref.file()), b));
            }
        }
        if (out.isEmpty()) {
            throw ApiException.validation("اختر ملف شهادة، أو شهادة من القائمة الحالية.");
        }
        if (total > MAX_UPLOAD) {
            throw ApiException.validation("الملفات أكبر من 6 MB.");
        }
        return out;
    }

    private static String safeName(String n) {
        String s = n == null ? "file" : n.replaceAll("[^\\p{L}\\p{N}._ -]", "_");
        return s.length() > 120 ? s.substring(0, 120) : s;
    }

    /** The PEM of a certificate file the worker listed (certificates only: the inventory never carries a key). */
    @SuppressWarnings("unchecked")
    private static String inventoryPem(Map<String, Object> inv, InventoryRef ref) {
        if (inv == null || ref == null) {
            return null;
        }
        for (Object o : (List<?>) inv.getOrDefault("stores", List.of())) {
            Map<String, Object> st = (Map<String, Object>) o;
            if (!String.valueOf(st.get("id")).equals(ref.store())) {
                continue;
            }
            for (Object fo : (List<?>) st.getOrDefault("files", List.of())) {
                Map<String, Object> f = (Map<String, Object>) fo;
                if (String.valueOf(f.get("name")).equals(ref.file()) && f.get("pem") instanceof String p && !p.isBlank()) {
                    return p;
                }
            }
        }
        return null;
    }

    // ---- the trust of a service (directory, Keycloak) ----------------------------------------------------------------------

    private Staged trust(String kind, String mode, CertificateInspector.Parsed parsed, List<Map<String, Object>> checks, Map<String, Object> plan,
                         Instant now) {
        String label = "DIRECTORY".equals(kind) ? "الدليل المؤسسي" : "Keycloak المؤسسة";
        if (parsed.key() != null) {
            add(checks, "PRIVATE_KEY", "FAIL", "في الملفات مفتاح خاص؛ ثقة " + label + " تحتاج شهادات الجهات المصدرة وحدها، ولا يُحفظ المفتاح.");
        }
        boolean saved = settings.sectionSaved(kind);
        if (!saved) {
            add(checks, "SECTION", "FAIL", "قسم " + label + " غير محفوظ في «إعدادات التكامل»: احفظه (أو استورده من ملف إعدادات) أولاً؛"
                    + " تُضاف الشهادات إلى ذلك القسم. (تبقى شهادات مجلد الثقة TMRKZ_TRUSTSTORE_DIR موثوقة كما هي.)");
        }
        List<X509Certificate> current = saved ? CertificateInspector.certificates(settings.savedCaPem(kind)) : List.of();
        List<String> currentSha = current.stream().map(CertificateInspector::sha256).toList();
        int valid = 0;
        for (X509Certificate c : parsed.certificates()) {
            String cn = CertificateInspector.cn(c.getSubjectX500Principal().getName());
            switch (CertificateInspector.health(c, now)) {
                case "EXPIRED" -> add(checks, "VALIDITY", "FAIL", cn + ": انتهت صلاحيتها في " + c.getNotAfter().toInstant() + ".");
                case "NOT_YET_VALID" -> add(checks, "VALIDITY", "FAIL", cn + ": لا تبدأ صلاحيتها قبل " + c.getNotBefore().toInstant() + ".");
                case "EXPIRING" -> add(checks, "VALIDITY", "WARN", cn + ": تنتهي خلال 30 يوماً (" + c.getNotAfter().toInstant() + ").");
                default -> valid++;
            }
            if (c.getBasicConstraints() < 0 && !CertificateInspector.selfSigned(c)) {
                add(checks, "CA", "WARN", cn + ": ليست شهادة جهة إصدار (CA)؛ تُوثق بها شهادة هذا الخادم وحدها، ويلزم تبديلها عند تجديده.");
            }
            if (currentSha.contains(CertificateInspector.sha256(c))) {
                add(checks, "DUPLICATE", "INFO", cn + ": موجودة في القائمة الحالية.");
            }
        }
        if (valid > 0) {
            add(checks, "VALIDITY", "PASS", valid + " شهادة سارية الآن.");
        }
        List<X509Certificate> after = new ArrayList<>("REPLACE".equals(mode) ? List.of() : current);
        for (X509Certificate c : parsed.certificates()) {
            if (after.stream().noneMatch(x -> CertificateInspector.sha256(x).equals(CertificateInspector.sha256(c)))) {
                after.add(c);
            }
        }
        StringBuilder afterPem = new StringBuilder();
        after.forEach(c -> afterPem.append(CertificateInspector.pem(c)));
        StringBuilder beforePem = new StringBuilder();
        current.forEach(c -> beforePem.append(CertificateInspector.pem(c)));
        plan.put("target", kind);
        plan.put("mode", mode);
        plan.put("server", settings.savedServer(kind));
        plan.put("before", current.stream().map(c -> CertificateInspector.describe(c, now)).toList());
        plan.put("after", after.stream().map(c -> CertificateInspector.describe(c, now)).toList());
        plan.put("folderNote", "وتبقى موثوقة شهادات مجلد الثقة (TMRKZ_TRUSTSTORE_DIR) المقروء للخادم.");
        plan.put("restart", "لا إعادة تشغيل: يسري فور التطبيق.");
        Boolean liveBefore = null;
        if (saved) {
            try {
                Probe before = live(kind, beforePem.toString());
                Probe next = live(kind, afterPem.toString());
                liveBefore = before.ok();
                String server = String.valueOf(settings.savedServer(kind));
                if (next.ok()) {
                    add(checks, "LIVE_TLS", "PASS", "اتصال مؤمَّن ناجح بـ " + server + " بالقائمة الجديدة (السلسلة واسم الخادم): " + next.message());
                } else if (before.ok()) {
                    add(checks, "LIVE_TLS", "FAIL", "الاتصال بـ " + server + " ينجح الآن ويفشل بالقائمة الجديدة؛ تطبيقها يقطعه: " + next.message());
                } else {
                    add(checks, "LIVE_TLS", "WARN", "لا ينجح الاتصال بـ " + server + " قبل التغيير ولا بعده: " + next.message());
                }
            } catch (RuntimeException e) {
                add(checks, "LIVE_TLS", "WARN", "لم يُختبر الاتصال: " + e.getMessage());
            }
        }
        plan.put("liveBefore", liveBefore);
        String finalPem = afterPem.toString();
        String previous = beforePem.toString();
        return (s, p) -> {
            Files.writeString(s.resolve("candidate.pem"), finalPem, StandardCharsets.US_ASCII);
            Files.writeString(s.resolve("previous.pem"), previous, StandardCharsets.US_ASCII);
        };
    }

    private record Probe(boolean ok, String message) {
    }

    /** A protected connection to the service's saved server through the given CA list (chain and host name checked). */
    private Probe live(String kind, String pem) {
        if ("DIRECTORY".equals(kind)) {
            LdapProperties p = settings.savedDirectoryWith(pem);
            DirectoryAuthenticator.TestResult r = directory.test(p, null, null);
            return new Probe(r.ok(), r.message());
        }
        OidcProperties.Provider p = settings.savedOidcProvider();
        OidcClient.Probe r = oidc.probe(p, settings.sslFor(pem), 6000);
        return new Probe(r.ok(), r.message());
    }

    // ---- the https server certificate ------------------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private Staged https(CertificateInspector.Parsed parsed, String hostname, List<Map<String, Object>> checks, Map<String, Object> plan, Instant now) {
        Map<String, Object> inv = readJson(updateRoot.resolve("certificate-inventory.json"));
        Map<String, Object> worker = readJson(updateRoot.resolve("worker.json"));
        boolean alive = worker != null && worker.get("at") != null && Instant.parse((String) worker.get("at")).isAfter(now.minusSeconds(20));
        Map<String, Object> store = null;
        Map<String, Object> config = inv == null ? Map.of() : (Map<String, Object>) inv.getOrDefault("config", Map.of());
        if (inv != null) {
            for (Object o : (List<?>) inv.getOrDefault("stores", List.of())) {
                if ("HTTPS".equals(((Map<String, Object>) o).get("id"))) {
                    store = (Map<String, Object>) o;
                }
            }
        }
        if (!alive || store == null) {
            add(checks, "WORKER", "FAIL", "عامل الصيانة لا يعمل أو لم يرسل قائمة الشهادات؛ شهادة الخادم يكتبها هو وحده.");
            return null;
        }
        if (!Boolean.TRUE.equals(store.get("writable"))) {
            add(checks, "FOLDER", "FAIL", "مجلد شهادة https (" + store.get("path") + ") لا يصل إليه عامل الصيانة للكتابة"
                    + (store.get("note") == null ? "" : ": " + store.get("note")) + ".");
        }
        String keySpki = null;
        boolean keyOnServer = false;
        List<X509Certificate> existing = new ArrayList<>();
        X509Certificate currentLeaf = null;
        for (Object fo : (List<?>) store.getOrDefault("files", List.of())) {
            Map<String, Object> f = (Map<String, Object>) fo;
            if ("server.key".equals(f.get("name"))) {
                keyOnServer = true;
                keySpki = (String) f.get("publicKeySha256");
            }
            if (f.get("pem") instanceof String p && !p.isBlank()) {
                try {
                    List<X509Certificate> cs = CertificateInspector.certificates(p);
                    existing.addAll(cs);
                    if ("server.crt".equals(f.get("name")) && !cs.isEmpty()) {
                        currentLeaf = cs.get(0);
                    }
                } catch (IllegalArgumentException ignored) {
                    // an unreadable file does not help the chain
                }
            }
        }
        // the leaf: the certificate of the key that goes with it
        X509Certificate leaf = null;
        boolean keyWorkerChecks = false;
        if (parsed.key() != null) {
            for (X509Certificate c : parsed.certificates()) {
                if (CertificateInspector.matches(parsed.key(), c)) {
                    leaf = c;
                    break;
                }
            }
            if (leaf == null) {
                add(checks, "KEY_MATCH", "FAIL", "المفتاح الخاص المختار لا يطابق أي شهادة في الملفات.");
                return null;
            }
            add(checks, "KEY_MATCH", "PASS", "المفتاح الخاص المرفوع يطابق الشهادة (تحقق بتوقيع تجريبي؛ لا يُعرض المفتاح).");
        } else if (keySpki != null) {
            for (X509Certificate c : parsed.certificates()) {
                if (keySpki.equals(CertificateInspector.spki(c.getPublicKey()))) {
                    leaf = c;
                }
            }
            if (leaf == null) {
                add(checks, "KEY_MATCH", "FAIL", "الشهادة لا تحمل مفتاح هذا الخادم (server.key)؛ هل صدرت لطلب CSR آخر؟ أو ارفع مفتاحها معها.");
                return null;
            }
            add(checks, "KEY_MATCH", "PASS", "الشهادة تحمل المفتاح الموجود على الخادم (server.key)، ويبقى المفتاح في مكانه.");
        } else if (keyOnServer) {
            List<X509Certificate> leaves = parsed.certificates().stream().filter(c -> c.getBasicConstraints() < 0).toList();
            if (leaves.size() != 1) {
                add(checks, "KEY_MATCH", "FAIL", "تعذر تحديد شهادة الخادم بين الملفات؛ اختر شهادة خادم واحدة.");
                return null;
            }
            leaf = leaves.get(0);
            keyWorkerChecks = true;
            add(checks, "KEY_MATCH", "WARN", "يتحقق عامل الصيانة من مطابقة server.key للشهادة قبل الكتابة (لا يُقرأ المفتاح هنا).");
        } else {
            add(checks, "KEY_MATCH", "FAIL", "لا يوجد مفتاح خاص لهذه الشهادة على الخادم: ارفع المفتاح أو ملف PFX مع كلمة مروره،"
                    + " أو أنشئ الطلب على الخادم (ops/tls/make-csr.sh).");
            return null;
        }
        int bits = CertificateInspector.bits(leaf.getPublicKey());
        String alg = leaf.getPublicKey().getAlgorithm();
        if ("RSA".equals(alg) && bits < 2048 || "EC".equals(alg) && bits < 256) {
            add(checks, "KEY_STRENGTH", "FAIL", "مفتاح ضعيف (" + alg + " " + bits + ")؛ الحد الأدنى RSA 2048 أو EC 256.");
        } else {
            add(checks, "KEY_STRENGTH", "PASS", alg + " " + bits);
        }
        switch (CertificateInspector.health(leaf, now)) {
            case "EXPIRED" -> add(checks, "VALIDITY", "FAIL", "انتهت صلاحية الشهادة في " + leaf.getNotAfter().toInstant() + ".");
            case "NOT_YET_VALID" -> add(checks, "VALIDITY", "FAIL", "لا تبدأ صلاحية الشهادة قبل " + leaf.getNotBefore().toInstant() + ".");
            case "EXPIRING" -> add(checks, "VALIDITY", "WARN", "سارية حتى " + leaf.getNotAfter().toInstant() + " (30 يوماً أو أقل).");
            default -> add(checks, "VALIDITY", "PASS", "سارية حتى " + leaf.getNotAfter().toInstant() + ".");
        }
        Boolean sa = CertificateInspector.serverAuth(leaf);
        if (Boolean.FALSE.equals(sa)) {
            add(checks, "SERVER_AUTH", "FAIL", "الشهادة ليست لمصادقة الخادم (القالب المطلوب «Web Server»).");
        } else {
            add(checks, "SERVER_AUTH", "PASS", sa == null ? "لا تقيد الشهادة الاستخدام (تصلح للخادم)." : "لمصادقة الخادم (TLS Web Server).");
        }
        String host = hostname != null && !hostname.isBlank() ? hostname.trim() : (String) config.get("publicHost");
        List<String> names = new ArrayList<>(CertificateInspector.names(leaf, 2));
        names.addAll(CertificateInspector.names(leaf, 7));
        if (host == null || host.isBlank()) {
            add(checks, "HOSTNAME", "WARN", "لا اسم خادم للمطابقة؛ أسماء الشهادة: " + names + ".");
        } else if (CertificateInspector.hostMatches(leaf, host)) {
            add(checks, "HOSTNAME", "PASS", "اسم الخادم " + host + " من أسماء الشهادة " + names + ".");
        } else {
            add(checks, "HOSTNAME", "FAIL", "اسم الخادم " + host + " ليس من أسماء الشهادة " + names + "؛ سيرفضها المتصفح.");
        }
        List<X509Certificate> pool = new ArrayList<>(parsed.certificates());
        pool.addAll(existing);
        List<X509Certificate> path = CertificateInspector.chainOf(leaf, pool);
        X509Certificate last = path.get(path.size() - 1);
        List<X509Certificate> intermediates = new ArrayList<>();
        X509Certificate rootCa = null;
        if (!CertificateInspector.selfSigned(last)) {
            add(checks, "CHAIN", "FAIL", "السلسلة ناقصة: لا توجد الجهة المصدرة " + CertificateInspector.cn(last.getIssuerX500Principal().getName())
                    + "؛ أضف شهادات الجهة الوسيطة والجذرية (ملف .p7b أو .crt).");
        } else {
            String problem = CertificateInspector.validate(path, now, true);
            if (problem != null) {
                add(checks, "CHAIN", "FAIL", "لا تتحقق السلسلة: " + problem);
            } else {
                add(checks, "CHAIN", "PASS", "تتحقق السلسلة إلى " + CertificateInspector.cn(last.getSubjectX500Principal().getName()) + " ("
                        + path.size() + " شهادات؛ دون فحص الإلغاء: الخادم معزول).");
            }
            rootCa = path.size() > 1 ? last : null;
            intermediates.addAll(path.subList(1, Math.max(1, path.size() - 1)));
        }
        plan.put("target", "HTTPS");
        plan.put("folder", store.get("path"));
        plan.put("httpsEnabled", config.get("httpsEnabled"));
        plan.put("host", host);
        plan.put("current", currentLeaf == null ? null : CertificateInspector.describe(currentLeaf, now));
        plan.put("next", CertificateInspector.describe(leaf, now));
        List<String> writes = new ArrayList<>();
        writes.add("server.crt — شهادة الخادم و" + intermediates.size() + " جهة وسيطة");
        writes.add("ca-chain.pem — الجهات الوسيطة والجذرية");
        writes.add(parsed.key() != null ? "server.key — يُستبدل بالمفتاح المرفوع (صلاحية المالك وحده)" : "server.key — يبقى كما هو");
        plan.put("writes", writes);
        plan.put("restart", Boolean.TRUE.equals(config.get("httpsEnabled"))
                ? "تعيد نقطة https تحميل الشهادة وحدها؛ يتحقق العامل أنها تقدم الشهادة الجديدة، وإلا أعاد السابقة."
                : "https غير مفعل الآن: تُثبت الشهادة وتُستخدم عند تفعيله (ops/tls/enable.sh).");
        final X509Certificate theLeaf = leaf;
        final X509Certificate theRoot = rootCa;
        final boolean workerChecksKey = keyWorkerChecks;
        final String folder = String.valueOf(store.get("path"));
        final String host0 = host;
        return (s, p) -> {
            Path n = Files.createDirectories(s.resolve("new"));
            StringBuilder crt = new StringBuilder(CertificateInspector.pem(theLeaf));
            StringBuilder chain = new StringBuilder();
            for (X509Certificate c : intermediates) {
                crt.append(CertificateInspector.pem(c));
                chain.append(CertificateInspector.pem(c));
            }
            if (theRoot != null) {
                chain.append(CertificateInspector.pem(theRoot));
            }
            Files.writeString(n.resolve("server.crt"), crt.toString(), StandardCharsets.US_ASCII);
            Files.writeString(n.resolve("ca-chain.pem"), chain.toString(), StandardCharsets.US_ASCII);
            if (p.key() != null) {
                writeOwnerOnly(n.resolve("server.key"), CertificateInspector.keyPem(p.key()));
            }
            Properties plan0 = new Properties();
            plan0.setProperty("folder", folder);
            plan0.setProperty("leafSha256", CertificateInspector.sha256(theLeaf));
            plan0.setProperty("keyReplaced", String.valueOf(p.key() != null));
            plan0.setProperty("workerChecksKey", String.valueOf(workerChecksKey));
            plan0.setProperty("host", host0 == null ? "" : host0);
            writeProps(s.resolve("plan.properties"), plan0);
        };
    }

    // ---- apply, restore, discard -----------------------------------------------------------------------------------------

    public Map<String, Object> apply(AccessContext ctx, String id, ReasonInput in) {
        require(ctx);
        stepUp(ctx);
        String reason = reason(in, "اذكر سبب تطبيق الشهادات.");
        Path s = session(id);
        if (!"CHECKED".equals(stateOf(s)) || Files.exists(s.resolve("approval.properties"))) {
            throw new ApiException(ErrorCode.STALE_REVISION, "هذا الطلب ليس بانتظار التطبيق.");
        }
        Properties r = props(s.resolve("request.properties"));
        String target = r.getProperty("target");
        Properties a = new Properties();
        a.setProperty("by", ctx.personId().toString());
        a.setProperty("byName", String.valueOf(ctx.actor().displayName()));
        a.setProperty("at", clock.instant().toString());
        a.setProperty("reason", reason);
        try {
            writeProps(s.resolve("approval.properties"), a); // for HTTPS, the worker installs when this file appears
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        audit.recordAs(ctx.actor(), "CERT_APPROVED", "CERTIFICATE", id, target, Map.of("target", target), reason);
        if (!"HTTPS".equals(target)) {
            applyTrust(ctx, s, target, reason);
        }
        return view(ctx, id);
    }

    @SuppressWarnings("unchecked")
    private void applyTrust(AccessContext ctx, Path s, String kind, String reason) {
        try {
            String candidate = Files.readString(s.resolve("candidate.pem"), StandardCharsets.US_ASCII);
            String previous = settings.savedCaPem(kind);
            Files.writeString(s.resolve("previous.pem"), previous == null ? "" : previous, StandardCharsets.US_ASCII);
            Map<String, Object> check = readJson(s.resolve("check.json"));
            Object before = check == null ? null : ((Map<String, Object>) check.getOrDefault("plan", Map.of())).get("liveBefore");
            settings.replaceCaPem(kind, candidate, ctx.personId());
            progress(s, "طُبقت قائمة الشهادات على قسم " + kind);
            Probe after = live(kind, settings.savedCaPem(kind));
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("target", kind);
            detail.put("certificates", CertificateInspector.certificates(candidate).stream().map(CertificateInspector::sha256).toList());
            detail.put("previous", CertificateInspector.certificates(previous).stream().map(CertificateInspector::sha256).toList());
            detail.put("health", after.ok());
            if (!after.ok() && Boolean.TRUE.equals(before)) {
                settings.replaceCaPem(kind, previous, ctx.personId());
                setState(s, "FAILED_ROLLED_BACK", "فشل الاتصال بعد التطبيق (" + after.message() + ")؛ أُعيدت القائمة السابقة تلقائياً.");
                audit.recordAs(ctx.actor(), "CERT_APPLY_FAILED", "CERTIFICATE", s.getFileName().toString(), kind, detail, reason);
                return;
            }
            setState(s, "APPLIED", after.ok() ? "طُبقت؛ نجح الاتصال المؤمَّن بالقائمة الجديدة." : "طُبقت؛ الاتصال لا ينجح (ولم يكن ينجح قبلها): "
                    + after.message());
            audit.recordAs(ctx.actor(), "CERT_APPLIED", "CERTIFICATE", s.getFileName().toString(), kind, detail, reason);
        } catch (IOException e) {
            setState(s, "ERROR", "تعذر التطبيق: " + e.getMessage());
            throw new IllegalStateException(e);
        } catch (RuntimeException e) {
            setState(s, "ERROR", "تعذر التطبيق: " + e.getMessage());
            throw e;
        }
    }

    public Map<String, Object> restore(AccessContext ctx, String id, ReasonInput in) {
        require(ctx);
        stepUp(ctx);
        String reason = reason(in, "اذكر سبب الاستعادة.");
        Path s = session(id);
        String state = stateOf(s);
        if (!"APPLIED".equals(state) && !"APPLIED_INACTIVE".equals(state) || Files.exists(s.resolve("rollback.properties"))) {
            throw new ApiException(ErrorCode.STALE_REVISION, "يُستعاد ما طُبق فقط، مرة واحدة.");
        }
        Properties r = props(s.resolve("request.properties"));
        String target = r.getProperty("target");
        Properties p = new Properties();
        p.setProperty("by", ctx.personId().toString());
        p.setProperty("byName", String.valueOf(ctx.actor().displayName()));
        p.setProperty("at", clock.instant().toString());
        p.setProperty("reason", reason);
        try {
            writeProps(s.resolve("rollback.properties"), p);
            if (!"HTTPS".equals(target)) {
                String previous = Files.readString(s.resolve("previous.pem"), StandardCharsets.US_ASCII);
                settings.replaceCaPem(target, previous.isBlank() ? null : previous, ctx.personId());
                Probe after = live(target, previous);
                setState(s, "RESTORED", "أُعيدت القائمة السابقة؛ " + (after.ok() ? "نجح الاتصال المؤمَّن." : "الاتصال: " + after.message()));
            }
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        audit.recordAs(ctx.actor(), "CERT_RESTORE_REQUESTED", "CERTIFICATE", id, target, Map.of("target", target), reason);
        return view(ctx, id);
    }

    public Map<String, Object> discard(AccessContext ctx, String id) {
        require(ctx);
        Path s = session(id);
        String state = stateOf(s);
        if (!"CHECKED".equals(state) && !"BLOCKED".equals(state) || Files.exists(s.resolve("approval.properties"))) {
            throw new ApiException(ErrorCode.STALE_REVISION, "لا يُلغى هذا الطلب الآن.");
        }
        removeStaged(s);
        setState(s, "DISCARDED", "أُلغي؛ حُذفت الملفات المؤقتة.");
        audit.recordAs(ctx.actor(), "CERT_DISCARDED", "CERTIFICATE", id, props(s.resolve("request.properties")).getProperty("target"), Map.of(), null);
        return view(ctx, id);
    }

    public Map<String, Object> view(AccessContext ctx, String id) {
        require(ctx);
        Path s = session(id);
        Map<String, Object> out = new LinkedHashMap<>();
        Properties r = props(s.resolve("request.properties"));
        Map<String, Object> st = readJson(s.resolve("state.json"));
        out.put("id", id);
        out.put("target", r.getProperty("target"));
        out.put("mode", r.getProperty("mode"));
        out.put("files", r.getProperty("files"));
        out.put("keyProvided", Boolean.parseBoolean(r.getProperty("keyProvided", "false")));
        out.put("state", shownState(s));
        out.put("message", st == null ? null : st.get("message"));
        Map<String, Object> check = readJson(s.resolve("check.json"));
        out.put("checks", check == null ? List.of() : check.get("checks"));
        out.put("plan", check == null ? Map.of() : check.get("plan"));
        out.put("certificates", check == null ? List.of() : check.get("certificates"));
        Properties a = props(s.resolve("approval.properties"));
        out.put("approval", a.isEmpty() ? null : Map.of("by", a.getProperty("byName", ""), "at", a.getProperty("at", ""), "reason", a.getProperty("reason", "")));
        out.put("progress", progressLines(s));
        out.put("canRestore", ("APPLIED".equals(shownState(s)) || "APPLIED_INACTIVE".equals(shownState(s))) && !Files.exists(s.resolve("rollback.properties")));
        return out;
    }

    // ---- background ----------------------------------------------------------------------------------------------------

    /** Outcomes the worker reached are audited once; a check never approved within the hour is discarded with its key. */
    @Scheduled(fixedDelayString = "${tmrkz.update.audit-interval-ms:15000}", initialDelay = 25000)
    public void housekeeping() {
        Instant now = clock.instant();
        for (String id : sessionIds()) {
            Path s = root.resolve(id);
            String state = stateOf(s);
            Properties r = props(s.resolve("request.properties"));
            if (state != null && FINAL.contains(state)) {
                removeStaged(s);
            }
            if ("HTTPS".equals(r.getProperty("target")) && state != null && WORKER_FINAL.contains(state) && !Files.exists(s.resolve("audited-" + state))) {
                Map<String, Object> st = readJson(s.resolve("state.json"));
                audit.system("CERT_" + state, "CERTIFICATE", id, "HTTPS", Map.of("message", String.valueOf(st == null ? "" : st.get("message"))));
                try {
                    Files.writeString(s.resolve("audited-" + state), now.toString());
                } catch (IOException e) {
                    log.warn("audit marker of certificate session {} not written", id);
                }
            }
            String at = r.getProperty("at");
            if ("CHECKED".equals(state) && !Files.exists(s.resolve("approval.properties")) && at != null
                    && Instant.parse(at).isBefore(now.minusSeconds(3600))) {
                removeStaged(s);
                setState(s, "DISCARDED", "انتهت مهلة التطبيق (ساعة)؛ حُذفت الملفات المؤقتة. افحص من جديد.");
            }
        }
    }

    /** The staged files of a session that is over or abandoned, the private key first. */
    private static void removeStaged(Path s) {
        try {
            Files.deleteIfExists(s.resolve("new/server.key"));
            Files.deleteIfExists(s.resolve("new/server.crt"));
            Files.deleteIfExists(s.resolve("new/ca-chain.pem"));
            Files.deleteIfExists(s.resolve("new"));
        } catch (IOException e) {
            log.warn("staged certificate files of {} not removed: {}", s.getFileName(), e.getClass().getSimpleName());
        }
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------------

    private static void add(List<Map<String, Object>> checks, String code, String status, String message) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("code", code);
        c.put("status", status);
        c.put("message", message);
        checks.add(c);
    }

    private static String reason(ReasonInput in, String ask) {
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation(ask);
        }
        return reason;
    }

    private String newId() {
        byte[] r = new byte[4];
        random.nextBytes(r);
        return STAMP.format(clock.instant()) + "-" + HexFormat.of().formatHex(r);
    }

    private List<String> sessionIds() {
        List<String> ids = new ArrayList<>();
        if (!Files.isDirectory(root)) {
            return ids;
        }
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(root)) {
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

    private Path session(String id) {
        if (id == null || !SESSION.matcher(id).matches()) {
            throw ApiException.notFound();
        }
        Path s = root.resolve(id);
        if (!Files.isDirectory(s, LinkOption.NOFOLLOW_LINKS)) {
            throw ApiException.notFound();
        }
        return s;
    }

    private String stateOf(Path s) {
        Map<String, Object> st = readJson(s.resolve("state.json"));
        return st == null ? null : (String) st.get("state");
    }

    /** Between the decision and the worker taking it up: APPROVED / RESTORE_REQUESTED, so the page keeps following. */
    private String shownState(Path s) {
        String state = stateOf(s);
        if ("CHECKED".equals(state) && Files.exists(s.resolve("approval.properties"))) {
            return "APPROVED";
        }
        if (("APPLIED".equals(state) || "APPLIED_INACTIVE".equals(state)) && Files.exists(s.resolve("rollback.properties"))) {
            return "RESTORE_REQUESTED";
        }
        return state == null ? "RECEIVED" : state;
    }

    private void setState(Path s, String state, String message) {
        try {
            Map<String, Object> st = new LinkedHashMap<>();
            st.put("state", state);
            st.put("message", message);
            st.put("at", clock.instant().toString());
            Path tmp = s.resolve("state.json.tmp");
            Files.writeString(tmp, json.write(st), StandardCharsets.UTF_8);
            Files.move(tmp, s.resolve("state.json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            progress(s, message);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private void progress(Path s, String text) {
        try {
            Files.writeString(s.resolve("progress.log"), clock.instant() + "\t" + text.replace('\n', ' ') + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.warn("progress of {} not written", s.getFileName());
        }
    }

    private static List<Map<String, String>> progressLines(Path s) {
        List<Map<String, String>> out = new ArrayList<>();
        try {
            if (Files.exists(s.resolve("progress.log"))) {
                List<String> all = Files.readAllLines(s.resolve("progress.log"), StandardCharsets.UTF_8);
                for (String l : all.subList(Math.max(0, all.size() - 100), all.size())) {
                    int t = l.indexOf('\t');
                    out.add(Map.of("at", t > 0 ? l.substring(0, t) : "", "text", t > 0 ? l.substring(t + 1) : l));
                }
            }
        } catch (IOException e) {
            return out;
        }
        return out;
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

    /** A file only its owner can read (where the file system has POSIX permissions: the staging volume on Linux). */
    private static void writeOwnerOnly(Path p, String text) throws IOException {
        Files.deleteIfExists(p);
        try {
            Files.createFile(p, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } catch (UnsupportedOperationException e) {
            Files.createFile(p);
        }
        Files.writeString(p, text, StandardCharsets.US_ASCII, StandardOpenOption.TRUNCATE_EXISTING);
    }
}
