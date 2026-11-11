package ae.mover.authz;

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

/** «إدارة الصلاحيات والوحدات» (ADR-058): the access workspace. Every call needs MANAGE_ACCESS and stays inside its reach. */
@RestController
@RequestMapping("/api/v1/access/workspace")
public class AccessWorkspaceController {

    private final AccessService access;
    private final AccessWorkspaceService workspace;

    public AccessWorkspaceController(AccessService access, AccessWorkspaceService workspace) {
        this.access = access;
        this.workspace = workspace;
    }

    /** Units in reach, their people, the active among them, and the rows of a page. */
    @GetMapping("/summary")
    public Map<String, Object> summary(Actor actor) {
        return workspace.summary(access.context(actor));
    }

    /** The top of the reach, or the children of a unit, each with its sub-units and people. */
    @GetMapping("/tree")
    public List<Map<String, Object>> tree(Actor actor, @RequestParam(required = false) UUID parent) {
        return workspace.tree(access.context(actor), parent);
    }

    /** Units (kind=UNITS) or people (kind=PEOPLE) by name or number, each with its path. */
    @GetMapping("/search")
    public List<Map<String, Object>> search(Actor actor, @RequestParam String q, @RequestParam(defaultValue = "UNITS") String kind) {
        return workspace.search(access.context(actor), q, kind);
    }

    /** «ملف الوحدة» with the roles its members inherit. */
    @GetMapping("/units/{id}")
    public Map<String, Object> unit(Actor actor, @PathVariable UUID id) {
        return workspace.unit(access.context(actor), id);
    }

    /** Gives a role to every member of the unit, or ends it. */
    @PutMapping("/units/{id}/inherited")
    public Map<String, Object> setUnitGrant(Actor actor, @PathVariable UUID id, @RequestBody AccessWorkspaceService.UnitGrantInput in) {
        return workspace.setUnitGrant(access.context(actor), id, in);
    }

    /** The unit's matrix, 25 people a page, every cell with its state. */
    @GetMapping("/units/{id}/matrix")
    public Map<String, Object> matrix(Actor actor, @PathVariable UUID id, @RequestParam(required = false) String q,
                                      @RequestParam(required = false) Integer page, @RequestParam(required = false) String role) {
        return workspace.matrix(access.context(actor), id, q, page, role);
    }

    /** Reviews the pending changes without saving: refusals, counts and the fingerprint to save with. */
    @PostMapping("/units/{id}/preview")
    public Map<String, Object> preview(Actor actor, @PathVariable UUID id, @RequestBody AccessWorkspaceService.Batch batch) {
        return workspace.preview(access.context(actor), id, batch);
    }

    /** «حفظ التعديلات»: all of the reviewed changes, or none, under one audit reference. */
    @PostMapping("/units/{id}/apply")
    public Map<String, Object> apply(Actor actor, @PathVariable UUID id, @RequestBody AccessWorkspaceService.Batch batch) {
        return workspace.apply(access.context(actor), id, batch);
    }

    /** «مصفوفة التدقيق»: the unit's permission changes, newest first. */
    @GetMapping("/units/{id}/history")
    public Map<String, Object> history(Actor actor, @PathVariable UUID id, @RequestParam(required = false) Integer page) {
        return workspace.history(access.context(actor), id, page);
    }
}
