package ae.mover.stationing;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/**
 * Re-stationing requests of Model V3 (ADR-033): draft, checks, submission, stage decisions, activation. Every
 * operation is authorised on the server ({@link RestationingService}, {@link ae.mover.access.AccessContext} confirmed
 * by OpenFGA); the page only shows what the response allows.
 */
@RestController
@RequestMapping("/api/v1/restationing-requests")
public class RestationingController {

    private final AccessService access;
    private final RestationingService service;
    private final Clock clock;

    public RestationingController(AccessService access, RestationingService service, Clock clock) {
        this.access = access;
        this.service = service;
        this.clock = clock;
    }

    @GetMapping
    public List<Map<String, Object>> list(Actor actor, @RequestParam(required = false) String state) {
        return service.list(access.context(actor), state);
    }

    @PostMapping
    public Map<String, Object> create(Actor actor, @RequestBody RestationingService.CreateInput in) {
        var ctx = access.context(actor);
        UUID id = service.create(ctx, in, clock.instant());
        return service.view(ctx, id, clock.instant());
    }

    @GetMapping("/units")
    public List<Map<String, Object>> units(Actor actor) {
        return service.requestableUnits(access.context(actor));
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(Actor actor, @PathVariable UUID id) {
        return service.view(access.context(actor), id, clock.instant());
    }

    @PutMapping("/{id}/content")
    public Map<String, Object> edit(Actor actor, @PathVariable UUID id, @RequestBody RestationingService.ContentInput in) {
        var ctx = access.context(actor);
        service.edit(ctx, id, in, clock.instant());
        return service.view(ctx, id, clock.instant());
    }

    /** The submission checks of the current content (validation against the policy version, never a recommendation). */
    @GetMapping("/{id}/checks")
    public Map<String, Object> checks(Actor actor, @PathVariable UUID id) {
        return service.checks(access.context(actor), id, clock.instant());
    }

    /** First submission, resubmission after a return, or confirmation after a hierarchy change (reason required then). */
    @PostMapping("/{id}/submit")
    public Map<String, Object> submit(Actor actor, @PathVariable UUID id, @RequestBody(required = false) RestationingService.ReasonInput in) {
        var ctx = access.context(actor);
        service.submit(ctx, id, in, clock.instant());
        return service.view(ctx, id, clock.instant());
    }

    /** APPROVE, RETURN or REJECT on the current stage. */
    @PostMapping("/{id}/decision")
    public Map<String, Object> decide(Actor actor, @PathVariable UUID id, @RequestBody RestationingService.DecisionInput in) {
        var ctx = access.context(actor);
        service.decide(ctx, id, in, clock.instant());
        return service.view(ctx, id, clock.instant());
    }

    @PostMapping("/{id}/activate")
    public Map<String, Object> activate(Actor actor, @PathVariable UUID id, @RequestBody(required = false) RestationingService.ReasonInput in) {
        var ctx = access.context(actor);
        service.activate(ctx, id, in, clock.instant());
        return service.view(ctx, id, clock.instant());
    }
}
