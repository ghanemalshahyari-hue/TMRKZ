package ae.mover.facilities;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Declared boundary input formats: GeoJSON and KML. Each feature becomes a candidate polygon with the site code it
 * names. Nothing is inferred: a coordinate reference system comes from the file or from an explicit declaration, never
 * from the size of the numbers, and coordinates keep the GeoJSON order (x = longitude/easting, y = latitude/northing).
 */
final class GeoInput {

    /** Supported coordinate reference systems → PostGIS SRID. Transformations run in PostGIS (PROJ, local grids only). */
    static final Map<String, Integer> SUPPORTED_CRS = Map.of(
            "EPSG:4326", 4326,
            "EPSG:3857", 3857,
            "EPSG:32639", 32639,
            "EPSG:32640", 32640);

    static final int MAX_BYTES = 5 * 1024 * 1024;
    static final int MAX_FEATURES = 2000;
    static final int MAX_VERTICES = 50_000;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    record Candidate(int index, String siteCode, String label, JsonNode geometry, String type, int vertices,
                     List<String> problems) {
    }

    record Parsed(String format, String fileCrs, List<Candidate> candidates, List<String> fileProblems) {
    }

    private GeoInput() {
    }

    /** Format from the file name; unsupported formats are refused with the documented conversion route. */
    static String format(String fileName) {
        String n = fileName == null ? "" : fileName.toLowerCase(Locale.ROOT);
        if (n.endsWith(".geojson") || n.endsWith(".json")) {
            return "GEOJSON";
        }
        if (n.endsWith(".kml")) {
            return "KML";
        }
        if (n.endsWith(".kmz")) {
            throw new IllegalArgumentException("ملفات KMZ المضغوطة غير مدعومة: فك الضغط واستورد ملف KML الموجود داخلها.");
        }
        if (n.endsWith(".zip") || n.endsWith(".shp") || n.endsWith(".gpkg") || n.endsWith(".dxf") || n.endsWith(".gml")) {
            throw new IllegalArgumentException("الصيغة غير معلنة للاستيراد داخل التطبيق. الصيغ المدعومة: GeoJSON وKML. "
                    + "حوّل Shapefile أو GeoPackage إلى GeoJSON بنظام إحداثيات صريح وفق docs/OPERATIONS.md ثم استورده.");
        }
        throw new IllegalArgumentException("صيغة الملف غير مدعومة. الصيغ المدعومة لاستيراد الحدود: GeoJSON (.geojson/.json) وKML (.kml).");
    }

    /**
     * Normalises a CRS name to a supported key. CRS84 and EPSG:4326 in GeoJSON order are the same lon/lat system; the
     * URN form of EPSG:4326 defines latitude first and is refused as ambiguous rather than reinterpreted.
     */
    static String normaliseCrs(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String v = raw.trim();
        String u = v.toUpperCase(Locale.ROOT);
        if (u.equals("CRS84") || u.equals("OGC:CRS84") || u.equals("URN:OGC:DEF:CRS:OGC:1.3:CRS84") || u.equals("URN:OGC:DEF:CRS:OGC::CRS84")) {
            return "EPSG:4326";
        }
        if (u.equals("URN:OGC:DEF:CRS:EPSG::4326") || u.equals("URN:OGC:DEF:CRS:EPSG:6.6:4326")) {
            throw new IllegalArgumentException("نظام الإحداثيات «" + v + "» يعرّف خط العرض أولاً، وهذا يخالف ترتيب GeoJSON. "
                    + "صرّح بـ CRS84 أو EPSG:4326 بترتيب (خط الطول، خط العرض) بعد التحقق من الملف.");
        }
        String code = u.startsWith("URN:OGC:DEF:CRS:EPSG::") ? "EPSG:" + u.substring("URN:OGC:DEF:CRS:EPSG::".length()) : u;
        if (SUPPORTED_CRS.containsKey(code)) {
            return code;
        }
        throw new IllegalArgumentException("نظام الإحداثيات «" + v + "» غير مدعوم. الأنظمة المدعومة: "
                + String.join("، ", SUPPORTED_CRS.keySet().stream().sorted().toList()) + ".");
    }

