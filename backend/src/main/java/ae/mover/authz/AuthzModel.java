package ae.mover.authz;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import ae.mover.access.Permission;
import ae.mover.common.Hashing;

/**
 * The OpenFGA authorisation model, generated from the action list so it always reproduces the contract of ADR-013.
 *
 * <ul>
 *   <li>{@code grant}: one object per grant (membership, delegation, seat holder); its single {@code holder} tuple
 *       carries the condition {@code grant_scope} (validity window, role, site limit of the same grant).</li>
 *   <li>{@code organization} and {@code site}: {@code <action>_here} (this object only) and {@code <action>_tree}
 *       (with descendants, followed through {@code parent}); a site also inherits from the organisation that
 *       administers it, and {@code <action>_contains} marks a site holding a resource target.</li>
 *   <li>{@code system}: {@code <action>} for the explicit ALL scope and {@code <action>_any} for "held somewhere".</li>
 *   <li>{@code request}: never stored; its relations to organisations, sites, resources, creator and information
 *       recipients are sent as contextual tuples with each check.</li>
 * </ul>
 */
public final class AuthzModel {

    public static final String CONDITION = "grant_scope";
    public static final String SYSTEM = "system:tmrkz";

    private static final String EXPRESSION = """
            now >= valid_from && (open_ended || now < valid_to) && (required_role == '' || required_role == role) &&
            (!site_limited || org_level || target_resources.exists(r, r in resources) || target_sites.exists(s, s in sites_here)
             || target_site_path.exists(s, s in sites_tree) || (site_check && target_sites.exists(s, s in resource_sites)))""";

    private AuthzModel() {
    }

    public static String rel(Permission p) {
        return p.name().toLowerCase(Locale.ROOT);
    }

