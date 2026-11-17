package ae.mover.hr;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;

import ae.mover.common.ApiException;
import ae.mover.common.Json;

/** Reads the private, unit-only Duty/Oracle mirror. It never opens a person view or a remote application URL. */
@Component
public class OracleUnitPayload {

    private static final long MAX_BYTES = 32L * 1024 * 1024;
    private static final int MAX_UNITS = 100_000;
    private static final Set<String> TOP_FIELDS = Set.of("schemaVersion", "source", "sourceSyncedAt", "sourceSyncedAtUtc",
            "sourceColumnContract", "units");
    private static final Set<String> UNIT_FIELDS = Set.of("external_unit_id", "name", "sort_order", "status", "main_unit_id");
    private static final Map<String, String> REQUIRED_CONTRACT = Map.of("external_unit_id", "ID", "name", "NAME",
            "sort_order", "SORT_ORDER", "status", "STATUS", "main_unit_id", "MAIN_UNIT_ID");

    private final Path root;
    private final Json json;

    public OracleUnitPayload(@Value("${mover.storage.root}") String root, Json json) {
        this.root = Path.of(root).toAbsolutePath().normalize();
        this.json = json;
    }

    public record Unit(String externalId, String code, String name, String parentExternalId, String status, boolean active,
                       int level, boolean main, String mainExternalId) {
    }

