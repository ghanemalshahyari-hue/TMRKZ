package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import ae.mover.system.DbMigrationDump;

/**
 * ADR-097: a MOVER-shaped SQLite file placed in the migration inbox is detected, previewed and imported into TMRKZ's
 * organization tree. Idempotent: a second import of the same file creates no new rows. Only CONFIGURE sees the
 * endpoints.
 */
class MoverUnitImportIT extends IntegrationTest {

    @Autowired
    DbMigrationDump dumps;

    @Test
    @DisplayName("MOVER SQLite units land in organization with source='MOVER'; re-import is a no-op")
    void importMoverUnits() throws Exception {
        Path db = dumps.inbox().resolve("mover-units-it-" + sfx + ".db");
        Files.deleteIfExists(db);
        buildMoverSqlite(db);

        DbMigrationDump.Info info = DbMigrationDump.inspect(db);
        assertThat(info.kind()).isEqualTo(DbMigrationDump.Kind.SQLITE);

        UUID org = org("IMP-ROOT", null);
        person("imp-admin", "SYSTEM_ADMIN", org);
        Api api = login("imp-admin");

        Res p1 = api.post("/settings/db-migration/mover-units/preview", Map.of("file", db.getFileName().toString()));
        assertThat(p1.status()).isEqualTo(200);
        assertThat(p1.body().path("total").asInt()).isEqualTo(4);
        assertThat(p1.body().path("newCount").asInt()).isEqualTo(4);
        assertThat(p1.body().path("existingCount").asInt()).isZero();
        assertThat(p1.body().path("conflictCount").asInt()).isZero();

        Res c1 = api.post("/settings/db-migration/mover-units/commit", Map.of("file", db.getFileName().toString()));
        assertThat(c1.status()).isEqualTo(200);
        assertThat(c1.body().path("created").asInt()).isEqualTo(4);

        List<String> codes = jdbc.sql(
                "select code from organization where source = 'MOVER' and source_external_id in ('101','102','110','199') order by code")
                .query(String.class).list();
        assertThat(codes).containsExactly("MOVER-HR-100000", "MOVER-HR-100001", "MOVER-HR-100002", "MOVER-U-199");

        String rootName = jdbc.sql("select name from organization where code = 'MOVER-HR-100000'")
                .query(String.class).single();
        assertThat(rootName).isEqualTo("Level 1 (تجريبي)");

        String orphanParent = jdbc.sql("""
                select p.code from organization c join organization p on p.id = c.parent_id
                 where c.code = 'MOVER-U-199'""").query(String.class).single();
        assertThat(orphanParent).isEqualTo("MOVER-HR-100001");

        // Idempotency.
        Res p2 = api.post("/settings/db-migration/mover-units/preview", Map.of("file", db.getFileName().toString()));
        assertThat(p2.body().path("newCount").asInt()).isZero();
        assertThat(p2.body().path("existingCount").asInt()).isEqualTo(4);
        Res c2 = api.post("/settings/db-migration/mover-units/commit", Map.of("file", db.getFileName().toString()));
        assertThat(c2.body().path("created").asInt()).isZero();

        Long audits = jdbc.sql("select count(*) from audit_event where action = 'MOVER_UNITS_IMPORTED'")
                .query(Long.class).single();
        assertThat(audits).isGreaterThanOrEqualTo(2L);
    }

