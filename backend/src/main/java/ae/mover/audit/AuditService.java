package ae.mover.audit;

import java.util.Map;
import java.util.UUID;

import org.slf4j.MDC;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import ae.mover.common.Json;
import ae.mover.security.Actor;

/**
 * Writes the production audit trail. Rows are append-only (database triggers reject UPDATE/DELETE/TRUNCATE) and
 * are written inside the caller's transaction, so an audited action and its audit row commit or roll back together.
 */
@Service
public class AuditService {

    private final JdbcClient jdbc;
    private final Json json;

    public AuditService(JdbcClient jdbc, Json json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Capacity of the actor at the time of the action (role, organisation, delegation). */
    public record Capacity(String roleName, String orgName, UUID delegationId) {
        public static final Capacity NONE = new Capacity(null, null, null);
    }

    public void recordAs(Actor actor, String action, String entityType, String entityId, String entityLabel,
                         Map<String, ?> detail, String reason) {
        record(actor, Capacity.NONE, action, entityType, entityId, entityLabel, detail, reason, null);
    }

    public void record(Actor actor, Capacity capacity, String action, String entityType, String entityId,
                       String entityLabel, Map<String, ?> detail, String reason, Integer revision) {
        jdbc.sql("""
                insert into audit_event(actor_person_id, actor_name, actor_role, actor_org, via_delegation_id, action,
                                        entity_type, entity_id, entity_label, detail, reason, revision, trace_id)
                values (:pid, :pname, :role, :org, :del, :action, :etype, :eid, :elabel, cast(:detail as jsonb),
                        :reason, :rev, :trace)""")
                .param("pid", actor == null ? null : actor.personId())
                .param("pname", actor == null ? "النظام" : actor.displayName())
                .param("role", capacity.roleName())
                .param("org", capacity.orgName())
                .param("del", capacity.delegationId())
                .param("action", action)
                .param("etype", entityType)
                .param("eid", entityId)
                .param("elabel", entityLabel)
                .param("detail", json.write(detail == null ? Map.of() : detail))
                .param("reason", reason)
                .param("rev", revision)
                .param("trace", MDC.get("traceId"))
                .update();
    }

    public void system(String action, String entityType, String entityId, String entityLabel, Map<String, ?> detail) {
        record(null, Capacity.NONE, action, entityType, entityId, entityLabel, detail, null, null);
    }

    public static final Map<String, String> LABELS = Map.ofEntries(
            Map.entry("LOGIN", "تسجيل دخول"),
            Map.entry("LOGIN_FAILED", "محاولة دخول فاشلة"),
            Map.entry("LOGOUT", "تسجيل خروج"),
            Map.entry("DEMO_SWITCH", "تبديل مستخدم تجريبي"),
            Map.entry("REQUEST_CREATED", "إنشاء طلب"),
            Map.entry("DRAFT_SAVED", "حفظ مسودة"),
            Map.entry("REQUEST_SUBMITTED", "تقديم الطلب"),
            Map.entry("REQUEST_RESUBMITTED", "إعادة تقديم"),
            Map.entry("STAGE_CARRIED_FORWARD", "حمل موافقة سابقة"),
            Map.entry("TASK_APPROVED", "موافقة"),
            Map.entry("REQUEST_RETURNED", "إرجاع للتعديل"),
            Map.entry("REQUEST_REJECTED", "رفض الطلب"),
            Map.entry("APPROVAL_SIGNED", "اعتماد وتوثيق"),
            Map.entry("REQUEST_APPROVED", "تثبيت القرار والحجز الإداري"),
            Map.entry("RESERVATION_CREATED", "إنشاء حجز"),
            Map.entry("RESERVATION_CHANGED", "تغيير حجز"),
            Map.entry("RESERVATION_RELEASED", "إخلاء حجز"),
            Map.entry("EXECUTION_COMPLETED", "إكمال مهمة تنفيذ"),
            Map.entry("REQUEST_CLOSED", "تأكيد التنفيذ وإغلاق الطلب"),
            Map.entry("ATTACHMENT_UPLOADED", "رفع مرفق"),
            Map.entry("ATTACHMENT_REJECTED", "رفض مرفق"),
            Map.entry("ATTACHMENT_DOWNLOADED", "تنزيل مرفق"),
            Map.entry("FORM_DRAFT_SAVED", "حفظ مسودة نموذج"),
            Map.entry("FORM_PUBLISHED", "نشر إصدار نموذج"),
            Map.entry("WORKFLOW_DRAFT_SAVED", "حفظ مسودة تدفق"),
            Map.entry("WORKFLOW_PUBLISHED", "نشر إصدار تدفق"),
            Map.entry("POLICY_DRAFT_SAVED", "حفظ مسودة سياسة"),
            Map.entry("POLICY_PUBLISHED", "نشر إعدادات"),
            Map.entry("ROLE_UPDATED", "تعديل صلاحيات دور"),
            Map.entry("MEMBERSHIP_CREATED", "إضافة عضوية"),
            Map.entry("MEMBERSHIP_ENDED", "إنهاء عضوية"),
            Map.entry("TASKS_REALIGNED", "إعادة مواءمة المهام"),
            Map.entry("DELEGATION_CREATED", "إنشاء تفويض"),
            Map.entry("DELEGATION_REVOKED", "إلغاء تفويض"),
            Map.entry("SITE_CREATED", "إنشاء موقع"),
            Map.entry("SITE_UPDATED", "تعديل موقع"),
            Map.entry("SITE_RETIRED", "إيقاف موقع"),
            Map.entry("RESOURCE_CREATED", "إنشاء مورد"),
            Map.entry("EXPORT_CREATED", "إنشاء تصدير"),
            Map.entry("EXPORT_DOWNLOADED", "تنزيل تصدير"),
            Map.entry("ORG_IMPORT_PREVIEWED", "معاينة استيراد الهيكل"),
            Map.entry("ORG_IMPORT_COMMITTED", "اعتماد استيراد الهيكل"),
            Map.entry("MAP_PACKAGE_INSTALLED", "تثبيت حزمة خرائط"),
            Map.entry("MAP_PACKAGE_UPLOADED", "رفع حزمة خرائط للمراجعة"),
            Map.entry("MAP_PACKAGE_ACTIVATED", "تفعيل حزمة خرائط"),
            Map.entry("MAP_PACKAGE_DISABLED", "تعطيل حزمة خرائط"),
            Map.entry("MAP_PACKAGE_REJECTED", "رفض حزمة خرائط"),
            Map.entry("SITE_BOUNDARY_PUBLISHED", "نشر إصدار حدود موقع"),
            Map.entry("MAP_IMPORT_PREVIEWED", "معاينة استيراد حدود"),
            Map.entry("MAP_IMPORT_REJECTED", "رفض ملف حدود"),
            Map.entry("MAP_IMPORT_PUBLISHED", "نشر حدود مستوردة"),
            Map.entry("MAP_IMPORT_CANCELLED", "إلغاء استيراد حدود"),
            Map.entry("MAP_BOUNDARIES_EXPORTED", "تصدير حدود المواقع"),
            Map.entry("DEMO_DATA_SEEDED", "تهيئة بيانات تجريبية"));
}
