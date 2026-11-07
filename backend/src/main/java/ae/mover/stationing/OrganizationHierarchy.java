package ae.mover.stationing;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import ae.mover.common.Db;

/**
 * {@link OrgHierarchy} over the existing projection: {@code organization} (parent links, the Oracle id in
 * {@code source_external_id}) and the level from the PUBLISHED HR snapshot ({@code hr_unit.level}), because the
 * projection does not carry the level yet (gap G-O1). Read only; no schema of its own.
 */
@Repository
public class OrganizationHierarchy implements OrgHierarchy {

    /** The cycle guard of the HR sync stops below 64 levels; the walk uses the same bound. */
    private static final int MAX_DEPTH = 64;

    private final JdbcClient jdbc;

    public OrganizationHierarchy(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public Optional<OrgUnit> unit(UUID id) {
        return path(id).stream().findFirst();
    }

    @Override
    public List<OrgUnit> path(UUID id) {
        return jdbc.sql("""
                with recursive up as (
                  select o.id, o.parent_id, o.code, o.name, o.source_external_id, 0 as depth
                    from organization o where o.id = :id
                  union all
                  select p.id, p.parent_id, p.code, p.name, p.source_external_id, up.depth + 1
                    from organization p join up on p.id = up.parent_id
                   where up.depth < :max)
                select up.id, up.parent_id, up.code, up.name, up.source_external_id, h.level, coalesce(h.is_main, false) as is_main
                  from up
                  left join hr_unit h on h.external_id = up.source_external_id
                        and h.snapshot_id = (select s.id from hr_snapshot s where s.status = 'PUBLISHED')
                 order by up.depth""")
                .param("id", id).param("max", MAX_DEPTH)
                .query((rs, n) -> new OrgUnit(Db.uuid(rs, "id"), rs.getString("source_external_id"), Db.uuid(rs, "parent_id"),
                        (Integer) rs.getObject("level"), rs.getString("code"), rs.getString("name"), rs.getBoolean("is_main")))
                .list();
    }
}
