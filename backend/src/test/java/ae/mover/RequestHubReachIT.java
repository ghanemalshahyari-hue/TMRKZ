package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * ADR-103 (owner: units missing from «طلب مناطق انتشار» on the VM, 23,674 units): the request hub listed the first 300 units of
 * the reach in tree order, whatever their state, so a stationed unit further down — the only kind the request can be made for —
 * was not offered, and retired units took places in the list. Fictional units only; the reach is a scoped grant so the order
 * is deterministic.
 */
class RequestHubReachIT extends IntegrationTest {

    private UUID stationing(UUID org) {
        UUID site = UUID.randomUUID();
        jdbc.sql("insert into site(id, code, name, kind, lat, lng) values (:id, :c, :n, 'مرفق', 24.4, 54.4)")
                .param("id", site).param("c", "HUB-SITE-" + sfx).param("n", "موقع الاختبار " + sfx).update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("s", site).param("o", org).update();
        UUID recorder = person("rec", role("REC", "ORGANIZATION", "VIEW"), org);
        jdbc.sql("""
                insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
                values (:id, :o, :s, 'PERMANENT', '2026-01-01T00:00:00Z', 'CORRECTION', 'تمركز اختبار القائمة', :by)""")
                .param("id", UUID.randomUUID()).param("o", org).param("s", site).param("by", recorder).update();
        return site;
    }

    private static Set<String> ids(JsonNode units) {
        Set<String> out = new HashSet<>();
        units.forEach(u -> out.add(u.path("id").asText()));
        return out;
    }

    @Test
    @DisplayName("HUB-1: a stationed unit beyond the first 300 of the reach is offered; a retired unit is not; the totals are stated")
    void stationedUnitsBeyondTheCapAreOffered() {
        UUID root = org("HUBROOT", null);
        for (int i = 0; i < 305; i++) {
            org(String.format("F%03d", i), root);
        }
        UUID late = org("ZZZ", root);           // sorts after every F### sibling
        UUID retired = org("RET", root);
        jdbc.sql("update organization set status = 'RETIRED', valid_to = now() where id = :id").param("id", retired).update();
        stationing(late);
        String requester = role("RS", "ORGANIZATION", "CREATE_RESTATIONING", "VIEW");
        person("req", requester, root);
        Api req = login("req");

        JsonNode hub = req.get("/request-hub").body();
        Set<String> offered = ids(hub.path("units"));
        assertThat(offered).as("the stationed unit, beyond position 300").contains(late.toString());
        assertThat(offered).as("a retired unit is never offered for a new request").doesNotContain(retired.toString());
        assertThat(offered).as("its parent stays, so the hierarchy is whole").contains(root.toString());
        assertThat(hub.path("unitsTotal").asInt()).as("root + 305 + the stationed unit").isEqualTo(307);
        assertThat(hub.path("unitsShown").asInt()).isEqualTo(hub.path("units").size());
        for (JsonNode u : hub.path("units")) {
            if (u.path("id").asText().equals(late.toString())) {
                assertThat(u.path("state").asText()).isNotEqualTo("NO_STATIONING");
            }
        }

        Set<String> requestable = ids(req.get("/restationing-requests/units").body());
        assertThat(requestable).contains(late.toString()).doesNotContain(retired.toString());
        assertThat(requestable).hasSize(307);
    }
}
