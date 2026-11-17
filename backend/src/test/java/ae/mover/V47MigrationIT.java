package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * V47 on lineage that already exists: a separate database on the throw-away test server is migrated to V46 (after the
 * committed V45 access_grants_per_role and V46 system-administrator re-stationing right), given a pre-V47 Oracle-sync
 * snapshot, then migrated only V46 to V47, checked with ops/sql/checks/V47-after.sql and dropped. No other database is
 * touched. (Drafted as V45 directly after V44; renumbered V47.) PREVIEWED is
 * distinct from the STAGING status targeted by hourly cleanup; publication promotes the same staged unit snapshot.
 * Carrying people forward is application-service behaviour, not something this schema-only test or migration performs.
 * Publishing the file fixture proves only these database constraints, never live Oracle connectivity.
 */
class V47MigrationIT {

    private static final String URL = env("MOVER_TEST_DB_URL", "jdbc:postgresql://localhost:5433/mover_test");
    private static final String USER = env("MOVER_TEST_DB_USER", "mover");
    private static final String PASSWORD = env("MOVER_TEST_DB_PASSWORD", "devpass");

    private static String env(String name, String fallback) {
        String v = System.getenv(name);
        return v == null || v.isBlank() ? fallback : v;
    }

    private static Flyway flyway(String url, String target) {
        return Flyway.configure().dataSource(url, USER, PASSWORD).locations("classpath:db/migration").target(target).load();
    }

    private static String previewRun(UUID id, UUID snapshot, UUID carried, UUID previewer, String sha256) {
        return """
                insert into oracle_unit_import_run(
                  id, storage_key, payload_sha256, payload_size, schema_version, source_name, source_synced_at,
                  source_contract, structure_fingerprint, snapshot_id, carried_person_snapshot_id, previewed_by,
                  preview_expires_at, reason, status)
                values ('%s', 'internal/v47/%s', '%s', 128, '1.0', 'Oracle-derived migration fixture',
                        '2026-11-10T04:17:08Z', '{}'::jsonb, 'fixture-structure', '%s', '%s', '%s',
                        now() + interval '1 hour', 'authorised migration integrity test', 'PREVIEWED')
                """.formatted(id, id, sha256, snapshot, carried, previewer);
    }

