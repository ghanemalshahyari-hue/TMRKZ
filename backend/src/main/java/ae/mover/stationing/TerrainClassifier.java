package ae.mover.stationing;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.ApiException;
import ae.mover.stationing.DeploymentRules.LegCheck;
import ae.mover.stationing.StationingPolicy.SlopeClass;
import ae.mover.stationing.TerrainRule.TerrainDecision;
import ae.mover.stationing.TerrainRule.TerrainShare;

/**
 * Terrain class of a deployment polygon from the approved slope dataset (owner stop-gate decisions 2 and 3): the slope
 * cells of {@code terrain_slope} whose centre lies inside the polygon ({@code ST_Clip}, PostGIS pixel-centre rule) are
 * counted per encoded value, each value is put into exactly one half-open class of the policy's
 * {@code terrain_slope_classification} (compared in the encoding's integer units, so a boundary is exact), the class
 * with the most cells governs, and a tie goes to {@code terrain_class_priority} or blocks ({@link TerrainRule}). Cells
 * without data (outside the dataset) are not counted and are reported. Nothing is recommended: the result only
 * validates an administrator's distance values.
 */
@Component
public class TerrainClassifier {

    /** The encoding this classifier reads (ops/terrain): uint16 slope percent × 100, floored; 65535 = no data. */
    public static final String ENCODING = "SLOPE_PERCENT_X100_FLOOR_U16";
    public static final String METHOD = "PIXEL_CENTRE_COUNT/LARGEST_SHARE/PRIORITY_TIE";

    private static final double A = 6378137.0;
    private static final double E2 = 6.69437999014e-3;

    public record ClassShare(String code, String label, long cells, double areaM2, double percent) {
    }

    /**
     * Everything the audit keeps for one assessment (classifier, dataset, shares, decision, allowance, ranges). The mean
     * and the largest slope of the counted cells (percent, from the same encoded values) are descriptive only: no rule
     * reads them (owner brief «TRUE OFFLINE 3D TERRAIN», §18: «متوسط الانحدار» when the authoritative data supports it).
     */
    public record TerrainAssessment(String datasetCode, String datasetVersion, String surfaceModel, String encoding,
                                    String processing, String method, Integer policyVersion, List<SlopeClass> classification,
                                    List<ClassShare> shares, long coveredCells, long estimatedCells, String controllingClass,
                                    String controllingLabel, boolean tie, List<String> tied, boolean resolved,
                                    List<String> priority, double allowanceM, Range primary, Range alternative,
                                    double meanSlopePct, double maxSlopePct) {
    }

    /** Effective deployment band of one leg after the allowance (the minimum never changes, O-06). */
    public record Range(double baseMinM, double baseMaxM, double effectiveMinM, double effectiveMaxM, boolean terrainApplies) {
    }

    private final JdbcClient jdbc;