    static Parsed parse(String format, byte[] bytes) {
        return "KML".equals(format) ? kml(bytes) : geojson(bytes);
    }

    // ---- GeoJSON ------------------------------------------------------------------------------------------

    private static Parsed geojson(byte[] bytes) {
        List<String> fileProblems = new ArrayList<>();
        List<Candidate> out = new ArrayList<>();
        JsonNode root;
        try {
            root = MAPPER.readTree(new String(bytes, StandardCharsets.UTF_8));
        } catch (Exception e) {
            fileProblems.add("الملف ليس GeoJSON صالحاً (تعذر قراءة JSON).");
            return new Parsed("GEOJSON", null, out, fileProblems);
        }
        if (root == null || !root.isObject()) {
            fileProblems.add("الملف ليس GeoJSON صالحاً.");
            return new Parsed("GEOJSON", null, out, fileProblems);
        }
        String fileCrs = null;
        JsonNode crs = root.path("crs");
        if (!crs.isMissingNode() && !crs.isNull()) {
            if (!"name".equals(crs.path("type").asText()) || !crs.path("properties").path("name").isTextual()) {
                fileProblems.add("تعريف نظام الإحداثيات في الملف غير مدعوم (المقبول: crs من النوع name).");
            } else {
                try {
                    fileCrs = normaliseCrs(crs.path("properties").path("name").asText());
                } catch (IllegalArgumentException e) {
                    fileProblems.add(e.getMessage());
                }
            }
        }
        List<JsonNode> features = new ArrayList<>();
        switch (root.path("type").asText()) {
            case "FeatureCollection" -> root.path("features").forEach(features::add);
            case "Feature" -> features.add(root);
            case "Polygon", "MultiPolygon", "Point", "LineString", "MultiPoint", "MultiLineString", "GeometryCollection" -> {
                ObjectNode f = MAPPER.createObjectNode();
                f.put("type", "Feature");
                f.set("geometry", root);
                f.set("properties", MAPPER.createObjectNode());
                features.add(f);
            }
            default -> fileProblems.add("نوع جذر GeoJSON غير معروف؛ المتوقع FeatureCollection أو Feature أو هندسة.");
        }
        if (features.size() > MAX_FEATURES) {
            fileProblems.add("عدد الأشكال (" + features.size() + ") يتجاوز الحد المسموح " + MAX_FEATURES + " في الملف الواحد.");
            return new Parsed("GEOJSON", fileCrs, out, fileProblems);
        }
        if (features.isEmpty() && fileProblems.isEmpty()) {
            fileProblems.add("لا يحتوي الملف على أشكال.");
        }
        int i = 0;
        for (JsonNode f : features) {
            JsonNode props = f.path("properties");
            String code = text(props, "site_code", "code", "siteCode");
            String label = text(props, "name", "label");
            out.add(candidate(i++, code, label, f.path("geometry")));
        }
        return new Parsed("GEOJSON", fileCrs, out, fileProblems);
    }

    private static String text(JsonNode props, String... keys) {
        for (String k : keys) {
            JsonNode v = props.path(k);
            if (v.isTextual() && !v.asText().isBlank()) {
                return v.asText().trim();
            }
            if (v.isNumber()) {
                return v.asText();
            }
        }
        return null;
    }

