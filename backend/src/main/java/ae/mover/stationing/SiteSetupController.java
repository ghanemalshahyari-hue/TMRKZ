package ae.mover.stationing;

import java.util.Map;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/**
 * «موقع جديد» of «تهيئة المواقع والتمركز» (ADR-067): the site, its initial stationing and the deployment areas of each unit
 * stationed there, saved as one audited act by the setup administrator; and the same checks beforehand, writing nothing.
 */
@RestController
@RequestMapping("/api/v1")
public class SiteSetupController {

    private final AccessService access;
    private final SiteSetupService setup;

    public SiteSetupController(AccessService access, SiteSetupService setup) {
        this.access = access;
        this.setup = setup;
    }

    @PostMapping("/site-setup")
    public Map<String, Object> bootstrap(Actor actor, @RequestBody SiteSetupService.SetupInput in,
                                         @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return setup.setup(access.context(actor), in, key);
    }

    /** «مراجعة وحفظ»: what the save would refuse, unit by unit, with the legs as every request shows them. Nothing is kept. */
    @PostMapping("/site-setup/check")
    public Map<String, Object> check(Actor actor, @RequestBody SiteSetupService.SetupInput in) {
        return setup.check(access.context(actor), in);
    }
}
