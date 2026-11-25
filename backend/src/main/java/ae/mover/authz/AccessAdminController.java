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
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessRights;
import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** ADR-059: the rights of an access manager, duty permits, the account card and the providing departments. */
@RestController
@RequestMapping("/api/v1")
public class AccessAdminController {

    private final AccessService access;
    private final AccessAdminService admin;

    public AccessAdminController(AccessService access, AccessAdminService admin) {
        this.access = access;
        this.admin = admin;
    }

    /** The ten rights of «مسؤول إدارة الوصول والصلاحيات», with their labels and which a new grant starts with. */
    @GetMapping("/access/rights-catalogue")
    public List<Map<String, Object>> rightsCatalogue() {
        return AccessRights.catalogue();
    }

    @GetMapping("/access/workspace/units/{id}/permits")
    public List<Map<String, Object>> permits(Actor actor, @PathVariable UUID id) {
        return admin.permits(access.context(actor), id);
    }

    @PostMapping("/access/permits")
    public Map<String, Object> issue(Actor actor, @RequestBody AccessAdminService.PermitInput in) {
        return admin.issue(access.context(actor), in);
    }

    @PostMapping("/access/permits/{id}/end")
    public Map<String, Object> endPermit(Actor actor, @PathVariable UUID id, @RequestBody(required = false) AccessAdminService.EndInput in) {
        return admin.endPermit(access.context(actor), id, in);
    }

    /** The signed-in person's own duty permits, to activate at the start of the duty. */
    @GetMapping("/me/permits")
    public List<Map<String, Object>> myPermits(Actor actor) {
        return admin.mine(access.context(actor));
    }

    @PostMapping("/me/permits/{id}/activate")
    public Map<String, Object> activate(Actor actor, @PathVariable UUID id) {
        return admin.activate(access.context(actor), id);
    }

    @PostMapping("/me/permits/{id}/end")
    public Map<String, Object> endMine(Actor actor, @PathVariable UUID id, @RequestBody(required = false) AccessAdminService.EndInput in) {
        return admin.endPermit(access.context(actor), id, in);
    }

    /** «بطاقة الحساب». */
    @GetMapping("/access/workspace/people/{id}")
    public Map<String, Object> card(Actor actor, @PathVariable UUID id) {
        return admin.card(access.context(actor), id);
    }

    @PutMapping("/access/workspace/people/{id}/active")
    public Map<String, Object> active(Actor actor, @PathVariable UUID id, @RequestBody AccessAdminService.ActiveInput in) {
        return admin.setActive(access.context(actor), id, in);
    }

    @PutMapping("/access/workspace/people/{id}/profile")
    public Map<String, Object> profile(Actor actor, @PathVariable UUID id, @RequestBody AccessAdminService.ProfileInput in) {
        return admin.profile(access.context(actor), id, in);
    }

    @PostMapping("/access/workspace/people/{id}/retire")
    public Map<String, Object> retire(Actor actor, @PathVariable UUID id, @RequestBody AccessAdminService.EndInput in) {
        return admin.retire(access.context(actor), id, in);
    }

    /** «إعادة الحساب» of a local account ended by «حذف الحساب» (ADR-103). */
    @PostMapping("/access/workspace/people/{id}/reinstate")
    public Map<String, Object> reinstate(Actor actor, @PathVariable UUID id, @RequestBody AccessAdminService.EndInput in) {
        return admin.reinstate(access.context(actor), id, in);
    }

    @GetMapping("/access/workspace/departments")
    public List<Map<String, Object>> departments(Actor actor) {
        return admin.departments(access.context(actor));
    }

    @PostMapping("/access/workspace/departments")
    public List<Map<String, Object>> addDepartment(Actor actor, @RequestBody AccessAdminService.DepartmentInput in) {
        return admin.addDepartment(access.context(actor), in);
    }

    @GetMapping("/access/workspace/units/{id}/providers")
    public List<String> providers(Actor actor, @PathVariable UUID id) {
        return admin.providers(access.context(actor), id);
    }

    @PutMapping("/access/workspace/units/{id}/providers")
    public List<String> setProvider(Actor actor, @PathVariable UUID id, @RequestBody AccessAdminService.ProviderInput in) {
        return admin.setProvider(access.context(actor), id, in);
    }
}
