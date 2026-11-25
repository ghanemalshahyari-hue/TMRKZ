package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * ADR-105: «مديرو النظام» finds a directory account that never signed in — here through the directory's read-only service
 * account — shows it for confirmation, and on confirmation creates the person exactly as their first sign-in would (one record,
 * linked by the directory's stable identifier, so their later sign-in lands on it). Duplicates are refused; global only.
 */
class AdministratorDirectoryLookupIT extends IntegrationTest {

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final String PASSWORD = "Lookup#Directory-Pass-1";

    @DynamicPropertySource
    static void directory(DynamicPropertyRegistry r) {
        r.add("tmrkz.ldap.url", () -> "ldap://localhost:" + DirectorySignInIT.LDAP.getListenPort());
        r.add("tmrkz.ldap.start-tls", () -> "true");
        r.add("tmrkz.ldap.bind-dn", () -> "cn=service," + DirectorySignInIT.BASE);
        r.add("tmrkz.ldap.bind-credential", () -> "service-secret");
        r.add("tmrkz.ldap.users-dn", () -> DirectorySignInIT.BASE);
        r.add("tmrkz.ldap.ca-dir", DirectorySignInIT.CA_DIR::toString);
    }

    UUID root;
    Api admin;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
    }

    private void entry(String login, String number) throws Exception {
        DirectorySignInIT.LDAP.add("dn: uid=" + login + "," + DirectorySignInIT.PEOPLE, "objectClass: inetOrgPerson", "uid: " + login,
                "cn: Directory person " + login, "sn: Test", "employeeNumber: " + number, "userPassword: " + PASSWORD);
    }

    @Test
    @DisplayName("ADM-L1 service account: found before any sign-in, confirmed, created as the first sign-in would; that sign-in lands on it; duplicates refused")
    void lookupBeforeFirstSignIn() throws Exception {
        person("cfg", role("CFG", "ORGANIZATION", "VIEW", "CONFIGURE"), root);
        assertThat(login("cfg").get("/administrators/lookup-options").status()).isEqualTo(403);
        JsonNode options = admin.get("/administrators/lookup-options").body();
        assertThat(options.path("directoryMode").asText()).isEqualTo("SERVICE_ACCOUNT");

        String login = "newadm" + sfx;
        entry(login, "E9-" + sfx);
        Res found = admin.post("/administrators/resolve", Map.of("method", "DIRECTORY_ACCOUNT", "value", login));
        assertThat(found.status()).as(found.toString()).isEqualTo(200);
        assertThat(found.body().path("verifiedBy").asText()).isEqualTo("DIRECTORY_SERVICE_LOOKUP");
        assertThat(found.body().path("personId").isNull() || found.body().path("personId").asText().isEmpty()).isTrue();
        assertThat(found.body().path("employeeNumber").asText()).isEqualTo("E9-" + sfx);
        assertThat(found.body().path("displayName").asText()).contains(login);
        assertThat(jdbc.sql("select count(*) from person where lower(username) = :l").param("l", login).query(Long.class).single())
                .as("nothing is created by looking").isZero();

        assertThat(admin.post("/administrators", Map.of("method", "DIRECTORY_ACCOUNT", "value", login, "confirmation", "0".repeat(64),
                "reason", "مدير جديد")).status()).isEqualTo(409);
        Res added = admin.post("/administrators", Map.of("method", "DIRECTORY_ACCOUNT", "value", login,
                "confirmation", found.body().path("confirmation").asText(), "reason", "مدير نظام للفرع"));
        assertThat(added.status()).as(added.toString()).isEqualTo(200);
        UUID person = UUID.fromString(added.body().path("personId").asText());
        Map<String, Object> link = jdbc.sql("select issuer, subject, method from identity_link where person_id = :p").param("p", person).query().singleRow();
        assertThat(link.get("method")).isEqualTo("DIRECTORY");
        assertThat(link.get("issuer")).isEqualTo("urn:tmrkz:directory");
        String entryUuid = DirectorySignInIT.LDAP.getEntry("uid=" + login + "," + DirectorySignInIT.PEOPLE, "entryUUID").getAttributeValue("entryUUID");
        assertThat(String.valueOf(link.get("subject"))).isEqualToIgnoringCase(entryUuid);
        assertThat(jdbc.sql("select detail::text from audit_event where action = 'ADMIN_GRANTED' and entity_id = :p").param("p", person.toString())
                .query(String.class).single()).contains("DIRECTORY_SERVICE_LOOKUP").contains("\"createdFromDirectory\": true");

        // their own first sign-in lands on the same record
        HttpResponse<String> signIn = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port
                        + "/api/v1/auth/directory/login")).header("Content-Type", "application/json").header("X-Requested-With", "mover")
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(Map.of("username", login, "password", PASSWORD)))).build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(signIn.statusCode()).as(signIn.body()).isEqualTo(200);
        assertThat(MAPPER.readTree(signIn.body()).path("id").asText()).isEqualTo(person.toString());
        assertThat(jdbc.sql("select count(*) from person where lower(username) = :l").param("l", login).query(Long.class).single()).isEqualTo(1);

        // not in the directory; already held by another TMRKZ record
        Res missing = admin.post("/administrators/resolve", Map.of("method", "DIRECTORY_ACCOUNT", "value", "nobody" + sfx));
        assertThat(missing.status()).isEqualTo(404);
        assertThat(missing.toString()).contains("NOT_IN_DIRECTORY");
        String dupe = "dupe" + sfx;
        entry(dupe, "E8-" + sfx);
        jdbc.sql("insert into person(id, employee_no, display_name, username, source) values (:id, :e, 'سجل قائم', :u, 'LOCAL')")
                .param("id", UUID.randomUUID()).param("e", "X-" + sfx).param("u", dupe).update();
        Res held = admin.post("/administrators/resolve", Map.of("method", "DIRECTORY_ACCOUNT", "value", dupe));
        assertThat(held.status()).isEqualTo(400);
        assertThat(held.toString()).contains("سجل آخر");
        assertThat(login("cfg").post("/administrators/resolve", Map.of("method", "DIRECTORY_ACCOUNT", "value", login)).status()).isEqualTo(403);
    }
}
