package ae.mover.authz;

import java.util.List;
import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** «مديرو النظام» (ADR-103): list, resolve a verified identity, grant on confirmation, end with a reason. */
@RestController
@RequestMapping("/api/v1")
public class AdministratorController {

    private final AccessService access;
    private final AdministratorService administrators;

    public AdministratorController(AccessService access, AdministratorService administrators) {
        this.access = access;
        this.administrators = administrators;
    }

    @GetMapping("/administrators")
    public List<AdministratorService.AdminView> list(Actor actor) {
        return administrators.list(access.context(actor));
    }

    /** Which verified lookups this installation can make now, and why not when it cannot (ADR-105). */
    @GetMapping("/administrators/lookup-options")
    public AdministratorService.LookupOptions lookupOptions(Actor actor) {
        return administrators.lookupOptions(access.context(actor));
    }

    /** Finds and shows one identity (Oracle HR by employee number, or a directory-verified account); changes nothing. */
    @PostMapping("/administrators/resolve")
    public AdministratorService.Candidate resolve(Actor actor, @RequestBody(required = false) AdministratorService.ResolveInput in) {
        return administrators.resolve(access.context(actor), in);
    }

    /** Grants the role to the identity shown, when its confirmation fingerprint and a reason come back. */
    @PostMapping("/administrators")
    public AdministratorService.AdminView add(Actor actor, @RequestBody(required = false) AdministratorService.AddInput in) {
        return administrators.add(access.context(actor), in);
    }

    @PostMapping("/administrators/{personId}/end")
    public ResponseEntity<Void> end(Actor actor, @PathVariable UUID personId, @RequestBody(required = false) AdministratorService.EndInput in) {
        administrators.end(access.context(actor), personId, in);
        return ResponseEntity.noContent().build();
    }
}
