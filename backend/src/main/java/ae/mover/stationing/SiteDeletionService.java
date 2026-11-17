package ae.mover.stationing;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;

/**
 * Deleting a site (owner decisions, 17 Nov 2026; ADR-086). The setup administrator ({@link SiteSetupService#admin}) erases
 * a site completely: the site, its boundary versions, symbol, responsibility, links and resources, its inside sites with
 * all of theirs, and the stationing of every unit there with its deployment areas (each unit is then stationed nowhere;
 * a {@code STATIONING_REMOVED} event says so). Whoever else manages the site asks for it, and the administrator approves
 * (the same erase) or refuses. One audit line keeps who, when, why and what went with it.
 *
 * <p>What a decided request or a booking still refers to is never erased: an approved request's site, a request in
 * progress for a unit stationed there, deployment areas a request made, bookings on its resources, old relocation
 * requests, permissions scoped to it, a temporary stationing elsewhere that returns there. The deletion is then refused
 * with each reason, and nothing is written.
 */
@Service
public class SiteDeletionService {

    public static final String DELETED = "SITE_DELETED";
    private static final String OPEN = "'DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED', 'APPROVED_NOT_ACTIVATED', 'TEMPORARY_SCHEDULED', 'ACTIVE_TEMPORARY'";

    public record ReasonInput(String reason) {
    }

    public record DecisionInput(String decision, String reason) {
    }

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AuditService audit;
    private final StationingOutbox outbox;

