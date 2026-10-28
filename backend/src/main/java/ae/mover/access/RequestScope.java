package ae.mover.access;

import java.util.Set;
import java.util.UUID;

/**
 * The organisations and sites a request relates to. Responsible organisations of the requested facilities are
 * included because the facility's administering body has a legitimate relation to the request.
 */
public record RequestScope(
        UUID requestId,
        UUID createdBy,
        String status,
        UUID ownerOrgId,
        Set<UUID> participantOrgs,
        Set<UUID> infoOrgs,
        Set<UUID> resourceOrgs,
        Set<UUID> siteIds) {

    public Set<UUID> relatedOrgs() {
        java.util.HashSet<UUID> all = new java.util.HashSet<>();
        all.add(ownerOrgId);
        all.addAll(participantOrgs);
        all.addAll(resourceOrgs);
        return all;
    }

    public boolean decided() {
        return "APPROVED".equals(status) || "CLOSED".equals(status);
    }
}
