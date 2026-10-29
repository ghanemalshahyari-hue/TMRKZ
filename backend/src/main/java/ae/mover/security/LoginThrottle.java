package ae.mover.security;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;

/**
 * Throttles manual sign-in: a login name is locked for {@code lockMinutes} after {@code maxFailures} failures within that
 * window, and one client address may not try more than 20 times in ten minutes. The directory's own lockout policy
 * still applies on top of this one.
 */
@Component
public class LoginThrottle {

    private static final int ADDRESS_FAILURES = 20;
    private static final Duration ADDRESS_WINDOW = Duration.ofMinutes(10);

    private final JdbcClient jdbc;
    private final Clock clock;
    private final LdapProperties props;

    public LoginThrottle(JdbcClient jdbc, Clock clock, LdapProperties props) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.props = props;
    }

    static String userKey(String username) {
        return "u:" + (username == null ? "" : username.trim().toLowerCase(Locale.ROOT));
    }

    static String addressKey(String ip) {
        return "ip:" + (ip == null ? "unknown" : ip);
    }

    public void check(String username, String ip) {
        Instant now = clock.instant();
        for (String key : ip == null ? new String[]{userKey(username)} : new String[]{userKey(username), addressKey(ip)}) {
            Map<String, Object> row = jdbc.sql("select locked_until from login_throttle where key = :k").param("k", key)
                    .query().listOfRows().stream().findFirst().orElse(null);
            Instant until = row == null ? null : Db.toInstant(row.get("locked_until"));
            if (until != null && until.isAfter(now)) {
                throw new ApiException(ErrorCode.SIGN_IN_THROTTLED,
                        "أُوقف الدخول مؤقتاً بعد محاولات خاطئة متكررة. حاول بعد " + Math.max(1, Duration.between(now, until).toMinutes() + 1) + " دقيقة.");
            }
        }
    }

    /** Recorded in its own transaction so a refused sign-in still counts. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void failed(String username, String ip) {
        Instant now = clock.instant();
        record(userKey(username), props.maxFailures(), Duration.ofMinutes(props.lockMinutes()), now);
        if (ip != null) {
            record(addressKey(ip), ADDRESS_FAILURES, ADDRESS_WINDOW, now);
        }
    }

    private void record(String key, int max, Duration window, Instant now) {
        jdbc.sql("""
                insert into login_throttle(key, failures, window_started_at) values (:k, 1, :now)
                on conflict (key) do update set
                  failures = case when login_throttle.window_started_at < :since then 1 else login_throttle.failures + 1 end,
                  window_started_at = case when login_throttle.window_started_at < :since then :now else login_throttle.window_started_at end""")
                .param("k", key).param("now", Db.ts(now)).param("since", Db.ts(now.minus(window))).update();
        jdbc.sql("update login_throttle set locked_until = :until, failures = 0, window_started_at = :now where key = :k and failures >= :max")
                .param("until", Db.ts(now.plus(window))).param("now", Db.ts(now)).param("k", key).param("max", max).update();
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void succeeded(String username) {
        jdbc.sql("delete from login_throttle where key = :k").param("k", userKey(username)).update();
    }
}
