package ae.mover.security;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.assistant.AssistantTester;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.ErrorCode;
import ae.mover.common.Json;

/**
 * «استيراد ملف إعدادات» (ADR-105): an administrator chooses the configuration file ({@code .env}) of a compatible application —
 * this one's own, or another that describes the enterprise directory, Keycloak and the assistant with the usual LDAP_ /
 * KEYCLOAK_ / AI_ names — and TMRKZ recognises the supported settings, maps each to its section of «إعدادات التكامل», shows what
 * is new, the same, or in conflict with what is in force, what is still missing, and which values it will never take.
 *
 * <p>Nothing is applied from the preview. The administrator picks the values; each section changed is tested live first
 * (directory: protected connection; Keycloak: discovery; assistant: the model server) and is saved only when that same
 * selection passed, through the section's own audited save. The file is never stored and {@code .env} is never written: database
 * credentials, signing and encryption keys, the authorisation store, the local identity provider and every other machine
 * setting are listed as "never imported" by name only. Secret values never leave the server: the screen sees only whether a
 * value is there and whether it equals the one in force.
 */
@Service
public class IntegrationImportService {

    private static final int MAX_TEXT = 256 * 1024;
    private static final Pattern KEY = Pattern.compile("^[A-Za-z_][A-Za-z0-9_.]{0,127}$");
    /** Values never imported, whatever the file says (named only): credentials, keys and stores of this installation. */
    private static final Pattern PROTECTED = Pattern.compile("^(DATABASE_URL|DB_.*|.*_DB_.*|.*_DB|POSTGRES.*|PG(HOST|USER|PASSWORD|DATABASE|PORT)"
            + "|SPRING_DATASOURCE_.*|SQLALCHEMY_.*|SECRET_KEY|.*SIGNING.*|.*PRIVATE_KEY.*|JWT.*|.*_SETTINGS_KEY|.*ENCRYPTION.*|.*OPENFGA.*"
            + "|KC_.*|.*KEYCLOAK_ADMIN.*|.*KEYCLOAK_DB.*|TMRKZ_KEYCLOAK_.*|TMRKZ_PLATFORM_.*|.*SESSION_SECRET.*|.*_TOKEN|.*CSRF.*"
            + "|TMRKZ_OIDC_CLIENT_SECRET|.*RELEASE.*KEY.*)$");

    public record ImportInput(String fileName, String text) {

        @Override
        public String toString() {
            return "ImportInput[" + fileName + "]"; // never the content
        }
    }

    public record Selection(List<String> fields, String reason) {
    }

    /** How a file setting becomes a section value; {@code otherApp} marks a value registered for another application. */
    private record Spec(String section, String field, String label, boolean secret, List<String> keys, boolean required) {
    }

    private record Value0(String value, String key, boolean otherApp) {
    }

    private record Pending(UUID actor, String fileName, Map<String, Value0> values, List<String> protectedKeys, List<String> ignoredKeys,
                           Map<String, String> tested, Instant until) {
    }

