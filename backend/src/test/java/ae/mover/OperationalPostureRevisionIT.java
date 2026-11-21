package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * ADR-094 Gate 2.5 §A-§B — the posture ETag must move on every mutation that can change the Site-Hub response,
 * and only then. Each scenario here starts from a 200 with a known ETag, makes ONE targeted mutation, then
 * replays the same {@code If-None-Match} and asserts the second response is 200 with a different ETag (not 304).
 *
 * <p>These scenarios are the correctness gate for the posture_change stream (V60) + the per-person
 * {@code authz_change} slice. If any of them answers 304 after the mutation, the ETag's coverage is broken and
 * clients will see a stale posture until an unrelated change happens to bump the revision.
 *
 * <p>The baseline (no mutation) 304 case is covered by {@link OperationalPostureScaleIT#etag304} — this file
 * only asserts the positive moves.
 */
class OperationalPostureRevisionIT extends IntegrationTest {

    private UUID root;
    private UUID site;
    private UUID unit;
    private UUID stationing;
    private UUID request;
    private UUID personId;
    private Api api;

    /**
     * Minimal posture fixture:
     * - one root, one site, one stationed unit
     * - one DRAFT restationing_request so deployment_area + pending-request scenarios can reference something
     * - one ACTIVE deployment_area so area UPDATE scenarios exist
     *
     * Business logic is not exercised — the FKs/CHECKs are relaxed just enough to let the posture_change triggers
     * fire on each affected table. {@code session_replication_role=replica} disables user AND foreign-key
     * triggers for the fixture's own writes, so a DRAFT request without a full approval chain is still legal
     * for the purpose of counting posture_change rows.
     */
    /** Counter to keep the per-test role code unique: setup() runs once per @Test method. */
    private static final java.util.concurrent.atomic.AtomicInteger SETUP_COUNTER = new java.util.concurrent.atomic.AtomicInteger();

    private void setup() {
        int n = SETUP_COUNTER.incrementAndGet();
        root = org("POSR-" + sfx + "-ROOT-" + n, null);
        // The posture endpoint is gated by the VIEW_OPERATIONAL_POSTURE permission (see RequestHubController), so
        // the viewer person must hold a role that includes it — mirrors StationingNextIT's `viewer` fixture.
        // Role code includes `n` so repeat setup() calls within one @BeforeEach-free class don't collide on PK.
        String viewerRole = role("POSRPOST" + n, "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE");
        person("rev-viewer-" + n, viewerRole, root);
        personId = jdbc.sql("select id from person where username = :u")
                .param("u", "rev-viewer-" + n + "-" + sfx).query(UUID.class).single();
        site = site("POSR-" + sfx + "-SITE-" + n, null, root);
        unit = org("POSR-" + sfx + "-UNIT-" + n, root);
        stationing = UUID.randomUUID();
        request = UUID.randomUUID();
        tx.executeWithoutResult(s -> {
            jdbc.sql("set local session_replication_role = replica").update();
            jdbc.sql("""
                    insert into org_stationing(id, organization_id, site_id, kind, valid_from,
                                               origin, reason, recorded_by)
                    values (:st, :o, :s, 'PERMANENT', '2026-01-01T00:00:00Z',
                            'CORRECTION', 'بيانات اختبار إعدادية', :by)""")
                    .param("st", stationing).param("o", unit).param("s", site).param("by", personId).update();
            jdbc.sql("""
                    insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind,
                                                     start_at, reason, content, created_at, updated_at)
                    values (:r, 'POSR-' || substr(:r::text, 1, 6), :by, cast(:o as uuid), 'DRAFT', 'PERMANENT',
                            '2026-01-01T00:00:00Z', 'بيانات اختبار',
                            cast('{"scope":["' || :o || '"]}' as jsonb), now(), now())""")
                    .param("r", request).param("by", personId).param("o", unit.toString()).update();
            jdbc.sql("""
                    insert into deployment_area(id, request_id, site_id, role, geom, state, valid_from,
                                                organization_id, stationing_id)
                    values (gen_random_uuid(), :r, :s, 'PRIMARY',
                            ST_SetSRID(ST_MakeEnvelope(55.3, 25.2, 55.31, 25.21, 4326), 4326), 'ACTIVE',
                            now(), :o, :st)""")
                    .param("r", request).param("s", site).param("o", unit).param("st", stationing).update();
        });
        api = login("rev-viewer-" + n);
    }

    /** First call produces a fresh 200 whose ETag is this scenario's baseline. */
    private String baselineEtag() {
        Res r = api.get("/operational-posture");
        assertThat(r.status()).isEqualTo(200);
        String etag = r.header("ETag");
        assertThat(etag).isNotNull();
        return etag;
    }

    /**
     * After {@code mutate.run()}, a replay with the baseline ETag MUST NOT answer 304 — the revision has to move
     * so clients re-fetch. {@code because} names what we expect the stream to catch.
     */
    private void assertEtagMovedBy(String etag, String because, Runnable mutate) {
        mutate.run();
        Res after = api.get("/operational-posture", Map.of("If-None-Match", etag));
        assertThat(after.status())
                .as("revision must bump on: " + because)
                .isEqualTo(200);
        String newEtag = after.header("ETag");
        assertThat(newEtag).as("a new ETag must be issued after " + because).isNotNull();
        assertThat(newEtag).as("the ETag must differ from the one before " + because).isNotEqualTo(etag);
    }

    @Test
    @DisplayName("Revision bumps on a stationing change (org_stationing)")
    void onStationingChange() {
        setup();
        String etag = baselineEtag();
        // UPDATE a nullable column that has no CHECK constraint — `reference` is free text. The trigger fires on
        // any update regardless of what changed.
        assertEtagMovedBy(etag, "org_stationing update (reference set)", () ->
                jdbc.sql("update org_stationing set reference = 'posture-revision-test' where organization_id = :o")
                        .param("o", unit).update());
    }

    @Test
    @DisplayName("Revision bumps on a deployment-area change (PRIMARY / SUB)")
    void onDeploymentAreaChange() {
        setup();
        String etag = baselineEtag();
        // UPDATE the fixture area created in setup. The user-defined posture_change trigger must FIRE here, so
        // we do NOT wrap this in session_replication_role=replica (that disables user triggers too). Plain UPDATE
        // of an existing row satisfies the CHECK ((state='RETIRED') = (valid_to is not null)) when we set both.
        assertEtagMovedBy(etag, "deployment_area update (state RETIRED)", () ->
                jdbc.sql("update deployment_area set state = 'RETIRED', valid_to = now() where request_id = :r")
                        .param("r", request).update());
    }

    @Test
    @DisplayName("Revision bumps on a pending restationing-request change (state/content)")
    void onPendingRequestChange() {
        setup();
        String etag = baselineEtag();
        // Update `reason` on the fixture request: it only has `not null default ''` (no CHECK on content), so any
        // non-null update is legal. The per-statement posture_change trigger fires on any UPDATE regardless of
        // which column moved — we do NOT disable user triggers (the point of the test is to see them fire).
        assertEtagMovedBy(etag, "restationing_request update (reason set)", () ->
                jdbc.sql("update restationing_request set reason = 'revision test', updated_at = now() where id = :r")
                        .param("r", request).update());
    }

    @Test
    @DisplayName("Revision bumps on a site name change (site metadata)")
    void onSiteNameChange() {
        setup();
        String etag = baselineEtag();
        assertEtagMovedBy(etag, "site.name update", () ->
                jdbc.sql("update site set name = name || ' مُحدَّث' where id = :s").param("s", site).update());
    }

    @Test
    @DisplayName("Revision bumps on a new site geometry version (site_geometry_version)")
    void onSiteGeometryChange() {
        setup();
        String etag = baselineEtag();
        assertEtagMovedBy(etag, "site_geometry_version insert (new boundary)", () ->
                jdbc.sql("""
                        insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from,
                            geom, geometry_type, original_format, original_crs, transform, reason)
                        values (gen_random_uuid(), :s, 1,
                                ST_AsGeoJSON(ST_MakeEnvelope(55.3, 25.2, 55.31, 25.21, 4326))::jsonb,
                                'EPSG:4326', 'TEST', now(),
                                ST_SetSRID(ST_MakeEnvelope(55.3, 25.2, 55.31, 25.21, 4326), 4326), 'Polygon',
                                'GEOJSON', 'EPSG:4326', 'none', 'revision test')""")
                        .param("s", site).update());
    }

    @Test
    @DisplayName("Revision bumps on a site marker move (site metadata — lat/lng)")
    void onSiteMarkerMove() {
        setup();
        String etag = baselineEtag();
        assertEtagMovedBy(etag, "site.lat/lng update", () ->
                jdbc.sql("update site set lat = 25.25, lng = 55.35 where id = :s").param("s", site).update());
    }

    @Test
    @DisplayName("Revision bumps on a unit name change (organization.name)")
    void onUnitNameChange() {
        setup();
        String etag = baselineEtag();
        assertEtagMovedBy(etag, "organization.name update", () ->
                jdbc.sql("update organization set name = name || ' مُحدَّث' where id = :o").param("o", unit).update());
    }

    @Test
    @DisplayName("Revision bumps on a hierarchy change (organization.parent_id)")
    void onHierarchyChange() {
        setup();
        UUID sibling = org("POSR-" + sfx + "-SIBLING", root);
        String etag = baselineEtag();
        assertEtagMovedBy(etag, "organization.parent_id change", () ->
                jdbc.sql("update organization set parent_id = :p where id = :o").param("p", sibling).param("o", unit).update());
    }

    @Test
    @DisplayName("Revision bumps on an authorization grant (per-person, authz_change)")
    void onAuthGrant() {
        setup();
        String etag = baselineEtag();
        // Any shared grants-write bumps authz_change(person_id=null), which is covered by the global stream of
        // the per-person query. We write a notional row directly so the test is independent of the access-studio
        // API surface — the point is that authz_change moved. `personId` is populated by setup().
        assertEtagMovedBy(etag, "authz_change row inserted (grant-write pattern)", () ->
                jdbc.sql("insert into authz_change(person_id, source) values (:p, 'test:grant')")
                        .param("p", personId).update());
    }

    @Test
    @DisplayName("Revision bumps on an authorization revoke (per-person, authz_change)")
    void onAuthRevoke() {
        setup();
        String etag = baselineEtag();
        assertEtagMovedBy(etag, "authz_change row inserted (revoke pattern)", () ->
                jdbc.sql("insert into authz_change(person_id, source) values (:p, 'test:revoke')")
                        .param("p", personId).update());
    }

    @Test
    @DisplayName("Revision bumps on a global role/policy permission change (role_def.permissions — shared authz_change)")
    void onGlobalAuthPolicyChange() {
        setup();
        String etag = baselineEtag();
        // Any role_def write fires authz_note_shared('grants') which writes authz_change(person_id=null) (V9:142).
        // dataRevisionFor reads that stream through the `person_id is null` branch, so a permission composition
        // change globally invalidates every user's posture ETag on their next request. We touch an existing role
        // row's updated_at — the trigger fires on any update, including a no-op — so the test does not depend on
        // whether a specific permission is granted or revoked, only on the shared-stream mechanism.
        assertEtagMovedBy(etag, "role_def update (global grants-write)", () ->
                jdbc.sql("update role_def set updated_at = now() where code = (select code from role_def order by code limit 1)")
                        .update());
    }

    @Test
    @DisplayName("Control: with NO mutation, the same ETag answers 304 — the moves above aren't coincidence")
    void controlNoMutation() {
        setup();
        String etag = baselineEtag();
        Res again = api.get("/operational-posture", Map.of("If-None-Match", etag));
        assertThat(again.status()).as("without any mutation, the ETag must still match").isEqualTo(304);
    }

    @AfterEach
    void cleanup() {
        String prefix = "POSR-" + sfx + "-%";
        tx.executeWithoutResult(s -> {
            // session_replication_role = replica disables user triggers AND foreign-key triggers, so a cleanup
            // order that would otherwise fail on FK dependencies between restationing_request / deployment_area /
            // org_stationing / site / organization just works.
            jdbc.sql("set local session_replication_role = replica").update();
            jdbc.sql("delete from deployment_area where organization_id in (select id from organization where code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("delete from restationing_request where requesting_unit_id in (select id from organization where code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("delete from org_stationing where organization_id in (select id from organization where code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("update site set geometry_version = null where code like :p").param("p", prefix).update();
            jdbc.sql("delete from site_geometry_version where site_id in (select id from site where code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("delete from site_responsibility where site_id in (select id from site where code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("delete from site where code like :p").param("p", prefix).update();
            jdbc.sql("delete from organization where code like :p").param("p", prefix).update();
        });
    }
}
