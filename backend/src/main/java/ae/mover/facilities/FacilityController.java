package ae.mover.facilities;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.common.ApiException;
import ae.mover.security.Actor;

@RestController
@RequestMapping("/api/v1")
public class FacilityController {

    private final AccessService access;
    private final SiteService sites;
    private final MapService map;
    private final MapPackageService packages;
    private final BoundaryService boundaries;
    private final ae.mover.common.Json json;

    public FacilityController(AccessService access, SiteService sites, MapService map, MapPackageService packages,
                              BoundaryService boundaries, ae.mover.common.Json json) {
        this.json = json;
        this.access = access;
        this.sites = sites;
        this.map = map;
        this.packages = packages;
        this.boundaries = boundaries;
    }

    // ---- sites -------------------------------------------------------------------------------------------

    @GetMapping("/sites")
    public List<SiteService.SiteView> sites(Actor actor) {
        var ctx = access.context(actor);
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        return sites.list(ctx);
    }

    @GetMapping("/sites/tree")
    public List<SiteService.SiteNode> siteTree(Actor actor, @RequestParam(required = false) UUID parentId) {
        var ctx = access.context(actor);
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        return sites.children(ctx, parentId);
    }

    @GetMapping("/sites/search")
    public List<SiteService.SiteNode> siteSearch(Actor actor, @RequestParam(required = false) String q,
                                                 @RequestParam(required = false) Integer limit) {
        var ctx = access.context(actor);
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        return sites.search(ctx, q, limit == null ? 30 : limit);
    }

    @GetMapping("/sites/{id}")
    public Map<String, Object> site(Actor actor, @PathVariable UUID id) {
        var ctx = access.context(actor);
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        return sites.detailView(ctx, id);
    }

    @PostMapping("/sites")
    public SiteService.SiteView createSite(Actor actor, @RequestBody SiteService.SiteInput in) {
        return sites.create(access.context(actor), in);
    }

    @PutMapping("/sites/{id}")
    public SiteService.SiteView updateSite(Actor actor, @PathVariable UUID id, @RequestBody SiteService.SiteInput in) {
        return sites.update(access.context(actor), id, in);
    }

