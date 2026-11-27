package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

import ae.mover.security.SessionFilter;

/**
 * ADR-108: inside another site's frame the browser keeps and sends only SameSite=None cookies. With https (Secure cookies)
 * and an allowed embedding site, the sign-in cookie is SameSite=None so a framed TMRKZ stays signed in; with no allowed site
 * it stays Strict, as before. Plain http keeps Strict whatever the list says (covered by every other class: secure-cookie=false).
 */
@TestPropertySource(properties = "mover.security.secure-cookie=true")
class EmbeddedSignInIT extends IntegrationTest {

    @AfterEach
    void noEmbedding() {
        jdbc.sql("delete from system_setting where key = 'EMBEDDING_ALLOWED_ORIGINS'").update();
    }

    /** The Set-Cookie of the session cookie the server writes on logout (the same builder as every sign-in route). */
    private String sessionCookieOnLogout(UUID person) throws Exception {
        String token = auth.issueSession(person, "test-issuer", null, Instant.now(), "127.0.0.1", "acceptance-test").token();
        HttpResponse<String> r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/auth/logout"))
                .header("Cookie", SessionFilter.COOKIE + "=" + token).header("X-Requested-With", "mover")
                .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(r.statusCode()).isEqualTo(200);
        return r.headers().allValues("Set-Cookie").stream().filter(c -> c.startsWith(SessionFilter.COOKIE + "=")).findFirst().orElseThrow();
    }

    @Test
    void anAllowedEmbeddingSiteMakesTheSignInCookieUsableInsideItsFrame() throws Exception {
        UUID person = person("embed", "REQUESTER", org("EMB", null));
        assertThat(sessionCookieOnLogout(person)).contains("Secure").contains("SameSite=Strict");

        jdbc.sql("insert into system_setting (key, value) values ('EMBEDDING_ALLOWED_ORIGINS', 'https://portal.example')").update();
        assertThat(sessionCookieOnLogout(person)).contains("Secure").contains("HttpOnly").contains("SameSite=None");
        // writes from another site still need the header it cannot send
        HttpResponse<String> forged = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/auth/logout"))
                .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(forged.statusCode()).isEqualTo(403);
    }
}
