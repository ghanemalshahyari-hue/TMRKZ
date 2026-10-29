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

    private List<RawGrant> load(UUID personId, Instant at, boolean startedOnly, Map<String, RoleOverride> roles) {
        String started = startedOnly ? " and %s.valid_from <= :at" : "";
        List<Map<String, Object>> rows = jdbc.sql("""
                select m.id as grant_id, m.person_id, m.id as membership_id, null::uuid as delegation_id, null as delegator_name,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id as org_id, o.name as org_name, s.id as site_id, s.name as site_name,
                       m.scope_mode, m.scope_combine, m.scope_all, m.valid_from, m.valid_to, null::uuid as seat_id
                from membership m
                join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id and o.status = 'ACTIVE'
                left join site s on s.id = m.site_scope_id
                join person p on p.id = m.person_id and p.status = 'ACTIVE'
                where (cast(:pid as uuid) is null or m.person_id = :pid) and (m.valid_to is null or m.valid_to > :at)"""
                + started.formatted("m") + "\n" + """
                union all
                select d.id, d.delegate_id, m.id, d.id, dp.display_name,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id, o.name, s.id, s.name,
                       m.scope_mode, m.scope_combine, m.scope_all,
                       greatest(d.valid_from, m.valid_from),
                       case when m.valid_to is null or d.valid_to < m.valid_to then d.valid_to else m.valid_to end, null::uuid
                from delegation d
                join membership m on m.id = d.membership_id
                join person dp on dp.id = d.delegator_id and dp.status = 'ACTIVE'
                join person dd on dd.id = d.delegate_id and dd.status = 'ACTIVE'
                join role_def r on r.code = m.role_code
                join organization o on o.id = m.organization_id and o.status = 'ACTIVE'
                left join site s on s.id = m.site_scope_id
                where (cast(:pid as uuid) is null or d.delegate_id = :pid) and d.revoked_at is null and d.valid_to > :at
                  and (m.valid_to is null or m.valid_to > :at)""" + started.formatted("d") + started.formatted("m") + "\n" + """
                union all
                -- responsibility seats: the role follows whoever currently holds the HR position in the organisation
                select null::uuid, a.person_id, null::uuid, null::uuid, null,
                       r.code, r.name, r.permissions, r.scope, r.summary_only,
                       o.id, o.name, s.id, s.name,
                       'ROLE', 'AND', false, a.valid_from, a.valid_to, ps.id
                from affiliation a
                join position_seat ps on ps.organization_id = a.organization_id and ps.position_id = a.position_id and ps.active
                join role_def r on r.code = ps.role_code
                join organization o on o.id = ps.organization_id and o.status = 'ACTIVE'
                left join site s on s.id = ps.site_scope_id
                join person p on p.id = a.person_id and p.status = 'ACTIVE'
                where (cast(:pid as uuid) is null or a.person_id = :pid) and (a.valid_to is null or a.valid_to > :at)"""
                + started.formatted("a") + "\n" + """
                order by 2, 4 nulls first, 6""")
                .param("pid", personId).param("at", Db.ts(at))
                .query().listOfRows();
        List<UUID> custom = rows.stream().filter(r -> "CUSTOM".equals(r.get("scope_mode")))
                .map(r -> (UUID) r.get("membership_id")).distinct().toList();
        Map<UUID, List<GrantTarget>> targets = targets(custom);
        List<RawGrant> out = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) {
            UUID person = (UUID) row.get("person_id");
            UUID seat = (UUID) row.get("seat_id");
            UUID grantId = seat == null ? (UUID) row.get("grant_id")
                    : UUID.nameUUIDFromBytes(("seat:" + seat + ":" + person).getBytes(StandardCharsets.UTF_8));
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
                select membership_id, kind, target_id, include_descendants from membership_scope_target
                where membership_id = any(string_to_array(:ids, ',')::uuid[]) order by kind, target_id""")
                .param("ids", Db.ids(membershipIds))
                .query((rs, n) -> out.computeIfAbsent(Db.uuid(rs, "membership_id"), k -> new ArrayList<>())
                        .add(new GrantTarget(rs.getString("kind"), Db.uuid(rs, "target_id"), rs.getBoolean("include_descendants"))))
                .list();
        return out;
    }

    static Set<Permission> permissions(Object value) {
        EnumSet<Permission> set = EnumSet.noneOf(Permission.class);
        try {
            Object[] items = (Object[]) ((java.sql.Array) value).getArray();
            for (Object item : items) {
                set.add(Permission.valueOf(String.valueOf(item)));
            }
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
        return set;
    }
}
