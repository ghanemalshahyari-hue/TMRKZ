package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * ADR-105 «استيراد ملف إعدادات»: a compatible application's configuration file is recognised and mapped to the integration
 * sections; conflicts, missing values and the values never imported are shown; secrets never come back; nothing is saved before
 * the same selection passed its live test; .env, database credentials and keys are never touched. All values are fictional.
 */
class IntegrationImportIT extends IntegrationTest {

    static final Path STAGE;
    static final ObjectMapper MAPPER = new ObjectMapper();

    static {
        try {
            STAGE = Files.createTempDirectory("tmrkz-import-it");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @DynamicPropertySource
    static void stage(DynamicPropertyRegistry r) {
        r.add("tmrkz.update.dir", STAGE::toString);
    }

    UUID root;
    Api admin;

    /** The integration sections are shared by every test class of this run: cleared through the service, so its cache renews. */
    @AfterEach
    void clearSections() {
        for (String section : java.util.List.of("directory", "oidc", "assistant")) {
            admin.delete("/settings/integration/" + section);
        }
    }

    @BeforeEach
    void fixtures() throws Exception {
        root = org("ROOT", null);
        person("admin", "SYSTEM_ADMIN", root);
        admin = login("admin");
        jdbc.sql("delete from integration_setting").update();
        // the machine's certs/ folder as the maintenance worker lists it: the directory's CA is there by its file name
        String ca = Files.readString(DirectorySignInIT.CA_FILE, StandardCharsets.US_ASCII);
        Map<String, Object> inv = new LinkedHashMap<>();
        inv.put("at", Instant.now().toString());
        inv.put("config", Map.of("tlsDir", "ops/tls/private"));
        inv.put("stores", List.of(Map.of("id", "CERTS", "path", "certs", "files",
                List.of(Map.of("name", "directory-ca.pem", "kind", "CERTIFICATES", "pem", ca)))));
        Files.writeString(STAGE.resolve("certificate-inventory.json"), MAPPER.writeValueAsString(inv));
    }

    private String file(String server) {
        return """
                # a compatible application's settings (fictional)
                LDAP_ENABLED=true
                LDAP_SERVER=%s
                LDAP_PORT=%d
                LDAP_SECURITY_MODE=starttls
                LDAP_BASE_DN=%s
                LDAP_BIND_DN=cn=service,%s
                LDAP_BIND_PASSWORD="service-secret"
                LDAP_MILITARY_NUMBER_ATTRIBUTE=employeeNumber
                LDAP_CA_CERT_PATH=/opt/other-app/ca-certs/directory-ca.pem
                export KEYCLOAK_ENABLED=false
                KEYCLOAK_SERVER_URL=https://keycloak.example.test/
                KEYCLOAK_REALM=corp
                KEYCLOAK_CLIENT_ID=other-application
                KEYCLOAK_CLIENT_SECRET=other-client-secret-%s
                KEYCLOAK_REDIRECT_URI=https://other.example.test/callback
                DATABASE_URL=postgresql://app:db-pass-%s@db/app
                SECRET_KEY=flask-secret-%s
                ORACLE_SETTINGS_KEY=oracle-key-%s
                OPENFGA_STORE_ID=01HTEST
                SMS_PASSWORD=sms-secret-%s
                SESSION_IDLE_TIMEOUT_SECONDS=900  # an inline comment
                """.formatted(server, DirectorySignInIT.LDAP.getListenPort(), DirectorySignInIT.BASE, DirectorySignInIT.BASE, sfx, sfx, sfx, sfx, sfx);
    }

    private static JsonNode section(JsonNode preview, String name) {
        for (JsonNode s : preview.path("sections")) {
            if (name.equals(s.path("section").asText())) {
                return s;
            }
        }
        return null;
    }

    private static JsonNode field(JsonNode preview, String path) {
        for (JsonNode s : preview.path("sections")) {
            for (JsonNode f : s.path("fields")) {
                if (path.equals(f.path("path").asText())) {
                    return f;
                }
            }
        }
        return null;
    }

    private static List<String> defaults(JsonNode preview) {
        List<String> out = new ArrayList<>();
        for (JsonNode s : preview.path("sections")) {
            for (JsonNode f : s.path("fields")) {
                if (f.path("selectedByDefault").asBoolean()) {
                    out.add(f.path("path").asText());
                }
            }
        }
        return out;
    }

    @Test
    @DisplayName("IMP-01 recognised, mapped and compared; never-imported values named only; secrets hidden; tested before applied; .env untouched")
    void importCompatibleFile() throws Exception {
        person("plain", role("PL", "ORGANIZATION", "VIEW"), root);
        assertThat(login("plain").post("/settings/integration/import/preview", Map.of("fileName", ".env", "text", file("localhost"))).status())
                .isEqualTo(403);

        Res preview = admin.post("/settings/integration/import/preview", Map.of("fileName", "other-app.env", "text", file("localhost")));
        assertThat(preview.status()).as(preview.toString()).isEqualTo(200);
        JsonNode p = preview.body();
        assertThat(p.path("format").asText()).isEqualTo("COMPATIBLE");
        assertThat(field(p, "DIRECTORY.server").path("status").asText()).isEqualTo("NEW");
        assertThat(field(p, "DIRECTORY.employeeNumberAttribute").path("sourceKey").asText()).isEqualTo("LDAP_MILITARY_NUMBER_ATTRIBUTE");
        assertThat(field(p, "DIRECTORY.bindPassword").path("imported").asText()).isEqualTo("••••");
        assertThat(field(p, "DIRECTORY.caCertificatesPem").path("certificate").path("file").asText()).isEqualTo("directory-ca.pem");
        assertThat(field(p, "OIDC.clientId").path("warning").asText()).as("the other application's client").isNotBlank();
        assertThat(field(p, "OIDC.clientId").path("selectedByDefault").asBoolean()).isFalse();
        assertThat(field(p, "OIDC.serverUrl").path("imported").asText()).isEqualTo("https://keycloak.example.test");
        assertThat(section(p, "OIDC").path("missing").toString()).as("no client secret of its own").contains("سر العميل");
        assertThat(p.path("protectedKeys").toString()).contains("DATABASE_URL", "SECRET_KEY", "ORACLE_SETTINGS_KEY", "OPENFGA_STORE_ID");
        assertThat(p.path("notApplicableKeys").toString()).contains("KEYCLOAK_REDIRECT_URI");
        assertThat(p.path("ignoredKeys").toString()).contains("SMS_PASSWORD", "SESSION_IDLE_TIMEOUT_SECONDS");
        for (String secret : List.of("service-secret", "db-pass-" + sfx, "flask-secret-" + sfx, "oracle-key-" + sfx, "other-client-secret-" + sfx,
                "sms-secret-" + sfx)) {
            assertThat(preview.toString()).as("never returned: " + secret).doesNotContain(secret);
        }
        String id = p.path("importId").asText();
        List<String> chosen = defaults(p).stream().filter(f -> f.startsWith("DIRECTORY.")).toList();
        assertThat(chosen).contains("DIRECTORY.server", "DIRECTORY.bindPassword", "DIRECTORY.caCertificatesPem");

        // not before a passed test of that same selection
        assertThat(admin.post("/settings/integration/import/" + id + "/apply", Map.of("fields", chosen, "reason", "استيراد")).status()).isEqualTo(409);
        Res tested = admin.post("/settings/integration/import/" + id + "/test", Map.of("fields", chosen));
        assertThat(tested.body().path("results").path("DIRECTORY").path("ok").asBoolean()).as(tested.toString()).isTrue();
        List<String> more = new ArrayList<>(chosen);
        more.add("OIDC.realm");
        assertThat(admin.post("/settings/integration/import/" + id + "/apply", Map.of("fields", more, "reason", "استيراد")).status())
                .as("another selection was not tested").isEqualTo(409);
        assertThat(admin.post("/settings/integration/import/" + id + "/apply", Map.of("fields", chosen)).status()).isEqualTo(400);
        Res applied = admin.post("/settings/integration/import/" + id + "/apply", Map.of("fields", chosen, "reason", "نقل إعدادات الدليل"));
        assertThat(applied.status()).as(applied.toString()).isEqualTo(200);
        JsonNode dir = admin.get("/settings/integration/directory").body();
        assertThat(dir.path("source").asText()).isEqualTo("SAVED");
        assertThat(dir.path("saved").path("server").asText()).isEqualTo("localhost");
        assertThat(dir.path("saved").path("bindPasswordSet").asBoolean()).isTrue();
        assertThat(dir.path("saved").path("caCertificatesPem").asText()).contains("BEGIN CERTIFICATE");
        assertThat(admin.get("/settings/integration/status").body().path("directory").path("state").asText()).isEqualTo("UP");
        String audit = jdbc.sql("select detail::text from audit_event where action = 'INTEGRATION_ENV_IMPORTED' order by occurred_at desc limit 1")
                .query(String.class).single();
        assertThat(audit).contains("LDAP_SERVER", "DATABASE_URL").doesNotContain("service-secret").doesNotContain("db-pass-" + sfx);
        assertThat(admin.post("/settings/integration/import/" + id + "/test", Map.of("fields", chosen)).status()).as("an applied import is closed")
                .isEqualTo(409);

        // the same file again: nothing new; another server is a conflict, kept unless chosen
        JsonNode again = admin.post("/settings/integration/import/preview", Map.of("fileName", "other-app.env", "text", file("ldap.example.test"))).body();
        assertThat(field(again, "DIRECTORY.server").path("status").asText()).isEqualTo("CONFLICT");
        assertThat(field(again, "DIRECTORY.server").path("selectedByDefault").asBoolean()).isFalse();
        assertThat(field(again, "DIRECTORY.bindPassword").path("status").asText()).isEqualTo("SAME");
        assertThat(field(again, "DIRECTORY.baseDn").path("status").asText()).isEqualTo("SAME");
        // a failing test blocks the conflicting value
        String id2 = again.path("importId").asText();
        Res failing = admin.post("/settings/integration/import/" + id2 + "/test", Map.of("fields", List.of("DIRECTORY.server")));
        assertThat(failing.body().path("results").path("DIRECTORY").path("ok").asBoolean()).isFalse();
        assertThat(admin.post("/settings/integration/import/" + id2 + "/apply", Map.of("fields", List.of("DIRECTORY.server"), "reason", "محاولة"))
                .status()).isEqualTo(409);
        assertThat(admin.get("/settings/integration/directory").body().path("saved").path("server").asText()).isEqualTo("localhost");

        // an insecure directory and an unknown file
        JsonNode insecure = admin.post("/settings/integration/import/preview", Map.of("fileName", "x.env",
                "text", "LDAP_SERVER=ldap.example.test\nLDAP_SECURITY_MODE=none\n")).body();
        assertThat(field(insecure, "DIRECTORY.securityMode").path("selectable").asBoolean()).isFalse();
        assertThat(admin.post("/settings/integration/import/preview", Map.of("fileName", "x.env", "text", "just text")).status()).isEqualTo(400);
    }
}
