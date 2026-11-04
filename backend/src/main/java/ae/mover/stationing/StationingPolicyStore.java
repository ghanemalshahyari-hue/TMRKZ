package ae.mover.stationing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;

/**
 * The versioned Stationing policy ({@code stationing_policy_version}): append-only versions, each a complete
 * {@link StationingPolicy} value set with its author, reason, reference and effective time. The version in force at a
 * time is the newest one whose effective time has come, so a newer version also supersedes an older one still waiting
 * for its effective time (the way to withdraw a scheduled change in an append-only history); a request keeps the
 * version it was submitted under, so a later change never alters it. Publishing needs CONFIGURE over every organisation (the System Administrator), refuses an
 * invalid value set, a backdated effective time and a terrain dataset that is not loaded, and audits the previous and
 * new value of every changed key.
 */
@Service
public class StationingPolicyStore {

    public record PolicyVersion(UUID id, int version, Integer previousVersion, StationingPolicy values, Instant effectiveFrom,
                                String reason, String reference, UUID createdBy, String createdByName, Instant createdAt) {
    }

    /** One changed key between two versions (the audit's "previous value / new value"). */
    public record Change(String key, JsonNode previous, JsonNode current) {
    }

    public record PublishInput(StationingPolicy values, Instant effectiveFrom, String reason, String reference) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final AuditService audit;

    public StationingPolicyStore(JdbcClient jdbc, Json json, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.audit = audit;
    }

    /** The version in force at {@code at}; empty before the administrator has published one. */
    public Optional<PolicyVersion> inForce(Instant at) {
        return rows("where v.effective_from <= :at order by v.version desc limit 1", Map.of("at", Db.ts(at))).stream().findFirst();
    }

    public Optional<PolicyVersion> byVersion(int version) {
        return rows("where v.version = :v", Map.of("v", version)).stream().findFirst();
    }

    /** Versions still to take effect: effective later and not superseded by a newer version effective no later. */
    public List<PolicyVersion> scheduled(Instant now) {
        List<PolicyVersion> all = history();
        return all.stream().filter(v -> v.effectiveFrom().isAfter(now))
                .filter(v -> all.stream().noneMatch(w -> w.version() > v.version() && !w.effectiveFrom().isAfter(v.effectiveFrom())))
                .toList();
    }

    /** Every version, newest first, including any published to take effect later. */
    public List<PolicyVersion> history() {
        return rows("order by v.version desc", Map.of());
    }

    public List<Change> changes(PolicyVersion v) {
        if (v.previousVersion() == null) {
            return diff(null, json.tree(v.values()));
        }
        PolicyVersion prev = byVersion(v.previousVersion()).orElseThrow();
        return diff(json.tree(prev.values()), json.tree(v.values()));
    }

    @Transactional
    public PolicyVersion publish(AccessContext ctx, PublishInput in, Instant now) {
        if (!ctx.canEverywhere(Permission.CONFIGURE)) {
            throw ApiException.forbidden("نشر سياسة التمركز لمسؤول النظام فقط (CONFIGURE على كل الجهات).");
        }
        if (in == null || in.values() == null) {
            throw ApiException.validation("أرسل قيم السياسة كاملة.");
        }
        if (in.reason() == null || in.reason().trim().length() < 5) {
            throw ApiException.validation("اكتب سبب التغيير (5 أحرف على الأقل).");
        }
        Instant effective = in.effectiveFrom() == null ? now : in.effectiveFrom();
        if (effective.isBefore(now.minusSeconds(1))) {
            throw ApiException.validation("لا تسري نسخة سياسة بأثر رجعي: تاريخ السريان من الآن فصاعداً.");
        }
        List<String> problems = validate(in.values());
        if (!problems.isEmpty()) {
            throw ApiException.validation("قيم السياسة غير صالحة.", Map.of("problems", problems));
        }
        // one publisher at a time: the newest version is read under lock so versions stay consecutive
        jdbc.sql("lock table stationing_policy_version in share row exclusive mode").update();
        PolicyVersion latest = rows("order by v.version desc limit 1", Map.of()).stream().findFirst().orElse(null);
        UUID id = UUID.randomUUID();
        int version = latest == null ? 1 : latest.version() + 1;
        jdbc.sql("""
                insert into stationing_policy_version(id, version, previous_id, policy_values, effective_from, reason, reference,
                                                      created_by, created_at)
                values (:id, :v, :prev, cast(:vals as jsonb), :eff, :reason, :ref, :by, :now)""")
                .param("id", id).param("v", version).param("prev", latest == null ? null : latest.id())
                .param("vals", json.write(in.values())).param("eff", Db.ts(effective)).param("reason", in.reason().trim())
                .param("ref", in.reference() == null || in.reference().isBlank() ? null : in.reference().trim())
                .param("by", ctx.personId()).param("now", Db.ts(now)).update();
        PolicyVersion saved = byVersion(version).orElseThrow();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("version", version);
        detail.put("previousVersion", latest == null ? null : latest.version());
        detail.put("effectiveFrom", effective.toString());
        detail.put("reference", saved.reference());
        detail.put("changes", changes(saved).stream().map(c -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", c.key());
            m.put("previous", c.previous());
            m.put("new", c.current());
            return m;
        }).toList());
        audit.recordAs(ctx.actor(), "STATIONING_POLICY_PUBLISHED", "STATIONING_POLICY", id.toString(), "النسخة " + version,
                detail, saved.reason());
        return saved;
    }

    /** Every problem that would refuse publishing these values (the dry run of the policy studio); empty when valid. */
    public List<String> validate(StationingPolicy values) {
        List<String> problems = new ArrayList<>(values.problems());
        var sc = values.terrainSlopeClassification();
        if (sc != null && sc.datasetCode() != null && !datasetLoaded(sc.datasetCode(), sc.datasetVersion())) {
            problems.add("مجموعة بيانات الأرض " + sc.datasetCode() + " / " + sc.datasetVersion() + " غير محمّلة");
        }
        return problems;
    }

    boolean datasetLoaded(String code, String version) {
        return jdbc.sql("select count(*) from terrain_dataset where code = :c and version = :v").param("c", code)
                .param("v", version == null ? "" : version).query(Long.class).single() > 0;
    }

    private List<PolicyVersion> rows(String tail, Map<String, ?> params) {
        return jdbc.sql("""
                select v.id, v.version, p.version as previous_version, v.policy_values::text as vals, v.effective_from, v.reason,
                       v.reference, v.created_by, pe.display_name as created_by_name, v.created_at
                  from stationing_policy_version v
                  left join stationing_policy_version p on p.id = v.previous_id
                  left join person pe on pe.id = v.created_by
                """ + tail).params(params)
                .query((rs, n) -> new PolicyVersion(Db.uuid(rs, "id"), rs.getInt("version"), (Integer) rs.getObject("previous_version"),
                        json.read(rs.getString("vals"), StationingPolicy.class), Db.instant(rs, "effective_from"), rs.getString("reason"),
                        rs.getString("reference"), Db.uuid(rs, "created_by"), rs.getString("created_by_name"), Db.instant(rs, "created_at")))
                .list();
    }

    /** Top-level keys of the value set whose value differs (all keys for the first version). */
    static List<Change> diff(JsonNode before, JsonNode after) {
        List<Change> out = new ArrayList<>();
        for (Iterator<String> it = after.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            JsonNode prev = before == null ? null : before.get(k);
            if (prev == null || !prev.equals(after.get(k))) {
                out.add(new Change(k, prev, after.get(k)));
            }
        }
        return out;
    }
}
