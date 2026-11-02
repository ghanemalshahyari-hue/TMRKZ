package ae.mover.access;

import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.Db;

/**
 * The people an access manager may see and act on (ADR-027). A global access manager reaches everyone. A scoped one
 * reaches <em>members</em> — people affiliated with, or holding a current grant homed in, an organisation inside their
 * MANAGE_ACCESS authority — and <em>bridges</em>: people of other organisations holding a current grant on a site that
 * authority administers, the explicit, scoped way cross-organisation work is set up (by a manager whose authority covers
 * the person). Members come with their identifiers, bridges with name and organisation only. Nobody else is listed,
 * searched, linked, granted or explained.
 */
@Component
public class DirectoryScope {

    /** What a manager's MANAGE_ACCESS grants reach: organisations, and the sites they administer or are limited to. */
    public record Reach(boolean global, Set<UUID> orgs, Set<UUID> sites) {
    }

    private final JdbcClient jdbc;

    public DirectoryScope(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Reach reach(AccessContext ctx) {
        if (ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            return new Reach(true, Set.of(), Set.of());
        }
        Set<UUID> orgs = new HashSet<>();
        Set<UUID> sites = new HashSet<>();
        for (Grant g : ctx.grants()) {
            if (!g.has(Permission.MANAGE_ACCESS)) {
                continue;
            }
            if (g.hasOrgLimit()) {
                orgs.addAll(g.orgSubtree());
            }
            if (g.hasSiteLimit()) {
                sites.addAll(g.siteSubtree());
                sites.addAll(g.resourceSites());
            }
        }
        if (!orgs.isEmpty()) {
            sites.addAll(jdbc.sql("""
                    select site_id from site_responsibility where valid_to is null
                      and organization_id = any(string_to_array(:o, ',')::uuid[])""")
                    .param("o", Db.ids(orgs)).query(UUID.class).list());
        }
        return new Reach(false, orgs, sites);
    }

    /** SQL: person {@code x} is a member of the reach (parameters {@code dir_orgs}). */
    public static final String MEMBER = """
            (exists (select 1 from affiliation da where da.person_id = x.id and da.valid_to is null
                       and da.organization_id = any(string_to_array(:dir_orgs, ',')::uuid[]))
             or exists (select 1 from membership dm where dm.person_id = x.id and (dm.valid_to is null or dm.valid_to > now())
                       and dm.organization_id = any(string_to_array(:dir_orgs, ',')::uuid[])))""";

    /** SQL: person {@code x} holds a current grant on a site of the reach (parameter {@code dir_sites}). */
    public static final String BRIDGE = """
            exists (select 1 from membership bm where bm.person_id = x.id and (bm.valid_to is null or bm.valid_to > now())
                      and (bm.site_scope_id = any(string_to_array(:dir_sites, ',')::uuid[])
                           or exists (select 1 from membership_scope_target bt left join resource br on bt.kind = 'RESOURCE' and br.id = bt.target_id
                                      where bt.membership_id = bm.id
                                        and ((bt.kind = 'SITE' and bt.target_id = any(string_to_array(:dir_sites, ',')::uuid[]))
                                             or br.site_id = any(string_to_array(:dir_sites, ',')::uuid[])))))""";

    /** Each given person the manager reaches, mapped to true for a member and false for a bridge. */
    public Map<UUID, Boolean> classify(AccessContext ctx, Collection<UUID> persons) {
        Map<UUID, Boolean> out = new HashMap<>();
        if (persons.isEmpty()) {
            return out;
        }
        Reach reach = reach(ctx);
        if (reach.global()) {
            persons.forEach(p -> out.put(p, true));
            return out;
        }
        jdbc.sql("select x.id, " + MEMBER + " as member, " + BRIDGE + " as bridge from person x "
                        + "where x.id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", Db.ids(persons)).param("dir_orgs", Db.ids(reach.orgs())).param("dir_sites", Db.ids(reach.sites()))
                .query((rs, n) -> {
                    if (rs.getBoolean("member") || rs.getBoolean("bridge")) {
                        out.put(Db.uuid(rs, "id"), rs.getBoolean("member"));
                    }
                    return null;
                }).list();
        return out;
    }

    public boolean covers(AccessContext ctx, UUID person) {
        return classify(ctx, Set.of(person)).containsKey(person);
    }

    /** The given persons who are members (shown with identifiers). */
    public Set<UUID> members(AccessContext ctx, Collection<UUID> persons) {
        Set<UUID> out = new HashSet<>();
        classify(ctx, persons).forEach((p, member) -> {
            if (member) {
                out.add(p);
            }
        });
        return out;
    }
}