    @PostMapping("/sites/{id}/retire")
    public ResponseEntity<Void> retire(Actor actor, @PathVariable UUID id) {
        sites.retire(access.context(actor), id);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/resources")
    public SiteService.ResourceView createResource(Actor actor, @RequestBody SiteService.ResourceInput in) {
        return sites.createResource(access.context(actor), in);
    }

    // ---- boundaries ---------------------------------------------------------------------------------------

    @GetMapping("/sites/{id}/geometry/versions")
    public List<BoundaryService.VersionView> geometryHistory(Actor actor, @PathVariable UUID id) {
        var ctx = access.context(actor);
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        return boundaries.history(ctx, id);
    }

    @GetMapping("/sites/{id}/geometry/versions/{version}")
    public BoundaryService.VersionView geometryVersion(Actor actor, @PathVariable UUID id, @PathVariable int version) {
        var ctx = access.context(actor);
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        return boundaries.version(ctx, id, version);
    }

    public record CheckGeometryInput(Map<String, Object> geometry, String crs) {
    }

    /** Validation preview only: nothing is stored. */
    @PostMapping("/sites/{id}/geometry/validate")
    public BoundaryService.Check validateGeometry(Actor actor, @PathVariable UUID id, @RequestBody CheckGeometryInput in) {
        var ctx = access.context(actor);
        ctx.require(Permission.MANAGE_FACILITIES);
        sites.detail(ctx, id);
        return boundaries.check(in == null || in.geometry() == null ? null : json.tree((Object) in.geometry()), in == null ? null : in.crs());
    }

    @PostMapping("/sites/{id}/geometry")
    public BoundaryService.VersionView saveGeometry(Actor actor, @PathVariable UUID id, @RequestBody BoundaryService.SaveInput in) {
        return boundaries.save(access.context(actor), id, in);
    }

    @PostMapping("/map/imports")
    public BoundaryService.ImportJob importBoundaries(Actor actor, @RequestParam("file") MultipartFile file,
                                                     @RequestParam(required = false) String crs,
                                                     @RequestParam(required = false) UUID targetSiteId) throws IOException {
        return boundaries.preview(access.context(actor), file.getOriginalFilename(), file.getBytes(), crs, targetSiteId);
    }

    @GetMapping("/map/imports/{id}")
    public BoundaryService.ImportJob importJob(Actor actor, @PathVariable UUID id) {
        return boundaries.job(access.context(actor), id);
    }

    public record ReasonInput(String reason) {
    }

    @PostMapping("/map/imports/{id}/publish")
    public BoundaryService.ImportJob publishImport(Actor actor, @PathVariable UUID id, @RequestBody ReasonInput in) {
        return boundaries.publish(access.context(actor), id, in == null ? null : in.reason());
    }

    @PostMapping("/map/imports/{id}/cancel")
    public BoundaryService.ImportJob cancelImport(Actor actor, @PathVariable UUID id) {
        return boundaries.cancel(access.context(actor), id);
    }

    @GetMapping("/map/boundaries/export")
    public ResponseEntity<Map<String, Object>> exportBoundaries(Actor actor) {
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("application/geo+json"))
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename("site-boundaries.geojson").build().toString())
                .body(boundaries.export(access.context(actor)));
    }

    // ---- map ------------------------------------------------------------------------------------------------

    @GetMapping("/map/context")
    public Map<String, Object> context(Actor actor) {
        return map.context(access.context(actor));
    }

    @GetMapping("/map/features")
    public MapService.MapFeatures features(Actor actor, @RequestParam(required = false) String bbox,
                                           @RequestParam(required = false) String from, @RequestParam(required = false) String to,
                                           @RequestParam(required = false) Boolean open, @RequestParam(required = false) String time,
                                           @RequestParam(required = false) String resourceIds,
                                           @RequestParam(required = false) String orgId,
                                           @RequestParam(required = false) Boolean includeSubOrgs,
                                           @RequestParam(required = false) String packageId,
                                           @RequestParam(required = false) Double zoom,
                                           @RequestParam(required = false) String siteIds) {
        return map.features(access.context(actor),
                new MapService.FeatureQuery(bbox, from, to, open, time, resourceIds, orgId, includeSubOrgs, packageId, zoom, siteIds));
    }

    @GetMapping("/map/packages")
    public List<MapPackageService.MapPackage> packages(Actor actor, @RequestParam(required = false) Boolean all) {
        return packages.list(access.context(actor), Boolean.TRUE.equals(all));
    }

    @GetMapping("/map/packages/{id}/content")
    public ResponseEntity<byte[]> packageContent(Actor actor, @PathVariable UUID id) {
        MapPackageService.PackageContent c = packages.content(access.context(actor), id);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(c.contentType()))
                .cacheControl(CacheControl.noCache().cachePrivate())
                // Packages are drawn as images; opened directly, an SVG gets no script, network or form capability.
                .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline().filename(c.fileName()).build().toString())
                .body(c.bytes());
    }

    @PostMapping("/map/packages")
    public MapPackageService.UploadResult uploadPackage(Actor actor, @RequestParam("file") MultipartFile file) throws IOException {
        return packages.upload(access.context(actor), file.getOriginalFilename(), file.getBytes());
    }

    public record StatusInput(String status, String reason) {
    }

    @PostMapping("/map/packages/{code}/{version}/status")
    public List<MapPackageService.MapPackage> packageStatus(Actor actor, @PathVariable String code, @PathVariable String version,
                                                            @RequestBody StatusInput in) {
        if (in == null) {
            throw ApiException.validation("حدد الحالة والسبب.");
        }
        return packages.setStatus(access.context(actor), code, version, in.status(), in.reason());
    }

    // ---- availability ------------------------------------------------------------------------------------------

    @GetMapping("/availability/grid")
    public MapService.Grid grid(Actor actor, @RequestParam(required = false) String from, @RequestParam(required = false) Integer days) {
        return map.grid(access.context(actor), from, days);
    }

    @PostMapping("/availability/check")
    public MapService.CheckResult check(Actor actor, @RequestBody MapService.CheckInput in) {
        return map.check(access.context(actor), in);
    }
}
