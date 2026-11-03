package ae.mover.stationing;

import java.util.UUID;

/**
 * An organisational unit as Oracle delivers it through the read-only HR mirror: the local id of the projection, the
 * stable Oracle id ({@code externalId}, null for a local unit), the parent and the level value Oracle sends (null when
 * the mirror has none). The level is a value, never a fixed depth.
 */
public record OrgUnit(UUID id, String externalId, UUID parentId, Integer level, String code, String name) {
}