    public SiteDeletionService(JdbcClient jdbc, Clock clock, AuditService audit, StationingOutbox outbox) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.audit = audit;
        this.outbox = outbox;
    }

    // ---- what a deletion takes, and what stops it --------------------------------------------------------------------

    /** The site and every site inside it, the site first. */
    private List<Map<String, Object>> subtree(UUID id) {
        return jdbc.sql("""
                with recursive t as (
                  select id, code, name, parent_id, 0 as depth from site where id = :id
                  union all
                  select s.id, s.code, s.name, s.parent_id, t.depth + 1 from site s join t on s.parent_id = t.id where t.depth < 30)
                select id, code, name, depth from t order by depth, code""")
                .param("id", id).query().listOfRows();
    }

    private static List<UUID> idsOf(List<Map<String, Object>> rows, String key) {
        return rows.stream().map(r -> (UUID) r.get(key)).toList();
    }

    /** The impact of deleting {@code id}: the sites, the units stationed there now, and what stops it. Nothing is written. */
    public Map<String, Object> impact(AccessContext ctx, UUID id) {
        Map<String, Object> site = siteRow(id);
        boolean admin = SiteSetupService.admin(ctx);
        boolean manager = manages(ctx, id);
        if (!admin && !manager) {
            throw ApiException.forbidden("حذف الموقع أو طلب حذفه لمن يدير الموقع.");
        }
        List<Map<String, Object>> sites = subtree(id);
        List<UUID> ids = idsOf(sites, "id");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("site", Map.of("id", id.toString(), "code", site.get("code"), "name", site.get("name")));
        m.put("inside", sites.stream().filter(s -> !id.equals(s.get("id"))).map(s -> Map.of("id", s.get("id").toString(), "code", s.get("code"), "name", s.get("name"))).toList());
        m.put("stationed", stationedNow(ids));
        m.put("blockers", blockers(ids));
        m.put("canDelete", admin);
        m.put("canRequest", manager && !admin);
        m.put("pending", pending(id));
        return m;
    }

    private Map<String, Object> siteRow(UUID id) {
        return jdbc.sql("select id, code, name from site where id = :id").param("id", id).query().listOfRows().stream().findFirst()
                .orElseThrow(ApiException::notFound);
    }

    /** Whoever manages the site: facilities over its responsible unit (or over everything when it has none). */
    private boolean manages(AccessContext ctx, UUID siteId) {
        UUID org = jdbc.sql("select organization_id from site_responsibility where site_id = :s and valid_to is null limit 1")
                .param("s", siteId).query(UUID.class).optional().orElse(null);
        return org == null ? ctx.canEverywhere(Permission.MANAGE_FACILITIES) : ctx.canFor(Permission.MANAGE_FACILITIES, org);
    }

    private List<Map<String, Object>> stationedNow(List<UUID> ids) {
        return jdbc.sql("""
                select o.name as unit, s.name as site from org_stationing x join organization o on o.id = x.organization_id
                  join site s on s.id = x.site_id
                 where x.site_id = any(string_to_array(:ids, ',')::uuid[]) and (x.valid_to is null or x.valid_to > now())
                 order by s.name, o.name""")
                .param("ids", Db.ids(ids)).query((rs, n) -> Map.<String, Object>of("unit", rs.getString("unit"), "site", rs.getString("site"))).list();
    }

    /** Each reason the deletion cannot go ahead, in words; empty when it can. */
    List<String> blockers(List<UUID> ids) {
        String in = Db.ids(ids);
        List<String> out = new ArrayList<>();
        jdbc.sql("select number from restationing_request where site_id = any(string_to_array(:ids, ',')::uuid[]) order by number")
                .param("ids", in).query(String.class).list()
                .forEach(n -> out.add("الطلب " + n + " اعتمد هذا الموقع أو سجّله: يبقى سجل الطلب، فلا يُحذف الموقع."));
        jdbc.sql("""
                select distinct r.number from deployment_area a join restationing_request r on r.id = a.request_id
                 where a.site_id = any(string_to_array(:ids, ',')::uuid[]) and a.request_id is not null order by r.number""")
                .param("ids", in).query(String.class).list()
                .forEach(n -> out.add("مناطق انتشار هنا أُقرت بالطلب " + n + "."));
        jdbc.sql("""
                select distinct r.number from restationing_request r
                 where r.state in (""" + OPEN + """
                ) and (r.requesting_unit_id in (select organization_id from org_stationing where site_id = any(string_to_array(:ids, ',')::uuid[]))
                       or exists (select 1 from jsonb_array_elements_text(coalesce(r.content->'scope', '[]'::jsonb)) u
                                   where u.value in (select organization_id::text from org_stationing where site_id = any(string_to_array(:ids, ',')::uuid[]))))
                 order by r.number""")
                .param("ids", in).query(String.class).list()
                .forEach(n -> out.add("الطلب " + n + " جارٍ لوحدة متمركزة هنا: يُنهى أو يُلغى أولاً."));
        long bookings = jdbc.sql("""
                select (select count(*) from reservation v join resource x on x.id = v.resource_id where x.site_id = any(string_to_array(:ids, ',')::uuid[]))
                     + (select count(*) from reservation_lock v join resource x on x.id = v.resource_id where x.site_id = any(string_to_array(:ids, ',')::uuid[]))
                     + (select count(*) from request_resource v join resource x on x.id = v.resource_id where x.site_id = any(string_to_array(:ids, ',')::uuid[]))""")
                .param("ids", in).query(Long.class).single();
        if (bookings > 0) out.add("حجوزات أو طلبات على مرافق الموقع: " + bookings + ".");
        long relocations = jdbc.sql("select count(*) from request_relocation where from_site_id = any(string_to_array(:ids, ',')::uuid[]) or target_site_id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", in).query(Long.class).single();
        if (relocations > 0) out.add("طلبات نقل سابقة تشير إلى الموقع: " + relocations + ".");
        long scoped = jdbc.sql("""
                select (select count(*) from membership where site_scope_id = any(string_to_array(:ids, ',')::uuid[]) and (valid_to is null or valid_to > now()))
                     + (select count(*) from position_seat where site_scope_id = any(string_to_array(:ids, ',')::uuid[]))""")
                .param("ids", in).query(Long.class).single();
        if (scoped > 0) out.add("صلاحيات أو مقاعد مقيدة بالموقع: " + scoped + ".");
        long returning = jdbc.sql("""
                select count(*) from org_stationing t where t.base_id in (select id from org_stationing where site_id = any(string_to_array(:ids, ',')::uuid[]))
                   and t.site_id <> all(string_to_array(:ids, ',')::uuid[])""")
                .param("ids", in).query(Long.class).single();
        if (returning > 0) out.add("تمركز مؤقت في موقع آخر يعود إلى هذا الموقع.");
        return out;
    }

    // ---- the erase -----------------------------------------------------------------------------------------------------

    /** «حذف الموقع» by the setup administrator: the site and everything inside it, erased, or a refusal naming each reason. */
    @Transactional
    public Map<String, Object> delete(AccessContext ctx, UUID id, ReasonInput in) {
        if (!SiteSetupService.admin(ctx)) {
            throw ApiException.forbidden("حذف الموقع لمدير النظام («تهيئة المواقع والتمركز»)؛ لغيره «طلب حذف».");
        }
        return erase(ctx, id, reason(in == null ? null : in.reason()), null);
    }

    private Map<String, Object> erase(AccessContext ctx, UUID id, String reason, UUID requestId) {
        Map<String, Object> site = siteRow(id);
        List<Map<String, Object>> sites = subtree(id);
        List<UUID> ids = idsOf(sites, "id");
        String in = Db.ids(ids);
        jdbc.sql("select id from site where id = any(string_to_array(:ids, ',')::uuid[]) order by id for update").param("ids", in).query().listOfRows();
        // the only transaction allowed to delete sites, their boundary versions and resources (V50)
        jdbc.sql("select set_config('tmrkz.site_erase', 'on', true)").query().singleRow();
        List<String> blocked = blockers(ids);
        if (!blocked.isEmpty()) {
            throw ApiException.validation("لا يُحذف «" + site.get("name") + "»: " + blocked.get(0), Map.of("problems", blocked));
        }
        Instant now = clock.instant();
        // every unit stationed there now is told it is stationed nowhere, before its record goes
        List<Map<String, Object>> stationings = jdbc.sql("""
                select id, organization_id, site_id from org_stationing
                 where site_id = any(string_to_array(:ids, ',')::uuid[]) and (valid_to is null or valid_to > :now)""")
                .param("ids", in).param("now", Db.ts(now)).query().listOfRows();
        for (Map<String, Object> s : stationings) {
            outbox.enqueue(StationingEvent.Type.STATIONING_REMOVED, (UUID) s.get("organization_id"), (UUID) s.get("site_id"), now, now,
                    "site_deleted", "org_stationing:" + s.get("id"));
        }
        List<String> units = stationedNow(ids).stream().map(r -> (String) r.get("unit")).distinct().toList();
        int areas = jdbc.sql("""
                delete from deployment_area where site_id = any(string_to_array(:ids, ',')::uuid[])
                   or stationing_id in (select id from org_stationing where site_id = any(string_to_array(:ids, ',')::uuid[]))""")
                .param("ids", in).update();
        jdbc.sql("delete from site_link where site_id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("delete from org_stationing where site_id = any(string_to_array(:ids, ',')::uuid[]) and base_id is not null").param("ids", in).update();
        int records = jdbc.sql("delete from org_stationing where site_id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("update map_import_job set target_site_id = null where target_site_id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("delete from site_symbol where site_id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("update resource set parent_resource_id = null where site_id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("delete from resource where site_id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("delete from site_responsibility where site_id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("update site set geometry_version = null, parent_id = null where id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("delete from site_geometry_version where site_id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        jdbc.sql("delete from site where id = any(string_to_array(:ids, ',')::uuid[])").param("ids", in).update();
        // open requests to delete any of them are settled by this deletion
        List<UUID> settled = jdbc.sql("""
                update site_deletion_request set state = case when id = cast(:rq as uuid) then 'APPROVED' else 'SUPERSEDED' end, decided_by = :by,
                       decided_at = :now, decision_reason = :why
                 where state = 'PENDING' and site_id = any(string_to_array(:ids, ',')::uuid[]) returning requested_by""")
                .param("rq", requestId).param("by", ctx.personId()).param("now", Db.ts(now)).param("why", reason).param("ids", in)
                .query(UUID.class).list();
        for (UUID p : settled) {
            notify(p, "حُذف الموقع", "حُذف «" + site.get("name") + "» (" + site.get("code") + ") ومواقعه الداخلية.");
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("code", site.get("code"));
        detail.put("sites", sites.stream().map(s -> s.get("code") + " " + s.get("name")).toList());
        detail.put("unitsStationedNowhere", units);
        detail.put("stationingRecords", records);
        detail.put("deploymentAreas", areas);
        if (requestId != null) detail.put("deletionRequestId", requestId.toString());
        audit.recordAs(ctx.actor(), DELETED, "SITE", id.toString(), (String) site.get("name"), detail, reason);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deleted", sites.stream().map(s -> s.get("code")).toList());
        m.put("unitsStationedNowhere", units);
        return m;
    }

    // ---- requests to delete ------------------------------------------------------------------------------------------

    /** «طلب حذف» by whoever manages the site and is not the administrator: one open request per site, the admins told. */
    @Transactional
    public Map<String, Object> request(AccessContext ctx, UUID id, ReasonInput in) {
        if (!manages(ctx, id)) {
            throw ApiException.forbidden("طلب حذف الموقع لمن يدير الموقع.");
        }
        String reason = reason(in == null ? null : in.reason());
        Map<String, Object> site = siteRow(id);
        if (pending(id) != null) {
            throw ApiException.validation("يوجد طلب حذف مفتوح لهذا الموقع.");
        }
        UUID rq = UUID.randomUUID();
        jdbc.sql("""
                insert into site_deletion_request(id, site_id, site_code, site_name, requested_by, reason, requested_at)
                values (:id, :s, :c, :n, :by, :r, :now)""")
                .param("id", rq).param("s", id).param("c", site.get("code")).param("n", site.get("name")).param("by", ctx.personId())
                .param("r", reason).param("now", Db.ts(clock.instant())).update();
        for (UUID admin : admins()) {
            notify(admin, "طلب حذف موقع", "طُلب حذف «" + site.get("name") + "» (" + site.get("code") + "): " + reason);
        }
        audit.recordAs(ctx.actor(), "SITE_DELETION_REQUESTED", "SITE", id.toString(), (String) site.get("name"), Map.of("requestId", rq.toString()), reason);
        return pending(id);
    }

    /** The open requests (the administrator), or one's own (anyone). */
    public List<Map<String, Object>> list(AccessContext ctx) {
        boolean admin = SiteSetupService.admin(ctx);
        return jdbc.sql("""
                select q.*, p.display_name as requester from site_deletion_request q join person p on p.id = q.requested_by
                 where""" + " " + (admin ? "q.state = 'PENDING'" : "q.requested_by = :me") + " order by q.requested_at desc limit 200")
                .param("me", ctx.personId()).query((rs, n) -> view(rs)).list();
    }

    /** The administrator's decision on a request: «اعتماد الحذف» erases the site, «رفض» keeps it; the requester is told. */
    @Transactional
    public Map<String, Object> decide(AccessContext ctx, UUID requestId, DecisionInput in) {
        if (!SiteSetupService.admin(ctx)) {
            throw ApiException.forbidden("اعتماد حذف المواقع لمدير النظام.");
        }
        Map<String, Object> q = jdbc.sql("select * from site_deletion_request where id = :id and state = 'PENDING' for update")
                .param("id", requestId).query().listOfRows().stream().findFirst()
                .orElseThrow(() -> ApiException.validation("لا طلب حذف مفتوح بهذا المعرف."));
        String reason = reason(in == null ? null : in.reason());
        boolean approve = in != null && "APPROVE".equals(in.decision());
        if (!approve && (in == null || !"REFUSE".equals(in.decision()))) {
            throw ApiException.validation("القرار: APPROVE أو REFUSE.");
        }
        if (approve) {
            return erase(ctx, (UUID) q.get("site_id"), reason, requestId);
        }
        jdbc.sql("update site_deletion_request set state = 'REFUSED', decided_by = :by, decided_at = :now, decision_reason = :why where id = :id")
                .param("by", ctx.personId()).param("now", Db.ts(clock.instant())).param("why", reason).param("id", requestId).update();
        notify((UUID) q.get("requested_by"), "رُفض طلب حذف الموقع", "رُفض حذف «" + q.get("site_name") + "»: " + reason);
        audit.recordAs(ctx.actor(), "SITE_DELETION_REFUSED", "SITE", q.get("site_id").toString(), (String) q.get("site_name"),
                Map.of("requestId", requestId.toString()), reason);
        return Map.of("refused", requestId.toString());
    }

    private Map<String, Object> pending(UUID siteId) {
        return jdbc.sql("""
                select q.*, p.display_name as requester from site_deletion_request q join person p on p.id = q.requested_by
                 where q.site_id = :s and q.state = 'PENDING'""")
                .param("s", siteId).query((rs, n) -> view(rs)).optional().orElse(null);
    }

    private static Map<String, Object> view(java.sql.ResultSet rs) throws java.sql.SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getString("id"));
        m.put("siteId", rs.getString("site_id"));
        m.put("siteCode", rs.getString("site_code"));
        m.put("siteName", rs.getString("site_name"));
        m.put("requester", rs.getString("requester"));
        m.put("reason", rs.getString("reason"));
        m.put("requestedAt", Db.instant(rs, "requested_at").toString());
        m.put("state", rs.getString("state"));
        m.put("decisionReason", rs.getString("decision_reason"));
        return m;
    }

    /** Who decides: everyone whose current role holds facilities and stationing corrections (the setup administrators). */
    private List<UUID> admins() {
        return jdbc.sql("""
                select distinct m.person_id from membership m join role_def r on r.code = m.role_code
                 where (m.valid_to is null or m.valid_to > now()) and 'MANAGE_FACILITIES' = any(r.permissions) and 'CORRECT_STATIONING' = any(r.permissions)""")
                .query(UUID.class).list();
    }

    private void notify(UUID person, String title, String body) {
        jdbc.sql("""
                insert into notification(id, person_id, kind, title, body, created_at, link)
                values (:id, :p, 'SITE_DELETION', :t, :b, :now, '#siteSetup')""")
                .param("id", UUID.randomUUID()).param("p", person).param("t", title).param("b", body).param("now", Db.ts(clock.instant())).update();
    }

    private static String reason(String r) {
        if (r == null || r.trim().length() < 5) {
            throw ApiException.validation("اذكر السبب (5 أحرف على الأقل).");
        }
        return r.trim();
    }
}
