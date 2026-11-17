package ae.mover.access;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.Db;

/**
 * Reads grants from the business database, the source of truth for authorisation. Used for the actor of each HTTP
 * request (grants in force now) and by the OpenFGA sync (every grant not yet ended, including future ones, whose
 * validity window travels with the tuple as a condition).
 */
@Component
public class GrantSource {

    /** A role definition that replaces the published one, for previewing a draft policy. */
    public record RoleOverride(String name, Set<Permission> permissions, String scope, boolean summaryOnly) {
    }

    private final JdbcClient jdbc;

    public GrantSource(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Grants of one person in force at {@code at}. */
    public List<RawGrant> current(UUID personId, Instant at, Map<String, RoleOverride> roles) {
        return load(personId, at, true, roles);
    }

    /** Grants not yet ended at {@code at}, of one person or (personId null) of everyone. */
    public List<RawGrant> unended(UUID personId, Instant at) {
        return load(personId, at, false, Map.of());
    }

    /** Grants of one role in force at {@code at}, of everyone: who a step found by scope can go to (ADR-042). */
    public List<RawGrant> ofRole(String roleCode, Instant at) {
        return load(null, roleCode, at, true, Map.of());
    }

    private List<RawGrant> load(UUID personId, Instant at, boolean startedOnly, Map<String, RoleOverride> roles) {
        return load(personId, null, at, startedOnly, roles);
    }

    private List<RawGrant> load(UUID personId, String roleCode, Instant at, boolean startedOnly, Map<String, RoleOverride> roles) {
        String started = (startedOnly ? " and %s.valid_from <= :at" : "") + " and (cast(:role as text) is null or r.code = :role)";
        List<Map<String, Object>> rows = jdbc.sql("""
                select m.id as grant_id, m.person_id, m.id as membership_id, null::uuid as delegation_id, null as delegator_name,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id as org_id, o.name as org_name, s.id as site_id, s.name as site_name,
                       m.scope_mode, m.scope_combine, m.scope_all, m.valid_from, m.valid_to, null::uuid as seat_id,
                       null::uuid as unit_grant_id
                from membership m
                join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id and o.status = 'ACTIVE'
                left join site s on s.id = m.site_scope_id
                join person p on p.id = m.person_id and p.status = 'ACTIVE' and not p.access_disabled
                where (cast(:pid as uuid) is null or m.person_id = :pid) and (m.valid_to is null or m.valid_to > :at)"""
                + started.formatted("m") + "\n" + """
                union all
                select d.id, d.delegate_id, m.id, d.id, dp.display_name,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id, o.name, s.id, s.name,
                       m.scope_mode, m.scope_combine, m.scope_all,
                       greatest(d.valid_from, m.valid_from),
                       case when m.valid_to is null or d.valid_to < m.valid_to then d.valid_to else m.valid_to end, null::uuid,
                       null::uuid
                from delegation d
                join membership m on m.id = d.membership_id
                join person dp on dp.id = d.delegator_id and dp.status = 'ACTIVE'
                join person dd on dd.id = d.delegate_id and dd.status = 'ACTIVE' and not dd.access_disabled
                join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id and o.status = 'ACTIVE'
                left join site s on s.id = m.site_scope_id
                where (cast(:pid as uuid) is null or d.delegate_id = :pid) and d.revoked_at is null and d.valid_to > :at
                  and (m.valid_to is null or m.valid_to > :at)""" + started.formatted("d") + (startedOnly ? " and m.valid_from <= :at" : "") + "\n" + """
                union all
                -- responsibility seats: the role follows whoever currently holds the HR position in the organisation — among the
                -- people added to the application only; HR alone gives nobody anything (owner, 16 Nov 2026, as MOVER)
                select null::uuid, a.person_id, null::uuid, null::uuid, null,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id, o.name, s.id, s.name,
                       'ROLE', 'AND', false, a.valid_from, a.valid_to, ps.id, null::uuid
                from affiliation a
                join position_seat ps on ps.organization_id = a.organization_id and ps.position_id = a.position_id and ps.active
                join role_def r on r.code = ps.role_code
                join organization o on o.id = ps.organization_id and o.status = 'ACTIVE'
                left join site s on s.id = ps.site_scope_id
                join person p on p.id = a.person_id and p.status = 'ACTIVE' and not p.access_disabled
                where (cast(:pid as uuid) is null or a.person_id = :pid) and (a.valid_to is null or a.valid_to > :at)
                  and exists (select 1 from unit_member um where um.person_id = a.person_id and um.ended_at is null)"""
                + started.formatted("a") + "\n" + """
                union all
                -- unit grants («موروثة من الوحدة», V36): every user added to the unit holds the role there, at the role's own reach;
                -- an HR posting alone is not membership (owner, 16 Nov 2026: a first sign-in holds nothing, as MOVER)
                select null::uuid, mem.person_id, null::uuid, null::uuid, null,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id, o.name, null::uuid, null,
                       'ROLE', 'AND', false, ug.valid_from, ug.valid_to, null::uuid, ug.id
                from unit_grant ug
                join role_def r on r.code = ug.role_code
                join organization o on o.id = ug.organization_id and o.status = 'ACTIVE'
                join (select person_id, organization_id from unit_member where ended_at is null) mem
                  on mem.organization_id = ug.organization_id
                join person p on p.id = mem.person_id and p.status = 'ACTIVE' and not p.access_disabled
                where (cast(:pid as uuid) is null or mem.person_id = :pid) and (ug.valid_to is null or ug.valid_to > :at)"""
                + started.formatted("ug") + "\n" + """
                union all
                -- duty permits («تصاريح المناوبة», V37): in force once activated by their holder, inside their window only
                select null::uuid, dp.person_id, null::uuid, null::uuid, null,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id, o.name, null::uuid, null,
                       'ROLE', 'AND', false, dp.valid_from, dp.valid_to, null::uuid, dp.id
                from duty_permit dp
                join role_def r on r.code = dp.role_code
                join organization o on o.id = dp.organization_id and o.status = 'ACTIVE'
                join person p on p.id = dp.person_id and p.status = 'ACTIVE' and not p.access_disabled
                where (cast(:pid as uuid) is null or dp.person_id = :pid) and dp.activated_at is not null and dp.ended_at is null
                  and dp.valid_to > :at"""
                + started.formatted("dp") + "\n" + """
                order by 2, 4 nulls first, 6""")
                .param("pid", personId).param("at", Db.ts(at)).param("role", roleCode)
                .query().listOfRows();
        List<UUID> custom = rows.stream().filter(r -> "CUSTOM".equals(r.get("scope_mode")))
                .map(r -> (UUID) r.get("membership_id")).distinct().toList();
        Map<UUID, List<GrantTarget>> targets = targets(custom);
        List<RawGrant> out = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) {
            UUID person = (UUID) row.get("person_id");
            UUID seat = (UUID) row.get("seat_id");
            UUID unitGrant = (UUID) row.get("unit_grant_id");
            UUID grantId = seat != null ? UUID.nameUUIDFromBytes(("seat:" + seat + ":" + person).getBytes(StandardCharsets.UTF_8))
                    : unitGrant != null ? UUID.nameUUIDFromBytes(("unit:" + unitGrant + ":" + person).getBytes(StandardCharsets.UTF_8))
                    : (UUID) row.get("grant_id");
            String code = (String) row.get("code");
            RoleOverride o = roles.get(code);
            UUID membership = (UUID) row.get("membership_id");
            out.add(new RawGrant(grantId, person, membership, (UUID) row.get("delegation_id"),
                    (String) row.get("delegator_name"), code, o == null ? (String) row.get("name") : o.name(),
                    o == null ? permissions(row.get("permissions")) : o.permissions(),
                    o == null ? (String) row.get("scope") : o.scope(),
                    o == null ? (Boolean) row.get("summary_only") : o.summaryOnly(),
                    (UUID) row.get("org_id"), (String) row.get("org_name"), (UUID) row.get("site_id"), (String) row.get("site_name"),
                    (String) row.get("scope_mode"), "AND".equals(row.get("scope_combine")), (Boolean) row.get("scope_all"),
                    Db.toInstant(row.get("valid_from")), Db.toInstant(row.get("valid_to")),
                    membership == null ? List.of() : targets.getOrDefault(membership, List.of())));
        }
        return out;
    }

