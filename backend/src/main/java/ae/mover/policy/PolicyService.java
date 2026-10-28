package ae.mover.policy;

import java.time.Clock;
import java.time.ZoneId;
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
import ae.mover.common.Json;

@Service
public class PolicyService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;

    public PolicyService(JdbcClient jdbc, Json json, Clock clock, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
    }

    public record PolicyVersion(UUID id, int version, String status, Settings settings, String publishedAt,
                                String publishedBy, List<Map<String, String>> errors) {
    }

    public PolicyVersion current() {
        return jdbc.sql("""
                select pv.*, p.display_name as publisher from policy_version pv left join person p on p.id = pv.published_by
                where pv.status = 'PUBLISHED' order by pv.version desc limit 1""")
                .query((rs, n) -> new PolicyVersion(Db.uuid(rs, "id"), rs.getInt("version"), rs.getString("status"),
                        json.read(rs.getString("settings"), Settings.class), Db.iso(rs, "published_at"),
                        rs.getString("publisher"), List.of()))
                .optional().orElseThrow(() -> new IllegalStateException("No published policy version"));
    }

    public Settings settings() {
        return current().settings();
    }

    public List<PolicyVersion> history() {
        return jdbc.sql("""
                select pv.*, p.display_name as publisher from policy_version pv left join person p on p.id = pv.published_by
                order by pv.version desc""")
                .query((rs, n) -> new PolicyVersion(Db.uuid(rs, "id"), rs.getInt("version"), rs.getString("status"),
                        json.read(rs.getString("settings"), Settings.class), Db.iso(rs, "published_at"),
                        rs.getString("publisher"), List.of()))
                .list();
    }

    public List<Map<String, String>> validate(Settings s) {
        List<Map<String, String>> errors = new ArrayList<>();
        if (s == null) {
            errors.add(error("settings", "الإعدادات مطلوبة."));
            return errors;
        }
        if (!List.of("INTERNAL_ATTESTATION", "PKI").contains(s.signatureMode())) {
            errors.add(error("signatureMode", "نوع التوقيع غير مدعوم."));
        }
        if (!List.of("DAYS", "HOURS").contains(s.defaultUnit())) {
            errors.add(error("defaultUnit", "وحدة الفترة غير مدعومة."));
        }
        if (s.attachmentMaxBytes() < 1024 || s.attachmentMaxBytes() > 25L * 1024 * 1024) {
            errors.add(error("attachmentMaxBytes", "حد حجم المرفقات يجب أن يكون بين 1 كيلوبايت و25 ميغابايت."));
        }
        if (s.allowedAttachmentTypes() == null || s.allowedAttachmentTypes().isEmpty()
                || !Settings.SUPPORTED_TYPES.containsAll(s.allowedAttachmentTypes())) {
            errors.add(error("allowedAttachmentTypes", "أنواع المرفقات يجب أن تكون من القائمة المدعومة."));
        }
        try {
            ZoneId.of(s.timezone());
        } catch (Exception e) {
            errors.add(error("timezone", "المنطقة الزمنية غير صحيحة."));
        }
        return errors;
    }

    private static Map<String, String> error(String path, String message) {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("path", path);
        m.put("message", message);
        return m;
    }

    @Transactional
    public PolicyVersion saveDraft(AccessContext ctx, Settings settings) {
        ctx.require(Permission.CONFIGURE);
        List<Map<String, String>> errors = validate(settings);
        if (!errors.isEmpty()) {
            throw ApiException.validation("الإعدادات غير صالحة.", Map.of("errors", errors));
        }
        jdbc.sql("delete from policy_version where status = 'DRAFT'").update();
        int next = jdbc.sql("select coalesce(max(version), 0) + 1 from policy_version").query(Integer.class).single();
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into policy_version(id, version, status, settings, created_by, created_at) values (:id, :v, 'DRAFT', cast(:s as jsonb), :by, :at)")
                .param("id", id).param("v", next).param("s", json.write(settings)).param("by", ctx.personId())
                .param("at", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), "POLICY_DRAFT_SAVED", "POLICY", id.toString(), "v" + next, Map.of(), null);
        return new PolicyVersion(id, next, "DRAFT", settings, null, null, List.of());
    }

    @Transactional
    public PolicyVersion publish(AccessContext ctx, UUID id) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> row = jdbc.sql("select version, status, settings::text as settings from policy_version where id = :id for update")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!"DRAFT".equals(row.get("status"))) {
            throw ApiException.validation("يمكن نشر المسودات فقط.");
        }
        Settings settings = json.read((String) row.get("settings"), Settings.class);
        List<Map<String, String>> errors = validate(settings);
        if (!errors.isEmpty()) {
            throw ApiException.validation("الإعدادات غير صالحة.", Map.of("errors", errors));
        }
        PolicyVersion previous = current();
        jdbc.sql("update policy_version set status = 'RETIRED' where status = 'PUBLISHED'").update();
        jdbc.sql("update policy_version set status = 'PUBLISHED', published_by = :by, published_at = :at where id = :id")
                .param("by", ctx.personId()).param("at", Db.ts(clock.instant())).param("id", id).update();
        Map<String, Object> diff = new LinkedHashMap<>();
        Map<String, Object> before = json.map(previous.settings());
        json.map(settings).forEach((k, v) -> {
            if (!java.util.Objects.equals(before.get(k), v)) {
                diff.put(k, Map.of("from", String.valueOf(before.get(k)), "to", String.valueOf(v)));
            }
        });
        audit.recordAs(ctx.actor(), "POLICY_PUBLISHED", "POLICY", id.toString(), "v" + row.get("version"), diff, null);
        return current();
    }

    /** Bootstrap: ensures a first published policy exists. */
    @Transactional
    public void ensureInitial() {
        Integer count = jdbc.sql("select count(*) from policy_version").query(Integer.class).single();
        if (count == 0) {
            jdbc.sql("insert into policy_version(id, version, status, settings, published_at) values (:id, 1, 'PUBLISHED', cast(:s as jsonb), :at)")
                    .param("id", UUID.randomUUID()).param("s", json.write(Settings.defaults()))
                    .param("at", Db.ts(clock.instant())).update();
        }
    }
}
