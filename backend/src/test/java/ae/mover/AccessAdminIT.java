package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.Stations;
import ae.mover.workflow.PlaceResolver;
import ae.mover.workflow.WorkflowDefinition.Assignee;

/**
 * The rest of TNQL's access workspace (owner, 11 Nov 2026; ADR-059): the separate rights of an access manager and their
 * delegation, the final step tied to FINALIZE, duty permits, the account card, the providing departments of «معتمد التوفر»,
 * and approvers HR marks away.
 */
class AccessAdminIT extends IntegrationTest {

    @Autowired
    Stations stations;
    @Autowired
    PlaceResolver places;

    UUID root, orgA, orgA1, orgB, admin, mgr, hrA, hrA1, hrA2;
    String viewer, approver, mgrRole;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgA1 = org("A1", orgA);
        orgB = org("B", root);
        viewer = role("AVIEW", "ORGANIZATION", "VIEW");
        approver = role("AAPR", "ORGANIZATION", "VIEW", "REVIEW");
        mgrRole = role("AMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW", "REVIEW");
        jdbc.sql("update role_def set grantable_roles = string_to_array(:g, ',') where code = :c")
                .param("g", String.join(",", viewer, approver, mgrRole)).param("c", mgrRole).update();
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order)
                values ('ACCESS_FINAL_APPROVER', 'معتمد طلبات الصلاحية', '{REVIEW,APPROVE}', 'ALL', false, 9) on conflict (code) do nothing""").update();
        admin = person("admin", "SYSTEM_ADMIN", root);
        mgr = person("mgr", mgrRole, orgA);
        hrA = hrPerson("hra", orgA);
        hrA1 = hrPerson("hra1", orgA1);
        hrA2 = hrPerson("hra2", orgA1);
    }

    private UUID hrPerson(String code, UUID org) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into person(id, employee_no, display_name, username, source, source_external_id)
                values (:id, :e, :n, :u, 'HR', :x)""")
                .param("id", id).param("e", "E-" + code + "-" + sfx).param("n", "موظف " + code).param("u", code + "-" + sfx)
                .param("x", "X-" + code + "-" + sfx).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, position_title, valid_from) values (:id, :p, :o, 'وظيفة', '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("p", id).param("o", org).update();
        return id;
    }

    private Map<String, Object> grant(UUID person, UUID org, String role, List<String> rights, Instant validTo) {
        Map<String, Object> g = new LinkedHashMap<>();
        g.put("personId", person.toString());
        g.put("organizationId", org.toString());
        g.put("roleCode", role);
        g.put("scope", Map.of("mode", "CUSTOM", "targets", List.of(Map.of("kind", "ORGANIZATION", "id", org.toString(), "includeDescendants", true))));
        if (rights != null) {
            g.put("rights", rights);
        }
        if (validTo != null) {
            g.put("validTo", validTo.toString());
        }
        return g;
    }

    private UUID membershipOf(UUID person, String role) {
        return jdbc.sql("select id from membership where person_id = :p and role_code = :r and (valid_to is null or valid_to > now()) order by valid_from desc limit 1")
                .param("p", person).param("r", role).query(UUID.class).optional().orElse(null);
    }

    @Test
    @DisplayName("AA-1: an access manager acts only through the rights on their grant; a request is reviewed only by those holding «مراجعة طلبات الصلاحية»")
    void separateRights() {
        assertThat(login("admin").post("/memberships", grant(hrA, orgA, mgrRole, List.of("LOOKUP"), null)).status()).isEqualTo(200);
        Api a = login("hra");
        assertThat(a.get("/access/unit-members/lookup?organizationId=" + orgA1 + "&key=E-hra1-" + sfx).status()).as("LOOKUP").isEqualTo(200);
        Res given = a.post("/memberships", grant(hrA1, orgA1, viewer, null, null));
        assertThat(given.status()).isEqualTo(403);
        assertThat(String.valueOf(given.body())).contains("منح الصلاحيات");
        Map<String, Object> add = new LinkedHashMap<>();
        add.put("organizationId", orgA1.toString());
        add.put("userId", "local-" + sfx);
        add.put("displayName", "مستخدم محلي");
        assertThat(a.post("/access/unit-members", add).status()).as("ANNEXED").isEqualTo(403);
        assertThat(a.put("/access/unit-ops-routes?commandId=" + orgA, List.of()).status()).as("UNIT_OPERATIONS").isEqualTo(403);
        assertThat(places.scope(mgrRole, orgA1).people()).as("REVIEW: the manager with all rights reviews, the LOOKUP-only one does not")
                .contains(mgr).doesNotContain(hrA);
        JsonNode file = a.get("/access/workspace/units/" + orgA1).body();
        assertThat(file.path("myRights").toString()).contains("LOOKUP").doesNotContain("GRANT");
    }

    @Test
    @DisplayName("AA-2: delegation is never wider or longer than the delegating grant; only its issuer or a global manager ends it; it ends with its sponsor")
    void delegation() {
        Instant month = Instant.now().plus(30, ChronoUnit.DAYS);
        assertThat(login("admin").post("/memberships", grant(hrA, orgA, mgrRole, List.of("GRANT", "DELEGATE", "LOOKUP"), month)).status()).isEqualTo(200);
        UUID sponsor = membershipOf(hrA, mgrRole);
        Api a = login("hra");
        Res wider = a.post("/memberships", grant(hrA1, orgA1, mgrRole, List.of("GRANT", "ATTACH"), Instant.now().plus(10, ChronoUnit.DAYS)));
        assertThat(wider.status()).isEqualTo(403);
        assertThat(String.valueOf(wider.body())).contains("التفويض");
        assertThat(a.post("/memberships", grant(hrA1, orgA1, mgrRole, List.of("GRANT"), Instant.now().plus(60, ChronoUnit.DAYS))).status())
                .as("longer than the sponsor").isEqualTo(403);
        assertThat(a.post("/memberships", grant(hrA1, orgA1, mgrRole, List.of("GRANT"), null)).status()).as("open-ended under an ending sponsor").isEqualTo(403);
        Res ok = a.post("/memberships", grant(hrA1, orgA1, mgrRole, List.of("GRANT"), Instant.now().plus(10, ChronoUnit.DAYS)));
        assertThat(ok.status()).as(String.valueOf(ok.body())).isEqualTo(200);
        UUID delegated = membershipOf(hrA1, mgrRole);
        assertThat(jdbc.sql("select sponsor_id from membership where id = :id").param("id", delegated).query(UUID.class).single()).isEqualTo(sponsor);
        assertThat(login("hra1").post("/memberships", grant(hrA2, orgA1, viewer, null, null)).status()).as("the delegate grants").isEqualTo(200);
        Res notIssuer = login("mgr").post("/memberships/" + delegated + "/end", Map.of("reason", "ليس المصدر"));
        assertThat(notIssuer.status()).isEqualTo(403);
        assertThat(String.valueOf(notIssuer.body())).contains("من أصدرها");
        assertThat(login("admin").post("/memberships/" + sponsor + "/end", Map.of("reason", "انتهى التكليف")).status()).isEqualTo(200);
        assertThat(membershipOf(hrA1, mgrRole)).as("the delegation ended with its sponsor").isNull();
    }

    @Test
    @DisplayName("AA-3: FINALIZE gives the final step of permission requests over the same units, tied to the grant and ended with it")
    void finalizeCompanion() {
        assertThat(login("admin").post("/memberships", grant(hrA, orgA, mgrRole, List.of("REVIEW", "FINALIZE"), null)).status()).isEqualTo(200);
        UUID sponsor = membershipOf(hrA, mgrRole);
        UUID companion = membershipOf(hrA, "ACCESS_FINAL_APPROVER");
        assertThat(companion).isNotNull();
        assertThat(jdbc.sql("select sponsor_id from membership where id = :id").param("id", companion).query(UUID.class).single()).isEqualTo(sponsor);
        assertThat(jdbc.sql("select target_id from membership_scope_target where membership_id = :id").param("id", companion).query(UUID.class).single()).isEqualTo(orgA);
        assertThat(login("admin").post("/memberships/" + sponsor + "/end", Map.of("reason", "انتهى")).status()).isEqualTo(200);
        assertThat(membershipOf(hrA, "ACCESS_FINAL_APPROVER")).isNull();
    }

    @Test
    @DisplayName("AA-4: a duty permit is issued by a DUTY holder for at most seven days, holds nothing until its holder activates it, and ends")
    void dutyPermits() {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("personId", hrA1.toString());
        p.put("organizationId", orgA1.toString());
        p.put("roleCode", approver);
        p.put("validTo", Instant.now().plus(8, ChronoUnit.HOURS).toString());
        p.put("reason", "مناوبة ليلية");
        Api m = login("mgr");
        Res issued = m.post("/access/permits", p);
        assertThat(issued.status()).as(String.valueOf(issued.body())).isEqualTo(200);
        assertThat(issued.body().path("state").asText()).isEqualTo("ISSUED");
        String id = issued.body().path("id").asText();
        Api holder = login("hra1");
        assertThat(holder.get("/me").body().path("grants").toString()).as("nothing before activation").doesNotContain(approver);
        assertThat(holder.post("/me/permits/" + id + "/activate", Map.of()).body().path("state").asText()).isEqualTo("ACTIVE");
        assertThat(login("hra1").get("/me").body().path("grants").toString()).contains(approver);
        JsonNode row = null;
        for (JsonNode r : m.get("/access/workspace/units/" + orgA1 + "/matrix").body().path("people")) {
            if (r.path("id").asText().equals(hrA1.toString())) {
                row = r;
            }
        }
        assertThat(row.path("cells").path(approver).path("temporary").asBoolean()).isTrue();
        assertThat(stations.of(approver, orgA1).people()).as("additive: the permit holder approves at the unit").contains(hrA1);

        Map<String, Object> week = new LinkedHashMap<>(p);
        week.put("validTo", Instant.now().plus(8, ChronoUnit.DAYS).toString());
        assertThat(m.post("/access/permits", week).status()).as("at most seven days").isEqualTo(400);
        assertThat(login("admin").post("/memberships", grant(hrA, orgA, mgrRole, List.of("LOOKUP"), null)).status()).isEqualTo(200);
        assertThat(login("hra").post("/access/permits", p).status()).as("without the DUTY right").isEqualTo(403);
        assertThat(holder.post("/me/permits/" + id + "/end", Map.of()).body().path("state").asText()).isEqualTo("ENDED");
        assertThat(login("hra1").get("/me").body().path("grants").toString()).doesNotContain(approver);
    }

    @Test
    @DisplayName("AA-5: the account card switches access off and on, edits only a local account, and retires a local account by a global manager only")
    void accountCard() {
        assertThat(login("mgr").post("/memberships", grant(hrA1, orgA1, viewer, null, null)).status()).isEqualTo(200);
        Api m = login("mgr");
        JsonNode card = m.get("/access/workspace/people/" + hrA1).body();
        assertThat(card.path("units").toString()).contains(orgA1.toString());
        assertThat(card.path("canEdit").asBoolean()).isTrue();
        assertThat(card.path("canEditProfile").asBoolean()).as("an HR record is edited in HR").isFalse();
        assertThat(m.put("/access/workspace/people/" + hrA1 + "/active", Map.of("active", false, "reason", "انتقال مؤقت")).status()).isEqualTo(200);
        assertThat(login("hra1").get("/me").body().path("grants").toString()).as("switched off: nothing held").doesNotContain(viewer);
        assertThat(m.put("/access/workspace/people/" + hrA1 + "/active", Map.of("active", true)).status()).isEqualTo(200);
        assertThat(login("hra1").get("/me").body().path("grants").toString()).contains(viewer);
        assertThat(m.put("/access/workspace/people/" + hrA1 + "/profile", Map.of("displayName", "اسم آخر")).status()).isEqualTo(403);

        Map<String, Object> add = new LinkedHashMap<>();
        add.put("organizationId", orgA1.toString());
        add.put("userId", "loc" + sfx);
        add.put("displayName", "مستخدم محلي");
        Res added = m.post("/access/unit-members", add);
        assertThat(added.status()).as(String.valueOf(added.body())).isEqualTo(200);
        UUID local = UUID.fromString(added.body().path("personId").asText());
        assertThat(m.put("/access/workspace/people/" + local + "/profile", Map.of("displayName", "مستخدم محلي معدّل")).status()).isEqualTo(200);
        assertThat(m.post("/access/workspace/people/" + local + "/retire", Map.of("reason", "انتهى العمل")).status()).as("a global manager only").isEqualTo(403);
        Res retired = login("admin").post("/access/workspace/people/" + local + "/retire", Map.of("reason", "انتهى العمل"));
        assertThat(retired.status()).isEqualTo(200);
        assertThat(retired.body().path("accessDisabled").asBoolean()).isTrue();
        assertThat(jdbc.sql("select count(*) from unit_member where person_id = :p and ended_at is null").param("p", local).query(Long.class).single()).isZero();
    }

    @Test
    @DisplayName("AA-6: a providing department is a published role; at a non-providing unit only a global manager gives it; steps go to the providing units")
    void providingDepartments() {
        Api admin = login("admin");
        if (jdbc.sql("select count(*) from access_policy_version where status = 'DRAFT'").query(Long.class).single() > 0) {
            admin.post("/access/policy/draft/discard", Map.of("reason", "تنظيف قبل الاختبار"));
        }
        String code = "T" + sfx.toUpperCase().replaceAll("[^A-Z0-9]", "");
        Res made = admin.post("/access/workspace/departments", Map.of("code", code, "name", "إدارة اختبار"));
        assertThat(made.status()).as(String.valueOf(made.body())).isEqualTo(200);
        String role = "AVAILABILITY_" + code;
        assertThat(made.body().toString()).contains(role);
        jdbc.sql("update role_def set grantable_roles = array_append(grantable_roles, :r) where code = :c").param("r", role).param("c", mgrRole).update();
        Api m = login("mgr");
        Map<String, Object> g = new LinkedHashMap<>();
        g.put("personId", hrA1.toString());
        g.put("organizationId", orgA1.toString());
        g.put("roleCode", role);
        Res standby = m.post("/memberships", g);
        assertThat(standby.status()).as("the unit does not provide it yet").isEqualTo(403);
        assertThat(String.valueOf(standby.body())).contains("ليست مزوّدة");
        assertThat(m.put("/access/workspace/units/" + orgA1 + "/providers", Map.of("roleCode", role, "on", true)).body().toString()).contains(role);
        assertThat(m.post("/memberships", g).status()).isEqualTo(200);
        Map<String, Object> b = new LinkedHashMap<>(g);
        b.put("personId", hrPerson("hrb", orgB).toString());
        b.put("organizationId", orgB.toString());
        assertThat(admin.post("/memberships", b).status()).as("a standby given by a global manager").isEqualTo(200);
        PlaceResolver.Place p = places.resolve(new Assignee(role, "PROVIDER"), orgA1, List.of());
        assertThat(p.orgs()).containsExactly(orgA1);
        JsonNode matrix = m.get("/access/workspace/units/" + orgA1 + "/matrix").body();
        assertThat(matrix.path("providers").toString()).contains(role);
    }

    @Test
    @DisplayName("AA-7: an approver HR marks away stays appointed — nothing is inherited past them — but the step does not go to them")
    void hrAway() {
        membership(hrA1, approver, orgA1, null);
        membership(hrA, approver, orgA, null);
        jdbc.sql("update person set hr_unavailable = 'إجازة' where id = :p").param("p", hrA1).update();
        Stations.Station st = stations.of(approver, orgA1);
        assertThat(st.appointed()).contains(hrA1);
        assertThat(st.people()).isEmpty();
        assertThat(st.away()).isTrue();
        assertThat(st.via()).as("not inherited from the unit above while its own approver is only away").isEqualTo(Stations.Via.EXPLICIT);
        jdbc.sql("update person set hr_unavailable = null where id = :p").param("p", hrA1).update();
        assertThat(stations.of(approver, orgA1).people()).contains(hrA1);
    }
}
