package ae.mover.hr;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** Private-file, organisation-only Oracle import. No remote upload URL or person-import parameter is accepted. */
@RestController
@RequestMapping("/api/v1/hr/unit-imports")
public class OracleUnitImportController {

    private static final Logger LOG = LoggerFactory.getLogger(OracleUnitImportController.class);

    private final AccessService access;
    private final OracleUnitImportService imports;

    public OracleUnitImportController(AccessService access, OracleUnitImportService imports) {
        this.access = access;
        this.imports = imports;
    }

    @PostMapping("/preview")
    public OracleUnitImportService.Result preview(Actor actor, @RequestBody OracleUnitImportService.Input in) {
        return imports.preview(access.context(actor), in);
    }

    @PostMapping("/{id}/publish")
    public OracleUnitImportService.Result publish(Actor actor, @PathVariable UUID id) {
        LOG.info("Oracle unit publish endpoint reached");
        return imports.commit(access.context(actor), id);
    }
}
