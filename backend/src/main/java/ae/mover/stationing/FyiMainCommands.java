package ae.mover.stationing;

import java.util.List;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * «الجهات الرئيسية للعلم», the one list of units informed after every final approval (ADR-042; one source since V69). The
 * screen of that name writes {@code fyi_main_command} through {@code GrantAdminService.setFyiMain}; this is the one way it is
 * read, by {@link PlaceInfo} for requests and by {@link RestationingService} for re-stationing, deployment areas and site
 * registration, so the screen and both distributions cannot drift apart again. {@code fyi_designation} (V64) is superseded
 * and read by nothing.
 */
public final class FyiMainCommands {

    private FyiMainCommands() {
    }

    /**
     * The units chosen, each with its active descendant units when it was chosen with «وما دونها», at this moment. A chosen
     * unit counts whatever its status, as before V69; below it only active units, and an inactive unit ends the walk down.
     */
    public static List<UUID> effectiveUnits(JdbcClient jdbc) {
        return jdbc.sql("""
                with recursive chosen(uid, deep) as (
                  select f.organization_id, f.include_descendants from fyi_main_command f
                  union
                  select o.id, true from organization o join chosen c on o.parent_id = c.uid
                   where c.deep and o.status = 'ACTIVE')
                select distinct uid from chosen""")
                .query(UUID.class).list();
    }
}
