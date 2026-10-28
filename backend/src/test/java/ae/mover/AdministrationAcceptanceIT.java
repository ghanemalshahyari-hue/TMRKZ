package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/** Signature failure, map coverage, structure import, site tree integrity (AT-27, 31, 32; R-01). */
class AdministrationAcceptanceIT extends IntegrationTest {

    UUID root, orgA, siteA, resA;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        siteA = site("SA", site("MAIN", null, root), orgA);
        resA = resource("RA", siteA, null, 0);
        person("req", "REQUESTER", orgA);
        person("apr", "APPROVER", root);
        person("admin", "SYSTEM_ADMIN", root);
    }

    @Test
    @DisplayName("AT-27: with PKI selected but no provider connected, approval fails closed and nothing is recorded")
    void signatureProviderUnavailable() {
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        Api admin = login("admin");
        JsonNode current = admin.get("/policies/current").body().path("settings");
        Map<String, Object> pki = JSON.convertValue(current, Map.class);
        pki.put("signatureMode", "PKI");
        try {
            Res d = admin.post("/policies/drafts", Map.of("settings", pki));
            assertThat(admin.post("/policy-versions/" + d.body().path("id").asText() + "/publish", Map.of()).status()).isEqualTo(200);
            Api req = login("req");
            UUID id = req.submitted(type, orgA, List.of(resA), day("2028-09-01"), day("2028-09-02"));
            Api apr = login("apr");
            Res r = apr.approve(apr.taskFor(id), 1);
            assertThat(r.status()).isEqualTo(503);
            assertThat(r.code()).isEqualTo("SIGNATURE_PROVIDER_UNAVAILABLE");
            assertThat(activeReservations(resA)).isZero();
            assertThat(jdbc.sql("select count(*) from decision where request_id = :id").param("id", id).query(Long.class).single()).isZero();
            assertThat(jdbc.sql("select status from request where id = :id").param("id", id).query(String.class).single()).isEqualTo("SUBMITTED");
        } finally {
            Map<String, Object> back = JSON.convertValue(current, Map.class);
            Res d = admin.post("/policies/drafts", Map.of("settings", back));
            admin.post("/policy-versions/" + d.body().path("id").asText() + "/publish", Map.of());
        }
    }

    @Test
    @DisplayName("Stored JSON documents (schemas, definitions) are returned as plain JSON to the studios and wizard")
    void storedDocumentsSerialiseAsJson() {
        String type = requestType("NEW_RESERVATION", finalOnly(), null);
        Api admin = login("admin");
        JsonNode wf = null;
        for (JsonNode item : admin.get("/workflows").body()) {
            if (item.path("requestType").path("code").asText().equals(type)) {
                wf = admin.get("/workflow-versions/" + item.path("published").path("id").asText()).body();
            }
        }
        assertThat(wf).isNotNull();
        assertThat(wf.path("definition").path("stages").isArray()).isTrue();
        assertThat(wf.path("definition").has("array")).isFalse();
        for (JsonNode t : admin.get("/request-types").body()) {
            assertThat(t.path("formVersion").path("schema").path("fields").isArray()).isTrue();
        }
        assertThat(admin.get("/reports/kpis?from=2026-09-27T20:00:00.000Z&to=2026-11-27T20:00:00.000Z").status()).isEqualTo(200);
    }

    @Test
    @DisplayName("AT-31: an area outside the installed map packages is reported as not covered")
    void mapCoverage() {
        Api req = login("req");
        JsonNode inside = req.get("/map/features?bbox=55.25,25.15,55.40,25.25").body();
        assertThat(inside.path("coverage").path("covered").asBoolean()).isTrue();
        JsonNode outside = req.get("/map/features?bbox=46.5,24.5,46.9,24.9").body();
        assertThat(outside.path("coverage").path("covered").asBoolean()).isFalse();
        assertThat(outside.path("coverage").path("message").asText()).contains("خارج حزم الخرائط المثبتة");
        JsonNode packages = req.get("/map/packages").body();
        assertThat(packages.size()).isGreaterThanOrEqualTo(1);
        assertThat(packages.get(0).path("license").asText()).isNotBlank();
        assertThat(packages.get(0).path("source").asText()).isNotBlank();
    }

    @Test
    @DisplayName("AT-32: importing a structure with a cycle or duplicate codes is reported in preview and writes nothing")
    void structureImport() {
        Api admin = login("admin");
        String p = "IMP" + sfx;
        long before = jdbc.sql("select count(*) from organization").query(Long.class).single();
        Res bad = admin.post("/integrations/org-structure/preview", Map.of("rows", List.of(
                Map.of("code", p + "-1", "name", "جهة 1", "parentCode", p + "-2"),
                Map.of("code", p + "-2", "name", "جهة 2", "parentCode", p + "-1"),
                Map.of("code", p + "-3", "name", "جهة 3", "parentCode", ""),
                Map.of("code", p + "-3", "name", "مكررة", "parentCode", ""))));
        assertThat(bad.body().path("valid").asBoolean()).isFalse();
        String errors = bad.body().path("errors").toString();
        assertThat(errors).contains("دورة").contains("مكرر");
        assertThat(admin.post("/integrations/org-structure/runs/" + bad.body().path("runId").asText() + "/commit", Map.of()).status())
                .isEqualTo(400);
        assertThat(jdbc.sql("select count(*) from organization").query(Long.class).single()).isEqualTo(before);

        Res good = admin.post("/integrations/org-structure/preview", Map.of("rows", List.of(
                Map.of("code", p + "-P", "name", "جهة أم", "parentCode", ""),
                Map.of("code", p + "-C", "name", "جهة فرعية", "parentCode", p + "-P"))));
        assertThat(good.body().path("valid").asBoolean()).isTrue();
        assertThat(admin.post("/integrations/org-structure/runs/" + good.body().path("runId").asText() + "/commit", Map.of()).status())
                .isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from organization where code like :p").param("p", p + "-%").query(Long.class).single()).isEqualTo(2);
    }

    @Test
    @DisplayName("R-01: the site tree rejects cycles and sites cannot be destructively deleted")
    void siteTree() {
        Api admin = login("admin");
        UUID child = site("CHILD", siteA, orgA);
        Res cycle = admin.post("/sites/" + siteA, Map.of());
        assertThat(cycle.status()).isIn(404, 405);
        Res update = admin.patch("/sites/" + siteA, Map.of());
        assertThat(update.status()).isIn(404, 405);
        var put = admin.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(admin.url("/sites/" + siteA)))
                .header("Content-Type", "application/json").header("X-Requested-With", "mover")
                .PUT(java.net.http.HttpRequest.BodyPublishers.ofString(write(Map.of("code", "SA-" + sfx, "name", "موقع SA",
                        "kind", "مرفق", "parentId", child.toString(), "responsibleOrgId", orgA.toString())))));
        assertThat(put.status()).isEqualTo(400);
        try {
            jdbc.sql("delete from site where id = :id").param("id", child).update();
            throw new AssertionError("delete should fail");
        } catch (org.springframework.dao.DataAccessException expected) {
            assertThat(expected.getMostSpecificCause().getMessage()).contains("cannot be deleted");
        }
        assertThat(admin.post("/sites/" + child + "/retire", Map.of()).status()).isEqualTo(204);
    }
}
