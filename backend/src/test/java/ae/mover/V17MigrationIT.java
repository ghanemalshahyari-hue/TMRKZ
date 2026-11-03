package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * V17 (ADR-028) on execution steps that already exist: a separate database on the throw-away test server is migrated to
 * V16, given steps as earlier versions wrote them, then migrated to V17, and dropped. No other database is touched.
 */
class V17MigrationIT {

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

    @Test
    @DisplayName("V17-1: existing steps take their purpose from their key; later inserts without it get TASK; unknown values are refused")
    void backfill() throws SQLException {
        String db = "mover_v17_probe_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String url = URL.substring(0, URL.lastIndexOf('/') + 1) + db;
        try (Connection server = DriverManager.getConnection(URL, USER, PASSWORD); Statement s = server.createStatement()) {
            s.execute("create database " + db);
        }
        try {
            flyway(url, "16").migrate();
            try (Connection c = DriverManager.getConnection(url, USER, PASSWORD); Statement s = c.createStatement()) {
                // rows as V16-era code wrote them; their request, role and organisation rows are not needed for this check
                s.execute("set session_replication_role = replica");
                for (String key : new String[] {"handover", "receipt", "relocated", "deliver"}) {
                    s.execute("insert into execution_task(id, request_id, key, name, role_code, due_at, evidence_required, status) values ('"
                            + UUID.randomUUID() + "', '" + UUID.randomUUID() + "', '" + key + "', 'step', 'X', now(), false, 'OPEN')");
                }
            }
            flyway(url, "17").migrate();
            try (Connection c = DriverManager.getConnection(url, USER, PASSWORD); Statement s = c.createStatement()) {
                Map<String, String> purposes = new HashMap<>();
                try (ResultSet rs = s.executeQuery("select key, purpose from execution_task")) {
                    while (rs.next()) {
                        purposes.put(rs.getString(1), rs.getString(2));
                    }
                }
                assertThat(purposes).containsExactlyInAnyOrderEntriesOf(
                        Map.of("handover", "HANDOVER", "receipt", "RECEIPT", "relocated", "ACKNOWLEDGEMENT", "deliver", "TASK"));

                s.execute("set session_replication_role = replica");
                s.execute("insert into execution_task(id, request_id, key, name, role_code, due_at, evidence_required, status) values ('"
                        + UUID.randomUUID() + "', '" + UUID.randomUUID() + "', 'handover', 'older code', 'X', now(), false, 'OPEN')");
                try (ResultSet rs = s.executeQuery("select purpose from execution_task where name = 'older code'")) {
                    rs.next();
                    assertThat(rs.getString(1)).as("a step written by code older than V17 is not backfilled again").isEqualTo("TASK");
                }
                assertThatThrownBy(() -> s.execute("update execution_task set purpose = 'BOGUS' where key = 'deliver'"))
                        .isInstanceOf(SQLException.class);
            }
        } finally {
            try (Connection server = DriverManager.getConnection(URL, USER, PASSWORD); Statement s = server.createStatement()) {
                s.execute("drop database if exists " + db + " with (force)");
            }
        }
    }
}
