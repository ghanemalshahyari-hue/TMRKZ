package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import ae.mover.access.Permission;
import ae.mover.stationing.DeploymentRules.LegStatus;
import ae.mover.stationing.OccupancyRule.Kind;
import ae.mover.stationing.OccupancyRule.Occupancy;
import ae.mover.stationing.RouteDerivation.CrossBranchInclusion;
import ae.mover.stationing.RouteDerivation.RouteStage;
import ae.mover.stationing.StationingEventSender.Delivery;
import ae.mover.stationing.StationingEventSender.Destination;
import ae.mover.stationing.StationingEventSender.State;
import ae.mover.stationing.StationingFixtures.FixtureHierarchy;
import ae.mover.stationing.StationingPolicy.CrossAuthority;
import ae.mover.stationing.StationingPolicy.CrossBranch;
import ae.mover.stationing.StationingPolicy.DeploymentRequirement;
import ae.mover.stationing.StationingPolicy.Routing;
import ae.mover.stationing.StationingPolicy.StartAt;
import ae.mover.stationing.StationingPolicy.TerrainAppliesTo;
import ae.mover.stationing.StationingReadAccess.StationingView;
import ae.mover.stationing.TerrainRule.TerrainDecision;
import ae.mover.stationing.TerrainRule.TerrainShare;

/** Stationing Model V3 rules in production code, against the owner decisions (docs/STATIONING_MODEL_V3_AR.md §13). */
class StationingRulesTest {

    final FixtureHierarchy h = new FixtureHierarchy(StationingFixtures.ORACLE_TEST_EXTRACT);
    final StationingPolicy policy = StationingFixtures.policy();
    static final Instant T0 = Instant.parse("2026-11-03T06:00:00Z");

    @Nested
    @DisplayName("routing from the requesting unit (O-07, O-09)")
    class Routes {

        @Test
        void startsAtTheRequestingUnitAndFollowsOracleUpward() {
            List<RouteStage> r = RouteDerivation.derive(h.path(h.id("900")), policy.routing(), policy.crossBranch(), List.of(), false);
            assertThat(r).extracting(RouteStage::unit).containsExactly(h.id("900"), h.id("800"), h.id("700"), h.id("600"));
            assertThat(RouteDerivation.complete(r)).isTrue();
            assertThat(r.get(r.size() - 1).dependsOn()).containsExactlyInAnyOrder(Fact.values());
        }

        @Test
        void aLevelConfiguredNotToApproveHasNoStageAndNoLevelIsHardCoded() {
            // L10 does not approve: a request from u1000 starts at its L9 parent's stage
            List<RouteStage> r = RouteDerivation.derive(h.path(h.id("1000")), policy.routing(), policy.crossBranch(), List.of(), false);
            assertThat(r).extracting(RouteStage::unit).containsExactly(h.id("900"), h.id("800"), h.id("700"), h.id("600"));
            var skip7 = new Routing(StartAt.SELF, policy.routing().levels().stream()
                    .map(l -> l.level() == 7 ? new StationingPolicy.RoutingLevel(7, false, l.label(), false, l.dependsOn()) : l).toList());
            assertThat(RouteDerivation.derive(h.path(h.id("900")), skip7, policy.crossBranch(), List.of(), false))
                    .extracting(RouteStage::unit).containsExactly(h.id("900"), h.id("800"), h.id("600"));
        }

        @Test
        void parentFirstIsConfigurable() {
            var parent = new Routing(StartAt.PARENT, policy.routing().levels());
            assertThat(RouteDerivation.derive(h.path(h.id("900")), parent, policy.crossBranch(), List.of(), false).get(0).unit())
                    .isEqualTo(h.id("800"));
        }

        @Test
        void aRouteWithoutTheFinalLevelIsIncomplete() {
            var noFinal = new Routing(StartAt.SELF, policy.routing().levels().stream().filter(l -> l.level() != 6).toList());
            assertThat(RouteDerivation.complete(RouteDerivation.derive(h.path(h.id("900")), noFinal, policy.crossBranch(), List.of(), false))).isFalse();
        }
    }

    @Nested
    @DisplayName("cross-branch units (O-03, O-03b)")
    class CrossBranchUnits {

        final CrossBranchInclusion networks = new CrossBranchInclusion(h.id("802"), "قسم الشبكات", h.id("701"), h.id("800"));