    /** Runs every statement of ops/sql/checks/V47-after.sql; each returns one {@code name=value} row. */
    private static Map<String, String> afterChecks(Statement s) throws SQLException {
        String script;
        try {
            script = Files.readString(Path.of("../ops/sql/checks/V47-after.sql"));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        Map<String, String> out = new LinkedHashMap<>();
        StringBuilder sql = new StringBuilder();
        for (String line : script.split("\\R")) {
            if (!line.trim().startsWith("--")) {
                sql.append(line).append('\n');
            }
        }
        for (String statement : sql.toString().split(";")) {
            if (statement.isBlank()) {
                continue;
            }
            try (ResultSet rs = s.executeQuery(statement)) {
                assertThat(rs.next()).as(statement).isTrue();
                String[] pair = rs.getString(1).split("=", 2);
                out.put(pair[0], pair[1]);
            }
        }
        return out;
    }

    @Test
    @DisplayName("V47-1: V46 lineage upgrades, sync defaults still work, and owned unit previews publish only once")
    void upgradeAndPreviewLifecycle() throws SQLException {
        String db = "mover_v47_probe_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String url = URL.substring(0, URL.lastIndexOf('/') + 1) + db;
        try (Connection server = DriverManager.getConnection(URL, USER, PASSWORD); Statement s = server.createStatement()) {
            s.execute("create database " + db);
        }
        UUID person = UUID.randomUUID();
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        UUID oldSnapshot = UUID.randomUUID();
        try {
            flyway(url, "46").migrate();
            try (Connection c = DriverManager.getConnection(url, USER, PASSWORD); Statement s = c.createStatement()) {
                s.execute("insert into person(id, employee_no, display_name, username) values ('" + person
                        + "', 'V47-PERSON', 'Migration previewer', 'v47-previewer')");
                s.execute("insert into hr_source(id, name) values ('" + source + "', 'V47 source')");
                s.execute("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values ('"
                        + mapping + "', '" + source + "', 1, 'PUBLISHED', '[]'::jsonb, '{}'::jsonb)");
                s.execute("insert into hr_sync_run(id, source_id, mapping_version_id, trigger, requested_by, status, started_at) "
                        + "values ('" + run + "', '" + source + "', '" + mapping + "', 'SCHEDULED', '" + person
                        + "', 'SUCCEEDED', now())");
                // The exact lineage available at V46; no origin column is supplied because it does not exist yet.
                s.execute("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values ('"
                        + oldSnapshot + "', '" + run + "', '" + mapping + "', 'PUBLISHED', now())");
            }

            try (Connection c = DriverManager.getConnection(url, USER, PASSWORD); Statement s = c.createStatement()) {
                Map<String, String> before = new LinkedHashMap<>();
                try (ResultSet rs = s.executeQuery("select version, description from flyway_schema_history "
                        + "where version in ('44', '45', '46', '47') order by installed_rank")) {
                    while (rs.next()) {
                        before.put(rs.getString(1), rs.getString(2));
                    }
                }
                assertThat(before).as("V47 runs on top of the committed V45 and V46, not directly after V44")
                        .containsExactly(Map.entry("44", "employment context"), Map.entry("45", "access grants per role"),
                                Map.entry("46", "system admin restationing request"));
            }

            assertThat(flyway(url, "47").migrate().migrationsExecuted).as("only V47 is applied").isEqualTo(1);
            try (Connection c = DriverManager.getConnection(url, USER, PASSWORD); Statement s = c.createStatement()) {
                assertThat(afterChecks(s)).as("ops/sql/checks/V47-after.sql on upgraded lineage")
                        .containsEntry("snapshot_origin", "1").containsEntry("nullable_snapshot_lineage", "2")
                        .containsEntry("snapshot_lineage_violations", "0").containsEntry("snapshot_guards", "3")
                        .containsEntry("preview_status_guard", "1").containsEntry("unit_import_table", "1")
                        .containsEntry("unit_import_columns", "21").containsEntry("unit_import_defaults", "2")
                        .containsEntry("unit_import_guards", "6").containsEntry("unit_import_foreign_keys", "4")
                        .containsEntry("unit_import_primary_key", "1").containsEntry("one_run_per_snapshot", "1")
                        .containsEntry("unit_import_indexes", "2").containsEntry("published_payload_unique", "1")
                        .containsEntry("mismatches", "0");
                try (ResultSet rs = s.executeQuery("select origin, run_id, mapping_version_id from hr_snapshot where id = '"
                        + oldSnapshot + "'")) {
                    rs.next();
                    assertThat(rs.getString(1)).as("existing V46 lineage").isEqualTo("ORACLE_SYNC");
                    assertThat(rs.getObject(2)).isNotNull();
                    assertThat(rs.getObject(3)).isNotNull();
                }

                // HrSyncService's existing insert omits origin and must continue to work through its default.
                UUID syncSnapshot = UUID.randomUUID();
                s.execute("insert into hr_snapshot(id, run_id, mapping_version_id, status) values ('" + syncSnapshot
                        + "', '" + run + "', '" + mapping + "', 'STAGING')");
                try (ResultSet rs = s.executeQuery("select origin from hr_snapshot where id = '" + syncSnapshot + "'")) {
                    rs.next();
                    assertThat(rs.getString(1)).isEqualTo("ORACLE_SYNC");
                }

                UUID previewSnapshot = UUID.randomUUID();
                s.execute("insert into hr_snapshot(id, origin, status) values ('" + previewSnapshot
                        + "', 'ORACLE_UNIT_IMPORT', 'PREVIEWED')");
                s.execute("insert into hr_unit(snapshot_id, external_id, name, active) values ('" + previewSnapshot
                        + "', 'V47-UNIT', 'Preview unit', true)");
                try (ResultSet rs = s.executeQuery("select origin, run_id, mapping_version_id, status from hr_snapshot where id = '"
                        + previewSnapshot + "'")) {
                    rs.next();
                    assertThat(rs.getString(1)).isEqualTo("ORACLE_UNIT_IMPORT");
                    assertThat(rs.getObject(2)).isNull();
                    assertThat(rs.getObject(3)).isNull();
                    assertThat(rs.getString(4)).isEqualTo("PREVIEWED");
                }

                assertThatThrownBy(() -> s.execute("insert into hr_snapshot(id, run_id, mapping_version_id, status) values ('"
                        + UUID.randomUUID() + "', null, '" + mapping + "', 'STAGING')"))
                        .as("ORACLE_SYNC without both lineage references is rejected")
                        .isInstanceOf(SQLException.class);
                assertThatThrownBy(() -> s.execute("insert into hr_snapshot(id, run_id, origin, status) values ('"
                        + UUID.randomUUID() + "', '" + run + "', 'ORACLE_UNIT_IMPORT', 'PREVIEWED')"))
                        .as("ORACLE_UNIT_IMPORT with sync lineage is rejected")
                        .isInstanceOf(SQLException.class);

                String payload = "a".repeat(64);
                UUID previewRun = UUID.randomUUID();
                s.execute(previewRun(previewRun, previewSnapshot, oldSnapshot, person, payload));
                try (ResultSet rs = s.executeQuery("select expected::text, reason from oracle_unit_import_run where id = '"
                        + previewRun + "'")) {
                    rs.next();
                    assertThat(rs.getString(1)).isEqualTo("{}");
                    assertThat(rs.getString(2)).isEqualTo("authorised migration integrity test");
                }

                // A repeat registered preview of unchanged bytes is allowed and owns a different preview snapshot.
                UUID repeatSnapshot = UUID.randomUUID();
                UUID repeatRun = UUID.randomUUID();
                s.execute("insert into hr_snapshot(id, origin, status) values ('" + repeatSnapshot
                        + "', 'ORACLE_UNIT_IMPORT', 'PREVIEWED')");
                s.execute(previewRun(repeatRun, repeatSnapshot, oldSnapshot, person, payload));

                // Even with another payload, a second run cannot take ownership of an existing preview snapshot.
                assertThatThrownBy(() -> s.execute(previewRun(UUID.randomUUID(), repeatSnapshot, oldSnapshot, person,
                        "b".repeat(64)))).as("one run owns each preview snapshot").isInstanceOf(SQLException.class);

                // Publication keeps the preview snapshot and its staged units. People are carried forward by the service.
                s.execute("update hr_snapshot set status = 'SUPERSEDED' where id = '" + oldSnapshot + "'");
                s.execute("update hr_snapshot set status = 'PUBLISHED', published_at = now() where id = '"
                        + previewSnapshot + "'");
                s.execute("update oracle_unit_import_run set status = 'PUBLISHED', committed_by = '" + person
                        + "', committed_at = now() where id = '" + previewRun + "'");
                try (ResultSet rs = s.executeQuery("select s.status, r.status, r.snapshot_id, "
                        + "(select count(*) from hr_unit where snapshot_id = s.id) from hr_snapshot s "
                        + "join oracle_unit_import_run r on r.snapshot_id = s.id where s.id = '" + previewSnapshot + "'")) {
                    rs.next();
                    assertThat(rs.getString(1)).isEqualTo("PUBLISHED");
                    assertThat(rs.getString(2)).isEqualTo("PUBLISHED");
                    assertThat(rs.getObject(3, UUID.class)).isEqualTo(previewSnapshot);
                    assertThat(rs.getLong(4)).isEqualTo(1);
                }

                assertThatThrownBy(() -> s.execute("update oracle_unit_import_run set status = 'PUBLISHED', committed_by = '"
                        + person + "', committed_at = now() where id = '" + repeatRun + "'"))
                        .as("one PUBLISHED run per payload hash").isInstanceOf(SQLException.class);
                try (ResultSet rs = s.executeQuery("select r.status, s.status from oracle_unit_import_run r "
                        + "join hr_snapshot s on s.id = r.snapshot_id where r.id = '" + repeatRun + "'")) {
                    rs.next();
                    assertThat(rs.getString(1)).isEqualTo("PREVIEWED");
                    assertThat(rs.getString(2)).isEqualTo("PREVIEWED");
                }
                assertThat(afterChecks(s)).as("the after-checks still hold once file snapshots exist")
                        .containsEntry("snapshot_lineage_violations", "0").containsEntry("mismatches", "0");
            }
        } finally {
            try (Connection server = DriverManager.getConnection(URL, USER, PASSWORD); Statement s = server.createStatement()) {
                s.execute("drop database if exists " + db + " with (force)");
            }
        }
    }
}
