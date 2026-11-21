package ae.mover.system;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Pattern;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.hr.HrSettingsCipher;

/**
 * «مركز ترحيل قاعدة البيانات» (owner, 20 Nov 2026; ADR-094 «Migration Center»): the data of an OLDER TMRKZ PostgreSQL
 * database brought into the CURRENT one, which is never replaced. The flow is choose the source (a live connection or a
 * {@code pg_dump -Fc} file restored into an isolated staging database) → check its schema version → analyse its tables →
 * preview by category → choose the tables and decide each conflict → validate → migrate behind the backup gate → report.
 *
 * <p>Conflicts (same stable id, different content): the default is that the current record wins and is never overwritten
 * silently; the administrator sees each conflict (key, the differing columns with both values) and decides per record —
 * KEEP, or TAKE_SOURCE to update the current row's shared columns from the source. The commit refuses while a table with
 * conflicts has no recorded decision (confirming the KEEP default for the table counts). Decisions are kept in the migration
 * row and in the audit.
 *
 * <p>The source is opened read-only (the connection and {@code default_transaction_read_only}); it must be a TMRKZ schema
 * ({@code flyway_schema_history} present) whose last successful version is not newer than the current database's, and it
 * must not be the current database itself. Only the business tables both sides share are considered; the tables
 * {@link DbMigrationCatalog} names as unsupported (sessions, sign-in state, outboxes, Flowable, Flyway, HR staging and
 * secrets, integration secrets, OpenFGA state, this table) are never read or written, and a password hash or any secret
 * column is stripped even from a table that is migrated.
 *
 * <p>Rows travel as text (every column cast to text on the source, cast back to the current column's type on insert) with
 * both sessions rendering dates, floats and bytes the same way, so the comparison «the row as text of all shared columns»
 * is exact and the transfer needs no per-type code. Only the shared columns are carried; a column the current database
 * added since takes its default. Every table name and column name comes from {@code information_schema}, is checked against
 * {@code [a-z_][a-z0-9_]*} and is double-quoted; values are always bound parameters.
 *
 * <p>The migration inserts the NEW rows of the chosen tables in dependency order (foreign keys of the current database,
 * topological; a cycle is refused) and applies the TAKE_SOURCE updates, inside ONE transaction of the current database,
 * reading the source in key-ordered batches, with {@code on conflict do nothing} on the primary key as the safety net; a
 * self-referencing table inserts parents before children. The source fingerprint (per table: row count, highest key, latest
 * stamp) taken at the preview is taken again at the commit; a change refuses the commit and asks for a new preview. A
 * failure rolls everything back and records FAILED with the reason.
 */
@Service
public class DbMigrationService {

    private static final Logger log = LoggerFactory.getLogger(DbMigrationService.class);
    static final Pattern NAME = Pattern.compile("^[a-z_][a-z0-9_]*$");
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\\[[0-9A-Fa-f:]+]$");
    private static final Pattern DATABASE = Pattern.compile("^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,62}$");
    private static final List<String> STAMP_COLUMNS = List.of("updated_at", "changed_at", "created_at", "occurred_at", "at");
    private static final int BATCH = 500;
    private static final int SAMPLE_KEYS = 50;
    private static final int DETAIL_ROWS = 200;
    private static final int DETAIL_CHARS = 160;
    private static final int LIST_LIMIT = 20;
    static final String KEEP = "KEEP";
    static final String TAKE_SOURCE = "TAKE_SOURCE";

    /**
     * The source as the screen enters it: {@code type} CONNECTION (host, port, database, username, password, schema) or DUMP
     * ({@code file}: a name in the inbox). {@code password} is write-only and never stored in clear.
     */
    public record Source(String type, String host, Integer port, String database, String username, String password, String schema,
                         String file) {

        @Override
        public String toString() {
            return "Source[" + type + " " + host + ":" + port + "/" + database + " " + schema + " " + file + "]"; // never the password
        }
    }

    /** A decision per table: the KEEP default confirmed for the table, and the records taken from the source. */
    public record TableDecision(Boolean confirmed, Map<String, String> records) {
    }

    public record Selection(List<String> tables, Map<String, TableDecision> decisions) {
    }

    /** The commit's confirmation: the administrator attests that {@code sh ops/verify-backup.sh <dir>} passed when no result file says so. */
    public record Commit(Boolean backupVerified) {
    }

    private record Column(String name, String udt) {
    }

    /** One shared table as the two sides describe it; the primary key and the column types come from the current side. */
    private record Shared(String name, String pk, String pkUdt, boolean serialPk, List<Column> columns, List<String> selfRefColumns,
                          List<String> sourceOnly, List<String> currentOnly, List<String> secret, String stampColumn) {
    }

    private record Side(Set<String> tables, Map<String, List<Column>> columns, Map<String, String> primaryKeys, Set<String> serialKeys) {
    }

    private record Edge(String child, String column, String parent) {
    }

    private record Scan(long sourceRows, long newRows, long conflicts, long identical, long inserted, long updated,
                        List<String> conflictSamples, List<Map<String, Object>> conflictDetails, boolean detailsTruncated) {
    }

    private final JdbcClient jdbc;
    private final DataSource dataSource;
    private final TransactionTemplate readTx;
    private final TransactionTemplate writeTx;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final HrSettingsCipher cipher;
    private final DbMigrationDump dumps;
    private final DbMigrationBackups backups;

    public DbMigrationService(JdbcClient jdbc, DataSource dataSource, PlatformTransactionManager txManager, Json json, Clock clock,
                              AuditService audit, HrSettingsCipher cipher, DbMigrationDump dumps, DbMigrationBackups backups) {
        this.jdbc = jdbc;
        this.dataSource = dataSource;
        this.readTx = new TransactionTemplate(txManager);
        this.readTx.setReadOnly(true);
        this.writeTx = new TransactionTemplate(txManager);
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.cipher = cipher;
        this.dumps = dumps;
        this.backups = backups;
    }

    // ---- 1. choose the source, check its version, analyse its tables -------------------------------------------------