        @Test
        void eachConfiguredAuthorityIsARequirementBeforeTheFinalStage() {
            var cb = new CrossBranch(true, List.of(CrossAuthority.OTHER_UNIT, CrossAuthority.OTHER_UNIT_PARENT), false);
            var r = RouteDerivation.derive(h.path(h.id("800")), policy.routing(), cb, List.of(networks), false);
            assertThat(r).extracting(RouteStage::unit).containsExactly(h.id("800"), h.id("700"), h.id("802"), h.id("701"), h.id("600"));
        }

        @Test
        void anAuthorityAlreadyOnTheRouteSatisfiesTheRequirementAndRecordsIt() {
            var cb = new CrossBranch(true, List.of(CrossAuthority.OTHER_UNIT, CrossAuthority.SITE_RESPONSIBLE), false);
            var r = RouteDerivation.derive(h.path(h.id("800")), policy.routing(), cb, List.of(networks), false);
            assertThat(r).extracting(RouteStage::unit).containsExactly(h.id("800"), h.id("700"), h.id("802"), h.id("600"));
            assertThat(r.get(0).satisfies()).extracting(RouteDerivation.Requirement::label)
                    .containsExactly("اعتماد هرمي", "موافقة المسؤول عن موقعها (ضم قسم الشبكات)");
        }

        @Test
        void independenceAddsASeparateStageThatAnotherHumanMustDecide() {
            var cb = new CrossBranch(true, List.of(CrossAuthority.OTHER_UNIT, CrossAuthority.SITE_RESPONSIBLE), true);
            var r = RouteDerivation.derive(h.path(h.id("800")), policy.routing(), cb, List.of(networks), false);
            var hier = r.get(0);
            var independent = r.stream().filter(s -> s.kind() == RouteDerivation.Kind.CROSS_BRANCH && h.id("800").equals(s.unit())).findFirst().orElseThrow();
            assertThat(independent.independentOf()).isEqualTo(hier.key());
            Map<String, String> decided = Map.of(hier.key(), "human-maryam");
            assertThat(RouteDerivation.mayDecide(independent, "human-maryam", r, decided)).isFalse();
            assertThat(RouteDerivation.mayDecide(independent, "human-hamad", r, decided)).isTrue();
            // and the reverse order: whoever decided the independent stage may not take the hierarchical one
            assertThat(RouteDerivation.mayDecide(hier, "human-hamad", r, Map.of(independent.key(), "human-hamad"))).isFalse();
        }

        @Test
        void aDistanceExceptionAddsItsPermissionStageBeforeTheFinal() {
            var r = RouteDerivation.derive(h.path(h.id("800")), policy.routing(), policy.crossBranch(), List.of(), true);
            assertThat(r).extracting(RouteStage::kind).containsExactly(RouteDerivation.Kind.HIERARCHY, RouteDerivation.Kind.HIERARCHY,
                    RouteDerivation.Kind.EXCEPTION, RouteDerivation.Kind.HIERARCHY);
        }
    }

    @Nested
    @DisplayName("hierarchy drift (O-10, O-16)")
    class Drift {

        @Test
        void noChangeNoDrift() {
            var snap = HierarchySnapshot.take(h, h.id("800"), T0);
            assertThat(HierarchyDrift.detect(snap, h).drifted()).isFalse();
            assertThat(HierarchyDrift.activationRefusal(RestationingState.APPROVED_NOT_ACTIVATED, snap, h)).isEmpty();
        }

        @Test
        void aParentChangeOfTheRequestingUnitPausesAndBlocksActivationEvenWhenApproved() {
            var snap = HierarchySnapshot.take(h, h.id("800"), T0);
            assertThat(snap.externalPath()).containsExactly("800", "700", "600");
            h.reparent("800", "701");
            var d = HierarchyDrift.detect(snap, h);
            assertThat(d.drifted()).isTrue();
            assertThat(d.current()).containsExactly(h.id("800"), h.id("701"), h.id("600"));
            assertThat(HierarchyDrift.mustPause(RestationingState.UNDER_REVIEW, snap, h)).isTrue();
            assertThat(HierarchyDrift.mustPause(RestationingState.APPROVED_NOT_ACTIVATED, snap, h)).isTrue();
            assertThat(HierarchyDrift.mustPause(RestationingState.ACTIVATED_PERMANENT, snap, h)).isFalse();
            assertThat(HierarchyDrift.activationRefusal(RestationingState.APPROVED_NOT_ACTIVATED, snap, h))
                    .hasValueSatisfying(m -> assertThat(m).contains(HierarchyDrift.MESSAGE));
            // the rebuilt route starts at the SAME requesting unit with its new ancestry
            assertThat(RouteDerivation.derive(h.path(h.id("800")), policy.routing(), policy.crossBranch(), List.of(), false))
                    .extracting(RouteStage::unit).containsExactly(h.id("800"), h.id("701"), h.id("600"));
        }

