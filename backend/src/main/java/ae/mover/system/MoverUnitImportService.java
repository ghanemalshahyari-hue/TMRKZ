package ae.mover.system;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;

/**
 * ADR-097 «استيراد وحدات MOVER»: reads the {@code units} table of an uploaded MOVER SQLite database and brings those
 * rows into TMRKZ's {@code organization} tree. Idempotent by the pair {@code (source='MOVER', source_external_id=<MOVER
 * unit id>)}; on re-import a row that is already there is NEVER changed by default and is reported as a conflict only.
 *
 * <p>MOVER schema:
 * <pre>units(id integer primary key, name varchar, parent_unit_id integer references units(id), level integer,
 *       hr_unit_id integer unique, hr_source varchar, hr_status integer, hr_synced_at datetime,
 *       manager_id integer, is_final_command boolean, unit_operations_approval_unit_id integer, display_alias varchar)</pre>
 *
 * <p>TMRKZ organization: {@code (id uuid pk, code text unique, name text, parent_id uuid fk, status, valid_from,
 * source text check in ('LOCAL','HR','MOVER'), source_external_id text)} — V65 added {@code 'MOVER'} to the check.
 *
 * <p>The SQLite file lives in the migration inbox. It is opened read-only through the xerial sqlite-jdbc driver; the
 * database file is never modified. The import runs in a Spring transaction so either every chosen unit lands or none
 * does. CONFIGURE is required; the request is audited as {@code MOVER_UNITS_IMPORTED} with the counts and the file
 * SHA-256, and per-unit conflicts are recorded with {@code MOVER_UNIT_CONFLICT_SKIPPED}.
 */
@Service
public class MoverUnitImportService {

    private static final Logger log = LoggerFactory.getLogger(MoverUnitImportService.class);

    private final JdbcClient jdbc;
    private final AuditService audit;
    private final DbMigrationDump dumps;
    private final TransactionTemplate tx;