    private static final List<Spec> SPECS = List.of(
            new Spec("DIRECTORY", "enabled", "مفعّل", false, List.of("LDAP_ENABLED"), false),
            new Spec("DIRECTORY", "server", "خادم الدليل", false, List.of("LDAP_SERVER", "LDAP_URL"), true),
            new Spec("DIRECTORY", "port", "المنفذ", false, List.of("LDAP_PORT", "LDAP_URL"), false),
            new Spec("DIRECTORY", "securityMode", "التأمين", false, List.of("LDAP_SECURITY_MODE", "LDAP_URL"), true),
            new Spec("DIRECTORY", "domain", "نطاق الدخول", false, List.of("LDAP_DOMAIN"), false),
            new Spec("DIRECTORY", "baseDn", "قاعدة البحث", false, List.of("LDAP_BASE_DN", "LDAP_USERS_DN"), true),
            new Spec("DIRECTORY", "bindDn", "حساب الخدمة", false, List.of("LDAP_BIND_DN"), false),
            new Spec("DIRECTORY", "bindPassword", "كلمة مرور حساب الخدمة", true, List.of("LDAP_BIND_PASSWORD", "LDAP_BIND_CREDENTIAL"), false),
            new Spec("DIRECTORY", "usernameAttribute", "سمة اسم الدخول", false, List.of("LDAP_USERNAME_ATTRIBUTE"), false),
            new Spec("DIRECTORY", "uuidAttribute", "سمة المعرّف الثابت", false, List.of("LDAP_UUID_ATTRIBUTE"), false),
            new Spec("DIRECTORY", "employeeNumberAttribute", "سمة الرقم الوظيفي", false,
                    List.of("LDAP_EMPLOYEE_NUMBER_ATTRIBUTE", "LDAP_MILITARY_NUMBER_ATTRIBUTE"), false),
            new Spec("DIRECTORY", "userObjectClass", "صنف المستخدم", false, List.of("LDAP_USER_OBJECT_CLASS", "LDAP_USER_OBJECT_CLASSES"), false),
            new Spec("DIRECTORY", "rankAttribute", "سمة الرتبة", false, List.of("LDAP_ATTR_RANK"), false),
            new Spec("DIRECTORY", "positionAttribute", "سمة المنصب", false, List.of("LDAP_ATTR_POSITION"), false),
            new Spec("DIRECTORY", "unitIdAttribute", "سمة معرّف الوحدة", false, List.of("LDAP_ATTR_UNIT_ID"), false),
            new Spec("DIRECTORY", "unitNameAttribute", "سمة اسم الوحدة", false, List.of("LDAP_ATTR_UNIT_NAME"), false),
            new Spec("DIRECTORY", "mainUnitIdAttribute", "سمة الوحدة الرئيسية", false, List.of("LDAP_ATTR_MAIN_UNIT_ID"), false),
            new Spec("DIRECTORY", "timeoutSeconds", "المهلة (ثوانٍ)", false, List.of("LDAP_TIMEOUT", "LDAP_CONNECT_TIMEOUT"), false),
            new Spec("DIRECTORY", "caCertificatesPem", "شهادة الجهة المصدرة", false, List.of("LDAP_CA_CERT_PATH", "LDAP_CA_FILE"), false),
            new Spec("OIDC", "enabled", "مفعّل", false, List.of("KEYCLOAK_ENABLED", "TMRKZ_ENTERPRISE_OIDC_ENABLED"), false),
            new Spec("OIDC", "serverUrl", "عنوان خادم Keycloak", false, List.of("KEYCLOAK_SERVER_URL", "TMRKZ_ENTERPRISE_OIDC_ISSUER", "KEYCLOAK_ISSUER"), true),
            new Spec("OIDC", "realm", "المجال (Realm)", false, List.of("KEYCLOAK_REALM", "TMRKZ_ENTERPRISE_OIDC_ISSUER", "KEYCLOAK_ISSUER"), true),
            new Spec("OIDC", "clientId", "معرّف العميل", false, List.of("TMRKZ_ENTERPRISE_OIDC_CLIENT_ID", "KEYCLOAK_CLIENT_ID"), true),
            new Spec("OIDC", "clientSecret", "سر العميل", true, List.of("TMRKZ_ENTERPRISE_OIDC_CLIENT_SECRET", "KEYCLOAK_CLIENT_SECRET"), true),
            new Spec("OIDC", "internalUrl", "العنوان الداخلي", false, List.of("TMRKZ_ENTERPRISE_OIDC_INTERNAL_URL", "KEYCLOAK_INTERNAL_URL"), false),
            new Spec("OIDC", "issuer", "المُصدِر (Issuer)", false, List.of("TMRKZ_ENTERPRISE_OIDC_ISSUER", "KEYCLOAK_ISSUER"), false),
            new Spec("OIDC", "caCertificatesPem", "شهادة الجهة المصدرة", false, List.of("KEYCLOAK_CA_FILE", "TMRKZ_ENTERPRISE_OIDC_CA_FILE"), false),
            new Spec("ASSISTANT", "enabled", "مفعّل", false, List.of("TMRKZ_AI_ENABLED", "AI_ASSISTANT_ENABLED"), false),
            new Spec("ASSISTANT", "baseUrl", "عنوان خادم النموذج", false, List.of("TMRKZ_AI_BASE_URL", "AI_BASE_URL", "OLLAMA_BASE_URL"), true),
            new Spec("ASSISTANT", "model", "النموذج", false, List.of("TMRKZ_AI_MODEL", "AI_MODEL"), true),
            new Spec("ASSISTANT", "apiKey", "مفتاح الخدمة", true, List.of("TMRKZ_AI_API_KEY", "AI_API_KEY"), false),
            new Spec("ASSISTANT", "timeoutSeconds", "المهلة (ثوانٍ)", false, List.of("TMRKZ_AI_TIMEOUT_SECONDS"), false));

    /** File settings recognised as belonging to this application's own address, never another's: listed as not applicable. */
    private static final Set<String> NOT_APPLICABLE = Set.of("KEYCLOAK_REDIRECT_URI", "TMRKZ_OIDC_REDIRECT_URI", "TMRKZ_PUBLIC_URL",
            "LDAP_SECURITY", "LDAP_ALLOW_INSECURE", "LDAP_ALLOW_PLAINTEXT_BIND", "LDAP_TLS_VALIDATE", "LDAP_REQUIRE_TLS", "LDAP_ALLOW_IP_SAN");
    private static final Map<String, String> SECTION_LABEL = Map.of("DIRECTORY", "الدليل المؤسسي (LDAP)", "OIDC", "Keycloak المؤسسة (الدخول الآلي)",
            "ASSISTANT", "المساعد الذكي");

    private final IntegrationSettingsService settings;
    private final DirectoryAuthenticator directory;
    private final OidcClient oidc;
    private final AssistantTester assistantTester;
    private final AuditService audit;
    private final Json json;
    private final Clock clock;
    private final Path inventory;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();

