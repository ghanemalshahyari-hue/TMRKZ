package ae.mover.stationing;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** Deleting a site and asking for it (ADR-086). */
@RestController
@RequestMapping("/api/v1")
public class SiteDeletionController {

    private final AccessService access;
    private final SiteDeletionService deletion;

    public SiteDeletionController(AccessService access, SiteDeletionService deletion) {
        this.access = access;
        this.deletion = deletion;
    }

    /** What deleting the site takes and what stops it; nothing is written. */
    @GetMapping("/sites/{id}/deletion")
    public Map<String, Object> impact(Actor actor, @PathVariable UUID id) {
        return deletion.impact(access.context(actor), id);
    }

    /** «حذف الموقع» (the setup administrator). */
    @PostMapping("/sites/{id}/deletion")
    public Map<String, Object> delete(Actor actor, @PathVariable UUID id, @RequestBody SiteDeletionService.ReasonInput in) {
        return deletion.delete(access.context(actor), id, in);
    }

    /** «طلب حذف» (whoever manages the site). */
    @PostMapping("/sites/{id}/deletion-requests")
    public Map<String, Object> request(Actor actor, @PathVariable UUID id, @RequestBody SiteDeletionService.ReasonInput in) {
        return deletion.request(access.context(actor), id, in);
    }

    @GetMapping("/site-deletion-requests")
    public List<Map<String, Object>> list(Actor actor) {
        return deletion.list(access.context(actor));
    }

    @PostMapping("/site-deletion-requests/{id}/decision")
    public Map<String, Object> decide(Actor actor, @PathVariable UUID id, @RequestBody SiteDeletionService.DecisionInput in) {
        return deletion.decide(access.context(actor), id, in);
    }
}