    @Test
    @DisplayName("A pg_dump file is rejected by the MOVER unit-import endpoint (it is the other source type)")
    void rejectPgDumpFile() throws Exception {
        Path dump = dumps.inbox().resolve("not-a-sqlite-" + sfx + ".dump");
        Files.write(dump, "PGDMP\u0001test".getBytes());

        UUID org = org("IMP-ROOT-2", null);
        person("imp-admin-2", "SYSTEM_ADMIN", org);
        Api api = login("imp-admin-2");

        Res r = api.post("/settings/db-migration/mover-units/preview",
                Map.of("file", dump.getFileName().toString()));
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.body().path("message").asText()).contains("ليس قاعدة SQLite");
    }

    @Test
    @DisplayName("A SQLite file without a units table is rejected with the expected Arabic message")
    void rejectSqliteWithoutUnits() throws Exception {
        Path db = dumps.inbox().resolve("wrong-schema-" + sfx + ".db");
        Files.deleteIfExists(db);
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement s = c.createStatement()) {
            s.execute("create table other(x integer)");
        }

        UUID org = org("IMP-ROOT-3", null);
        person("imp-admin-3", "SYSTEM_ADMIN", org);
        Api api = login("imp-admin-3");

        Res r = api.post("/settings/db-migration/mover-units/preview",
                Map.of("file", db.getFileName().toString()));
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.body().path("message").asText()).contains("لا تحتوي جدول units");
    }

    @Test
    @DisplayName("Older MOVER schema without display_alias and with NULL hr_status is accepted (status defaults to ACTIVE)")
    void acceptsOlderSchema() throws Exception {
        Path db = dumps.inbox().resolve("mover-old-" + sfx + ".db");
        Files.deleteIfExists(db);
        String url = "jdbc:sqlite:" + db.toAbsolutePath();
        Class.forName("org.sqlite.JDBC");
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(url); java.sql.Statement s = c.createStatement()) {
            // Mirrors the pre-untrack schema: no display_alias; hr_status column exists but every row has it NULL.
            s.execute("""
                    create table units (
                      id INTEGER NOT NULL,
                      name VARCHAR(128) NOT NULL,
                      parent_unit_id INTEGER,
                      level INTEGER,
                      manager_id INTEGER,
                      is_final_command BOOLEAN,
                      unit_operations_approval_unit_id INTEGER,
                      hr_unit_id INTEGER,
                      hr_source VARCHAR(8),
                      hr_status INTEGER,
                      hr_synced_at DATETIME,
                      PRIMARY KEY (id),
                      FOREIGN KEY(parent_unit_id) REFERENCES units (id))""");
            s.execute("insert into units(id, name, parent_unit_id, level, hr_unit_id) values " +
                    "(1, 'Old Root', null, 0, 500000)," +
                    "(2, 'Old Child', 1, 1, 500001)");
        }

        UUID org = org("IMP-OLD", null);
        person("imp-admin-old", "SYSTEM_ADMIN", org);
        Api api = login("imp-admin-old");

        Res p = api.post("/settings/db-migration/mover-units/preview", Map.of("file", db.getFileName().toString()));
        assertThat(p.status()).isEqualTo(200);
        assertThat(p.body().path("total").asInt()).isEqualTo(2);

        Res c = api.post("/settings/db-migration/mover-units/commit", Map.of("file", db.getFileName().toString()));
        assertThat(c.status()).isEqualTo(200);

        List<String> statuses = jdbc.sql(
                "select status from organization where code in ('MOVER-HR-500000','MOVER-HR-500001') order by code")
                .query(String.class).list();
        assertThat(statuses).containsExactly("ACTIVE", "ACTIVE");
    }

    @Test
    @DisplayName("A person without CONFIGURE cannot call the MOVER unit-import endpoints")
    void requireConfigure() throws Exception {
        Path db = dumps.inbox().resolve("perm-check-" + sfx + ".db");
        Files.deleteIfExists(db);
        buildMoverSqlite(db);

        UUID org = org("IMP-ROOT-4", null);
        person("imp-viewer", role("IMP_V", "ORGANIZATION", "VIEW"), org);
        Api api = login("imp-viewer");

        Res r = api.post("/settings/db-migration/mover-units/preview",
                Map.of("file", db.getFileName().toString()));
        assertThat(r.status()).isEqualTo(403);
    }

    // ---- helpers -------------------------------------------------------------------------------------------

    private static void buildMoverSqlite(Path dbFile) throws Exception {
        String url = "jdbc:sqlite:" + dbFile.toAbsolutePath();
        Class.forName("org.sqlite.JDBC");
        try (Connection c = DriverManager.getConnection(url); Statement s = c.createStatement()) {
            s.execute("""
                    create table units (
                      id INTEGER NOT NULL,
                      name VARCHAR(128) NOT NULL,
                      parent_unit_id INTEGER,
                      level INTEGER,
                      hr_unit_id INTEGER,
                      hr_source VARCHAR(8) DEFAULT 'LOCAL' NOT NULL,
                      hr_status INTEGER,
                      hr_synced_at DATETIME,
                      manager_id INTEGER,
                      is_final_command BOOLEAN DEFAULT '0' NOT NULL,
                      unit_operations_approval_unit_id INTEGER,
                      display_alias VARCHAR(64),
                      PRIMARY KEY (id),
                      FOREIGN KEY(parent_unit_id) REFERENCES units (id))""");
            // MOVER ids chosen to not overlap with acceptsOlderSchema's ids (1, 2): source_external_id is the MOVER id
            // and the IntegrationTest's shared Postgres carries rows between test methods.
            s.execute("insert into units(id, name, parent_unit_id, level, hr_unit_id, hr_status) values (101, 'Level 1 (تجريبي)', null, 0, 100000, 1)");
            s.execute("insert into units(id, name, parent_unit_id, level, hr_unit_id, hr_status) values (102, 'Level 2-1', 101, 1, 100001, 1)");
            s.execute("insert into units(id, name, parent_unit_id, level, hr_unit_id, hr_status) values (110, 'Level 2-2', 101, 1, 100002, 1)");
            s.execute("insert into units(id, name, parent_unit_id, level, hr_unit_id, hr_status) values (199, 'Orphan (no HR id)', 102, 2, null, 1)");
        }
    }
}
