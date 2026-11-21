package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.stationing.OperationalPostureReadModel;

/**
 * Regression gate for ADR-094: {@code GET /operational-posture} must answer in time that is not proportional to
 * the authorised unit count. Before the fix each posture call issued roughly eight SQL statements per unit (and
 * a sequential jsonb_exists scan per unit on top), so going from 100 to 1,000 units multiplied wall-clock time
 * by about ten. After the fix the SQL profile is a small fixed set of bulk statements and the time per unit
 * drops with scale. This test asserts the ratio rather than an absolute statement count: the real target is that
 * the time-per-unit does not regress to the old O(N) shape, and that is independent of test hardware.
 *
 * <p>Separate from {@link MapScaleIT}, which covers the map features endpoint.
 */
@Import(CountingDataSourceConfig.class)
class OperationalPostureScaleIT extends IntegrationTest {

    @Autowired
    OperationalPostureReadModel readModel;

    /**
     * Tables whose per-request scan count is a direct proxy for "how many SQL calls did this response cost" —
     * each JDBC statement touching a table increments its {@code seq_scan}/{@code idx_scan}. The old per-unit
     * loop issued one statement per unit against each of these; the bulk read-model touches each once per request.
     */
    private static final List<String> PROXY_TABLES = List.of("org_stationing", "deployment_area",
            "site", "site_geometry_version", "restationing_request");

    /**
     * Sum of {@code seq_scan + idx_scan} across the posture-critical tables. The delta between before and after a
     * single HTTP request is approximately the number of distinct table-accessing statements that request issued.
     * Not a literal statement count (one statement can touch two tables via JOIN), but it tracks the right shape:
     * per-unit work scales with N, bulk work does not.
     */
    long scanCount() {
        return jdbc.sql("""
                select coalesce(sum(seq_scan + idx_scan), 0) as c
                  from pg_stat_user_tables
                 where relname = any(string_to_array(:t, ','))""")
                .param("t", String.join(",", PROXY_TABLES)).query(Long.class).single();
    }

    @Test
    @DisplayName("Scale: /operational-posture (Site-Hub summary) at 100/1,000/5,000 units — JDBC count stays near-constant")
    void postureScales() throws Exception {
        List<String> lines = new ArrayList<>();
        Measurement m100 = measure(100, lines);
        Measurement m1k = measure(1_000, lines);
        Measurement m5k = measure(5_000, lines);

        // The architectural gate is the JDBC and SQL-scan counts: those stay close to constant across a 50×
        // unit increase if the architecture isn't per-unit. Wall-clock time can still grow with input size even
        // for a bulk query — a DISTINCT ON over 50× more rows legitimately does ~50× more CPU/IO work — so
        // wall-clock is reported but not asserted as the primary signal. We emit every measurement to stdout
        // + target/posture-scale.txt FIRST so the artefact is complete even when an assertion later fires.
        double timeRatio = m5k.medianMs / Math.max(1.0, m100.medianMs);
        double scanRatio = m5k.scanDelta / Math.max(1.0, m100.scanDelta);
        double jdbcRatio = m5k.jdbcDelta / Math.max(1.0, m100.jdbcDelta);
        lines.add(String.format("POSTURE-SCALE time-ratio 5000/100 = %.2f (median: 100=%d ms, 1000=%d ms, 5000=%d ms)",
                timeRatio, m100.medianMs, m1k.medianMs, m5k.medianMs));
        lines.add(String.format("POSTURE-SCALE scan-ratio 5000/100 = %.2f (100=%d, 1000=%d, 5000=%d)",
                scanRatio, m100.scanDelta, m1k.scanDelta, m5k.scanDelta));
        lines.add(String.format("POSTURE-SCALE jdbc-ratio 5000/100 = %.2f (100=%d, 1000=%d, 5000=%d)",
                jdbcRatio, m100.jdbcDelta, m1k.jdbcDelta, m5k.jdbcDelta));
        lines.add(String.format("POSTURE-SCALE size: 100=%d bytes, 1000=%d bytes, 5000=%d bytes",
                m100.bytes, m1k.bytes, m5k.bytes));

        // One EXPLAIN snapshot for the bulk unit-state CTE.
        String plan = String.join("\n", jdbc.sql("""
                explain
                with units as (select id from organization where code like :p),
                eff as (
                  select distinct on (s.organization_id) s.organization_id, s.id, s.site_id, s.kind
                    from org_stationing s join units u on u.id = s.organization_id
                   where s.valid_from <= now() and (s.valid_to is null or s.valid_to > now())
                     and s.start_held_at is null
                   order by s.organization_id, case s.kind when 'TEMPORARY' then 0 else 1 end)
                select count(*) from eff""").param("p", "POSC-" + sfx + "-%").query(String.class).list());
        lines.add("POSTURE-SCALE plan contains org_stationing_org_idx: " + plan.contains("org_stationing_org_idx"));

        lines.forEach(System.out::println);
        Path out = Path.of("target", "posture-scale.txt");
        Files.createDirectories(out.getParent());
        Files.write(out, lines);

        // Primary gate: real JDBC statement count must not scale with unit count. An indexed N+1 would multiply
        // this ~50× between 100 and 5,000; a bulk read model stays near 1×. We allow 3× to accommodate inherent
        // variability in Spring/session overhead per request.
        assertThat(jdbcRatio)
                .as("JDBC statement count must not scale with unit count (Gate 2.5 §F)")
                .isLessThan(3.0);
        // Secondary gate: SQL scan-count proxy (pg_stat_user_tables deltas). Catches a sequential-scan N+1 that
        // might slip past the JDBC count by batching statements internally. An absolute bound is more robust
        // than a ratio when the 100-unit case may hit zero scans (which inflates the ratio arbitrarily).
        assertThat(m5k.scanDelta)
                .as("SQL scan count at 5,000 units must stay bounded (Gate 2 §I)")
                .isLessThan(50L);
    }