        @Test
        void aChangeElsewhereDoesNotDrift() {
            var snap = HierarchySnapshot.take(h, h.id("800"), T0);
            h.reparent("901", "701");
            assertThat(HierarchyDrift.detect(snap, h).drifted()).isFalse();
        }

        @Test
        void pausedRequestsCannotBeActivated() {
            var snap = HierarchySnapshot.take(h, h.id("800"), T0);
            assertThat(HierarchyDrift.activationRefusal(RestationingState.PAUSED_HIERARCHY_CHANGED, snap, h)).isPresent();
        }
    }

    @Nested
    @DisplayName("terrain (O-05, O-05b, O-06)")
    class Terrain {

        @Test
        void theLargestAreaGovernsAndTheAllowanceExtendsTheMaximumOnly() {
            TerrainDecision t = TerrainRule.decide(List.of(new TerrainShare("FLAT", 400_000), new TerrainShare("HILLY", 700_000)), policy);
            assertThat(t.tie()).isFalse();
            assertThat(t.controlling().code()).isEqualTo("HILLY");
            var leg = DeploymentRules.leg(policy.primary(), policy, 9300.0, t);
            assertThat(leg.effectiveMinM()).isEqualTo(5000);
            assertThat(leg.effectiveMaxM()).isEqualTo(10_000); // 5–8 + 2 = 5–10
            assertThat(leg.status()).isEqualTo(LegStatus.OK);
            assertThat(t.percent(t.shares().get(0))).isCloseTo(63.6, org.assertj.core.data.Offset.offset(0.1));
        }

        @Test
        void aTieIsDecidedByTheConfiguredPriorityNotByTheAllowance() {
            var shares = List.of(new TerrainShare("HILLY", 500_000), new TerrainShare("FLAT", 500_000));
            TerrainDecision t = TerrainRule.decide(shares, policy); // priority ROLLING > FLAT > HILLY
            assertThat(t.tie()).isTrue();
            assertThat(t.resolved()).isTrue();
            assertThat(t.tied()).containsExactlyInAnyOrder("FLAT", "HILLY");
            assertThat(t.controlling().code()).isEqualTo("FLAT");
            assertThat(DeploymentRules.leg(policy.primary(), policy, 7000.0, t).effectiveMaxM()).isEqualTo(8000);
            var reversed = new StationingPolicy(policy.maxFootprintAreaM2(), policy.deploymentRequirement(), policy.primary(),
                    policy.alternative(), policy.terrainSlopeClassification(), policy.terrainAllowancesM(), List.of("HILLY", "FLAT", "ROLLING"), policy.terrainAppliesTo(),
                    policy.exception(), policy.crossBranch(), policy.routing());
            assertThat(TerrainRule.decide(shares, reversed).controlling().code()).isEqualTo("HILLY");
        }

        @Test
        void tiedClassesWithoutAValidPriorityBlock() {
            var partial = new StationingPolicy(policy.maxFootprintAreaM2(), policy.deploymentRequirement(), policy.primary(),
                    policy.alternative(), policy.terrainSlopeClassification(), policy.terrainAllowancesM(), List.of("ROLLING", "FLAT"), policy.terrainAppliesTo(),
                    policy.exception(), policy.crossBranch(), policy.routing());
            TerrainDecision t = TerrainRule.decide(List.of(new TerrainShare("HILLY", 500_000), new TerrainShare("FLAT", 500_000)), partial);
            assertThat(t.resolved()).isFalse();
            assertThat(DeploymentRules.leg(partial.primary(), partial, 6000.0, t).status()).isEqualTo(LegStatus.TERRAIN_TIE_UNRESOLVED);
        }

