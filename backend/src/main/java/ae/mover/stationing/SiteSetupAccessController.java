package ae.mover.stationing;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** «الإعدادات → صلاحيات تهيئة المواقع» (phase 7; ADR-089): the rule, and whether the person may set up sites. */
@RestController
@RequestMapping("/api/v1")
public class SiteSetupAccessController {

    private final AccessService access;
    private final SiteSetupAccess rule;

    public SiteSetupAccessController(AccessService access, SiteSetupAccess rule) {
        this.access = access;
        this.rule = rule;
    }

    /** The setup screen: may this person set up sites (each unit is checked again on the save). */
    @GetMapping("/site-setup/access")
    public Map<String, Object> mine(Actor actor) {
        return rule.mine(access.context(actor));
    }

    @GetMapping("/settings/site-setup-access")
    public Map<String, Object> forSettings(Actor actor) {
        return rule.forSettings(access.context(actor));
    }

    @PutMapping("/settings/site-setup-access")
    public Map<String, Object> save(Actor actor, @RequestBody SiteSetupAccess.SaveInput in) {
        return rule.save(access.context(actor), in);
    }
}
