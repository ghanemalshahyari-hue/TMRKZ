package ae.mover.stationing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.ApiException;
import ae.mover.common.Hashing;
import ae.mover.common.Json;

/**
 * «الاعتماد الجزئي» (owner brief §6, phase 8; ADR-090): a re-stationing is made of parts — the new site, the main deployment
 * area, the sub-area (a deployment-area request of its two areas) — and the reviewer of a stage may approve one part and
 * return another for changes. The workflow is not rebuilt: a stage still approves the request (every part approved) or returns
 * it (a part needs changes), through the existing route.
 *
 * <p>What a stage decided on each part is kept with the part's fingerprint. When the request comes back to that stage, a part
 * it approved that has not changed since stays «معتمد» and is not decided again; a part the requester changed after its approval
 * is reopened for that stage only, and so is a part that was returned. Other stages decide for themselves.
 */
@Component
public class PartReviews {

    public static final List<String> ORDER = List.of("SITE", "PRIMARY", "ALTERNATIVE");
    static final Map<String, String> LABEL = Map.of("SITE", "موقع التمركز الجديد", "PRIMARY", "منطقة الانتشار الرئيسية",
            "ALTERNATIVE", "منطقة الانتشار الفرعية");
    static final Set<String> CHOICES = Set.of("APPROVE", "CHANGES");

    /** The effective decision of a stage and the parts it returned. */
    public record Outcome(String decision, List<String> changes, Map<String, String> parts) {
    }

    private final JdbcClient jdbc;
    private final Json json;

