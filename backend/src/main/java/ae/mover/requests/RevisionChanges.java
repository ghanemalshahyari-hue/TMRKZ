package ae.mover.requests;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.RequestScope;
import ae.mover.access.ViewLevel;
import ae.mover.common.ApiException;
import ae.mover.common.Json;

/**
 * What changed between two submitted revisions of a request (owner brief of 30 Oct 2026 §5C): the reviewer of a
 * resubmission sees each changed field with its previous and new value, read from the immutable revision snapshots.
 */
@Service
public class RevisionChanges {

    private final JdbcClient jdbc;
    private final Json json;
    private final AccessService access;

    public RevisionChanges(JdbcClient jdbc, Json json, AccessService access) {
        this.jdbc = jdbc;
        this.json = json;
        this.access = access;
    }

    public record Change(String field, String label, String before, String after) {
    }

    public record Comparison(int fromRevision, int toRevision, String reason, List<Change> changes) {
    }

    public Comparison compare(AccessContext ctx, UUID requestId, Integer to) {
        RequestScope scope = access.requestScope(requestId);
        if (scope == null || ctx.viewLevel(scope) == ViewLevel.NONE) {
            throw ApiException.notFound();
        }
        if (ctx.viewLevel(scope) != ViewLevel.FULL) {
            throw ApiException.forbidden("مقارنة المراجعات جزء من محتوى الطلب الكامل.");
        }
        ctx.confirmView(scope, ViewLevel.FULL);
        int target = to != null ? to : jdbc.sql("select coalesce(max(revision), 0) from request_revision where request_id = :id")
                .param("id", requestId).query(Integer.class).single();
        if (target < 2) {
            return new Comparison(target, target, null, List.of());
        }
        Map<String, Object> after = revision(requestId, target);
        Map<String, Object> before = revision(requestId, target - 1);
        JsonNode a = json.tree((String) after.get("data"));
        JsonNode b = json.tree((String) before.get("data"));
        Map<String, String> labels = new LinkedHashMap<>();
        json.tree((String) after.get("schema")).path("fields").forEach(f -> labels.put(f.path("id").asText(), f.path("label").asText()));
        List<Change> out = new ArrayList<>();
        diff(out, "subject", "عنوان الطلب", text(b.path("subject")), text(a.path("subject")));
        diff(out, "period.start", "بداية الفترة", text(b.path("period").path("start")), text(a.path("period").path("start")));
        diff(out, "period.end", "نهاية الفترة", orOpen(b.path("period").path("end")), orOpen(a.path("period").path("end")));
        diff(out, "resourceIds", "المرافق", names(b.path("resourceIds"), "resource"), names(a.path("resourceIds"), "resource"));
        diff(out, "participantOrgIds", "الجهات المشاركة", names(b.path("participantOrgIds"), "organization"),
                names(a.path("participantOrgIds"), "organization"));
        diff(out, "infoOrgIds", "جهات للعلم", names(b.path("infoOrgIds"), "organization"), names(a.path("infoOrgIds"), "organization"));
        JsonNode ra = a.path("relocation");
        JsonNode rb = b.path("relocation");
        if (!ra.isMissingNode() || !rb.isMissingNode()) {
            diff(out, "relocation.organizationId", "الجهة المنقولة", names(arr(rb.path("organizationId")), "organization"),
                    names(arr(ra.path("organizationId")), "organization"));
            diff(out, "relocation.includeDescendants", "تشمل الفروع", text(rb.path("includeDescendants")), text(ra.path("includeDescendants")));
            diff(out, "relocation.proposedName", "اسم الموقع المقترح", text(rb.path("proposedName")), text(ra.path("proposedName")));
            diff(out, "relocation.geometry", "حدود الموقع المقترح", shape(rb), shape(ra));
        }
        java.util.Set<String> keys = new java.util.LinkedHashSet<>();
        a.path("values").fieldNames().forEachRemaining(keys::add);
        b.path("values").fieldNames().forEachRemaining(keys::add);
        for (String k : keys) {
            diff(out, "values." + k, labels.getOrDefault(k, k), text(b.path("values").path(k)), text(a.path("values").path(k)));
        }
        return new Comparison(target - 1, target, (String) after.get("reason"), out);
    }

    private Map<String, Object> revision(UUID requestId, int revision) {
        return jdbc.sql("""
                select r.data::text as data, r.reason, f.schema::text as schema from request_revision r
                join form_version f on f.id = r.form_version_id where r.request_id = :id and r.revision = :rev""")
                .param("id", requestId).param("rev", revision).query().listOfRows().stream().findFirst()
                .orElseThrow(ApiException::notFound);
    }

    private static void diff(List<Change> out, String field, String label, String before, String after) {
        if (!Objects.equals(before, after)) {
            out.add(new Change(field, label, before, after));
        }
    }

    private static String text(JsonNode n) {
        if (n == null || n.isMissingNode() || n.isNull()) {
            return null;
        }
        return n.isValueNode() ? n.asText() : n.toString();
    }

    private static JsonNode arr(JsonNode one) {
        com.fasterxml.jackson.databind.node.ArrayNode n = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode();
        if (one != null && one.isTextual()) {
            n.add(one.asText());
        }
        return n;
    }

    /** A drawn proposal compared by its shape (a different drawing shows as changed, with its area). */
    private static String shape(JsonNode relocation) {
        JsonNode g = relocation.path("geometry");
        if (g.isMissingNode() || g.isNull()) {
            return null;
        }
        String area = relocation.path("areaM2").isNumber() ? " · " + relocation.path("areaM2").asLong() + " م²" : "";
        return g.path("type").asText() + area + " · " + Integer.toHexString(g.toString().hashCode());
    }

    private static String orOpen(JsonNode n) {
        String t = text(n);
        return t == null ? "مفتوحة" : t;
    }

    private String names(JsonNode ids, String table) {
        List<String> out = new ArrayList<>();
        ids.forEach(i -> out.add(jdbc.sql("select name from " + table + " where id = cast(:id as uuid)").param("id", i.asText())
                .query(String.class).optional().orElse(i.asText())));
        return out.isEmpty() ? null : String.join("، ", out);
    }
}