        @Test
        void minAndMaxIsNeverPublishableTheMinimumStays() {
            var mm = new StationingPolicy(policy.maxFootprintAreaM2(), policy.deploymentRequirement(), policy.primary(),
                    policy.alternative(), policy.terrainSlopeClassification(), policy.terrainAllowancesM(), policy.terrainClassPriority(), TerrainAppliesTo.MIN_AND_MAX,
                    policy.exception(), policy.crossBranch(), policy.routing());
            var t = TerrainRule.decide(List.of(new TerrainShare("HILLY", 1)), mm);
            var leg = DeploymentRules.leg(mm.primary(), mm, 6000.0, t);
            assertThat(leg.effectiveMinM()).isEqualTo(7000);
            assertThat(leg.effectiveMaxM()).isEqualTo(10_000);
            assertThat(mm.problems()).containsExactly("إضافة الأرض تمد الحد الأقصى فقط، والحد الأدنى لا يتغير (O-06)");
        }
    }

    @Nested
    @DisplayName("deployment, footprint and occupancy (O-08, O-15)")
    class Deployment {

        @Test
        void legStatuses() {
            var flat = TerrainRule.decide(List.of(new TerrainShare("FLAT", 1)), policy);
            assertThat(DeploymentRules.leg(policy.primary(), policy, null, flat).status()).isEqualTo(LegStatus.NOT_PLACED);
            assertThat(DeploymentRules.leg(policy.primary(), policy, 4999.0, flat).status()).isEqualTo(LegStatus.OUT_OF_RANGE);
            assertThat(DeploymentRules.leg(policy.primary(), policy, 8500.0, flat).status()).isEqualTo(LegStatus.NEEDS_EXCEPTION);
            assertThat(DeploymentRules.leg(policy.primary(), policy, 9001.0, flat).status()).isEqualTo(LegStatus.OUT_OF_RANGE);
        }

        @Test
        void requiredNeedsBothOptionalNoneOrBothNeverOne() {
            assertThat(DeploymentRules.pair(DeploymentRequirement.REQUIRED, true, false)).isNotEmpty();
            assertThat(DeploymentRules.pair(DeploymentRequirement.REQUIRED, true, true)).isEmpty();
            assertThat(DeploymentRules.pair(DeploymentRequirement.OPTIONAL, false, false)).isEmpty();
            assertThat(DeploymentRules.pair(DeploymentRequirement.OPTIONAL, true, true)).isEmpty();
            assertThat(DeploymentRules.pair(DeploymentRequirement.OPTIONAL, false, true)).isNotEmpty();
        }

        @Test
        void maximumFootprintBlocks() {
            assertThat(DeploymentRules.footprintWithin(199_999, policy)).isTrue();
            assertThat(DeploymentRules.footprintWithin(200_001, policy)).isFalse();
        }

        @Test
        void onlyAuthoritativeRecordsOccupyAndAVacatedSiteIsNotAConflict() {
            UUID a = UUID.randomUUID(), j = UUID.randomUUID(), k = UUID.randomUUID();
            UUID u800 = h.id("800"), u802 = h.id("802");
            var records = List.of(
                    new Occupancy(a, u800, Kind.STATIONING, T0.minus(Duration.ofDays(400)), null, "st-1"),
                    new Occupancy(a, u802, Kind.STATIONING, T0.minus(Duration.ofDays(400)), null, "st-2"),
                    new Occupancy(k, u802, Kind.RESERVATION, T0.minus(Duration.ofDays(5)), T0.plus(Duration.ofDays(60)), "RSV-42"),
                    new Occupancy(j, u800, Kind.APPROVED_USE, T0.minus(Duration.ofDays(30)), T0.minus(Duration.ofDays(1)), "expired"));
            // site J has only a (non-input) link and an expired use: not occupied; K is reserved
            assertThat(OccupancyRule.occupiedSites(records, Set.of(u800), T0)).containsExactlyInAnyOrder(a, k);
            // when everyone stationed at A moves, A is not a conflict for this request
            assertThat(OccupancyRule.occupiedSites(records, Set.of(u800, u802), T0)).containsExactly(k);
        }
    }

    @Nested
    @DisplayName("outbound contract and sender (O-01)")
    class Outbound {

        final UUID site = UUID.randomUUID();

