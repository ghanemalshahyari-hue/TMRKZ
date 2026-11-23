package ae.mover.system;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import ae.mover.common.ApiException;

/**
 * The second source of the migration center (ADR-094): a {@code pg_dump -Fc} file of an older TMRKZ database, uploaded or
 * placed in the inbox folder, checked (the PGDMP magic, its SHA-256), restored by {@code pg_restore} into an ISOLATED staging
 * database on the application's own server ({@code tmrkz_staging_<id>}), read through the same path as a live connection
 * and dropped when the migration finished or failed. The staging database reuses the application's datasource host and
 * credentials; the dump never touches the current database.
 */
@Component
public class DbMigrationDump {

    private static final Logger log = LoggerFactory.getLogger(DbMigrationDump.class);
    private static final Pattern FILE_NAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$");
    private static final Pattern DATASOURCE_URL = Pattern.compile("^jdbc:postgresql://([^/:?,]+)(?::(\\d+))?/([^?;]+)");
    private static final byte[] MAGIC = "PGDMP".getBytes(StandardCharsets.US_ASCII);
    static final String STAGING_PREFIX = "tmrkz_staging_";

    /** The application's own datasource as the folder or image installation configured it. */
    public record Datasource(String host, int port, String database, String username, String password) {

        @Override
        public String toString() {
            return "Datasource[" + host + ":" + port + "/" + database + "]"; // never the password
        }
    }