    public Map<UUID, List<GrantTarget>> targets(List<UUID> membershipIds) {
        Map<UUID, List<GrantTarget>> out = new HashMap<>();
        if (membershipIds.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                select membership_id, kind, target_id, include_descendants, array_to_string(levels, ',') as levels from membership_scope_target
                where membership_id = any(string_to_array(:ids, ',')::uuid[]) order by kind, target_id""")
                .param("ids", Db.ids(membershipIds))
                .query((rs, n) -> {
                    UUID target = Db.uuid(rs, "target_id");
                    List<Integer> levels = levels(rs.getString("levels"));
                    return out.computeIfAbsent(Db.uuid(rs, "membership_id"), k -> new ArrayList<>())
                            .add(levels.isEmpty() ? new GrantTarget(rs.getString("kind"), target, rs.getBoolean("include_descendants"))
                                    : new GrantTarget(rs.getString("kind"), target, true, levels, reach(target, levels)));
                })
                .list();
        return out;
    }

    private static List<Integer> levels(String text) {
        return text == null || text.isBlank() ? List.of() : java.util.Arrays.stream(text.split(",")).map(Integer::valueOf).toList();
    }

    /** The active units at these levels of the published hierarchy, at or below {@code root} (ADR-042). */
    public Set<UUID> reach(UUID root, List<Integer> levels) {
        return new java.util.HashSet<>(jdbc.sql("""
                with recursive t(id) as (
                  select id from organization where id = :root
                  union select o.id from organization o join t on o.parent_id = t.id)
                select o.id from t join organization o on o.id = t.id and o.status = 'ACTIVE'
                join hr_unit h on h.external_id = o.source_external_id and h.snapshot_id = (select s.id from hr_snapshot s where s.status = 'PUBLISHED')
                where h.level = any(string_to_array(:levels, ',')::int[])""")
                .param("root", root)
                .param("levels", String.join(",", levels.stream().map(String::valueOf).toList()))
                .query(UUID.class).list());
    }

    /**
     * A role's stored action names as actions. A name that is no longer an action (retired by ADR-078, or written by hand) gives
     * nothing and never fails the request: V49 removed them from every role, and an old policy version is translated when it is
     * brought back ({@link Permission#current}).
     */
    static Set<Permission> permissions(Object value) {
        EnumSet<Permission> set = EnumSet.noneOf(Permission.class);
        try {
            Object[] items = (Object[]) ((java.sql.Array) value).getArray();
            for (Object item : items) {
                Permission.parse(String.valueOf(item)).ifPresent(set::add);
            }
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
        return set;
    }
}
