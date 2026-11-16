package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/** «إضافة مستخدم» to a unit's matrix, as in TNQL's access workspace (owner, 11 Nov 2026; ADR-049, V33). */
class UnitMemberIT extends IntegrationTest {

    UUID root, orgA, orgA1, orgB, admin, mgr, mgrB, viewerA1, hrA1, hrB;
    String viewer, mgrRole;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        orgA = org("A", root);
        orgA1 = org("A1", orgA);
        orgB = org("B", root);
        viewer = role("VIEWER", "ORGANIZATION", "VIEW");
        mgrRole = role("ACCMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        jdbc.sql("update role_def set grantable_roles = string_to_array(:g, ',') where code = :c").param("g", viewer).param("c", mgrRole).update();
        admin = person("admin", "SYSTEM_ADMIN", root);
        mgr = person("mgr", mgrRole, orgA);
        mgrB = person("mgrb", mgrRole, orgB);
        viewerA1 = person("va1", viewer, orgA1);
        hrA1 = hrPerson("hra1", orgA1);
        hrB = hrPerson("hrb", orgB);
    }

    /** A person from the HR mirror, posted in the given unit, with no grant. */
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

    private Res lookup(Api a, UUID org, String key) {
        return a.get("/access/unit-members/lookup?organizationId=" + org + "&key=" + java.net.URLEncoder.encode(key, java.nio.charset.StandardCharsets.UTF_8));
    }

