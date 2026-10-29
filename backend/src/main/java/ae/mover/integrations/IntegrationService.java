package ae.mover.integrations;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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

/**
 * Integration registry. Connectors whose target systems are not yet defined (D-04) are reported as NOT_CONNECTED
 * and never simulate a successful connection. The organisation-structure connector supports validated file import
 * with a preview before anything is written.
 */
@Service
public class IntegrationService {

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final ae.mover.security.OidcClient oidc;

    public IntegrationService(JdbcClient jdbc, Json json, Clock clock, AuditService audit, ae.mover.security.OidcClient oidc) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.oidc = oidc;
    }

    public record Connector(String code, String name, String status, String description, Map<String, Object> lastRun) {
    }

    public List<Connector> list(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        return List.of(
                identityConnector(),
                new Connector("ORG_STRUCTURE", "الهيكل التنظيمي", "FILE_IMPORT",
                        "استيراد ملف (رمز، اسم، رمز الجهة الأم) مع تحقق ومعاينة قبل الحفظ. المزامنة الآلية غير مربوطة.",
                        lastRun("ORG_STRUCTURE")),
                hrConnector(),
                new Connector("CORRESPONDENCE", "المراسلات", "NOT_CONNECTED",
                        "الإشعارات داخل النظام فقط. لا يُرسل أي إشعار خارجي ولا يُدّعى تسليمه.", null),
                new Connector("SIGNATURE_PKI", "التوقيع الرقمي بشهادة", "NOT_CONNECTED",
                        "القرار D-02 مفتوح. نمط PKI يرفض الاعتماد برسالة واضحة حتى ربط مزود الشهادات.", null),
                new Connector("MALWARE_SCAN", "فحص المرفقات", "BUILT_IN",
                        "فحص مدمج للنوع الفعلي والتوقيعات المعروفة (EICAR، الماكرو، محتوى PDF النشط). ماسح خارجي غير مربوط.", null));
    }

    /** Enterprise sign-in as measured: configured, provider answering, and at least one linked sign-in recorded. */
    private Connector identityConnector() {
        boolean configured = oidc.configured();
        boolean reachable = configured && oidc.reachable();
        long linked = jdbc.sql("select count(*) from identity_link").query(Long.class).single();
        String status = !configured ? "NOT_CONNECTED" : reachable && linked > 0 ? "CONNECTED" : "CONFIGURED";
        return new Connector("IDENTITY", "الدخول المؤسسي (Keycloak + LDAP)", status,
                !configured ? "مزود الهوية غير مهيأ؛ لا يوجد دخول بديل."
                        : (reachable ? "مزود الهوية يستجيب" : "مزود الهوية لا يستجيب الآن") + "؛ حسابات مربوطة: " + linked + ".", null);
    }

    /**
     * Status of the HR mirror as measured, never assumed: CONNECTED only after a successful sync from the configured
     * source; CONFIGURED when settings exist but no sync has succeeded; NOT_CONNECTED otherwise.
     */
    private Connector hrConnector() {
        Map<String, Object> src = jdbc.sql("select enabled, last_success_at, last_connection_ok from hr_source order by created_at limit 1")
                .query().listOfRows().stream().findFirst().orElse(null);
        Map<String, Object> run = jdbc.sql("select id, status, started_at from hr_sync_run order by started_at desc limit 1")
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("status", rs.getString("status"));
                    m.put("startedAt", Db.iso(rs, "started_at"));
                    return m;
                }).optional().orElse(null);
        if (src == null) {
            return new Connector("PEOPLE", "مصدر الموارد البشرية (الجهات والأشخاص)", "NOT_CONNECTED",
                    "قراءة فقط من عروض الموارد البشرية بعقد تنقل، مزامنة كل ساعة. لم تُدخل إعدادات المصدر بعد.", null);
        }
        boolean synced = src.get("last_success_at") != null;
        return new Connector("PEOPLE", "مصدر الموارد البشرية (الجهات والأشخاص)", synced ? "CONNECTED" : "CONFIGURED",
                synced ? "مرآة للقراءة فقط تُحدّث كل ساعة؛ آخر نجاح " + Db.toInstant(src.get("last_success_at"))
                        : "الإعدادات محفوظة ولم تنجح مزامنة بعد" + (Boolean.FALSE.equals(src.get("last_connection_ok")) ? "؛ فشل آخر اختبار اتصال." : "."),
                run);
    }

    private Map<String, Object> lastRun(String connector) {
        return jdbc.sql("select id, status, started_at, result::text as result from integration_run where connector = :c order by started_at desc limit 1")
                .param("c", connector).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("status", rs.getString("status"));
                    m.put("startedAt", Db.iso(rs, "started_at"));
                    m.put("stats", json.map(rs.getString("result")).get("summary"));
                    return m;
                }).optional().orElse(null);
    }

    public record OrgRow(String code, String name, String parentCode) {
    }

    public record PreviewResult(String runId, boolean valid, List<Map<String, Object>> errors, Map<String, Integer> summary) {
    }

    @Transactional
    public PreviewResult preview(AccessContext ctx, List<OrgRow> rows) {
        ctx.require(Permission.CONFIGURE);
        if (rows == null || rows.isEmpty()) {
            throw ApiException.validation("الملف لا يحتوي صفوفاً.");
        }
        if (rows.size() > 20000) {
            throw ApiException.validation("الحد الأقصى 20,000 صف في دفعة واحدة.");
        }
        List<Map<String, Object>> errors = new ArrayList<>();
        Map<String, Map<String, Object>> existing = new HashMap<>();
        jdbc.sql("select o.code, o.name, p.code as parent_code from organization o left join organization p on p.id = o.parent_id")
                .query().listOfRows().forEach(r -> existing.put((String) r.get("code"), r));
        Map<String, String> parentOf = new HashMap<>();
        existing.forEach((code, r) -> parentOf.put(code, (String) r.get("parent_code")));
        Set<String> seen = new HashSet<>();
        int create = 0;
        int update = 0;
        int unchanged = 0;
        for (int i = 0; i < rows.size(); i++) {
            OrgRow r = rows.get(i);
            int line = i + 1;
            String code = r.code() == null ? "" : r.code().trim();
            if (!code.matches("^[A-Za-z0-9._-]{1,40}$")) {
                errors.add(error(line, code, "رمز الجهة مطلوب ويتكون من حروف لاتينية وأرقام و. _ - (حتى 40)."));
                continue;
            }
            if (!seen.add(code)) {
                errors.add(error(line, code, "رمز مكرر داخل الملف."));
                continue;
            }
            if (r.name() == null || r.name().isBlank() || r.name().length() > 200) {
                errors.add(error(line, code, "اسم الجهة مطلوب (حتى 200 حرف)."));
            }
            String parent = r.parentCode() == null || r.parentCode().isBlank() ? null : r.parentCode().trim();
            if (parent != null && parent.equals(code)) {
                errors.add(error(line, code, "لا يجوز أن تكون الجهة أماً لنفسها."));
            }
            parentOf.put(code, parent);
            Map<String, Object> ex = existing.get(code);
            if (ex == null) {
                create++;
            } else if (!java.util.Objects.equals(ex.get("name"), r.name()) || !java.util.Objects.equals(ex.get("parent_code"), parent)) {
                update++;
            } else {
                unchanged++;
            }
        }
        for (int i = 0; i < rows.size(); i++) {
            OrgRow r = rows.get(i);
            String parent = r.parentCode() == null || r.parentCode().isBlank() ? null : r.parentCode().trim();
            if (parent != null && !parentOf.containsKey(parent)) {
                errors.add(error(i + 1, r.code(), "الجهة الأم «" + parent + "» غير موجودة في الملف أو في النظام."));
            }
        }
        // Cycle detection over the combined graph (file rows override existing parents).
        Set<String> reported = new HashSet<>();
        for (String start : seen) {
            Set<String> path = new HashSet<>();
            String cur = start;
            while (cur != null && parentOf.containsKey(cur)) {
                if (!path.add(cur)) {
                    if (reported.add(cur)) {
                        errors.add(error(0, cur, "دورة في شجرة الجهات تمر بالرمز «" + cur + "»."));
                    }
                    break;
                }
                cur = parentOf.get(cur);
            }
        }
        Map<String, Integer> summary = Map.of("create", create, "update", update, "unchanged", unchanged);
        UUID runId = UUID.randomUUID();
        boolean valid = errors.isEmpty();
        jdbc.sql("""
                insert into integration_run(id, connector, status, payload, result, started_by, started_at, finished_at)
                values (:id, 'ORG_STRUCTURE', :st, cast(:p as jsonb), cast(:r as jsonb), :by, :now, :now)""")
                .param("id", runId).param("st", valid ? "PREVIEWED" : "INVALID").param("p", json.write(rows))
                .param("r", json.write(Map.of("errors", errors, "summary", summary))).param("by", ctx.personId())
                .param("now", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), "ORG_IMPORT_PREVIEWED", "INTEGRATION", runId.toString(), "ORG_STRUCTURE",
                Map.of("valid", valid, "errors", errors.size(), "summary", summary), null);
        return new PreviewResult(runId.toString(), valid, errors, summary);
    }

    private static Map<String, Object> error(int row, String code, String message) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("row", row);
        m.put("code", code);
        m.put("message", message);
        return m;
    }

    @Transactional
    public Map<String, Object> commit(AccessContext ctx, UUID runId) {
        ctx.require(Permission.CONFIGURE);
        Map<String, Object> run = jdbc.sql("select status, payload::text as payload from integration_run where id = :id and connector = 'ORG_STRUCTURE' for update")
                .param("id", runId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!"PREVIEWED".equals(run.get("status"))) {
            throw ApiException.validation("لا يمكن اعتماد دفعة غير صالحة أو معتمدة سابقاً.");
        }
        List<OrgRow> rows = json.convert(json.tree((String) run.get("payload")),
                new com.fasterxml.jackson.core.type.TypeReference<List<OrgRow>>() {
                });
        PreviewResult recheck = preview(ctx, rows);
        if (!recheck.valid()) {
            throw ApiException.validation("تغيرت البيانات منذ المعاينة وأصبحت الدفعة غير صالحة. أعد المعاينة.");
        }
        Map<String, UUID> ids = new HashMap<>();
        jdbc.sql("select id, code from organization").query((rs, n) -> ids.put(rs.getString("code"), Db.uuid(rs, "id"))).list();
        for (OrgRow r : rows) {
            if (!ids.containsKey(r.code().trim())) {
                UUID id = UUID.randomUUID();
                jdbc.sql("insert into organization(id, code, name) values (:id, :c, :n)")
                        .param("id", id).param("c", r.code().trim()).param("n", r.name().trim()).update();
                ids.put(r.code().trim(), id);
            } else {
                jdbc.sql("update organization set name = :n, version = version + 1 where code = :c")
                        .param("n", r.name().trim()).param("c", r.code().trim()).update();
            }
        }
        // Clear then set parents so intermediate states during re-parenting cannot form transient cycles.
        jdbc.sql("update organization set parent_id = null where code = any(string_to_array(:codes, ','))")
                .param("codes", String.join(",", rows.stream().map(r -> r.code().trim()).toList())).update();
        for (OrgRow r : rows) {
            String parent = r.parentCode() == null || r.parentCode().isBlank() ? null : r.parentCode().trim();
            jdbc.sql("update organization set parent_id = :p where code = :c")
                    .param("p", parent == null ? null : ids.get(parent)).param("c", r.code().trim()).update();
        }
        jdbc.sql("update integration_run set status = 'COMMITTED', finished_at = :now where id = :id")
                .param("now", Db.ts(clock.instant())).param("id", runId).update();
        audit.recordAs(ctx.actor(), "ORG_IMPORT_COMMITTED", "INTEGRATION", runId.toString(), "ORG_STRUCTURE",
                Map.of("summary", recheck.summary()), null);
        return Map.of("runId", runId.toString(), "status", "COMMITTED", "summary", recheck.summary());
    }
}
