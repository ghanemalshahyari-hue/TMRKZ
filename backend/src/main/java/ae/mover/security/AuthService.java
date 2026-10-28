package ae.mover.security;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import io.micrometer.core.instrument.MeterRegistry;

/** Local identity adapter: username/password with server-side sessions (see ADR-003). */
@Service
public class AuthService {

    private static final String DUMMY_HASH = new BCryptPasswordEncoder(12).encode("not-a-real-password");

    private final JdbcClient jdbc;
    private final Clock clock;
    private final SecurityProperties props;
    private final DemoProperties demo;
    private final AuditService audit;
    private final MeterRegistry meters;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder(12);
    private final SecureRandom random = new SecureRandom();

    public AuthService(JdbcClient jdbc, Clock clock, SecurityProperties props, DemoProperties demo,
                       AuditService audit, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.props = props;
        this.demo = demo;
        this.audit = audit;
        this.meters = meters;
    }

    public record LoginResult(String token, Actor actor) {
    }

    public String hash(String password) {
        return encoder.encode(password);
    }

    @Transactional(noRollbackFor = ApiException.class)
    public LoginResult login(String username, String password, String ip, String userAgent) {
        if (username == null || password == null || username.isBlank() || password.isEmpty()) {
            throw invalidCredentials();
        }
        Instant now = clock.instant();
        Optional<Map<String, Object>> row = jdbc.sql("""
                select id, username, display_name, password_hash, status, failed_logins, locked_until
                from person where lower(username) = lower(:u) for update""")
                .param("u", username.trim())
                .query().listOfRows().stream().findFirst();
        if (row.isEmpty() || row.get().get("password_hash") == null) {
            encoder.matches(password, DUMMY_HASH); // equalise timing for unknown users
            meters.counter("mover.auth.failures", "reason", "unknown").increment();
            throw invalidCredentials();
        }
        Map<String, Object> p = row.get();
        UUID personId = (UUID) p.get("id");
        if (!"ACTIVE".equals(p.get("status"))) {
            meters.counter("mover.auth.failures", "reason", "disabled").increment();
            throw invalidCredentials();
        }
        Instant lockedUntil = Db.toInstant(p.get("locked_until"));
        if (lockedUntil != null && lockedUntil.isAfter(now)) {
            meters.counter("mover.auth.failures", "reason", "locked").increment();
            throw new ApiException(ErrorCode.UNAUTHENTICATED,
                    "تم إيقاف الدخول مؤقتاً بعد محاولات متكررة. حاول لاحقاً أو تواصل مع مدير النظام.");
        }
        if (!encoder.matches(password, (String) p.get("password_hash"))) {
            int failures = ((Number) p.get("failed_logins")).intValue() + 1;
            Instant lock = failures >= props.maxFailedLogins() ? now.plus(Duration.ofMinutes(props.lockMinutes())) : null;
            jdbc.sql("update person set failed_logins = :f, locked_until = :l where id = :id")
                    .param("f", lock != null ? 0 : failures).param("l", Db.ts(lock)).param("id", personId).update();
            meters.counter("mover.auth.failures", "reason", "password").increment();
            audit.system("LOGIN_FAILED", "PERSON", personId.toString(), (String) p.get("display_name"),
                    Map.of("locked", lock != null));
            throw invalidCredentials();
        }
        jdbc.sql("update person set failed_logins = 0, locked_until = null where id = :id").param("id", personId).update();
        Actor actor = new Actor(personId, (String) p.get("username"), (String) p.get("display_name"), null);
        String token = createSession(personId, ip, userAgent, now);
        audit.recordAs(actor, "LOGIN", "PERSON", personId.toString(), actor.displayName(), Map.of(), null);
        return new LoginResult(token, new Actor(personId, actor.username(), actor.displayName(), Hashing.sha256(token)));
    }

    @Transactional
    public LoginResult demoSwitch(String username, String ip, String userAgent) {
        if (!demo.mode()) {
            throw ApiException.notFound();
        }
        Map<String, Object> p = jdbc.sql("select id, username, display_name from person where username = :u and status = 'ACTIVE'")
                .param("u", username).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        UUID personId = (UUID) p.get("id");
        Actor actor = new Actor(personId, (String) p.get("username"), (String) p.get("display_name"), null);
        String token = createSession(personId, ip, userAgent, clock.instant());
        audit.recordAs(actor, "DEMO_SWITCH", "PERSON", personId.toString(), actor.displayName(),
                Map.of("note", "تبديل مستخدم في وضع العرض التجريبي"), null);
        return new LoginResult(token, new Actor(personId, actor.username(), actor.displayName(), Hashing.sha256(token)));
    }

    private String createSession(UUID personId, String ip, String userAgent, Instant now) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        jdbc.sql("""
                insert into user_session(id, person_id, created_at, last_seen_at, expires_at, client_ip, user_agent)
                values (:id, :p, :now, :now, :exp, :ip, :ua)""")
                .param("id", Hashing.sha256(token)).param("p", personId).param("now", Db.ts(now))
                .param("exp", Db.ts(now.plus(Duration.ofHours(props.sessionAbsoluteHours()))))
                .param("ip", ip).param("ua", userAgent == null ? null : userAgent.substring(0, Math.min(200, userAgent.length())))
                .update();
        return token;
    }

    /** Resolves a cookie token to an actor. Expired, idle or disabled sessions resolve to empty. */
    @Transactional
    public Optional<Actor> resolve(String token) {
        if (token == null || token.isBlank() || token.length() > 100) {
            return Optional.empty();
        }
        String id = Hashing.sha256(token);
        Instant now = clock.instant();
        List<Actor> found = jdbc.sql("""
                select p.id, p.username, p.display_name, s.last_seen_at
                from user_session s join person p on p.id = s.person_id
                where s.id = :id and s.expires_at > :now and s.last_seen_at > :idle and p.status = 'ACTIVE'""")
                .param("id", id).param("now", Db.ts(now))
                .param("idle", Db.ts(now.minus(Duration.ofMinutes(props.sessionIdleMinutes()))))
                .query((rs, n) -> {
                    Instant lastSeen = Db.instant(rs, "last_seen_at");
                    if (lastSeen.isBefore(now.minusSeconds(60))) {
                        jdbc.sql("update user_session set last_seen_at = :now where id = :id")
                                .param("now", Db.ts(now)).param("id", id).update();
                    }
                    return new Actor(Db.uuid(rs, "id"), rs.getString("username"), rs.getString("display_name"), id);
                }).list();
        return found.stream().findFirst();
    }

    @Transactional
    public void logout(Actor actor) {
        if (actor != null && actor.sessionId() != null) {
            jdbc.sql("delete from user_session where id = :id").param("id", actor.sessionId()).update();
            audit.recordAs(actor, "LOGOUT", "PERSON", actor.personId().toString(), actor.displayName(), Map.of(), null);
        }
    }

    /** Re-authentication used for the internal approval attestation. */
    public boolean verifyPassword(UUID personId, String password) {
        if (password == null || password.isEmpty()) {
            return false;
        }
        String hash = jdbc.sql("select password_hash from person where id = :id and status = 'ACTIVE'")
                .param("id", personId).query(String.class).optional().orElse(null);
        if (hash == null) {
            encoder.matches(password, DUMMY_HASH);
            return false;
        }
        return encoder.matches(password, hash);
    }

    public Duration sessionLifetime() {
        return Duration.ofHours(props.sessionAbsoluteHours());
    }

    private ApiException invalidCredentials() {
        return new ApiException(ErrorCode.UNAUTHENTICATED, "اسم المستخدم أو كلمة المرور غير صحيحة.");
    }
}