    /** What a file in the inbox is: its size, SHA-256 and whether it starts with the custom-format magic. */
    public record Info(String file, long size, String sha256, boolean pgdmp) {
        public Map<String, Object> asMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("file", file);
            m.put("size", size);
            m.put("sha256", sha256);
            m.put("pgdmp", pgdmp);
            return m;
        }
    }

    private final DataSource dataSource;
    private final Datasource datasource;
    private final Path inbox;
    private final long maxUploadBytes;
    private final String pgRestore;

    public DbMigrationDump(DataSource dataSource, @Value("${spring.datasource.url}") String url,
                           @Value("${spring.datasource.username:}") String username, @Value("${spring.datasource.password:}") String password,
                           @Value("${tmrkz.migration.inbox:${mover.storage.root}/migration-inbox}") String inbox,
                           @Value("${tmrkz.migration.max-upload-bytes:26214400}") long maxUploadBytes,
                           @Value("${tmrkz.migration.pg-restore:pg_restore}") String pgRestore) {
        this.dataSource = dataSource;
        this.datasource = parse(url, username, password);
        this.inbox = Path.of(inbox);
        this.maxUploadBytes = maxUploadBytes;
        this.pgRestore = pgRestore;
    }

    static Datasource parse(String url, String username, String password) {
        Matcher m = DATASOURCE_URL.matcher(url == null ? "" : url.trim());
        if (!m.find()) {
            return new Datasource("localhost", 5432, "tmrkz", username, password);
        }
        return new Datasource(m.group(1), m.group(2) == null ? 5432 : Integer.parseInt(m.group(2)), m.group(3), username,
                password == null ? "" : password);
    }

    public Datasource datasource() {
        return datasource;
    }

    public Path inbox() {
        try {
            Files.createDirectories(inbox);
        } catch (IOException e) {
            throw ApiException.validation("تعذر فتح مجلد ملفات الترحيل: " + e.getMessage());
        }
        return inbox;
    }

    public long maxUploadBytes() {
        return maxUploadBytes;
    }

    /** A name inside the inbox: no path, no hidden file; the file must exist. */
    public Path resolve(String name) {
        if (name == null || !FILE_NAME.matcher(name).matches()) {
            throw ApiException.validation("اكتب اسم ملف النسخة كما هو في مجلد الترحيل، دون مسار.");
        }
        Path p = inbox().resolve(name).normalize();
        if (!p.startsWith(inbox()) || !Files.isRegularFile(p)) {
            throw ApiException.validation("لا يوجد ملف باسم «" + name + "» في مجلد الترحيل.");
        }
        return p;
    }

    /** Saves an upload into the inbox under a checked name; a file of the same name is replaced. */
    public Info store(String originalName, long size, InputStream in) throws IOException {
        if (size > maxUploadBytes) {
            throw ApiException.validation("حجم الملف يتجاوز الحد المسموح للرفع (" + (maxUploadBytes / (1024 * 1024)) + " م.ب)؛ ضع الملف في مجلد الترحيل بدلاً من رفعه.");
        }
        String base = originalName == null ? "" : Path.of(originalName.replace('\\', '/')).getFileName().toString();
        base = base.replaceAll("[^A-Za-z0-9._-]", "_");
        if (base.isEmpty() || base.startsWith(".")) {
            base = "upload-" + UUID.randomUUID().toString().substring(0, 8) + ".dump";
        }
        if (!FILE_NAME.matcher(base).matches()) {
            base = base.substring(0, Math.min(base.length(), 200));
        }
        Path target = inbox().resolve(base);
        Path tmp = inbox().resolve(base + ".part");
        Files.copy(in, tmp, StandardCopyOption.REPLACE_EXISTING);
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        return inspect(target);
    }

    /** The files of the inbox, newest first. */
    public List<Info> list() throws IOException {
        List<Info> out = new ArrayList<>();
        try (Stream<Path> s = Files.list(inbox())) {
            for (Path p : s.sorted((a, b) -> {
                try {
                    return Files.getLastModifiedTime(b).compareTo(Files.getLastModifiedTime(a));
                } catch (IOException e) {
                    return 0;
                }
            }).toList()) {
                String n = p.getFileName().toString();
                if (Files.isRegularFile(p) && FILE_NAME.matcher(n).matches() && !n.endsWith(".part")) {
                    out.add(inspect(p));
                }
            }
        }
        return out;
    }

    /** The magic of a {@code pg_dump -Fc} archive (PGDMP) and the file's SHA-256, read once in a stream. */
    public static Info inspect(Path p) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        byte[] head = new byte[MAGIC.length];
        int got = 0;
        long size = 0;
        try (InputStream in = Files.newInputStream(p)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (got < head.length) {
                    int take = Math.min(head.length - got, n);
                    System.arraycopy(buf, 0, head, got, take);
                    got += take;
                }
                md.update(buf, 0, n);
                size += n;
            }
        }
        boolean pgdmp = got == head.length && java.util.Arrays.equals(head, MAGIC);
        return new Info(p.getFileName().toString(), size, HexFormat.of().formatHex(md.digest()), pgdmp);
    }

    static String stagingName(UUID id) {
        return STAGING_PREFIX + id.toString().replace("-", "").substring(0, 12).toLowerCase(Locale.ROOT);
    }

    /**
     * Creates the staging database and restores the dump into it with {@code pg_restore} (no owners, no privileges). Exit
     * code 1 means pg_restore ignored errors (comments, extension objects that already exist): the schema version read
     * afterwards decides. Any other failure drops the staging database again.
     */
    public String stage(UUID id, Path dump) {
        String name = stagingName(id);
        if (!DbMigrationService.NAME.matcher(name).matches()) {
            throw new IllegalStateException(name);
        }
        try (Connection c = dataSource.getConnection(); Statement st = c.createStatement()) {
            c.setAutoCommit(true);
            st.execute("drop database if exists \"" + name + "\" with (force)");
            st.execute("create database \"" + name + "\" template template0");
        } catch (SQLException e) {
            throw ApiException.validation("تعذر إنشاء قاعدة الاستعادة المؤقتة على خادم قاعدة البيانات: " + e.getMessage());
        }
        List<String> cmd = new ArrayList<>(List.of(pgRestore, "--no-owner", "--no-privileges", "--no-comments",
                "--host", datasource.host(), "--port", String.valueOf(datasource.port()), "--username", datasource.username(),
                "--dbname", name, dump.toAbsolutePath().toString()));
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        pb.environment().put("PGPASSWORD", datasource.password() == null ? "" : datasource.password());
        pb.environment().put("PGCONNECT_TIMEOUT", "10");
        try {
            Process p = pb.start();
            p.getOutputStream().close();
            byte[] out = p.getInputStream().readAllBytes();
            if (!p.waitFor(30, TimeUnit.MINUTES)) {
                p.destroyForcibly();
                drop(name);
                throw ApiException.validation("استعادة النسخة استغرقت أكثر من 30 دقيقة وأُوقفت.");
            }
            String text = new String(out, StandardCharsets.UTF_8);
            if (p.exitValue() > 1) {
                drop(name);
                throw ApiException.validation("فشلت استعادة النسخة (pg_restore " + p.exitValue() + "): " + tail(text));
            }
            if (p.exitValue() == 1) {
                log.info("pg_restore of {} into {} finished with ignored errors: {}", dump.getFileName(), name, tail(text));
            }
            return name;
        } catch (IOException e) {
            drop(name);
            throw ApiException.validation("أداة pg_restore غير متوفرة في صورة الخادم (أعد بناء صورة tmrkz/folder-backend بعد إضافة postgresql-client-17): " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            drop(name);
            throw ApiException.validation("أُوقفت استعادة النسخة.");
        }
    }

    private static String tail(String text) {
        String t = text == null ? "" : text.strip();
        return t.length() > 400 ? "…" + t.substring(t.length() - 400) : t;
    }

    /** Drops a staging database (its connections are closed first); nothing else is ever dropped. */
    public void drop(String name) {
        if (name == null || !name.startsWith(STAGING_PREFIX) || !DbMigrationService.NAME.matcher(name).matches()) {
            return;
        }
        try (Connection c = dataSource.getConnection(); Statement st = c.createStatement()) {
            c.setAutoCommit(true);
            st.execute("drop database if exists \"" + name + "\" with (force)");
        } catch (SQLException e) {
            log.warn("Staging database {} could not be dropped: {}", name, e.getMessage());
        }
    }
}