    public IntegrationImportService(IntegrationSettingsService settings, DirectoryAuthenticator directory, OidcClient oidc,
                                    AssistantTester assistantTester, AuditService audit, Json json, Clock clock,
                                    @Value("${tmrkz.update.dir:/update}") String updateDir) {
        this.settings = settings;
        this.directory = directory;
        this.oidc = oidc;
        this.assistantTester = assistantTester;
        this.audit = audit;
        this.json = json;
        this.clock = clock;
        this.inventory = Path.of(updateDir).resolve("certificate-inventory.json");
    }

    // ---- reading a file -------------------------------------------------------------------------------------------

    /** KEY=VALUE lines as a dotenv file has them: comments, {@code export}, single and double quotes, inline comments. */
    static Map<String, String> parse(String text, List<String> problems) {
        Map<String, String> out = new LinkedHashMap<>();
        String t = text.startsWith("﻿") ? text.substring(1) : text;
        String[] lines = t.split("\\r?\\n", -1);
        for (int i = 0; i < lines.length; i++) {
            String l = lines[i].strip();
            if (l.isEmpty() || l.startsWith("#")) {
                continue;
            }
            if (l.startsWith("export ")) {
                l = l.substring(7).strip();
            }
            int eq = l.indexOf('=');
            if (eq <= 0) {
                problems.add("السطر " + (i + 1) + " ليس KEY=VALUE.");
                continue;
            }
            String key = l.substring(0, eq).strip();
            if (!KEY.matcher(key).matches()) {
                problems.add("السطر " + (i + 1) + ": اسم غير صالح.");
                continue;
            }
            String raw = l.substring(eq + 1).strip();
            String value;
            if (raw.startsWith("\"")) {
                StringBuilder b = new StringBuilder();
                int j = 1;
                boolean closed = false;
                for (; j < raw.length(); j++) {
                    char c = raw.charAt(j);
                    if (c == '\\' && j + 1 < raw.length()) {
                        char n = raw.charAt(++j);
                        b.append(switch (n) {
                            case 'n' -> '\n';
                            case 't' -> '\t';
                            default -> n;
                        });
                    } else if (c == '"') {
                        closed = true;
                        break;
                    } else {
                        b.append(c);
                    }
                }
                if (!closed) {
                    problems.add("السطر " + (i + 1) + ": علامة اقتباس غير مغلقة.");
                }
                value = b.toString();
            } else if (raw.startsWith("'")) {
                int end = raw.indexOf('\'', 1);
                value = end > 0 ? raw.substring(1, end) : raw.substring(1);
            } else {
                int hash = raw.indexOf(" #");
                value = (hash >= 0 ? raw.substring(0, hash) : raw).strip();
            }
            if (out.containsKey(key)) {
                problems.add(key + " مكرر في الملف؛ أُخذ آخره.");
            }
            out.put(key, value);
        }
        return out;
    }

    // ---- preview ----------------------------------------------------------------------------------------------------

    public Map<String, Object> preview(AccessContext ctx, ImportInput in) {
        ctx.require(Permission.CONFIGURE);
        if (in == null || in.text() == null || in.text().isBlank()) {
            throw ApiException.validation("اختر ملف الإعدادات (.env).");
        }
        if (in.text().length() > MAX_TEXT) {
            throw ApiException.validation("الملف أكبر من 256 KB؛ ليس ملف إعدادات.");
        }
        List<String> problems = new ArrayList<>();
        Map<String, String> file = parse(in.text(), problems);
        if (file.isEmpty()) {
            throw ApiException.validation("لا إعدادات KEY=VALUE في الملف.");
        }
        Map<String, Value0> values = new LinkedHashMap<>();
        Set<String> used = new LinkedHashSet<>();
        for (Spec s : SPECS) {
            Value0 v = derive(s, file);
            if (v != null && v.value() != null && !v.value().isBlank()) {
                values.put(s.section() + "." + s.field(), v);
                used.add(v.key());
            }
        }
        // the address and security settings a URL also carries
        for (String k : List.of("LDAP_URL", "LDAP_START_TLS")) {
            if (file.containsKey(k) && values.keySet().stream().anyMatch(f -> f.startsWith("DIRECTORY."))) {
                used.add(k);
            }
        }
        List<String> protectedKeys = new ArrayList<>();
        List<String> ignoredKeys = new ArrayList<>();
        List<String> notApplicable = new ArrayList<>();
        for (String k : file.keySet()) {
            if (used.contains(k)) {
                continue;
            }
            if (PROTECTED.matcher(k).matches()) {
                protectedKeys.add(k);
            } else if (NOT_APPLICABLE.contains(k)) {
                notApplicable.add(k);
            } else if (SPECS.stream().noneMatch(s -> s.keys().contains(k))) {
                ignoredKeys.add(k);
            }
        }
        boolean own = file.keySet().stream().anyMatch(k -> k.startsWith("TMRKZ_"));
        String id = newId();
        pending.values().removeIf(p -> p.until().isBefore(clock.instant()));
        if (pending.size() > 50) {
            pending.clear();
        }
        pending.put(id, new Pending(ctx.personId(), safeName(in.fileName()), values, protectedKeys, ignoredKeys, new ConcurrentHashMap<>(),
                clock.instant().plusSeconds(1800)));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("importId", id);
        out.put("fileName", safeName(in.fileName()));
        out.put("format", own ? "TMRKZ" : values.isEmpty() ? "UNKNOWN" : "COMPATIBLE");
        out.put("settingsInFile", file.size());
        out.put("recognised", values.size());
        out.put("problems", problems);
        out.put("sections", sections(values, problems));
        out.put("protectedKeys", protectedKeys);
        out.put("notApplicableKeys", notApplicable);
        out.put("ignoredKeys", ignoredKeys);
        out.put("expiresAt", clock.instant().plusSeconds(1800).toString());
        audit.recordAs(ctx.actor(), "INTEGRATION_ENV_PREVIEWED", "SETTINGS", "integration/import", safeName(in.fileName()),
                Map.of("recognised", values.keySet().stream().toList(), "protected", protectedKeys.size(), "ignored", ignoredKeys.size()), null);
        return out;
    }