    public PartReviews(JdbcClient jdbc, Json json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** The parts a request is made of: a re-stationing's new site and its areas; a deployment-area request's areas. */
    public List<String> partsOf(String purpose, RestationingContent c) {
        List<String> out = new ArrayList<>();
        if (c == null || !(RestationingChecks.RESTATIONING.equals(purpose) || RestationingChecks.DEPLOYMENT_AREAS.equals(purpose))) {
            return out;
        }
        if (RestationingChecks.RESTATIONING.equals(purpose) && c.site() != null && c.site().geometry() != null) {
            out.add("SITE");
        }
        if (c.primary() != null) {
            out.add("PRIMARY");
        }
        if (c.alternative() != null) {
            out.add("ALTERNATIVE");
        }
        return out;
    }

    /** The part's fingerprint: its geometry as stored. */
    String fingerprint(RestationingContent c, String part) {
        Object g = switch (part) {
            case "SITE" -> c.site() == null ? null : c.site().geometry();
            case "PRIMARY" -> c.primary();
            default -> c.alternative();
        };
        return g == null ? "" : Hashing.sha256(json.write(g));
    }

    /** stage key → part → what that stage decided on it. */
    Map<String, Map<String, Map<String, Object>>> stored(UUID id) {
        String s = jdbc.sql("select part_reviews::text from restationing_request where id = :id").param("id", id).query(String.class).optional().orElse(null);
        if (s == null || s.isBlank()) {
            return new LinkedHashMap<>();
        }
        Map<String, Map<String, Map<String, Object>>> out = new LinkedHashMap<>();
        json.map(s).forEach((stage, parts) -> {
            Map<String, Map<String, Object>> byPart = new LinkedHashMap<>();
            if (parts instanceof Map<?, ?> pm) {
                pm.forEach((k, v) -> {
                    if (v instanceof Map<?, ?> rec) {
                        Map<String, Object> r = new LinkedHashMap<>();
                        rec.forEach((rk, rv) -> r.put(String.valueOf(rk), rv));
                        byPart.put(String.valueOf(k), r);
                    }
                });
            }
            out.put(stage, byPart);
        });
        return out;
    }

    /** Approved at this stage and unchanged since: kept, never decided again by the same stage. */
    private boolean kept(Map<String, Object> prev, String fingerprint) {
        return prev != null && "APPROVED".equals(prev.get("state")) && fingerprint.equals(prev.get("hash"));
    }

    /**
     * A stage's decision part by part ({@code given}: part → APPROVE or CHANGES; a part kept from an earlier approval may be
     * left out). Writes what the stage decided and returns the stage's decision: RETURN when a part needs changes, APPROVE when
     * every part is approved. Called inside the decision's transaction, after the decider has been checked.
     */
    public Outcome apply(UUID id, String purpose, RestationingContent c, String stageKey, String stageLabel, Map<String, String> given,
                         Map<String, String> notes, UUID by, String byName, Instant now) {
        List<String> parts = partsOf(purpose, c);
        if (parts.isEmpty()) {
            throw ApiException.validation("لا أجزاء في هذا الطلب تُعتمد منفصلة؛ قرر الطلب كاملاً.");
        }
        for (Map.Entry<String, String> e : given.entrySet()) {
            if (!parts.contains(e.getKey())) {
                throw ApiException.validation("جزء غير موجود في الطلب: " + e.getKey());
            }
            if (!CHOICES.contains(e.getValue())) {
                throw ApiException.validation("قرار الجزء اعتماد أو تعديل مطلوب.");
            }
        }
        Map<String, Map<String, Map<String, Object>>> all = stored(id);
        Map<String, Map<String, Object>> stage = new LinkedHashMap<>(all.getOrDefault(stageKey, Map.of()));
        Map<String, String> effective = new LinkedHashMap<>();
        List<String> changes = new ArrayList<>();
        for (String p : parts) {
            String fp = fingerprint(c, p);
            Map<String, Object> prev = stage.get(p);
            String g = given.get(p);
            if (kept(prev, fp)) {
                if ("CHANGES".equals(g)) {
                    throw ApiException.validation("«" + LABEL.get(p) + "» معتمد في هذه المرحلة ولم يتغير منذ اعتماده: لا يُعاد قراره.");
                }
                effective.put(p, "APPROVE");
                continue;
            }
            if (g == null) {
                throw ApiException.validation("قرر «" + LABEL.get(p) + "»: اعتماد أو تعديل مطلوب.");
            }
            effective.put(p, g);
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("state", "APPROVE".equals(g) ? "APPROVED" : "CHANGES_REQUESTED");
            rec.put("hash", fp);
            rec.put("by", by.toString());
            rec.put("byName", byName);
            rec.put("at", now.toString());
            rec.put("stageLabel", stageLabel);
            String note = notes == null ? null : notes.get(p);
            rec.put("note", note == null || note.isBlank() ? null : note.trim());
            stage.put(p, rec);
            if ("CHANGES".equals(g)) {
                changes.add(p);
            }
        }
        all.put(stageKey, stage);
        jdbc.sql("update restationing_request set part_reviews = cast(:j as jsonb) where id = :id").param("j", json.write(all)).param("id", id).update();
        return new Outcome(changes.isEmpty() ? "APPROVE" : "RETURN", changes, effective);
    }

    /** The reason a part-by-part return carries when the reviewer wrote none of their own: the parts and their notes. */
    static String reasonOf(List<String> changes, Map<String, String> notes) {
        StringBuilder b = new StringBuilder("تعديل مطلوب في: ");
        for (int i = 0; i < changes.size(); i++) {
            String p = changes.get(i);
            b.append(i == 0 ? "" : "، ").append("«").append(LABEL.get(p)).append("»");
            String n = notes == null ? null : notes.get(p);
            if (n != null && !n.isBlank()) {
                b.append(" (").append(n.trim()).append(")");
            }
        }
        return b.toString();
    }

    /**
     * Each part as the request shows it: what the current stage has decided on it (APPROVED kept, REOPENED when changed after
     * its approval, CHANGES_REQUESTED, EDITED when changed after a return, PENDING), and the latest decision of any stage.
     */
    public List<Map<String, Object>> view(UUID id, String purpose, RestationingContent c, String currentStage) {
        List<Map<String, Object>> out = new ArrayList<>();
        List<String> parts = partsOf(purpose, c);
        if (parts.isEmpty()) {
            return out;
        }
        Map<String, Map<String, Map<String, Object>>> all = stored(id);
        for (String p : parts) {
            String fp = fingerprint(c, p);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("part", p);
            m.put("label", LABEL.get(p));
            Map<String, Object> cur = currentStage == null ? null : all.getOrDefault(currentStage, Map.of()).get(p);
            m.put("current", status(cur, fp));
            Map<String, Object> last = null;
            for (Map<String, Map<String, Object>> stage : all.values()) {
                Map<String, Object> x = stage.get(p);
                if (x != null && (last == null || String.valueOf(x.get("at")).compareTo(String.valueOf(last.get("at"))) > 0)) {
                    last = x;
                }
            }
            if (last != null) {
                Map<String, Object> l = new LinkedHashMap<>();
                l.put("state", status(last, fp));
                l.put("stageLabel", last.get("stageLabel"));
                l.put("byName", last.get("byName"));
                l.put("at", last.get("at"));
                l.put("note", last.get("note"));
                m.put("last", l);
            }
            out.add(m);
        }
        return out;
    }

    private static String status(Map<String, Object> rec, String fp) {
        if (rec == null) {
            return "PENDING";
        }
        boolean same = fp.equals(rec.get("hash"));
        if ("APPROVED".equals(rec.get("state"))) {
            return same ? "APPROVED" : "REOPENED";
        }
        return same ? "CHANGES_REQUESTED" : "EDITED";
    }
}
