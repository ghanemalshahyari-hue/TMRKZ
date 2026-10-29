package ae.mover.org;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.annotation.JsonInclude;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.policy.PolicyService;

/**
 * Informational unit identity symbols (ADR-021): an approved number-based SIDC per organisation, kept as local metadata
 * beside the HR mirror and drawn in the browser by the bundled renderer. The institution decides the standard and
 * edition (system settings); a configuration administrator assigns symbols from the approved catalog or enters a
 * SIDC that the server checks for shape (land unit or land civilian organisation, friend, reality). A symbol is
 * identity only: it grants nothing, changes no facility geometry and never replaces the organisation's name.
 */
@Service
public class UnitSymbolService {

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AuditService audit;
    private final PolicyService policies;
    private final OrganizationService orgs;

    public UnitSymbolService(JdbcClient jdbc, Clock clock, AuditService audit, PolicyService policies, OrganizationService orgs) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.audit = audit;
        this.policies = policies;
        this.orgs = orgs;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SymbolView(String sidc, String standard, String edition, String description, String source, String catalogCode,
                             int version, String updatedAt) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CatalogEntry(String code, String standard, String edition, String sidc, String name, String description,
                               boolean active) {
    }

    /** Symbols of the requested organisations that the actor may see; an organisation without one maps to null. */
    public record Lookup(String standard, Map<String, SymbolView> symbols) {
    }

    public record AssignInput(String catalogCode, String sidc, String description, Integer expectedVersion, String reason) {
    }

    public record RemoveInput(Integer expectedVersion, String reason) {
    }

    public record CatalogInput(String code, String sidc, String name, String description) {
    }

    public record ActiveInput(Boolean active, String reason) {
    }

    /** The approved standard and edition, e.g. {@code APP6-D}; null until the institution decides. */
    public String approvedStandard() {
        return policies.settings().unitSymbolStandard();
    }

    public Lookup lookup(AccessContext ctx, Collection<UUID> ids) {
        orgs.requireOrgReader(ctx);
        if (ids.size() > 300) {
            throw ApiException.validation("يمكن طلب رموز 300 جهة على الأكثر في المرة الواحدة.");
        }
        List<UUID> visible = orgs.visibleAmong(ctx, ids);
        Map<String, SymbolView> out = new LinkedHashMap<>();
        visible.forEach(id -> out.put(id.toString(), null));
        if (!visible.isEmpty()) {
            jdbc.sql("""
                    select organization_id, sidc, standard, edition, description_ar, source, catalog_code, version, updated_at
                    from org_unit_symbol where organization_id = any(string_to_array(:ids, ',')::uuid[])""")
                    .param("ids", visible.stream().map(UUID::toString).collect(java.util.stream.Collectors.joining(",")))
                    .query((rs, n) -> out.put(rs.getString("organization_id"), row(rs))).list();
        }
        return new Lookup(approvedStandard(), out);
    }

    private static SymbolView row(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new SymbolView(rs.getString("sidc"), rs.getString("standard"), rs.getString("edition"), rs.getString("description_ar"),
                rs.getString("source"), rs.getString("catalog_code"), rs.getInt("version"), Db.iso(rs, "updated_at"));
    }

    public List<CatalogEntry> catalog(AccessContext ctx) {
        orgs.requireOrgReader(ctx);
        boolean all = ctx.has(Permission.CONFIGURE);
        return jdbc.sql("select * from unit_symbol_catalog " + (all ? "" : "where active ") + "order by active desc, name_ar")
                .query((rs, n) -> new CatalogEntry(rs.getString("code"), rs.getString("standard"), rs.getString("edition"),
                        rs.getString("sidc"), rs.getString("name_ar"), rs.getString("description_ar"), rs.getBoolean("active")))
                .list();
    }

