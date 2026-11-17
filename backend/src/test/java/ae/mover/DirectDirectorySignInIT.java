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

/** TNQL/Duty-style direct user bind on the real manual login endpoint, using a fictional StartTLS directory (ADR-070). */
class DirectDirectorySignInIT extends IntegrationTest {

    private static final String PASSWORD = "Direct#Directory-Pass-1";

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

    private Signed signIn(String username, String password) throws Exception {
        HttpResponse<String> r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(
                        "http://localhost:" + port + "/api/v1/auth/directory/login"))
                .header("Content-Type", "application/json").header("X-Requested-With", "mover")
                .POST(HttpRequest.BodyPublishers.ofString(write(Map.of("username", username, "password", password)))).build(),
                HttpResponse.BodyHandlers.ofString());
        String cookie = r.headers().allValues("Set-Cookie").stream().filter(c -> c.startsWith("MOVER_SESSION="))
                .map(c -> c.split(";")[0]).findFirst().orElse(null);
        return new Signed(r.statusCode(), r.body().isEmpty() ? null : JSON.readTree(r.body()), cookie);
    }

    private HttpResponse<String> call(String cookie, String path, Object body) throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1" + path))
                .header("Content-Type", "application/json").header("X-Requested-With", "mover").header("Cookie", cookie)
                .POST(HttpRequest.BodyPublishers.ofString(write(body))).build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    @DisplayName("ADR-070: direct bind signs in the added User ID, rejects a bad password and reauthenticates by UUID + login")
    void directBindAndStepUp() throws Exception {
        String login = "direct" + sfx;
        DirectorySignInIT.LDAP.add("dn: uid=" + login + "," + DirectorySignInIT.PEOPLE,
                "objectClass: inetOrgPerson", "uid: " + login, "cn: Direct test " + login, "sn: Test",
                "employeeNumber: E-" + login, "userPassword: " + PASSWORD);
        UUID local = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username, source) values (:id, :e, :l, :l, 'LOCAL')")
                .param("id", local).param("e", "USER-" + login).param("l", login).update();

        Signed ok = signIn(login, PASSWORD);
        assertThat(ok.status()).as(String.valueOf(ok.body())).isEqualTo(200);
        assertThat(ok.cookie()).isNotNull();
        JsonNode me = JSON.readTree(HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(
                        "http://localhost:" + port + "/api/v1/me")).header("Cookie", ok.cookie()).GET().build(),
                HttpResponse.BodyHandlers.ofString()).body());
        assertThat(me.path("id").asText()).isEqualTo(local.toString());
        assertThat(me.path("signInMethod").asText()).isEqualTo("DIRECTORY");
        assertThat(me.path("permissions").size()).as("no role from authentication or direct bind").isZero();
        assertThat(jdbc.sql("select method from identity_link where person_id = :p").param("p", local).query(String.class).single())
                .isEqualTo("LOCAL_USER");
        assertThat(jdbc.sql("select count(*) from person_directory_profile where person_id = :p and issuer = 'urn:tmrkz:directory'")
                .param("p", local).query(Long.class).single()).isEqualTo(1);

        Signed wrong = signIn(login, "wrong-password");
        Signed unknown = signIn("unknown" + sfx, "anything");
        assertThat(wrong.status()).isEqualTo(401);
        assertThat(unknown.status()).isEqualTo(401);
        assertThat(wrong.cookie()).isNull();
        assertThat(unknown.cookie()).isNull();

        assertThat(call(ok.cookie(), "/auth/directory/reauth", Map.of("password", "wrong-password")).statusCode()).isEqualTo(403);
        assertThat(call(ok.cookie(), "/auth/directory/reauth", Map.of("password", PASSWORD)).statusCode()).as("UUID lookup and user bind")
                .isEqualTo(204);
        assertThat(jdbc.sql("select authenticated_at is not null from user_session where person_id = :p")
                .param("p", local).query(Boolean.class).single()).isTrue();
        assertThat(jdbc.sql("select * from person_directory_profile where person_id = :p").param("p", local).query().singleRow().toString())
                .doesNotContain(PASSWORD);
    }

    private record Signed(int status, JsonNode body, String cookie) {
    }
}
