package ae.mover.stationing;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** «طلب جديد», the operational posture, a site's occupants and the scoped counts of the home page (ADR-045). */
@RestController
@RequestMapping("/api/v1")
public class RequestHubController {

    private final AccessService access;
    private final RequestHubService hub;
    private final Clock clock;

    public RequestHubController(AccessService access, RequestHubService hub, Clock clock) {
        this.access = access;
        this.hub = hub;
        this.clock = clock;
    }

    @GetMapping("/request-hub")
    public Map<String, Object> hub(Actor actor) {
        return hub.hub(access.context(actor), clock.instant());
    }

    @GetMapping("/request-hub/units/{id}")
    public Map<String, Object> unit(Actor actor, @PathVariable UUID id) {
        return hub.unit(access.context(actor), id, clock.instant());
    }

    @GetMapping("/request-hub/units/{id}/sites")
    public List<Map<String, Object>> sites(Actor actor, @PathVariable UUID id) {
        return hub.selectableSites(access.context(actor), id);
    }

    @GetMapping("/request-hub/overview")
    public List<Map<String, Object>> overview(Actor actor, @RequestParam(required = false) String filter) {
        return hub.overview(access.context(actor), filter);
    }

    @GetMapping("/request-hub/home-cards")
    public List<Map<String, Object>> homeCards(Actor actor) {
        return hub.homeCards(access.context(actor), clock.instant());
    }

    @GetMapping("/sites/{id}/occupants")
    public Map<String, Object> occupants(Actor actor, @PathVariable UUID id) {
        return hub.occupants(access.context(actor), id, clock.instant());
    }

    @GetMapping("/operational-posture")
    public Map<String, Object> posture(Actor actor) {
        return hub.posture(access.context(actor), clock.instant());
    }
}