    /** One value of the file for a section field, from the first of its keys the file has (a URL or an issuer is taken apart). */
    private static Value0 derive(Spec s, Map<String, String> f) {
        for (String k : s.keys()) {
            String v = f.get(k);
            if (v == null || v.isBlank()) {
                continue;
            }
            boolean other = k.startsWith("KEYCLOAK_CLIENT_");
            String out = switch (s.section() + "." + s.field()) {
                case "DIRECTORY.server" -> k.equals("LDAP_URL") ? host(v) : stripScheme(v);
                case "DIRECTORY.port" -> k.equals("LDAP_URL") ? port(v) : digits(v);
                case "DIRECTORY.securityMode" -> k.equals("LDAP_URL") ? (v.toLowerCase(Locale.ROOT).startsWith("ldaps://") ? "ldaps"
                        : "false".equalsIgnoreCase(f.getOrDefault("LDAP_START_TLS", "true")) ? "none" : "starttls") : mode(v);
                case "DIRECTORY.userObjectClass" -> last(v);
                case "DIRECTORY.timeoutSeconds" -> seconds(v);
                case "DIRECTORY.enabled", "OIDC.enabled", "ASSISTANT.enabled" -> bool(v);
                case "OIDC.serverUrl" -> k.endsWith("ISSUER") ? before(v, "/realms/") : trimSlash(v);
                case "OIDC.realm" -> k.endsWith("ISSUER") ? after(v, "/realms/") : v.trim();
                case "OIDC.internalUrl" -> before(v, "/realms/");
                case "ASSISTANT.timeoutSeconds" -> digits(v);
                default -> v.trim();
            };
            if (out != null && !out.isBlank()) {
                return new Value0(out, k, other);
            }
        }
        return null;
    }

    private static String stripScheme(String v) {
        String s = v.trim().replaceFirst("(?i)^ldaps?://", "");
        int c = s.indexOf(':');
        s = c > 0 ? s.substring(0, c) : s;
        int sl = s.indexOf('/');
        return sl > 0 ? s.substring(0, sl) : s;
    }

