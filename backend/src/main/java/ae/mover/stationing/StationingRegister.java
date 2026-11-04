package ae.mover.stationing;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;

/**
 * Authoritative stationing ({@code org_stationing}, V3 §1.4.3) and site ↔ unit links ({@code site_link}, §6) — two
 * separate records. A stationing is recorded only by an activated re-stationing request (request workflow, later) or
 * by a data correction with CORRECT_STATIONING; a link is created and ended with MANAGE_SITE_LINKS and never becomes
 * stationing or occupancy (O-15). Every change writes its outbound event in the same transaction
 * ({@link StationingOutbox}) and an audit record. Reads return only units a VIEW grant reaches
 * ({@link StationingReadAccess}), confirmed by OpenFGA where the context carries a second decision.
 */
@Service
public class StationingRegister {

    public record StationingRecord(UUID id, UUID orgId, String orgCode, String orgName, String orgExternalId, UUID siteId,
                                   String siteCode, String siteName, String kind, UUID baseId, Instant validFrom, Instant validTo,
                                   Instant plannedEnd, String origin, UUID requestId, String reason, String reference,
                                   String endReason, Instant recordedAt) {
    }

    public record SiteLinkRecord(UUID id, UUID siteId, String siteName, UUID orgId, String orgName, String orgExternalId,
                                 Instant validFrom, Instant validTo, String source, String reason, String endedReason) {
    }

    public record CorrectionInput(UUID organizationId, UUID siteId, Instant effectiveFrom, String reason, String reference) {
    }

    public record LinkInput(UUID siteId, UUID organizationId, Instant validFrom, String reason) {
    }

    public record EndInput(String reason) {
    }

    private final JdbcClient jdbc;
    private final AuditService audit;
    private final StationingOutbox outbox;
    private final StationingPolicyStore policies;

