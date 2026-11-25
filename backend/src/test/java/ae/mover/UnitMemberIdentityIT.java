package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import ae.mover.common.ApiException;
import ae.mover.security.DirectoryProfile;
import ae.mover.security.IdentityService;
import ae.mover.security.OidcClient;

/**
 * ADR-103: the VM's «رقم المستخدم هذا مستخدم لحساب خارج نطاقك» and «سجل الشخص غير نشط في مصدر الموارد البشرية», reproduced with
 * fictional identities. A first directory sign-in while HR is not in force creates a LOCAL zero-access person whose employee
 * number is the directory's (or DIR-login), never USER-login (ADR-068); «إضافة مستخدم» by User ID accepted only USER- accounts
 * as its own, so even the global administrator was told the account was outside their scope. «حذف الحساب» switches an account
 * off and the sign-in then blamed HR. The scope bound itself and HR identity uniqueness are kept.
 */
class UnitMemberIdentityIT extends IntegrationTest {

    private static final String ISSUER = "http://idp.test/realms/tmrkz";

    @Autowired
    IdentityService identities;

    UUID root, orgA, orgB;

    @BeforeEach
    void fixtures() {
        // directory mode (ADR-068): no HR source in force, so a verified directory sign-in provisions a zero-access person
        jdbc.sql("update hr_source set enabled = false").update();
        root = org("ROOT", null);
        orgA = org("A", root);
        orgB = org("B", root);
        String mgrRole = role("ACCMGR", "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        person("admin", "SYSTEM_ADMIN", root);
        person("mgr", mgrRole, orgA);
    }

    /** A sign-in the directory has verified (the provider path), stating the directory's employee number. */
    private UUID firstDirectorySignIn(String login, String employeeNumber) {
        return identities.resolve(new OidcClient.Identity(ISSUER, "sub-" + login, login, "دخول " + login, login, Instant.now(), null,
                "LOGIN", "/", null, false, new DirectoryProfile(employeeNumber, null, null, null, null, null, true)));
    }

    private Res addByUserId(Api a, UUID org, String userId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("organizationId", org.toString());
        body.put("userId", userId);
        return a.post("/access/unit-members", body);
    }

    private long people(String login) {
        return jdbc.sql("select count(*) from person where lower(username) = :l").param("l", login).query(Long.class).single();
    }

    @Test
    @DisplayName("UMI-1: a person whose first directory sign-in created their record is added by User ID by the global administrator; a scoped manager is still bounded by scope")
    void directoryProvisionedPersonAddedByUserId() {
        String login = "u7" + sfx;
        UUID provisioned = firstDirectorySignIn(login, "7" + sfx.replaceAll("[^0-9]", "1"));
        Map<String, Object> p = jdbc.sql("select source, employee_no, status from person where id = :p").param("p", provisioned).query().singleRow();
        assertThat(p.get("source")).isEqualTo("LOCAL");
        assertThat((String) p.get("employee_no")).as("the directory's number, not USER-login").doesNotStartWith("USER-");

        // a scoped manager: the person is in none of their units, so the scope refusal is right and says so
        Res scoped = addByUserId(login("mgr"), orgA, login);
        assertThat(scoped.status()).isEqualTo(400);
        assertThat(scoped.body().path("message").asText()).contains("خارج نطاقك");

        // the global administrator reaches everyone: the incident's refusal is reproduced here before the fix
        Res global = addByUserId(login("admin"), orgA, login);
        assertThat(global.status()).as(String.valueOf(global.body())).isEqualTo(200);
        assertThat(global.body().path("personId").asText()).as("the same person, never a second record").isEqualTo(provisioned.toString());
        assertThat(people(login)).isEqualTo(1);

        // now a user of A: inside the scoped manager's reach, adding again changes nothing
        Res again = addByUserId(login("mgr"), orgA, login);
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.body().path("already").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("UMI-2: a refused User ID states the real reason — a removed account is not «outside your scope»; an HR employee's account still goes through HR (no duplicate identity)")
    void refusalsStateTheirReason() {
        String login = "u8" + sfx;
        UUID removed = firstDirectorySignIn(login, "8" + sfx.replaceAll("[^0-9]", "2"));
        Api admin = login("admin");
        assertThat(admin.post("/access/workspace/people/" + removed + "/retire", Map.of("reason", "حساب تجريبي أنهيت حاجته")).status())
                .isEqualTo(200);
        Res r = addByUserId(admin, orgA, login);
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.body().path("message").asText()).as("the account was removed, not out of scope")
                .doesNotContain("خارج نطاقك").contains("موقوف");

        // an HR employee keeps one identity: their account is added from the HR card, never as a second LOCAL account
        UUID hr = UUID.randomUUID();
        String hrLogin = "hr" + sfx;
        jdbc.sql("""
                insert into person(id, employee_no, display_name, username, source, source_external_id)
                values (:id, :e, 'موظف من الموارد', :u, 'HR', :x)""")
                .param("id", hr).param("e", "E-" + sfx).param("u", hrLogin).param("x", "X-" + sfx).update();
        Res dup = addByUserId(admin, orgB, hrLogin);
        assertThat(dup.status()).isEqualTo(400);
        assertThat(dup.body().path("message").asText()).contains("الموارد البشرية");
        assertThat(people(hrLogin)).isEqualTo(1);
    }

    @Test
    @DisplayName("UMI-3: the sign-in refusal names the real cause: removed in TMRKZ versus inactive in HR")
    void signInRefusalNamesTheCause() {
        UUID removed = firstDirectorySignIn("u9" + sfx, "9" + sfx.replaceAll("[^0-9]", "3"));
        assertThat(login("admin").post("/access/workspace/people/" + removed + "/retire", Map.of("reason", "انتهت الحاجة للحساب")).status())
                .isEqualTo(200);
        assertThatThrownBy(() -> auth.issueSession(removed, ISSUER, null, Instant.now(), "127.0.0.1", "t"))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getMessage()).doesNotContain("الموارد البشرية").contains("موقوف");
                    assertThat(e.details().get("reason")).isEqualTo("ACCOUNT_REMOVED");
                });

        UUID hrOff = UUID.randomUUID();
        jdbc.sql("""
                insert into person(id, employee_no, display_name, username, source, source_external_id, status)
                values (:id, :e, 'موظف غير نشط', :u, 'HR', :x, 'DISABLED')""")
                .param("id", hrOff).param("e", "EOFF-" + sfx).param("u", "hroff" + sfx).param("x", "XOFF-" + sfx).update();
        assertThatThrownBy(() -> auth.issueSession(hrOff, ISSUER, null, Instant.now(), "127.0.0.1", "t"))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getMessage()).contains("الموارد البشرية");
                    assertThat(e.details().get("reason")).isEqualTo("HR_INACTIVE");
                });
    }

    @Test
    @DisplayName("UMI-4: a removed local account is brought back by a global manager with a reason, audited, holding nothing until granted again")
    void removedAccountReinstated() {
        String login = "u6" + sfx;
        UUID removed = firstDirectorySignIn(login, "6" + sfx.replaceAll("[^0-9]", "4"));
        Api admin = login("admin");
        Map<String, Object> grant = new LinkedHashMap<>();
        grant.put("personId", removed.toString());
        grant.put("organizationId", orgA.toString());
        grant.put("roleCode", role("V", "ORGANIZATION", "VIEW"));
        assertThat(admin.post("/memberships", grant).status()).isEqualTo(200);
        assertThat(admin.post("/access/workspace/people/" + removed + "/retire", Map.of("reason", "أُنهي بالخطأ")).status()).isEqualTo(200);
        assertThat(admin.get("/access/workspace/people/" + removed).body().path("canReinstate").asBoolean()).isTrue();

        // a scoped manager cannot; a reason is required
        assertThat(login("mgr").post("/access/workspace/people/" + removed + "/reinstate", Map.of("reason", "إعادة")).status()).isIn(403, 404);
        assertThat(admin.post("/access/workspace/people/" + removed + "/reinstate", Map.of("reason", "")).status()).isEqualTo(400);

        Res back = admin.post("/access/workspace/people/" + removed + "/reinstate", Map.of("reason", "أُعيد بعد مراجعة المالك"));
        assertThat(back.status()).as(String.valueOf(back.body())).isEqualTo(200);
        Map<String, Object> p = jdbc.sql("select status, access_disabled from person where id = :p").param("p", removed).query().singleRow();
        assertThat(p).containsEntry("status", "ACTIVE").containsEntry("access_disabled", false);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p and (valid_to is null or valid_to > now())")
                .param("p", removed).query(Long.class).single()).as("grants are not given back").isZero();
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'PERSON_REINSTATED' and entity_id = :p and reason is not null")
                .param("p", removed.toString()).query(Long.class).single()).isEqualTo(1);
        assertThat(auth.issueSession(removed, ISSUER, null, Instant.now(), "127.0.0.1", "t").token()).isNotBlank();
        assertThat(addByUserId(admin, orgB, login).status()).isEqualTo(200);
    }
}
