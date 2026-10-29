package ae.mover.hr;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Reads the HR views. Every session is one {@code SET TRANSACTION READ ONLY} transaction that ends in a rollback, so
 * both views are read at the same point in time and nothing can be written. The adapter issues only that statement and
 * SELECTs; identifiers are validated and taken from the source metadata, never from free user input.
 */
@Component
public class HrSourceAdapter {

    private static final Logger log = LoggerFactory.getLogger(HrSourceAdapter.class);

    private final HrConnectionFactory connections;

    public HrSourceAdapter(HrConnectionFactory connections) {
        this.connections = connections;
    }

    /** Decrypted connection settings plus view names and timeouts of one source. */
    public record Config(String hostOrUrl, int port, String serverName, String nameType, String username, String password,
                         String unitView, String personView, int connectTimeoutS, int callTimeoutMs) {

        @Override
        public String toString() {
            return "HrSource.Config[" + serverName + ", views=" + unitView + "/" + personView + "]"; // never the password
        }
    }

    /** Failure category shown to administrators; raw driver messages stay in the server log. */
    public enum Failure { UNREACHABLE, AUTHENTICATION, CONTRACT, TIMEOUT, ERROR }

    public static final class SourceException extends RuntimeException {
        private final Failure failure;

        public SourceException(Failure failure, String message, Throwable cause) {
            super(message, cause);
            this.failure = failure;
        }

        public Failure failure() {
            return failure;
        }
    }

    public interface BatchConsumer {
        void accept(List<Map<String, Object>> rows);
    }

    public Session open(Config cfg) {
        try {
            Connection c = connections.connect(cfg);
            try {
                c.setAutoCommit(false);
                Session s = new Session(c, cfg);
                s.execute("SET TRANSACTION READ ONLY");
                return s;
            } catch (SQLException e) {
                close(c);
                throw e;
            }
        } catch (SQLException e) {
            throw translate(e);
        }
    }

    public final class Session implements AutoCloseable {
        private final Connection connection;
        private final Config cfg;
        private final List<String> statements = new ArrayList<>();

        private Session(Connection connection, Config cfg) {
            this.connection = connection;
            this.cfg = cfg;
        }

        private void execute(String sql) throws SQLException {
            statements.add(sql);
            try (Statement st = connection.createStatement()) {
                st.setQueryTimeout(Math.max(1, cfg.callTimeoutMs() / 1000));
                st.execute(sql);
            }
        }

        /** Statements issued in this session (SQL text only, never data), for diagnostics and tests. */
        public List<String> statements() {
            return List.copyOf(statements);
        }

        public String databaseVersion() {
            try {
                DatabaseMetaData md = connection.getMetaData();
                return md.getDatabaseProductName() + " " + md.getDatabaseProductVersion().lines().findFirst().orElse("");
            } catch (SQLException e) {
                throw translate(e);
            }
        }

        /** Column names of a view, from metadata only ({@code WHERE 1 = 0} returns no rows). */
        public List<String> columns(String view) {
            requireView(view);
            String sql = "SELECT * FROM " + view + " WHERE 1 = 0";
            statements.add(sql);
            try (Statement st = connection.createStatement()) {
                st.setQueryTimeout(Math.max(1, cfg.callTimeoutMs() / 1000));
                try (ResultSet rs = st.executeQuery(sql)) {
                    ResultSetMetaData md = rs.getMetaData();
                    List<String> out = new ArrayList<>();
                    for (int i = 1; i <= md.getColumnCount(); i++) {
                        out.add(md.getColumnLabel(i));
                    }
                    return out;
                }
            } catch (SQLException e) {
                throw translate(e);
            }
        }

        /** Streams the selected columns of a view in batches. */
        public long stream(String view, List<String> columns, int fetchSize, int batchSize, BatchConsumer consumer) {
            requireView(view);
            for (String col : columns) {
                if (!HrMapping.COLUMN_NAME.matcher(col).matches()) {
                    throw new SourceException(Failure.CONTRACT, "اسم عمود غير صالح في بيانات المصدر.", null);
                }
            }
            String sql = "SELECT " + columns.stream().map(c -> "\"" + c + "\"").collect(Collectors.joining(", ")) + " FROM " + view;
            statements.add(sql);
            long total = 0;
            try (Statement st = connection.createStatement()) {
                st.setFetchSize(fetchSize);
                st.setQueryTimeout(Math.max(1, cfg.callTimeoutMs() / 1000));
                try (ResultSet rs = st.executeQuery(sql)) {
                    List<Map<String, Object>> batch = new ArrayList<>(batchSize);
                    while (rs.next()) {
                        Map<String, Object> row = new LinkedHashMap<>();
                        for (int i = 0; i < columns.size(); i++) {
                            row.put(columns.get(i), rs.getObject(i + 1));
                        }
                        batch.add(row);
                        total++;
                        if (batch.size() >= batchSize) {
                            consumer.accept(batch);
                            batch = new ArrayList<>(batchSize);
                        }
                    }
                    if (!batch.isEmpty()) {
                        consumer.accept(batch);
                    }
                }
            } catch (SQLException e) {
                throw translate(e);
            }
            return total;
        }

        @Override
        public void close() {
            HrSourceAdapter.close(connection);
        }
    }

    private static void requireView(String view) {
        if (view == null || !HrMapping.VIEW_NAME.matcher(view).matches()) {
            throw new SourceException(Failure.CONTRACT, "اسم عرض المصدر غير صالح أو غير مهيأ.", null);
        }
    }

    private static void close(Connection c) {
        try {
            c.rollback();
        } catch (SQLException ignored) {
            // the transaction is read-only; nothing to keep
        }
        try {
            c.close();
        } catch (SQLException ignored) {
            // connection already gone
        }
    }

    static SourceException translate(SQLException e) {
        String state = e.getSQLState() == null ? "" : e.getSQLState();
        int code = e.getErrorCode();
        Failure f;
        if (e instanceof SQLTimeoutException || code == 1013 || "57014".equals(state)) {
            f = Failure.TIMEOUT;
        } else if (code == 1017 || code == 28000 || state.startsWith("28")) {
            f = Failure.AUTHENTICATION;
        } else if (code == 942 || code == 904 || "42P01".equals(state) || "42703".equals(state)) {
            f = Failure.CONTRACT;
        } else if (state.startsWith("08") || code == 12541 || code == 12514 || code == 12505 || code == 17002) {
            f = Failure.UNREACHABLE;
        } else {
            f = Failure.ERROR;
        }
        log.warn("HR source error {} (SQLState {}, code {}): {}", f, state, code, e.getMessage());
        return new SourceException(f, switch (f) {
            case TIMEOUT -> "انتهت مهلة الاتصال أو الاستعلام في مصدر الموارد البشرية.";
            case AUTHENTICATION -> "رفض مصدر الموارد البشرية بيانات الدخول.";
            case CONTRACT -> "عرض أو عمود غير موجود في مصدر الموارد البشرية.";
            case UNREACHABLE -> "تعذر الوصول إلى مصدر الموارد البشرية.";
            default -> "خطأ في قراءة مصدر الموارد البشرية.";
        }, e);
    }
}
