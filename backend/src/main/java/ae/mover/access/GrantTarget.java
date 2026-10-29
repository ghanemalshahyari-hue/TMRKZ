package ae.mover.access;

import java.util.UUID;

/** One explicit target of a scoped grant: an organisation or site (alone or with its descendants), or a resource. */
public record GrantTarget(String kind, UUID id, boolean includeDescendants) {

    public static final String ORGANIZATION = "ORGANIZATION";
    public static final String SITE = "SITE";
    public static final String RESOURCE = "RESOURCE";
}