    /** Structural check and 2D rebuild of one geometry; validity (self-intersection etc.) is checked by PostGIS. */
    static Candidate candidate(int index, String code, String label, JsonNode g) {
        List<String> problems = new ArrayList<>();
        String type = g == null || g.isMissingNode() || g.isNull() ? null : g.path("type").asText(null);
        ObjectNode clean = MAPPER.createObjectNode();
        int[] vertices = {0};
        if (type == null) {
            problems.add("الشكل بلا هندسة.");
        } else if (!type.equals("Polygon") && !type.equals("MultiPolygon")) {
            problems.add("نوع الهندسة «" + type + "» غير مقبول للحدود؛ المطلوب Polygon أو MultiPolygon.");
        } else {
            clean.put("type", type);
            JsonNode coords = g.path("coordinates");
            ArrayNode rebuilt = MAPPER.createArrayNode();
            if (type.equals("Polygon")) {
                polygon(coords, rebuilt, problems, vertices);
            } else if (!coords.isArray() || coords.isEmpty()) {
                problems.add("MultiPolygon بلا مضلعات.");
            } else {
                for (JsonNode p : coords) {
                    ArrayNode one = MAPPER.createArrayNode();
                    polygon(p, one, problems, vertices);
                    rebuilt.add(one);
                }
            }
            clean.set("coordinates", rebuilt);
            if (vertices[0] > MAX_VERTICES) {
                problems.add("عدد الرؤوس (" + vertices[0] + ") يتجاوز الحد " + MAX_VERTICES + ".");
            }
        }
        return new Candidate(index, code, label, problems.isEmpty() ? clean : null, type, vertices[0], problems);
    }

    private static void polygon(JsonNode rings, ArrayNode out, List<String> problems, int[] vertices) {
        if (!rings.isArray() || rings.isEmpty()) {
            problems.add("مضلع بلا حلقات.");
            return;
        }
        for (JsonNode ring : rings) {
            if (!ring.isArray() || ring.size() < 4) {
                problems.add("كل حلقة في المضلع تحتاج أربع نقاط على الأقل (مع تكرار النقطة الأولى في النهاية).");
                return;
            }
            ArrayNode r = MAPPER.createArrayNode();
            for (JsonNode pos : ring) {
                if (!pos.isArray() || pos.size() < 2 || !pos.get(0).isNumber() || !pos.get(1).isNumber()
                        || !Double.isFinite(pos.get(0).asDouble()) || !Double.isFinite(pos.get(1).asDouble())) {
                    problems.add("إحداثيات غير رقمية أو ناقصة في المضلع.");
                    return;
                }
                ArrayNode p = MAPPER.createArrayNode();
                p.add(pos.get(0).asDouble());
                p.add(pos.get(1).asDouble());
                r.add(p);
                vertices[0]++;
            }
            JsonNode first = r.get(0);
            JsonNode last = r.get(r.size() - 1);
            if (first.get(0).asDouble() != last.get(0).asDouble() || first.get(1).asDouble() != last.get(1).asDouble()) {
                problems.add("حلقة المضلع غير مغلقة: يجب أن تطابق النقطة الأخيرة النقطة الأولى.");
                return;
            }
            out.add(r);
        }
    }

    // ---- KML ------------------------------------------------------------------------------------------------

