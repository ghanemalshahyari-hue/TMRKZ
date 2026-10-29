package ae.mover.authz;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.core.type.TypeReference;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Grant;
import ae.mover.access.GrantSource;
import ae.mover.access.Permission;
import ae.mover.access.RawGrant;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.common.Ref;
import ae.mover.security.Actor;

/**
 * Versioned access policy (the role catalogue): draft → validation → impact → publication, with the history kept and
 * any earlier version restorable by a recorded action. Publishing rewrites {@code role_def}, which the OpenFGA outbox
 * then applies; the model id in force is pinned on the version. Also answers "what can this person do, and why".
 */
@Service
public class AccessPolicyService {

    public static final List<String> SCOPES = List.of("ALL", "ORGANIZATION", "SITE", "ORGANIZATION_AND_SITE");

    public record RoleSpec(String code, String name, List<String> permissions, String scope, boolean summaryOnly,
                           boolean system, List<String> grantableRoles, int sortOrder) {
    }

    public record VersionView(String id, int version, String status, String note, Ref createdBy, String createdAt,
                              Ref publishedBy, String publishedAt, Integer restoredFromVersion, Integer basedOnVersion,
                              String fgaModelId, List<RoleSpec> roles) {
    }

    public record Problem(String level, String role, String message) {
    }

    public record RoleImpact(String code, String name, String change, List<String> added, List<String> removed,
                             String scopeFrom, String scopeTo, Boolean summaryFrom, Boolean summaryTo,
                             List<String> grantableAdded, List<String> grantableRemoved, int memberships, int delegations,
                             int seats, int persons) {
    }

    public record Impact(int draftVersion, int publishedVersion, List<RoleImpact> roles, List<Problem> problems,
                         boolean publishable) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final AccessService access;
    private final AuthzSync sync;
    private final Authorization authorization;
    private final GrantAdminService grants;

