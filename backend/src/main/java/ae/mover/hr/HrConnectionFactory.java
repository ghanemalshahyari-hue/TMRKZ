package ae.mover.hr;

import java.net.URI;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Properties;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

/**
 * Opens JDBC thin connections to the Oracle HR database. Host input is a host name or address with an optional port —
 * never credentials, paths or connect descriptors — so it cannot alter the connect string. {@code service_name} and
 * {@code sid} follow the TNQL setting of the same name. Thick (OCI) mode is not offered: the thin driver needs no
 * native client in the isolated image.
 */
@Component
public class HrConnectionFactory {

    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\\[[0-9A-Fa-f:]+]$");
    private static final Pattern SERVICE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._$#-]{0,127}$");

    public Connection connect(HrSourceAdapter.Config cfg) throws SQLException {
        Properties p = new Properties();
        p.setProperty("user", cfg.username());
        p.setProperty("password", cfg.password());
        p.setProperty("oracle.net.CONNECT_TIMEOUT", String.valueOf(cfg.connectTimeoutS() * 1000L));
        p.setProperty("oracle.jdbc.ReadTimeout", String.valueOf(cfg.callTimeoutMs()));
        p.setProperty("v$session.program", "TMRKZ HR mirror");
        DriverManager.setLoginTimeout(cfg.connectTimeoutS());
        return DriverManager.getConnection(url(cfg), p);
    }

    /** Builds the thin URL from validated parts; a port inside {@code hostOrUrl} wins over {@code port}, as in TNQL. */
    static String url(HrSourceAdapter.Config cfg) {
        String raw = cfg.hostOrUrl() == null ? "" : cfg.hostOrUrl().trim();
        String host;
        int port = cfg.port() <= 0 ? 1521 : cfg.port();
        URI uri;
        try {
            uri = URI.create(raw.contains("://") ? raw : "oracle://" + raw);
        } catch (IllegalArgumentException e) {
            throw invalid();
        }
        if (uri.getUserInfo() != null || (uri.getPath() != null && !uri.getPath().isEmpty()) || uri.getQuery() != null
                || uri.getFragment() != null || uri.getHost() == null) {
            throw invalid();
        }
        host = uri.getHost();
        if (uri.getPort() > 0) {
            port = uri.getPort();
        }
        if (!HOST.matcher(host).matches() || port > 65535) {
            throw invalid();
        }
        String server = cfg.serverName() == null ? "" : cfg.serverName().trim();
        if (!SERVICE.matcher(server).matches()) {
            throw new IllegalArgumentException("اسم الخدمة أو SID غير صالح.");
        }
        return "sid".equals(cfg.nameType())
                ? "jdbc:oracle:thin:@" + host + ":" + port + ":" + server
                : "jdbc:oracle:thin:@//" + host + ":" + port + "/" + server;
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("عنوان الخادم يجب أن يكون اسم مضيف أو عنواناً مع منفذ اختياري، دون بيانات دخول أو مسار.");
    }
}