    /** KML 2.2 defines WGS 84 longitude, latitude[, altitude]; altitude is dropped. External entities are disabled. */
    private static Parsed kml(byte[] bytes) {
        List<String> fileProblems = new ArrayList<>();
        List<Candidate> out = new ArrayList<>();
        Document doc;
        try {
            DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
            f.setNamespaceAware(true);
            f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            f.setFeature("http://xml.org/sax/features/external-general-entities", false);
            f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            f.setXIncludeAware(false);
            f.setExpandEntityReferences(false);
            DocumentBuilder b = f.newDocumentBuilder();
            b.setErrorHandler(null);
            doc = b.parse(new ByteArrayInputStream(bytes));
        } catch (Exception e) {
            fileProblems.add("الملف ليس KML صالحاً (تعذر قراءة XML أو يحتوي تعريفات DOCTYPE غير مسموحة).");
            return new Parsed("KML", "EPSG:4326", out, fileProblems);
        }
        if (!"kml".equals(doc.getDocumentElement().getLocalName())) {
            fileProblems.add("جذر الملف ليس kml.");
            return new Parsed("KML", "EPSG:4326", out, fileProblems);
        }
        NodeList placemarks = doc.getElementsByTagNameNS("*", "Placemark");
        if (placemarks.getLength() > MAX_FEATURES) {
            fileProblems.add("عدد الأشكال يتجاوز الحد المسموح " + MAX_FEATURES + ".");
            return new Parsed("KML", "EPSG:4326", out, fileProblems);
        }
        if (placemarks.getLength() == 0) {
            fileProblems.add("لا يحتوي الملف على Placemark.");
        }
        for (int i = 0; i < placemarks.getLength(); i++) {
            Element pm = (Element) placemarks.item(i);
            String label = childText(pm, "name");
            String code = kmlData(pm);
            List<Element> polygons = descendants(pm, "Polygon");
            boolean otherGeometry = !descendants(pm, "Point").isEmpty() || !descendants(pm, "LineString").isEmpty();
            ObjectNode geometry = MAPPER.createObjectNode();
            List<String> problems = new ArrayList<>();
            if (polygons.isEmpty()) {
                out.add(new Candidate(i, code, label, null, otherGeometry ? "Point/LineString" : null, 0,
                        List.of(otherGeometry ? "نوع الهندسة غير مقبول للحدود؛ المطلوب Polygon أو MultiPolygon."
                                : "الشكل بلا هندسة مضلع.")));
                continue;
            }
            if (otherGeometry) {
                problems.add("المجموعة تحتوي نقاطاً أو خطوطاً مع المضلعات؛ الحدود تقبل مضلعات فقط.");
            }
            ArrayNode polys = MAPPER.createArrayNode();
            for (Element poly : polygons) {
                ArrayNode rings = MAPPER.createArrayNode();
                for (Element boundary : children(poly, "outerBoundaryIs", "innerBoundaryIs")) {
                    for (Element coordinates : descendants(boundary, "coordinates")) {
                        ArrayNode ring = MAPPER.createArrayNode();
                        for (String tuple : coordinates.getTextContent().trim().split("\\s+")) {
                            if (tuple.isBlank()) {
                                continue;
                            }
                            String[] parts = tuple.split(",");
                            ArrayNode pos = MAPPER.createArrayNode();
                            try {
                                pos.add(Double.parseDouble(parts[0]));
                                pos.add(Double.parseDouble(parts[1]));
                            } catch (RuntimeException e) {
                                problems.add("إحداثيات KML غير رقمية: «" + tuple + "».");
                                break;
                            }
                            ring.add(pos);
                        }
                        if ("outerBoundaryIs".equals(boundary.getLocalName())) {
                            rings.insert(0, ring);
                        } else {
                            rings.add(ring);
                        }
                    }
                }
                polys.add(rings);
            }
            if (polys.size() == 1) {
                geometry.put("type", "Polygon");
                geometry.set("coordinates", polys.get(0));
            } else {
                geometry.put("type", "MultiPolygon");
                geometry.set("coordinates", polys);
            }
            Candidate c = candidate(i, code, label, geometry);
            if (!problems.isEmpty()) {
                List<String> all = new ArrayList<>(problems);
                all.addAll(c.problems());
                c = new Candidate(i, code, label, null, c.type(), c.vertices(), all);
            }
            out.add(c);
        }
        return new Parsed("KML", "EPSG:4326", out, fileProblems);
    }

    private static String kmlData(Element pm) {
        for (Element d : descendants(pm, "Data")) {
            String name = d.getAttribute("name");
            if ("site_code".equals(name) || "code".equals(name)) {
                String v = childText(d, "value");
                if (v != null) {
                    return v;
                }
            }
        }
        for (Element d : descendants(pm, "SimpleData")) {
            String name = d.getAttribute("name");
            if (("site_code".equals(name) || "code".equals(name)) && !d.getTextContent().isBlank()) {
                return d.getTextContent().trim();
            }
        }
        return null;
    }

    private static String childText(Element e, String name) {
        for (Node n = e.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element c && name.equals(c.getLocalName()) && !c.getTextContent().isBlank()) {
                return c.getTextContent().trim();
            }
        }
        return null;
    }

    private static List<Element> children(Element e, String... names) {
        List<Element> out = new ArrayList<>();
        for (Node n = e.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element c && List.of(names).contains(c.getLocalName())) {
                out.add(c);
            }
        }
        return out;
    }

    private static List<Element> descendants(Element e, String name) {
        List<Element> out = new ArrayList<>();
        NodeList list = e.getElementsByTagNameNS("*", name);
        for (int i = 0; i < list.getLength(); i++) {
            out.add((Element) list.item(i));
        }
        return out;
    }
}