    public AccessPolicyService(JdbcClient jdbc, Json json, Clock clock, AuditService audit, AccessService access,
                               AuthzSync sync, Authorization authorization, GrantAdminService grants) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.access = access;
        this.sync = sync;
        this.authorization = authorization;
        this.grants = grants;
    }

    /** Version 1 = the roles in force when the studio was introduced (run at start-up, after the baseline roles). */
    @Transactional
    public void ensureInitialVersion() {
        int published = jdbc.sql("select count(*) from access_policy_version where status in ('PUBLISHED', 'SUPERSEDED')")
                .query(Integer.class).single();
        if (published > 0) {
            return;
        }
        jdbc.sql("""
                insert into access_policy_version(id, version, status, roles, note, published_at)
                values (:id, 1, 'PUBLISHED', cast(:r as jsonb), 'الأدوار القائمة عند تفعيل استوديو الصلاحيات', now())""")
                .param("id", UUID.randomUUID()).param("r", json.write(liveRoles())).update();
        jdbc.sql("update role_def set policy_version = 1 where policy_version is null").update();
    }

    // ---- reading --------------------------------------------------------------------------------------------------

    public List<VersionView> versions(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        return jdbc.sql(VERSION_SQL + " order by v.version desc").query((rs, n) -> view(rs, false)).list();
    }

    public VersionView version(AccessContext ctx, UUID id) {
        ctx.require(Permission.MANAGE_ACCESS);
        return jdbc.sql(VERSION_SQL + " where v.id = :id").param("id", id).query((rs, n) -> view(rs, true))
                .optional().orElseThrow(ApiException::notFound);
    }

    private static final String VERSION_SQL = """
            select v.*, v.roles::text as roles_text, c.display_name as created_name, p.display_name as published_name,
                   rf.version as restored_version, bo.version as based_version
            from access_policy_version v left join person c on c.id = v.created_by left join person p on p.id = v.published_by
            left join access_policy_version rf on rf.id = v.restored_from left join access_policy_version bo on bo.id = v.based_on""";

    private VersionView view(java.sql.ResultSet rs, boolean withRoles) throws java.sql.SQLException {
        List<RoleSpec> roles = parse(rs.getString("roles_text"));
        return new VersionView(rs.getString("id"), rs.getInt("version"), rs.getString("status"), rs.getString("note"),
                Ref.of(Db.uuid(rs, "created_by"), rs.getString("created_name")), Db.iso(rs, "created_at"),
                Ref.of(Db.uuid(rs, "published_by"), rs.getString("published_name")), Db.iso(rs, "published_at"),
                (Integer) rs.getObject("restored_version"), (Integer) rs.getObject("based_version"),
                rs.getString("fga_model_id"), withRoles ? roles : List.of());
    }

    private List<RoleSpec> parse(String text) {
        return json.convert(json.tree(text), new TypeReference<List<RoleSpec>>() {
        });
    }

    /** The published projection (role_def) as role specifications. */
    private List<RoleSpec> liveRoles() {
        return jdbc.sql("select * from role_def order by sort_order, code")
                .query((rs, n) -> new RoleSpec(rs.getString("code"), rs.getString("name"), Db.strings(rs, "permissions"),
                        rs.getString("scope"), rs.getBoolean("summary_only"), rs.getBoolean("system"),
                        Db.strings(rs, "grantable_roles"), rs.getInt("sort_order"))).list();
    }

    // ---- draft --------------------------------------------------------------------------------------------------

    @Transactional
    public VersionView draft(AccessContext ctx, String note) {
        requireGlobal(ctx);
        UUID existing = jdbc.sql("select id from access_policy_version where status = 'DRAFT'").query(UUID.class).optional().orElse(null);
        if (existing != null) {
            return version(ctx, existing);
        }
        UUID id = UUID.randomUUID();
        UUID base = jdbc.sql("select id from access_policy_version where status = 'PUBLISHED'").query(UUID.class).optional().orElse(null);
        jdbc.sql("""
                insert into access_policy_version(id, version, status, roles, note, based_on, created_by)
                values (:id, (select coalesce(max(version), 0) + 1 from access_policy_version), 'DRAFT', cast(:r as jsonb), :n, :b, :by)""")
                .param("id", id).param("r", json.write(liveRoles())).param("n", note).param("b", base).param("by", ctx.personId())
                .update();
        audit.recordAs(ctx.actor(), "POLICY_DRAFT_CREATED", "POLICY", id.toString(), null, Map.of(), note);
        return version(ctx, id);
    }

    public record RoleInput(String code, String name, List<String> permissions, String scope, Boolean summaryOnly,
                            List<String> grantableRoles) {
    }

    /** Adds or changes one role in the draft. The protected system role cannot be changed. */
    @Transactional
    public VersionView saveDraftRole(AccessContext ctx, RoleInput in) {
        requireGlobal(ctx);
        Map<String, Object> d = draftRow();
        List<RoleSpec> roles = new ArrayList<>(parse((String) d.get("roles_text")));
        if (in == null || in.code() == null || !in.code().matches("[A-Z][A-Z0-9_]{1,39}")) {
            throw ApiException.validation("رمز الدور: أحرف لاتينية كبيرة وأرقام وشرطة سفلية (2–40).");
        }
        RoleSpec current = roles.stream().filter(r -> r.code().equals(in.code())).findFirst().orElse(null);
        if (current != null && current.system()) {
            throw ApiException.validation("دور مدير النظام محمي ولا يُعدل في المسودة.");
        }
        List<String> perms = in.permissions() == null ? List.of() : new ArrayList<>(new LinkedHashSet<>(in.permissions()));
        RoleSpec next = new RoleSpec(in.code(), in.name() == null ? (current == null ? in.code() : current.name()) : in.name().trim(),
                perms, in.scope() == null ? (current == null ? "ORGANIZATION" : current.scope()) : in.scope(),
                in.summaryOnly() == null ? current != null && current.summaryOnly() : in.summaryOnly(), false,
                in.grantableRoles() == null ? (current == null ? List.of() : current.grantableRoles()) : List.copyOf(new LinkedHashSet<>(in.grantableRoles())),
                current == null ? roles.stream().mapToInt(RoleSpec::sortOrder).max().orElse(0) + 1 : current.sortOrder());
        List<Problem> problems = new ArrayList<>();
        check(next, roles, problems);
        if (problems.stream().anyMatch(p -> "ERROR".equals(p.level()))) {
            throw ApiException.validation(problems.stream().filter(p -> "ERROR".equals(p.level())).findFirst().get().message(),
                    Map.of("problems", problems));
        }
        if (current == null) {
            roles.add(next);
        } else {
            roles.replaceAll(r -> r.code().equals(next.code()) ? next : r);
        }
        jdbc.sql("update access_policy_version set roles = cast(:r as jsonb) where id = :id")
                .param("r", json.write(roles)).param("id", d.get("id")).update();
        return version(ctx, (UUID) d.get("id"));
    }

    @Transactional
    public void discard(AccessContext ctx, String reason) {
        requireGlobal(ctx);
        Map<String, Object> d = draftRow();
        jdbc.sql("update access_policy_version set status = 'DISCARDED' where id = :id").param("id", d.get("id")).update();
        audit.recordAs(ctx.actor(), "POLICY_DRAFT_DISCARDED", "POLICY", d.get("id").toString(), null, Map.of(), reason);
    }

    private Map<String, Object> draftRow() {
        return jdbc.sql("select id, version, roles::text as roles_text from access_policy_version where status = 'DRAFT' for update")
                .query().listOfRows().stream().findFirst()
                .orElseThrow(() -> ApiException.validation("لا توجد مسودة سياسة؛ أنشئ مسودة أولاً."));
    }

    private void check(RoleSpec r, List<RoleSpec> all, List<Problem> out) {
        if (r.name() == null || r.name().isBlank()) {
            out.add(new Problem("ERROR", r.code(), "اسم الدور مطلوب."));
        }
        if (!SCOPES.contains(r.scope())) {
            out.add(new Problem("ERROR", r.code(), "نطاق الدور الافتراضي غير معروف."));
        }
        for (String p : r.permissions()) {
            try {
                Permission.valueOf(p);
            } catch (IllegalArgumentException e) {
                out.add(new Problem("ERROR", r.code(), "صلاحية غير معروفة: " + p));
            }
        }
        for (String g : r.grantableRoles()) {
            if (all.stream().noneMatch(x -> x.code().equals(g)) && !g.equals(r.code())) {
                out.add(new Problem("ERROR", r.code(), "الدور القابل للمنح غير موجود: " + g));
            }
        }
        if (!r.grantableRoles().isEmpty() && !r.permissions().contains("MANAGE_ACCESS")) {
            out.add(new Problem("WARNING", r.code(), "قائمة الأدوار القابلة للمنح لا أثر لها دون صلاحية إدارة الصلاحيات."));
        }
        if (r.summaryOnly() && !r.permissions().contains("VIEW")) {
            out.add(new Problem("WARNING", r.code(), "«عرض مختصر» لا أثر له دون صلاحية العرض."));
        }
        if ("ALL".equals(r.scope()) && r.permissions().stream().anyMatch(p -> List.of("VIEW", "APPROVE", "EXPORT").contains(p))) {
            out.add(new Problem("WARNING", r.code(), "النطاق الشامل يعطي هذا الدور محتوى جميع الطلبات أو قرارها أو تصديرها."));
        }
        if (r.permissions().isEmpty()) {
            out.add(new Problem("WARNING", r.code(), "دور بلا صلاحيات: حامله لا يستطيع أي إجراء."));
        }
    }

    // ---- validation and impact ----------------------------------------------------------------------------------

    public Impact impact(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        Map<String, Object> d = jdbc.sql("select version, roles::text as roles_text from access_policy_version where status = 'DRAFT'")
                .query().listOfRows().stream().findFirst()
                .orElseThrow(() -> ApiException.validation("لا توجد مسودة سياسة."));
        List<RoleSpec> draft = parse((String) d.get("roles_text"));
        Map<String, RoleSpec> live = new LinkedHashMap<>();
        liveRoles().forEach(r -> live.put(r.code(), r));
        int publishedVersion = jdbc.sql("select coalesce(max(version), 0) from access_policy_version where status = 'PUBLISHED'")
                .query(Integer.class).single();
        List<Problem> problems = new ArrayList<>();
        for (RoleSpec r : draft) {
            check(r, draft, problems);
            RoleSpec was = live.get(r.code());
            if (was != null && was.system() && !sameRole(was, r)) {
                problems.add(new Problem("ERROR", r.code(), "دور مدير النظام محمي ولا يتغير بالنشر."));
            }
        }
        for (String code : live.keySet()) {
            if (draft.stream().noneMatch(r -> r.code().equals(code))) {
                problems.add(new Problem("ERROR", code, "لا يُحذف دور من السياسة؛ أفرغ صلاحياته بدلاً من ذلك."));
            }
        }
        List<RoleImpact> roles = new ArrayList<>();
        for (RoleSpec r : draft) {
            RoleSpec was = live.get(r.code());
            String change = was == null ? "ADDED" : sameRole(was, r) ? "UNCHANGED" : "CHANGED";
            List<String> added = new ArrayList<>(r.permissions());
            List<String> removed = new ArrayList<>();
            if (was != null) {
                added.removeAll(was.permissions());
                removed.addAll(was.permissions());
                removed.removeAll(r.permissions());
            }
            List<String> gAdded = new ArrayList<>(r.grantableRoles());
            List<String> gRemoved = new ArrayList<>();
            if (was != null) {
                gAdded.removeAll(was.grantableRoles());
                gRemoved.addAll(was.grantableRoles());
                gRemoved.removeAll(r.grantableRoles());
            }
            Map<String, Object> h = holders(r.code());
            roles.add(new RoleImpact(r.code(), r.name(), change, added, removed, was == null ? null : was.scope(), r.scope(),
                    was == null ? null : was.summaryOnly(), r.summaryOnly(), gAdded, gRemoved,
                    ((Number) h.get("memberships")).intValue(), ((Number) h.get("delegations")).intValue(),
                    ((Number) h.get("seats")).intValue(), ((Number) h.get("persons")).intValue()));
        }
        boolean publishable = problems.stream().noneMatch(p -> "ERROR".equals(p.level()))
                && roles.stream().anyMatch(r -> !"UNCHANGED".equals(r.change()));
        return new Impact(((Number) d.get("version")).intValue(), publishedVersion, roles, problems, publishable);
    }

    private static boolean sameRole(RoleSpec a, RoleSpec b) {
        return a.name().equals(b.name()) && Set.copyOf(a.permissions()).equals(Set.copyOf(b.permissions()))
                && a.scope().equals(b.scope()) && a.summaryOnly() == b.summaryOnly()
                && Set.copyOf(a.grantableRoles()).equals(Set.copyOf(b.grantableRoles()));
    }

    private Map<String, Object> holders(String role) {
        return jdbc.sql("""
                with m as (select id, person_id from membership where role_code = :r and (valid_to is null or valid_to > now())),
                     d as (select d.delegate_id as person_id from delegation d join m on m.id = d.membership_id
                           where d.revoked_at is null and d.valid_to > now()),
                     s as (select a.person_id from position_seat ps join affiliation a on a.organization_id = ps.organization_id
                             and a.position_id = ps.position_id and (a.valid_to is null or a.valid_to > now())
                           where ps.role_code = :r and ps.active)
                select (select count(*) from m) as memberships, (select count(*) from d) as delegations,
                       (select count(*) from s) as seats,
                       (select count(distinct person_id) from (select person_id from m union select person_id from d
                          union select person_id from s) x) as persons""")
                .param("r", role).query().singleRow();
    }

    // ---- publish and restore ------------------------------------------------------------------------------------

    @Transactional
    public VersionView publish(AccessContext ctx, String note) {
        requireGlobal(ctx);
        if (note == null || note.isBlank()) {
            throw ApiException.validation("اكتب ملاحظة النشر: ما الذي تغير ولماذا.");
        }
        Map<String, Object> d = draftRow();
        Impact impact = impact(ctx);
        if (!impact.publishable()) {
            throw ApiException.validation(impact.problems().stream().anyMatch(p -> "ERROR".equals(p.level()))
                    ? "في المسودة أخطاء يجب إصلاحها قبل النشر." : "لا تغيير في المسودة عن الإصدار المنشور.",
                    Map.of("problems", impact.problems()));
        }
        return install(ctx, (UUID) d.get("id"), parse((String) d.get("roles_text")), note, null, impact);
    }

    /** Publishes a copy of an earlier version as the newest version (the rollback is itself a recorded version). */
    @Transactional
    public VersionView restore(AccessContext ctx, UUID id, String note) {
        requireGlobal(ctx);
        if (note == null || note.isBlank()) {
            throw ApiException.validation("اذكر سبب الرجوع إلى الإصدار السابق.");
        }
        if (jdbc.sql("select count(*) from access_policy_version where status = 'DRAFT'").query(Integer.class).single() > 0) {
            throw ApiException.validation("توجد مسودة مفتوحة؛ انشرها أو تجاهلها قبل الرجوع إلى إصدار سابق.");
        }
        Map<String, Object> src = jdbc.sql("select version, status, roles::text as roles_text from access_policy_version where id = :id")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!List.of("PUBLISHED", "SUPERSEDED").contains(src.get("status"))) {
            throw ApiException.validation("يمكن الرجوع إلى إصدار نُشر سابقاً فقط.");
        }
        if ("PUBLISHED".equals(src.get("status"))) {
            throw ApiException.validation("هذا الإصدار هو المنشور حالياً.");
        }
        List<RoleSpec> roles = parse((String) src.get("roles_text"));
        // roles created after the restored version stay defined (memberships may use them) but lose every action
        Set<String> listed = new java.util.HashSet<>();
        roles.forEach(r -> listed.add(r.code()));
        List<RoleSpec> merged = new ArrayList<>(roles);
        for (RoleSpec live : liveRoles()) {
            if (!listed.contains(live.code())) {
                merged.add(new RoleSpec(live.code(), live.name(), List.of(), live.scope(), live.summaryOnly(), live.system(),
                        List.of(), live.sortOrder()));
            }
        }
        UUID newId = UUID.randomUUID();
        UUID base = jdbc.sql("select id from access_policy_version where status = 'PUBLISHED'").query(UUID.class).optional().orElse(null);
        jdbc.sql("""
                insert into access_policy_version(id, version, status, roles, note, based_on, restored_from, created_by)
                values (:id, (select coalesce(max(version), 0) + 1 from access_policy_version), 'DRAFT', cast(:r as jsonb), :n, :b, :src, :by)""")
                .param("id", newId).param("r", json.write(merged)).param("n", note).param("b", base).param("src", id)
                .param("by", ctx.personId()).update();
        return install(ctx, newId, merged, note, ((Number) src.get("version")).intValue(), null);
    }

    private VersionView install(AccessContext ctx, UUID id, List<RoleSpec> roles, String note, Integer restoredFrom, Impact impact) {
        String modelId;
        try {
            modelId = sync.ready().modelId();
        } catch (RuntimeException e) {
            throw Authorization.unavailable();
        }
        int version = jdbc.sql("select version from access_policy_version where id = :id").param("id", id).query(Integer.class).single();
        for (RoleSpec r : roles) {
            if (r.system()) {
                continue;
            }
            jdbc.sql("""
                    insert into role_def(code, name, permissions, scope, summary_only, system, sort_order, grantable_roles, policy_version, updated_at)
                    values (:c, :n, string_to_array(:p, ','), :s, :so, false, :o, string_to_array(:g, ','), :v, now())
                    on conflict (code) do update set name = excluded.name, permissions = excluded.permissions, scope = excluded.scope,
                      summary_only = excluded.summary_only, grantable_roles = excluded.grantable_roles,
                      policy_version = excluded.policy_version, updated_at = now()
                    where not role_def.system""")
                    .param("c", r.code()).param("n", r.name()).param("p", String.join(",", r.permissions())).param("s", r.scope())
                    .param("so", r.summaryOnly()).param("o", r.sortOrder()).param("g", String.join(",", r.grantableRoles()))
                    .param("v", version).update();
        }
        jdbc.sql("update role_def set policy_version = :v where system").param("v", version).update();
        jdbc.sql("update access_policy_version set status = 'SUPERSEDED' where status = 'PUBLISHED'").update();
        jdbc.sql("""
                update access_policy_version set status = 'PUBLISHED', note = :n, published_by = :by, published_at = :now,
                  fga_model_id = :m where id = :id""")
                .param("n", note).param("by", ctx.personId()).param("now", Db.ts(clock.instant())).param("m", modelId)
                .param("id", id).update();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("version", version);
        detail.put("fgaModelId", modelId);
        if (restoredFrom != null) {
            detail.put("restoredFromVersion", restoredFrom);
        }
        if (impact != null) {
            detail.put("changedRoles", impact.roles().stream().filter(r -> !"UNCHANGED".equals(r.change()))
                    .map(r -> r.code() + ":" + r.change() + " +" + r.added() + " -" + r.removed()).toList());
        }
        audit.recordAs(ctx.actor(), restoredFrom == null ? "POLICY_PUBLISHED" : "POLICY_RESTORED", "POLICY", id.toString(),
                "الإصدار " + version, detail, note);
        return version(ctx, id);
    }

    private void requireGlobal(AccessContext ctx) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("سياسة الأدوار يعدلها وينشرها مدير صلاحيات عام (نطاق شامل) فقط.");
        }
    }

    // ---- explain ------------------------------------------------------------------------------------------------

    public record Reason(String role, String organization, String scope, String validTo, String via) {
    }

    public record Verdict(boolean allowed, List<Reason> reasons) {
    }

    public record ActionExplain(String action, Verdict published, Verdict draft, Boolean openfga, boolean changed) {
    }

    /**
     * What a person can do now, and why, under the published policy — and under the draft if one exists — optionally
     * for an organisation (acting for it) or a site/resource (a request that would involve it). OpenFGA's answer for
     * the published policy is shown next to the grants' answer.
     */
    public Map<String, Object> explain(AccessContext ctx, UUID personId, UUID orgId, UUID siteId, UUID resourceId) {
        ctx.require(Permission.MANAGE_ACCESS);
        Map<String, Object> person = jdbc.sql("select id, display_name, employee_no, status from person where id = :id")
                .param("id", personId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            List<UUID> orgs = jdbc.sql("""
                    select organization_id from membership where person_id = :p
                    union select organization_id from affiliation where person_id = :p and valid_to is null""")
                    .param("p", personId).query(UUID.class).list();
            if (orgs.stream().noneMatch(o -> ctx.canFor(Permission.MANAGE_ACCESS, o))) {
                throw ApiException.notFound();
            }
        }
        Instant now = clock.instant();
        UUID site = siteId;
        if (resourceId != null) {
            site = jdbc.sql("select site_id from resource where id = :id").param("id", resourceId).query(UUID.class)
                    .optional().orElseThrow(ApiException::notFound);
        }
        UUID responsible = site == null ? null : jdbc.sql(
                "select organization_id from site_responsibility where site_id = :s and valid_to is null")
                .param("s", site).query(UUID.class).optional().orElse(null);
        Actor subject = new Actor(personId, null, (String) person.get("display_name"), null);
        AccessContext published = access.load(subject, now);
        Map<String, Object> draftRow = jdbc.sql("select version, roles::text as roles_text from access_policy_version where status = 'DRAFT'")
                .query().listOfRows().stream().findFirst().orElse(null);
        AccessContext draft = null;
        if (draftRow != null) {
            Map<String, GrantSource.RoleOverride> overrides = new HashMap<>();
            for (RoleSpec r : parse((String) draftRow.get("roles_text"))) {
                EnumSet<Permission> ps = EnumSet.noneOf(Permission.class);
                r.permissions().forEach(p -> ps.add(Permission.valueOf(p)));
                overrides.put(r.code(), new GrantSource.RoleOverride(r.name(), ps, r.scope(), r.summaryOnly()));
            }
            draft = access.load(subject, now, overrides);
        }
        boolean fgaReady = false;
        try {
            if (sync.pending(personId)) {
                sync.run(false);
            }
            fgaReady = true;
        } catch (RuntimeException e) {
            fgaReady = false;
        }
        Set<UUID> orgs = new LinkedHashSet<>();
        if (orgId != null) {
            orgs.add(orgId);
        }
        if (responsible != null) {
            orgs.add(responsible);
        }
        Set<UUID> sites = site == null ? Set.of() : Set.of(site);
        Set<UUID> resources = resourceId == null ? Set.of() : Set.of(resourceId);
        Map<UUID, String> scopeTexts = scopeTexts(published, draft);
        List<ActionExplain> actions = new ArrayList<>();
        for (Permission p : Permission.values()) {
            Verdict pub = verdict(published, p, orgId, site, orgs, sites, resources, scopeTexts);
            Verdict dr = draft == null ? null : verdict(draft, p, orgId, site, orgs, sites, resources, scopeTexts);
            Boolean fga = fgaReady ? authorization.preview(personId, now, p, orgId, siteId == null && resourceId != null ? site : siteId,
                    resourceId, responsible) : null;
            actions.add(new ActionExplain(p.name(), pub, dr, fga, dr != null && dr.allowed() != pub.allowed()));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("person", Map.of("id", personId.toString(), "displayName", person.get("display_name"),
                "employeeNo", person.get("employee_no"), "status", person.get("status")));
        Map<String, Object> target = new LinkedHashMap<>();
        target.put("organization", orgId == null ? null : Ref.of(orgId, name("organization", orgId)));
        target.put("site", site == null ? null : Ref.of(site, name("site", site)));
        target.put("resource", resourceId == null ? null : Ref.of(resourceId, name("resource", resourceId)));
        target.put("meaning", resourceId != null || siteId != null
                ? "طلب يخص هذا الموقع أو المورد" + (orgId != null ? " مقدم من الجهة المختارة" : "")
                : orgId != null ? "العمل باسم الجهة المختارة" : "في أي نطاق");
        out.put("target", target);
        out.put("draftVersion", draftRow == null ? null : draftRow.get("version"));
        out.put("openfgaAvailable", fgaReady);
        out.put("actions", actions);
        return out;
    }

    private Verdict verdict(AccessContext c, Permission p, UUID orgId, UUID site, Set<UUID> orgs, Set<UUID> sites,
                            Set<UUID> resources, Map<UUID, String> scopeTexts) {
        List<Reason> reasons = new ArrayList<>();
        for (Grant g : c.grants()) {
            if (!g.has(p)) {
                continue;
            }
            boolean ok = site == null && resources.isEmpty() ? orgId == null || g.actsFor(orgId) : g.covers(orgs, sites, resources);
            if (ok) {
                reasons.add(new Reason(g.roleName(), g.orgName(), scopeTexts.getOrDefault(g.grantId(), ""),
                        g.validTo() == null ? null : g.validTo().toString(),
                        g.delegationId() == null ? (g.membershipId() == null ? "مقعد مسؤولية" : null) : "تفويض من " + g.delegatorName()));
            }
        }
        return new Verdict(!reasons.isEmpty(), reasons);
    }

    private Map<UUID, String> scopeTexts(AccessContext published, AccessContext draft) {
        Map<UUID, String> out = new HashMap<>();
        List<RawGrant> raws = new ArrayList<>();
        for (AccessContext c : draft == null ? List.of(published) : List.of(published, draft)) {
            for (Grant g : c.grants()) {
                raws.add(new RawGrant(g.grantId(), c.personId(), g.membershipId(), g.delegationId(), g.delegatorName(), g.roleCode(),
                        g.roleName(), g.permissions(), "CUSTOM".equals(g.scope()) ? "ORGANIZATION" : g.scope(), g.summaryOnly(),
                        g.orgId(), g.orgName(), g.siteId(), g.siteName(), "CUSTOM".equals(g.scope()) ? "CUSTOM" : "ROLE",
                        g.andCombine(), g.isAll() && "CUSTOM".equals(g.scope()), null, g.validTo(), g.targets()));
            }
        }
        GrantAdminService.Names names = grants.names(raws);
        for (RawGrant r : raws) {
            out.putIfAbsent(r.grantId(), GrantAdminService.describe(r, names));
        }
        return out;
    }

    private String name(String table, UUID id) {
        return jdbc.sql("select name from " + table + " where id = :id").param("id", id).query(String.class).optional().orElse(null);
    }
}