    public TerrainClassifier(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public TerrainAssessment assess(String polygonGeoJson, StationingPolicy policy, Integer policyVersion) {
        var sc = policy.terrainSlopeClassification();
        Map<String, Object> ds = jdbc.sql("""
                select id, surface_model, slope_encoding, manifest ->> 'processingVersion' as processing
                  from terrain_dataset where code = :c and version = :v""")
                .param("c", sc.datasetCode()).param("v", sc.datasetVersion()).query().listOfRows().stream().findFirst()
                .orElseThrow(() -> ApiException.validation("مجموعة بيانات الأرض " + sc.datasetCode() + " / " + sc.datasetVersion()
                        + " غير محمّلة؛ لا يمكن تحديد فئة الأرض."));
        if (!ENCODING.equals(ds.get("slope_encoding"))) {
            throw new IllegalStateException("unsupported slope encoding " + ds.get("slope_encoding"));
        }
        Map<String, Object> geo = jdbc.sql("""
                with g as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) as geom)
                select ST_IsValid(geom) as valid, GeometryType(geom) as type, ST_Area(geom::geography) as area,
                       ST_Y(ST_Centroid(geom)) as lat,
                       (select abs(ST_ScaleX(rast)) from terrain_slope where dataset_id = :ds limit 1) as sx,
                       (select abs(ST_ScaleY(rast)) from terrain_slope where dataset_id = :ds limit 1) as sy
                  from g""").param("g", polygonGeoJson).param("ds", ds.get("id")).query().singleRow();
        if (!Boolean.TRUE.equals(geo.get("valid")) || !String.valueOf(geo.get("type")).endsWith("POLYGON")) {
            throw ApiException.validation("منطقة الانتشار يجب أن تكون مضلعاً صالحاً.");
        }
        List<Map<String, Object>> counts = jdbc.sql("""
                with g as (select ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) as geom)
                select (vc).value::int as v, sum((vc).count)::bigint as n
                  from (select ST_ValueCount(ST_Clip(t.rast, g.geom), 1, true) as vc
                          from terrain_slope t, g
                         where t.dataset_id = :ds and ST_Intersects(t.rast, g.geom)) s
                 group by 1""").param("g", polygonGeoJson).param("ds", ds.get("id")).query().listOfRows();
        Map<String, Long> cells = new LinkedHashMap<>();
        sc.classes().forEach(c -> cells.put(c.code(), 0L));
        long covered = 0;
        double encodedSum = 0;
        int encodedMax = 0;
        for (Map<String, Object> r : counts) {
            int v = ((Number) r.get("v")).intValue();
            long n = ((Number) r.get("n")).longValue();
            cells.merge(classOf(sc.classes(), v).code(), n, Long::sum);
            covered += n;
            encodedSum += (double) v * n;
            encodedMax = Math.max(encodedMax, v);
        }
        if (covered == 0) {
            throw ApiException.validation("لا تغطية لبيانات الأرض داخل منطقة الانتشار؛ لا يمكن تحديد فئتها.");
        }
        double pixelM2 = pixelAreaM2(((Number) geo.get("lat")).doubleValue(), ((Number) geo.get("sx")).doubleValue(),
                ((Number) geo.get("sy")).doubleValue());
        List<TerrainShare> shares = new ArrayList<>();
        List<ClassShare> view = new ArrayList<>();
        for (SlopeClass c : sc.classes()) {
            long n = cells.get(c.code());
            if (n > 0) {
                shares.add(new TerrainShare(c.code(), n * pixelM2));
            }
            view.add(new ClassShare(c.code(), c.label(), n, n * pixelM2, n * 100.0 / covered));
        }
        TerrainDecision d = TerrainRule.decide(shares, policy);
        long estimated = Math.round(((Number) geo.get("area")).doubleValue() / pixelM2);
        return new TerrainAssessment(sc.datasetCode(), sc.datasetVersion(), (String) ds.get("surface_model"), ENCODING,
                (String) ds.get("processing"), METHOD, policyVersion, sc.classes(), view, covered, Math.max(estimated, covered),
                d.controlling().code(), d.controlling().label(), d.tie(), d.tied(), d.resolved(), d.priority(),
                d.resolved() ? d.controlling().allowanceM() : 0, range(policy.primary(), policy, d), range(policy.alternative(), policy, d),
                encodedSum / covered / 100.0, encodedMax / 100.0);
    }

    /** The class of an encoded value: from ≤ value < to, compared in hundredths of a percent. */
    static SlopeClass classOf(List<SlopeClass> classes, int encoded) {
        for (SlopeClass c : classes) {
            long from = Math.round(c.fromPct() * 100);
            if (encoded >= from && (c.toPct() == null || encoded < Math.round(c.toPct() * 100))) {
                return c;
            }
        }
        throw new IllegalStateException("slope value " + encoded + " outside the classification");
    }

    /** An unresolved tie blocks submission, so no allowance is shown for it. */
    private static Range range(StationingPolicy.Leg leg, StationingPolicy policy, TerrainDecision d) {
        if (!d.resolved()) {
            return new Range(leg.minM(), leg.maxM(), leg.minM(), leg.maxM(), leg.terrainApplies());
        }
        LegCheck c = DeploymentRules.leg(leg, policy, null, d);
        return new Range(c.baseMinM(), c.baseMaxM(), c.effectiveMinM(), c.effectiveMaxM(), leg.terrainApplies());
    }

    /** Area of one geographic cell at latitude {@code lat} on the WGS 84 ellipsoid (meridian and normal radii). */
    static double pixelAreaM2(double lat, double sxDeg, double syDeg) {
        double phi = Math.toRadians(lat);
        double s = Math.sin(phi);
        double w = Math.sqrt(1 - E2 * s * s);
        double n = A / w;
        double m = A * (1 - E2) / (w * w * w);
        return Math.toRadians(sxDeg) * n * Math.cos(phi) * Math.toRadians(syDeg) * m;
    }
}
