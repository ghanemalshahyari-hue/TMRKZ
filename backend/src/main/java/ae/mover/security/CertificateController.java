package ae.mover.security;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;

/** «الشهادات» (ADR-105): inventory, check and preview, explicit application, restore. */
@RestController
@RequestMapping("/api/v1/settings/certificates")
public class CertificateController {

    private final AccessService access;
    private final CertificateService certificates;

    public CertificateController(AccessService access, CertificateService certificates) {
        this.access = access;
        this.certificates = certificates;
    }

    /** The certificate folders the running configuration uses, each service's trust, their health, and recent requests. */
    @GetMapping
    public Map<String, Object> overview(Actor actor) {
        return certificates.overview(access.context(actor));
    }

    /** Reads and checks the chosen files for one service; stages them when nothing failed; applies nothing. */
    @PostMapping("/check")
    public Map<String, Object> check(Actor actor, @RequestBody(required = false) CertificateService.CheckInput in) {
        return certificates.check(access.context(actor), in);
    }

    @GetMapping("/sessions/{id}")
    public Map<String, Object> view(Actor actor, @PathVariable String id) {
        return certificates.view(access.context(actor), id);
    }

    @PostMapping("/sessions/{id}/apply")
    public Map<String, Object> apply(Actor actor, @PathVariable String id, @RequestBody(required = false) CertificateService.ReasonInput in) {
        return certificates.apply(access.context(actor), id, in);
    }

    @PostMapping("/sessions/{id}/restore")
    public Map<String, Object> restore(Actor actor, @PathVariable String id, @RequestBody(required = false) CertificateService.ReasonInput in) {
        return certificates.restore(access.context(actor), id, in);
    }

    @PostMapping("/sessions/{id}/discard")
    public Map<String, Object> discard(Actor actor, @PathVariable String id) {
        return certificates.discard(access.context(actor), id);
    }
}
