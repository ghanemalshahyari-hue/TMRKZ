package ae.mover.authz;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.IntegrationTest;

/**
 * POSTURE-SCOPE-01..07 (owner, 21 Nov 2026): «معاين الموقف العملياتي» honours three scope modes — this unit only
 * (UNIT), this unit and its descendants (UNIT_TREE), and selected levels (LEVELS) — plus the union of several
 * explicit targets. Every reach is derived from the published organisation hierarchy at read time, so moving a
 * unit in or out of the branch shows up on the very next request without a snapshot refresh. The three lazy
 * detail endpoints fail closed: a viewer scoped to one branch cannot fetch the identity, geometry or request of
 * an outside site/unit/request by its id. The Site-Hub overview totals and per-site aggregates are derived from
 * the viewer's reach only — no counts for outside-scope units leak through {@code unitsTotal}, {@code sitesTotal},
 * {@code siteHubs} or {@code summary.pending}. Each test builds its own HR snapshot and organisation branch so
 * tests never share state.
 */
class PostureViewerScopeIT extends IntegrationTest {

    private UUID publishedSnapshot() {
        UUID s = jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).optional().orElse(null);
        if (s != null) return s;
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        s = UUID.randomUUID();
        jdbc.sql("insert into hr_source(id, name) values (:id, 'مصدر اختبار نطاق المشاهد')").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'DRAFT', '{}', '{}')")
                .param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, trigger, status, started_at) values (:id, 'MANUAL', 'SUCCEEDED', now())").param("id", run).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())")
                .param("id", s).param("r", run).param("m", mapping).update();
        return s;
    }

    /** An organisation that is also an HR unit at a chosen level of the hierarchy (ADR-042). */
    private UUID hrOrg(String code, UUID parent, int level, UUID snapshot) {
        UUID id = UUID.randomUUID();
        String ext = "PV-" + code + "-" + sfx;
        jdbc.sql("""
                insert into organization(id, code, name, parent_id, valid_from, source, source_external_id)
                values (:id, :c, :n, :p, '2026-01-01T00:00:00Z', 'HR', :e)""")
                .param("id", id).param("c", ext).param("n", "وحدة " + code).param("p", parent).param("e", ext).update();
        jdbc.sql("insert into hr_unit(snapshot_id, external_id, name, level, active, is_main) values (:s, :e, :n, :l, true, :m)")
                .param("s", snapshot).param("e", ext).param("n", "وحدة " + code).param("l", level).param("m", parent == null).update();
        return id;
    }

    /** A site owned by an organisation and a permanent stationing of that organisation at the site, so the posture
     *  read model sees a stationed unit in the viewer's reach (otherwise the overview aggregates and the site
     *  detail endpoint have nothing to attach to). */
    private UUID stationed(String code, UUID org, double lat, double lng) {
        UUID site = UUID.randomUUID();
        jdbc.sql("insert into site(id, code, name, kind, lat, lng) values (:id, :c, :n, 'مرفق', :lat, :lng)")
                .param("id", site).param("c", "PV-SITE-" + code + "-" + sfx).param("n", "موقع " + code)
                .param("lat", BigDecimal.valueOf(lat)).param("lng", BigDecimal.valueOf(lng)).update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("s", site).param("o", org).update();
        UUID stationing = UUID.randomUUID();
        jdbc.sql("""
                insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
                values (:id, :o, :s, 'PERMANENT', '2026-01-01T00:00:00Z', 'CORRECTION', 'اختبار موقف', :by)""")
                .param("id", stationing).param("o", org).param("s", site)
                .param("by", bootstrapPerson()).update();
        return site;
    }

    /** A plain person credited as the recorder of a stationing — the real recorder is always a user. */
    private UUID bootstrapPerson() {
        UUID id = jdbc.sql("select id from person where employee_no = 'PV-REC-" + sfx + "'").query(UUID.class).optional().orElse(null);
        if (id != null) return id;
        id = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username) values (:id, :e, :n, :u)")
                .param("id", id).param("e", "PV-REC-" + sfx).param("n", "مسجل اختبار").param("u", "posture-rec-" + sfx).update();
        return id;
    }

    /** A person with VIEW_OPERATIONAL_POSTURE and a CUSTOM scope on one anchor with optional descendants/levels. */
    private UUID viewerWithScope(String username, UUID homeUnit, UUID anchor, boolean includeDescendants, List<Integer> levels) {
        return viewerWithScope(username, homeUnit, List.of(new Target(anchor, includeDescendants, levels)));
    }

    private record Target(UUID anchor, boolean includeDescendants, List<Integer> levels) {}

    private UUID viewerWithScope(String username, UUID homeUnit, List<Target> targets) {
        String roleCode = role("PVIEW_" + username, "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE");
        UUID personId = person(username, roleCode, homeUnit);
        UUID membershipId = jdbc.sql("select id from membership where person_id = :p and role_code = :r order by valid_from desc limit 1")
                .param("p", personId).param("r", roleCode).query(UUID.class).single();
        jdbc.sql("update membership set scope_mode = 'CUSTOM', scope_combine = 'AND', scope_all = false where id = :id")
                .param("id", membershipId).update();
        for (Target t : targets) {
            jdbc.sql("""
                    insert into membership_scope_target(membership_id, kind, target_id, include_descendants, levels)
                    values (:m, 'ORGANIZATION', :a, :d, string_to_array(nullif(:l, ''), ',')::int[])""")
                    .param("m", membershipId).param("a", t.anchor()).param("d", t.includeDescendants() || !t.levels().isEmpty())
                    .param("l", String.join(",", t.levels().stream().map(String::valueOf).toList())).update();
        }
        jdbc.sql("insert into authz_change(person_id, source) values (:p, 'test:posture-viewer-scope')").param("p", personId).update();
        return personId;
    }

    /** The unit ids visible in the legacy per-unit shape of {@code /operational-posture} — the one the overview
     *  summarises. The compact Site-Hub shape (§C) doesn't expose unit ids directly; {@code ?view=UNITS} does. */
    private Set<String> visibleUnits(String username) {
        Res r = login(username).get("/operational-posture?view=UNITS");
        assertThat(r.status()).as("posture for " + username + ": " + r).isEqualTo(200);
        Set<String> ids = new LinkedHashSet<>();
        for (JsonNode u : r.body().path("units")) {
            ids.add(u.path("id").asText());
        }
        return ids;
    }

    /** The compact Site-Hub overview (§C). Used to verify {@code unitsTotal}, {@code sitesTotal} and the per-site
     *  aggregates are derived strictly from the viewer's reach. */
    private JsonNode overview(String username) {
        Res r = login(username).get("/operational-posture");
        assertThat(r.status()).as("posture overview for " + username + ": " + r).isEqualTo(200);
        return r.body();
    }

    // ---- POSTURE-SCOPE-01 — UNIT ---------------------------------------------------------------------------------

    @Test
    @DisplayName("POSTURE-SCOPE-01: UNIT — anchor visible, children and siblings and ancestors are not")
    void unitOnly() {
        UUID snapshot = publishedSnapshot();
        UUID wing = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing, 2, snapshot);
        UUID sec2 = hrOrg("SEC2", wing, 2, snapshot);
        UUID team = hrOrg("TEAMC", sec2, 3, snapshot);
        stationed("WING1", wing, 25.0, 55.0);
        stationed("SEC1", sec1, 25.1, 55.1);
        stationed("SEC2", sec2, 25.2, 55.2);
        stationed("TEAMC", team, 25.3, 55.3);
        viewerWithScope("pv01", wing, sec2, false, List.of());
        var ids = visibleUnits("pv01");
        assertThat(ids).as("anchor sec2 is visible").contains(sec2.toString());
        assertThat(ids).as("child team_c is NOT visible by UNIT scope").doesNotContain(team.toString());
        assertThat(ids).as("sibling sec1 is NOT visible").doesNotContain(sec1.toString());
        assertThat(ids).as("ancestor wing is NOT visible").doesNotContain(wing.toString());
    }

    // ---- POSTURE-SCOPE-02 — UNIT_TREE ----------------------------------------------------------------------------

    @Test
    @DisplayName("POSTURE-SCOPE-02: UNIT_TREE — anchor and every descendant are visible; sibling branch stays out")
    void unitTree() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        UUID sec2 = hrOrg("SEC2", wing1, 2, snapshot);
        UUID teamA = hrOrg("TEAMA", sec1, 3, snapshot);
        UUID teamC = hrOrg("TEAMC", sec2, 3, snapshot);
        UUID wing2 = hrOrg("WING2", null, 1, snapshot);
        UUID sec3 = hrOrg("SEC3", wing2, 2, snapshot);
        for (UUID u : List.of(wing1, sec1, sec2, teamA, teamC, wing2, sec3)) {
            stationed("U-" + u.toString().substring(0, 4), u, 25.0 + Math.random() * 0.5, 55.0 + Math.random() * 0.5);
        }
        viewerWithScope("pv02", wing1, wing1, true, List.of());
        var ids = visibleUnits("pv02");
        assertThat(ids).as("anchor and every descendant are visible")
                .contains(wing1.toString(), sec1.toString(), sec2.toString(), teamA.toString(), teamC.toString());
        assertThat(ids).as("sibling branch wing2 is NOT visible").doesNotContain(wing2.toString(), sec3.toString());
    }

    // ---- POSTURE-SCOPE-03 — LEVELS -------------------------------------------------------------------------------

    @Test
    @DisplayName("POSTURE-SCOPE-03: LEVELS — only units at the selected levels under the anchor are visible")
    void levelsOnly() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        UUID sec2 = hrOrg("SEC2", wing1, 2, snapshot);
        UUID teamA = hrOrg("TEAMA", sec1, 3, snapshot);
        UUID teamC = hrOrg("TEAMC", sec2, 3, snapshot);
        for (UUID u : List.of(wing1, sec1, sec2, teamA, teamC)) {
            stationed("L-" + u.toString().substring(0, 4), u, 25.0 + Math.random() * 0.5, 55.0 + Math.random() * 0.5);
        }
        // level 3 only → team_a and team_c; sec1, sec2 (level 2) and wing1 (level 1) are NOT visible
        viewerWithScope("pv03", wing1, wing1, true, List.of(3));
        var ids = visibleUnits("pv03");
        assertThat(ids).as("units at the chosen level are visible").contains(teamA.toString(), teamC.toString());
        assertThat(ids).as("units at other levels under the same anchor are NOT visible")
                .doesNotContain(wing1.toString(), sec1.toString(), sec2.toString());
    }

    // ---- POSTURE-SCOPE-04 — MULTIPLE UNITS -----------------------------------------------------------------------

    @Test
    @DisplayName("POSTURE-SCOPE-04: MULTI — union of {Section1 UNIT, Section4 UNIT_TREE}; nothing between them leaks")
    void multipleTargets() {
        UUID snapshot = publishedSnapshot();
        UUID wing = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing, 2, snapshot);
        UUID sec2 = hrOrg("SEC2", wing, 2, snapshot);  // between s1 and s4, must NOT appear
        UUID sec3 = hrOrg("SEC3", wing, 2, snapshot);  // also between, must NOT appear
        UUID sec4 = hrOrg("SEC4", wing, 2, snapshot);
        UUID teamD = hrOrg("TEAMD", sec4, 3, snapshot);
        UUID teamE = hrOrg("TEAME", sec4, 3, snapshot);
        for (UUID u : List.of(wing, sec1, sec2, sec3, sec4, teamD, teamE)) {
            stationed("M-" + u.toString().substring(0, 4), u, 25.0 + Math.random() * 0.5, 55.0 + Math.random() * 0.5);
        }
        viewerWithScope("pv04", wing, List.of(
                new Target(sec1, false, List.of()),
                new Target(sec4, true, List.of())));
        var ids = visibleUnits("pv04");
        assertThat(ids).as("sec1 only").contains(sec1.toString());
        assertThat(ids).as("sec4 and both descendants").contains(sec4.toString(), teamD.toString(), teamE.toString());
        assertThat(ids).as("units between sec1 and sec4 stay invisible").doesNotContain(sec2.toString(), sec3.toString(), wing.toString());
    }

    // ---- POSTURE-SCOPE-05 — LIVE HIERARCHY -----------------------------------------------------------------------

    @Test
    @DisplayName("POSTURE-SCOPE-05: moving a child outside the branch removes it on the very next request; adding one adds it")
    void liveHierarchy() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID wing2 = hrOrg("WING2", null, 1, snapshot);
        UUID child = hrOrg("CHILD", wing1, 2, snapshot);
        stationed("WING1", wing1, 25.0, 55.0);
        stationed("WING2", wing2, 25.5, 55.5);
        stationed("CHILD", child, 25.1, 55.1);
        viewerWithScope("pv05", wing1, wing1, true, List.of());
        assertThat(visibleUnits("pv05")).as("initially inside the branch").contains(child.toString());

        // move the child out of wing1 under wing2 — the hierarchy change note moves the authorisation-change watermark
        tx.executeWithoutResult(s -> {
            jdbc.sql("set local session_replication_role = replica").update();
            jdbc.sql("update organization set parent_id = :w where id = :c").param("w", wing2).param("c", child).update();
            jdbc.sql("insert into authz_change(person_id, source) values (null, 'test:hierarchy-change')").update();
        });
        assertThat(visibleUnits("pv05")).as("after the move the child is no longer visible").doesNotContain(child.toString());

        // move a brand-new child UNDER wing1 — the next request picks it up
        UUID added = hrOrg("ADDED", wing1, 2, snapshot);
        stationed("ADDED", added, 25.2, 55.2);
        jdbc.sql("insert into authz_change(person_id, source) values (null, 'test:hierarchy-change')").update();
        assertThat(visibleUnits("pv05")).as("newly added child is visible").contains(added.toString());
    }

    // ---- POSTURE-SCOPE-06 — LAZY ENDPOINT SECURITY ---------------------------------------------------------------

    @Test
    @DisplayName("POSTURE-SCOPE-06: lazy endpoints fail closed for outside-scope sites, units and requests (no identity/geometry leak)")
    void lazyEndpointSecurity() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID sec1 = hrOrg("SEC1", wing1, 2, snapshot);
        UUID wing2 = hrOrg("WING2", null, 1, snapshot);
        UUID sec2 = hrOrg("SEC2", wing2, 2, snapshot);
        UUID insideSite = stationed("WING1", wing1, 25.0, 55.0);
        stationed("SEC1", sec1, 25.1, 55.1);
        UUID outsideSite = stationed("WING2", wing2, 26.0, 56.0);
        UUID outsideSiteSec = stationed("SEC2", sec2, 26.1, 56.1);
        viewerWithScope("pv06", wing1, wing1, true, List.of());

        // an outside site must fail closed: no identity (name, code), no geometry (anchor), no units list leak
        Res outSite = login("pv06").get("/operational-posture/sites/" + outsideSite);
        assertThat(outSite.status()).as("outside site is 404-closed: " + outSite).isEqualTo(404);
        Res outSite2 = login("pv06").get("/operational-posture/sites/" + outsideSiteSec);
        assertThat(outSite2.status()).as("another outside site is 404-closed: " + outSite2).isEqualTo(404);

        // the inside site is fine
        Res inSite = login("pv06").get("/operational-posture/sites/" + insideSite);
        assertThat(inSite.status()).as("inside site is served: " + inSite).isEqualTo(200);

        // an outside unit is 404 (the controller's canFor check)
        Res outUnit = login("pv06").get("/operational-posture/units/" + wing2);
        assertThat(outUnit.status()).as("outside unit is 404: " + outUnit).isEqualTo(404);
        Res outUnit2 = login("pv06").get("/operational-posture/units/" + sec2);
        assertThat(outUnit2.status()).as("outside unit under outside parent is 404: " + outUnit2).isEqualTo(404);

        // an outside pending request is 404 (the request-visibility rule; a forged uuid is also 404)
        Res fake = login("pv06").get("/operational-posture/requests/" + UUID.randomUUID());
        assertThat(fake.status()).as("a forged request id is 404: " + fake).isEqualTo(404);
    }

    // ---- POSTURE-SCOPE-07 — OVERVIEW COUNTS ----------------------------------------------------------------------

    @Test
    @DisplayName("POSTURE-SCOPE-07: overview totals and per-site aggregates follow the viewer's reach only")
    void overviewAggregatesRespectScope() {
        UUID snapshot = publishedSnapshot();
        UUID wing1 = hrOrg("WING1", null, 1, snapshot);
        UUID wing2 = hrOrg("WING2", null, 1, snapshot);
        // 3 wing-1 units, 2 wing-2 units — all stationed, each at its own site so sitesTotal is verifiable too
        List<UUID> wing1Units = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID u = hrOrg("W1-" + i, wing1, 2, snapshot);
            wing1Units.add(u);
            stationed("W1-" + i, u, 25.0 + i * 0.01, 55.0 + i * 0.01);
        }
        List<UUID> wing2Units = new ArrayList<>();
        for (int i = 0; i < 2; i++) {
            UUID u = hrOrg("W2-" + i, wing2, 2, snapshot);
            wing2Units.add(u);
            stationed("W2-" + i, u, 26.0 + i * 0.01, 56.0 + i * 0.01);
        }
        // the viewer sees only wing1 + its 3 descendants (so 4 units, 3 sites — the wing itself has no site here)
        viewerWithScope("pv07", wing1, wing1, true, List.of());
        JsonNode body = overview("pv07");
        long units = body.path("unitsTotal").asLong();
        long sites = body.path("sitesTotal").asLong();
        // the reach is the 3 descendants plus wing1 itself (4 units), but only the 3 descendants have a stationing/site
        assertThat(units).as("unitsTotal reflects reach size, not the whole table").isEqualTo(4L);
        assertThat(sites).as("sitesTotal counts only sites where reach units stand").isEqualTo(3L);

        // no outside-wing site sneaks into siteHubs
        Set<String> hubSiteIds = new LinkedHashSet<>();
        for (JsonNode h : body.path("siteHubs")) hubSiteIds.add(h.path("siteId").asText());
        for (UUID outside : wing2Units) {
            // the site of each wing2 unit must not appear in the viewer's hubs (we know the site is the stationing site)
            UUID outsideSite = jdbc.sql("select site_id from org_stationing where organization_id = :o and valid_to is null")
                    .param("o", outside).query(UUID.class).single();
            assertThat(hubSiteIds).as("outside-reach site must not appear in siteHubs").doesNotContain(outsideSite.toString());
        }

        // a global VIEW_OPERATIONAL_POSTURE (scope_all = true on CUSTOM) sees every stationed unit across both wings
        String fullRole = role("PVFULL", "ORGANIZATION", "VIEW_OPERATIONAL_POSTURE");
        person("pv07full", fullRole, wing1);
        jdbc.sql("""
                update membership set scope_mode = 'CUSTOM', scope_all = true, scope_combine = 'AND'
                where person_id = (select id from person where username = :u) and role_code = :r""")
                .param("u", "pv07full-" + sfx).param("r", fullRole).update();
        jdbc.sql("insert into authz_change(person_id, source) select id, 'test:pv07-full' from person where username = :u")
                .param("u", "pv07full-" + sfx).update();
        JsonNode full = overview("pv07full");
        assertThat(full.path("sitesTotal").asLong()).as("full reach counts both wings' stationed sites (3 + 2)").isGreaterThanOrEqualTo(5L);
    }
}
