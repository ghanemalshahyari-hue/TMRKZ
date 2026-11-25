package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * ADR-105 with ADR-100's directory (no service account, each person binds as themselves): an administrator who signed in with
 * the directory can look up an account that never signed in by typing their OWN directory password for that one search (never
 * stored, never audited); a wrong password is refused and counted; an administrator not signed in with the directory is told why
 * the lookup is not possible instead of being given a way around it.
 */
class AdministratorOwnLookupIT extends IntegrationTest {

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final String PASSWORD = "Own#Directory-Pass-1";

    @DynamicPropertySource
    static void directory(DynamicPropertyRegistry r) {
        r.add("tmrkz.ldap.url", () -> "ldap://localhost:" + DirectorySignInIT.LDAP.getListenPort());
        r.add("tmrkz.ldap.start-tls", () -> "true");
        r.add("tmrkz.ldap.users-dn", () -> DirectorySignInIT.BASE);
        r.add("tmrkz.ldap.ca-dir", DirectorySignInIT.CA_DIR::toString);
        r.add("tmrkz.ldap.username-attribute", () -> "uid");
        r.add("tmrkz.ldap.uuid-attribute", () -> "entryUUID");
        r.add("tmrkz.ldap.employee-number-attribute", () -> "employeeNumber");
        r.add("tmrkz.ldap.direct-bind-pattern", () -> "uid={username}," + DirectorySignInIT.PEOPLE);
    }

    private void entry(String login) throws Exception {
        DirectorySignInIT.LDAP.add("dn: uid=" + login + "," + DirectorySignInIT.PEOPLE, "objectClass: inetOrgPerson", "uid: " + login,
                "cn: Directory person " + login, "sn: Test", "employeeNumber: N-" + login, "userPassword: " + PASSWORD);
    }

    @Test
    @DisplayName("ADM-L2 no service account: the administrator's own directory password, for this search only; refused when wrong; explained when impossible")
    void lookupWithOwnAccount() throws Exception {
        UUID root = org("ROOT", null);
        String boss = "boss-" + sfx;
        entry(boss);
        HttpResponse<String> signIn = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port
                        + "/api/v1/auth/directory/login")).header("Content-Type", "application/json").header("X-Requested-With", "mover")
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(Map.of("username", boss, "password", PASSWORD)))).build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(signIn.statusCode()).as(signIn.body()).isEqualTo(200);
        UUID bossId = UUID.fromString(MAPPER.readTree(signIn.body()).path("id").asText());
        membership(bossId, "SYSTEM_ADMIN", root, null);
        Api adm = login("boss");

        JsonNode options = adm.get("/administrators/lookup-options").body();
        assertThat(options.path("directoryMode").asText()).isEqualTo("OWN_ACCOUNT");
        assertThat(options.path("directoryNeedsPassword").asBoolean()).isTrue();

        String newcomer = "newcomer" + sfx;
        entry(newcomer);
        Res ask = adm.post("/administrators/resolve", Map.of("method", "DIRECTORY_ACCOUNT", "value", newcomer));
        assertThat(ask.status()).isEqualTo(400);
        assertThat(ask.toString()).contains("PASSWORD_REQUIRED");
        Res wrong = adm.post("/administrators/resolve", Map.of("method", "DIRECTORY_ACCOUNT", "value", newcomer, "directoryPassword", "wrong-" + sfx));
        assertThat(wrong.status()).isEqualTo(403);
        assertThat(wrong.toString()).contains("PASSWORD_REFUSED");
        Res found = adm.post("/administrators/resolve", Map.of("method", "DIRECTORY_ACCOUNT", "value", newcomer, "directoryPassword", PASSWORD));
        assertThat(found.status()).as(found.toString()).isEqualTo(200);
        assertThat(found.body().path("verifiedBy").asText()).isEqualTo("DIRECTORY_OWN_ACCOUNT_LOOKUP");
        Res added = adm.post("/administrators", Map.of("method", "DIRECTORY_ACCOUNT", "value", newcomer,
                "confirmation", found.body().path("confirmation").asText(), "reason", "مدير نظام جديد"));
        assertThat(added.status()).as(added.toString()).isEqualTo(200);
        assertThat(jdbc.sql("select method from identity_link where person_id = :p").param("p", UUID.fromString(added.body().path("personId").asText()))
                .query(String.class).single()).isEqualTo("DIRECTORY");
        assertThat(jdbc.sql("select count(*) from audit_event where detail::text like :p or coalesce(reason, '') like :p")
                .param("p", "%" + PASSWORD + "%").query(Long.class).single()).as("the password is never recorded").isZero();

        // an administrator who did not sign in with the directory: no way to search, and told so
        person("plat", "SYSTEM_ADMIN", root);
        Api plat = login("plat");
        assertThat(plat.get("/administrators/lookup-options").body().path("directoryNeedsPassword").asBoolean()).isFalse();
        entry("other" + sfx);
        Res impossible = plat.post("/administrators/resolve", Map.of("method", "DIRECTORY_ACCOUNT", "value", "other" + sfx, "directoryPassword", PASSWORD));
        assertThat(impossible.status()).isEqualTo(404);
        assertThat(impossible.toString()).contains("UNAVAILABLE_NOT_DIRECTORY_SESSION");
    }
}
