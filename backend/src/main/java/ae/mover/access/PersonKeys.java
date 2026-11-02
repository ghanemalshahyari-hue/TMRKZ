package ae.mover.access;

import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.Db;

/**
 * The keys a human signs in with, across person records (ADR-027): employee number, account, HR domain account of the
 * published snapshot, the key claimed by every sign-in an administrator linked to the record, and the login of a
 * temporary first administrator (so it and the HR record that later replaces it are one human). Two records sharing a
 * key are the same human — e.g. a duplicate HR record or a sign-in claiming one person's key linked to another — so
 * separation of duties and identity linking compare humans, not record identifiers. Keys compare case-insensitively.
 */
@Component
public class PersonKeys {

    /** Keys of the given person records (lower case), and every record holding one of them. */
    private static final String KEYS = """
            with base as (select unnest(string_to_array(:ids, ',')::uuid[]) as id),
            keys as (
              select p.id, lower(p.employee_no) as k from person p join base on base.id = p.id
              union select p.id, lower(p.username) from person p join base on base.id = p.id where p.username is not null
              union select p.id, lower(h.domain_account) from person p join base on base.id = p.id
                    join hr_person h on h.external_id = p.source_external_id and h.domain_account is not null
                    join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED'
                    where p.source = 'HR'
              union select i.resolved_person_id, lower(i.claimed_key) from identity_link_issue i join base on base.id = i.resolved_person_id
                    where i.resolution = 'LINKED' and i.claimed_key is not null
              union select b.person_id, lower(b.login) from bootstrap_admin b join base on base.id = b.person_id)
            """;

    private static final String HOLDERS = """
            holders(other, k) as (
              select p.id, lower(p.employee_no) from person p where lower(p.employee_no) in (select k from wanted)
              union select p.id, lower(p.username) from person p where lower(p.username) in (select k from wanted)
              union select p.id, lower(h.domain_account) from hr_person h
                    join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED'
                    join person p on p.source = 'HR' and p.source_external_id = h.external_id
                    where lower(h.domain_account) in (select k from wanted)
              union select i.resolved_person_id, lower(i.claimed_key) from identity_link_issue i
                    where i.resolution = 'LINKED' and lower(i.claimed_key) in (select k from wanted)
              union select b.person_id, lower(b.login) from bootstrap_admin b
                    where b.person_id is not null and lower(b.login) in (select k from wanted))
            """;

    private final JdbcClient jdbc;

    public PersonKeys(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Whether two records are the same human. */
    public boolean same(UUID a, UUID b) {
        return a.equals(b) || samePeople(java.util.List.of(a)).get(a).contains(b);
    }

    /** Each given record with every record of the same human (itself included). */
    public Map<UUID, Set<UUID>> samePeople(Collection<UUID> persons) {
        Map<UUID, Set<UUID>> out = new HashMap<>();
        for (UUID p : persons) {
            out.computeIfAbsent(p, k -> new HashSet<>()).add(p);
        }
        if (persons.isEmpty()) {
            return out;
        }
        jdbc.sql(KEYS + ", wanted as (select k from keys), " + HOLDERS + """
                select keys.id as person, holders.other from keys join holders on holders.k = keys.k""")
                .param("ids", Db.ids(persons))
                .query((rs, n) -> out.computeIfAbsent(Db.uuid(rs, "person"), k -> new HashSet<>()).add(Db.uuid(rs, "other")))
                .list();
        return out;
    }

    /** The records holding each key (lower-cased keys; a key nobody holds is absent). */
    public Map<String, Set<UUID>> holders(Collection<String> keys) {
        Map<String, Set<UUID>> out = new HashMap<>();
        List<String> wanted = keys.stream().filter(k -> k != null && !k.isBlank())
                .map(k -> k.trim().toLowerCase(java.util.Locale.ROOT)).distinct().toList();
        if (wanted.isEmpty()) {
            return out;
        }
        // unit separator: a claimed key comes from the directory and may contain any printable character
        jdbc.sql("with wanted(k) as (select unnest(string_to_array(:keys, chr(31)))), " + HOLDERS + "select other, k from holders")
                .param("keys", String.join("\u001f", wanted))
                .query((rs, n) -> out.computeIfAbsent(rs.getString("k"), k -> new HashSet<>()).add(Db.uuid(rs, "other")))
                .list();
        return out;
    }
}
