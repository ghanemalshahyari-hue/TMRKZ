package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * «معتمد السلسلة الهرمية» as TNQL's (owner, 16 Nov 2026; ADR-061): a «تعيين» cell; a level — «هذا المستوى فقط», the default when
 * no unit is chosen — or a level with every unit below it; never every unit, chosen levels or sites; never a main unit.
 */
class ChainApproverScopeIT extends IntegrationTest {

    UUID main, level1, level2, admin, grantee;

    @BeforeEach
    void fixtures() {
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order)
                values ('CHAIN_APPROVER', 'معتمد السلسلة الهرمية', array['VIEW','REVIEW'], 'ORGANIZATION', false, 951) on conflict (code) do nothing""").update();
        UUID snapshot = publishedSnapshot();
        main = hrOrg("MAIN", null, true, snapshot);
        level1 = hrOrg("L1", main, false, snapshot);
        level2 = hrOrg("L2", level1, false, snapshot);
        admin = person("cadmin", "SYSTEM_ADMIN", main);
        grantee = person("cgrantee", role("CVIEW", "ORGANIZATION", "VIEW"), level1);
    }

    private UUID publishedSnapshot() {
        UUID s = jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).optional().orElse(null);
        if (s != null) {
            return s;
        }
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        s = UUID.randomUUID();
        jdbc.sql("insert into hr_source(id, name) values (:id, 'مصدر اختبار')").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'DRAFT', '{}', '{}')")
                .param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, trigger, status, started_at) values (:id, 'MANUAL', 'SUCCEEDED', now())").param("id", run).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())")
                .param("id", s).param("r", run).param("m", mapping).update();
        return s;
    }

    private UUID hrOrg(String code, UUID parent, boolean isMain, UUID snapshot) {
        UUID id = UUID.randomUUID();
        String ext = "C-" + code + "-" + sfx;
        jdbc.sql("""
                insert into organization(id, code, name, parent_id, valid_from, source, source_external_id)
                values (:id, :c, :n, :p, '2026-01-01T00:00:00Z', 'HR', :e)""")
                .param("id", id).param("c", ext).param("n", "وحدة " + code).param("p", parent).param("e", ext).update();
        jdbc.sql("insert into hr_unit(snapshot_id, external_id, name, active, is_main) values (:s, :e, :n, true, :m)")
                .param("s", snapshot).param("e", ext).param("n", "وحدة " + code).param("m", isMain).update();
        return id;
    }

    private Res grant(Map<String, Object> scope) {
        Map<String, Object> body = new java.util.LinkedHashMap<>(Map.of("personId", grantee.toString(), "organizationId", level1.toString(),
                "roleCode", "CHAIN_APPROVER"));
        if (scope != null) {
            body.put("scope", scope);
        }
        return login("cadmin").post("/memberships", body);
    }

    private static Map<String, Object> custom(UUID org, boolean branch, List<Integer> levels) {
        return Map.of("mode", "CUSTOM", "all", false, "targets",
                List.of(Map.of("kind", "ORGANIZATION", "id", org.toString(), "includeDescendants", branch, "levels", levels)));
    }

    private List<Map<String, Object>> targets() {
        return jdbc.sql("""
                select t.target_id, t.include_descendants from membership m join membership_scope_target t on t.membership_id = m.id
                 where m.person_id = :p and m.role_code = 'CHAIN_APPROVER' and m.valid_to is null""")
                .param("p", grantee).query().listOfRows();
    }

    @Test
    @DisplayName("CH-1 no unit chosen: «هذا المستوى فقط» — the home level, without the units below it")
    void noScopeIsThisLevelOnly() {
        assertThat(grant(null).status()).isEqualTo(200);
        assertThat(targets()).singleElement().satisfies(t -> {
            assertThat(t.get("target_id")).isEqualTo(level1);
            assertThat(t.get("include_descendants")).isEqualTo(false);
        });
    }

    @Test
    @DisplayName("CH-2 «هذا المستوى ومع جميع الوحدات التابعة» is kept as chosen")
    void branchIsKept() {
        assertThat(grant(custom(level1, true, List.of())).status()).isEqualTo(200);
        assertThat(targets()).singleElement().satisfies(t -> assertThat(t.get("include_descendants")).isEqualTo(true));
    }

    @Test
    @DisplayName("CH-3 never every unit, chosen levels or sites")
    void noAllNoLevels() {
        Res all = grant(Map.of("mode", "CUSTOM", "all", true, "targets", List.of()));
        assertThat(all.status()).isEqualTo(400);
        assertThat(all.body().path("message").asText()).contains("معتمد السلسلة الهرمية يُعيَّن على مستوى بعينه");
        assertThat(grant(custom(level1, true, List.of(3))).status()).isIn(400, 422);
        assertThat(targets()).isEmpty();
    }

    @Test
    @DisplayName("CH-4 a main unit is not a level in the chain")
    void mainUnitRefused() {
        Res r = grant(custom(main, false, List.of()));
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.body().path("message").asText()).isEqualTo("الوحدة الرئيسية ليست مستوى في السلسلة الهرمية — اختر مستوى تحتها");
        assertThat(targets()).isEmpty();
    }

    @Test
    @DisplayName("CH-5 the matrix offers it as a «تعيين» cell, saved at once, not as a staged tick")
    void assignColumn() {
        JsonNode m = login("cadmin").get("/access/workspace/units/" + level1 + "/matrix").body();
        JsonNode col = null;
        for (JsonNode c : m.path("columns")) {
            if ("CHAIN_APPROVER".equals(c.path("code").asText())) {
                col = c;
            }
        }
        assertThat(col).as("the chain approver column").isNotNull();
        assertThat(col.path("mode").asText()).isEqualTo("ASSIGN");
    }
}
