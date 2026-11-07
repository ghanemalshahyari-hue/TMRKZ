package ae.mover.authz;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.security.Actor;

/** Permissions studio: policy versions, scoped grants, explanations and the state of the OpenFGA sync. */
@RestController
@RequestMapping("/api/v1/access")
public class AccessController {

    private final AccessService access;
    private final AccessPolicyService policies;
    private final GrantAdminService grants;
    private final AuthzSync sync;

    public AccessController(AccessService access, AccessPolicyService policies, GrantAdminService grants, AuthzSync sync) {
        this.access = access;
        this.policies = policies;
        this.grants = grants;
        this.sync = sync;
    }

    public record NoteInput(String note) {
    }

    @GetMapping("/status")
    public Map<String, Object> status(Actor actor) {
        AccessContext ctx = access.context(actor);
        if (!ctx.has(Permission.MANAGE_ACCESS) && !ctx.has(Permission.CONFIGURE)) {
            throw ae.mover.common.ApiException.forbidden();
        }
        return sync.status();
    }

    /** Rebuilds the OpenFGA data from the database in a new store and switches to it (global access managers). */
    @PostMapping("/rebuild")
    public Map<String, Object> rebuild(Actor actor) {
        AccessContext ctx = access.context(actor);
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ae.mover.common.ApiException.forbidden("إعادة بناء بيانات الصلاحيات لمدير صلاحيات عام فقط.");
        }
        AuthzSync.Result r;
        try {
            r = sync.rebuild();
        } catch (FgaClient.FgaException e) {
            throw Authorization.unavailable();
        } catch (IllegalStateException e) {
            throw ae.mover.common.ApiException.validation("المخزن مثبت بالإعداد TMRKZ_OPENFGA_STORE_ID؛ أعد البناء من خلال التشغيل.");
        }
        Map<String, Object> out = new java.util.LinkedHashMap<>(sync.status());
        out.put("rebuiltTuples", r.written());
        out.put("rebuildMs", r.millis());
        return out;
    }

    @GetMapping("/policy/versions")
    public List<AccessPolicyService.VersionView> versions(Actor actor) {
        return policies.versions(access.context(actor));
    }

    @GetMapping("/policy/versions/{id}")
    public AccessPolicyService.VersionView version(Actor actor, @PathVariable UUID id) {
        return policies.version(access.context(actor), id);
    }

    @PostMapping("/policy/versions/{id}/restore")
    public AccessPolicyService.VersionView restore(Actor actor, @PathVariable UUID id, @RequestBody NoteInput in) {
        return policies.restore(access.context(actor), id, in == null ? null : in.note());
    }

    @PostMapping("/policy/draft")
    public AccessPolicyService.VersionView draft(Actor actor, @RequestBody(required = false) NoteInput in) {
        return policies.draft(access.context(actor), in == null ? null : in.note());
    }

    @PutMapping("/policy/draft/roles")
    public AccessPolicyService.VersionView saveRole(Actor actor, @RequestBody AccessPolicyService.RoleInput in) {
        return policies.saveDraftRole(access.context(actor), in);
    }

    @GetMapping("/policy/draft/impact")
    public AccessPolicyService.Impact impact(Actor actor) {
        return policies.impact(access.context(actor));
    }

    @PostMapping("/policy/draft/publish")
    public AccessPolicyService.VersionView publish(Actor actor, @RequestBody NoteInput in) {
        return policies.publish(access.context(actor), in == null ? null : in.note());
    }

    @PostMapping("/policy/draft/discard")
    public ResponseEntity<Void> discard(Actor actor, @RequestBody(required = false) NoteInput in) {
        policies.discard(access.context(actor), in == null ? null : in.note());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/explain")
    public Map<String, Object> explain(Actor actor, @RequestParam UUID personId,
                                       @RequestParam(required = false) UUID organizationId,
                                       @RequestParam(required = false) UUID siteId,
                                       @RequestParam(required = false) UUID resourceId) {
        return policies.explain(access.context(actor), personId, organizationId, siteId, resourceId);
    }

    @GetMapping("/scope-preview")
    public Map<String, Object> scopePreview(Actor actor, @RequestParam UUID organizationId,
                                            @RequestParam(required = false) Boolean descendants,
                                            @RequestParam(required = false) List<Integer> levels) {
        return grants.scopePreview(access.context(actor), organizationId, Boolean.TRUE.equals(descendants), levels);
    }

    @GetMapping("/grant-roots")
    public List<Map<String, Object>> grantRoots(Actor actor) {
        return grants.grantRoots(access.context(actor));
    }

    @GetMapping("/unit-matrix")
    public Map<String, Object> unitMatrix(Actor actor, @RequestParam UUID organizationId, @RequestParam(required = false) String q,
                                          @RequestParam(required = false) Integer page) {
        return grants.unitMatrix(access.context(actor), organizationId, q, page);
    }

    public record ReplaceInput(GrantAdminService.GrantInput grant, String reason) {
    }

    @PostMapping("/grants/{id}/replace")
    public Map<String, Object> replaceGrant(Actor actor, @PathVariable UUID id, @RequestBody ReplaceInput in) {
        return grants.replace(access.context(actor), id, in.grant(), in.reason());
    }

    @GetMapping("/unit-ops-routes")
    public List<Map<String, Object>> routes(Actor actor, @RequestParam UUID commandId) {
        return grants.routes(access.context(actor), commandId);
    }

    @PutMapping("/unit-ops-routes")
    public List<Map<String, Object>> saveRoutes(Actor actor, @RequestParam UUID commandId, @RequestBody List<GrantAdminService.RouteInput> in) {
        return grants.saveRoutes(access.context(actor), commandId, in);
    }

    @GetMapping("/fyi-mains")
    public List<Map<String, Object>> fyiMains(Actor actor) {
        return grants.fyiMains(access.context(actor));
    }

    @PutMapping("/fyi-mains/{id}")
    public ResponseEntity<Void> addFyiMain(Actor actor, @PathVariable UUID id) {
        grants.setFyiMain(access.context(actor), id, true);
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/fyi-mains/{id}")
    public ResponseEntity<Void> removeFyiMain(Actor actor, @PathVariable UUID id) {
        grants.setFyiMain(access.context(actor), id, false);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/grants")
    public List<GrantAdminService.GrantView> grants(Actor actor, @RequestParam(required = false) UUID organizationId,
                                                    @RequestParam(required = false) UUID personId,
                                                    @RequestParam(required = false) Boolean includeEnded) {
        return grants.list(access.context(actor), organizationId, personId, Boolean.TRUE.equals(includeEnded));
    }
}
