package ae.mover.facilities;

import java.util.List;
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

import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.security.Actor;

@RestController
@RequestMapping("/api/v1")
public class FacilityController {

    private final AccessService access;
    private final SiteService sites;
    private final MapService map;

    public FacilityController(AccessService access, SiteService sites, MapService map) {
        this.access = access;
        this.sites = sites;
        this.map = map;
    }

    @GetMapping("/sites")
    public List<SiteService.SiteView> sites(Actor actor) {
        var ctx = access.context(actor);
        ctx.requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.MANAGE_FACILITIES);
        return sites.list(ctx);
    }

    @GetMapping("/sites/{id}")
    public java.util.Map<String, Object> site(Actor actor, @PathVariable UUID id) {
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

    @GetMapping("/map/packages")
    public List<MapService.MapPackage> packages(Actor actor) {
        return map.packages(access.context(actor));
    }

    @GetMapping("/map/packages/{id}/content")
    public ResponseEntity<byte[]> packageContent(Actor actor, @PathVariable UUID id) {
        MapService.PackageContent c = map.content(access.context(actor), id);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(c.contentType()))
                .cacheControl(CacheControl.noCache().cachePrivate())
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline().filename(c.fileName()).build().toString())
                .body(c.bytes());
    }

    @GetMapping("/map/features")
    public MapService.MapFeatures features(Actor actor, @RequestParam(required = false) String bbox,
                                           @RequestParam(required = false) String time) {
        return map.features(access.context(actor), bbox, time);
    }

    @GetMapping("/availability/grid")
    public MapService.Grid grid(Actor actor, @RequestParam(required = false) String from, @RequestParam(required = false) Integer days) {
        return map.grid(access.context(actor), from, days);
    }

    @PostMapping("/availability/check")
    public MapService.CheckResult check(Actor actor, @RequestBody MapService.CheckInput in) {
        return map.check(access.context(actor), in);
    }
}
