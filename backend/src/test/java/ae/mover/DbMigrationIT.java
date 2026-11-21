package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.test.context.TestPropertySource;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * «مركز ترحيل قاعدة البيانات» (owner, 20 Nov 2026; ADR-094): an older TMRKZ database — here a schema of the test database
 * holding copies of a few tables at version 40 — previewed by category, its conflicts decided per record, validated in
 * dependency order and migrated behind the backup gate into the current database, which is never replaced. The current
 * record wins unless the administrator takes the source's; secrets are stripped; unsupported tables are never written;
 * a source that changed since the preview is refused; the password is encrypted at rest and in no answer.
 */
@TestPropertySource(properties = {"tmrkz.migration.backups-dir=${java.io.tmpdir}/mover-test-backups",
        "tmrkz.migration.inbox=${java.io.tmpdir}/mover-test-migration-inbox"})
class DbMigrationIT extends IntegrationTest {

    private static final Pattern URL = Pattern.compile("^jdbc:postgresql://([^/:?,]+)(?::(\\d+))?/([^?;]+)");

    @Value("${spring.datasource.url}")
    String url;
    @Value("${spring.datasource.username}")
    String dbUser;
    @Value("${spring.datasource.password}")
    String dbPassword;
    @Value("${tmrkz.migration.backups-dir}")
    String backupsDir;

    private Map<String, Object> source(String schema) {
        Matcher m = URL.matcher(url);
        assertThat(m.find()).isTrue();
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("type", "CONNECTION");
        s.put("host", m.group(1));
        s.put("port", m.group(2) == null ? 5432 : Integer.parseInt(m.group(2)));
        s.put("database", m.group(3));
        s.put("username", dbUser);
        s.put("password", dbPassword);
        s.put("schema", schema);
        return s;
    }

    private void ddl(String sql) {
        jdbc.sql(sql).update();
    }

    private static JsonNode table(JsonNode preview, String name) {
        for (JsonNode t : preview.path("tables")) {
            if (t.path("table").asText().equals(name)) {
                return t;
            }
        }
        throw new AssertionError("table " + name + " not in the preview: " + preview);
    }

    private static List<String> planOrder(JsonNode view) {
        return view.path("selection").path("plan").findValuesAsText("table");
    }

