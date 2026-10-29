package ae.mover.authz;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import ae.mover.access.GrantTarget;
import ae.mover.access.Permission;
import ae.mover.access.RawGrant;

/** Translates one stored grant into OpenFGA tuples (the same {@link RawGrant#spec()} the in-process evaluation uses). */
final class AuthzTuples {

    private AuthzTuples() {
    }

    /**
     * Tuples of a grant. {@code resourceSites} maps resource targets to their sites. The scope limits of one grant are
     * kept together: an AND grant places its organisations as objects and checks its sites in the holder condition,
     * so a site reached by another grant can never complete it.
     */
    static List<FgaClient.Tuple> of(RawGrant g, Map<UUID, UUID> resourceSites) {
        RawGrant.Spec spec = g.spec();
        Set<Permission> actions = g.effectivePermissions();
        String holder = "grant:" + g.grantId() + "#holder";
        List<FgaClient.Tuple> out = new ArrayList<>();
        List<String> here = new ArrayList<>();
        List<String> tree = new ArrayList<>();
        for (GrantTarget t : spec.sites()) {
            (t.includeDescendants() ? tree : here).add(t.id().toString());
        }
        List<String> resources = spec.resources().stream().map(UUID::toString).toList();
        List<String> holdingSites = spec.resources().stream().map(resourceSites::get).filter(java.util.Objects::nonNull)
                .map(UUID::toString).distinct().toList();

        Map<String, Object> cond = new LinkedHashMap<>();
        Instant from = g.validFrom() == null ? Instant.EPOCH : g.validFrom();
        cond.put("valid_from", from.toString());
        cond.put("valid_to", (g.validTo() == null ? from : g.validTo()).toString());
        cond.put("open_ended", g.validTo() == null);
        cond.put("role", g.roleCode());
        cond.put("site_limited", spec.siteLimited());
        cond.put("sites_here", here);
        cond.put("sites_tree", tree);
        cond.put("resources", resources);
        cond.put("resource_sites", holdingSites);
        out.add(new FgaClient.Tuple("grant:" + g.grantId(), "holder", "user:" + g.personId(), cond));

        for (Permission p : actions) {
            String a = AuthzModel.rel(p);
            out.add(new FgaClient.Tuple(AuthzModel.SYSTEM, a + "_any", holder, null));
            if (spec.all()) {
                out.add(new FgaClient.Tuple(AuthzModel.SYSTEM, a, holder, null));
                continue;
            }
            for (GrantTarget t : spec.orgs()) {
                out.add(new FgaClient.Tuple("organization:" + t.id(), a + (t.includeDescendants() ? "_tree" : "_here"), holder, null));
            }
            if (spec.siteConstraint() && !(spec.and() && spec.orgConstraint())) {
                for (GrantTarget t : spec.sites()) {
                    out.add(new FgaClient.Tuple("site:" + t.id(), a + (t.includeDescendants() ? "_tree" : "_here"), holder, null));
                }
                for (String r : resources) {
                    out.add(new FgaClient.Tuple("resource:" + r, a + "_here", holder, null));
                }
                for (String s : holdingSites) {
                    out.add(new FgaClient.Tuple("site:" + s, a + "_contains", holder, null));
                }
            }
            if (!spec.orgConstraint()) {
                // limited by site only: the grant still acts for its own organisation (its site limit applies to content)
                out.add(new FgaClient.Tuple("organization:" + g.orgId(), a + "_here", holder, null));
            }
        }
        if (actions.contains(Permission.VIEW) || actions.contains(Permission.VIEW_SUMMARY)) {
            out.add(new FgaClient.Tuple("organization:" + g.orgId(), "info_member", holder, null));
        }
        return out;
    }
}
