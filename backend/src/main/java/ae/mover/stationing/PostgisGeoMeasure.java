package ae.mover.stationing;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * {@link GeoMeasure} on the database's PostGIS: the same expressions as the CENTER measure of {@code PlacementService}
 * ({@code ST_Distance(ST_Centroid(a)::geography, ST_Centroid(b)::geography)}). No table is read or written.
 */
@Component
public class PostgisGeoMeasure implements GeoMeasure {

    private static final String GEOM = "ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)";

    private final JdbcClient jdbc;

    public PostgisGeoMeasure(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public double centroidDistanceM(String a, String b) {
        return jdbc.sql("select ST_Distance(ST_Centroid(" + GEOM.formatted(":a") + ")::geography, ST_Centroid(" + GEOM.formatted(":b") + ")::geography)")
                .param("a", a).param("b", b).query(Double.class).single();
    }

    @Override
    public double areaM2(String g) {
        return jdbc.sql("select ST_Area(" + GEOM.formatted(":g") + "::geography)").param("g", g).query(Double.class).single();
    }

    @Override
    public boolean intersects(String a, String b) {
        return jdbc.sql("select ST_Intersects(" + GEOM.formatted(":a") + ", " + GEOM.formatted(":b") + ")")
                .param("a", a).param("b", b).query(Boolean.class).single();
    }
}