    /** Shape checks the server can make without the renderer; the renderer's own validation runs in the preview. */
    static void checkSidc(String sidc) {
        if (sidc == null || !sidc.matches("[0-9]{20}([0-9]{10})?")) {
            throw ApiException.validation("رمز التعريف (SIDC) يجب أن يكون 20 أو 30 رقماً من معيار يعتمد الترميز الرقمي.");
        }
        if (sidc.charAt(2) != '0') {
            throw ApiException.validation("خانة السياق في رمز التعريف يجب أن تكون «واقع» (0).");
        }
        if (sidc.charAt(3) != '3') {
            throw ApiException.validation("خانة الهوية القياسية يجب أن تكون «صديق» (3) لهوية جهة داخلية.");
        }
        String set = sidc.substring(4, 6);
        if (!set.equals("10") && !set.equals("11")) {
            throw ApiException.validation("مجموعة الرمز يجب أن تكون وحدة برية (10) أو جهة مدنية برية (11).");
        }
    }

    private String[] standardParts() {
        String s = approvedStandard();
        if (s == null) {
            throw ApiException.validation("لم تعتمد المؤسسة معيار رموز الوحدات وإصداره بعد؛ يحدده مسؤول الإعداد في «إعدادات النظام».");
        }
        return s.split("-");
    }

    private static String reason(String r) {
        if (r == null || r.trim().length() < 5) {
            throw ApiException.validation("اكتب سبب التغيير (5 أحرف على الأقل).");
        }
        return r.trim();
    }

    @Transactional
    public SymbolView assign(AccessContext ctx, UUID orgId, AssignInput in) {
        ctx.require(Permission.CONFIGURE);
        if (orgs.visibleAmong(ctx, List.of(orgId)).isEmpty()) {
            throw ApiException.notFound();
        }
        String why = reason(in == null ? null : in.reason());
        String[] std = standardParts();
        String sidc;
        String description;
        String source;
        String catalogCode = null;
        if (in.catalogCode() != null && !in.catalogCode().isBlank()) {
            CatalogEntry e = jdbc.sql("select * from unit_symbol_catalog where code = :c and active")
                    .param("c", in.catalogCode())
                    .query((rs, n) -> new CatalogEntry(rs.getString("code"), rs.getString("standard"), rs.getString("edition"),
                            rs.getString("sidc"), rs.getString("name_ar"), rs.getString("description_ar"), true))
                    .optional().orElseThrow(() -> ApiException.validation("الرمز غير موجود في الفهرس المعتمد أو موقوف."));
            if (!e.standard().equals(std[0]) || !e.edition().equals(std[1])) {
                throw ApiException.validation("رمز الفهرس من معيار أو إصدار غير المعتمد حالياً؛ لا تُخلط إصدارات الرموز.");
            }
            sidc = e.sidc();
            description = in.description() != null && !in.description().isBlank() ? in.description().trim() : e.name();
            source = "CATALOG";
            catalogCode = e.code();
        } else {
            sidc = in.sidc() == null ? null : in.sidc().trim();
            description = in.description() == null ? "" : in.description().trim();
            source = "MANUAL";
            if (description.length() < 2) {
                throw ApiException.validation("اكتب وصفاً عربياً للرمز يقرؤه من لا يعرف المعيار.");
            }
        }
        checkSidc(sidc);
        if (description.length() > 200) {
            throw ApiException.validation("الوصف أطول من 200 حرف.");
        }
        Integer current = jdbc.sql("select version from org_unit_symbol where organization_id = :id for update").param("id", orgId)
                .query(Integer.class).optional().orElse(null);
        int expected = in.expectedVersion() == null ? -1 : in.expectedVersion();
        if ((current == null ? 0 : current) != expected) {
            throw ApiException.staleRevision();
        }
        int version = current == null ? 1 : current + 1;
        jdbc.sql("""
                insert into org_unit_symbol(organization_id, standard, edition, sidc, description_ar, source, catalog_code, version,
                                            updated_by, updated_at)
                values (:o, :st, :ed, :sidc, :d, :src, :cat, :v, :by, :now)
                on conflict (organization_id) do update set standard = :st, edition = :ed, sidc = :sidc, description_ar = :d,
                    source = :src, catalog_code = :cat, version = :v, updated_by = :by, updated_at = :now""")
                .param("o", orgId).param("st", std[0]).param("ed", std[1]).param("sidc", sidc).param("d", description)
                .param("src", source).param("cat", catalogCode).param("v", version).param("by", ctx.personId())
                .param("now", Db.ts(clock.instant())).update();
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("sidc", sidc);
        details.put("standard", std[0] + "-" + std[1]);
        details.put("source", source);
        if (catalogCode != null) {
            details.put("catalogCode", catalogCode);
        }
        details.put("version", version);
        audit.recordAs(ctx.actor(), "UNIT_SYMBOL_ASSIGNED", "ORGANIZATION", orgId.toString(), description, details, why);
        return new SymbolView(sidc, std[0], std[1], description, source, catalogCode, version, clock.instant().toString());
    }

