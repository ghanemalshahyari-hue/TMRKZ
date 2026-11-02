package ae.mover.facilities;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.access.AccessContext;
import ae.mover.access.ViewLevel;

/**
 * Where registered boundaries may meet (audit P1-4, ADR-027). Two active sites' boundaries overlap only along the site
 * tree, and only as containment — a zone inside its campus: where a site meets an ancestor's boundary it lies inside it,
 * and where it meets a descendant's boundary it contains it. Any other overlap above {@link #TOLERANCE_M2} is refused.
 * The register has no site-level sharing: organisations share one site through a SHARED resource, which needs no
 * overlapping boundaries, so there is no other exception. Because the exemption follows the tree, moving a site in the
 * tree is checked too. A site the editor may not see is not named.
 */
@Component
public class SiteOverlapRule {

    /** A shared edge or numerical noise is not an overlap. */
    static final double TOLERANCE_M2 = 1.0;

    private final JdbcClient jdbc;

    public SiteOverlapRule(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Boundary registrations and tree moves are checked one at a time (transaction-level advisory lock): two concurrent
     * changes could otherwise each pass the check against the other's old state.
     */
    static void serialise(JdbcClient jdbc) {
        jdbc.sql("select pg_advisory_xact_lock(hashtext('tmrkz.site-boundaries'))").query().listOfRows();
    }

    /** Problems of a boundary for a site, against every other active site's current boundary, in the tree as it is now. */
    public List<String> problems(AccessContext ctx, UUID siteId, String geojson4326) {
        List<String> out = new ArrayList<>();
        jdbc.sql("""
                with recursive up(id) as (
                    select parent_id from site where id = :s and parent_id is not null
                    union select x.parent_id from site x join up on x.id = up.id where x.parent_id is not null),
                down(id) as (
                    select id from site where parent_id = :s
                    union select x.id from site x join down on x.parent_id = down.id),
                p as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) as g),
                other as (
                    select s.id, s.name, v.geom,
                           case when s.id in (select id from up) then 'ANCESTOR'
                                when s.id in (select id from down) then 'DESCENDANT' else 'UNRELATED' end as rel
                    from site s join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version
                         and v.geometry_type <> 'Point', p
                    where s.status = 'ACTIVE' and s.id <> :s and v.geom && p.g and ST_Intersects(v.geom, p.g))
                select o.id, o.name, o.rel, sr.organization_id as resp,
                       ST_Area(ST_Intersection(o.geom, p.g)::geography) as shared,
                       case o.rel when 'ANCESTOR' then ST_Area(ST_Difference(p.g, o.geom)::geography)
                                  when 'DESCENDANT' then ST_Area(ST_Difference(o.geom, p.g)::geography) else 0 end as outside
                from other o left join site_responsibility sr on sr.site_id = o.id and sr.valid_to is null, p
                order by shared desc""").param("s", siteId).param("g", geojson4326).query().listOfRows().forEach(r -> {
            double shared = ((Number) r.get("shared")).doubleValue();
            double outside = ((Number) r.get("outside")).doubleValue();
            if (shared <= TOLERANCE_M2) {
                return;
            }
            String label = label(ctx, r);
            switch ((String) r.get("rel")) {
                case "UNRELATED" -> out.add("الحدود تتداخل مع حدود " + label + " بمساحة " + Math.round(shared)
                        + " م²؛ لا تتداخل حدود موقعين إلا إذا كان أحدهما ضمن الآخر في شجرة المواقع.");
                case "ANCESTOR" -> {
                    if (outside > TOLERANCE_M2) {
                        out.add("جزء من الحدود بمساحة " + Math.round(outside) + " م² خارج حدود الموقع الأعلى " + label
                                + "؛ الموقع الفرعي يقع داخل حدود موقعه الأعلى أو خارجها كلياً، لا عليها.");
                    }
                }
                default -> {
                    if (outside > TOLERANCE_M2) {
                        out.add("جزء من حدود الموقع الفرعي " + label + " بمساحة " + Math.round(outside)
                                + " م² خارج هذه الحدود؛ الموقع الأعلى يحيط بفروعه التي تلتقي حدوده.");
                    }
                }
            }
        });
        return out;
    }

    /** After a site moved in the tree: the site and every descendant, with their current boundaries, against everyone. */
    public List<String> afterMove(AccessContext ctx, UUID siteId) {
        List<String> out = new ArrayList<>();
        jdbc.sql("""
                with recursive t(id) as (select cast(:s as uuid) union select x.id from site x join t on x.parent_id = t.id)
                select s.id, s.name, sr.organization_id as resp, ST_AsGeoJSON(v.geom) as gj from site s join t on t.id = s.id
                join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version and v.geometry_type <> 'Point'
                left join site_responsibility sr on sr.site_id = s.id and sr.valid_to is null
                where s.status = 'ACTIVE'""").param("s", siteId).query().listOfRows().forEach(r -> {
            UUID id = (UUID) r.get("id");
            for (String p : problems(ctx, id, (String) r.get("gj"))) {
                out.add(id.equals(siteId) ? p : label(ctx, r) + ": " + p);
            }
        });
        return out;
    }

    private static String label(AccessContext ctx, Map<String, Object> r) {
        boolean visible = ctx.siteView((UUID) r.get("id"), Set.of(), (UUID) r.get("resp")) != ViewLevel.NONE;
        return visible ? "«" + r.get("name") + "»" : "موقع آخر غير ظاهر لك";
    }
}