    public StationingRegister(JdbcClient jdbc, AuditService audit, StationingOutbox outbox, StationingPolicyStore policies) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.outbox = outbox;
        this.policies = policies;
    }

    // ---- reads ---------------------------------------------------------------------------------------

    /** Current stationing (permanent, and a temporary one in force) of the units this actor may read. */
    public List<StationingRecord> current(AccessContext ctx, UUID orgId, UUID siteId, Instant at) {
        String where = "where s.valid_from <= :at and (s.valid_to is null or s.valid_to > :at) and s.start_held_at is null"
                + (orgId == null ? "" : " and s.organization_id = :org") + (siteId == null ? "" : " and s.site_id = :site");
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("at", Db.ts(at));
        if (orgId != null) {
            p.put("org", orgId);
        }
        if (siteId != null) {
            p.put("site", siteId);
        }
        return records(where + " order by o.code, s.kind", p).stream().filter(r -> readable(ctx, r.orgId())).toList();
    }

    /** The full stationing history of one unit (nothing is deleted). */
    public List<StationingRecord> history(AccessContext ctx, UUID orgId) {
        if (!readable(ctx, orgId)) {
            throw ApiException.notFound();
        }
        return records("where s.organization_id = :org order by s.valid_from, s.recorded_at", Map.of("org", orgId));
    }

    public List<SiteLinkRecord> links(AccessContext ctx, UUID siteId, UUID orgId, boolean includeEnded) {
        String where = "where true" + (includeEnded ? "" : " and l.valid_to is null") + (siteId == null ? "" : " and l.site_id = :site")
                + (orgId == null ? "" : " and l.organization_id = :org");
        Map<String, Object> p = new LinkedHashMap<>();
        if (siteId != null) {
            p.put("site", siteId);
        }
        if (orgId != null) {
            p.put("org", orgId);
        }
        return jdbc.sql("""
                select l.id, l.site_id, si.name as site_name, l.organization_id, o.name as org_name, o.source_external_id,
                       l.valid_from, l.valid_to, l.source, l.reason, l.ended_reason
                  from site_link l join site si on si.id = l.site_id join organization o on o.id = l.organization_id
                """ + where + " order by l.valid_from").params(p)
                .query((rs, n) -> new SiteLinkRecord(Db.uuid(rs, "id"), Db.uuid(rs, "site_id"), rs.getString("site_name"),
                        Db.uuid(rs, "organization_id"), rs.getString("org_name"), rs.getString("source_external_id"),
                        Db.instant(rs, "valid_from"), Db.instant(rs, "valid_to"), rs.getString("source"), rs.getString("reason"),
                        rs.getString("ended_reason")))
                .list().stream().filter(l -> readable(ctx, l.orgId())).toList();
    }

    /** VIEW reaching the unit (first decision) and, where the context carries it, OpenFGA's agreement. */
    boolean readable(AccessContext ctx, UUID orgId) {
        return ctx.remember("stationing-read:" + orgId,
                () -> StationingReadAccess.visible(ctx.grants(), orgId) && ctx.canFor(Permission.VIEW, orgId));
    }

    // ---- correction ----------------------------------------------------------------------------------

    /**
     * Records the current permanent stationing of a unit as a data correction: the open permanent record (if any) ends at
     * the effective time as CORRECTED and the new one starts there. History stays; an overlap is refused by the database.
     * A unit in a temporary stationing is not corrected here (its lifecycle belongs to the request workflow).
     */
    @Transactional
    public StationingRecord correct(AccessContext ctx, CorrectionInput in, Instant now) {
        if (in == null || in.organizationId() == null || in.siteId() == null) {
            throw ApiException.validation("حدد الوحدة والموقع.");
        }
        if (in.reason() == null || in.reason().trim().length() < 5) {
            throw ApiException.validation("اكتب سبب التصحيح (5 أحرف على الأقل).");
        }
        if (!ctx.canFor(Permission.CORRECT_STATIONING, in.organizationId())) {
            throw ApiException.forbidden("تصحيح تمركز هذه الوحدة يحتاج صلاحية تصحيح التمركز في نطاقها.");
        }
        Instant effective = in.effectiveFrom() == null ? now : in.effectiveFrom();
        if (effective.isAfter(now)) {
            throw ApiException.validation("التصحيح يسجل واقعاً قائماً؛ لا يكون تاريخه في المستقبل.");
        }
        requireActive("site", in.siteId(), "الموقع غير موجود أو موقوف.");
        requireActive("organization", in.organizationId(), "الوحدة غير موجودة أو موقوفة.");
        jdbc.sql("select id from organization where id = :id for update").param("id", in.organizationId()).query().listOfRows();
        if (!records("where s.organization_id = :org and s.kind = 'TEMPORARY' and s.valid_to is null", Map.of("org", in.organizationId()))
                .isEmpty()) {
            throw ApiException.validation("للوحدة تمركز مؤقت قائم؛ يُدار من طلبه لا بالتصحيح.");
        }
        StationingRecord open = records("where s.organization_id = :org and s.kind = 'PERMANENT' and s.valid_to is null",
                Map.of("org", in.organizationId())).stream().findFirst().orElse(null);
        if (open != null && open.siteId().equals(in.siteId())) {
            throw ApiException.validation("الوحدة متمركزة في هذا الموقع حالياً.");
        }
        if (open != null && !effective.isAfter(open.validFrom())) {
            throw ApiException.validation("تاريخ التصحيح قبل بدء التمركز الحالي (" + open.validFrom() + ").");
        }
        UUID id = UUID.randomUUID();
        try {
            if (open != null) {
                jdbc.sql("""
                        update org_stationing set valid_to = :t, end_reason = 'CORRECTED', ended_by = :by, ended_at = :now
                         where id = :id and valid_to is null""")
                        .param("t", Db.ts(effective)).param("by", ctx.personId()).param("now", Db.ts(now)).param("id", open.id()).update();
            }
            jdbc.sql("""
                    insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, reference, recorded_by,
                                               recorded_at)
                    values (:id, :org, :site, 'PERMANENT', :from, 'CORRECTION', :reason, :ref, :by, :now)""")
                    .param("id", id).param("org", in.organizationId()).param("site", in.siteId()).param("from", Db.ts(effective))
                    .param("reason", in.reason().trim()).param("ref", blankToNull(in.reference())).param("by", ctx.personId())
                    .param("now", Db.ts(now)).update();
        } catch (DataAccessException e) {
            if (Db.isExclusionViolation(e)) {
                throw ApiException.validation("يتداخل هذا التمركز مع تمركز مسجل للوحدة في الفترة نفسها.");
            }
            throw e;
        }
        StationingRecord saved = records("where s.id = :id", Map.of("id", id)).getFirst();
        outbox.enqueue(StationingEvent.Type.STATIONING_CORRECTED, in.organizationId(), in.siteId(), effective, now,
                sourceVersion(now), "org_stationing:" + id);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("organizationId", in.organizationId().toString());
        detail.put("siteId", in.siteId().toString());
        detail.put("previousSiteId", open == null ? null : open.siteId().toString());
        detail.put("effectiveFrom", effective.toString());
        detail.put("reference", saved.reference());
        audit.recordAs(ctx.actor(), "STATIONING_CORRECTED", "ORG_STATIONING", id.toString(), saved.orgName() + " ← " + saved.siteName(),
                detail, saved.reason());
        return saved;
    }

    // ---- links ---------------------------------------------------------------------------------------

    @Transactional
    public SiteLinkRecord link(AccessContext ctx, LinkInput in, Instant now) {
        if (in == null || in.siteId() == null || in.organizationId() == null) {
            throw ApiException.validation("حدد الموقع والوحدة.");
        }
        if (in.reason() == null || in.reason().trim().length() < 5) {
            throw ApiException.validation("اكتب سبب الربط (5 أحرف على الأقل).");
        }
        if (!ctx.canFor(Permission.MANAGE_SITE_LINKS, in.organizationId())) {
            throw ApiException.forbidden("ربط الموقع بهذه الوحدة يحتاج صلاحية إدارة روابط المواقع في نطاقها.");
        }
        requireActive("site", in.siteId(), "الموقع غير موجود أو موقوف.");
        requireActive("organization", in.organizationId(), "الوحدة غير موجودة أو موقوفة.");
        Instant from = in.validFrom() == null ? now : in.validFrom();
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("""
                    insert into site_link(id, site_id, organization_id, valid_from, reason, created_by, created_at)
                    values (:id, :site, :org, :from, :reason, :by, :now)""")
                    .param("id", id).param("site", in.siteId()).param("org", in.organizationId()).param("from", Db.ts(from))
                    .param("reason", in.reason().trim()).param("by", ctx.personId()).param("now", Db.ts(now)).update();
        } catch (DataAccessException e) {
            throw ApiException.validation("الموقع مرتبط بهذه الوحدة حالياً.");
        }
        outbox.enqueue(StationingEvent.Type.SITE_LINK_CREATED, in.organizationId(), in.siteId(), from, now, sourceVersion(now),
                "site_link:" + id);
        SiteLinkRecord saved = link(id);
        audit.recordAs(ctx.actor(), "SITE_LINK_CREATED", "SITE_LINK", id.toString(), saved.orgName() + " ↔ " + saved.siteName(),
                Map.of("siteId", in.siteId().toString(), "organizationId", in.organizationId().toString(), "validFrom", from.toString()),
                saved.reason());
        return saved;
    }

    @Transactional
    public SiteLinkRecord endLink(AccessContext ctx, UUID id, EndInput in, Instant now) {
        SiteLinkRecord l = link(id);
        if (!ctx.canFor(Permission.MANAGE_SITE_LINKS, l.orgId())) {
            throw ApiException.forbidden("إنهاء الربط يحتاج صلاحية إدارة روابط المواقع في نطاق الوحدة.");
        }
        if (in == null || in.reason() == null || in.reason().trim().length() < 5) {
            throw ApiException.validation("اكتب سبب إنهاء الربط (5 أحرف على الأقل).");
        }
        if (l.validTo() != null) {
            throw ApiException.validation("الربط منتهٍ.");
        }
        Instant to = now.isAfter(l.validFrom()) ? now : l.validFrom().plusSeconds(1);
        jdbc.sql("update site_link set valid_to = :t, ended_by = :by, ended_reason = :r where id = :id and valid_to is null")
                .param("t", Db.ts(to)).param("by", ctx.personId()).param("r", in.reason().trim()).param("id", id).update();
        outbox.enqueue(StationingEvent.Type.SITE_LINK_ENDED, l.orgId(), l.siteId(), to, now, sourceVersion(now), "site_link:" + id + ":end");
        audit.recordAs(ctx.actor(), "SITE_LINK_ENDED", "SITE_LINK", id.toString(), l.orgName() + " ↔ " + l.siteName(),
                Map.of("validTo", to.toString()), in.reason().trim());
        return link(id);
    }

    // ---- helpers -------------------------------------------------------------------------------------

    private SiteLinkRecord link(UUID id) {
        return jdbc.sql("""
                select l.id, l.site_id, si.name as site_name, l.organization_id, o.name as org_name, o.source_external_id,
                       l.valid_from, l.valid_to, l.source, l.reason, l.ended_reason
                  from site_link l join site si on si.id = l.site_id join organization o on o.id = l.organization_id
                 where l.id = :id""").param("id", id)
                .query((rs, n) -> new SiteLinkRecord(Db.uuid(rs, "id"), Db.uuid(rs, "site_id"), rs.getString("site_name"),
                        Db.uuid(rs, "organization_id"), rs.getString("org_name"), rs.getString("source_external_id"),
                        Db.instant(rs, "valid_from"), Db.instant(rs, "valid_to"), rs.getString("source"), rs.getString("reason"),
                        rs.getString("ended_reason")))
                .optional().orElseThrow(ApiException::notFound);
    }

    /** The policy version in force (the event's {@code sourceVersion}); "none" before the first version. */
    private String sourceVersion(Instant now) {
        return policies.inForce(now).map(v -> "policy:" + v.version()).orElse("policy:none");
    }

    private void requireActive(String table, UUID id, String message) {
        long n = jdbc.sql("select count(*) from " + table + " where id = :id and status = 'ACTIVE'").param("id", id)
                .query(Long.class).single();
        if (n == 0) {
            throw ApiException.validation(message);
        }
    }

    private List<StationingRecord> records(String where, Map<String, ?> params) {
        return jdbc.sql("""
                select s.id, s.organization_id, o.code as org_code, o.name as org_name, o.source_external_id, s.site_id,
                       si.code as site_code, si.name as site_name, s.kind, s.base_id, s.valid_from, s.valid_to, s.planned_end,
                       s.origin, s.request_id, s.reason, s.reference, s.end_reason, s.recorded_at
                  from org_stationing s join organization o on o.id = s.organization_id join site si on si.id = s.site_id
                """ + where).params(params)
                .query((rs, n) -> new StationingRecord(Db.uuid(rs, "id"), Db.uuid(rs, "organization_id"), rs.getString("org_code"),
                        rs.getString("org_name"), rs.getString("source_external_id"), Db.uuid(rs, "site_id"), rs.getString("site_code"),
                        rs.getString("site_name"), rs.getString("kind"), Db.uuid(rs, "base_id"), Db.instant(rs, "valid_from"),
                        Db.instant(rs, "valid_to"), Db.instant(rs, "planned_end"), rs.getString("origin"), Db.uuid(rs, "request_id"),
                        rs.getString("reason"), rs.getString("reference"), rs.getString("end_reason"), Db.instant(rs, "recorded_at")))
                .list();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