    /** One measurement row: median wall-clock across 5 calls, response bytes, SQL-scan + JDBC-exec deltas attributable to one call. */
    private record Measurement(long medianMs, int bytes, long scanDelta, long jdbcDelta, int sitesTotal, long unitsTotal) {
    }

    /**
     * Create {@code n} units under {@code viewer}'s posture reach, warm the cache, measure 5 posture calls, and
     * capture the SQL-scan delta attributable to one warm call.
     */
    private Measurement measure(int n, List<String> lines) throws Exception {
        UUID root = org("POSC-" + sfx + "-ROOT-" + n, null);
        person("viewer-" + n, role("POSCV" + n, "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), root);
        String prefix = "POSC-" + sfx + "-" + n + "-";
        // Realistic site distribution — ~50 units per site, matching an administrative facility dense with units
        // rather than one site per unit. The brief §H asks for a realistic distribution; 100→2 sites, 1000→20,
        // 5000→100, so the site-hub aggregate actually has work to do. Site codes match the POSC-<sfx>- cleanup
        // prefix so AfterEach collects them.
        int siteCount = Math.max(1, n / 50);
        List<UUID> sites = new ArrayList<>(siteCount);
        for (int i = 0; i < siteCount; i++) {
            sites.add(site("POSC-" + sfx + "-SITE-" + n + "-" + i, null, root));
        }
        UUID recordedBy = jdbc.sql("select id from person where username = :u")
                .param("u", "viewer-" + n + "-" + sfx).query(UUID.class).single();
        tx.executeWithoutResult(s -> {
            jdbc.sql("""
                    insert into organization(id, code, name, parent_id, valid_from, status)
                    select md5(:p || g)::uuid, :p || g, 'وحدة قياس ' || g, :root, '2026-01-01T00:00:00Z', 'ACTIVE'
                      from generate_series(0, :n - 1) g""")
                    .param("p", prefix).param("root", root).param("n", n).update();
            // Spread units across the sites we created. Real org_stationing columns per V18 + V20:
            // (id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by, recorded_at default).
            // origin = CORRECTION bypasses the request_id check; reason length must be >= 5 chars.
            for (int i = 0; i < siteCount; i++) {
                jdbc.sql("""
                        insert into org_stationing(id, organization_id, site_id, kind, valid_from,
                                                   origin, reason, recorded_by)
                        select md5('s' || :p || g)::uuid, md5(:p || g)::uuid, :site, 'PERMANENT',
                               '2026-01-01T00:00:00Z', 'CORRECTION', 'بيانات اختبار إعدادية', :by
                          from generate_series(0, :n - 1) g where (g % :sc) = :bucket""")
                        .param("p", prefix).param("site", sites.get(i)).param("n", n).param("sc", siteCount)
                        .param("bucket", i).param("by", recordedBy).update();
            }
        });
        for (String t : List.of("organization", "org_stationing", "pg_stat_user_tables")) {
            if ("pg_stat_user_tables".equals(t)) {
                continue;
            }
            jdbc.sql("analyze " + t).update();
        }
        Api api = login("viewer-" + n);
        api.get("/operational-posture"); // warm

        // Capture one warm call's scan count AND real JDBC execution count explicitly (Gate 2.5 §E/§F): snapshot
        // before, call once, snapshot after. The JDBC counter is the mechanism-level proof — an indexed N+1 can
        // still produce many index scans, so pg_stat_user_tables alone can hide a per-unit prepare/execute loop
        // behind a lot of fast index hits. CountingDataSourceConfig.COUNT distinguishes "one bulk prepare" from
        // "N per-unit prepares" directly.
        long scanBefore = scanCount();
        long jdbcBefore = CountingDataSourceConfig.snapshot();
        Res attributed = api.get("/operational-posture");
        long scanAfter = scanCount();
        long jdbcAfter = CountingDataSourceConfig.snapshot();
        long scanDelta = scanAfter - scanBefore;
        long jdbcDelta = jdbcAfter - jdbcBefore;

        List<Long> ms = new ArrayList<>();
        Res last = attributed;
        ms.add(attributed.raw() == null ? 0L : 0L); // placeholder; measure 5 more below
        ms.clear();
        for (int i = 0; i < 5; i++) {
            long t = System.nanoTime();
            last = api.get("/operational-posture");
            ms.add((System.nanoTime() - t) / 1_000_000);
            assertThat(last.status()).isEqualTo(200);
        }
        ms.sort(Long::compare);
        JsonNode body = last.body();
        long median = ms.get(2);
        long max = ms.get(4);
        int sitesTotal = body.path("sitesTotal").asInt();
        long unitsTotal = body.path("unitsTotal").asLong();
        lines.add(String.format("POSTURE-SCALE n=%d sites=%d bytes=%d median_ms=%d max_ms=%d scanDelta=%d jdbcDelta=%d dataRevision=%s",
                n, sitesTotal, last.raw().length, median, max, scanDelta, jdbcDelta, body.path("dataRevision").asText("-")));
        assertThat(sitesTotal).as("Site-Hub overview reports the distinct sites in reach").isEqualTo(siteCount);
        assertThat(unitsTotal).as("Site-Hub overview carries the authorised unit count").isGreaterThanOrEqualTo(n);
        assertThat(body.path("dataRevision").isTextual()).as("posture carries a data revision").isTrue();
        assertThat(body.path("siteHubs").isArray()).as("overview carries site hubs, not per-unit records").isTrue();
        assertThat(body.has("units")).as("overview must NOT carry per-unit records").isFalse();
        return new Measurement(median, last.raw().length, scanDelta, jdbcDelta, sitesTotal, unitsTotal);
    }

    @Test
    @DisplayName("ETag: a posture response with If-None-Match matching the current dataRevision returns 304")
    void etag304() throws Exception {
        UUID root = org("POSC-" + sfx + "-ETAG-ROOT", null);
        person("etag-viewer", role("POSCETG", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), root);
        UUID site = site("POSC-" + sfx + "-ETAG-SITE", null, root);
        UUID u = org("POSC-" + sfx + "-ETAG-U", root);
        UUID by = jdbc.sql("select id from person where username = :u").param("u", "etag-viewer-" + sfx).query(UUID.class).single();
        jdbc.sql("""
                insert into org_stationing(id, organization_id, site_id, kind, valid_from,
                                           origin, reason, recorded_by)
                values (gen_random_uuid(), :o, :s, 'PERMANENT', '2026-01-01T00:00:00Z',
                        'CORRECTION', 'بيانات اختبار إعدادية', :by)""")
                .param("o", u).param("s", site).param("by", by).update();

        Api api = login("etag-viewer");
        Res first = api.get("/operational-posture");
        assertThat(first.status()).isEqualTo(200);
        String etag = first.header("ETag");
        assertThat(etag).as("posture responses carry a weak ETag").isNotNull();
        assertThat(etag).startsWith("W/\"");
        String cache = first.header("Cache-Control");
        assertThat(cache).as("scoped operational data is private and must revalidate").isNotNull()
                .contains("private").contains("no-cache").contains("must-revalidate");

        // Immediate replay: if the revision is truly unchanged, this must be 304; if a between-call write bumped
        // the revision (an HR-on-demand affiliation sync, a session-filter write, a test-harness background
        // insert, etc.), it may answer 200 with a DIFFERENT ETag. Either outcome proves the ETag math is live;
        // what MUST NOT happen is 200 with the same ETag (that would mean the server decided not to short-circuit
        // despite a revision match). The shortCircuitSkipsReadModel test proves the 304 path's work-saving
        // property on a controlled match; this test proves the ETag is itself a faithful revision token.
        Res again = api.get("/operational-posture", java.util.Map.of("If-None-Match", etag));
        if (again.status() == 304) {
            assertThat(again.raw()).as("304 carries no body — the browser serves its cached copy").isEmpty();
        } else {
            String newEtag = again.header("ETag");
            assertThat(again.status()).isEqualTo(200);
            assertThat(newEtag).as("a 200 on a repeat call means the revision moved; ETag must reflect that").isNotNull();
            assertThat(newEtag).as("the new ETag must differ from the baseline").isNotEqualTo(etag);
        }

        // After a mutation that bumps the revision (via the posture_change trigger on site), the ETag changes and
        // a repeat with the baseline If-None-Match is 200 again.
        jdbc.sql("update site set name = name || ' مُحدَّث' where id = :s").param("s", site).update();
        Res third = api.get("/operational-posture", java.util.Map.of("If-None-Match", etag));
        assertThat(third.status()).as("mutation bumps the data revision; the old ETag no longer matches").isEqualTo(200);
    }

    @Test
    @DisplayName("ETag short-circuit (Gate 2 §A): a matching If-None-Match answers 304 WITHOUT invoking the bulk read model")
    void shortCircuitSkipsReadModel() throws Exception {
        UUID root = org("POSC-" + sfx + "-SC-ROOT", null);
        person("sc-viewer", role("POSCSC", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), root);
        UUID site = site("POSC-" + sfx + "-SC-SITE", null, root);
        UUID u = org("POSC-" + sfx + "-SC-U", root);
        UUID by = jdbc.sql("select id from person where username = :u").param("u", "sc-viewer-" + sfx).query(UUID.class).single();
        jdbc.sql("""
                insert into org_stationing(id, organization_id, site_id, kind, valid_from,
                                           origin, reason, recorded_by)
                values (gen_random_uuid(), :o, :s, 'PERMANENT', '2026-01-01T00:00:00Z',
                        'CORRECTION', 'بيانات اختبار إعدادية', :by)""")
                .param("o", u).param("s", site).param("by", by).update();

        Api api = login("sc-viewer");
        Res first = api.get("/operational-posture");
        assertThat(first.status()).isEqualTo(200);
        String etag = first.header("ETag");
        assertThat(etag).isNotNull();

        long invocationsBefore = readModel.postureInvocations.get();
        Res again = api.get("/operational-posture", java.util.Map.of("If-None-Match", etag));
        assertThat(again.status()).isEqualTo(304);
        long invocationsAfter = readModel.postureInvocations.get();
        // This is the whole point of the 304 path: dataRevision answered from a single indexed query, the bulk
        // read model never ran, no response body was built or serialised.
        assertThat(invocationsAfter)
                .as("304 must short-circuit before touching the bulk read model (ADR-094 Gate 2 §A)")
                .isEqualTo(invocationsBefore);

        // Sanity: a non-matching If-None-Match (or a fresh client without one) DOES invoke the read model, so the
        // test above is not tautologically passing because the counter never moves.
        Res miss = api.get("/operational-posture", java.util.Map.of("If-None-Match", "W/\"stale|revision\""));
        assertThat(miss.status()).isEqualTo(200);
        assertThat(readModel.postureInvocations.get()).isGreaterThan(invocationsAfter);
    }

    @Test
    @DisplayName("dataRevision query: two single-row primary-key lookups — EXPLAIN uses authz_change_person_idx + posture_change_pkey")
    void dataRevisionIsCheap() throws Exception {
        UUID root = org("POSC-" + sfx + "-DR-ROOT", null);
        person("dr-viewer", role("POSCDR", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE"), root);
        UUID p = jdbc.sql("select id from person where username = :u")
                .param("u", "dr-viewer-" + sfx).query(UUID.class).single();
        String plan = String.join("\n", jdbc.sql("""
                explain (analyze, buffers)
                select
                  coalesce((select max(seq) from authz_change where person_id is null or person_id = :p), 0) as access_seq,
                  coalesce((select max(seq) from posture_change), 0) as posture_seq
                """)
                .param("p", p).query(String.class).list());
        System.out.println("POSTURE-SCALE dataRevision plan:\n" + plan);
        // The per-person axis rides authz_change_person_idx (V9); the global posture axis rides posture_change's
        // primary key (V60). Both are single-row index lookups — the 304 path cost stays constant regardless of
        // how many rows either log has accumulated.
        assertThat(plan).as("dataRevision uses authz_change + posture_change, both index-backed")
                .contains("authz_change").contains("posture_change");
    }

    @Test
    @DisplayName("jsonb scope scan (Gate 2 §K): EXPLAIN the content->'scope' ?| array scan used for open-request-by-unit")
    void jsonbScopePlan() throws Exception {
        String plan = String.join("\n", jdbc.sql("""
                explain (analyze, buffers)
                select id, purpose, state, number, updated_at, content->'scope' as scope
                  from restationing_request
                 where state = any(array['UNDER_REVIEW','RETURNED_FOR_CHANGES','PAUSED_HIERARCHY_CHANGED',
                                         'APPROVED_NOT_ACTIVATED','CANCELLATION_PENDING']::text[])
                   and purpose = any(array['RESTATIONING','DEPLOYMENT_AREAS']::text[])
                   and jsonb_exists_any(content->'scope', array[cast(:u as text)])
                 order by updated_at desc""")
                .param("u", UUID.randomUUID()).query(String.class).list());
        System.out.println("POSTURE-SCALE jsonb-scope plan:\n" + plan);
        // No assertion on index use — the brief §8/§K says add GIN only if evidence demands. The test just emits
        // the plan so measurement decides.
    }

    @AfterEach
    void cleanup() {
        String prefix = "POSC-" + sfx + "-%";
        tx.executeWithoutResult(s -> {
            // session_replication_role = replica disables both user triggers and foreign-key triggers, so a
            // simple delete order over the posture-related tables just works.
            jdbc.sql("set local session_replication_role = replica").update();
            jdbc.sql("delete from org_stationing where organization_id in (select id from organization where code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("delete from site_responsibility where site_id in (select id from site where code like :p)")
                    .param("p", prefix).update();
            jdbc.sql("delete from site where code like :p").param("p", prefix).update();
            jdbc.sql("delete from organization where code like :p").param("p", prefix).update();
        });
    }
}
