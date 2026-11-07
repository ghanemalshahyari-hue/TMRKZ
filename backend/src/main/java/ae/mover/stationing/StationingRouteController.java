package ae.mover.stationing;

import java.time.Clock;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** The approval path of each stationing request type, on «مسار الموافقات» (ADR-046). */
@RestController
@RequestMapping("/api/v1/stationing/routes")
public class StationingRouteController {

    private final AccessService access;
    private final StationingRoutes routes;
    private final StationingPolicyStore policies;
    private final Clock clock;

    public StationingRouteController(AccessService access, StationingRoutes routes, StationingPolicyStore policies, Clock clock) {
        this.access = access;
        this.routes = routes;
        this.policies = policies;
        this.clock = clock;
    }

    @GetMapping
    public Map<String, Object> list(Actor actor) {
        return routes.list(access.context(actor), policies.inForce(clock.instant()).isPresent());
    }

    @PutMapping("/{purpose}/draft")
    public Map<String, Object> saveDraft(Actor actor, @PathVariable String purpose, @RequestBody StationingRoutes.RouteInput in) {
        return routes.saveDraft(access.context(actor), purpose, in, clock.instant());
    }

    @PostMapping("/{purpose}/publish")
    public Map<String, Object> publish(Actor actor, @PathVariable String purpose, @RequestBody StationingRoutes.PublishInput in) {
        return routes.publish(access.context(actor), purpose, in, clock.instant());
    }

    @PostMapping("/{purpose}/simulate")
    public Map<String, Object> simulate(Actor actor, @PathVariable String purpose, @RequestBody StationingRoutes.SimulateInput in) {
        return routes.simulate(access.context(actor), purpose, in);
    }
}
