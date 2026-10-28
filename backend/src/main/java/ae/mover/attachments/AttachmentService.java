package ae.mover.attachments;

import java.time.Clock;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.access.ViewLevel;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import ae.mover.policy.PolicyService;
import ae.mover.policy.Settings;
import ae.mover.requests.RequestViews;

@Service
public class AttachmentService {

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AccessService access;
    private final PolicyService policies;
    private final ContentInspector inspector;
    private final FileStore store;
    private final AuditService audit;

    public AttachmentService(JdbcClient jdbc, Clock clock, AccessService access, PolicyService policies,
                             ContentInspector inspector, FileStore store, AuditService audit) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.access = access;
        this.policies = policies;
        this.inspector = inspector;
        this.store = store;
        this.audit = audit;
    }

    public record Download(String fileName, String contentType, byte[] content) {
    }

    /**
     * Stores a new attachment version. Uploads go to drafts/returned requests by their creator, or as handover
     * evidence on approved requests by the holder of an open execution task. Rejected files are recorded (so the
     * user sees why) but their content is never stored or served.
     */
    @Transactional
    public RequestViews.AttachmentView upload(AccessContext ctx, UUID requestId, String fieldId, String fileName, byte[] bytes) {
        Map<String, Object> r = jdbc.sql("select status, created_by, number from request where id = :id for update")
                .param("id", requestId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        var scope = access.requestScope(requestId);
        if (ctx.viewLevel(scope) != ViewLevel.FULL) {
            throw ApiException.notFound();
        }
        String status = (String) r.get("status");
        boolean creatorEditing = ctx.personId().equals(r.get("created_by")) && ctx.has(Permission.CREATE)
                && ("DRAFT".equals(status) || "RETURNED".equals(status));
        boolean evidence = "APPROVED".equals(status) && "evidence".equals(fieldId)
                && jdbc.sql("select role_code, target_org_id from execution_task where request_id = :r and status = 'OPEN'")
                .param("r", requestId).query().listOfRows().stream()
                .anyMatch(t -> ctx.executionGrant((String) t.get("role_code"), (UUID) t.get("target_org_id"), scope).isPresent());
        if (!creatorEditing && !evidence) {
            throw ApiException.forbidden("لا يمكن إضافة مرفقات لهذا الطلب في حالته الحالية.");
        }
        if (fieldId == null || !fieldId.matches("^[a-z][a-z0-9_]{1,39}$")) {
            throw ApiException.validation("معرف حقل المرفق غير صالح.");
        }
        Settings settings = policies.settings();
        if (bytes.length == 0) {
            throw ApiException.validation("الملف فارغ.");
        }
        if (bytes.length > settings.attachmentMaxBytes()) {
            throw ApiException.validation("حجم الملف يتجاوز الحد المسموح (" + settings.attachmentMaxBytes() / (1024 * 1024) + " ميغابايت).");
        }
        String safeName = sanitize(fileName);
        ContentInspector.Inspection inspection = inspector.inspect(safeName, bytes);
        boolean allowedType = settings.allowedAttachmentTypes().contains(inspection.contentType());
        boolean clean = inspection.clean() && allowedType;
        String detail = !allowedType && inspection.clean() ? "نوع الملف غير مسموح وفق سياسة المرفقات." : inspection.detail();
        String sha = Hashing.sha256(bytes);
        String key = clean ? store.putAttachment(bytes, sha) : null;
        int version = jdbc.sql("select coalesce(max(version), 0) + 1 from attachment where request_id = :r and field_id = :f")
                .param("r", requestId).param("f", fieldId).query(Integer.class).single();
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into attachment(id, request_id, field_id, version, file_name, content_type, size_bytes, sha256,
                    storage_key, scan_status, scan_detail, uploaded_by, uploaded_at)
                values (:id, :r, :f, :v, :n, :ct, :size, :sha, :key, :st, :detail, :by, :now)""")
                .param("id", id).param("r", requestId).param("f", fieldId).param("v", version).param("n", safeName)
                .param("ct", inspection.contentType()).param("size", (long) bytes.length).param("sha", sha).param("key", key)
                .param("st", clean ? "CLEAN" : "REJECTED").param("detail", detail).param("by", ctx.personId())
                .param("now", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), clean ? "ATTACHMENT_UPLOADED" : "ATTACHMENT_REJECTED", "REQUEST", requestId.toString(),
                (String) r.get("number"), Map.of("fileName", safeName, "sha256", sha, "fieldId", fieldId, "size", bytes.length), detail);
        return jdbc.sql("select * from attachment where id = :id").param("id", id)
                .query((rs, n) -> new RequestViews.AttachmentView(rs.getString("id"), rs.getString("field_id"),
                        rs.getString("file_name"), rs.getString("content_type"), rs.getLong("size_bytes"), rs.getString("sha256"),
                        rs.getInt("version"), rs.getString("scan_status"), rs.getString("scan_detail"), Db.iso(rs, "uploaded_at")))
                .single();
    }

    /** Download requires FULL view of the request; info recipients and summary viewers never get content. */
    @Transactional
    public Download download(AccessContext ctx, UUID attachmentId) {
        Map<String, Object> a = jdbc.sql("""
                select a.*, r.number from attachment a join request r on r.id = a.request_id where a.id = :id""")
                .param("id", attachmentId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        UUID requestId = (UUID) a.get("request_id");
        if (ctx.viewLevel(access.requestScope(requestId)) != ViewLevel.FULL) {
            throw ApiException.notFound();
        }
        if (!"CLEAN".equals(a.get("scan_status")) || a.get("storage_key") == null) {
            throw new ApiException(ErrorCode.ATTACHMENT_NOT_READY, "المرفق غير متاح: لم يجتز الفحص أو ما زال قيد المعالجة.");
        }
        audit.recordAs(ctx.actor(), "ATTACHMENT_DOWNLOADED", "REQUEST", requestId.toString(), (String) a.get("number"),
                Map.of("attachmentId", attachmentId.toString(), "fileName", a.get("file_name")), null);
        return new Download((String) a.get("file_name"), (String) a.get("content_type"), store.read((String) a.get("storage_key")));
    }

    private static String sanitize(String name) {
        if (name == null || name.isBlank()) {
            return "file";
        }
        String base = name.replace('\\', '/');
        base = base.substring(base.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}\"<>|:*?]", "_").trim();
        return base.length() > 150 ? base.substring(base.length() - 150) : base;
    }
}