    public static Map<String, Object> json() {
        List<Map<String, Object>> types = new ArrayList<>();
        types.add(Map.of("type", "user"));
        types.add(type("grant", rels("holder", direct()), meta("holder", List.of(Map.of("type", "user", "condition", CONDITION)))));

        Map<String, Object> sys = new LinkedHashMap<>();
        Map<String, Object> sysMeta = new LinkedHashMap<>();
        Map<String, Object> org = new LinkedHashMap<>();
        Map<String, Object> orgMeta = new LinkedHashMap<>();
        Map<String, Object> site = new LinkedHashMap<>();
        Map<String, Object> siteMeta = new LinkedHashMap<>();
        Map<String, Object> res = new LinkedHashMap<>();
        Map<String, Object> resMeta = new LinkedHashMap<>();
        Map<String, Object> req = new LinkedHashMap<>();
        Map<String, Object> reqMeta = new LinkedHashMap<>();

        org.put("parent", direct());
        orgMeta.put("parent", types("organization"));
        org.put("system", direct());
        orgMeta.put("system", types("system"));
        org.put("info_member", direct());
        orgMeta.put("info_member", grantHolder());
        site.put("parent", direct());
        siteMeta.put("parent", types("site"));
        site.put("responsible", direct());
        siteMeta.put("responsible", types("organization"));
        site.put("system", direct());
        siteMeta.put("system", types("system"));
        res.put("system", direct());
        resMeta.put("system", types("system"));
        for (String r : List.of("creator", "related_org", "site", "resource", "info_org", "system")) {
            req.put(r, direct());
        }
        reqMeta.put("creator", types("user"));
        reqMeta.put("related_org", types("organization"));
        reqMeta.put("site", types("site"));
        reqMeta.put("resource", types("resource"));
        reqMeta.put("info_org", types("organization"));
        reqMeta.put("system", types("system"));

        for (Permission p : Permission.values()) {
            String a = rel(p);
            sys.put(a, direct());
            sysMeta.put(a, grantHolder());
            sys.put(a + "_any", direct());
            sysMeta.put(a + "_any", grantHolder());

            org.put(a + "_here", direct());
            orgMeta.put(a + "_here", grantHolder());
            org.put(a + "_tree", direct());
            orgMeta.put(a + "_tree", grantHolder());
            org.put(a + "_inh", union(computed(a + "_tree"), ttu("parent", a + "_inh")));
            org.put(a, union(computed(a + "_here"), computed(a + "_inh"), ttu("system", a)));

            site.put(a + "_here", direct());
            siteMeta.put(a + "_here", grantHolder());
            site.put(a + "_tree", direct());
            siteMeta.put(a + "_tree", grantHolder());
            site.put(a + "_contains", direct());
            siteMeta.put(a + "_contains", grantHolder());
            site.put(a + "_inh", union(computed(a + "_tree"), ttu("parent", a + "_inh")));
            site.put(a + "_direct", union(computed(a + "_here"), computed(a + "_inh")));
            site.put(a + "_req", union(computed(a + "_direct"), ttu("responsible", a)));
            site.put(a, union(computed(a + "_req"), computed(a + "_contains"), ttu("system", a)));

            res.put(a + "_here", direct());
            resMeta.put(a + "_here", grantHolder());
            res.put(a, union(computed(a + "_here"), ttu("system", a)));

            req.put(a, union(ttu("related_org", a), ttu("site", a + "_req"), ttu("resource", a), ttu("system", a)));
            // a task aimed at one organisation: that organisation only, not the administrators of the sites
            req.put(a + "_task", union(ttu("related_org", a), ttu("site", a + "_direct"), ttu("resource", a), ttu("system", a)));
        }
        req.put("view_full", union(computed("creator"), computed("view")));
        req.put("view_any", union(computed("view_full"), computed("view_summary")));
        req.put("info_view", ttu("info_org", "info_member"));

        types.add(type("system", sys, sysMeta));
        types.add(type("organization", org, orgMeta));
        types.add(type("site", site, siteMeta));
        types.add(type("resource", res, resMeta));
        types.add(type("request", req, reqMeta));

        Map<String, Object> params = new LinkedHashMap<>();
        for (String t : List.of("now", "valid_from", "valid_to")) {
            params.put(t, Map.of("type_name", "TYPE_NAME_TIMESTAMP"));
        }
        for (String b : List.of("open_ended", "site_limited", "org_level", "site_check")) {
            params.put(b, Map.of("type_name", "TYPE_NAME_BOOL"));
        }
        for (String s : List.of("role", "required_role")) {
            params.put(s, Map.of("type_name", "TYPE_NAME_STRING"));
        }
        for (String l : List.of("resources", "sites_here", "sites_tree", "resource_sites", "target_resources", "target_sites",
                "target_site_path")) {
            params.put(l, Map.of("type_name", "TYPE_NAME_LIST", "generic_types", List.of(Map.of("type_name", "TYPE_NAME_STRING"))));
        }
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("schema_version", "1.1");
        model.put("type_definitions", types);
        model.put("conditions", Map.of(CONDITION, Map.of("name", CONDITION, "expression", EXPRESSION, "parameters", params)));
        return model;
    }

    /** Stable fingerprint: a changed model is written to OpenFGA as a new model id. */
    public static String hash() {
        return Hashing.sha256(dsl());
    }

