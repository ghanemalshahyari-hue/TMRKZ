package ae.mover.facilities;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Hashing;
import ae.mover.common.Json;
import ae.mover.common.Ref;
import ae.mover.common.Times;
import ae.mover.reservations.ReservationService;

/**
 * Local map packages and the facility layers drawn over them. Only packages installed on the local volume are
 * offered; requesting an area outside every installed package returns an explicit "not covered" message.
 */
@Service
public class MapService {

    private static final Logger log = LoggerFactory.getLogger(MapService.class);

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final SiteService sites;
    private final ReservationService reservations;
    private final AuditService audit;
    private final Path mapRoot;

    public MapService(JdbcClient jdbc, Json json, Clock clock, SiteService sites, ReservationService reservations,
                      AuditService audit, @Value("${mover.map.root}") String mapRoot) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.sites = sites;
        this.reservations = reservations;
        this.audit = audit;
        this.mapRoot = Path.of(mapRoot).toAbsolutePath().normalize();
    }

    public record Coverage(double minLat, double minLng, double maxLat, double maxLng) {
    }

    public record MapPackage(String id, String code, String name, String source, String license, String attributionHtml,
                             Coverage coverage, String crs, String version, String dataDate, String format, String contentUrl) {
    }

    /** Registers packages found under the map root (each directory holds manifest.json + files with SHA-256). */
    @Transactional
    public void installLocalPackages() {
        if (!Files.isDirectory(mapRoot)) {
            log.warn("Map package directory {} not found; map backgrounds unavailable", mapRoot);
            return;
        }
        try (Stream<Path> dirs = Files.list(mapRoot)) {
            for (Path dir : dirs.filter(Files::isDirectory).toList()) {
                Path manifest = dir.resolve("manifest.json");
                if (!Files.exists(manifest)) {
                    continue;
                }
                JsonNode m = json.tree(Files.readString(manifest));
                for (JsonNode f : m.path("files")) {
                    Path file = dir.resolve(f.path("path").asText()).normalize();
                    if (!file.startsWith(dir) || !Files.exists(file)) {
                        log.warn("Map package file missing: {}", file);
                        continue;
                    }
                    String sha = Hashing.sha256(Files.readAllBytes(file));
                    if (!sha.equals(f.path("sha256").asText())) {
                        log.error("Map package checksum mismatch for {} — not installed", file);
                        continue;
                    }
                    int exists = jdbc.sql("select count(*) from map_package where code = :c and version = :v and format = :f")
                            .param("c", m.path("code").asText()).param("v", m.path("version").asText())
                            .param("f", f.path("format").asText()).query(Integer.class).single();
                    if (exists > 0) {
                        continue;
                    }
                    UUID id = UUID.randomUUID();
                    JsonNode cov = m.path("coverage");
                    jdbc.sql("""
                            insert into map_package(id, code, name, version, data_date, source, license, attribution_html, crs,
                                min_lat, min_lng, max_lat, max_lng, format, local_path, content_sha256)
                            values (:id, :code, :name, :ver, :date, :src, :lic, :attr, :crs, :a, :b, :c, :d, :fmt, :path, :sha)""")
                            .param("id", id).param("code", m.path("code").asText()).param("name", m.path("name").asText())
                            .param("ver", m.path("version").asText()).param("date", LocalDate.parse(m.path("dataDate").asText()))
                            .param("src", m.path("source").asText()).param("lic", m.path("license").asText())
                            .param("attr", m.path("attributionHtml").asText()).param("crs", m.path("crs").asText())
                            .param("a", cov.path("minLat").asDouble()).param("b", cov.path("minLng").asDouble())
                            .param("c", cov.path("maxLat").asDouble()).param("d", cov.path("maxLng").asDouble())
                            .param("fmt", f.path("format").asText()).param("path", mapRoot.relativize(file).toString().replace('\\', '/'))
                            .param("sha", sha).update();
                    audit.system("MAP_PACKAGE_INSTALLED", "MAP_PACKAGE", id.toString(), m.path("name").asText(),
                            Map.of("version", m.path("version").asText(), "format", f.path("format").asText(), "sha256", sha));
                }
            }
        } catch (IOException e) {
            log.error("Failed to scan map packages", e);
        }
    }

    public List<MapPackage> packages(AccessContext ctx) {
        ctx.require(Permission.VIEW);
        return jdbc.sql("select * from map_package where status = 'ACTIVE' order by code, version desc, format desc")
                .query((rs, n) -> new MapPackage(rs.getString("id"), rs.getString("code"), rs.getString("name"),
                        rs.getString("source"), rs.getString("license"), rs.getString("attribution_html"),
                        new Coverage(rs.getDouble("min_lat"), rs.getDouble("min_lng"), rs.getDouble("max_lat"), rs.getDouble("max_lng")),
                        rs.getString("crs"), rs.getString("version"), rs.getString("data_date"), rs.getString("format"),
                        "/api/v1/map/packages/" + rs.getString("id") + "/content")).list();
    }

    public record PackageContent(byte[] bytes, String contentType, String fileName) {
    }

    public PackageContent content(AccessContext ctx, UUID id) {
        ctx.require(Permission.VIEW);
        Map<String, Object> row = jdbc.sql("select local_path, format, content_sha256 from map_package where id = :id and status = 'ACTIVE'")
                .param("id", id).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        Path file = mapRoot.resolve((String) row.get("local_path")).normalize();
        if (!file.startsWith(mapRoot)) {
            throw ApiException.notFound();
        }
        try {
            byte[] bytes = Files.readAllBytes(file);
            String type = "SVG_OVERLAY".equals(row.get("format")) ? "image/svg+xml" : "application/geo+json";
            return new PackageContent(bytes, type, file.getFileName().toString());
        } catch (IOException e) {
            throw ApiException.notFound();
        }
    }

    public record Feature(String siteId, String code, String name, double lat, double lng, String availability,
                          String administrative, @JsonInclude(JsonInclude.Include.NON_NULL) Ref occupantOrg, int pendingCount) {
    }

    public record MapFeatures(String asOf, String dataVersion, Map<String, Object> coverage, List<Feature> features) {
    }

    public MapFeatures features(AccessContext ctx, String bbox, String time) {
        ctx.require(Permission.VIEW);
        Instant at = time == null || time.isBlank() ? clock.instant() : Times.parse(time, "time");
        Instant until = at.plus(Duration.ofDays(1));
        double[] box = null;
        if (bbox != null && !bbox.isBlank()) {
            String[] parts = bbox.split(",");
            if (parts.length != 4) {
                throw ApiException.validation("صيغة النطاق bbox يجب أن تكون minLng,minLat,maxLng,maxLat.");
            }
            box = new double[4];
            for (int i = 0; i < 4; i++) {
                box[i] = Double.parseDouble(parts[i].trim());
            }
        }
        List<String> covering = new ArrayList<>();
        if (box != null) {
            final double[] b = box;
            jdbc.sql("select id, min_lat, min_lng, max_lat, max_lng from map_package where status = 'ACTIVE'").query((rs, n) -> {
                boolean inside = b[0] >= rs.getDouble("min_lng") && b[2] <= rs.getDouble("max_lng")
                        && b[1] >= rs.getDouble("min_lat") && b[3] <= rs.getDouble("max_lat");
                if (inside) {
                    covering.add(rs.getString("id"));
                }
                return null;
            }).list();
        } else {
            covering.addAll(jdbc.sql("select id::text from map_package where status = 'ACTIVE'").query(String.class).list());
        }
        Map<String, Object> coverage = new LinkedHashMap<>();
        coverage.put("covered", !covering.isEmpty());
        coverage.put("packageIds", covering);
        coverage.put("message", covering.isEmpty()
                ? "النطاق المطلوب خارج حزم الخرائط المثبتة محلياً. تُعرض علامات المرافق فقط دون خلفية."
                : null);
        Map<UUID, String> status = siteStatus(at, until);
        Map<UUID, Integer> pending = pendingCounts(at, until);
        Map<UUID, Ref> occupants = occupants(at, until);
        List<Feature> features = new ArrayList<>();
        for (SiteService.SiteView s : sites.list(ctx)) {
            if (s.location() == null || s.parentId() == null) {
                continue;
            }
            if (box != null && (s.location().lng() < box[0] || s.location().lng() > box[2]
                    || s.location().lat() < box[1] || s.location().lat() > box[3])) {
                continue;
            }
            UUID id = UUID.fromString(s.id());
            String availability = status.getOrDefault(id, pending.containsKey(id) ? "PENDING" : "FREE");
            String administrative = "BUSY".equals(availability) ? "APPROVED" : pending.containsKey(id) ? "PENDING" : "NONE";
            features.add(new Feature(s.id(), s.code(), s.name(), s.location().lat(), s.location().lng(), availability,
                    administrative, "FULL".equals(s.view()) ? occupants.get(id) : null, pending.getOrDefault(id, 0)));
        }
        String dataVersion = jdbc.sql("select coalesce(max(updated_at), now())::text from reservation").query(String.class).single();
        return new MapFeatures(at.toString(), dataVersion, coverage, features);
    }

    private Map<UUID, String> siteStatus(Instant from, Instant to) {
        Map<UUID, String> out = new HashMap<>();
        jdbc.sql("""
                select distinct r.site_id from reservation_lock l join resource r on r.id = l.resource_id
                where l.kind = 'X' and l.period && tstzrange(:a, :b, '[)')""")
                .param("a", Db.ts(from)).param("b", Db.ts(to))
                .query((rs, n) -> out.put(Db.uuid(rs, "site_id"), "BUSY")).list();
        jdbc.sql("""
                select distinct r.site_id from reservation v join resource r on r.id = v.resource_id
                where v.status = 'ACTIVE' and r.policy = 'SHARED' and tstzrange(v.period_start, v.period_end, '[)') && tstzrange(:a, :b, '[)')""")
                .param("a", Db.ts(from)).param("b", Db.ts(to))
                .query((rs, n) -> out.put(Db.uuid(rs, "site_id"), "BUSY")).list();
        return out;
    }

    /** Pending (orange) requests never block anything; they are a separate administrative layer. */
    private Map<UUID, Integer> pendingCounts(Instant from, Instant to) {
        Map<UUID, Integer> out = new HashMap<>();
        jdbc.sql("""
                select r.site_id, count(distinct q.id) as n from request q
                join request_type t on t.code = q.type_code and t.kind in ('NEW_RESERVATION', 'EXTENSION', 'MODIFICATION')
                join request_resource rr on rr.request_id = q.id join resource r on r.id = rr.resource_id
                where q.status = 'SUBMITTED' and tstzrange(q.period_start, q.period_end, '[)') && tstzrange(:a, :b, '[)')
                group by r.site_id""")
                .param("a", Db.ts(from)).param("b", Db.ts(to))
                .query((rs, n) -> out.put(Db.uuid(rs, "site_id"), rs.getInt("n"))).list();
        return out;
    }

    private Map<UUID, Ref> occupants(Instant from, Instant to) {
        Map<UUID, Ref> out = new HashMap<>();
        jdbc.sql("""
                select distinct on (r.site_id) r.site_id, o.id, o.name from reservation v join resource r on r.id = v.resource_id
                join organization o on o.id = v.organization_id
                where v.status = 'ACTIVE' and tstzrange(v.period_start, v.period_end, '[)') && tstzrange(:a, :b, '[)')
                order by r.site_id, v.period_start""")
                .param("a", Db.ts(from)).param("b", Db.ts(to))
                .query((rs, n) -> out.put(Db.uuid(rs, "site_id"), Ref.of(Db.uuid(rs, "id"), rs.getString("name")))).list();
        return out;
    }

    public record GridRow(String siteId, List<String> cells) {
    }

    public record Grid(List<String> days, List<GridRow> rows) {
    }

    public Grid grid(AccessContext ctx, String from, Integer days) {
        ctx.require(Permission.VIEW);
        LocalDate start = from == null ? LocalDate.now(clock.withZone(Times.DISPLAY_ZONE)) : Times.parseDate(from, "from");
        int n = days == null ? 7 : Math.max(1, Math.min(days, 31));
        List<String> dayList = new ArrayList<>();
        List<Map<UUID, String>> statuses = new ArrayList<>();
        List<Map<UUID, Integer>> pendings = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            LocalDate d = start.plusDays(i);
            dayList.add(d.toString());
            Instant a = Times.startOfDay(d);
            Instant b = Times.startOfDay(d.plusDays(1));
            statuses.add(siteStatus(a, b));
            pendings.add(pendingCounts(a, b));
        }
        List<GridRow> rows = new ArrayList<>();
        for (SiteService.SiteView s : sites.list(ctx)) {
            if (s.parentId() == null) {
                continue;
            }
            UUID id = UUID.fromString(s.id());
            List<String> cells = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                cells.add(statuses.get(i).containsKey(id) ? "BUSY" : pendings.get(i).containsKey(id) ? "PENDING" : "FREE");
            }
            rows.add(new GridRow(s.id(), cells));
        }
        return new Grid(dayList, rows);
    }

    public record CheckInput(List<String> resourceIds, String start, String end, String excludeReservationId) {
    }

    public record CheckResult(boolean available, List<ReservationService.Conflict> conflicts, int pendingRequests, String note) {
    }

    public CheckResult check(AccessContext ctx, CheckInput in) {
        ctx.require(Permission.VIEW);
        if (in == null || in.resourceIds() == null || in.resourceIds().isEmpty()) {
            throw ApiException.validation("حدد المرافق المطلوب فحصها.");
        }
        Instant start = Times.parse(in.start(), "start");
        Instant end = Times.parse(in.end(), "end");
        if (start == null || (end != null && !end.isAfter(start))) {
            throw ApiException.validation("حدد فترة صحيحة.");
        }
        List<UUID> ids = in.resourceIds().stream().map(UUID::fromString).toList();
        List<ReservationService.Conflict> conflicts = reservations.conflicts(ids, start, end,
                in.excludeReservationId() == null ? null : UUID.fromString(in.excludeReservationId()));
        int pending = jdbc.sql("""
                select count(distinct q.id) from request q join request_resource rr on rr.request_id = q.id
                where q.status = 'SUBMITTED' and rr.resource_id = any(string_to_array(:ids, ',')::uuid[])
                  and tstzrange(q.period_start, q.period_end, '[)') && tstzrange(:a, :b, '[)')""")
                .param("ids", Db.ids(ids)).param("a", Db.ts(start)).param("b", Db.ts(end)).query(Integer.class).single();
        return new CheckResult(conflicts.isEmpty(), conflicts, pending,
                "معاينة فقط: لا تمنح حجزاً، ويُعاد التحقق عند الاعتماد النهائي.");
    }
}
