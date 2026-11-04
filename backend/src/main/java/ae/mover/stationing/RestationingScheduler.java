package ae.mover.stationing;

import java.time.Clock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ae.mover.hr.HrSnapshotPublished;

/**
 * Time and hierarchy for re-stationing requests: after every HR publication, and periodically as a safety net, requests
 * whose requesting unit's hierarchy changed are paused (O-10, O-16); temporaries start at their approved start and
 * return automatically at their end (V2 D7). Activation also refuses a drifted hierarchy on its own (defensive check).
 */
@Component
public class RestationingScheduler {

    private static final Logger log = LoggerFactory.getLogger(RestationingScheduler.class);

    private final RestationingService service;
    private final Clock clock;

    public RestationingScheduler(RestationingService service, Clock clock) {
        this.service = service;
        this.clock = clock;
    }

    @EventListener
    public void onHrPublished(HrSnapshotPublished e) {
        int paused = service.pauseDrifted(clock.instant());
        if (paused > 0) {
            log.info("HR snapshot {}: {} re-stationing request(s) paused after a hierarchy change", e.snapshotId(), paused);
        }
    }

    @Scheduled(fixedDelayString = "${tmrkz.restationing.poll-ms:60000}", initialDelay = 20000)
    public void tick() {
        service.pauseDrifted(clock.instant());
        int[] r = service.runTemporaryLifecycle(clock.instant());
        if (r[0] + r[1] > 0) {
            log.info("Re-stationing temporaries: {} started, {} returned", r[0], r[1]);
        }
    }
}
