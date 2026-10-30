package ae.mover.facilities;

import java.util.List;
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

/** Stationing proposal on the map (ADR-025): distance rules, the interactive check and the organisations a move covers. */
@RestController
@RequestMapping("/api/v1/placement")
public class PlacementController {

    private final AccessService access;
    private final PlacementService placement;

    public PlacementController(AccessService access, PlacementService placement) {
        this.access = access;
        this.placement = placement;
    }

    @GetMapping("/rules")
    public List<PlacementService.Rule> rules(Actor actor) {
        return placement.rules(access.context(actor));
    }

    @PostMapping("/rules")
    public PlacementService.Rule createRule(Actor actor, @RequestBody PlacementService.RuleInput in) {
        return placement.saveRule(access.context(actor), null, in);
    }

    @PutMapping("/rules/{id}")
    public PlacementService.Rule saveRule(Actor actor, @PathVariable UUID id, @RequestBody PlacementService.RuleInput in) {
        return placement.saveRule(access.context(actor), id, in);
    }

    /** Preview while the marker is dragged; reads only. */
    @PostMapping("/check")
    public PlacementService.Check check(Actor actor, @RequestBody PlacementService.CheckInput in) {
        return placement.check(access.context(actor), in);
    }

    @GetMapping("/units")
    public List<PlacementService.Unit> units(Actor actor, @RequestParam UUID orgId, @RequestParam UUID siteId) {
        return placement.units(access.context(actor), orgId, siteId);
    }
}
