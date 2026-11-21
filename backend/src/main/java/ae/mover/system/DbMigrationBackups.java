package ae.mover.system;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Stream;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import ae.mover.common.Json;

/**
 * The backup gate of the migration center (ADR-094): the migration commits only while a verified current backup exists.
 * {@code ops/backup.sh} writes {@code <backups>/<project>-<stamp>/manifest.json}; the folder is mounted read-only into the
 * backend. {@code ops/verify-backup.sh} writes {@code verify-result.txt} («PASS …») beside the manifest when it passes; a
 * backup without that file shows «لم يُتحقق» and the administrator confirms, on the record, that the check passed.
 */
@Component
public class DbMigrationBackups {

    private static final Logger log = LoggerFactory.getLogger(DbMigrationBackups.class);
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'");

    /** The newest backup as the gate sees it. */
    public record Status(boolean found, String dir, Instant createdAt, Integer schemaVersion, boolean verified, Instant verifiedAt,
                         boolean current, long maxAgeHours, String problem) {
        public Map<String, Object> asMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("found", found);
            m.put("dir", dir);
            m.put("createdAt", createdAt == null ? null : createdAt.toString());
            m.put("schemaVersion", schemaVersion);
            m.put("verified", verified);
            m.put("verifiedAt", verifiedAt == null ? null : verifiedAt.toString());
            m.put("current", current);
            m.put("maxAgeHours", maxAgeHours);
            m.put("problem", problem);
            return m;
        }
    }

    private final Path root;
    private final long maxAgeHours;
    private final Json json;
    private final Clock clock;

    public DbMigrationBackups(@Value("${tmrkz.migration.backups-dir:/var/lib/mover/backups}") String root,
                              @Value("${tmrkz.migration.backup-max-age-hours:24}") long maxAgeHours, Json json, Clock clock) {
        this.root = Path.of(root);
        this.maxAgeHours = maxAgeHours;
        this.json = json;
        this.clock = clock;
    }

    public Status status() {
        if (!Files.isDirectory(root)) {
            return new Status(false, null, null, null, false, null, false, maxAgeHours,
                    "مجلد النسخ الاحتياطية غير متاح للخادم (" + root + ")؛ خذ نسخة بـ sh ops/backup.sh أولاً.");
        }
        Path best = null;
        Instant bestAt = null;
        Map<String, Object> bestManifest = null;
        try (Stream<Path> dirs = Files.list(root)) {
            for (Path d : dirs.toList()) {
                Path manifest = d.resolve("manifest.json");
                if (!Files.isDirectory(d) || !Files.isRegularFile(manifest)) {
                    continue;
                }
                Map<String, Object> m;
                try {
                    m = json.map(Files.readString(manifest, StandardCharsets.UTF_8));
                } catch (RuntimeException e) {
                    log.warn("Backup manifest {} unreadable: {}", manifest, e.getMessage());
                    continue;
                }
                Instant at = stamp(m.get("createdAt"));
                if (at == null) {
                    at = Files.getLastModifiedTime(manifest).toInstant();
                }
                if (bestAt == null || at.isAfter(bestAt)) {
                    best = d;
                    bestAt = at;
                    bestManifest = m;
                }
            }
        } catch (IOException e) {
            return new Status(false, null, null, null, false, null, false, maxAgeHours, "تعذرت قراءة مجلد النسخ الاحتياطية: " + e.getMessage());
        }
        if (best == null) {
            return new Status(false, null, null, null, false, null, false, maxAgeHours,
                    "لا نسخة احتياطية في " + root + "؛ خذ نسخة بـ sh ops/backup.sh أولاً.");
        }
        Integer schema = null;
        Object sv = bestManifest.get("schemaVersion");
        if (sv != null && sv.toString().matches("\\d+")) {
            schema = Integer.valueOf(sv.toString());
        }
        boolean verified = false;
        Instant verifiedAt = null;
        Path result = best.resolve("verify-result.txt");
        if (Files.isRegularFile(result)) {
            try {
                String text = Files.readString(result, StandardCharsets.UTF_8).strip();
                verified = text.startsWith("PASS");
                verifiedAt = Files.getLastModifiedTime(result).toInstant();
            } catch (IOException e) {
                log.warn("Backup verification result {} unreadable: {}", result, e.getMessage());
            }
        }
        boolean current = Duration.between(bestAt, clock.instant()).toHours() < maxAgeHours;
        String problem = current ? null : "آخر نسخة احتياطية أقدم من " + maxAgeHours + " ساعة؛ خذ نسخة جديدة بـ sh ops/backup.sh.";
        return new Status(true, best.getFileName().toString(), bestAt, schema, verified, verifiedAt, current, maxAgeHours, problem);
    }

    static Instant stamp(Object value) {
        if (value == null) {
            return null;
        }
        String s = value.toString().trim();
        try {
            return Instant.parse(s);
        } catch (RuntimeException ignored) {
            // the backup script's compact UTC stamp
        }
        try {
            return LocalDateTime.parse(s, STAMP).toInstant(ZoneOffset.UTC);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
