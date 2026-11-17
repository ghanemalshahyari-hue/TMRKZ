package ae.mover.stationing;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Grant;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;

/**
 * «الإعدادات → صلاحيات تهيئة المواقع» (owner brief §3, phase 7; ADR-089): who may set up a site and its unit's initial
 * stationing besides the system administrator. Not hard-coded: whoever configures the system chooses the roles, the people,
 * the units (each with or without the units under it) and the levels of the hierarchy; the initial rule is «معتمد عمليات
 * الوحدة» in that role's own reach.
 *
 * <p>A person may set up a unit when they hold one of the roles acting for that unit, or are named; and the unit is inside the
 * chosen units (none chosen: any); and its level is one of the chosen levels (none chosen: any). The system administrator
 * («تهيئة المواقع والتمركز», {@link SiteSetupService#admin}) always may. The server checks this on every save; the site is then
 * registered on the unit's behalf, without the person holding facility management of their own.
 */
@Service
public class SiteSetupAccess {

    public static final String DEFAULT_ROLE = "UNIT_OPERATIONS_APPROVER";
    static final int MAX_LEVEL = 20;

    public record UnitTarget(UUID id, boolean includeDescendants) {
    }

    public record Rule(List<String> roles, List<UUID> persons, List<UnitTarget> units, List<Integer> levels) {
        public Rule {
            roles = roles == null ? List.of() : List.copyOf(new LinkedHashSet<>(roles));
            persons = persons == null ? List.of() : List.copyOf(new LinkedHashSet<>(persons));
            units = units == null ? List.of() : List.copyOf(units);
            levels = levels == null ? List.of() : List.copyOf(new LinkedHashSet<>(levels));
        }
    }

    public record SaveInput(List<String> roles, List<UUID> persons, List<UnitTarget> units, List<Integer> levels, String reason) {
    }

    static final Rule INITIAL = new Rule(List.of(DEFAULT_ROLE), List.of(), List.of(), List.of());

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final OrgHierarchy hierarchy;

