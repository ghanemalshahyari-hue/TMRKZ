package ae.mover.system;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

/** The dump source's checks that need no server: the PGDMP magic, the SHA-256, the staging name, the backup stamp. */
class DbMigrationDumpTest {

    @Test
    void magicAndSha256() throws Exception {
        Path dir = Files.createTempDirectory("tmrkz-dump");
        Path dump = dir.resolve("old.dump");
        Files.write(dump, "PGDMP\u0001\u0010\u0000rest".getBytes(StandardCharsets.ISO_8859_1));
        DbMigrationDump.Info info = DbMigrationDump.inspect(dump);
        assertThat(info.pgdmp()).isTrue();
        assertThat(info.size()).isEqualTo(12);
        assertThat(info.sha256()).hasSize(64).matches("[0-9a-f]+");
        Path text = dir.resolve("plain.sql");
        Files.writeString(text, "-- PostgreSQL database dump", StandardCharsets.UTF_8);
        assertThat(DbMigrationDump.inspect(text).pgdmp()).isFalse();
        Path empty = dir.resolve("empty");
        Files.write(empty, new byte[0]);
        assertThat(DbMigrationDump.inspect(empty).pgdmp()).isFalse();
        assertThat(DbMigrationDump.inspect(empty).sha256()).isEqualTo("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    @Test
    void stagingNameAndDatasource() {
        UUID id = UUID.fromString("0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8");
        assertThat(DbMigrationDump.stagingName(id)).isEqualTo("tmrkz_staging_0f3c1a2b4d5e").matches(DbMigrationService.NAME);
        DbMigrationDump.Datasource ds = DbMigrationDump.parse("jdbc:postgresql://db:5432/mover?sslmode=disable", "mover", "");
        assertThat(ds.host()).isEqualTo("db");
        assertThat(ds.port()).isEqualTo(5432);
        assertThat(ds.database()).isEqualTo("mover");
        assertThat(ds.toString()).doesNotContain("password");
        assertThat(DbMigrationDump.parse("jdbc:postgresql://localhost/mover", "mover", "x").port()).isEqualTo(5432);
    }

    @Test
    void backupStamp() {
        assertThat(DbMigrationBackups.stamp("20261107T030611Z")).isEqualTo(Instant.parse("2026-11-07T03:06:11Z"));
        assertThat(DbMigrationBackups.stamp("2026-11-20T10:00:00Z")).isEqualTo(Instant.parse("2026-11-20T10:00:00Z"));
        assertThat(DbMigrationBackups.stamp("yesterday")).isNull();
    }

    @Test
    void catalog() {
        assertThat(DbMigrationCatalog.category("organization")).isEqualTo("ORGANISATIONS");
        assertThat(DbMigrationCatalog.category("deployment_area")).isEqualTo("DEPLOYMENT_AREAS");
        assertThat(DbMigrationCatalog.category("user_session")).isEqualTo("UNSUPPORTED");
        assertThat(DbMigrationCatalog.category("act_ru_task")).isEqualTo("UNSUPPORTED");
        assertThat(DbMigrationCatalog.category("hr_source")).isEqualTo("UNSUPPORTED");
        assertThat(DbMigrationCatalog.category("restationing_new_thing")).isEqualTo("STATIONING");
        assertThat(DbMigrationCatalog.secretColumn("password_hash")).isTrue();
        assertThat(DbMigrationCatalog.secretColumn("secret_ciphertext")).isTrue();
        assertThat(DbMigrationCatalog.secretColumn("display_name")).isFalse();
        assertThat(DbMigrationCatalog.secretColumn("tokens_count")).isFalse();
    }
}