    public Map<String, Object> connect(AccessContext ctx, Source in) {
        ctx.require(Permission.CONFIGURE);
        if (!cipher.configured()) {
            throw ApiException.validation("مفتاح حماية الإعدادات (TMRKZ_HR_SETTINGS_KEY) غير مهيأ؛ لا يمكن حفظ بيانات اتصال المصدر.");
        }
        UUID id = UUID.randomUUID();
        Source s;
        String staging = null;
        Map<String, Object> dumpInfo = null;
        if (in != null && "DUMP".equalsIgnoreCase(text(in.type()))) {
            Path dump = dumps.resolve(in.file());
            DbMigrationDump.Info info;
            try {
                info = DbMigrationDump.inspect(dump);
            } catch (IOException e) {
                throw ApiException.validation("تعذرت قراءة ملف النسخة: " + e.getMessage());
            }
            if (!info.pgdmp()) {
                throw ApiException.validation("الملف ليس نسخة pg_dump بالصيغة المخصصة (-Fc): لا يبدأ بالعلامة PGDMP.");
            }
            dumpInfo = info.asMap();
            staging = dumps.stage(id, dump);
            DbMigrationDump.Datasource ds = dumps.datasource();
            s = new Source("DUMP", ds.host(), ds.port(), staging, ds.username(), ds.password() == null ? "" : ds.password(), "public",
                    info.file());
        } else {
            s = normalise(in);
        }
        Map<String, Object> preview;
        Integer sourceVersion;
        try (Connection src = open(s)) {
            if (!schemaExists(src, s.schema())) {
                throw ApiException.validation("لا يوجد مخطط باسم «" + s.schema() + "» في قاعدة المصدر.");
            }
            sourceVersion = flywayVersion(src, s.schema());
            if (sourceVersion == null) {
                throw ApiException.validation("قاعدة المصدر ليست قاعدة TMRKZ: لا يوجد فيها سجل إصدارات المخطط (flyway_schema_history) بإصدار ناجح.");
            }
            final int sv = sourceVersion;
            final Source source = s;
            preview = readTx.execute(status -> {
                Connection cur = DataSourceUtils.getConnection(dataSource);
                try {
                    textSettings(cur, true);
                    String currentSchema = currentSchema(cur);
                    if (sameDatabase(source, currentSchema)) {
                        throw ApiException.validation("هذه هي قاعدة البيانات الحالية نفسها؛ اختر قاعدة قديمة أخرى.");
                    }
                    Integer cv = flywayVersion(cur, currentSchema);
                    int currentVersion = cv == null ? 0 : cv;
                    if (sv > currentVersion) {
                        throw ApiException.validation("إصدار مخطط المصدر (" + sv + ") أحدث من إصدار القاعدة الحالية (" + currentVersion
                                + ")؛ حدّث النظام الحالي أولاً ثم أعد المحاولة.");
                    }
                    return analyse(src, source.schema(), cur, currentSchema, sv, currentVersion);
                } catch (SQLException e) {
                    throw unavailable(e);
                }
            });
        } catch (SQLException e) {
            dumps.drop(staging);
            throw unavailable(e);
        } catch (RuntimeException e) {
            dumps.drop(staging);
            throw e;
        }
        preview.put("sourceType", s.type());
        if (dumpInfo != null) {
            preview.put("dump", dumpInfo);
        }
        Map<String, Object> source = asSource(s);
        String cipherText = cipher.encrypt(s.password());
        jdbc.sql("""
                insert into db_migration(id, state, source, secret_ciphertext, secret_key_id, source_schema_version, created_by, created_at, preview)
                values (:id, 'PREVIEWED', cast(:src as jsonb), :c, :kid, :v, :by, :now, cast(:p as jsonb))""")
                .param("id", id).param("src", json.write(source)).param("c", cipherText).param("kid", cipher.keyId())
                .param("v", sourceVersion).param("by", ctx.personId()).param("now", Db.ts(clock.instant())).param("p", json.write(preview)).update();
        Map<String, Object> detail = new LinkedHashMap<>(source);
        detail.put("sourceVersion", sourceVersion);
        detail.put("currentVersion", preview.get("currentVersion"));
        detail.put("tables", ((List<?>) preview.get("tables")).size());
        detail.put("categories", preview.get("categories"));
        detail.put("fingerprint", preview.get("fingerprint"));
        if (dumpInfo != null) {
            detail.put("dump", dumpInfo);
        }
        audit.recordAs(ctx.actor(), "DB_MIGRATION_PREVIEWED", "SETTINGS", "db-migration/" + id, "مركز ترحيل قاعدة البيانات", detail,
                "فحص قاعدة بيانات قديمة ومعاينة جداولها");
        return view(id);
    }

    private static Source normalise(Source in) {
        if (in == null) {
            throw ApiException.validation("اكتب بيانات الاتصال بقاعدة المصدر.");
        }
        String host = text(in.host());
        String database = text(in.database());
        String username = text(in.username());
        String schema = text(in.schema()) == null ? "public" : in.schema().trim().toLowerCase(Locale.ROOT);
        int port = in.port() == null ? 5432 : in.port();
        if (host == null || !HOST.matcher(host).matches()) {
            throw ApiException.validation("اسم الخادم يجب أن يكون اسم مضيف أو عنواناً، دون بيانات دخول أو مسار.");
        }
        if (port < 1 || port > 65535) {
            throw ApiException.validation("المنفذ بين 1 و65535.");
        }
        if (database == null || !DATABASE.matcher(database).matches()) {
            throw ApiException.validation("اكتب اسم قاعدة البيانات (حروف وأرقام وشرطات فقط).");
        }
        if (username == null || username.length() > 128 || username.chars().anyMatch(Character::isISOControl)) {
            throw ApiException.validation("اكتب اسم المستخدم.");
        }
        if (in.password() == null || in.password().isEmpty()) {
            throw ApiException.validation("اكتب كلمة مرور المستخدم.");
        }
        if (!NAME.matcher(schema).matches()) {
            throw ApiException.validation("اسم المخطط ليس اسماً صالحاً (حروف صغيرة وأرقام وشرطة سفلية).");
        }
        return new Source("CONNECTION", host, port, database, username, in.password(), schema, null);
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    private static Map<String, Object> asSource(Source s) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", s.type());
        m.put("host", s.host());
        m.put("port", s.port());
        m.put("database", s.database());
        m.put("username", s.username());
        m.put("schema", s.schema());
        m.put("file", s.file());
        return m;
    }

    /** The current datasource (host, port, database) and schema: the one source that is refused. */
    private boolean sameDatabase(Source s, String currentSchema) {
        DbMigrationDump.Datasource ds = dumps.datasource();
        return ds.host().equalsIgnoreCase(s.host()) && ds.port() == s.port() && ds.database().equals(s.database())
                && currentSchema.equals(s.schema());
    }

    /** A read-only JDBC connection to the old PostgreSQL: the driver's read-only flag and the session default both say so. */
    private static Connection open(Source s) throws SQLException {
        Properties p = new Properties();
        p.setProperty("user", s.username());
        p.setProperty("password", s.password() == null ? "" : s.password());
        p.setProperty("readOnly", "true");
        p.setProperty("readOnlyMode", "always");
        p.setProperty("options", "-c default_transaction_read_only=on");
        p.setProperty("ApplicationName", "TMRKZ migration center");
        p.setProperty("loginTimeout", "10");
        p.setProperty("connectTimeout", "10");
        p.setProperty("socketTimeout", "900");
        String host = s.host().startsWith("[") ? s.host() : s.host().toLowerCase(Locale.ROOT);
        Connection c = DriverManager.getConnection("jdbc:postgresql://" + host + ":" + s.port() + "/" + s.database(), p);
        try {
            c.setReadOnly(true);
            c.setAutoCommit(true);
            textSettings(c, false);
        } catch (SQLException | RuntimeException e) {
            c.close();
            throw e;
        }
        return c;
    }

    private static ApiException unavailable(SQLException e) {
        String reason = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage().strip();
        if (reason.length() > 400) {
            reason = reason.substring(0, 400) + "…";
        }
        return ApiException.validation("تعذر الوصول إلى قاعدة المصدر أو قراءتها: " + reason);
    }

    /** Both sessions render dates, intervals, floats and bytes the same way, so text comparison and transfer are exact. */
    private static void textSettings(Connection c, boolean local) throws SQLException {
        String prefix = local ? "set local " : "set ";
        try (Statement st = c.createStatement()) {
            st.execute(prefix + "time zone 'UTC'");
            st.execute(prefix + "datestyle to 'ISO, YMD'");
            st.execute(prefix + "intervalstyle to 'postgres'");
            st.execute(prefix + "extra_float_digits to 3");
            st.execute(prefix + "bytea_output to 'hex'");
        }
    }