    /** The raw file fingerprint is the evidence for preview/commit; no person data is present in this object. */
    public record Payload(String storageKey, long size, String sha256, String schemaVersion, String source, Instant syncedAt,
                          String syncedAtUtc, String sourceContract, List<Unit> units) {

        public Map<String, Object> provenance() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("storageKey", storageKey);
            out.put("size", size);
            out.put("sha256", sha256);
            out.put("schemaVersion", schemaVersion);
            out.put("source", source);
            out.put("sourceSyncedAtUtc", syncedAtUtc);
            out.put("sourceColumnContract", sourceContract);
            return out;
        }
    }

    public Payload read(String storageKey) {
        Path path = resolve(storageKey);
        long size;
        try {
            size = Files.size(path);
        } catch (IOException e) {
            throw invalid("UNIT_FILE_READ", "تعذر قراءة ملف الجهات؛ أعد تجهيز الملف الداخلي.");
        }
        if (size == 0 || size > MAX_BYTES) {
            throw invalid("UNIT_FILE_SIZE", "حجم ملف الجهات خارج الحد المسموح.");
        }
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        // the parser must not close the stream at end of input: every trailing byte is still read into the digest below
        try (InputStream in = new DigestInputStream(Files.newInputStream(path), digest);
             JsonParser p = json.mapper().getFactory().createParser(in).disable(JsonParser.Feature.AUTO_CLOSE_SOURCE)) {
            return parse(p, in, storageKey, size, digest);
        } catch (IOException e) {
            throw invalid("UNIT_FILE_READ", "تعذر قراءة ملف الجهات؛ أعد تجهيز الملف الداخلي.");
        }
    }

    private Payload parse(JsonParser p, InputStream in, String key, long size, MessageDigest digest) throws IOException {
        if (p.nextToken() != JsonToken.START_OBJECT) {
            throw invalid("UNIT_FILE_JSON", "ملف الجهات يجب أن يكون كائن JSON.");
        }
        Set<String> seen = new LinkedHashSet<>();
        String schema = null;
        String source = null;
        String syncedEpoch = null;
        String syncedUtc = null;
        String contract = null;
        List<Unit> units = null;
        while (p.nextToken() != JsonToken.END_OBJECT) {
            if (p.currentToken() != JsonToken.FIELD_NAME || !TOP_FIELDS.contains(p.currentName()) || !seen.add(p.currentName())) {
                throw invalid("UNIT_FILE_FIELDS", "يحتوي الملف حقولاً مفقودة أو مكررة أو غير معلنة.");
            }
            String field = p.currentName();
            JsonToken value = p.nextToken();
            switch (field) {
                case "schemaVersion" -> schema = scalar(p, value);
                case "source" -> source = scalar(p, value);
                case "sourceSyncedAt" -> syncedEpoch = scalar(p, value);
                case "sourceSyncedAtUtc" -> syncedUtc = scalar(p, value);
                case "sourceColumnContract" -> {
                    if (value != JsonToken.START_OBJECT) {
                        throw invalid("UNIT_FILE_CONTRACT", "عقد أعمدة الجهات غير صالح.");
                    }
                    Map<String, Object> values = json.convert(p.readValueAsTree(), Map.class);
                    Map<String, Object> expected = new LinkedHashMap<>(REQUIRED_CONTRACT);
                    values.forEach((k, v) -> {
                        if (!(v instanceof String)) {
                            throw invalid("UNIT_FILE_CONTRACT", "عقد أعمدة الجهات يحتوي قيمة غير نصية.");
                        }
                    });
                    if (!values.equals(expected)) {
                        throw invalid("UNIT_FILE_CONTRACT", "عقد ملف الجهات لا يطابق أعمدة Oracle المعتمدة.");
                    }
                    contract = json.write(values);
                }
                case "units" -> units = units(p, value);
                default -> throw invalid("UNIT_FILE_FIELDS", "حقل غير معلن في ملف الجهات.");
            }
        }
        if (!seen.equals(TOP_FIELDS) || units == null || units.isEmpty()) {
            throw invalid("UNIT_FILE_FIELDS", "ملف الجهات ناقص أو لا يحتوي جهات.");
        }
        if (!"tmrkz-oracle-unit-mirror-v1".equals(schema) || source == null || source.isBlank() || source.length() > 200
                || syncedEpoch == null || !syncedEpoch.matches("[0-9]{1,18}") || syncedUtc == null) {
            throw invalid("UNIT_FILE_METADATA", "بيانات مصدر ملف الجهات غير صالحة.");
        }
        Instant syncedAt;
        Instant stated;
        try {
            syncedAt = Instant.ofEpochSecond(Long.parseLong(syncedEpoch));
            stated = OffsetDateTime.parse(syncedUtc).toInstant();
        } catch (RuntimeException e) {
            throw invalid("UNIT_FILE_METADATA", "تاريخ مصدر ملف الجهات غير صالح.");
        }
        if (!syncedAt.equals(stated)) {
            throw invalid("UNIT_FILE_METADATA", "تاريخا مصدر ملف الجهات غير متطابقين.");
        }
        if (p.nextToken() != null) {
            throw invalid("UNIT_FILE_JSON", "محتوى زائد بعد ملف الجهات.");
        }
        in.readAllBytes(); // include every trailing byte in the digest, if the parser buffered ahead.
        String sha = HexFormat.of().formatHex(digest.digest());
        validateTree(units);
        return new Payload(key, size, sha, schema, source, syncedAt,
                java.time.format.DateTimeFormatter.ISO_INSTANT.format(stated), contract, List.copyOf(units));
    }

    private static String scalar(JsonParser p, JsonToken value) throws IOException {
        if (value == null || value.isScalarValue() && value != JsonToken.VALUE_STRING && value != JsonToken.VALUE_NUMBER_INT) {
            throw invalid("UNIT_FILE_JSON", "قيمة JSON غير متوقعة في ملف الجهات.");
        }
        if (value != JsonToken.VALUE_STRING && value != JsonToken.VALUE_NUMBER_INT) {
            throw invalid("UNIT_FILE_JSON", "قيمة JSON غير متوقعة في ملف الجهات.");
        }
        return p.getText();
    }

    private static List<Unit> units(JsonParser p, JsonToken value) throws IOException {
        if (value != JsonToken.START_ARRAY) {
            throw invalid("UNIT_FILE_ROWS", "قائمة الجهات غير صالحة.");
        }
        List<Unit> out = new java.util.ArrayList<>();
        while (p.nextToken() != JsonToken.END_ARRAY) {
            if (p.currentToken() != JsonToken.START_OBJECT) {
                throw invalid("UNIT_FILE_ROWS", "سجل الجهة ليس كائن JSON.");
            }
            Map<String, String> row = new LinkedHashMap<>();
            Set<String> fields = new LinkedHashSet<>();
            while (p.nextToken() != JsonToken.END_OBJECT) {
                if (p.currentToken() != JsonToken.FIELD_NAME || !UNIT_FIELDS.contains(p.currentName())
                        || !fields.add(p.currentName())) {
                    throw invalid("UNIT_FILE_ROW_FIELDS", "سجل جهة يتضمن حقلاً غير معلن أو مكرراً؛ حقول الأشخاص مرفوضة.");
                }
                String field = p.currentName();
                JsonToken scalar = p.nextToken();
                if (scalar == JsonToken.VALUE_NULL) {
                    row.put(field, null);
                } else if (scalar == JsonToken.VALUE_STRING) {
                    row.put(field, p.getText());
                } else {
                    throw invalid("UNIT_FILE_ROW_FIELDS", "قيم سجل الجهة يجب أن تكون نصية.");
                }
            }
            if (!fields.equals(UNIT_FIELDS)) {
                throw invalid("UNIT_FILE_ROW_FIELDS", "سجل جهة ناقص الحقول المطلوبة.");
            }
            String id = row.get("external_unit_id");
            String name = row.get("name");
            String rawPath = row.get("sort_order");
            String status = row.get("status");
            if (id == null || id.isBlank() || id.length() > 36 || name == null || name.isBlank() || name.length() > 200
                    || rawPath == null || status == null || !Set.of("1", "2", "3", "4").contains(status)) {
                throw invalid("UNIT_FILE_ROW", "معرف أو اسم أو حالة جهة غير صالحة.");
            }
            if (!rawPath.startsWith("\\") || rawPath.endsWith("\\")) {
                throw invalid("UNIT_FILE_PATH", "مسار الجهة الهرمي غير قانوني.");
            }
            String[] parts = rawPath.substring(1).split("\\\\", -1);
            for (String part : parts) {
                if (part.isBlank()) {
                    throw invalid("UNIT_FILE_PATH", "مسار الجهة يحتوي جزءاً فارغاً.");
                }
            }
            if (!id.equals(parts[parts.length - 1])) {
                throw invalid("UNIT_FILE_PATH", "مسار الجهة لا ينتهي بمعرفها.");
            }
            String main = row.get("main_unit_id");
            if (main != null && (main.isBlank() || main.length() > 36)) {
                throw invalid("UNIT_FILE_MAIN", "مرجع الجهة الرئيسية غير صالح.");
            }
            out.add(new Unit(id, "HR-" + id, name, parts.length == 1 ? null : parts[parts.length - 2], status,
                    "1".equals(status), parts.length, id.equals(main), main));
            if (out.size() > MAX_UNITS) {
                throw invalid("UNIT_FILE_SIZE", "عدد الجهات يتجاوز الحد المسموح.");
            }
        }
        return out;
    }

    private static void validateTree(List<Unit> units) {
        Map<String, Unit> byId = new LinkedHashMap<>();
        for (Unit unit : units) {
            if (byId.putIfAbsent(unit.externalId(), unit) != null) {
                throw invalid("UNIT_DUPLICATE_ID", "تكرر معرف جهة في الملف.");
            }
        }
        for (Unit unit : units) {
            if (unit.parentExternalId() != null && !byId.containsKey(unit.parentExternalId())) {
                throw invalid("UNIT_ORPHAN", "ملف الجهات يحتوي أماً غير موجودة.");
            }
            if (unit.mainExternalId() != null && !byId.containsKey(unit.mainExternalId())) {
                throw invalid("UNIT_MAIN_UNKNOWN", "مرجع الجهة الرئيسية غير موجود في الملف.");
            }
        }
        if (byId.values().stream().filter(u -> u.parentExternalId() == null).count() == 0) {
            throw invalid("UNIT_ROOT", "لا توجد جذور صالحة في ملف الجهات.");
        }
        for (Unit unit : units) {
            Set<String> path = new LinkedHashSet<>();
            String current = unit.externalId();
            while (current != null) {
                if (!path.add(current)) {
                    throw invalid("UNIT_CYCLE", "ملف الجهات يحتوي دورة هرمية.");
                }
                Unit node = byId.get(current);
                current = node == null ? null : node.parentExternalId();
            }
        }
    }

    private Path resolve(String key) {
        if (key == null || key.isBlank() || key.indexOf('\0') >= 0 || !key.startsWith("unit-import/")) {
            throw invalid("UNIT_FILE_KEY", "مسار ملف الجهات غير مصرح.");
        }
        try {
            Path realRoot = root.toRealPath();
            Path base = root.resolve("unit-import").normalize();
            Path target = base.resolve(key.substring("unit-import/".length())).normalize();
            if (!target.startsWith(base) || target.getParent() == null
                    || !Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
                throw invalid("UNIT_FILE_KEY", "ملف الجهات غير موجود أو ليس ملفاً داخلياً عادياً.");
            }
            Path realBase = base.toRealPath();
            if (!target.getParent().toRealPath().startsWith(realBase)) {
                throw invalid("UNIT_FILE_KEY", "مسار ملف الجهات خارج مجلد الاستيراد المصرح.");
            }
            Path real = target.toRealPath(LinkOption.NOFOLLOW_LINKS);
            if (!real.startsWith(realBase) || !real.startsWith(realRoot)) {
                throw invalid("UNIT_FILE_KEY", "ملف الجهات خارج المخزن الداخلي.");
            }
            return real;
        } catch (IOException e) {
            throw invalid("UNIT_FILE_KEY", "تعذر التحقق من ملف الجهات الداخلي.");
        }
    }

    private static ApiException invalid(String reason, String message) {
        return ApiException.validation(message, Map.of("reason", reason));
    }
}
