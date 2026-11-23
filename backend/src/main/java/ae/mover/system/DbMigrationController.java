package ae.mover.system;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/**
 * «الإعدادات → ترحيل البيانات → مركز ترحيل قاعدة البيانات» (ADR-094 «Migration Center»): an older TMRKZ database (a live
 * connection or a pg_dump file restored into an isolated staging database) read, previewed by category, chosen from with a
 * decision per conflict, validated and migrated behind the backup gate into the current one by whoever configures the
 * system. The current database is never replaced; the source password is encrypted at rest and never returned.
 */
@RestController
@RequestMapping("/api/v1/settings/db-migration")
public class DbMigrationController {

    private final AccessService access;
    private final DbMigrationService migrations;

    public DbMigrationController(AccessService access, DbMigrationService migrations) {
        this.access = access;
        this.migrations = migrations;
    }

    /** The last migrations: id, state, source type and host/database or file, versions, created, finished. */
    @GetMapping
    public List<Map<String, Object>> list(Actor actor) {
        return migrations.list(access.context(actor));
    }

    /** The backup gate: the newest backup, its age, whether its verification result exists. */
    @GetMapping("/backup-status")
    public Map<String, Object> backupStatus(Actor actor) {
        return migrations.backupStatus(access.context(actor));
    }

    /** The dump files in the inbox folder, with the upload limit. */
    @GetMapping("/inbox")
    public Map<String, Object> inbox(Actor actor) {
        return migrations.inbox(access.context(actor));
    }

    /** Uploads a pg_dump -Fc file into the inbox (size-limited); reports its magic and SHA-256. */
    @PostMapping(value = "/inbox", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> upload(Actor actor, @RequestParam("file") MultipartFile file) throws IOException {
        return migrations.upload(access.context(actor), file.getOriginalFilename(), file.getSize(), file.getInputStream());
    }

    /** Opens the source read-only (or restores the dump into staging), checks its schema version, analyses the shared tables and stores the preview. */
    @PostMapping("/connect")
    public Map<String, Object> connect(Actor actor, @RequestBody DbMigrationService.Source in) {
        return migrations.connect(access.context(actor), in);
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(Actor actor, @PathVariable UUID id) {
        return migrations.get(access.context(actor), id);
    }

    /** Which tables to bring and the decision per conflict; returns the ordered plan and its warnings. */
    @PutMapping("/{id}/selection")
    public Map<String, Object> select(Actor actor, @PathVariable UUID id, @RequestBody(required = false) DbMigrationService.Selection in) {
        return migrations.select(access.context(actor), id, in);
    }

    /** Behind the backup gate and the fingerprint check: inserts the new rows and applies the decisions in one transaction. */
    @PostMapping("/{id}/migrate")
    public Map<String, Object> migrate(Actor actor, @PathVariable UUID id, @RequestBody(required = false) DbMigrationService.Commit in) {
        return migrations.migrate(access.context(actor), id, in);
    }

    /** Gives a preview up: a dump's staging database is dropped. */
    @DeleteMapping("/{id}")
    public Map<String, Object> abandon(Actor actor, @PathVariable UUID id) {
        return migrations.abandon(access.context(actor), id);
    }
}