        StationingEvent event(StationingEvent.Type type) {
            return StationingEvent.of(type, "800", "SS-TS", site, "FMS-117", T0, T0, "policy-1/rev-1", "RS-2026-0101");
        }

        @Test
        void theContractCarriesTheRequiredFieldsAndAStableIdempotentId() {
            var e = event(StationingEvent.Type.STATIONING_ACTIVATED);
            assertThat(e.payload()).containsKeys("eventId", "schema", "source", "type", "orgExternalId", "siteId", "siteExternalId",
                    "effectiveAt", "recordedAt", "sourceVersion", "auditRef");
            assertThat(e.payload()).containsEntry("schema", "tmrkz.stationing.v1").containsEntry("source", "TMRKZ")
                    .containsEntry("orgExternalId", "800");
            assertThat(event(StationingEvent.Type.STATIONING_ACTIVATED).eventId()).isEqualTo(e.eventId());
            assertThat(event(StationingEvent.Type.TEMPORARY_STATIONING_ENDED).eventId()).isNotEqualTo(e.eventId());
            assertThatThrownBy(() -> StationingEvent.of(StationingEvent.Type.SITE_LINK_CREATED, "", " ", site, null, T0, T0, "v", "ref"))
                    .isInstanceOf(IllegalArgumentException.class);
        }

        @Test
        void retriesWithBackoffThenParksAsFailedWithTheReasonAndNeverDrops() {
            var ledger = new MemoryLedger();
            var e = event(StationingEvent.Type.TEMPORARY_STATIONING_STARTED);
            ledger.save(new Delivery(e, State.PENDING, 0, T0, null));
            var sender = new StationingEventSender(ledger, ev -> Destination.Result.retry("الوجهة غير متاحة"));
            Instant now = T0;
            for (int i = 0; i < StationingEventSender.MAX_ATTEMPTS; i++) {
                sender.process(now, 10);
                now = now.plus(Duration.ofMinutes(10));
            }
            Delivery d = ledger.get(e.eventId()).orElseThrow();
            assertThat(d.state()).isEqualTo(State.FAILED);
            assertThat(d.attempts()).isEqualTo(10);
            assertThat(d.lastError()).isEqualTo("الوجهة غير متاحة");
            assertThat(StationingEventSender.backoff(1)).isEqualTo(Duration.ofSeconds(4));
            assertThat(StationingEventSender.backoff(9)).isEqualTo(Duration.ofSeconds(300));
        }

        @Test
        void aPermanentRefusalFailsAtOnceAndAnExceptionIsRetried() {
            var ledger = new MemoryLedger();
            var a = event(StationingEvent.Type.SITE_LINK_CREATED);
            var b = event(StationingEvent.Type.SITE_LINK_ENDED);
            ledger.save(new Delivery(a, State.PENDING, 0, T0, null));
            ledger.save(new Delivery(b, State.PENDING, 0, T0, null));
            new StationingEventSender(ledger, ev -> {
                if (ev.type() == StationingEvent.Type.SITE_LINK_CREATED) {
                    return Destination.Result.refuse("مخطط غير مقبول");
                }
                throw new IllegalStateException("timeout");
            }).process(T0, 10);
            assertThat(ledger.get(a.eventId()).orElseThrow().state()).isEqualTo(State.FAILED);
            assertThat(ledger.get(b.eventId()).orElseThrow()).satisfies(d -> {
                assertThat(d.state()).isEqualTo(State.PENDING);
                assertThat(d.lastError()).contains("timeout");
                assertThat(d.availableAt()).isAfter(T0);
            });
        }

        @Test
        void deliveredOnceAndTheDestinationSeesTheEventId() {
            var ledger = new MemoryLedger();
            var e = event(StationingEvent.Type.STATIONING_ACTIVATED);
            ledger.save(new Delivery(e, State.PENDING, 0, T0, null));
            List<UUID> seen = new ArrayList<>();
            var sender = new StationingEventSender(ledger, ev -> {
                seen.add(ev.eventId());
                return Destination.Result.ok();
            });
            sender.process(T0, 10);
            sender.process(T0.plusSeconds(60), 10);
            assertThat(seen).containsExactly(e.eventId());
            assertThat(ledger.get(e.eventId()).orElseThrow().state()).isEqualTo(State.DELIVERED);
        }

