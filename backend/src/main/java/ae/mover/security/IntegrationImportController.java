package ae.mover.security;

import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;

/** «استيراد ملف إعدادات» (ADR-105): preview a configuration file, test the chosen values, apply them to «إعدادات التكامل». */
@RestController
@RequestMapping("/api/v1/settings/integration/import")
public class IntegrationImportController {

    private final AccessService access;
    private final IntegrationImportService imports;

    public IntegrationImportController(AccessService access, IntegrationImportService imports) {
        this.access = access;
        this.imports = imports;
    }

    /** Recognises the file's settings and compares them with what is in force; saves nothing and keeps no file. */
    @PostMapping("/preview")
    public Map<String, Object> preview(Actor actor, @RequestBody(required = false) IntegrationImportService.ImportInput in) {
        return imports.preview(access.context(actor), in);
    }

    @PostMapping("/{id}/test")
    public Map<String, Object> test(Actor actor, @PathVariable String id, @RequestBody(required = false) IntegrationImportService.Selection in) {
        return imports.test(access.context(actor), id, in);
    }

    @PostMapping("/{id}/apply")
    public Map<String, Object> apply(Actor actor, @PathVariable String id, @RequestBody(required = false) IntegrationImportService.Selection in) {
        return imports.apply(access.context(actor), id, in);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> discard(Actor actor, @PathVariable String id) {
        imports.discard(access.context(actor), id);
        return ResponseEntity.noContent().build();
    }
}
