package ae.mover.stationing;

import java.time.Instant;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import ae.mover.access.Grant;
import ae.mover.access.Permission;
import ae.mover.stationing.StationingPolicy.CrossAuthority;
import ae.mover.stationing.StationingPolicy.CrossBranch;
import ae.mover.stationing.StationingPolicy.DeploymentRequirement;
import ae.mover.stationing.StationingPolicy.DistanceException;
import ae.mover.stationing.StationingPolicy.Leg;
import ae.mover.stationing.StationingPolicy.Routing;
import ae.mover.stationing.StationingPolicy.RoutingLevel;
import ae.mover.stationing.StationingPolicy.StartAt;
import ae.mover.stationing.StationingPolicy.TerrainAppliesTo;
import ae.mover.stationing.StationingPolicy.TerrainClass;

/**
 * Test fixtures for Stationing V3, shaped exactly like the read-only HR mapping (external_unit_id,
 * parent_external_unit_id, level, code, name): the same fictional L6–L10 test extract as the accepted prototype
 * (prototypes/stationing-ux/src/v3/fixtures.ts). A FIXTURE, not a real Oracle read.
 */
final class StationingFixtures {

    private StationingFixtures() {
    }

    record Row(String externalUnitId, String parentExternalUnitId, int level, String code, String name) {
    }

    static final List<Row> ORACLE_TEST_EXTRACT = List.of(
            new Row("600", null, 6, "GS", "الإدارة العامة للخدمات"),
            new Row("700", "600", 7, "SS", "إدارة الخدمات المساندة"),
            new Row("800", "700", 8, "SS-TS", "قسم الخدمات الفنية"),
            new Row("900", "800", 9, "SS-TS-MN", "شعبة الصيانة"),
            new Row("1000", "900", 10, "SS-TS-MN-B", "وحدة صيانة المباني"),
            new Row("1001", "900", 10, "SS-TS-MN-E", "وحدة الصيانة الكهربائية"),
            new Row("901", "800", 9, "SS-TS-TR", "شعبة النقل"),
            new Row("701", "600", 7, "IT", "إدارة تقنية المعلومات"),
            new Row("802", "701", 8, "IT-NW", "قسم الشبكات"));

    /** An in-memory {@link OrgHierarchy} projected from the extract by parent links (as the HR projection does). */
    static final class FixtureHierarchy implements OrgHierarchy {

        final Map<String, UUID> ids = new LinkedHashMap<>();
        final Map<UUID, OrgUnit> units = new HashMap<>();

        FixtureHierarchy(List<Row> rows) {
            rows.forEach(r -> ids.put(r.externalUnitId(), UUID.nameUUIDFromBytes(r.externalUnitId().getBytes())));
            rows.forEach(r -> put(r));
        }

        void put(Row r) {
            UUID id = ids.computeIfAbsent(r.externalUnitId(), k -> UUID.nameUUIDFromBytes(k.getBytes()));
            units.put(id, new OrgUnit(id, r.externalUnitId(), r.parentExternalUnitId() == null ? null : ids.get(r.parentExternalUnitId()),
                    r.level(), r.code(), r.name()));
        }

        /** Simulates an Oracle sync that moves a unit under another parent. */
        void reparent(String externalId, String newParentExternalId) {
            OrgUnit u = units.get(ids.get(externalId));
            units.put(u.id(), new OrgUnit(u.id(), u.externalId(), ids.get(newParentExternalId), u.level(), u.code(), u.name()));
        }

        UUID id(String externalId) {
            return ids.get(externalId);
        }

        @Override
        public Optional<OrgUnit> unit(UUID id) {
            return Optional.ofNullable(units.get(id));
        }

        @Override
        public List<OrgUnit> path(UUID id) {
            List<OrgUnit> out = new java.util.ArrayList<>();
            for (OrgUnit u = units.get(id); u != null && out.size() < 64; u = u.parentId() == null ? null : units.get(u.parentId())) {
                out.add(u);
            }
            return out;
        }
    }

    static StationingPolicy policy() {
        return new StationingPolicy(
                200_000,
                DeploymentRequirement.REQUIRED,
                new Leg(5000, 8000, true),
                new Leg(3000, 5000, true),
                List.of(new TerrainClass("FLAT", "أرض مستوية", 0), new TerrainClass("ROLLING", "أرض متموجة", 1000),
                        new TerrainClass("RUGGED", "أرض وعرة", 2000)),
                List.of("ROLLING", "FLAT", "RUGGED"),
                TerrainAppliesTo.MAX_ONLY,
                new DistanceException(true, 1000),
                new CrossBranch(false, List.of(CrossAuthority.OTHER_UNIT), false),
                new Routing(StartAt.SELF, List.of(
                        new RoutingLevel(10, false, "معتمد الوحدة", false, EnumSet.of(Fact.SCOPE)),
                        new RoutingLevel(9, true, "معتمد الشعبة", false, EnumSet.of(Fact.SCOPE, Fact.CLASSIFICATION, Fact.DURATION)),
                        new RoutingLevel(8, true, "معتمد القسم", false, EnumSet.of(Fact.SCOPE, Fact.CLASSIFICATION, Fact.DURATION)),
                        new RoutingLevel(7, true, "معتمد وسيط — الإدارة", false, EnumSet.of(Fact.SCOPE, Fact.SITE, Fact.DEPLOYMENT, Fact.AVAILABILITY)),
                        new RoutingLevel(6, true, "المعتمد النهائي", true, Set.of()))));
    }

    /** A grant with VIEW whose resolved organisation scope is {@code orgScope} (descendants already resolved). */
    static Grant viewGrant(Set<UUID> orgScope) {
        return new Grant(UUID.randomUUID(), UUID.randomUUID(), null, null, "CONSUMER", "مستهلك قراءة", Set.of(Permission.VIEW),
                "ORG", false, null, null, null, null, Instant.parse("2027-01-01T00:00:00Z"), false, true, orgScope, null,
                Set.of(), Set.of(), List.of());
    }

    static Grant grant(Set<Permission> permissions, Set<UUID> orgScope) {
        return new Grant(UUID.randomUUID(), UUID.randomUUID(), null, null, "R", "R", permissions, "ORG", false, null, null, null,
                null, Instant.parse("2027-01-01T00:00:00Z"), false, true, orgScope, null, Set.of(), Set.of(), List.of());
    }
}
