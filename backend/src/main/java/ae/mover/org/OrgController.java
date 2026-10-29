package ae.mover.org;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.common.PageResult;
import ae.mover.security.Actor;

@RestController
@RequestMapping("/api/v1")
public class OrgController {

    private final AccessService access;
    private final OrganizationService orgs;

    public OrgController(AccessService access, OrganizationService orgs) {
        this.access = access;
        this.orgs = orgs;
    }

    public record EndInput(String endAt, String reason) {
    }

    public record RevokeInput(String reason) {
    }

    @GetMapping("/organizations/tree")
    public List<OrganizationService.OrgNode> tree(Actor actor) {
        return orgs.tree(access.context(actor));
    }

    @GetMapping("/organizations/{id}")
    public OrganizationService.OrgDetail organization(Actor actor, @PathVariable UUID id) {
        return orgs.detail(access.context(actor), id);
    }

    @GetMapping("/organizations/roots")
    public List<OrganizationService.OrgBranch> roots(Actor actor) {
        return orgs.roots(access.context(actor));
    }

    @GetMapping("/organizations/search")
    public List<OrganizationService.OrgBranch> search(Actor actor, @RequestParam(required = false) String q) {
        return orgs.search(access.context(actor), q);
    }

    @GetMapping("/organizations/{id}/children")
    public List<OrganizationService.OrgBranch> children(Actor actor, @PathVariable UUID id) {
        return orgs.branchChildren(access.context(actor), id);
    }

    @GetMapping("/people")
    public PageResult<Map<String, Object>> people(Actor actor, @RequestParam(required = false) String q,
                                                  @RequestParam(required = false) Integer page,
                                                  @RequestParam(required = false) Integer size) {
        return orgs.people(access.context(actor), q, page, size);
    }

    @PostMapping("/memberships")
    public Map<String, Object> addMembership(Actor actor, @RequestBody OrganizationService.MembershipInput in) {
        return orgs.addMembership(access.context(actor), in);
    }

    @PostMapping("/memberships/{id}/end")
    public Map<String, Object> endMembership(Actor actor, @PathVariable UUID id, @RequestBody EndInput in) {
        return orgs.endMembership(access.context(actor), id, in.endAt(), in.reason());
    }

    @GetMapping("/delegations")
    public List<OrganizationService.DelegationView> delegations(Actor actor) {
        return orgs.delegations(access.context(actor));
    }

    @PostMapping("/delegations")
    public Map<String, Object> delegate(Actor actor, @RequestBody OrganizationService.DelegationInput in) {
        return orgs.delegate(access.context(actor), in);
    }

    @PostMapping("/delegations/{id}/revoke")
    public ResponseEntity<Void> revoke(Actor actor, @PathVariable UUID id, @RequestBody RevokeInput in) {
        orgs.revokeDelegation(access.context(actor), id, in.reason());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/roles")
    public List<OrganizationService.RoleDef> roles(Actor actor) {
        return orgs.roles(access.context(actor));
    }

    @PutMapping("/roles/{code}")
    public OrganizationService.RoleDef updateRole(Actor actor, @PathVariable String code, @RequestBody OrganizationService.RoleInput in) {
        return orgs.updateRole(access.context(actor), code, in);
    }
}
