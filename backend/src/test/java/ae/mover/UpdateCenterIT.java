package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.CookieManager;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.update.UpdateService;

/**
 * ADR-104: the browser side of «مركز التحديث». The backend is a broker — authorised (global administrator), audited, step-up for
 * approve and rollback — that stores the signed release, accepts only the compared files with their signed SHA-256 and records
 * the approval for the maintenance worker; it never writes an application file. The worker's answers are simulated here by
 * writing its files into the staging directory; the worker itself is exercised end to end by tests/acceptance/update-center.mjs.
 */
class UpdateCenterIT extends IntegrationTest {

    static final Path STAGE;

    static {
        try {
            STAGE = Files.createTempDirectory("tmrkz-update-it");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @DynamicPropertySource
    static void stage(DynamicPropertyRegistry r) {
        r.add("tmrkz.update.dir", STAGE::toString);
    }

    @Autowired
    UpdateService updates;

    UUID root;
    Api admin;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
    }

    private static String sha(byte[] b) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
    }

    private Res put(Api api, String id, String path, byte[] body) {
        return api.send(HttpRequest.newBuilder(URI.create(api.url("/updates/sessions/" + id + "/files?path="
                        + java.net.URLEncoder.encode(path, StandardCharsets.UTF_8))))
                .header("Content-Type", "application/octet-stream").header("X-Requested-With", "mover")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(body)));
    }

    /** What the worker writes after a verified comparison. */
    private void compared(String id, String addedSha, int addedSize) throws Exception {
        Path s = STAGE.resolve("sessions").resolve(id);
        Files.writeString(s.resolve("compare.json"), """
                {"release":{"release":"r1"},"signature":"VALID","baseline":false,"unchanged":3,"counts":{"ADDED":1,"MODIFIED":0,"DELETED":1,"BLOCKED":1},
                 "changes":[{"path":"docs/new-%s.md","class":"docs","change":"ADDED","sha256":"%s","size":%d,"installedSha256":null,"blocked":false,"reason":null,"flags":[]},
                            {"path":"docs/old.md","class":"docs","change":"DELETED","sha256":null,"size":0,"installedSha256":"%s","blocked":false,"reason":null,"flags":[]},
                            {"path":"data/db/x","class":"protected","change":"BLOCKED","sha256":"%s","size":1,"installedSha256":null,"blocked":true,"reason":"محمي","flags":["PROTECTED"]}]}
                """.formatted(sfx, addedSha, addedSize, addedSha, addedSha));
        Files.writeString(s.resolve("state.json"), "{\"state\":\"COMPARED\",\"message\":\"قورن\"}");
    }

    @Test
    @DisplayName("UPD-1: only a global administrator; the release is kept as sent; only compared files with the signed SHA-256 are accepted")
    void brokerAcceptsOnlyTheSignedFiles() throws Exception {
        String viewer = role("V", "ORGANIZATION", "VIEW", "CONFIGURE");
        person("cfg", viewer, root);
        assertThat(login("cfg").get("/updates").status()).isEqualTo(403);
        Res overview = admin.get("/updates");
        assertThat(overview.status()).isEqualTo(200);
        assertThat(overview.body().path("worker").path("alive").asBoolean()).as("no worker in this test").isFalse();

        assertThat(admin.post("/updates/sessions", Map.of()).status()).isEqualTo(400);
        Res created = admin.post("/updates/sessions", Map.of("release", "{\"format\":1,\"release\":\"r1-" + sfx + "\"}",
                "signature", "c2ln", "manifest", "app\t" + "0".repeat(64) + "\t1\tstart.sh\n"));
        assertThat(created.status()).as(created.toString()).isEqualTo(200);
        String id = created.body().path("id").asText();
        assertThat(created.body().path("state").asText()).isEqualTo("RECEIVED");
        Path s = STAGE.resolve("sessions").resolve(id);
        assertThat(Files.readString(s.resolve("release/RELEASE.sig"))).isEqualTo("c2ln");
        assertThat(Files.exists(s.resolve("session.properties"))).isTrue();
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'UPDATE_RECEIVED' and entity_id = :id").param("id", id)
                .query(Long.class).single()).isEqualTo(1);

        byte[] content = ("محتوى جديد " + sfx).getBytes(StandardCharsets.UTF_8);
        // before the worker compared: nothing is accepted
        assertThat(put(admin, id, "docs/new-" + sfx + ".md", content).status()).isEqualTo(409);
        compared(id, sha(content), content.length);
        assertThat(put(admin, id, "docs/new-" + sfx + ".md", "مختلف".getBytes(StandardCharsets.UTF_8)).status()).as("not the signed content").isEqualTo(400);
        assertThat(put(admin, id, "../../etc/passwd", content).status()).as("not a compared path").isEqualTo(400);
        assertThat(put(admin, id, "data/db/x", content).status()).as("a blocked path").isEqualTo(400);
        assertThat(put(admin, id, "docs/old.md", content).status()).as("a deletion carries no file").isEqualTo(400);
        assertThat(put(login("cfg"), id, "docs/new-" + sfx + ".md", content).status()).isEqualTo(403);
        assertThat(put(admin, id, "docs/new-" + sfx + ".md", content).status()).isEqualTo(204);
        assertThat(Files.readAllBytes(s.resolve("files/docs/new-" + sfx + ".md"))).isEqualTo(content);
        JsonNode view = admin.get("/updates/sessions/" + id).body();
        assertThat(view.path("state").asText()).isEqualTo("COMPARED");
        assertThat(view.path("compare").path("changes").get(0).path("uploaded").asBoolean()).isTrue();
        assertThat(admin.get("/updates/sessions/../../x").status()).isIn(400, 404);
    }

    @Test
    @DisplayName("UPD-2: approval needs a recent sign-in and a reason, names only compared changes, is recorded once; rollback only after completion; outcomes audited once")
    void approvalAndRollback() throws Exception {
        String id = admin.post("/updates/sessions", Map.of("release", "{\"format\":1,\"release\":\"r2-" + sfx + "\"}", "signature", "c2ln",
                "manifest", "docs\t" + "1".repeat(64) + "\t1\tdocs/x.md\n")).body().path("id").asText();
        byte[] content = ("ملف " + sfx).getBytes(StandardCharsets.UTF_8);
        compared(id, sha(content), content.length);
        List<String> both = List.of("docs/new-" + sfx + ".md", "docs/old.md");
        assertThat(admin.post("/updates/sessions/" + id + "/approve", Map.of("paths", both, "reason", "تحديث التوثيق")).status())
                .as("not uploaded yet").isEqualTo(400);
        assertThat(put(admin, id, "docs/new-" + sfx + ".md", content).status()).isEqualTo(204);
        assertThat(admin.post("/updates/sessions/" + id + "/approve", Map.of("paths", List.of("data/db/x"), "reason", "محاولة")).status())
                .as("a blocked path").isEqualTo(400);
        assertThat(admin.post("/updates/sessions/" + id + "/approve", Map.of("paths", both, "reason", "")).status()).isEqualTo(400);

        // a session whose interactive sign-in is an hour old
        UUID adminId = jdbc.sql("select id from person where username = :u").param("u", "admin-" + sfx).query(UUID.class).single();
        var old = auth.issueSession(adminId, "test-issuer", null, Instant.now().minusSeconds(3600), "127.0.0.1", "t");
        Api stale = new Api();
        java.net.HttpCookie cookie = new java.net.HttpCookie(ae.mover.security.SessionFilter.COOKIE, old.token());
        cookie.setPath("/");
        cookie.setVersion(0);
        ((CookieManager) stale.http.cookieHandler().orElseThrow()).getCookieStore().add(URI.create("http://localhost:" + port), cookie);
        Res stepUp = stale.post("/updates/sessions/" + id + "/approve", Map.of("paths", both, "reason", "تحديث التوثيق"));
        assertThat(stepUp.status()).isEqualTo(403);
        assertThat(stepUp.code()).isEqualTo("REAUTHENTICATION_REQUIRED");

        Res approved = admin.post("/updates/sessions/" + id + "/approve", Map.of("paths", both, "reason", "تحديث التوثيق"));
        assertThat(approved.status()).as(approved.toString()).isEqualTo(200);
        Path s = STAGE.resolve("sessions").resolve(id);
        assertThat(Files.readAllLines(s.resolve("approval-paths.txt"))).containsExactlyElementsOf(both);
        assertThat(Files.readString(s.resolve("approval.properties"))).contains("reason");
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'UPDATE_APPROVED' and entity_id = :id and reason = 'تحديث التوثيق'")
                .param("id", id).query(Long.class).single()).isEqualTo(1);
        assertThat(admin.post("/updates/sessions/" + id + "/approve", Map.of("paths", both, "reason", "مرة ثانية")).status()).isEqualTo(409);

        assertThat(admin.post("/updates/sessions/" + id + "/rollback", Map.of("reason", "رجوع")).status()).as("not finished").isEqualTo(409);
        Files.writeString(s.resolve("state.json"), "{\"state\":\"DONE\",\"message\":\"طُبق\"}");
        updates.auditOutcomes();
        updates.auditOutcomes();
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'UPDATE_DONE' and entity_id = :id").param("id", id)
                .query(Long.class).single()).as("once").isEqualTo(1);
        assertThat(admin.post("/updates/sessions/" + id + "/rollback", Map.of("reason", "")).status()).isEqualTo(400);
        assertThat(admin.post("/updates/sessions/" + id + "/rollback", Map.of("reason", "رجوع للتجربة")).status()).isEqualTo(200);
        assertThat(Files.exists(s.resolve("rollback.properties"))).isTrue();
        assertThat(admin.post("/updates/sessions/" + id + "/rollback", Map.of("reason", "مرة ثانية")).status()).isEqualTo(409);
    }

    @Test
    @DisplayName("UPD-3: the backend's start time is public (the worker's proof that a new build runs); nothing else is")
    void liveness() throws Exception {
        HttpResponse<String> r = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/system/liveness"))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(Instant.parse(JSON.readTree(r.body()).path("startedAt").asText())).isBefore(Instant.now());
        HttpResponse<String> other = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/updates"))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(other.statusCode()).isEqualTo(401);
    }
}
