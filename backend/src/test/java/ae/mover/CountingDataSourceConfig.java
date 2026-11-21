package ae.mover;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.concurrent.atomic.AtomicLong;

import javax.sql.DataSource;

import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.datasource.DelegatingDataSource;

/**
 * Test-only JDBC statement counter (ADR-094 Gate 2.5 §E/§F). Wraps whichever {@link DataSource} Spring Boot
 * auto-configures from the test {@code spring.datasource.url} with a thin counting proxy. Every call that
 * creates a statement — {@code prepareStatement}, {@code prepareCall}, {@code createStatement} — advances the
 * counter. Tests that import this configuration can then snapshot {@link #COUNT} before and after a posture
 * request and assert on the exact number of real JDBC executions, not just {@code pg_stat_user_tables} scans.
 *
 * <p>This is a mechanism-level counter: an {@code IN (:1, :2, :3)} bulk query counts as one, while N
 * individual {@code WHERE id = :1} queries count as N. That is exactly the shape we want to protect against —
 * an indexed N+1 can still produce many index scans, which the scan-ratio check cannot tell apart from a bulk
 * query that happens to touch the index many times.
 *
 * <p>Enabled only in the integration tests that {@code @Import} this configuration. Production never loads it,
 * so there is no per-production-request cost.
 */
@TestConfiguration
public class CountingDataSourceConfig {

    /** Counts every JDBC statement created through any DataSource bean in this Spring context. Test-shared. */
    public static final AtomicLong COUNT = new AtomicLong();

    @Bean
    static BeanPostProcessor countingDataSourceProcessor() {
        return new BeanPostProcessor() {
            @Override
            public Object postProcessAfterInitialization(Object bean, String beanName) {
                if (bean instanceof DataSource ds && !(bean instanceof CountingDataSource)) {
                    return new CountingDataSource(ds);
                }
                return bean;
            }
        };
    }

    /** Snapshot-and-return helper: the number of JDBC statements created since the last {@code reset()}. */
    public static long snapshot() {
        return COUNT.get();
    }

    /** Reset the shared counter to zero. Tests call this before the request they want to measure. */
    public static void reset() {
        COUNT.set(0);
    }

    /** DataSource delegate that wraps every returned Connection with the counting proxy below. */
    static final class CountingDataSource extends DelegatingDataSource {
        CountingDataSource(DataSource delegate) {
            super(delegate);
        }

        @Override
        public Connection getConnection() throws SQLException {
            return wrap(super.getConnection());
        }

        @Override
        public Connection getConnection(String username, String password) throws SQLException {
            return wrap(super.getConnection(username, password));
        }

        private static Connection wrap(Connection c) {
            return (Connection) Proxy.newProxyInstance(
                    CountingDataSource.class.getClassLoader(),
                    new Class<?>[]{Connection.class},
                    new ConnectionCounter(c));
        }
    }

    /**
     * Counts every {@code prepareStatement} / {@code prepareCall} / {@code createStatement} on a Connection and
     * delegates everything else unchanged. Statement-returning methods have many overloads with autoCommit/
     * resultSetType flags; checking the method name alone covers them all.
     */
    private static final class ConnectionCounter implements InvocationHandler {
        private final Connection delegate;

        ConnectionCounter(Connection delegate) {
            this.delegate = delegate;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            String name = method.getName();
            if ("prepareStatement".equals(name) || "prepareCall".equals(name) || "createStatement".equals(name)) {
                COUNT.incrementAndGet();
            }
            try {
                return method.invoke(delegate, args);
            } catch (java.lang.reflect.InvocationTargetException e) {
                throw e.getCause();
            }
        }
    }
}
