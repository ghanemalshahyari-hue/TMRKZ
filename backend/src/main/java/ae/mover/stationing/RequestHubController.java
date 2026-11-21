package ae.mover.stationing;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.common.ApiException;
import ae.mover.security.Actor;

/** «طلب جديد», the operational posture, a site's occupants and the scoped counts of the home page (ADR-045). */
@RestController
@RequestMapping("/api/v1")
public class RequestHubController {

    private final AccessService access;
    private final RequestHubService hub;
    private final OperationalPostureReadModel posture;
    private final Clock clock;

    public RequestHubController(AccessService access, RequestHubService hub, OperationalPostureReadModel posture, Clock clock) {
        this.access = access;
        this.hub = hub;
        this.posture = posture;
        this.clock = clock;
    }

    @GetMapping("/request-hub")
    public Map<String, Object> hub(Actor actor) {
        return hub.hub(access.context(actor), clock.instant());
    }

    @GetMapping("/request-hub/units/{id}")
    public Map<String, Object> unit(Actor actor, @PathVariable UUID id) {
        return hub.unit(access.context(actor), id, clock.instant());
    }

    @GetMapping("/request-hub/overview")
    public List<Map<String, Object>> overview(Actor actor, @RequestParam(required = false) String filter) {
        return hub.overview(access.context(actor), filter);
    }

    @GetMapping("/request-hub/home-cards")
    public List<Map<String, Object>> homeCards(Actor actor) {
        return hub.homeCards(access.context(actor), clock.instant());
    }

    @GetMapping("/sites/{id}/occupants")
    public Map<String, Object> occupants(Actor actor, @PathVariable UUID id) {
        return hub.occupants(access.context(actor), id, clock.instant());
    }

    /**
     * «متابعة الموقف العملياتي» (ADR-094 Gate 2 §A-§C). The 304 Not Modified short-circuit is the whole point of
     * the ETag, so the ordering is strict:
     *
     * <ol>
     *   <li>Authenticate the session (handled by the security filter chain upstream).</li>
     *   <li>Verify the {@code VIEW_OPERATIONAL_POSTURE} permission on the actor's current context — reach is
     *       re-derived on every request so a revoked right hits 403 here on the next request.</li>
     *   <li>Compute the user-scoped data revision — a single indexed query over {@code authz_change} and three
     *       {@code max(updated_at)} probes, independent of unit count. See
     *       {@link OperationalPostureReadModel#dataRevisionFor}.</li>
     *   <li>If {@code If-None-Match} matches the current ETag, return 304 immediately. The expensive read model
     *       (unit-state bulk CTE, site references, deployment-area geometry, pending-request scope scan, JSON
     *       serialization) is NOT invoked on this path.</li>
     *   <li>Otherwise, delegate to the read model and return the body with the same ETag.</li>
     * </ol>
     *
     * <p>Default shape (§C): compact Site-Hub summary — {@code siteHubs} with per-site aggregates, a one-line
     * {@code summary}, {@code noStationingSummary}, {@code unitsTotal}, {@code sitesTotal}, {@code dataRevision}.
     * No per-unit records, no PRIMARY/SUB geometry, no proposal geometry. Those come from the lazy endpoints:
     * {@code /operational-posture/sites/{id}}, {@code /operational-posture/units/{id}},
     * {@code /operational-posture/requests/{id}}. Legacy per-unit shape is still available via {@code ?view=UNITS}
     * while the PosturePage frontend migrates.
     *
     * <p>{@code Cache-Control: private, no-cache, must-revalidate} because the body is scoped to this person's
     * reach — never shared or served stale (brief §B). The access axis of the revision token moves the ETag the
     * instant a grant/membership/delegation changes, so the browser's cached copy misses on the very next request
     * even when the underlying posture tables have not moved (brief §T, next-request revocation).
     */
    @GetMapping("/operational-posture")
    public ResponseEntity<Map<String, Object>> posture(Actor actor,
                                                       @RequestParam(value = "view", required = false) String view,
                                                       @RequestHeader(value = HttpHeaders.IF_NONE_MATCH, required = false) String ifNoneMatch) {
        AccessContext ctx = access.context(actor);
        if (!ctx.has(Permission.VIEW_OPERATIONAL_POSTURE)) {
            throw ApiException.forbidden("يحتاج صلاحية «متابعة الموقف العملياتي».");
        }
        String etag = "W/\"" + posture.dataRevisionFor(ctx.personId()) + "\"";
        CacheControl cache = CacheControl.noCache().mustRevalidate().cachePrivate();
        if (ifNoneMatch != null && ifNoneMatch.equals(etag)) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).cacheControl(cache).build();
        }
        Map<String, Object> body = "UNITS".equalsIgnoreCase(view)
                ? hub.posture(ctx, clock.instant())            // legacy per-unit shape (phased out by PosturePage migration)
                : hub.postureOverview(ctx, clock.instant());   // Site-Hub summary (brief §C default)
        return ResponseEntity.ok().eTag(etag).cacheControl(cache).body(body);
    }

    /**
     * Site detail (§D): the authorised units at one site plus their compact posture status plus the pending
     * requests visible at that site. Called when the operator drills into one site hub in the UI.
     */
    @GetMapping("/operational-posture/sites/{id}")
    public Map<String, Object> postureSite(Actor actor, @PathVariable UUID id) {
        AccessContext ctx = access.context(actor);
        if (!ctx.has(Permission.VIEW_OPERATIONAL_POSTURE)) {
            throw ApiException.forbidden("يحتاج صلاحية «متابعة الموقف العملياتي».");
        }
        Map<String, Object> body = hub.postureSite(ctx, id, clock.instant());
        if (body == null) {
            throw ApiException.notFound();
        }
        return body;
    }

    /**
     * Unit detail (§E): one unit's full posture — site geometry, PRIMARY/ALTERNATIVE deployment areas, kind,
     * plannedEnd, current open request. Called when the operator selects one unit.
     */
    @GetMapping("/operational-posture/units/{id}")
    public Map<String, Object> postureUnit(Actor actor, @PathVariable UUID id) {
        AccessContext ctx = access.context(actor);
        if (!ctx.has(Permission.VIEW_OPERATIONAL_POSTURE)) {
            throw ApiException.forbidden("يحتاج صلاحية «متابعة الموقف العملياتي».");
        }
        // reach check: the unit must be visible to this person's VIEW_OPERATIONAL_POSTURE right.
        if (!ctx.canFor(Permission.VIEW_OPERATIONAL_POSTURE, id)) {
            throw ApiException.notFound();
        }
        return hub.postureUnit(ctx, id, clock.instant());
    }

    /**
     * Request geometry (§F): one pending request's proposal geometry. Called only when the operator selects a
     * pending indicator in the UI — the overview deliberately omits proposal geometry.
     */
    @GetMapping("/operational-posture/requests/{id}")
    public Map<String, Object> postureRequest(Actor actor, @PathVariable UUID id) {
        AccessContext ctx = access.context(actor);
        if (!ctx.has(Permission.VIEW_OPERATIONAL_POSTURE)) {
            throw ApiException.forbidden("يحتاج صلاحية «متابعة الموقف العملياتي».");
        }
        Map<String, Object> body = hub.postureRequest(ctx, id);
        if (body == null) {
            throw ApiException.notFound();
        }
        return body;
    }
}