    public MoverUnitImportService(JdbcClient jdbc, AuditService audit, DbMigrationDump dumps,
                                  PlatformTransactionManager ptm) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.dumps = dumps;
        this.tx = new TransactionTemplate(ptm);
    }

    /** One MOVER unit as read from the SQLite file, before any TMRKZ decision. */
    public record SourceUnit(long id, String name, Long parentId, Integer level, Long hrUnitId, Integer hrStatus,
                             String displayAlias) {
        String code() {
            return hrUnitId != null ? "MOVER-HR-" + hrUnitId : "MOVER-U-" + id;
        }
        /** hr_status=1 ACTIVE · hr_status=0 (or any other explicit non-1 value) RETIRED · NULL "no HR info" treated as
         *  ACTIVE, since the older MOVER schema added hr_status after the fact and left it NULL for existing rows. */
        String status() {
            if (hrStatus == null) return "ACTIVE";
            return hrStatus == 1 ? "ACTIVE" : "RETIRED";
        }
    }

    /** A per-row verdict after joining a MOVER unit against TMRKZ's current state. */
    public record Verdict(long moverId, String code, String name, Long parentMoverId, int level, String status,
                          String category) {
        /** Categories: NEW (would insert), EXISTING (same row already; nothing to do), CODE_CONFLICT (another
         *  unit holds this code), PARENT_MISSING (parent_unit_id refers to a unit not in this import nor in
         *  TMRKZ), CYCLE (import or TMRKZ would hold a cycle). */
    }

    public record Preview(String file, int total, int newCount, int existingCount, int conflictCount,
                          List<Verdict> rows) {
    }

    public record CommitResult(String file, int created, int skipped, int existing, List<String> conflicts) {
    }

    /** Reads the SQLite file in the inbox and returns the per-row verdict against current TMRKZ. No writes. */
    public Preview preview(AccessContext ctx, String fileName) {
        ctx.require(Permission.CONFIGURE);
        Path dbFile = inboxFile(fileName);
        List<SourceUnit> source = readMoverUnits(dbFile);
        Map<String, Map<String, Object>> existingByExternalId = currentByExternalId();
        Map<String, Map<String, Object>> existingByCode = currentByCode();

        List<Verdict> rows = new ArrayList<>(source.size());
        int newCount = 0, existing = 0, conflicts = 0;
        for (SourceUnit u : source) {
            String category;
            Map<String, Object> sameExt = existingByExternalId.get(String.valueOf(u.id()));
            Map<String, Object> sameCode = existingByCode.get(u.code());
            if (sameExt != null) {
                category = "EXISTING";
                existing++;
            } else if (sameCode != null) {
                category = "CODE_CONFLICT";
                conflicts++;
            } else {
                category = "NEW";
                newCount++;
            }
            rows.add(new Verdict(u.id(), u.code(), u.name(), u.parentId(), u.level() == null ? 0 : u.level(),
                    u.status(), category));
        }
        return new Preview(fileName, source.size(), newCount, existing, conflicts, rows);
    }

    /**
     * Writes every NEW row from the preview inside one transaction. EXISTING rows are left alone (idempotent).
     * CODE_CONFLICT rows are reported and audited; the administrator must resolve those by hand.
     */
    public CommitResult commit(AccessContext ctx, String fileName) {
        ctx.require(Permission.CONFIGURE);
        Path dbFile = inboxFile(fileName);
        String sha256 = sha256Of(dbFile);
        List<SourceUnit> source = readMoverUnits(dbFile);
        Preview p = preview(ctx, fileName);

        List<SourceUnit> toInsert = new ArrayList<>();
        List<String> conflicts = new ArrayList<>();
        Map<Long, Verdict> byId = new HashMap<>();
        for (Verdict v : p.rows()) byId.put(v.moverId(), v);
        for (SourceUnit u : source) {
            Verdict v = byId.get(u.id());
            if (v == null) continue;
            if ("NEW".equals(v.category())) toInsert.add(u);
            else if ("CODE_CONFLICT".equals(v.category())) conflicts.add(v.code() + " ← " + v.name());
        }

        // Topological: parents before children so parent_id FK is satisfied. MOVER's units table has a cycle check
        // via FK but no guarantee of insertion order here; the sort walks parent chains until every chosen row is
        // placed or the input has an unresolvable parent for an EXISTING row (which is fine — we read its UUID).
        List<SourceUnit> ordered = topologicalOrder(toInsert);

        Map<Long, java.util.UUID> moverToUuid = new HashMap<>();
        // seed with every already-imported MOVER unit so children inserted here can reference them
        for (Map<String, Object> row : currentByExternalId().values()) {
            moverToUuid.put(Long.valueOf((String) row.get("source_external_id")), (java.util.UUID) row.get("id"));
        }

        int inserted = tx.execute(status -> {
            int n = 0;
            for (SourceUnit u : ordered) {
                java.util.UUID parent = null;
                if (u.parentId() != null) {
                    parent = moverToUuid.get(u.parentId());
                    // A parent not in MOVER-sourced TMRKZ rows is left null; the admin can rewire manually.
                }
                java.util.UUID id = jdbc.sql("""
                        insert into organization(id, code, name, parent_id, status, source, source_external_id)
                        values (gen_random_uuid(), :c, :n, :p, :s, 'MOVER', :ext)
                        returning id""")
                        .param("c", u.code())
                        .param("n", u.name())
                        .param("p", parent)
                        .param("s", u.status())
                        .param("ext", String.valueOf(u.id()))
                        .query(java.util.UUID.class).single();
                moverToUuid.put(u.id(), id);
                n++;
            }
            for (String c : conflicts) {
                audit.system("MOVER_UNIT_CONFLICT_SKIPPED", "ORGANIZATION", c, null, Map.of("file", fileName));
            }
            audit.system("MOVER_UNITS_IMPORTED", "DB_MIGRATION", sha256, fileName,
                    Map.of("file", fileName, "sha256", sha256, "created", n,
                            "existing", p.existingCount(), "conflicts", conflicts.size()));
            log.info("MOVER units import: {} created, {} existing, {} conflicts from {} (sha256={})",
                    n, p.existingCount(), conflicts.size(), fileName, sha256);
            return n;
        });
        return new CommitResult(fileName, inserted, conflicts.size(), p.existingCount(), conflicts);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------

    private Path inboxFile(String fileName) {
        if (fileName == null || fileName.isBlank()) {
            throw ApiException.validation("اسم الملف مطلوب.");
        }
        Path p = dumps.inbox().resolve(fileName).normalize();
        if (!p.startsWith(dumps.inbox()) || !Files.isRegularFile(p)) {
            throw ApiException.validation("الملف غير موجود في مجلد الترحيل.");
        }
        try {
            DbMigrationDump.Info info = DbMigrationDump.inspect(p);
            if (info.kind() != DbMigrationDump.Kind.SQLITE) {
                throw ApiException.validation(
                        "الملف ليس قاعدة SQLite — استيراد وحدات MOVER يقبل ملف SQLite فقط (الملف الحالي: " + info.kind() + ").");
            }
        } catch (java.io.IOException e) {
            throw ApiException.validation("تعذر فحص الملف: " + e.getMessage());
        }
        return p;
    }

    private static String sha256Of(Path p) {
        try {
            return DbMigrationDump.inspect(p).sha256();
        } catch (java.io.IOException e) {
            throw ApiException.validation("تعذر حساب بصمة الملف: " + e.getMessage());
        }
    }

    private static List<SourceUnit> readMoverUnits(Path dbFile) {
        String url = "jdbc:sqlite:" + dbFile.toAbsolutePath();
        List<SourceUnit> out = new ArrayList<>();
        try {
            Class.forName("org.sqlite.JDBC");
        } catch (ClassNotFoundException e) {
            throw new IllegalStateException("sqlite-jdbc not on the classpath", e);
        }
        try (Connection c = DriverManager.getConnection(url)) {
            try (Statement s = c.createStatement()) {
                s.execute("PRAGMA query_only = true");
            }
            try (Statement s = c.createStatement();
                 ResultSet rs = s.executeQuery("select name from sqlite_master where type='table' and name='units'")) {
                if (!rs.next()) {
                    throw ApiException.validation("قاعدة SQLite لا تحتوي جدول units — ليست قاعدة MOVER.");
                }
            }
            // MOVER has evolved its units schema over releases. Discover the columns actually present and ask only
            // for those; required (id, name, parent_unit_id) are checked, optional (level, hr_unit_id, hr_status,
            // display_alias) fall back to null if absent. This lets the importer accept both the current MOVER
            // SQLite and older snapshots (e.g. transport_requests.2026-10-15-pre-untrack.db).
            java.util.Set<String> columns = new java.util.HashSet<>();
            try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery("PRAGMA table_info(units)")) {
                while (rs.next()) {
                    columns.add(rs.getString("name"));
                }
            }
            for (String required : List.of("id", "name", "parent_unit_id")) {
                if (!columns.contains(required)) {
                    throw ApiException.validation(
                            "قاعدة SQLite لا تحتوي عمود " + required + " في جدول units — ليست قاعدة MOVER بشكل كامل.");
                }
            }
            boolean hasLevel = columns.contains("level");
            boolean hasHrId = columns.contains("hr_unit_id");
            boolean hasHrStatus = columns.contains("hr_status");
            boolean hasAlias = columns.contains("display_alias");
            StringBuilder select = new StringBuilder("select id, name, parent_unit_id");
            if (hasLevel) select.append(", level"); else select.append(", null as level");
            if (hasHrId) select.append(", hr_unit_id"); else select.append(", null as hr_unit_id");
            if (hasHrStatus) select.append(", hr_status"); else select.append(", null as hr_status");
            if (hasAlias) select.append(", display_alias"); else select.append(", null as display_alias");
            select.append(" from units order by id");
            try (PreparedStatement ps = c.prepareStatement(select.toString());
                 ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    long id = rs.getLong("id");
                    String name = rs.getString("name");
                    long parent = rs.getLong("parent_unit_id");
                    boolean parentNull = rs.wasNull();
                    int level = rs.getInt("level");
                    boolean levelNull = rs.wasNull();
                    long hr = rs.getLong("hr_unit_id");
                    boolean hrNull = rs.wasNull();
                    int hrStatus = rs.getInt("hr_status");
                    boolean hrStatusNull = rs.wasNull();
                    String alias = rs.getString("display_alias");
                    out.add(new SourceUnit(id, name, parentNull ? null : parent, levelNull ? null : level,
                            hrNull ? null : hr, hrStatusNull ? null : hrStatus, alias));
                }
            }
        } catch (SQLException e) {
            throw ApiException.validation("تعذر قراءة units من ملف SQLite: " + e.getMessage());
        }
        return out;
    }

    private Map<String, Map<String, Object>> currentByExternalId() {
        Map<String, Map<String, Object>> m = new LinkedHashMap<>();
        for (Map<String, Object> row : jdbc.sql(
                "select id, code, name, parent_id, source_external_id from organization where source = 'MOVER' and source_external_id is not null")
                .query().listOfRows()) {
            m.put(Objects.toString(row.get("source_external_id")), row);
        }
        return m;
    }

    private Map<String, Map<String, Object>> currentByCode() {
        Map<String, Map<String, Object>> m = new LinkedHashMap<>();
        for (Map<String, Object> row : jdbc.sql("select id, code, name, source from organization").query().listOfRows()) {
            m.put(Objects.toString(row.get("code")), row);
        }
        return m;
    }

    /** Parents before children, for the rows that will be inserted. */
    private static List<SourceUnit> topologicalOrder(List<SourceUnit> toInsert) {
        Map<Long, SourceUnit> byId = new HashMap<>();
        for (SourceUnit u : toInsert) byId.put(u.id(), u);
        List<SourceUnit> out = new ArrayList<>();
        java.util.Set<Long> placed = new java.util.HashSet<>();
        for (SourceUnit u : toInsert) place(u, byId, placed, out);
        return out;
    }
    private static void place(SourceUnit u, Map<Long, SourceUnit> byId, java.util.Set<Long> placed,
                              List<SourceUnit> out) {
        if (!placed.add(u.id())) return;
        if (u.parentId() != null) {
            SourceUnit parent = byId.get(u.parentId());
            if (parent != null) place(parent, byId, placed, out);
        }
        out.add(u);
    }
}
