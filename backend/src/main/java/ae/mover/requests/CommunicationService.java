package ae.mover.requests;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.annotation.JsonInclude;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.RequestScope;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Ref;
import ae.mover.common.Times;
import ae.mover.system.IdempotencyService;

/**
 * Communication of a decision (owner brief of 30 Oct 2026 §5E): who communicated which outcome, to whom, when, by
 * which channel and which document revision. A record is append-only and grants nothing; information recipients of the
 * request remain a separate list without tasks. Recording needs a review, approval or closing right over the request;
 * reading needs the full view.
 */
@Service
public class CommunicationService {

    static final Set<String> CHANNELS = Set.of("IN_APP", "INTERNAL_MAIL", "OFFICIAL_LETTER", "HAND_DELIVERY", "OTHER");

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AccessService access;
    private final AuditService audit;
    private final IdempotencyService idempotency;

    public CommunicationService(JdbcClient jdbc, Clock clock, AccessService access, AuditService audit, IdempotencyService idempotency) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.access = access;
        this.audit = audit;
        this.idempotency = idempotency;
    }

    public record Input(String recipientKind, String recipientOrgId, String recipientPersonId, String recipientText, String channel,
                        String reference, String communicatedAt, String note) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record View(String id, int revision, String outcome, String recipientKind, Ref recipientOrg, Ref recipientPerson,
                       String recipientText, String channel, String reference, Integer documentRevision, String documentSha256,
                       String communicatedAt, String recordedBy, String recordedAt, String note) {
    }

    private RequestScope fullView(AccessContext ctx, UUID requestId) {
        RequestScope scope = access.requestScope(requestId);
        if (scope == null || ctx.viewLevel(scope) == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        if (ctx.viewLevel(scope) != ViewLevel.FULL) {
            throw ApiException.forbidden("سجل الإبلاغ جزء من محتوى الطلب الكامل.");
        }
        ctx.confirmView(scope, ViewLevel.FULL);
        return scope;
    }

    public List<View> list(AccessContext ctx, UUID requestId) {
        fullView(ctx, requestId);
        return jdbc.sql("""
                select c.*, o.name as org_name, p.display_name as person_name from decision_communication c
                left join organization o on o.id = c.recipient_org_id left join person p on p.id = c.recipient_person_id
                where c.request_id = :id order by c.communicated_at, c.recorded_at""")
                .param("id", requestId)
                .query((rs, n) -> new View(rs.getString("id"), rs.getInt("revision"), rs.getString("outcome"),
                        rs.getString("recipient_kind"), Ref.of(Db.uuid(rs, "recipient_org_id"), rs.getString("org_name")),
                        Ref.of(Db.uuid(rs, "recipient_person_id"), rs.getString("person_name")), rs.getString("recipient_text"),
                        rs.getString("channel"), rs.getString("reference"), (Integer) rs.getObject("document_revision"),
                        rs.getString("document_sha256"), Db.iso(rs, "communicated_at"), rs.getString("recorded_by_name"),
                        Db.iso(rs, "recorded_at"), rs.getString("note")))
                .list();
    }

    @Transactional
    public List<View> record(AccessContext ctx, UUID requestId, Input in, String idemKey) {
        return idempotency.run(ctx.actor(), idemKey, "communication:" + requestId, in, () -> {
            doRecord(ctx, requestId, in);
            return list(ctx, requestId);
        }, () -> list(ctx, requestId));
    }

    private void doRecord(AccessContext ctx, UUID requestId, Input in) {
        Map<String, Object> r = jdbc.sql("select number, status, current_revision from request where id = :id for update")
                .param("id", requestId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        RequestScope scope = fullView(ctx, requestId);
        Permission right = List.of(Permission.APPROVE, Permission.REVIEW, Permission.CLOSE).stream()
                .filter(p -> ctx.grants().stream().anyMatch(g -> g.has(p) && g.coversRequest(scope))).findFirst()
                .orElseThrow(() -> ApiException.forbidden("تسجيل إبلاغ القرار لمن يملك المراجعة أو الاعتماد أو الإغلاق على نطاق الطلب."));
        ctx.confirmTask("", null, scope, right);
        String status = (String) r.get("status");
        if (!Set.of("APPROVED", "REJECTED", "RETURNED", "CLOSED").contains(status)) {
            throw ApiException.validation("لا يوجد قرار لإبلاغه بعد: الطلب " + ("DRAFT".equals(status) ? "مسودة." : "قيد المراجعة."));
        }
        if (in == null) {
            throw ApiException.validation("بيانات الإبلاغ مطلوبة.");
        }
        String kind = in.recipientKind() == null ? "" : in.recipientKind();
        UUID org = null;
        UUID person = null;
        String text = in.recipientText() == null || in.recipientText().isBlank() ? null : in.recipientText().trim();
        switch (kind) {
            case "ORGANIZATION" -> {
                org = uuid(in.recipientOrgId(), "الجهة المبلَّغة");
                if (jdbc.sql("select count(*) from organization where id = :id").param("id", org).query(Integer.class).single() == 0) {
                    throw ApiException.validation("الجهة المبلَّغة غير موجودة.");
                }
            }
            case "PERSON" -> {
                person = uuid(in.recipientPersonId(), "الشخص المبلَّغ");
                if (jdbc.sql("select count(*) from person where id = :id").param("id", person).query(Integer.class).single() == 0) {
                    throw ApiException.validation("الشخص المبلَّغ غير موجود.");
                }
            }
            case "OTHER" -> {
                if (text == null || text.length() < 2 || text.length() > 200) {
                    throw ApiException.validation("اكتب اسم الجهة أو الشخص المبلَّغ (2–200 حرف).");
                }
            }
            default -> throw ApiException.validation("حدد المبلَّغ: جهة أو شخص أو غير ذلك.");
        }
        if (in.channel() == null || !CHANNELS.contains(in.channel())) {
            throw ApiException.validation("قناة الإبلاغ غير معروفة.");
        }
        Instant now = clock.instant();
        Instant at = in.communicatedAt() == null || in.communicatedAt().isBlank() ? now : Times.parse(in.communicatedAt(), "وقت الإبلاغ");
        if (at.isAfter(now.plus(Duration.ofMinutes(5)))) {
            throw ApiException.validation("وقت الإبلاغ في المستقبل.");
        }
        String reference = in.reference() == null || in.reference().isBlank() ? null : in.reference().trim();
        String note = in.note() == null || in.note().isBlank() ? null : in.note().trim();
        if ((reference != null && reference.length() > 120) || (note != null && note.length() > 2000)) {
            throw ApiException.validation("المرجع أو الملاحظة أطول من المسموح.");
        }
        int revision = ((Number) r.get("current_revision")).intValue();
        // the outcome communicated is the request's current state; an approval is communicated with its document version
        String outcome = "CLOSED".equals(status) ? "CLOSED" : status;
        UUID decisionId = jdbc.sql("""
                select id from decision where request_id = :id and decision in ('APPROVE', 'RETURN', 'REJECT')
                order by decided_at desc limit 1""").param("id", requestId).query(UUID.class).optional().orElse(null);
        Map<String, Object> doc = Set.of("APPROVED", "CLOSED").contains(status)
                ? jdbc.sql("select revision, sha256 from approval_document where request_id = :id order by revision desc limit 1")
                        .param("id", requestId).query().listOfRows().stream().findFirst().orElse(null)
                : null;
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into decision_communication(id, request_id, decision_id, revision, outcome, recipient_kind, recipient_org_id,
                    recipient_person_id, recipient_text, channel, reference, document_revision, document_sha256, communicated_at,
                    recorded_by, recorded_by_name, recorded_at, note)
                values (:id, :req, :dec, :rev, :out, :kind, :org, :person, :text, :ch, :ref, :drev, :dsha, :at, :by, :byName, :now, :note)""")
                .param("id", id).param("req", requestId).param("dec", decisionId).param("rev", revision).param("out", outcome)
                .param("kind", kind).param("org", org).param("person", person).param("text", "OTHER".equals(kind) ? text : null)
                .param("ch", in.channel()).param("ref", reference)
                .param("drev", doc == null ? null : doc.get("revision")).param("dsha", doc == null ? null : doc.get("sha256"))
                .param("at", Db.ts(at)).param("by", ctx.personId()).param("byName", ctx.actor().displayName())
                .param("now", Db.ts(now)).param("note", note).update();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("outcome", outcome);
        detail.put("channel", in.channel());
        detail.put("recipientKind", kind);
        if (doc != null) {
            detail.put("documentRevision", doc.get("revision"));
        }
        audit.recordAs(ctx.actor(), "DECISION_COMMUNICATED", "REQUEST", requestId.toString(), (String) r.get("number"), detail, note);
    }

    private static UUID uuid(String v, String label) {
        try {
            return UUID.fromString(v);
        } catch (RuntimeException e) {
            throw ApiException.validation("معرف غير صالح في «" + label + "».");
        }
    }
}