    public SiteSetupAccess(JdbcClient jdbc, Json json, Clock clock, AuditService audit, OrgHierarchy hierarchy) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.hierarchy = hierarchy;
    }

    /** The rule in force: the one saved, or the initial one. */
    public Rule rule() {
        return jdbc.sql("select rule::text from site_setup_access where id = 1").query(String.class).optional()
                .map(s -> json.read(s, Rule.class)).orElse(INITIAL);
    }

    /** The unit's level in the hierarchy: 1 for a unit at the top. */
    int level(UUID unit) {
        return hierarchy.path(unit).size();
    }

    /** Whether this person may set up a site with this unit's initial stationing (the server's check on every save). */
    public boolean allows(AccessContext ctx, UUID unit) {
        if (unit == null) {
            return false;
        }
        if (SiteSetupService.admin(ctx)) {
            return true;
        }
        Rule r = rule();
        boolean who = r.persons().contains(ctx.personId())
                || ctx.grants().stream().anyMatch(g -> g.delegationId() == null && r.roles().contains(g.roleCode()) && g.actsFor(unit));
        if (!who) {
            return false;
        }
        boolean where = r.units().isEmpty()
                || r.units().stream().anyMatch(t -> t.id().equals(unit) || t.includeDescendants() && hierarchy.isUnder(unit, t.id()));
        return where && (r.levels().isEmpty() || r.levels().contains(level(unit)));
    }

    /** Whether the person may set up any site at all (the screen's save button; each unit is checked again on the save). */
    public boolean anywhere(AccessContext ctx) {
        if (SiteSetupService.admin(ctx)) {
            return true;
        }
        Rule r = rule();
        return r.persons().contains(ctx.personId()) || ctx.grants().stream().anyMatch(g -> g.delegationId() == null && r.roles().contains(g.roleCode()));
    }

    /**
     * The context a save by someone allowed by the rule runs with: theirs, plus facility management for the unit the site is
     * registered for, for this one operation (the rule has already been checked; OpenFGA has no tuple for it, so no confirmer).
     */
    AccessContext actingFor(AccessContext ctx, UUID unit) {
        Grant g = new Grant(UUID.randomUUID(), null, null, null, "SITE_SETUP", "تهيئة المواقع", Set.of(Permission.VIEW, Permission.MANAGE_FACILITIES),
                "ORGANIZATION", false, unit, null, null, null, null, false, false, Set.of(unit), null, Set.of(), Set.of(), List.of());
        return ctx.plus(g);
    }

    /** For the person's own screen: may they set up sites, and the rule in words. */
    public Map<String, Object> mine(AccessContext ctx) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("admin", SiteSetupService.admin(ctx));
        m.put("may", anywhere(ctx));
        return m;
    }

    /** The rule with the names of its roles, people and units, for the settings. */
    public Map<String, Object> forSettings(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        Rule r = rule();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("saved", jdbc.sql("select count(*) from site_setup_access").query(Long.class).single() > 0);
        m.put("roles", r.roles());
        m.put("persons", r.persons().stream().map(p -> Map.of("id", p.toString(), "name", java.util.Objects.requireNonNullElse(personName(p), "—"))).toList());
        m.put("units", r.units().stream().map(u -> Map.of("id", u.id().toString(), "name", unitName(u.id()), "includeDescendants", u.includeDescendants())).toList());
        m.put("levels", r.levels());
        jdbc.sql("""
                select a.reason, a.updated_at, p.display_name from site_setup_access a join person p on p.id = a.updated_by where a.id = 1""")
                .query((rs, n) -> {
                    m.put("reason", rs.getString("reason"));
                    m.put("updatedAt", Db.instant(rs, "updated_at").toString());
                    m.put("updatedBy", rs.getString("display_name"));
                    return null;
                }).list();
        return m;
    }

    @Transactional
    public Map<String, Object> save(AccessContext ctx, SaveInput in) {
        ctx.require(Permission.CONFIGURE);
        if (in == null) {
            throw ApiException.validation("أرسل القاعدة.");
        }
        String reason = in.reason() == null ? "" : in.reason().trim();
        if (reason.length() < 5) {
            throw ApiException.validation("اكتب سبب التغيير (5 أحرف على الأقل).");
        }
        Rule r = new Rule(in.roles(), in.persons(), in.units(), in.levels());
        List<String> problems = new ArrayList<>();
        if (r.roles().isEmpty() && r.persons().isEmpty()) {
            problems.add("اختر دوراً أو شخصاً واحداً على الأقل؛ مدير النظام يهيئ المواقع دائماً.");
        }
        for (String role : r.roles()) {
            if (jdbc.sql("select count(*) from role_def where code = :c").param("c", role).query(Long.class).single() == 0) {
                problems.add("دور غير معروف: " + role);
            }
        }
        for (UUID p : r.persons()) {
            if (personName(p) == null) {
                problems.add("شخص غير معروف.");
            }
        }
        for (UnitTarget u : r.units()) {
            if (u.id() == null || hierarchy.unit(u.id()).isEmpty()) {
                problems.add("وحدة غير معروفة.");
            }
        }
        if (r.levels().stream().anyMatch(l -> l == null || l < 1 || l > MAX_LEVEL)) {
            problems.add("المستويات من 1 (الوحدة العليا) إلى " + MAX_LEVEL + ".");
        }
        if (!problems.isEmpty()) {
            throw ApiException.validation(problems.get(0), Map.of("problems", problems));
        }
        Instant now = clock.instant();
        jdbc.sql("""
                insert into site_setup_access(id, rule, reason, updated_by, updated_at) values (1, cast(:r as jsonb), :why, :by, :now)
                on conflict (id) do update set rule = excluded.rule, reason = excluded.reason, updated_by = excluded.updated_by,
                                               updated_at = excluded.updated_at""")
                .param("r", json.write(r)).param("why", reason).param("by", ctx.personId()).param("now", Db.ts(now)).update();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("roles", r.roles());
        detail.put("persons", r.persons().size());
        detail.put("units", r.units().size());
        detail.put("levels", r.levels());
        audit.recordAs(ctx.actor(), "SITE_SETUP_ACCESS_SAVED", "SETTINGS", "site-setup-access", "صلاحيات تهيئة المواقع", detail, reason);
        return forSettings(ctx);
    }

    private String personName(UUID id) {
        return jdbc.sql("select display_name from person where id = :id").param("id", id).query(String.class).optional().orElse(null);
    }

    private String unitName(UUID id) {
        return hierarchy.unit(id).map(OrgUnit::name).orElse("—");
    }
}
