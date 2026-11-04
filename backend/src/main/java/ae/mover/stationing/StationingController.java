package ae.mover.stationing;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;
import ae.mover.security.Actor;

/**
 * Stationing V3 foundation API (ADR-031): the versioned policy, terrain assessment of a deployment polygon, the read
 * contract for authoritative stationing and site links, data corrections, links, and the outbound event outbox. Every
 * operation is authorised on the server ({@link ae.mover.access.AccessContext}, confirmed by OpenFGA).
 */
@RestController
@RequestMapping("/api/v1")
public class StationingController {

    private static final Permission[] POLICY_READERS = {Permission.VIEW, Permission.VIEW_SUMMARY, Permission.CREATE,
            Permission.REVIEW, Permission.APPROVE, Permission.CONFIGURE};

    private final AccessService access;
    private final StationingPolicyStore policies;
    private final StationingRegister register;
    private final StationingOutbox outbox;
    private final TerrainClassifier terrain;
    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;

    public StationingController(AccessService access, StationingPolicyStore policies, StationingRegister register,
                                StationingOutbox outbox, TerrainClassifier terrain, JdbcClient jdbc, Json json, Clock clock) {
        this.access = access;
        this.policies = policies;
        this.register = register;
        this.outbox = outbox;
        this.terrain = terrain;
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
    }

    // ---- policy --------------------------------------------------------------------------------------

    public record PolicyOverview(StationingPolicyStore.PolicyVersion inForce, List<StationingPolicyStore.PolicyVersion> scheduled,
                                 List<StationingPolicy.SlopeClass> initialSlopeClasses) {
    }

    /** The version in force, versions published to take effect later, and the owner-approved initial slope classes. */
    @GetMapping("/stationing/policy")
    public PolicyOverview policy(Actor actor) {
        access.context(actor).requireAny(POLICY_READERS);
        Instant now = clock.instant();
        return new PolicyOverview(policies.inForce(now).orElse(null),
                policies.scheduled(now),
                StationingPolicyDefaults.FAO_SLOPE_CLASSES);
    }

    public record VersionView(StationingPolicyStore.PolicyVersion version, List<StationingPolicyStore.Change> changes) {
    }

    @GetMapping("/stationing/policy/versions")
    public List<VersionView> policyVersions(Actor actor) {
        access.context(actor).requireAny(POLICY_READERS);
        return policies.history().stream().map(v -> new VersionView(v, policies.changes(v))).toList();
    }

    @PostMapping("/stationing/policy/versions")
    public VersionView publishPolicy(Actor actor, @RequestBody StationingPolicyStore.PublishInput in) {
        var v = policies.publish(access.context(actor), in, clock.instant());
        return new VersionView(v, policies.changes(v));
    }

    // ---- terrain -------------------------------------------------------------------------------------

    public record AssessInput(Map<String, Object> geometry, Integer policyVersion) {
    }

    /** Terrain class shares, controlling class, allowance and effective ranges of a polygon under a policy version. */
    @PostMapping("/stationing/terrain/assess")
    public TerrainClassifier.TerrainAssessment assess(Actor actor, @RequestBody AssessInput in) {
        access.context(actor).requireAny(POLICY_READERS);
        if (in == null || in.geometry() == null) {
            throw ApiException.validation("أرسل هندسة منطقة الانتشار.");
        }
        var v = in.policyVersion() == null ? policies.inForce(clock.instant())
                .orElseThrow(() -> ApiException.validation("لا سياسة تمركز سارية بعد."))
                : policies.byVersion(in.policyVersion()).orElseThrow(ApiException::notFound);
        return terrain.assess(json.write(in.geometry()), v.values(), v.version());
    }

    public record DatasetView(UUID id, String code, String version, String surfaceModel, String encoding, Instant loadedAt,
                              Map<String, Object> manifest) {
    }

    @GetMapping("/terrain/datasets")
    public List<DatasetView> datasets(Actor actor) {
        access.context(actor).requireAny(POLICY_READERS);
        return jdbc.sql("""
                select id, code, version, surface_model, slope_encoding, loaded_at, manifest::text as manifest
                  from terrain_dataset order by loaded_at desc""")
                .query((rs, n) -> new DatasetView(Db.uuid(rs, "id"), rs.getString("code"), rs.getString("version"),
                        rs.getString("surface_model"), rs.getString("slope_encoding"), Db.instant(rs, "loaded_at"),
                        summary(json.map(rs.getString("manifest")))))
                .list();
    }

    /** The provenance part of a dataset manifest (no per-file lists). */
    private static Map<String, Object> summary(Map<String, Object> manifest) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (String k : List.of("source", "product", "surfaceModel", "resolution", "licence", "license", "attribution",
                "processingVersion", "limitation")) {
            if (manifest.containsKey(k)) {
                m.put(k, manifest.get(k));
            }
        }
        return m;
    }

    // ---- read contract -------------------------------------------------------------------------------

    @GetMapping("/stationing/current")
    public List<StationingRegister.StationingRecord> current(Actor actor, @RequestParam(required = false) UUID orgId,
                                                             @RequestParam(required = false) UUID siteId) {
        return register.current(access.context(actor), orgId, siteId, clock.instant());
    }

    @GetMapping("/stationing/organizations/{orgId}/history")
    public List<StationingRegister.StationingRecord> history(Actor actor, @PathVariable UUID orgId) {
        return register.history(access.context(actor), orgId);
    }

    @GetMapping("/site-links")
    public List<StationingRegister.SiteLinkRecord> links(Actor actor, @RequestParam(required = false) UUID siteId,
                                                         @RequestParam(required = false) UUID orgId,
                                                         @RequestParam(defaultValue = "false") boolean includeEnded) {
        return register.links(access.context(actor), siteId, orgId, includeEnded);
    }

    // ---- authoritative changes -----------------------------------------------------------------------

    @PostMapping("/stationing/corrections")
    public StationingRegister.StationingRecord correct(Actor actor, @RequestBody StationingRegister.CorrectionInput in) {
        return register.correct(access.context(actor), in, clock.instant());
    }

    @PostMapping("/site-links")
    public StationingRegister.SiteLinkRecord link(Actor actor, @RequestBody StationingRegister.LinkInput in) {
        return register.link(access.context(actor), in, clock.instant());
    }

    @PostMapping("/site-links/{id}/end")
    public StationingRegister.SiteLinkRecord endLink(Actor actor, @PathVariable UUID id, @RequestBody StationingRegister.EndInput in) {
        return register.endLink(access.context(actor), id, in, clock.instant());
    }

    // ---- outbound events (operators) -----------------------------------------------------------------

    @GetMapping("/stationing/outbox")
    public List<StationingOutbox.OutboxRow> outbox(Actor actor, @RequestParam(required = false) String state,
                                                   @RequestParam(defaultValue = "100") int limit) {
        return outbox.list(access.context(actor), state, Math.max(1, Math.min(limit, 500)));
    }

    public record ReplayInput(String reason) {
    }

    @PostMapping("/stationing/outbox/{eventId}/replay")
    public StationingOutbox.OutboxRow replay(Actor actor, @PathVariable UUID eventId, @RequestBody ReplayInput in) {
        return outbox.replay(access.context(actor), eventId, in == null ? null : in.reason(), clock.instant());
    }
}