    private Path backup(boolean verified) throws Exception {
        Path root = Path.of(backupsDir);
        Files.createDirectories(root);
        try (var s = Files.list(root)) {
            for (Path p : s.toList()) {
                try (var f = Files.walk(p)) {
                    for (Path x : f.sorted(java.util.Comparator.reverseOrder()).toList()) {
                        Files.deleteIfExists(x);
                    }
                }
            }
        }
        Path dir = root.resolve("tmrkz-mover-" + sfx);
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("manifest.json"), "{\"project\":\"tmrkz-mover\",\"createdAt\":\"" + Instant.now()
                + "\",\"schemaVersion\":\"56\",\"files\":{}}", StandardCharsets.UTF_8);
        if (verified) {
            Files.writeString(dir.resolve("verify-result.txt"), "PASS " + Instant.now(), StandardCharsets.UTF_8);
        }
        return dir;
    }

    @Test
    @DisplayName("DB-MIGRATION-01 preview by category, conflicts decided per record, dependency order, backup gate, fingerprint, one transaction, audit, no secret")
    void migrationCenter() throws Exception {
        UUID top = org("DM", null);
        UUID conf = org("DC", null);
        UUID cfg = person("cfg", role("DMCFG", "ALL", "VIEW", "CONFIGURE"), top);
        UUID plain = person("plain", role("DMVIEW", "ALL", "VIEW"), top);
        jdbc.sql("update person set password_hash = 'current-hash' where id in (:a, :b)").param("a", cfg).param("b", plain).update();
        String old = "old_" + sfx;
        String newer = "newer_" + sfx;
        UUID orgNew = UUID.randomUUID();
        UUID personNew = UUID.randomUUID();
        UUID siteParent = UUID.randomUUID();
        UUID siteChild = UUID.randomUUID();
        UUID membershipNew = UUID.randomUUID();
        String roleCode = jdbc.sql("select role_code from membership where person_id = :p").param("p", plain).query(String.class).single();
        try {
            // the older database: a schema at version 40 with copies of a few tables; new, identical and conflicting rows
            ddl("create schema " + old);
            ddl("create schema " + newer);
            for (String t : List.of("flyway_schema_history", "organization", "person", "site", "membership", "bootstrap_admin")) {
                ddl("create table " + old + "." + t + " (like public." + t + " including all)");
            }
            ddl("create table " + newer + ".flyway_schema_history (like public.flyway_schema_history including all)");
            ddl("insert into " + old + ".flyway_schema_history select * from public.flyway_schema_history where version ~ '^[0-9]+$' and cast(version as int) <= 40");
            ddl("insert into " + newer + ".flyway_schema_history select * from public.flyway_schema_history");
            jdbc.sql("update " + newer + ".flyway_schema_history set version = '999' where installed_rank = (select max(installed_rank) from " + newer + ".flyway_schema_history)").update();
            jdbc.sql("insert into " + old + ".organization select * from organization where id in (:a, :b)").param("a", top).param("b", conf).update();
            jdbc.sql("update " + old + ".organization set name = 'الاسم القديم' where id = :id").param("id", conf).update();
            jdbc.sql("insert into " + old + ".organization(id, code, name, valid_from) values (:id, :c, 'جهة قديمة جديدة', '2025-01-01T00:00:00Z')")
                    .param("id", orgNew).param("c", "OLDNEW-" + sfx).update();
            jdbc.sql("insert into " + old + ".person select * from person where id in (:a, :b)").param("a", cfg).param("b", plain).update();
            jdbc.sql("update " + old + ".person set password_hash = 'old-hash' where id = :id").param("id", plain).update(); // stripped: identical
            jdbc.sql("update " + old + ".person set display_name = 'الاسم من المصدر', password_hash = 'old-hash' where id = :id").param("id", cfg).update();
            jdbc.sql("insert into " + old + ".person(id, employee_no, display_name, username, password_hash) values (:id, :e, 'شخص قديم', :u, 'old-secret')")
                    .param("id", personNew).param("e", "OLD-" + sfx).param("u", "old-" + sfx).update();
            // the child may sort before its parent: the migration must still insert the parent first
            jdbc.sql("insert into " + old + ".site(id, code, name, kind, lat, lng) values (:id, :c, 'موقع أب قديم', 'مرفق', 25.2, 55.3)")
                    .param("id", siteParent).param("c", "OLDP-" + sfx).update();
            jdbc.sql("insert into " + old + ".site(id, code, name, kind, parent_id, lat, lng) values (:id, :c, 'موقع ابن قديم', 'مرفق', :p, 25.2, 55.3)")
                    .param("id", siteChild).param("c", "OLDC-" + sfx).param("p", siteParent).update();
            jdbc.sql("insert into " + old + ".membership(id, person_id, organization_id, role_code, valid_from) values (:id, :p, :o, :r, '2026-01-01T00:00:00Z')")
                    .param("id", membershipNew).param("p", personNew).param("o", orgNew).param("r", roleCode).update();
            jdbc.sql("insert into " + old + ".bootstrap_admin(login, expires_at) values (:l, now() + interval '1 day')").param("l", "old-admin-" + sfx).update();

            Api admin = login("cfg");
            assertThat(login("plain").post("/settings/db-migration/connect", source(old)).status()).isEqualTo(403);
            assertThat(login("plain").get("/settings/db-migration").status()).isEqualTo(403);
            // the current database itself, a newer source, a missing schema, a bad name: refused
            assertThat(admin.post("/settings/db-migration/connect", source("public")).status()).isEqualTo(400);
            Res newerRes = admin.post("/settings/db-migration/connect", source(newer));
            assertThat(newerRes.status()).as(newerRes.toString()).isEqualTo(400);
            assertThat(newerRes.body().path("message").asText()).contains("أحدث");
            assertThat(admin.post("/settings/db-migration/connect", source("nope_" + sfx)).status()).isEqualTo(400);
            assertThat(admin.post("/settings/db-migration/connect", source("public; drop")).status()).isEqualTo(400);

            // the preview
            Res connected = admin.post("/settings/db-migration/connect", source(old));
            assertThat(connected.status()).as(connected.toString()).isEqualTo(200);
            String id = connected.body().path("id").asText();
            JsonNode preview = connected.body().path("preview");
            assertThat(connected.body().path("state").asText()).isEqualTo("PREVIEWED");
            assertThat(connected.body().path("sourceType").asText()).isEqualTo("CONNECTION");
            assertThat(connected.body().path("sourceVersion").asInt()).isEqualTo(40);
            assertThat(connected.body().path("currentVersion").asInt()).isGreaterThanOrEqualTo(56);
            assertThat(connected.body().toString()).doesNotContain(dbPassword).doesNotContain("old-hash").doesNotContain("old-secret");
            JsonNode organization = table(preview, "organization");
            assertThat(organization.path("category").asText()).isEqualTo("ORGANISATIONS");
            assertThat(organization.path("sourceRows").asInt()).isEqualTo(3);
            assertThat(organization.path("newRows").asInt()).isEqualTo(1);
            assertThat(organization.path("conflicts").asInt()).isEqualTo(1);
            assertThat(organization.path("identical").asInt()).isEqualTo(1);
            assertThat(organization.path("conflictSamples").get(0).asText()).isEqualTo(conf.toString());
            JsonNode detail = organization.path("conflictDetails").get(0);
            assertThat(detail.path("key").asText()).isEqualTo(conf.toString());
            assertThat(detail.path("columns").get(0).path("column").asText()).isEqualTo("name");
            assertThat(detail.path("columns").get(0).path("current").asText()).isEqualTo("جهة DC");
            assertThat(detail.path("columns").get(0).path("source").asText()).isEqualTo("الاسم القديم");
            JsonNode person = table(preview, "person");
            assertThat(person.path("category").asText()).isEqualTo("PEOPLE");
            assertThat(person.path("secretColumns").toString()).contains("password_hash");
            assertThat(person.path("sharedColumns").toString()).doesNotContain("password_hash");
            assertThat(person.path("newRows").asInt()).isEqualTo(1);
            assertThat(person.path("identical").asInt()).as("a different password hash is not a conflict: the column is stripped").isEqualTo(1);
            assertThat(person.path("conflicts").asInt()).isEqualTo(1);
            assertThat(table(preview, "site").path("newRows").asInt()).isEqualTo(2);
            assertThat(table(preview, "membership").path("dependsOn").toString()).contains("organization").contains("person");
            JsonNode unsupported = null;
            for (JsonNode e : preview.path("excluded")) {
                if (e.path("table").asText().equals("bootstrap_admin")) {
                    unsupported = e;
                }
            }
            assertThat(unsupported).as("sessions and sign-in state are never migrated").isNotNull();
            assertThat(unsupported.path("category").asText()).isEqualTo("UNSUPPORTED");
            JsonNode organisations = null;
            for (JsonNode c : preview.path("categories")) {
                if (c.path("code").asText().equals("ORGANISATIONS")) {
                    organisations = c;
                }
            }
            assertThat(organisations.path("newRows").asInt()).isEqualTo(1);
            assertThat(organisations.path("conflicts").asInt()).isEqualTo(1);
            assertThat(preview.path("fingerprint").path("organization").path("rows").asInt()).isEqualTo(3);
            // the password at rest: encrypted with TMRKZ's key, never in clear
            String cipherText = jdbc.sql("select secret_ciphertext from db_migration where id = cast(:id as uuid)").param("id", id).query(String.class).single();
            assertThat(cipherText).startsWith("v1:").doesNotContain(dbPassword);
            assertThat(jdbc.sql("select source::text from db_migration where id = cast(:id as uuid)").param("id", id).query(String.class).single())
                    .doesNotContain(dbPassword);
            assertThat(admin.get("/settings/db-migration/" + id).body().toString()).doesNotContain(dbPassword);
            assertThat(admin.get("/settings/db-migration").body().get(0).path("id").asText()).isEqualTo(id);

            // the selection: a table with conflicts needs a decision; the default selection is every table with new rows
            Res undecided = admin.put("/settings/db-migration/" + id + "/selection", Map.of());
            assertThat(undecided.status()).as(undecided.toString()).isEqualTo(400);
            assertThat(undecided.body().path("details").path("undecided").toString()).contains("organization").contains("person");
            Map<String, Object> decisions = new LinkedHashMap<>();
            decisions.put("organization", Map.of("confirmed", true)); // KEEP: the current name wins
            decisions.put("person", Map.of("records", Map.of(cfg.toString(), "TAKE_SOURCE")));
            Map<String, Object> selection = Map.of("tables", List.of("membership", "person", "site", "organization"), "decisions", decisions);
            assertThat(admin.put("/settings/db-migration/" + id + "/selection",
                    Map.of("tables", List.of("person"), "decisions", Map.of("person", Map.of("records", Map.of(plain.toString(), "TAKE_SOURCE"))))).status())
                    .as("a key the preview did not list as a conflict").isEqualTo(400);
            Res validated = admin.put("/settings/db-migration/" + id + "/selection", selection);
            assertThat(validated.status()).as(validated.toString()).isEqualTo(200);
            assertThat(validated.body().path("state").asText()).isEqualTo("VALIDATED");
            List<String> order = planOrder(validated.body());
            assertThat(order).containsExactlyInAnyOrder("organization", "person", "site", "membership");
            assertThat(order.indexOf("organization")).isLessThan(order.indexOf("membership"));
            assertThat(order.indexOf("person")).isLessThan(order.indexOf("membership"));
            assertThat(validated.body().path("selection").path("takeSource").asInt()).isEqualTo(1);
            assertThat(validated.body().path("selection").path("decisions").path("person").path("records").path(cfg.toString()).asText()).isEqualTo("TAKE_SOURCE");

            // the backup gate: no backup, an unverified backup without the attestation, then the attestation
            Res noBackup = admin.post("/settings/db-migration/" + id + "/migrate", Map.of());
            assertThat(noBackup.status()).as(noBackup.toString()).isEqualTo(400);
            assertThat(admin.get("/settings/db-migration/backup-status").body().path("found").asBoolean()).isFalse();
            backup(false);
            Res status = admin.get("/settings/db-migration/backup-status");
            assertThat(status.body().path("found").asBoolean()).isTrue();
            assertThat(status.body().path("verified").asBoolean()).isFalse();
            assertThat(status.body().path("current").asBoolean()).isTrue();
            Res unverified = admin.post("/settings/db-migration/" + id + "/migrate", Map.of());
            assertThat(unverified.status()).as(unverified.toString()).isEqualTo(400);
            assertThat(unverified.body().path("message").asText()).contains("verify-backup");
            assertThat(admin.get("/settings/db-migration/" + id).body().path("state").asText()).isEqualTo("VALIDATED");

            // the source changed since the preview: refused, nothing written, a new preview required
            jdbc.sql("insert into " + old + ".organization(id, code, name, valid_from) values (:id, :c, 'جهة ظهرت بعد المعاينة', '2025-01-01T00:00:00Z')")
                    .param("id", UUID.randomUUID()).param("c", "LATE-" + sfx).update();
            Res changed = admin.post("/settings/db-migration/" + id + "/migrate", Map.of("backupVerified", true));
            assertThat(changed.status()).as(changed.toString()).isEqualTo(200);
            assertThat(changed.body().path("state").asText()).isEqualTo("FAILED");
            assertThat(changed.body().path("report").path("fingerprintChanged").asBoolean()).isTrue();
            assertThat(jdbc.sql("select count(*) from organization where id = :id").param("id", orgNew).query(Long.class).single()).isZero();
            assertThat(admin.post("/settings/db-migration/" + id + "/migrate", Map.of("backupVerified", true)).status()).as("finished: not run again").isEqualTo(400);

            // again from a fresh preview, with the backup verified by its result file
            backup(true);
            Res again = admin.post("/settings/db-migration/connect", source(old));
            assertThat(again.status()).isEqualTo(200);
            String id2 = again.body().path("id").asText();
            assertThat(table(again.body().path("preview"), "organization").path("newRows").asInt()).isEqualTo(2);
            Res validated2 = admin.put("/settings/db-migration/" + id2 + "/selection", selection);
            assertThat(validated2.status()).as(validated2.toString()).isEqualTo(200);
            Res migrated = admin.post("/settings/db-migration/" + id2 + "/migrate", Map.of());
            assertThat(migrated.status()).as(migrated.toString()).isEqualTo(200);
            assertThat(migrated.body().path("state").asText()).as(migrated.toString()).isEqualTo("MIGRATED");
            assertThat(migrated.body().toString()).doesNotContain(dbPassword).doesNotContain("old-hash").doesNotContain("old-secret");
            JsonNode report = migrated.body().path("report");
            assertThat(report.path("ok").asBoolean()).isTrue();
            assertThat(report.path("backup").path("verified").asBoolean()).isTrue();
            assertThat(report.path("backup").path("confirmedByAdministrator").asBoolean()).isFalse();
            Map<String, JsonNode> byTable = new LinkedHashMap<>();
            for (JsonNode t : report.path("tables")) {
                byTable.put(t.path("table").asText(), t);
            }
            assertThat(byTable.get("organization").path("inserted").asInt()).isEqualTo(2);
            assertThat(byTable.get("organization").path("updated").asInt()).isEqualTo(0);
            assertThat(byTable.get("organization").path("conflicts").asInt()).isEqualTo(1);
            assertThat(byTable.get("organization").path("conflictSamples").get(0).asText()).isEqualTo(conf.toString());
            assertThat(byTable.get("person").path("inserted").asInt()).isEqualTo(1);
            assertThat(byTable.get("person").path("updated").asInt()).as("TAKE_SOURCE").isEqualTo(1);
            assertThat(byTable.get("site").path("inserted").asInt()).isEqualTo(2);
            assertThat(byTable.get("membership").path("inserted").asInt()).isEqualTo(1);
            // the current database: new rows in, KEEP left the current name, TAKE_SOURCE took the source's, secrets untouched
            assertThat(jdbc.sql("select name from organization where id = :id").param("id", orgNew).query(String.class).single()).isEqualTo("جهة قديمة جديدة");
            assertThat(jdbc.sql("select name from organization where id = :id").param("id", conf).query(String.class).single()).isEqualTo("جهة DC");
            assertThat(jdbc.sql("select display_name from person where id = :id").param("id", cfg).query(String.class).single()).isEqualTo("الاسم من المصدر");
            assertThat(jdbc.sql("select password_hash from person where id = :id").param("id", cfg).query(String.class).single()).isEqualTo("current-hash");
            assertThat(jdbc.sql("select password_hash from person where id = :id").param("id", plain).query(String.class).single()).isEqualTo("current-hash");
            assertThat(jdbc.sql("select password_hash is null from person where id = :id").param("id", personNew).query(Boolean.class).single())
                    .as("a new person arrives without the source's hash").isTrue();
            assertThat(jdbc.sql("select parent_id from site where id = :id").param("id", siteChild).query(UUID.class).single()).isEqualTo(siteParent);
            assertThat(jdbc.sql("select count(*) from membership where id = :id").param("id", membershipNew).query(Long.class).single()).isEqualTo(1);
            assertThat(jdbc.sql("select count(*) from bootstrap_admin where login = :l").param("l", "old-admin-" + sfx).query(Long.class).single())
                    .as("an unsupported table is never written").isZero();
            // audited: who, source, fingerprint, categories, decisions, counts, result; never the password
            List<Map<String, Object>> events = jdbc.sql("select action, detail::text as d from audit_event where entity_id = :e order by id")
                    .param("e", "db-migration/" + id2).query().listOfRows();
            assertThat(events.stream().map(e -> e.get("action"))).containsExactly("DB_MIGRATION_PREVIEWED", "DB_MIGRATION_VALIDATED", "DB_MIGRATION_RUN");
            String run = (String) events.get(2).get("d");
            assertThat(run).contains("\"ok\": true").contains("TAKE_SOURCE").contains("ORGANISATIONS").contains("fingerprint").doesNotContain(dbPassword);
            assertThat(admin.get("/settings/db-migration").body().get(0).path("state").asText()).isEqualTo("MIGRATED");

            // a dump file: the inbox, the magic check, and the staging database dropped when pg_restore cannot run here
            Res notDump = admin.post("/settings/db-migration/connect", Map.of("type", "DUMP", "file", "missing-" + sfx + ".dump"));
            assertThat(notDump.status()).isEqualTo(400);
            Path inbox = Path.of(admin.get("/settings/db-migration/inbox").body().path("folder").asText());
            Files.writeString(inbox.resolve("plain-" + sfx + ".dump"), "not a dump", StandardCharsets.UTF_8);
            Res plainFile = admin.post("/settings/db-migration/connect", Map.of("type", "DUMP", "file", "plain-" + sfx + ".dump"));
            assertThat(plainFile.status()).isEqualTo(400);
            assertThat(plainFile.body().path("message").asText()).contains("PGDMP");
            Files.write(inbox.resolve("fake-" + sfx + ".dump"), "PGDMP\u0001\u0010\u0000 not really".getBytes(StandardCharsets.ISO_8859_1));
            JsonNode listed = admin.get("/settings/db-migration/inbox").body().path("files");
            assertThat(listed.findValuesAsText("file")).contains("fake-" + sfx + ".dump");
            Res fake = admin.post("/settings/db-migration/connect", Map.of("type", "DUMP", "file", "fake-" + sfx + ".dump"));
            assertThat(fake.status()).as(fake.toString()).isEqualTo(400);
            assertThat(jdbc.sql("select count(*) from pg_database where datname like 'tmrkz_staging_%'").query(Long.class).single())
                    .as("the staging database is dropped on failure").isZero();
            // abandoning a preview
            Res third = admin.post("/settings/db-migration/connect", source(old));
            assertThat(third.status()).isEqualTo(200);
            Res abandoned = admin.delete("/settings/db-migration/" + third.body().path("id").asText());
            assertThat(abandoned.status()).isEqualTo(200);
            assertThat(abandoned.body().path("state").asText()).isEqualTo("FAILED");
        } finally {
            ddl("drop schema if exists " + old + " cascade");
            ddl("drop schema if exists " + newer + " cascade");
        }
    }
}
