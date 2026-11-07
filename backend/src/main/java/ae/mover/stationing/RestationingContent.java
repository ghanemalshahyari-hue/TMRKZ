package ae.mover.stationing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * The editable content of a re-stationing request (Model V3 §3 {@code Content}): what each submission snapshots and what
 * a return for changes may change. One proposed site (copied from a site and dragged, edited or drawn), the units that
 * move chosen explicitly (never inferred from the tree or the site), an explicit decision for every unit of another
 * branch at an affected site (O-03), the deployment areas and a written reason for each distance exception. Geometry is
 * GeoJSON in WGS 84.
 */
public record RestationingContent(String kind, Instant start, Instant end, List<UUID> scope,
                                  Map<UUID, OccupantDecision> occupants, ProposedSite site, Map<String, Object> primary,
                                  Map<String, Object> alternative, Map<String, String> exceptions, String reason,
                                  UUID existingSite, SiteInfo siteInfo) {

    /** A site asked to be registered (طلب اعتماد موقع): its register fields, written only on activation. */
    public record SiteInfo(String name, String code, UUID parentId, String kind, String notes) {
    }

    /** Content of a request that names no existing site and registers none. */
    public RestationingContent(String kind, Instant start, Instant end, List<UUID> scope, Map<UUID, OccupantDecision> occupants,
                               ProposedSite site, Map<String, Object> primary, Map<String, Object> alternative,
                               Map<String, String> exceptions, String reason) {
        this(kind, start, end, scope, occupants, site, primary, alternative, exceptions, reason, null, null);
    }

    /** A unit of another branch at an affected site: stays, goes in a separate request, or is included (O-03). */
    public enum OccupantDecision { EXCLUDED, INCLUDED, SEPARATE }

    /** {@code shape}: COPY (the copied boundary, dragged), EDITED or DRAWN. */
    public record ProposedSite(Map<String, Object> geometry, UUID copiedFrom, String shape) {
    }

    public static final String PERMANENT = "PERMANENT";
    public static final String TEMPORARY = "TEMPORARY";

    public RestationingContent {
        kind = kind == null ? PERMANENT : kind;
        scope = scope == null ? List.of() : List.copyOf(new LinkedHashSet<>(scope));
        occupants = occupants == null ? Map.of() : Map.copyOf(occupants);
        exceptions = exceptions == null ? Map.of() : Map.copyOf(exceptions);
        reason = reason == null ? "" : reason;
    }

    public boolean temporary() {
        return TEMPORARY.equals(kind);
    }

    public OccupantDecision decision(UUID unit) {
        return occupants.get(unit);
    }

    /** The written reason for a leg's distance exception ("primary" or "alternative"), or empty. */
    public String exception(String leg) {
        String s = exceptions.get(leg);
        return s == null ? "" : s.trim();
    }

    public Map<String, Object> area(String leg) {
        return "primary".equals(leg) ? primary : alternative;
    }

    /**
     * The facts that changed between two submitted contents (V2 D18 kept by Model V3 §1 item 21): only the decisions
     * resting on one of them are taken again after a return for changes. Geometry is compared as stored.
     */
    public static Set<Fact> changed(RestationingContent a, RestationingContent b) {
        Set<Fact> f = EnumSet.noneOf(Fact.class);
        if (!new LinkedHashSet<>(a.scope).equals(new LinkedHashSet<>(b.scope)) || !a.occupants.equals(b.occupants)) {
            f.add(Fact.SCOPE);
            f.add(Fact.AVAILABILITY);
        }
        if (!a.kind.equals(b.kind)) {
            f.add(Fact.CLASSIFICATION);
            f.add(Fact.DURATION);
            f.add(Fact.AVAILABILITY);
        }
        if (!Objects.equals(a.start, b.start) || !Objects.equals(a.end, b.end)) {
            f.add(Fact.DURATION);
            f.add(Fact.AVAILABILITY);
        }
        if (!Objects.equals(geometry(a.site), geometry(b.site)) || !Objects.equals(a.existingSite, b.existingSite)
                || !Objects.equals(a.siteInfo, b.siteInfo)) {
            f.add(Fact.SITE);
            f.add(Fact.AVAILABILITY);
        }
        if (!Objects.equals(a.primary, b.primary) || !Objects.equals(a.alternative, b.alternative)
                || !a.exceptions.equals(b.exceptions)) {
            f.add(Fact.DEPLOYMENT);
        }
        return f;
    }

    private static Map<String, Object> geometry(ProposedSite s) {
        return s == null ? null : s.geometry();
    }

    /** Facts as stored text, in their declared order. */
    public static List<String> names(Set<Fact> facts) {
        List<String> out = new ArrayList<>();
        for (Fact f : Fact.values()) {
            if (facts.contains(f)) {
                out.add(f.name());
            }
        }
        return out;
    }

    /** The stored form (jsonb of the request and of each revision): ISO times, ids as text. */
    public Map<String, Object> stored() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", kind);
        m.put("start", start == null ? null : start.toString());
        m.put("end", end == null ? null : end.toString());
        m.put("scope", scope.stream().map(UUID::toString).toList());
        Map<String, String> occ = new LinkedHashMap<>();
        occupants.entrySet().stream().sorted(Map.Entry.comparingByKey())
                .forEach(e -> occ.put(e.getKey().toString(), e.getValue().name()));
        m.put("occupants", occ);
        if (site == null) {
            m.put("site", null);
        } else {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("geometry", site.geometry());
            s.put("copiedFrom", site.copiedFrom() == null ? null : site.copiedFrom().toString());
            s.put("shape", site.shape());
            m.put("site", s);
        }
        m.put("primary", primary);
        m.put("alternative", alternative);
        m.put("exceptions", new java.util.TreeMap<>(exceptions));
        m.put("reason", reason);
        if (existingSite != null) {
            m.put("existingSite", existingSite.toString());
        }
        if (siteInfo != null) {
            Map<String, Object> i = new LinkedHashMap<>();
            i.put("name", siteInfo.name());
            i.put("code", siteInfo.code());
            i.put("parentId", siteInfo.parentId() == null ? null : siteInfo.parentId().toString());
            i.put("kind", siteInfo.kind());
            i.put("notes", siteInfo.notes());
            m.put("siteInfo", i);
        }
        return m;
    }

    @SuppressWarnings("unchecked")
    public static RestationingContent fromStored(Map<String, Object> m) {
        Map<UUID, OccupantDecision> occ = new LinkedHashMap<>();
        Object o = m.get("occupants");
        if (o instanceof Map<?, ?> om) {
            om.forEach((k, v) -> occ.put(UUID.fromString(k.toString()), OccupantDecision.valueOf(v.toString())));
        }
        ProposedSite site = null;
        if (m.get("site") instanceof Map<?, ?> s && s.get("geometry") instanceof Map<?, ?> g) {
            site = new ProposedSite((Map<String, Object>) g, s.get("copiedFrom") == null ? null : UUID.fromString(s.get("copiedFrom").toString()),
                    s.get("shape") == null ? null : s.get("shape").toString());
        }
        Map<String, String> ex = new LinkedHashMap<>();
        if (m.get("exceptions") instanceof Map<?, ?> em) {
            em.forEach((k, v) -> ex.put(k.toString(), v == null ? "" : v.toString()));
        }
        List<UUID> scope = new ArrayList<>();
        if (m.get("scope") instanceof List<?> l) {
            l.forEach(x -> scope.add(UUID.fromString(x.toString())));
        }
        return new RestationingContent((String) m.get("kind"), time(m.get("start")), time(m.get("end")), scope, occ, site,
                m.get("primary") instanceof Map<?, ?> p ? (Map<String, Object>) p : null,
                m.get("alternative") instanceof Map<?, ?> a ? (Map<String, Object>) a : null, ex, (String) m.get("reason"),
                m.get("existingSite") == null ? null : UUID.fromString(m.get("existingSite").toString()),
                m.get("siteInfo") instanceof Map<?, ?> i ? new SiteInfo(text(i.get("name")), text(i.get("code")),
                        i.get("parentId") == null ? null : UUID.fromString(i.get("parentId").toString()), text(i.get("kind")), text(i.get("notes"))) : null);
    }

    private static String text(Object v) {
        return v == null ? null : v.toString();
    }

    private static Instant time(Object v) {
        return v == null || v.toString().isBlank() ? null : Instant.parse(v.toString());
    }

    /** The content as a plain map (for the audit detail and the API). */
    public Map<String, Object> summary() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", kind);
        m.put("start", start == null ? null : start.toString());
        m.put("end", end == null ? null : end.toString());
        m.put("units", scope.size());
        m.put("deployment", primary != null || alternative != null);
        return m;
    }
}
