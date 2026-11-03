package ae.mover.stationing;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Delivers outbound stationing events to a configured destination with the semantics of the existing outbox processor:
 * at-least-once with the event id as idempotency key, exponential back-off (2^(n+1) s, capped at 300 s), parked as
 * FAILED for an operator after 10 attempts or at once on a permanent refusal, the reason kept, replay only with
 * permission and audited. Nothing is dropped silently. Persistence ({@link Ledger}) and the destination are injected;
 * no destination is connected in production (it is built and tested against a test destination only).
 */
public final class StationingEventSender {

    public static final int MAX_ATTEMPTS = 10;

    public enum State { PENDING, DELIVERED, FAILED }

    public record Delivery(StationingEvent event, State state, int attempts, Instant availableAt, String lastError) {
    }

    /** The consumer side. {@code permanent} failures are not retried. */
    public interface Destination {

        Result deliver(StationingEvent event);

        record Result(boolean delivered, boolean permanent, String reason) {

            public static Result ok() {
                return new Result(true, false, null);
            }

            public static Result retry(String reason) {
                return new Result(false, false, reason);
            }

            public static Result refuse(String reason) {
                return new Result(false, true, reason);
            }
        }
    }

    /** Delivery state storage (the stationing outbox table once its schema is deployed). */
    public interface Ledger {

        List<Delivery> due(Instant now, int max);

        Optional<Delivery> get(UUID eventId);

        void save(Delivery delivery);

        /** Operator visibility and audit of replays. */
        void audit(UUID eventId, String action, String by, String reason, Instant at);
    }

    private final Ledger ledger;
    private final Destination destination;

    public StationingEventSender(Ledger ledger, Destination destination) {
        this.ledger = ledger;
        this.destination = destination;
    }

    /** Delivers what is due; returns the number of attempts made. */
    public int process(Instant now, int max) {
        List<Delivery> due = ledger.due(now, max);
        for (Delivery d : due) {
            Destination.Result r;
            try {
                r = destination.deliver(d.event());
            } catch (RuntimeException e) {
                r = Destination.Result.retry(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            int attempts = d.attempts() + 1;
            if (r.delivered()) {
                ledger.save(new Delivery(d.event(), State.DELIVERED, attempts, d.availableAt(), null));
            } else if (r.permanent() || attempts >= MAX_ATTEMPTS) {
                ledger.save(new Delivery(d.event(), State.FAILED, attempts, d.availableAt(), reason(r)));
            } else {
                ledger.save(new Delivery(d.event(), State.PENDING, attempts, now.plus(backoff(attempts)), reason(r)));
            }
        }
        return due.size();
    }

    /** Puts a FAILED event back to PENDING; only with the replay permission, with a reason, audited. */
    public void replay(UUID eventId, boolean permitted, String by, String reason, Instant now) {
        if (!permitted) {
            throw new SecurityException("إعادة إرسال حدث التمركز تحتاج صلاحيتها");
        }
        if (reason == null || reason.isBlank()) {
            throw new IllegalArgumentException("سبب إعادة الإرسال مطلوب");
        }
        Delivery d = ledger.get(eventId).orElseThrow(() -> new IllegalArgumentException("لا يوجد الحدث " + eventId));
        if (d.state() != State.FAILED) {
            throw new IllegalStateException("لا يُعاد إلا حدث متوقف (FAILED)");
        }
        ledger.save(new Delivery(d.event(), State.PENDING, d.attempts(), now, d.lastError()));
        ledger.audit(eventId, "REPLAY", by, reason, now);
    }

    static Duration backoff(int attempts) {
        return Duration.ofSeconds((long) Math.min(300, Math.pow(2, attempts + 1)));
    }

    private static String reason(Destination.Result r) {
        String s = r.reason() == null || r.reason().isBlank() ? "سبب غير مذكور من الوجهة" : r.reason();
        return s.length() > 500 ? s.substring(0, 500) : s;
    }
}
