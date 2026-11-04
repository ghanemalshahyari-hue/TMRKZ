package ae.mover.stationing;

import java.net.URI;
import java.time.Clock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ae.mover.common.Json;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;

/**
 * Runs the outbound stationing sender ({@link StationingEventSender}) on the outbox. It delivers only when a consumer
 * endpoint is configured ({@code TMRKZ_STATIONING_OUTBOUND_URL}); without one nothing is sent and events stay PENDING
 * (visible in {@code tmrkz_stationing_outbox_pending}), so a missing consumer never loses an event and never blocks a
 * stationing change. One backend instance delivers; delivery is at least once and the event id is the consumer's
 * idempotency key.
 */
@Component
public class StationingOutboxProcessor {

    private static final Logger log = LoggerFactory.getLogger(StationingOutboxProcessor.class);

    private final StationingOutbox outbox;
    private final Clock clock;
    private final StationingEventSender sender;

    public StationingOutboxProcessor(StationingOutbox outbox, Clock clock, Json json, MeterRegistry meters,
                                     @Value("${tmrkz.stationing.outbound.url:}") String url,
                                     @Value("${tmrkz.stationing.outbound.token:}") String token) {
        this.outbox = outbox;
        this.clock = clock;
        this.sender = url == null || url.isBlank() ? null
                : new StationingEventSender(outbox.ledger(), new HttpStationingDestination(URI.create(url), token, json));
        Gauge.builder("tmrkz.stationing.outbox.pending", outbox, StationingOutbox::pending).register(meters);
        if (sender == null) {
            log.info("Outbound stationing events: no consumer endpoint configured; events are kept PENDING");
        }
    }

    @Scheduled(fixedDelayString = "${tmrkz.stationing.outbound.poll-ms:5000}", initialDelay = 10000)
    public void poll() {
        if (sender != null) {
            process(sender);
        }
    }

    /** One delivery pass with the given sender (tests pass one with a test transport). */
    public int process(StationingEventSender s) {
        return s.process(clock.instant(), 50);
    }
}
