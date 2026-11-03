package ae.mover.stationing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.data.Offset.offset;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import ae.mover.IntegrationTest;

/**
 * The production adapters of Stationing V3 on the real (disposable) PostgreSQL + PostGIS: the hierarchy over the HR
 * projection, drift after a projection change, and the PostGIS centre-to-centre geometry. Organisations are inserted
 * shaped like HR rows (source HR, Oracle id in source_external_id); this is NOT a real Oracle read.
 */
class StationingAdaptersIT extends IntegrationTest {

    @Autowired
    OrganizationHierarchy hierarchy;
    @Autowired
    PostgisGeoMeasure geo;

    UUID hrOrg(String ext, UUID parent) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into organization(id, code, name, parent_id, valid_from, source, source_external_id)
                values (:id, :c, :n, :p, '2026-01-01T00:00:00Z', 'HR', :e)""")
                .param("id", id).param("c", "HR-" + ext + "-" + sfx).param("n", "وحدة " + ext).param("p", parent)
                .param("e", ext + "-" + sfx).update();
        return id;
    }

    @Test
    void pathFromTheProjectionAndDriftAfterAnOracleParentChange() {
        UUID top = hrOrg("600", null);
        UUID mid = hrOrg("700", top);
        UUID other = hrOrg("701", top);
        UUID unit = hrOrg("800", mid);
        assertThat(hierarchy.path(unit)).extracting(OrgUnit::id).containsExactly(unit, mid, top);
        assertThat(hierarchy.path(unit).get(0).externalId()).isEqualTo("800-" + sfx);
        var snap = HierarchySnapshot.take(hierarchy, unit, Instant.now());
        assertThat(HierarchyDrift.detect(snap, hierarchy).drifted()).isFalse();
        // the HR projection (and only it) may change an HR parent: simulate the Oracle sync
        tx.executeWithoutResult(s -> {
            jdbc.sql("select set_config('tmrkz.hr_projection', 'on', true)").query().singleRow();
            jdbc.sql("update organization set parent_id = :p where id = :id").param("p", other).param("id", unit).update();
        });
        var d = HierarchyDrift.detect(snap, hierarchy);
        assertThat(d.drifted()).isTrue();
        assertThat(d.current()).containsExactly(unit, other, top);
        assertThat(HierarchyDrift.activationRefusal(RestationingState.APPROVED_NOT_ACTIVATED, snap, hierarchy)).isPresent();
    }

    @Test
    void postgisCentreToCentreDistanceAreaAndIntersection() {
        String a = square(25.205, 55.30, 0.003);
        String b = square(25.205, 55.38, 0.003);
        // 0.08° of longitude at 25.2° N ≈ 8.05 km
        assertThat(geo.centroidDistanceM(a, b)).isCloseTo(8050, offset(30.0));
        assertThat(geo.areaM2(a)).isGreaterThan(0);
        assertThat(geo.intersects(a, b)).isFalse();
        assertThat(geo.intersects(a, square(25.2055, 55.3005, 0.003))).isTrue();
    }

    static String square(double lat, double lng, double h) {
        return "{\"type\":\"Polygon\",\"coordinates\":[[[%s,%s],[%s,%s],[%s,%s],[%s,%s],[%s,%s]]]}".formatted(
                lng - h, lat - h, lng + h, lat - h, lng + h, lat + h, lng - h, lat + h, lng - h, lat - h);
    }
}
