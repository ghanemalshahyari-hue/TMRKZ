package ae.mover.outbox;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.security.Actor;
import io.micrometer.core.instrument.MeterRegistry;

/**
 * Delivers outbox events as in-app notifications. Each event is handled in its own transaction together with
 * marking it DONE; notification rows are unique per (event, person, kind), so re-processing after a crash or a
 * worker restart never duplicates an effect. The correspondence connector is not connected (D-04), so no external
 * delivery is attempted or claimed.
 */
@Component
public class OutboxProcessor {

    private static final Logger log = LoggerFactory.getLogger(OutboxProcessor.class);

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final TransactionTemplate tx;
    private final AccessService access;
    private final MeterRegistry meters;
    private final boolean enabled;

    public OutboxProcessor(JdbcClient jdbc, Json json, Clock clock, TransactionTemplate tx, AccessService access,
                           MeterRegistry meters, @Value("${mover.outbox.enabled:true}") boolean enabled) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.tx = tx;
        this.access = access;
        this.meters = meters;
        this.enabled = enabled;
    }

    @Scheduled(fixedDelayString = "${mover.outbox.poll-ms:2000}", initialDelay = 5000)
    public void poll() {
        if (enabled) {
            processBatch(50);
        }
    }

    @Scheduled(fixedDelay = 60000, initialDelay = 15000)
    public void overdueScan() {
        if (!enabled) {
            return;
        }
        tx.executeWithoutResult(s -> {
            List<Map<String, Object>> rows = jdbc.sql("""
                    select id, request_id from task_assignment where status = 'OPEN' and due_at < :now and not overdue_notified
                    for update skip locked limit 100""").param("now", Db.ts(clock.instant())).query().listOfRows();
            for (Map<String, Object> r : rows) {
                jdbc.sql("update task_assignment set overdue_notified = true where id = :id").param("id", r.get("id")).update();
                jdbc.sql("insert into outbox_event(aggregate_type, aggregate_id, event_type, payload) values ('TASK', :id, 'TASK_OVERDUE', cast(:p as jsonb))")
                        .param("id", r.get("id").toString())
                        .param("p", json.write(Map.of("taskId", r.get("id").toString(), "requestId", r.get("request_id").toString())))
                        .update();
            }
        });
    }

    /** Processes up to {@code limit} pending events; returns how many were handled. Safe to run concurrently. */
    public int processBatch(int limit) {
        int handled = 0;
        for (int i = 0; i < limit; i++) {
            long[] current = {-1};
            try {
                Boolean did = tx.execute(s -> {
                    List<Map<String, Object>> rows = jdbc.sql("""
                            select id, event_type, payload::text as payload from outbox_event
                            where delivery_state = 'PENDING' and available_at <= :now order by id
                            for update skip locked limit 1""").param("now", Db.ts(clock.instant())).query().listOfRows();
                    if (rows.isEmpty()) {
                        return false;
                    }
                    Map<String, Object> e = rows.get(0);
                    long id = ((Number) e.get("id")).longValue();
                    current[0] = id;
                    handle(id, (String) e.get("event_type"), json.map((String) e.get("payload")));
                    jdbc.sql("update outbox_event set delivery_state = 'DONE', processed_at = :now, attempts = attempts + 1 where id = :id")
                            .param("now", Db.ts(clock.instant())).param("id", id).update();
                    meters.counter("mover.outbox.delivered", "type", (String) e.get("event_type")).increment();
                    return true;
                });
                if (!Boolean.TRUE.equals(did)) {
                    break;
                }
                handled++;
            } catch (RuntimeException ex) {
                if (current[0] < 0) {
                    throw ex;
                }
                long failed = current[0];
                log.warn("Outbox event {} failed: {}", failed, ex.getMessage());
                meters.counter("mover.outbox.failures").increment();
                // Exponential back-off; after 10 attempts the event is parked as FAILED for an operator.
                tx.executeWithoutResult(s -> jdbc.sql("""
                        update outbox_event set attempts = attempts + 1, last_error = left(:err, 500),
                               available_at = now() + make_interval(secs => least(300, power(2, attempts + 1))),
                               delivery_state = case when attempts + 1 >= 10 then 'FAILED' else 'PENDING' end
                        where id = :id""").param("err", String.valueOf(ex.getMessage())).param("id", failed).update());
            }
        }
        return handled;
    }

    private void handle(long eventId, String type, Map<String, Object> payload) {
        Object rid = payload.get("requestId");
        if (rid == null) {
            return;
        }
        UUID requestId = UUID.fromString(rid.toString());
        Map<String, Object> r = jdbc.sql("""
                select r.number, r.created_by, t.name as type_name,
                       (select string_agg(res.name, '، ' order by res.code) from request_resource rr join resource res on res.id = rr.resource_id
                        where rr.request_id = r.id) as resources
                from request r join request_type t on t.code = r.type_code where r.id = :id""")
                .param("id", requestId).query().listOfRows().stream().findFirst().orElse(null);
        if (r == null) {
            return;
        }
        String number = (String) r.get("number");
        UUID creator = (UUID) r.get("created_by");
        switch (type) {
            case "REQUEST_RETURNED" -> notify(eventId, creator, "REQUEST_RETURNED", "أعيد الطلب " + number + " للتعديل",
                    "راجع ملاحظة المراجع وعدّل الطلب ثم أعد تقديمه.", requestId);
            case "REQUEST_REJECTED" -> notify(eventId, creator, "REQUEST_REJECTED", "رُفض الطلب " + number,
                    "اطلع على سبب الرفض في سجل الطلب.", requestId);
            case "REQUEST_APPROVED" -> {
                notify(eventId, creator, "REQUEST_APPROVED", "اعتُمد الطلب " + number,
                        "ثُبت الحجز الإداري وفق الفترة المعتمدة.", requestId);
                notifyInfoRecipients(eventId, requestId, number, (String) r.get("type_name"), (String) r.get("resources"));
            }
            case "TASK_OVERDUE" -> notify(eventId, creator, "TASK_OVERDUE", "تأخر مراجعة الطلب " + number,
                    "تجاوزت إحدى مراحل المراجعة مهلتها المحددة.", requestId);
            default -> {
                // REQUEST_SUBMITTED etc.: reviewers see work through their task list; nothing to deliver.
            }
        }
    }

    /**
     * Info ("للعلم") recipients: members of the listed organisations whose current grants include VIEW. The notice
     * carries only summary data; it grants no access to attachments or full request data.
     */
    private void notifyInfoRecipients(long eventId, UUID requestId, String number, String typeName, String resources) {
        List<Map<String, Object>> people = jdbc.sql("""
                select distinct p.id, p.username, p.display_name from request_participant rp
                join membership m on m.organization_id = rp.organization_id
                join person p on p.id = m.person_id and p.status = 'ACTIVE'
                where rp.request_id = :r and rp.relation = 'INFO'
                  and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())""")
                .param("r", requestId).query().listOfRows();
        for (Map<String, Object> p : people) {
            Actor actor = new Actor((UUID) p.get("id"), (String) p.get("username"), (String) p.get("display_name"), null);
            var ctx = access.load(actor, clock.instant());
            if (!ctx.viewer() || ctx.viewLevel(access.requestScope(requestId)) == ae.mover.access.ViewLevel.NONE) {
                continue;
            }
            notify(eventId, actor.personId(), "INFO_COPY", "للعلم: اعتماد " + typeName + " — " + number,
                    "المرافق: " + (resources == null ? "-" : resources) + ". نسخة للعلم دون مرفقات.", requestId);
        }
    }

    private void notify(long eventId, UUID person, String kind, String title, String body, UUID requestId) {
        jdbc.sql("""
                insert into notification(id, person_id, outbox_event_id, kind, title, body, request_id, created_at)
                values (:id, :p, :e, :k, :t, :b, :r, :now) on conflict (outbox_event_id, person_id, kind) do nothing""")
                .param("id", UUID.randomUUID()).param("p", person).param("e", eventId).param("k", kind).param("t", title)
                .param("b", body).param("r", requestId).param("now", Db.ts(Instant.now(clock))).update();
    }

    public long pending() {
        return jdbc.sql("select count(*) from outbox_event where delivery_state = 'PENDING'").query(Long.class).single();
    }
}