    /** The same model in OpenFGA's DSL, for review ({@code docs/authz/model.fga}). */
    public static String dsl() {
        StringBuilder b = new StringBuilder("""
                # Generated by ae.mover.authz.AuthzModel (ADR-018). Do not edit by hand.
                model
                  schema 1.1

                type user

                type grant
                  relations
                    define holder: [user with grant_scope]

                type system
                  relations
                """);
        for (Permission p : Permission.values()) {
            String a = rel(p);
            b.append("    define ").append(a).append(": [grant#holder]\n");
            b.append("    define ").append(a).append("_any: [grant#holder]\n");
        }
        b.append("\ntype organization\n  relations\n    define parent: [organization]\n    define system: [system]\n")
                .append("    define info_member: [grant#holder]\n");
        for (Permission p : Permission.values()) {
            String a = rel(p);
            b.append("    define ").append(a).append("_here: [grant#holder]\n")
                    .append("    define ").append(a).append("_tree: [grant#holder]\n")
                    .append("    define ").append(a).append("_inh: ").append(a).append("_tree or ").append(a).append("_inh from parent\n")
                    .append("    define ").append(a).append(": ").append(a).append("_here or ").append(a).append("_inh or ")
                    .append(a).append(" from system\n");
        }
        b.append("\ntype site\n  relations\n    define parent: [site]\n    define responsible: [organization]\n")
                .append("    define system: [system]\n");
        for (Permission p : Permission.values()) {
            String a = rel(p);
            b.append("    define ").append(a).append("_here: [grant#holder]\n")
                    .append("    define ").append(a).append("_tree: [grant#holder]\n")
                    .append("    define ").append(a).append("_contains: [grant#holder]\n")
                    .append("    define ").append(a).append("_inh: ").append(a).append("_tree or ").append(a).append("_inh from parent\n")
                    .append("    define ").append(a).append("_direct: ").append(a).append("_here or ").append(a).append("_inh\n")
                    .append("    define ").append(a).append("_req: ").append(a).append("_direct or ").append(a).append(" from responsible\n")
                    .append("    define ").append(a).append(": ").append(a).append("_req or ").append(a).append("_contains or ")
                    .append(a).append(" from system\n");
        }
        b.append("\ntype resource\n  relations\n    define system: [system]\n");
        for (Permission p : Permission.values()) {
            String a = rel(p);
            b.append("    define ").append(a).append("_here: [grant#holder]\n")
                    .append("    define ").append(a).append(": ").append(a).append("_here or ").append(a).append(" from system\n");
        }
        b.append("""

                type request
                  relations
                    define creator: [user]
                    define related_org: [organization]
                    define site: [site]
                    define resource: [resource]
                    define info_org: [organization]
                    define system: [system]
                """);
        for (Permission p : Permission.values()) {
            String a = rel(p);
            b.append("    define ").append(a).append(": ").append(a).append(" from related_org or ").append(a)
                    .append("_req from site or ").append(a).append(" from resource or ").append(a).append(" from system\n");
            b.append("    define ").append(a).append("_task: ").append(a).append(" from related_org or ").append(a)
                    .append("_direct from site or ").append(a).append(" from resource or ").append(a).append(" from system\n");
        }
        b.append("""
                    define view_full: creator or view
                    define view_any: view_full or view_summary
                    define info_view: info_member from info_org

                condition grant_scope(now: timestamp, valid_from: timestamp, valid_to: timestamp, open_ended: bool,
                    role: string, required_role: string, site_limited: bool, org_level: bool, site_check: bool,
                    resources: list<string>, sites_here: list<string>, sites_tree: list<string>, resource_sites: list<string>,
                    target_resources: list<string>, target_sites: list<string>, target_site_path: list<string>) {
                """);
        for (String line : EXPRESSION.split("\n")) {
            b.append("  ").append(line).append('\n');
        }
        b.append("}\n");
        return b.toString();
    }

    // ---- JSON helpers ---------------------------------------------------------------------------------------------

    private static Map<String, Object> type(String name, Map<String, Object> relations, Map<String, Object> meta) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("type", name);
        t.put("relations", relations);
        t.put("metadata", Map.of("relations", meta));
        return t;
    }

    private static Map<String, Object> rels(String name, Object def) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(name, def);
        return m;
    }

    private static Map<String, Object> meta(String name, List<Map<String, Object>> typesList) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(name, Map.of("directly_related_user_types", typesList));
        return m;
    }

    private static Map<String, Object> direct() {
        return Map.of("this", Map.of());
    }

    private static Map<String, Object> types(String type) {
        return Map.of("directly_related_user_types", List.of(Map.of("type", type)));
    }

    private static Map<String, Object> grantHolder() {
        return Map.of("directly_related_user_types", List.of(Map.of("type", "grant", "relation", "holder")));
    }

    private static Map<String, Object> computed(String relation) {
        return Map.of("computedUserset", Map.of("relation", relation));
    }

    private static Map<String, Object> ttu(String tupleset, String relation) {
        return Map.of("tupleToUserset", Map.of("tupleset", Map.of("relation", tupleset),
                "computedUserset", Map.of("relation", relation)));
    }

    @SafeVarargs
    private static Map<String, Object> union(Map<String, Object>... children) {
        return Map.of("union", Map.of("child", List.of(children)));
    }
}
