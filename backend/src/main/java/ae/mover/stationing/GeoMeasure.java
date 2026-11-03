package ae.mover.stationing;

/**
 * Geometry the Stationing rules need, on GeoJSON in WGS 84. The production implementation is PostGIS
 * ({@link PostgisGeoMeasure}); distances and areas are geodesic.
 */
public interface GeoMeasure {

    /** Distance between the two geometries' centres (O-04: centre to centre), in metres. */
    double centroidDistanceM(String geoJsonA, String geoJsonB);

    double areaM2(String geoJson);

    /** True when the two geometries share any point (the occupied-geography test). */
    boolean intersects(String geoJsonA, String geoJsonB);
}
