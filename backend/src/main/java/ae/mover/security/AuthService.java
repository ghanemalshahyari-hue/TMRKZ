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
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;

/**
 * Server-side sessions for enterprise sign-in (ADR-015). TMRKZ verifies no passwords: the identity provider
 * authenticates, TMRKZ links the identity and issues an opaque HttpOnly session whose SHA-256 alone is stored.
 * Authorisation is evaluated from the database on every request, so a withdrawn right stops the next action without
 * waiting for any token to expire.
 */
@Service
public class AuthService {

    private final JdbcClient jdbc;
    private final Clock clock;
    private final SecurityProperties props;
    private final AuditService audit;
    private final SecureRandom random = new SecureRandom();

    public AuthService(JdbcClient jdbc, Clock clock, SecurityProperties props, AuditService audit) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.props = props;
        this.audit = audit;
    }

    public record LoginResult(String token, Actor actor) {
    }

    /** Opens a session for a linked, active person after a verified sign-in at {@code authenticatedAt}. */
    @Transactional
    public LoginResult issueSession(UUID personId, String issuer, String idToken, Instant authenticatedAt, String ip, String userAgent) {
        Map<String, Object> p = jdbc.sql("select id, username, display_name, status from person where id = :id")
                .param("id", personId).query().listOfRows().stream().findFirst()
                .orElseThrow(() -> new ApiException(ErrorCode.IDENTITY_NOT_LINKED, "لا يوجد سجل شخص مرتبط بهذا الحساب."));
        if (!"ACTIVE".equals(p.get("status"))) {
            throw new ApiException(ErrorCode.IDENTITY_NOT_LINKED, "سجل الشخص غير نشط في مصدر الموارد البشرية.");
        }
        Instant now = clock.instant();
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        jdbc.sql("""
                insert into user_session(id, person_id, created_at, last_seen_at, expires_at, client_ip, user_agent,
                                         authenticated_at, issuer, id_token)
                values (:id, :p, :now, :now, :exp, :ip, :ua, :auth, :iss, :tok)""")
                .param("id", Hashing.sha256(token)).param("p", personId).param("now", Db.ts(now))
                .param("exp", Db.ts(now.plus(Duration.ofHours(props.sessionAbsoluteHours()))))
                .param("ip", ip).param("ua", userAgent == null ? null : userAgent.substring(0, Math.min(200, userAgent.length())))
                .param("auth", Db.ts(authenticatedAt == null ? now : authenticatedAt)).param("iss", issuer).param("tok", idToken)
                .update();
        Actor actor = new Actor(personId, (String) p.get("username"), (String) p.get("display_name"), Hashing.sha256(token));
        audit.recordAs(actor, "LOGIN", "PERSON", personId.toString(), actor.displayName(), Map.of("issuer", String.valueOf(issuer)), null);
        return new LoginResult(token, actor);
    }

    /** Records a fresh interactive authentication (step-up) on an existing session of the same person. */
    @Transactional
    public void markReauthenticated(String sessionId, UUID personId, Instant authTime, String idToken) {
        int n = jdbc.sql("update user_session set authenticated_at = :t, id_token = :tok where id = :id and person_id = :p")
                .param("t", Db.ts(authTime)).param("tok", idToken).param("id", sessionId).param("p", personId).update();
        if (n == 0) {
            throw new ApiException(ErrorCode.IDENTITY_SIGN_IN_FAILED, "إعادة التحقق تخص حساباً أو جلسة أخرى.");
        }
    }

    /** When the session's person last authenticated interactively. */
    public Optional<Instant> authenticatedAt(String sessionId) {
        return jdbc.sql("select authenticated_at from user_session where id = :id").param("id", sessionId)
                .query().listOfRows().stream().findFirst().map(r -> Db.toInstant(r.get("authenticated_at")));
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

    /** Ends the session; returns the ID token so the provider session can be ended too. */
    @Transactional
    public String logout(Actor actor) {
        if (actor == null || actor.sessionId() == null) {
            return null;
        }
        String idToken = jdbc.sql("delete from user_session where id = :id returning id_token").param("id", actor.sessionId())
                .query(String.class).optional().orElse(null);
        audit.recordAs(actor, "LOGOUT", "PERSON", actor.personId().toString(), actor.displayName(), Map.of(), null);
        return idToken;
    }

    public Duration sessionLifetime() {
        return Duration.ofHours(props.sessionAbsoluteHours());
    }
}