    @Transactional
    public void remove(AccessContext ctx, UUID orgId, RemoveInput in) {
        ctx.require(Permission.CONFIGURE);
        if (orgs.visibleAmong(ctx, List.of(orgId)).isEmpty()) {
            throw ApiException.notFound();
        }
        String why = reason(in == null ? null : in.reason());
        Integer current = jdbc.sql("select version from org_unit_symbol where organization_id = :id for update").param("id", orgId)
                .query(Integer.class).optional().orElseThrow(ApiException::notFound);
        if (in.expectedVersion() == null || current.intValue() != in.expectedVersion()) {
            throw ApiException.staleRevision();
        }
        jdbc.sql("delete from org_unit_symbol where organization_id = :id").param("id", orgId).update();
        audit.recordAs(ctx.actor(), "UNIT_SYMBOL_REMOVED", "ORGANIZATION", orgId.toString(), null, Map.of("version", current), why);
    }

    @Transactional
    public CatalogEntry addCatalog(AccessContext ctx, CatalogInput in) {
        ctx.require(Permission.CONFIGURE);
        String[] std = standardParts();
        if (in == null || in.code() == null || !in.code().matches("[A-Z0-9_-]{2,40}")) {
            throw ApiException.validation("رمز الفهرس: حروف لاتينية كبيرة وأرقام وشرطات (2–40).");
        }
        checkSidc(in.sidc());
        if (in.name() == null || in.name().trim().length() < 2 || in.name().trim().length() > 120) {
            throw ApiException.validation("اسم الرمز بالعربية مطلوب (2–120 حرفاً).");
        }
        if (jdbc.sql("select count(*) from unit_symbol_catalog where code = :c").param("c", in.code()).query(Integer.class).single() > 0) {
            throw ApiException.validation("رمز الفهرس مستخدم.");
        }
        jdbc.sql("""
                insert into unit_symbol_catalog(code, standard, edition, sidc, name_ar, description_ar, created_by)
                values (:c, :st, :ed, :sidc, :n, :d, :by)""")
                .param("c", in.code()).param("st", std[0]).param("ed", std[1]).param("sidc", in.sidc()).param("n", in.name().trim())
                .param("d", in.description() == null || in.description().isBlank() ? null : in.description().trim())
                .param("by", ctx.personId()).update();
        audit.recordAs(ctx.actor(), "UNIT_SYMBOL_CATALOG_ADDED", "UNIT_SYMBOL_CATALOG", in.code(), in.name().trim(),
                Map.of("sidc", in.sidc(), "standard", std[0] + "-" + std[1]), null);
        return new CatalogEntry(in.code(), std[0], std[1], in.sidc(), in.name().trim(), in.description(), true);
    }

    @Transactional
    public void setCatalogActive(AccessContext ctx, String code, ActiveInput in) {
        ctx.require(Permission.CONFIGURE);
        String why = reason(in == null ? null : in.reason());
        boolean active = Boolean.TRUE.equals(in.active());
        if (jdbc.sql("update unit_symbol_catalog set active = :a where code = :c").param("a", active).param("c", code).update() == 0) {
            throw ApiException.notFound();
        }
        audit.recordAs(ctx.actor(), active ? "UNIT_SYMBOL_CATALOG_ENABLED" : "UNIT_SYMBOL_CATALOG_DISABLED", "UNIT_SYMBOL_CATALOG",
                code, null, Map.of(), why);
    }

    /** Organisation ids from a comma-separated query value. */
    public static List<UUID> ids(String csv) {
        List<UUID> out = new ArrayList<>();
        if (csv == null || csv.isBlank()) {
            return out;
        }
        for (String s : csv.split(",")) {
            try {
                out.add(UUID.fromString(s.trim()));
            } catch (IllegalArgumentException e) {
                throw ApiException.validation("معرف جهة غير صالح.");
            }
        }
        return out;
    }
}