        @Test
        void replayNeedsPermissionAndAReasonAndIsAudited() {
            var ledger = new MemoryLedger();
            var e = event(StationingEvent.Type.STATIONING_CORRECTED);
            ledger.save(new Delivery(e, State.FAILED, 10, T0, "x"));
            var sender = new StationingEventSender(ledger, ev -> Destination.Result.ok());
            assertThatThrownBy(() -> sender.replay(e.eventId(), false, "p", "سبب", T0)).isInstanceOf(SecurityException.class);
            assertThatThrownBy(() -> sender.replay(e.eventId(), true, "p", " ", T0)).isInstanceOf(IllegalArgumentException.class);
            sender.replay(e.eventId(), true, "operator-1", "أُصلحت الوجهة", T0);
            assertThat(ledger.get(e.eventId()).orElseThrow().state()).isEqualTo(State.PENDING);
            assertThat(ledger.audit).containsExactly("REPLAY|operator-1|أُصلحت الوجهة");
        }
    }

    @Nested
    @DisplayName("read contract scope")
    class ReadScope {

        final StationingView v800 = view("800"), v900 = view("900"), v802 = view("802");

        StationingView view(String ext) {
            return new StationingView(h.id(ext), ext, UUID.randomUUID(), null, "PERMANENT", T0, null);
        }

        @Test
        void allowedDescendantDeniedUnrelatedAndCrossBranch() {
            // a consumer scoped to u800 with descendants (resolved scope u800, u900, u1000, u1001, u901)
            var scope = Set.of(h.id("800"), h.id("900"), h.id("1000"), h.id("1001"), h.id("901"));
            var g = StationingFixtures.viewGrant(scope);
            assertThat(StationingReadAccess.filter(List.of(g), List.of(v800, v900, v802))).containsExactly(v800, v900);
            // the cross-branch unit u802 (moved by a u800 request) stays invisible to the u800 scope
            assertThat(StationingReadAccess.visible(List.of(g), h.id("802"))).isFalse();
            // without VIEW nothing is visible even inside the scope
            assertThat(StationingReadAccess.visible(List.of(StationingFixtures.grant(Set.of(Permission.CREATE), scope)), h.id("800"))).isFalse();
            // no grant: denied
            assertThat(StationingReadAccess.visible(List.of(), h.id("800"))).isFalse();
        }
    }

    @Nested
    @DisplayName("slope classification (owner stop-gate decision 2)")
    class SlopeBands {

        final List<StationingPolicy.SlopeClass> fao = StationingPolicyDefaults.FAO_SLOPE_CLASSES;

        @Test
        void halfOpenBandsInTheEncodingsUnitsPutEachCellInOneClass() {
            Map<Integer, String> expected = new LinkedHashMap<>();
            expected.put(0, "FLAT");
            expected.put(199, "FLAT");
            expected.put(200, "UNDULATING");
            expected.put(999, "UNDULATING");
            expected.put(1000, "ROLLING");
            expected.put(1499, "ROLLING");
            expected.put(1500, "HILLY");
            expected.put(2999, "HILLY");
            expected.put(3000, "MOUNTAINOUS");
            expected.put(65534, "MOUNTAINOUS");
            expected.forEach((v, code) -> assertThat(TerrainClassifier.classOf(fao, v).code()).as(v + "").isEqualTo(code));
            assertThat(policy.terrainSlopeClassification().classify(1.99).code()).isEqualTo("FLAT");
            assertThat(policy.terrainSlopeClassification().classify(2.0).code()).isEqualTo("UNDULATING");
            assertThat(policy.terrainSlopeClassification().classify(30.0).code()).isEqualTo("MOUNTAINOUS");
        }

        @Test
        void theInitialValuesAreTheDocumentedFaoGradientsWithoutAllowances() {
            assertThat(fao).extracting(StationingPolicy.SlopeClass::code)
                    .containsExactly("FLAT", "UNDULATING", "ROLLING", "HILLY", "MOUNTAINOUS");
            assertThat(fao).extracting(StationingPolicy.SlopeClass::toPct).containsExactly(2.0, 10.0, 15.0, 30.0, null);
            var none = withClassification(policy.terrainSlopeClassification(), Map.of());
            assertThat(none.problems()).hasSize(5).allMatch(p -> p.contains("لم تُهيأ إضافة فئة الأرض"));
        }

