package ae.mover.stationing;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.security.Actor;
import ae.mover.stationing.StationingEventSender.Delivery;
import ae.mover.stationing.StationingEventSender.State;

/**
 * The stationing outbox ({@code stationing_outbox}, O-01). {@link #enqueue} runs inside the transaction of the
 * authoritative change, so the event exists exactly when the change does. As a {@link StationingEventSender.Ledger} it
 * hands out due events in sequence per unit — a unit's next event waits while an earlier one is undelivered (pending or
 * failed) — and stores each delivery result. A failed event is put back only by {@link #replay} (an operator with
 * REPLAY_STATIONING_EVENTS over every organisation, from a grant of their own, with a reason, audited).
 */
@Service
public class StationingOutbox {

    public record OutboxRow(long seq, UUID eventId, String type, UUID orgId, String state, int attempts, Instant availableAt,
                            String lastError, Instant createdAt, Instant deliveredAt, Map<String, Object> payload) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final AuditService audit;

    public StationingOutbox(JdbcClient jdbc, Json json, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.audit = audit;
    }

    /** Writes the event of an authoritative change (call inside that change's transaction). */
    public StationingEvent enqueue(StationingEvent.Type type, UUID orgId, UUID siteId, Instant effectiveAt, Instant recordedAt,
                                   String sourceVersion, String auditRef) {
        Map<String, Object> unit = jdbc.sql("select code, source_external_id from organization where id = :id").param("id", orgId)
                .query().singleRow();
        StationingEvent e = StationingEvent.of(type, (String) unit.get("source_external_id"), (String) unit.get("code"), siteId, null,
                effectiveAt, recordedAt, sourceVersion, auditRef);
        jdbc.sql("""
                insert into stationing_outbox(event_id, event_type, organization_id, payload, created_at, available_at)
                values (:id, :t, :org, cast(:p as jsonb), :now, :now)""")
                .param("id", e.eventId()).param("t", type.name()).param("org", orgId).param("p", json.write(e.payload()))
                .param("now", Db.ts(recordedAt)).update();
        return e;
    }

    public List<OutboxRow> list(AccessContext ctx, String state, int limit) {
        if (!ctx.canEverywhere(Permission.REPLAY_STATIONING_EVENTS) && !ctx.canEverywhere(Permission.AUDIT)) {
            throw ApiException.forbidden();
        }
        return rows(state == null ? "order by seq desc limit :n" : "where state = :s order by seq desc limit :n",
                state == null ? Map.of("n", limit) : Map.of("s", state, "n", limit));
    }

    /** The ledger the sender works with. */
    public StationingEventSender.Ledger ledger() {
        return new JdbcLedger(null);
    }

    @Transactional
    public OutboxRow replay(AccessContext ctx, UUID eventId, String reason, Instant now) {
        boolean ownGrant = ctx.grants().stream()
                .anyMatch(g -> g.has(Permission.REPLAY_STATIONING_EVENTS) && g.isAll() && g.delegationId() == null);
        boolean permitted = ownGrant && ctx.canEverywhere(Permission.REPLAY_STATIONING_EVENTS);
        try {
            new StationingEventSender(new JdbcLedger(ctx.actor()), e -> {
                throw new IllegalStateException("no delivery during a replay");
            }).replay(eventId, permitted, ctx.actor().username(), reason, now);
        } catch (SecurityException e) {
            throw ApiException.forbidden(e.getMessage());
        } catch (IllegalArgumentException | IllegalStateException e) {
            throw ApiException.validation(e.getMessage());
        }
        return rows("where event_id = :id", Map.of("id", eventId)).getFirst();
    }

    public long pending() {
        return jdbc.sql("select count(*) from stationing_outbox where state = 'PENDING'").query(Long.class).single();
    }

    private List<OutboxRow> rows(String tail, Map<String, ?> params) {
        return jdbc.sql("""
                select seq, event_id, event_type, organization_id, state, attempts, available_at, last_error, created_at,
                       delivered_at, payload::text as payload
                  from stationing_outbox
                """ + tail).params(params)
                .query((rs, n) -> new OutboxRow(rs.getLong("seq"), Db.uuid(rs, "event_id"), rs.getString("event_type"),
                        Db.uuid(rs, "organization_id"), rs.getString("state"), rs.getInt("attempts"), Db.instant(rs, "available_at"),
                        rs.getString("last_error"), Db.instant(rs, "created_at"), Db.instant(rs, "delivered_at"),
                        json.map(rs.getString("payload"))))
                .list();
    }

    private final class JdbcLedger implements StationingEventSender.Ledger {

        private final Actor actor;

        JdbcLedger(Actor actor) {
            this.actor = actor;
        }

        @Override
        public List<Delivery> due(Instant now, int max) {
            return jdbc.sql("""
                    select o.event_id, o.state, o.attempts, o.available_at, o.last_error, o.payload::text as payload
                      from stationing_outbox o
                     where o.state = 'PENDING' and o.available_at <= :now
                       and not exists (select 1 from stationing_outbox e
                                        where e.organization_id = o.organization_id and e.seq < o.seq and e.state <> 'DELIVERED')
                     order by o.seq limit :max""")
                    .param("now", Db.ts(now)).param("max", max)
                    .query((rs, n) -> delivery(rs.getString("payload"), rs.getString("state"), rs.getInt("attempts"),
                            Db.instant(rs, "available_at"), rs.getString("last_error")))
                    .list();
        }

        @Override
        public Optional<Delivery> get(UUID eventId) {
            return jdbc.sql("""
                    select state, attempts, available_at, last_error, payload::text as payload from stationing_outbox
                     where event_id = :id""").param("id", eventId)
                    .query((rs, n) -> delivery(rs.getString("payload"), rs.getString("state"), rs.getInt("attempts"),
                            Db.instant(rs, "available_at"), rs.getString("last_error")))
                    .optional();
        }

        @Override
        public void save(Delivery d) {
            jdbc.sql("""
                    update stationing_outbox set state = :s, attempts = :a, available_at = :at, last_error = :err,
                           delivered_at = case when :s = 'DELIVERED' then now() end
                     where event_id = :id""")
                    .param("s", d.state().name()).param("a", d.attempts()).param("at", Db.ts(d.availableAt()))
                    .param("err", d.lastError()).param("id", d.event().eventId()).update();
        }

        @Override
        public void audit(UUID eventId, String action, String by, String reason, Instant at) {
            audit.recordAs(actor, "STATIONING_EVENT_" + action + "ED", "STATIONING_EVENT", eventId.toString(), null,
                    Map.of("eventId", eventId.toString()), reason);
        }

        private Delivery delivery(String payload, String state, int attempts, Instant availableAt, String lastError) {
            Map<String, Object> p = json.map(payload);
            StationingEvent e = new StationingEvent(UUID.fromString((String) p.get("eventId")),
                    StationingEvent.Type.valueOf((String) p.get("type")), (String) p.get("orgExternalId"), (String) p.get("orgCode"),
                    UUID.fromString((String) p.get("siteId")), (String) p.get("siteExternalId"),
                    Instant.parse((String) p.get("effectiveAt")), Instant.parse((String) p.get("recordedAt")),
                    (String) p.get("sourceVersion"), (String) p.get("auditRef"));
            return new Delivery(e, State.valueOf(state), attempts, availableAt, lastError);
        }
    }
}
