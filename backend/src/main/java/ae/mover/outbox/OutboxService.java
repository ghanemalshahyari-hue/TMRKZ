package ae.mover.outbox;

import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.common.Json;

/** Writes outbox events inside the business transaction (transactional outbox pattern). */
@Service
public class OutboxService {

    private final JdbcClient jdbc;
    private final Json json;

    public OutboxService(JdbcClient jdbc, Json json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Payloads are minimal identifiers; recipients re-read data through access checks when the event is handled. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void enqueue(String aggregateType, String aggregateId, String eventType, Map<String, ?> payload) {
        jdbc.sql("""
                insert into outbox_event(aggregate_type, aggregate_id, event_type, payload)
                values (:t, :id, :e, cast(:p as jsonb))""")
                .param("t", aggregateType).param("id", aggregateId).param("e", eventType)
                .param("p", json.write(payload)).update();
    }
}