        @Test
        void thresholdsMustBeContiguousFromZeroOpenEndedAndEncodable() {
            List<StationingPolicy.SlopeClass> bad = List.of(
                    new StationingPolicy.SlopeClass("FLAT", "مستوٍ", 0.5, 2.0),
                    new StationingPolicy.SlopeClass("UNDULATING", "متموّج", 2.5, 10.0),
                    new StationingPolicy.SlopeClass("ROLLING", "تضاريس متدرجة", 10, 10.125),
                    new StationingPolicy.SlopeClass("HILLY", "تلال", 10.125, 700.0),
                    new StationingPolicy.SlopeClass("MOUNTAINOUS", "جبلي", 700, 800.0));
            var p = withClassification(new StationingPolicy.SlopeClassification("TEST_TERRAIN", "1", bad), StationingFixtures.allowances());
            assertThat(p.problems()).anyMatch(m -> m.contains("تبدأ من 0"))
                    .anyMatch(m -> m.contains("غير متصلة"))
                    .anyMatch(m -> m.contains("بخانتين عشريتين"))
                    .anyMatch(m -> m.contains("مفتوحة الحد الأعلى"));
            var extra = new LinkedHashMap<>(StationingFixtures.allowances());
            extra.put("ROCKY", 100.0);
            assertThat(withClassification(policy.terrainSlopeClassification(), extra).problems())
                    .containsExactly("إضافة لفئة غير موجودة في تصنيف الميل: ROCKY");
        }

        @Test
        void aCellAreaIsGeodesicOnTheEllipsoid() {
            // one arc-second at 24° N: about 30.8 m north–south by 28.3 m east–west
            assertThat(TerrainClassifier.pixelAreaM2(24, 1.0 / 3600, 1.0 / 3600)).isBetween(865.0, 880.0);
            // at the equator 30.92 m (normal radius) by 30.72 m (meridian radius)
            assertThat(TerrainClassifier.pixelAreaM2(0, 1.0 / 3600, 1.0 / 3600)).isBetween(949.0, 951.0);
        }

        StationingPolicy withClassification(StationingPolicy.SlopeClassification sc, Map<String, Double> allowances) {
            return new StationingPolicy(policy.maxFootprintAreaM2(), policy.deploymentRequirement(), policy.primary(),
                    policy.alternative(), sc, allowances, List.of(), policy.terrainAppliesTo(), policy.exception(),
                    policy.crossBranch(), policy.routing());
        }
    }

    @Nested
    @DisplayName("policy validation")
    class PolicyValidation {

        @Test
        void theDemonstrationPolicyIsValid() {
            assertThat(policy.problems()).isEmpty();
        }

        @Test
        void invalidValuesAreRefused() {
            var bad = new StationingPolicy(0, DeploymentRequirement.OPTIONAL, new StationingPolicy.Leg(8000, 5000, true),
                    policy.alternative(), policy.terrainSlopeClassification(), policy.terrainAllowancesM(), List.of("FLAT", "FLAT", "UNKNOWN"), TerrainAppliesTo.MAX_ONLY,
                    new StationingPolicy.DistanceException(true, 0), new CrossBranch(true, List.of(), false),
                    new Routing(StartAt.SELF, policy.routing().levels().stream().filter(l -> !l.finalStage()).toList()));
            assertThat(bad.problems()).hasSize(7);
        }
    }

    /** In-memory {@link StationingEventSender.Ledger} (the stationing outbox table comes with the schema work). */
    static final class MemoryLedger implements StationingEventSender.Ledger {

        final Map<UUID, Delivery> rows = new LinkedHashMap<>();
        final List<String> audit = new ArrayList<>();

        @Override
        public List<Delivery> due(Instant now, int max) {
            return rows.values().stream().filter(d -> d.state() == State.PENDING && !d.availableAt().isAfter(now)).limit(max).toList();
        }

        @Override
        public Optional<Delivery> get(UUID eventId) {
            return Optional.ofNullable(rows.get(eventId));
        }

        @Override
        public void save(Delivery d) {
            rows.put(d.event().eventId(), d);
        }

        @Override
        public void audit(UUID eventId, String action, String by, String reason, Instant at) {
            audit.add(action + "|" + by + "|" + reason);
        }
    }

    @SuppressWarnings("unused")
    private static Map<String, String> none() {
        return new HashMap<>();
    }
}