    private static String host(String url) {
        try {
            return URI.create(url.trim()).getHost();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String port(String url) {
        try {
            int p = URI.create(url.trim()).getPort();
            return p > 0 ? String.valueOf(p) : url.trim().toLowerCase(Locale.ROOT).startsWith("ldaps://") ? "636" : "389";
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String digits(String v) {
        String d = v.trim();
        return d.matches("\\d{1,6}") ? d : null;
    }

    private static String seconds(String v) {
        String d = digits(v.replaceAll("\\.\\d+$", ""));
        if (d == null) {
            return null;
        }
        long n = Long.parseLong(d);
        return String.valueOf(n > 1000 ? Math.max(1, n / 1000) : n);
    }

    private static String mode(String v) {
        String m = v.trim().toLowerCase(Locale.ROOT);
        return switch (m) {
            case "ldaps", "ssl" -> "ldaps";
            case "starttls", "start_tls", "tls" -> "starttls";
            default -> "none";
        };
    }

    private static String bool(String v) {
        String b = v.trim().toLowerCase(Locale.ROOT);
        return Set.of("1", "true", "yes", "on").contains(b) ? "true" : Set.of("0", "false", "no", "off").contains(b) ? "false" : null;
    }

    private static String last(String v) {
        String[] parts = v.split(",");
        return parts[parts.length - 1].trim();
    }

    private static String trimSlash(String v) {
        String s = v.trim();
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    private static String before(String v, String mark) {
        String s = trimSlash(v);
        int i = s.indexOf(mark);
        return i > 0 ? s.substring(0, i) : s;
    }

    private static String after(String v, String mark) {
        String s = trimSlash(v);
        int i = s.indexOf(mark);
        if (i < 0) {
            return null;
        }
        String r = s.substring(i + mark.length());
        int sl = r.indexOf('/');
        return sl > 0 ? r.substring(0, sl) : r;
    }

    /** The sections with each recognised value against the one in force: NEW, SAME, CONFLICT; what is still missing. */
    private List<Map<String, Object>> sections(Map<String, Value0> values, List<String> problems) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String section : List.of("DIRECTORY", "OIDC", "ASSISTANT")) {
            Map<String, Object> current = current(section);
            Map<String, String> secrets = currentSecrets(section);
            List<Map<String, Object>> fields = new ArrayList<>();
            boolean any = false;
            for (Spec s : SPECS) {
                if (!s.section().equals(section)) {
                    continue;
                }
                String path = section + "." + s.field();
                Value0 v = values.get(path);
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("path", path);
                f.put("field", s.field());
                f.put("label", s.label());
                f.put("secret", s.secret());
                f.put("required", s.required());
                Object cur = current == null ? null : current.get(s.field());
                String curText = cur == null ? null : String.valueOf(cur);
                String warning = null;
                boolean selectable = true;
                String status;
                if (s.field().equals("caCertificatesPem")) {
                    curText = curText == null || curText.isBlank() ? null : CertificateInspector.certificates(curText).size() + " شهادة";
                    f.put("current", curText);
                    if (v == null) {
                        status = "ABSENT";
                    } else {
                        Map<String, Object> ref = certificateRef(v.value());
                        f.put("imported", v.value());
                        f.put("certificate", ref);
                        if (ref == null) {
                            status = "MISSING_FILE";
                            selectable = false;
                            warning = "الملف " + v.value() + " غير موجود في مجلدات الشهادات على هذا الخادم؛ ضعه في certs/ ثم أعد المعاينة، أو استورده من «الشهادات».";
                        } else {
                            status = curText == null ? "NEW" : "CONFLICT";
                        }
                    }
                } else if (s.secret()) {
                    String have = secrets.get(s.field());
                    f.put("current", have == null ? null : "••••");
                    f.put("imported", v == null ? null : "••••");
                    status = v == null ? "ABSENT" : have == null ? "NEW" : have.equals(v.value()) ? "SAME" : "CONFLICT";
                } else {
                    f.put("current", curText);
                    f.put("imported", v == null ? null : v.value());
                    status = v == null ? "ABSENT" : curText == null || curText.isBlank() ? "NEW" : Objects.equals(curText, v.value()) ? "SAME" : "CONFLICT";
                }
                if (v != null) {
                    any = true;
                    f.put("sourceKey", v.key());
                    if (v.otherApp()) {
                        warning = "عميل مسجل في Keycloak للتطبيق الآخر؛ يحتاج تمركز عميلاً خاصاً به يسجله فريق Keycloak. لا يُختار تلقائياً.";
                    }
                    if ("DIRECTORY.securityMode".equals(path) && "none".equals(v.value())) {
                        warning = "الملف يصف اتصالاً بلا تأمين؛ تمركز لا يتصل بالدليل إلا بـ LDAPS أو StartTLS. اختر التأمين يدوياً.";
                        selectable = false;
                    }
                }
                f.put("status", status);
                f.put("warning", warning);
                f.put("selectable", selectable && v != null && !"SAME".equals(status));
                f.put("selectedByDefault", selectable && v != null && "NEW".equals(status) && (v == null || !v.otherApp()));
                fields.add(f);
            }
            Map<String, Object> sec = new LinkedHashMap<>();
            sec.put("section", section);
            sec.put("label", SECTION_LABEL.get(section));
            sec.put("source", current == null ? "NONE" : Boolean.TRUE.equals(current.get("_saved")) ? "SAVED" : "ENV");
            sec.put("inFile", any);
            sec.put("fields", fields);
            List<String> missing = new ArrayList<>();
            if (any) {
                // what the section would still lack with the values in force and the values chosen by default
                for (Map<String, Object> f : fields) {
                    boolean has = f.get("current") != null || Boolean.TRUE.equals(f.get("selectedByDefault"));
                    if (Boolean.TRUE.equals(f.get("required")) && !has) {
                        missing.add((String) f.get("label"));
                    }
                }
                // a section the file cannot complete is not chosen by default: the administrator decides, seeing what it lacks
                if (!missing.isEmpty()) {
                    fields.forEach(f -> f.put("selectedByDefault", false));
                }
            }
            sec.put("missing", missing);
            out.add(sec);
        }
        return out;
    }

    /** The section as it is in force: the saved form, else the environment's; null when neither describes it. */
    private Map<String, Object> current(String section) {
        Object form = switch (section) {
            case "DIRECTORY" -> settings.savedDirectoryForm() != null ? settings.savedDirectoryForm() : settings.envDirectoryForm();
            case "OIDC" -> settings.savedOidcForm() != null ? settings.savedOidcForm() : settings.envOidcForm();
            default -> settings.savedAssistantForm() != null ? settings.savedAssistantForm() : settings.envAssistantForm();
        };
        if (form == null) {
            return null;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> m = new LinkedHashMap<>(json.read(json.write(form), LinkedHashMap.class));
        m.values().removeIf(Objects::isNull);
        m.put("_saved", switch (section) {
            case "DIRECTORY" -> settings.savedDirectoryForm() != null;
            case "OIDC" -> settings.savedOidcForm() != null;
            default -> settings.savedAssistantForm() != null;
        });
        return m;
    }

    private Map<String, String> currentSecrets(String section) {
        Map<String, String> m = new LinkedHashMap<>();
        switch (section) {
            case "DIRECTORY" -> {
                String s = settings.savedDirectoryForm() != null ? settings.storedDirectoryPassword() : settings.envDirectoryPassword();
                if (s != null) {
                    m.put("bindPassword", s);
                }
            }
            case "OIDC" -> {
                String s = settings.savedOidcForm() != null ? settings.storedClientSecret() : settings.envClientSecret();
                if (s != null) {
                    m.put("clientSecret", s);
                }
            }
            default -> {
                String s = settings.savedAssistantForm() != null ? settings.storedAssistantKey() : settings.envAssistantKey();
                if (s != null && !s.isBlank()) {
                    m.put("apiKey", s);
                }
            }
        }
        return m;
    }

    /** A CA file the configuration names, found by its file name in the certificate folders the worker lists; null if absent. */
    @SuppressWarnings("unchecked")
    private Map<String, Object> certificateRef(String path) {
        String name = path.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1);
        if (name.isBlank()) {
            return null;
        }
        try {
            if (!Files.exists(inventory)) {
                return null;
            }
            Map<String, Object> inv = json.map(Files.readString(inventory, StandardCharsets.UTF_8));
            for (Object o : (List<?>) inv.getOrDefault("stores", List.of())) {
                Map<String, Object> st = (Map<String, Object>) o;
                for (Object fo : (List<?>) st.getOrDefault("files", List.of())) {
                    Map<String, Object> f = (Map<String, Object>) fo;
                    if (name.equals(f.get("name")) && f.get("pem") instanceof String pem && !pem.isBlank()) {
                        List<java.security.cert.X509Certificate> certs = CertificateInspector.certificates(pem);
                        Map<String, Object> r = new LinkedHashMap<>();
                        r.put("store", st.get("id"));
                        r.put("folder", st.get("path"));
                        r.put("file", name);
                        r.put("certificates", certs.stream().map(c -> CertificateInspector.describe(c, clock.instant())).toList());
                        r.put("pem", pem);
                        return r;
                    }
                }
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    // ---- test and apply ------------------------------------------------------------------------------------------------

    /** Tests every section the selection changes, with the values it would save; nothing is saved. */
    public Map<String, Object> test(AccessContext ctx, String id, Selection in) {
        ctx.require(Permission.CONFIGURE);
        Pending p = pending(ctx, id);
        Map<String, List<String>> bySection = selection(p, in);
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> e : bySection.entrySet()) {
            Map<String, Object> r = new LinkedHashMap<>();
            try {
                Object candidate = candidate(e.getKey(), p, e.getValue());
                Map<String, Object> t = run(e.getKey(), candidate);
                r.putAll(t);
                if (Boolean.TRUE.equals(t.get("ok"))) {
                    p.tested().put(e.getKey(), hash(e.getKey(), e.getValue(), p));
                } else {
                    p.tested().remove(e.getKey());
                }
            } catch (ApiException x) {
                r.put("ok", false);
                r.put("message", x.getMessage());
                p.tested().remove(e.getKey());
            }
            out.put(e.getKey(), r);
        }
        audit.recordAs(ctx.actor(), "INTEGRATION_ENV_TESTED", "SETTINGS", "integration/import", p.fileName(),
                Map.of("sections", bySection.keySet().stream().toList(), "ok", out.values().stream().allMatch(v -> Boolean.TRUE.equals(((Map<?, ?>) v).get("ok")))),
                null);
        return Map.of("results", out);
    }

    /** Saves each changed section through its own audited save, only when that same selection passed its test. */
    public Map<String, Object> apply(AccessContext ctx, String id, Selection in) {
        ctx.require(Permission.CONFIGURE);
        String reason = in == null || in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 3) {
            throw ApiException.validation("اذكر سبب استيراد الإعدادات.");
        }
        Pending p = pending(ctx, id);
        Map<String, List<String>> bySection = selection(p, in);
        for (Map.Entry<String, List<String>> e : bySection.entrySet()) {
            if (!hash(e.getKey(), e.getValue(), p).equals(p.tested().get(e.getKey()))) {
                throw new ApiException(ErrorCode.STALE_REVISION, "اختبر قسم «" + SECTION_LABEL.get(e.getKey()) + "» بهذا الاختيار نفسه قبل التطبيق؛ لم يُحفظ شيء.");
            }
        }
        List<String> saved = new ArrayList<>();
        for (Map.Entry<String, List<String>> e : bySection.entrySet()) {
            Object candidate = candidate(e.getKey(), p, e.getValue());
            switch (e.getKey()) {
                case "DIRECTORY" -> settings.saveDirectory(ctx, (IntegrationSettingsService.Directory) candidate);
                case "OIDC" -> settings.saveOidc(ctx, (IntegrationSettingsService.Oidc) candidate);
                default -> settings.saveAssistant(ctx, (IntegrationSettingsService.Assistant) candidate);
            }
            saved.add(e.getKey());
        }
        List<String> taken = bySection.values().stream().flatMap(List::stream).toList();
        List<String> keys = taken.stream().map(f -> p.values().get(f).key()).distinct().toList();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("file", p.fileName());
        detail.put("sections", saved);
        detail.put("fields", taken);
        detail.put("fileKeys", keys);
        detail.put("notTaken", p.values().keySet().stream().filter(f -> !taken.contains(f)).toList());
        detail.put("neverImported", p.protectedKeys());
        audit.recordAs(ctx.actor(), "INTEGRATION_ENV_IMPORTED", "SETTINGS", "integration/import", p.fileName(), detail, reason);
        pending.remove(id);
        return Map.of("saved", saved, "fields", taken);
    }

    public void discard(AccessContext ctx, String id) {
        ctx.require(Permission.CONFIGURE);
        Pending p = pending.get(id);
        if (p != null && p.actor().equals(ctx.personId())) {
            pending.remove(id);
        }
    }

    private Pending pending(AccessContext ctx, String id) {
        Pending p = id == null ? null : pending.get(id);
        if (p == null || !p.actor().equals(ctx.personId()) || p.until().isBefore(clock.instant())) {
            throw new ApiException(ErrorCode.STALE_REVISION, "انتهت المعاينة أو ليست لك؛ اختر الملف من جديد.");
        }
        return p;
    }

    /** The chosen fields by section; each must be a recognised, selectable value of this file. */
    private Map<String, List<String>> selection(Pending p, Selection in) {
        List<String> fields = in == null || in.fields() == null ? List.of() : in.fields().stream().distinct().toList();
        if (fields.isEmpty()) {
            throw ApiException.validation("اختر الإعدادات التي تُستورد.");
        }
        Map<String, List<String>> out = new LinkedHashMap<>();
        for (String f : fields) {
            Value0 v = p.values().get(f);
            if (v == null) {
                throw ApiException.validation("ليست من إعدادات هذا الملف: " + f);
            }
            if (f.endsWith(".caCertificatesPem") && certificateRef(v.value()) == null) {
                throw ApiException.validation("ملف الشهادة غير موجود على الخادم: " + v.value());
            }
            if (f.equals("DIRECTORY.securityMode") && "none".equals(v.value())) {
                throw ApiException.validation("لا يُستورد اتصال بالدليل بلا تأمين.");
            }
            out.computeIfAbsent(f.substring(0, f.indexOf('.')), k -> new ArrayList<>()).add(f);
        }
        out.values().forEach(l -> l.sort(null));
        return out;
    }

    /** The section's form in force with the chosen values of the file over it. */
    private Object candidate(String section, Pending p, List<String> fields) {
        Function<String, String> val = f -> fields.contains(section + "." + f) ? p.values().get(section + "." + f).value() : null;
        switch (section) {
            case "DIRECTORY" -> {
                IntegrationSettingsService.Directory b = settings.savedDirectoryForm() != null ? settings.savedDirectoryForm() : settings.envDirectoryForm();
                String envPassword = settings.savedDirectoryForm() == null ? settings.envDirectoryPassword() : null;
                IntegrationSettingsService.Directory base = b != null ? b : new IntegrationSettingsService.Directory(true, null, null, "ldaps", null, null,
                        null, null, null, null, null, null, null, null, null, null, null, null, null);
                String ca = val.apply("caCertificatesPem") != null ? pem(val.apply("caCertificatesPem")) : base.caCertificatesPem();
                return new IntegrationSettingsService.Directory(boolOr(val.apply("enabled"), base.enabled()), or(val.apply("server"), base.server()),
                        intOr(val.apply("port"), base.port()), or(val.apply("securityMode"), base.securityMode()), or(val.apply("domain"), base.domain()),
                        or(val.apply("baseDn"), base.baseDn()), or(val.apply("bindDn"), base.bindDn()), or(val.apply("bindPassword"), envPassword),
                        or(val.apply("usernameAttribute"), base.usernameAttribute()), or(val.apply("uuidAttribute"), base.uuidAttribute()),
                        or(val.apply("employeeNumberAttribute"), base.employeeNumberAttribute()), or(val.apply("userObjectClass"), base.userObjectClass()),
                        or(val.apply("rankAttribute"), base.rankAttribute()), or(val.apply("positionAttribute"), base.positionAttribute()),
                        or(val.apply("unitIdAttribute"), base.unitIdAttribute()), or(val.apply("unitNameAttribute"), base.unitNameAttribute()),
                        or(val.apply("mainUnitIdAttribute"), base.mainUnitIdAttribute()), ca, intOr(val.apply("timeoutSeconds"), base.timeoutSeconds()));
            }
            case "OIDC" -> {
                IntegrationSettingsService.Oidc b = settings.savedOidcForm() != null ? settings.savedOidcForm() : settings.envOidcForm();
                String envSecret = settings.savedOidcForm() == null ? settings.envClientSecret() : null;
                IntegrationSettingsService.Oidc base = b != null ? b : new IntegrationSettingsService.Oidc(true, null, null, null, null, null, null, null, null);
                String ca = val.apply("caCertificatesPem") != null ? pem(val.apply("caCertificatesPem")) : base.caCertificatesPem();
                return new IntegrationSettingsService.Oidc(boolOr(val.apply("enabled"), base.enabled()), or(val.apply("serverUrl"), base.serverUrl()),
                        or(val.apply("realm"), base.realm()), or(val.apply("clientId"), base.clientId()), or(val.apply("clientSecret"), envSecret),
                        or(val.apply("internalUrl"), base.internalUrl()), or(val.apply("issuer"), base.issuer()), base.redirectUri(), ca);
            }
            default -> {
                IntegrationSettingsService.Assistant b = settings.savedAssistantForm() != null ? settings.savedAssistantForm() : settings.envAssistantForm();
                String envKey = settings.savedAssistantForm() == null ? settings.envAssistantKey() : null;
                return new IntegrationSettingsService.Assistant(boolOr(val.apply("enabled"), b.enabled()), or(val.apply("baseUrl"), b.baseUrl()),
                        or(val.apply("model"), b.model()), or(val.apply("apiKey"), envKey), intOr(val.apply("timeoutSeconds"), b.timeoutSeconds()));
            }
        }
    }

    private String pem(String path) {
        Map<String, Object> ref = certificateRef(path);
        return ref == null ? null : (String) ref.get("pem");
    }

    private Map<String, Object> run(String section, Object candidate) {
        Map<String, Object> r = new LinkedHashMap<>();
        switch (section) {
            case "DIRECTORY" -> {
                IntegrationSettingsService.Directory d = (IntegrationSettingsService.Directory) candidate;
                LdapProperties p = settings.toLdap(d, settings.savedDirectoryForm() != null ? settings.storedDirectoryPassword() : null);
                DirectoryAuthenticator.TestResult t = directory.test(p, null, null);
                r.put("ok", t.ok());
                r.put("step", t.step());
                r.put("message", t.message());
                r.put("target", p.url());
            }
            case "OIDC" -> {
                IntegrationSettingsService.Oidc o = (IntegrationSettingsService.Oidc) candidate;
                OidcProperties props = settings.toOidc(o, settings.savedOidcForm() != null ? settings.storedClientSecret() : null);
                OidcClient.Probe t = oidc.probe(props.automatic(), settings.sslFor(o.caCertificatesPem()), Math.min(8000, props.httpTimeoutMs()));
                r.put("ok", t.ok());
                r.put("step", t.step());
                r.put("message", t.message());
                r.put("target", props.automatic().issuer());
            }
            default -> {
                IntegrationSettingsService.Assistant a = (IntegrationSettingsService.Assistant) candidate;
                String key = a.apiKey() != null ? a.apiKey() : settings.storedAssistantKey();
                Map<String, Object> t = assistantTester.test(new IntegrationSettingsService.Assistant(a.enabled(), a.baseUrl(), a.model(), key,
                        a.timeoutSeconds() == null ? 60 : a.timeoutSeconds()));
                r.put("ok", Boolean.TRUE.equals(t.get("ok")));
                r.put("message", t.getOrDefault("message", t.get("error")));
                r.put("target", a.baseUrl());
            }
        }
        return r;
    }

    /** What a passed test covered: the section's chosen fields and their values (secrets included, only as a hash). */
    private static String hash(String section, List<String> fields, Pending p) {
        StringBuilder b = new StringBuilder(section);
        for (String f : fields) {
            b.append('\n').append(f).append('=').append(p.values().get(f).value());
        }
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String or(String a, String b) {
        return a != null ? a : b;
    }

    private static Boolean boolOr(String a, Boolean b) {
        return a != null ? Boolean.valueOf(a) : b;
    }

    private static Integer intOr(String a, Integer b) {
        return a != null ? Integer.valueOf(a) : b;
    }

    private String newId() {
        byte[] r = new byte[12];
        random.nextBytes(r);
        return HexFormat.of().formatHex(r);
    }

    private static String safeName(String n) {
        String s = n == null ? ".env" : n.replaceAll("[^\\p{L}\\p{N}._ -]", "_");
        return s.length() > 120 ? s.substring(0, 120) : s;
    }
}
