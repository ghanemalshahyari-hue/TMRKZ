package ae.mover.system;

import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** «صحة الطلبات» (owner, 20 Nov 2026): the three read-only endpoints that drive the diagnostic page and the Home widget. */
@RestController
@RequestMapping("/api/v1/system/request-health")
public class RequestHealthController {

    private final AccessService access;
    private final RequestHealthService health;

    public RequestHealthController(AccessService access, RequestHealthService health) {
        this.access = access;
        this.health = health;
    }

    @GetMapping("/summary")
    public Map<String, Object> summary(Actor actor) {
        return health.summary(access.context(actor));
    }

    @GetMapping
    public List<Map<String, Object>> search(Actor actor,
                                            @RequestParam(required = false) String q,
                                            @RequestParam(required = false) String state,
                                            @RequestParam(required = false) String health,
                                            @RequestParam(required = false) Integer limit) {
        return this.health.search(access.context(actor), q, state, health, limit == null ? 50 : limit);
    }

    @GetMapping("/{id}")
    public Map<String, Object> diagnose(Actor actor, @PathVariable String id) {
        return health.diagnose(access.context(actor), id);
    }
}
