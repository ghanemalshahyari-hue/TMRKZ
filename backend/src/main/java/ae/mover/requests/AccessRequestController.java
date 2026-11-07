package ae.mover.requests;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** Asking for permissions (ADR-044): open to anyone signed in, for themselves; deciding is checked by the engine. */
@RestController
@RequestMapping("/api/v1/access-requests")
public class AccessRequestController {

    private final AccessRequestService requests;
    private final AccessService access;

    public AccessRequestController(AccessRequestService requests, AccessService access) {
        this.requests = requests;
        this.access = access;
    }

    @GetMapping("/mine")
    public Map<String, Object> mine(Actor actor) {
        return requests.mine(access.context(actor));
    }

    @PostMapping
    public Map<String, Object> submit(Actor actor, @RequestBody AccessRequestService.NewRequest in) {
        return requests.submit(access.context(actor), in);
    }

    @PostMapping("/{id}/resubmit")
    public Map<String, Object> resubmit(Actor actor, @PathVariable UUID id, @RequestBody AccessRequestService.NewRequest in) {
        return requests.resubmit(access.context(actor), id, in);
    }

    @GetMapping("/offer")
    public List<Map<String, Object>> offer(Actor actor) {
        return requests.offer(access.context(actor));
    }

    @PutMapping("/offer")
    public List<Map<String, Object>> saveOffer(Actor actor, @RequestBody Map<String, String> audiences) {
        return requests.saveOffer(access.context(actor), audiences);
    }

    @GetMapping("/inbox")
    public List<Map<String, Object>> inbox(Actor actor) {
        return requests.inbox(access.context(actor));
    }

    @PostMapping("/{id}/decision")
    public Map<String, Object> decide(Actor actor, @PathVariable UUID id, @RequestBody AccessRequestService.Decide in) {
        return requests.decide(access.context(actor), id, in);
    }
}