    private static String currentSchema(Connection c) throws SQLException {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("select current_schema()")) {
            rs.next();
            String s = rs.getString(1);
            return s == null ? "public" : s;
        }
    }

    private static boolean schemaExists(Connection c, String schema) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("select 1 from information_schema.schemata where schema_name = ?")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next();
            }
        }
    }

    /** The last successful numbered Flyway version of a TMRKZ schema; null when the history table is absent or empty. */
    private static Integer flywayVersion(Connection c, String schema) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(
                "select 1 from information_schema.tables where table_schema = ? and table_name = 'flyway_schema_history'")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
            }
        }
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("select max(cast(version as int)) from " + q(schema)
                + ".flyway_schema_history where success and version ~ '^[0-9]+$'")) {
            rs.next();
            int v = rs.getInt(1);
            return rs.wasNull() ? null : v;
        }
    }

    // ---- the table analysis --------------------------------------------------------------------------------------------

    private Map<String, Object> analyse(Connection src, String srcSchema, Connection cur, String curSchema, int sourceVersion,
                                        int currentVersion) throws SQLException {
        Side source = side(src, srcSchema);
        Side current = side(cur, curSchema);
        List<Edge> edges = foreignKeys(cur, curSchema);
        List<Map<String, Object>> tables = new ArrayList<>();
        List<Map<String, Object>> excluded = new ArrayList<>();
        Map<String, Object> fingerprint = new TreeMap<>();
        Map<String, long[]> perCategory = new LinkedHashMap<>();
        for (DbMigrationCatalog.Category c : DbMigrationCatalog.CATEGORIES) {
            perCategory.put(c.code(), new long[6]); // tables, new, identical, conflicts, changed, unsupported
        }
        for (String t : new TreeSet<>(current.tables())) {
            String category = DbMigrationCatalog.category(t);
            String why = excludedReason(t, current);
            if (why != null) {
                excluded.add(Map.of("table", t, "category", category, "reason", why));
                perCategory.get(category)[5]++;
                continue;
            }
            if (!source.tables().contains(t)) {
                excluded.add(Map.of("table", t, "category", category, "reason", "غير موجود في المصدر"));
                continue;
            }
            String pk = current.primaryKeys().get(t);
            if (!pk.equals(source.primaryKeys().get(t))) {
                excluded.add(Map.of("table", t, "category", category, "reason", "المفتاح الأساسي في المصدر يختلف عن الحالي"));
                continue;
            }
            Shared shared = shared(t, source, current, edges);
            Scan scan = scan(src, srcSchema, cur, shared, false, Map.of());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("table", t);
            row.put("category", category);
            row.put("primaryKey", pk);
            row.put("sourceRows", scan.sourceRows());
            row.put("currentRows", count(cur, null, t));
            row.put("newRows", scan.newRows());
            row.put("conflicts", scan.conflicts());
            row.put("identical", scan.identical());
            row.put("conflictSamples", scan.conflictSamples());
            row.put("conflictDetails", scan.conflictDetails());
            row.put("conflictDetailsTruncated", scan.detailsTruncated());
            row.put("sharedColumns", shared.columns().stream().map(Column::name).toList());
            row.put("secretColumns", shared.secret());
            row.put("sourceOnlyColumns", shared.sourceOnly());
            row.put("currentOnlyColumns", shared.currentOnly());
            row.put("dependsOn", dependsOn(t, edges));
            tables.add(row);
            fingerprint.put(t, fingerprint(src, srcSchema, shared));
            long[] c = perCategory.get(category);
            c[0]++;
            c[1] += scan.newRows();
            c[2] += scan.identical();
            c[3] += scan.conflicts();
        }
        List<String> sourceOnlyTables = new ArrayList<>();
        for (String t : new TreeSet<>(source.tables())) {
            if (!current.tables().contains(t) && excludedReason(t, source) == null) {
                sourceOnlyTables.add(t);
            }
        }
        List<Map<String, Object>> categories = new ArrayList<>();
        for (DbMigrationCatalog.Category c : DbMigrationCatalog.CATEGORIES) {
            long[] n = perCategory.get(c.code());
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("code", c.code());
            m.put("label", c.label());
            m.put("tables", n[0]);
            m.put("newRows", n[1]);
            m.put("identical", n[2]);
            m.put("conflicts", n[3]);
            m.put("changed", n[4]);
            m.put("unsupported", n[5]);
            categories.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sourceVersion", sourceVersion);
        out.put("currentVersion", currentVersion);
        out.put("currentSchema", curSchema);
        out.put("categories", categories);
        out.put("tables", tables);
        out.put("excluded", excluded);
        out.put("sourceOnlyTables", sourceOnlyTables);
        out.put("fingerprint", fingerprint);
        return out;
    }

    private static String excludedReason(String t, Side side) {
        if (!NAME.matcher(t).matches()) {
            return "اسم جدول غير مقبول";
        }
        String unsupported = DbMigrationCatalog.unsupportedReason(t);
        if (unsupported != null) {
            return unsupported;
        }
        if (!side.primaryKeys().containsKey(t)) {
            return "بلا مفتاح أساسي من عمود واحد";
        }
        return null;
    }

    private static Shared shared(String t, Side source, Side current, List<Edge> edges) {
        Set<String> srcCols = new HashSet<>();
        for (Column c : source.columns().getOrDefault(t, List.of())) {
            srcCols.add(c.name());
        }
        String pk = current.primaryKeys().get(t);
        List<Column> shared = new ArrayList<>();
        List<String> currentOnly = new ArrayList<>();
        List<String> secret = new ArrayList<>();
        Set<String> sharedNames = new HashSet<>();
        for (Column c : current.columns().getOrDefault(t, List.of())) {
            if (!NAME.matcher(c.name()).matches() || !NAME.matcher(c.udt()).matches()) {
                continue;
            }
            if (!c.name().equals(pk) && DbMigrationCatalog.secretColumn(c.name())) {
                secret.add(c.name());
                continue;
            }
            if (srcCols.contains(c.name())) {
                shared.add(c);
                sharedNames.add(c.name());
            } else {
                currentOnly.add(c.name());
            }
        }
        List<String> sourceOnly = new ArrayList<>();
        for (Column c : source.columns().getOrDefault(t, List.of())) {
            if (!sharedNames.contains(c.name()) && !secret.contains(c.name())) {
                sourceOnly.add(c.name());
            }
        }
        String pkUdt = shared.stream().filter(c -> c.name().equals(pk)).map(Column::udt).findFirst().orElse("text");
        List<String> selfRef = new ArrayList<>();
        for (Edge e : edges) {
            if (e.child().equals(t) && e.parent().equals(t) && sharedNames.contains(e.column()) && !e.column().equals(pk)) {
                selfRef.add(e.column());
            }
        }
        String stamp = null;
        for (String s : STAMP_COLUMNS) {
            if (sharedNames.contains(s)) {
                stamp = s;
                break;
            }
        }
        return new Shared(t, pk, pkUdt, current.serialKeys().contains(t), shared, selfRef, sourceOnly, currentOnly, secret, stamp);
    }

    private static List<String> dependsOn(String t, List<Edge> edges) {
        Set<String> out = new TreeSet<>();
        for (Edge e : edges) {
            if (e.child().equals(t) && !e.parent().equals(t)) {
                out.add(e.parent());
            }
        }
        return new ArrayList<>(out);
    }

    private static Side side(Connection c, String schema) throws SQLException {
        Set<String> tables = new HashSet<>();
        try (PreparedStatement ps = c.prepareStatement(
                "select table_name from information_schema.tables where table_schema = ? and table_type = 'BASE TABLE'")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    tables.add(rs.getString(1));
                }
            }
        }
        Map<String, List<Column>> columns = new HashMap<>();
        Map<String, Map<String, String>> defaults = new HashMap<>();
        try (PreparedStatement ps = c.prepareStatement("""
                select table_name, column_name, udt_name, column_default, is_generated, is_identity, identity_generation
                from information_schema.columns where table_schema = ? order by table_name, ordinal_position""")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    // a generated column (site.marker) or an always-identity column is computed by the database: never carried
                    if ("ALWAYS".equals(rs.getString(5)) || ("YES".equals(rs.getString(6)) && "ALWAYS".equals(rs.getString(7)))) {
                        continue;
                    }
                    columns.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(new Column(rs.getString(2), rs.getString(3)));
                    String d = rs.getString(4);
                    if (d != null) {
                        defaults.computeIfAbsent(rs.getString(1), k -> new HashMap<>()).put(rs.getString(2), d);
                    }
                }
            }
        }
        Map<String, List<String>> pkColumns = new HashMap<>();
        try (PreparedStatement ps = c.prepareStatement("""
                select tc.table_name, kcu.column_name from information_schema.table_constraints tc
                join information_schema.key_column_usage kcu on kcu.constraint_schema = tc.constraint_schema
                  and kcu.constraint_name = tc.constraint_name and kcu.table_name = tc.table_name
                where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = ? order by kcu.ordinal_position""")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    pkColumns.computeIfAbsent(rs.getString(1), k -> new ArrayList<>()).add(rs.getString(2));
                }
            }
        }
        Map<String, String> primaryKeys = new HashMap<>();
        Set<String> serial = new HashSet<>();
        for (Map.Entry<String, List<String>> e : pkColumns.entrySet()) {
            if (e.getValue().size() == 1) {
                String col = e.getValue().get(0);
                primaryKeys.put(e.getKey(), col);
                String d = defaults.getOrDefault(e.getKey(), Map.of()).get(col);
                if (d != null && d.startsWith("nextval(")) {
                    serial.add(e.getKey());
                }
            }
        }
        return new Side(tables, columns, primaryKeys, serial);
    }

    /** The foreign keys of the current database between its tables (child, child column, parent). */
    private static List<Edge> foreignKeys(Connection c, String schema) throws SQLException {
        List<Edge> out = new ArrayList<>();
        try (PreparedStatement ps = c.prepareStatement("""
                select tc.table_name as child, kcu.column_name, pc.table_name as parent
                from information_schema.referential_constraints rc
                join information_schema.table_constraints tc on tc.constraint_schema = rc.constraint_schema
                  and tc.constraint_name = rc.constraint_name
                join information_schema.table_constraints pc on pc.constraint_schema = rc.unique_constraint_schema
                  and pc.constraint_name = rc.unique_constraint_name
                join information_schema.key_column_usage kcu on kcu.constraint_schema = tc.constraint_schema
                  and kcu.constraint_name = tc.constraint_name
                where tc.constraint_schema = ?""")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(new Edge(rs.getString(1), rs.getString(2), rs.getString(3)));
                }
            }
        }
        return out;
    }

    private static long count(Connection c, String schema, String table) throws SQLException {
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("select count(*) from " + (schema == null ? "" : q(schema) + ".") + q(table))) {
            rs.next();
            return rs.getLong(1);
        }
    }

    /** The source's fingerprint of one table: row count, highest key, latest stamp (when the table has one). */
    private static Map<String, Object> fingerprint(Connection src, String schema, Shared t) throws SQLException {
        // max over the text form: uuid has no max aggregate, and the fingerprint only has to be deterministic
        String sql = "select count(*), max(cast(" + q(t.pk()) + " as text))"
                + (t.stampColumn() == null ? "" : ", max(cast(" + q(t.stampColumn()) + " as text))")
                + " from " + q(schema) + "." + q(t.name());
        try (Statement st = src.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("rows", rs.getLong(1));
            m.put("maxKey", rs.getString(2));
            m.put("stampColumn", t.stampColumn());
            m.put("maxStamp", t.stampColumn() == null ? null : rs.getString(3));
            return m;
        }
    }

    /** A checked identifier, double-quoted. */
    static String q(String name) {
        if (name == null || !NAME.matcher(name).matches()) {
            throw ApiException.validation("اسم غير مقبول في المخطط: " + name);
        }
        return "\"" + name + "\"";
    }

    // ---- the scan of one table: classify every source row; with write=true insert the new ones and apply decisions ------

    private static Scan scan(Connection src, String srcSchema, Connection cur, Shared t, boolean write, Map<String, String> decisions)
            throws SQLException {
        List<Column> cols = t.columns();
        int pkIndex = -1;
        StringBuilder select = new StringBuilder("select ");
        for (int i = 0; i < cols.size(); i++) {
            if (cols.get(i).name().equals(t.pk())) {
                pkIndex = i;
            }
            select.append(i > 0 ? ", " : "").append("cast(").append(q(cols.get(i).name())).append(" as text)");
        }
        if (pkIndex < 0) {
            throw ApiException.validation("المفتاح الأساسي للجدول " + t.name() + " ليس من الأعمدة المشتركة.");
        }
        String from = " from " + q(srcSchema) + "." + q(t.name());
        String orderBy = " order by " + q(t.pk()) + " limit " + BATCH;
        String keyCast = "cast(? as " + q(t.pkUdt()) + ")";
        String keyArray = "cast(? as " + q(t.pkUdt()) + "[])";
        String lookup = select + " from " + q(t.name()) + " where " + q(t.pk()) + " = any(" + keyArray + ")";
        String parentLookup = "select cast(" + q(t.pk()) + " as text) from " + q(t.name()) + " where " + q(t.pk()) + " = any(" + keyArray + ")";
        StringBuilder insert = new StringBuilder("insert into " + q(t.name()) + " (");
        StringBuilder values = new StringBuilder();
        StringBuilder update = new StringBuilder("update " + q(t.name()) + " set ");
        int updateColumns = 0;
        for (int i = 0; i < cols.size(); i++) {
            insert.append(i > 0 ? ", " : "").append(q(cols.get(i).name()));
            values.append(i > 0 ? ", " : "").append("cast(? as ").append(q(cols.get(i).udt())).append(")");
            if (i != pkIndex) {
                update.append(updateColumns++ > 0 ? ", " : "").append(q(cols.get(i).name())).append(" = cast(? as ").append(q(cols.get(i).udt())).append(")");
            }
        }
        insert.append(") values (").append(values).append(") on conflict (").append(q(t.pk())).append(") do nothing");
        update.append(" where ").append(q(t.pk())).append(" = ").append(keyCast);
        int[] selfRef = t.selfRefColumns().stream().mapToInt(c -> indexOf(cols, c)).toArray();

        long sourceRows = 0;
        long newRows = 0;
        long conflicts = 0;
        long identical = 0;
        long inserted = 0;
        long updated = 0;
        List<String> samples = new ArrayList<>();
        List<Map<String, Object>> details = new ArrayList<>();
        boolean truncated = false;
        Set<String> present = new HashSet<>();
        List<String[]> deferred = new ArrayList<>();
        List<String[]> takeSource = new ArrayList<>();
        String lastKey = null;
        final int pk = pkIndex;
        try (PreparedStatement first = src.prepareStatement(select + from + orderBy);
             PreparedStatement next = src.prepareStatement(select + from + " where " + q(t.pk()) + " > " + keyCast + orderBy);
             PreparedStatement look = cur.prepareStatement(lookup);
             PreparedStatement parents = cur.prepareStatement(parentLookup);
             PreparedStatement ins = write ? cur.prepareStatement(insert.toString()) : null;
             PreparedStatement upd = write && updateColumns > 0 ? cur.prepareStatement(update.toString()) : null) {
            while (true) {
                List<String[]> batch = new ArrayList<>(BATCH);
                PreparedStatement ps = lastKey == null ? first : next;
                if (lastKey != null) {
                    next.setString(1, lastKey);
                }
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        String[] row = new String[cols.size()];
                        for (int i = 0; i < row.length; i++) {
                            row[i] = rs.getString(i + 1);
                        }
                        batch.add(row);
                    }
                }
                if (batch.isEmpty()) {
                    break;
                }
                sourceRows += batch.size();
                lastKey = batch.get(batch.size() - 1)[pk];
                String[] keys = batch.stream().map(r -> r[pk]).toArray(String[]::new);
                Map<String, String[]> existing = new HashMap<>();
                look.setArray(1, cur.createArrayOf("text", keys));
                try (ResultSet rs = look.executeQuery()) {
                    while (rs.next()) {
                        String[] row = new String[cols.size()];
                        for (int i = 0; i < row.length; i++) {
                            row[i] = rs.getString(i + 1);
                        }
                        existing.put(row[pk], row);
                    }
                }
                List<String[]> fresh = new ArrayList<>();
                for (String[] row : batch) {
                    String[] have = existing.get(row[pk]);
                    if (have == null) {
                        newRows++;
                        fresh.add(row);
                    } else if (Arrays.equals(have, row)) {
                        identical++;
                        present.add(row[pk]);
                    } else {
                        conflicts++;
                        present.add(row[pk]);
                        if (samples.size() < SAMPLE_KEYS) {
                            samples.add(row[pk]);
                        }
                        if (details.size() < DETAIL_ROWS) {
                            details.add(difference(cols, row[pk], have, row));
                        } else {
                            truncated = true;
                        }
                        if (write && TAKE_SOURCE.equals(decisions.get(row[pk]))) {
                            takeSource.add(row);
                        }
                    }
                }
                if (!write || fresh.isEmpty()) {
                    continue;
                }
                if (selfRef.length == 0) {
                    inserted += insertAll(ins, fresh);
                    continue;
                }
                // a self-referencing table: the parents named by this batch that the current database already holds
                Set<String> wanted = new HashSet<>();
                for (String[] row : fresh) {
                    for (int c : selfRef) {
                        if (row[c] != null && !present.contains(row[c])) {
                            wanted.add(row[c]);
                        }
                    }
                }
                if (!wanted.isEmpty()) {
                    parents.setArray(1, cur.createArrayOf("text", wanted.toArray(String[]::new)));
                    try (ResultSet rs = parents.executeQuery()) {
                        while (rs.next()) {
                            present.add(rs.getString(1));
                        }
                    }
                }
                List<String[]> ready = new ArrayList<>();
                for (String[] row : fresh) {
                    if (ready(row, selfRef, present)) {
                        ready.add(row);
                        present.add(row[pk]);
                    } else {
                        deferred.add(row);
                    }
                }
                inserted += insertAll(ins, ready);
            }
            // rows whose parent row came later in key order: passes until nothing more becomes ready
            while (write && !deferred.isEmpty()) {
                List<String[]> ready = new ArrayList<>();
                List<String[]> still = new ArrayList<>();
                for (String[] row : deferred) {
                    if (ready(row, selfRef, present)) {
                        ready.add(row);
                        present.add(row[pk]);
                    } else {
                        still.add(row);
                    }
                }
                if (ready.isEmpty()) {
                    // a parent missing on both sides: inserted as is, so the current database's foreign key says so honestly
                    inserted += insertAll(ins, still);
                    break;
                }
                inserted += insertAll(ins, ready);
                deferred = still;
            }
            // the conflicts the administrator decided to take from the source, after every new row of the table is in
            if (upd != null && !takeSource.isEmpty()) {
                for (String[] row : takeSource) {
                    int p = 1;
                    for (int i = 0; i < row.length; i++) {
                        if (i != pk) {
                            upd.setString(p++, row[i]);
                        }
                    }
                    upd.setString(p, row[pk]);
                    upd.addBatch();
                }
                for (int c : upd.executeBatch()) {
                    if (c > 0) {
                        updated += c;
                    }
                }
            }
        }
        if (write && inserted > 0 && t.serialPk()) {
            try (PreparedStatement ps = cur.prepareStatement("select setval(pg_get_serial_sequence(?, ?), greatest((select max("
                    + q(t.pk()) + ") from " + q(t.name()) + "), 1))")) {
                ps.setString(1, q(t.name()));
                ps.setString(2, t.pk());
                ps.execute();
            }
        }
        return new Scan(sourceRows, newRows, conflicts, identical, inserted, updated, samples, details, truncated);
    }

    /** One conflict for the screen: the key and the columns whose text differs, current beside source (shortened). */
    private static Map<String, Object> difference(List<Column> cols, String key, String[] current, String[] source) {
        List<Map<String, Object>> columns = new ArrayList<>();
        for (int i = 0; i < cols.size(); i++) {
            if (!Objects.equals(current[i], source[i])) {
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("column", cols.get(i).name());
                d.put("current", shorten(current[i]));
                d.put("source", shorten(source[i]));
                columns.add(d);
            }
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", key);
        m.put("columns", columns);
        return m;
    }

    private static String shorten(String s) {
        return s == null || s.length() <= DETAIL_CHARS ? s : s.substring(0, DETAIL_CHARS) + "…";
    }

    private static boolean ready(String[] row, int[] selfRef, Set<String> present) {
        for (int c : selfRef) {
            if (row[c] != null && !present.contains(row[c])) {
                return false;
            }
        }
        return true;
    }

    private static int indexOf(List<Column> cols, String name) {
        for (int i = 0; i < cols.size(); i++) {
            if (cols.get(i).name().equals(name)) {
                return i;
            }
        }
        throw new IllegalStateException(name);
    }

    private static long insertAll(PreparedStatement ins, List<String[]> rows) throws SQLException {
        if (rows.isEmpty()) {
            return 0;
        }
        for (String[] row : rows) {
            for (int i = 0; i < row.length; i++) {
                ins.setString(i + 1, row[i]);
            }
            ins.addBatch();
        }
        long n = 0;
        for (int c : ins.executeBatch()) {
            if (c > 0) {
                n += c;
            }
        }
        return n;
    }

    // ---- 2. the stored preview, the selection with its decisions, the plan ---------------------------------------------

    public Map<String, Object> view(UUID id) {
        Map<String, Object> row = jdbc.sql("""
                select m.id, m.state, m.source::text as source, m.source_schema_version, m.created_at, m.finished_at,
                       m.preview::text as preview, m.selection::text as selection, m.report::text as report, p.display_name as created_by
                from db_migration m left join person p on p.id = m.created_by where m.id = :id""")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id.toString());
        out.put("state", row.get("state"));
        Map<String, Object> source = json.map((String) row.get("source"));
        out.put("source", source);
        out.put("sourceType", source.getOrDefault("type", "CONNECTION"));
        out.put("sourceVersion", row.get("source_schema_version"));
        Map<String, Object> preview = row.get("preview") == null ? null : json.map((String) row.get("preview"));
        out.put("currentVersion", preview == null ? null : preview.get("currentVersion"));
        out.put("createdAt", iso(row.get("created_at")));
        out.put("createdBy", row.get("created_by"));
        out.put("finishedAt", iso(row.get("finished_at")));
        out.put("preview", preview);
        out.put("selection", row.get("selection") == null ? null : json.map((String) row.get("selection")));
        out.put("report", row.get("report") == null ? null : json.map((String) row.get("report")));
        out.put("backup", backups.status().asMap());
        return out;
    }

    private static String iso(Object ts) {
        Instant i = Db.toInstant(ts);
        return i == null ? null : i.toString();
    }

    public Map<String, Object> get(AccessContext ctx, UUID id) {
        ctx.require(Permission.CONFIGURE);
        return view(id);
    }

    /** The backup gate as the screen shows it before the commit. */
    public Map<String, Object> backupStatus(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        return backups.status().asMap();
    }

    /** The dump files waiting in the inbox folder. */
    public Map<String, Object> inbox(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("folder", dumps.inbox().toString());
        out.put("maxUploadBytes", dumps.maxUploadBytes());
        try {
            out.put("files", dumps.list().stream().map(DbMigrationDump.Info::asMap).toList());
        } catch (IOException e) {
            throw ApiException.validation("تعذرت قراءة مجلد الترحيل: " + e.getMessage());
        }
        return out;
    }

    /** An uploaded dump saved into the inbox; its magic and SHA-256 are reported, nothing is restored yet. */
    public Map<String, Object> upload(AccessContext ctx, String originalName, long size, InputStream in) {
        ctx.require(Permission.CONFIGURE);
        try {
            DbMigrationDump.Info info = dumps.store(originalName, size, in);
            audit.recordAs(ctx.actor(), "DB_MIGRATION_DUMP_UPLOADED", "SETTINGS", "db-migration/inbox/" + info.file(),
                    "مركز ترحيل قاعدة البيانات", info.asMap(), "رفع ملف نسخة قاعدة بيانات إلى مجلد الترحيل");
            return info.asMap();
        } catch (IOException e) {
            throw ApiException.validation("تعذر حفظ الملف: " + e.getMessage());
        }
    }

    public List<Map<String, Object>> list(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> row : jdbc.sql("""
                select m.id, m.state, m.source::text as source, m.source_schema_version, m.created_at, m.finished_at,
                       m.preview -> 'currentVersion' as current_version, p.display_name as created_by
                from db_migration m left join person p on p.id = m.created_by order by m.created_at desc limit %d""".formatted(LIST_LIMIT))
                .query().listOfRows()) {
            Map<String, Object> source = json.map((String) row.get("source"));
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", row.get("id").toString());
            m.put("state", row.get("state"));
            m.put("sourceType", source.getOrDefault("type", "CONNECTION"));
            m.put("host", source.get("host"));
            m.put("database", source.get("database"));
            m.put("schema", source.get("schema"));
            m.put("file", source.get("file"));
            m.put("sourceVersion", row.get("source_schema_version"));
            Object cv = row.get("current_version");
            m.put("currentVersion", cv == null ? null : Integer.valueOf(cv.toString().replace("\"", "")));
            m.put("createdAt", iso(row.get("created_at")));
            m.put("createdBy", row.get("created_by"));
            m.put("finishedAt", iso(row.get("finished_at")));
            out.add(m);
        }
        return out;
    }

    /**
     * Which tables to bring and what to do with each conflict: the dependency order from the current database's foreign keys
     * (a cycle is refused); a chosen table with conflicts needs its KEEP default confirmed or every record decided.
     */
    public Map<String, Object> select(AccessContext ctx, UUID id, Selection in) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> m = view(id);
        String state = (String) m.get("state");
        if (!"PREVIEWED".equals(state) && !"VALIDATED".equals(state)) {
            throw ApiException.validation("هذا الترحيل انتهى؛ افحص المصدر من جديد لترحيل آخر.");
        }
        Map<String, Object> preview = castMap(m.get("preview"));
        Map<String, Map<String, Object>> byName = new LinkedHashMap<>();
        for (Object o : (List<?>) preview.get("tables")) {
            Map<String, Object> t = castMap(o);
            byName.put((String) t.get("table"), t);
        }
        Set<String> chosen = new LinkedHashSet<>();
        if (in == null || in.tables() == null) {
            for (Map<String, Object> t : byName.values()) {
                if (((Number) t.get("newRows")).longValue() > 0) {
                    chosen.add((String) t.get("table"));
                }
            }
        } else {
            for (String t : in.tables()) {
                if (t == null || !byName.containsKey(t)) {
                    throw ApiException.validation("الجدول «" + t + "» ليس من الجداول المشتركة في المعاينة.");
                }
                chosen.add(t);
            }
        }
        if (chosen.isEmpty()) {
            throw ApiException.validation("اختر جدولاً واحداً على الأقل.");
        }
        List<String> order = order(chosen, byName);
        // the decisions: only for chosen tables, only KEEP or TAKE_SOURCE, only keys the preview listed as conflicts
        Map<String, Object> decisions = new LinkedHashMap<>();
        List<String> undecided = new ArrayList<>();
        long takeSourceTotal = 0;
        for (String t : order) {
            Map<String, Object> p = byName.get(t);
            long conflicts = ((Number) p.get("conflicts")).longValue();
            TableDecision d = in == null || in.decisions() == null ? null : in.decisions().get(t);
            Map<String, String> records = new TreeMap<>();
            if (d != null && d.records() != null) {
                Set<String> keys = new HashSet<>();
                for (Object o : (List<?>) p.get("conflictDetails")) {
                    keys.add((String) castMap(o).get("key"));
                }
                for (Map.Entry<String, String> e : d.records().entrySet()) {
                    String decision = e.getValue() == null ? KEEP : e.getValue().trim().toUpperCase(Locale.ROOT);
                    if (!KEEP.equals(decision) && !TAKE_SOURCE.equals(decision)) {
                        throw ApiException.validation("قرار غير معروف للسجل " + e.getKey() + " في «" + t + "»: " + e.getValue());
                    }
                    if (!keys.contains(e.getKey())) {
                        throw ApiException.validation("السجل " + e.getKey() + " ليس من تعارضات «" + t + "» في المعاينة.");
                    }
                    records.put(e.getKey(), decision);
                }
            }
            boolean confirmed = d != null && Boolean.TRUE.equals(d.confirmed());
            long detailed = ((List<?>) p.get("conflictDetails")).size();
            boolean everyRecordDecided = conflicts > 0 && conflicts == detailed && records.size() == detailed;
            if (conflicts > 0 && !confirmed && !everyRecordDecided) {
                undecided.add(t);
            }
            long take = records.values().stream().filter(TAKE_SOURCE::equals).count();
            takeSourceTotal += take;
            Map<String, Object> dm = new LinkedHashMap<>();
            dm.put("confirmed", confirmed || everyRecordDecided);
            dm.put("records", records);
            dm.put("takeSource", take);
            dm.put("keep", conflicts - take);
            decisions.put(t, dm);
        }
        if (!undecided.isEmpty()) {
            throw ApiException.validation("قبل التحقق قرر ما يُفعل بتعارضات: " + String.join("، ", undecided)
                    + " — إما تأكيد إبقاء السجلات الحالية للجدول أو قرار لكل سجل.", Map.of("undecided", undecided));
        }
        List<Map<String, Object>> plan = new ArrayList<>();
        List<Map<String, Object>> warnings = new ArrayList<>();
        Set<String> categories = new LinkedHashSet<>();
        for (String t : order) {
            Map<String, Object> p = byName.get(t);
            categories.add((String) p.get("category"));
            Map<String, Object> step = new LinkedHashMap<>();
            step.put("table", t);
            step.put("category", p.get("category"));
            step.put("newRows", p.get("newRows"));
            step.put("conflicts", p.get("conflicts"));
            step.put("takeSource", castMap(decisions.get(t)).get("takeSource"));
            step.put("dependsOn", p.get("dependsOn"));
            plan.add(step);
            for (Object o : (List<?>) p.get("dependsOn")) {
                String parent = (String) o;
                Map<String, Object> pp = byName.get(parent);
                if (!chosen.contains(parent) && pp != null && ((Number) pp.get("newRows")).longValue() > 0) {
                    Map<String, Object> w = new LinkedHashMap<>();
                    w.put("table", t);
                    w.put("references", parent);
                    w.put("newRows", pp.get("newRows"));
                    w.put("message", "الجدول «" + t + "» يشير إلى «" + parent + "» الذي لم يُختر وفيه " + pp.get("newRows")
                            + " صفاً جديداً؛ قد تحتاجها الصفوف الجديدة، وإلا يُرفض الترحيل كله ويُلغى.");
                    warnings.add(w);
                }
            }
        }
        Map<String, Object> selection = new LinkedHashMap<>();
        selection.put("tables", new ArrayList<>(chosen));
        selection.put("categories", new ArrayList<>(categories));
        selection.put("decisions", decisions);
        selection.put("takeSource", takeSourceTotal);
        selection.put("plan", plan);
        selection.put("warnings", warnings);
        jdbc.sql("update db_migration set state = 'VALIDATED', selection = cast(:s as jsonb) where id = :id")
                .param("s", json.write(selection)).param("id", id).update();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("tables", order);
        detail.put("categories", new ArrayList<>(categories));
        detail.put("decisions", decisions);
        detail.put("warnings", warnings.size());
        audit.recordAs(ctx.actor(), "DB_MIGRATION_VALIDATED", "SETTINGS", "db-migration/" + id, "مركز ترحيل قاعدة البيانات",
                detail, "اختيار الجداول وتقرير التعارضات والتحقق من الترتيب");
        return view(id);
    }

    /** Kahn's order over the chosen tables (parents first), ties alphabetical; a cycle among them is refused. */
    static List<String> order(Set<String> chosen, Map<String, Map<String, Object>> byName) {
        Map<String, Set<String>> parents = new TreeMap<>();
        Map<String, Set<String>> children = new HashMap<>();
        for (String t : chosen) {
            Set<String> ps = new TreeSet<>();
            for (Object o : (List<?>) byName.get(t).get("dependsOn")) {
                String p = (String) o;
                if (chosen.contains(p) && !p.equals(t)) {
                    ps.add(p);
                    children.computeIfAbsent(p, k -> new TreeSet<>()).add(t);
                }
            }
            parents.put(t, ps);
        }
        Deque<String> free = new ArrayDeque<>();
        for (Map.Entry<String, Set<String>> e : parents.entrySet()) {
            if (e.getValue().isEmpty()) {
                free.add(e.getKey());
            }
        }
        List<String> out = new ArrayList<>();
        while (!free.isEmpty()) {
            String t = free.poll();
            out.add(t);
            for (String c : children.getOrDefault(t, Set.of())) {
                Set<String> ps = parents.get(c);
                ps.remove(t);
                if (ps.isEmpty()) {
                    free.add(c);
                }
            }
        }
        if (out.size() != chosen.size()) {
            List<String> cycle = new ArrayList<>(chosen);
            cycle.removeAll(out);
            throw ApiException.validation("الجداول المختارة تعتمد على بعضها في حلقة ولا يمكن ترتيبها: " + String.join("، ", cycle));
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object o) {
        return (Map<String, Object>) o;
    }

    // ---- 3. the migration: the backup gate, the fingerprint check, one transaction of the current database --------------

    public Map<String, Object> migrate(AccessContext ctx, UUID id, Commit in) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> m = view(id);
        if (!"VALIDATED".equals(m.get("state"))) {
            throw ApiException.validation("تحقق من اختيار الجداول أولاً؛ ولا يُعاد ترحيل انتهى.");
        }
        // the backup gate
        DbMigrationBackups.Status backup = backups.status();
        boolean attested = in != null && Boolean.TRUE.equals(in.backupVerified());
        if (!backup.found() || !backup.current()) {
            throw ApiException.validation(backup.problem() == null ? "لا نسخة احتياطية حديثة." : backup.problem(), Map.of("backup", backup.asMap()));
        }
        if (!backup.verified() && !attested) {
            throw ApiException.validation("آخر نسخة احتياطية (" + backup.dir() + ") لم يُتحقق منها: شغّل sh ops/verify-backup.sh "
                    + backup.dir() + " ثم أكد نجاحه قبل الترحيل.", Map.of("backup", backup.asMap()));
        }
        Map<String, Object> stored = jdbc.sql("select secret_ciphertext, secret_key_id, source::text as source, source_schema_version from db_migration where id = :id")
                .param("id", id).query().listOfRows().getFirst();
        Map<String, Object> src = json.map((String) stored.get("source"));
        String password = cipher.decrypt((String) stored.get("secret_ciphertext"), (String) stored.get("secret_key_id"));
        Source s = new Source((String) src.getOrDefault("type", "CONNECTION"), (String) src.get("host"), ((Number) src.get("port")).intValue(),
                (String) src.get("database"), (String) src.get("username"), password, (String) src.get("schema"), (String) src.get("file"));
        int storedVersion = ((Number) stored.get("source_schema_version")).intValue();
        Map<String, Object> preview = castMap(m.get("preview"));
        Map<String, Object> selection = castMap(m.get("selection"));
        Map<String, Object> previewFingerprint = castMap(preview.get("fingerprint"));
        Map<String, Object> decisions = castMap(selection.get("decisions"));
        List<String> tables = new ArrayList<>();
        for (Object o : (List<?>) selection.get("plan")) {
            tables.add((String) castMap(o).get("table"));
        }
        Instant started = clock.instant();
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("startedAt", started.toString());
        Map<String, Object> backupUsed = backup.asMap();
        backupUsed.put("confirmedByAdministrator", attested);
        report.put("backup", backupUsed);
        List<Map<String, Object>> perTable = new ArrayList<>();
        Map<String, Object> commitFingerprint = new TreeMap<>();
        String failure = null;
        boolean fingerprintChanged = false;
        try (Connection source = open(s)) {
            Integer sv = flywayVersion(source, s.schema());
            if (sv == null || sv != storedVersion) {
                throw ApiException.validation("تغير إصدار مخطط المصدر منذ الفحص؛ افحص المصدر من جديد.");
            }
            writeTx.executeWithoutResult(status -> {
                Connection cur = DataSourceUtils.getConnection(dataSource);
                try {
                    textSettings(cur, true);
                    String curSchema = currentSchema(cur);
                    Side sourceSide = side(source, s.schema());
                    Side currentSide = side(cur, curSchema);
                    List<Edge> edges = foreignKeys(cur, curSchema);
                    Map<String, Shared> shared = new LinkedHashMap<>();
                    for (String t : tables) {
                        if (excludedReason(t, currentSide) != null || !sourceSide.tables().contains(t)
                                || !currentSide.primaryKeys().get(t).equals(sourceSide.primaryKeys().get(t))) {
                            throw ApiException.validation("الجدول «" + t + "» لم يعد مشتركاً بين القاعدتين؛ افحص المصدر من جديد.");
                        }
                        Shared sh = shared(t, sourceSide, currentSide, edges);
                        shared.put(t, sh);
                        Map<String, Object> now = fingerprint(source, s.schema(), sh);
                        commitFingerprint.put(t, now);
                        if (!json.canonical(previewFingerprint.get(t)).equals(json.canonical(now))) {
                            throw new FingerprintChanged("تغيرت بيانات المصدر منذ المعاينة (الجدول «" + t + "»)؛ افحص المصدر من جديد ثم أعد الاختيار.");
                        }
                    }
                    for (String t : tables) {
                        Map<String, String> records = new HashMap<>();
                        Object d = decisions.get(t);
                        if (d != null) {
                            for (Map.Entry<String, Object> e : castMap(castMap(d).get("records")).entrySet()) {
                                records.put(e.getKey(), String.valueOf(e.getValue()));
                            }
                        }
                        Scan scan = scan(source, s.schema(), cur, shared.get(t), true, records);
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("table", t);
                        row.put("category", DbMigrationCatalog.category(t));
                        row.put("sourceRows", scan.sourceRows());
                        row.put("inserted", scan.inserted());
                        row.put("updated", scan.updated());
                        row.put("skipped", scan.sourceRows() - scan.inserted() - scan.updated());
                        row.put("conflicts", scan.conflicts());
                        row.put("identical", scan.identical());
                        row.put("conflictSamples", scan.conflictSamples());
                        perTable.add(row);
                    }
                    report.put("ok", true);
                    report.put("tables", perTable);
                    report.put("fingerprint", commitFingerprint);
                    report.put("finishedAt", clock.instant().toString());
                    jdbc.sql("update db_migration set state = 'MIGRATED', report = cast(:r as jsonb), finished_at = :now where id = :id")
                            .param("r", json.write(report)).param("now", Db.ts(clock.instant())).param("id", id).update();
                } catch (SQLException e) {
                    throw new IllegalStateException(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), e);
                }
            });
        } catch (FingerprintChanged e) {
            fingerprintChanged = true;
            failure = e.getMessage();
        } catch (ApiException e) {
            failure = e.getMessage();
        } catch (SQLException e) {
            failure = unavailable(e).getMessage();
        } catch (RuntimeException e) {
            log.warn("Database migration {} failed and was rolled back: {}", id, e.toString());
            failure = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        }
        if (failure != null) {
            if (failure.length() > 600) {
                failure = failure.substring(0, 600) + "…";
            }
            report.put("ok", false);
            report.put("error", failure);
            report.put("fingerprintChanged", fingerprintChanged);
            report.put("tables", perTable);
            report.put("fingerprint", commitFingerprint);
            report.put("finishedAt", clock.instant().toString());
            jdbc.sql("update db_migration set state = 'FAILED', report = cast(:r as jsonb), finished_at = :now where id = :id")
                    .param("r", json.write(report)).param("now", Db.ts(clock.instant())).param("id", id).update();
        }
        if ("DUMP".equals(s.type())) {
            dumps.drop(s.database());
        }
        long inserted = 0;
        long updated = 0;
        long conflicts = 0;
        for (Map<String, Object> row : perTable) {
            inserted += (Long) row.get("inserted");
            updated += (Long) row.get("updated");
            conflicts += (Long) row.get("conflicts");
        }
        Map<String, Object> detail = new LinkedHashMap<>(asSource(s));
        detail.put("ok", failure == null);
        detail.put("sourceVersion", storedVersion);
        detail.put("fingerprint", failure == null ? commitFingerprint : previewFingerprint);
        detail.put("categories", selection.get("categories"));
        detail.put("tables", tables);
        detail.put("decisions", decisions);
        detail.put("inserted", inserted);
        detail.put("updated", updated);
        detail.put("conflicts", conflicts);
        detail.put("backup", backupUsed);
        detail.put("startedAt", started.toString());
        detail.put("finishedAt", report.get("finishedAt"));
        if (failure != null) {
            detail.put("error", failure);
        }
        audit.recordAs(ctx.actor(), "DB_MIGRATION_RUN", "SETTINGS", "db-migration/" + id, "مركز ترحيل قاعدة البيانات", detail,
                failure == null ? "ترحيل الصفوف الجديدة من قاعدة قديمة وتطبيق قرارات التعارض" : "فشل الترحيل وأُلغي كله");
        return view(id);
    }

    /** A preview or validation given up: its staging database (a dump source) is dropped and the row recorded as FAILED. */
    public Map<String, Object> abandon(AccessContext ctx, UUID id) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> m = view(id);
        String state = (String) m.get("state");
        if (!"PREVIEWED".equals(state) && !"VALIDATED".equals(state)) {
            return m;
        }
        Map<String, Object> source = castMap(m.get("source"));
        if ("DUMP".equals(source.get("type"))) {
            dumps.drop((String) source.get("database"));
        }
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("ok", false);
        report.put("error", "أُلغي قبل الترحيل.");
        report.put("finishedAt", clock.instant().toString());
        jdbc.sql("update db_migration set state = 'FAILED', report = cast(:r as jsonb), finished_at = :now where id = :id")
                .param("r", json.write(report)).param("now", Db.ts(clock.instant())).param("id", id).update();
        audit.recordAs(ctx.actor(), "DB_MIGRATION_ABANDONED", "SETTINGS", "db-migration/" + id, "مركز ترحيل قاعدة البيانات",
                asSourceMap(source), "إلغاء ترحيل قبل تنفيذه");
        return view(id);
    }

    private static Map<String, Object> asSourceMap(Map<String, Object> source) {
        Map<String, Object> m = new LinkedHashMap<>(source);
        m.remove("password");
        return m;
    }

    private static final class FingerprintChanged extends RuntimeException {
        FingerprintChanged(String message) {
            super(message);
        }
    }
}