    private Res add(Api a, UUID org, UUID person, String userId, String name) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("organizationId", org.toString());
        body.put("personId", person == null ? null : person.toString());
        body.put("userId", userId);
        body.put("displayName", name);
        return a.post("/access/unit-members", body);
    }

    private JsonNode row(Api a, UUID org, UUID person) {
        for (JsonNode p : a.get("/access/unit-matrix?organizationId=" + org).body().path("people")) {
            if (p.path("id").asText().equals(person.toString())) {
                return p;
            }
        }
        return null;
    }

    @Test
    @DisplayName("UM-1: the HR card is found by employee number or User ID, only inside the manager's directory")
    void lookupInsideReach() {
        Api m = login("mgr");
        Res byNo = lookup(m, orgA, "E-hra1-" + sfx);
        assertThat(byNo.status()).as(String.valueOf(byNo.body())).isEqualTo(200);
        assertThat(byNo.body().path("personId").asText()).isEqualTo(hrA1.toString());
        assertThat(byNo.body().path("displayName").asText()).isEqualTo("موظف hra1");
        assertThat(byNo.body().path("unitName").asText()).isEqualTo("جهة A1");
        assertThat(byNo.body().path("inUnit").asBoolean()).isFalse();
        assertThat(byNo.body().path("acting").asBoolean()).as("posted in a sub-unit: added to A acting").isTrue();
        assertThat(lookup(m, orgA, "HRA1-" + sfx).body().path("personId").asText()).as("by User ID, any case").isEqualTo(hrA1.toString());
        // posted in A1 is not being one of A1's users (owner, 16 Nov 2026): the card offers to add them, not acting
        assertThat(lookup(m, orgA1, "E-hra1-" + sfx).body().path("inUnit").asBoolean()).as("posted in A1, not yet a user").isFalse();
        assertThat(lookup(m, orgA1, "E-hra1-" + sfx).body().path("acting").asBoolean()).isFalse();

        // outside the directory, unknown: the same answer, so the search reveals nothing
        Res outside = lookup(m, orgA, "E-hrb-" + sfx);
        Res unknown = lookup(m, orgA, "E-nobody-" + sfx);
        assertThat(outside.status()).isEqualTo(404);
        assertThat(unknown.status()).isEqualTo(404);
        assertThat(outside.body().path("message").asText()).isEqualTo(unknown.body().path("message").asText());
        // a unit the manager does not manage, and a person without MANAGE_ACCESS
        assertThat(lookup(m, orgB, "E-hrb-" + sfx).status()).isEqualTo(404);
        assertThat(lookup(login("va1"), orgA1, "E-hra1-" + sfx).status()).isEqualTo(403);
        // the global administrator finds anyone
        assertThat(lookup(login("admin"), orgA, "E-hrb-" + sfx).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("UM-2: an HR person added to a unit appears in its matrix with no role; adding again changes nothing")
    void addHrPerson() {
        Api m = login("mgr");
        Res r = add(m, orgA, hrA1, null, null);
        assertThat(r.status()).as(String.valueOf(r.body())).isEqualTo(200);
        assertThat(r.body().path("already").asBoolean()).isFalse();
        JsonNode row = row(m, orgA, hrA1);
        assertThat(row).as("the new row").isNotNull();
        assertThat(row.path("added").asBoolean()).isTrue();
        assertThat(row.path("acting").asBoolean()).isTrue();
        assertThat(row.path("grants").size()).as("no role").isZero();
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", hrA1).query(Long.class).single()).isZero();
        assertThat(add(m, orgA, hrA1, null, null).body().path("already").asBoolean()).isTrue();
        assertThat(jdbc.sql("select count(*) from unit_member where person_id = :p and ended_at is null").param("p", hrA1).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'UNIT_MEMBER_ADDED' and entity_id = :p").param("p", hrA1.toString())
                .query(Long.class).single()).isEqualTo(1);
        // someone outside the manager's directory cannot be added by id
        assertThat(add(m, orgA, hrB, null, null).status()).isEqualTo(404);

        // the cells are ticked afterwards through the existing grant rules
        Map<String, Object> grant = new LinkedHashMap<>();
        grant.put("personId", hrA1.toString());
        grant.put("organizationId", orgA.toString());
        grant.put("roleCode", viewer);
        grant.put("scope", Map.of("mode", "ROLE"));
        assertThat(m.post("/memberships", grant).status()).isEqualTo(200);
        assertThat(row(m, orgA, hrA1).path("grants").size()).isEqualTo(1);
    }

    @Test
    @DisplayName("UM-3: a User ID without HR becomes a LOCAL account in the unit; nobody takes over another manager's account")
    void addUserIdWithoutHr() {
        Api m = login("mgr");
        String login = "u" + sfx;
        Res r = add(m, orgA, null, "DOMAIN\\U" + sfx, "مستخدم بلا موارد");
        assertThat(r.status()).as(String.valueOf(r.body())).isEqualTo(200);
        assertThat(r.body().path("created").asBoolean()).isTrue();
        UUID local = UUID.fromString(r.body().path("personId").asText());
        Map<String, Object> p = jdbc.sql("select source, employee_no, username, display_name, status from person where id = :p").param("p", local).query().singleRow();
        assertThat(p).containsEntry("source", "LOCAL").containsEntry("employee_no", "USER-" + login).containsEntry("username", login)
                .containsEntry("display_name", "مستخدم بلا موارد").containsEntry("status", "ACTIVE");
        JsonNode row = row(m, orgA, local);
        assertThat(row.path("withoutHr").asBoolean()).isTrue();
        assertThat(row.path("employeeNo").asText()).as("shown by its login").isEqualTo(login);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'LOCAL_USER_CREATED' and entity_id = :p").param("p", local.toString())
                .query(Long.class).single()).isEqualTo(1);

        // invalid, reserved by HR, or another manager's account: refused
        assertThat(add(m, orgA, null, "bad login!", null).status()).isEqualTo(400);
        assertThat(add(m, orgA, null, "hra1-" + sfx, null).status()).as("an HR person is added from HR").isEqualTo(400);
        assertThat(add(login("mgrb"), orgB, null, login, null).status()).as("outside B's reach").isEqualTo(400);
        assertThat(jdbc.sql("select count(*) from unit_member where person_id = :p and ended_at is null").param("p", local).query(Long.class).single()).isEqualTo(1);
        // the global administrator may add the same account to another unit; it stays one person
        Res again = add(login("admin"), orgB, null, login, null);
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.body().path("personId").asText()).isEqualTo(local.toString());
        assertThat(jdbc.sql("select count(*) from person where username = :l").param("l", login).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("UM-4: removing an added person ends the entry with a reason; grants are not touched")
    void endEntry() {
        Api m = login("mgr");
        UUID local = UUID.fromString(add(m, orgA, null, "end" + sfx, null).body().path("personId").asText());
        assertThat(m.post("/access/unit-members/" + local + "/end", Map.of("organizationId", orgA.toString(), "reason", "")).status()).isEqualTo(400);
        assertThat(m.post("/access/unit-members/" + local + "/end", Map.of("organizationId", orgA.toString(), "reason", "أضيف بالخطأ")).status()).isEqualTo(204);
        assertThat(row(m, orgA, local)).isNull();
        assertThat(m.post("/access/unit-members/" + local + "/end", Map.of("organizationId", orgA.toString(), "reason", "مرة ثانية")).status()).isEqualTo(404);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'UNIT_MEMBER_ENDED' and entity_id = :p").param("p", local.toString())
                .query(Long.class).single()).isEqualTo(1);
        // another manager's unit is not theirs to change
        UUID inB = UUID.fromString(add(login("admin"), orgB, null, "inb" + sfx, null).body().path("personId").asText());
        assertThat(m.post("/access/unit-members/" + inB + "/end", Map.of("organizationId", orgB.toString(), "reason", "ليست وحدتي")).status()).isEqualTo(404);
    }
}
