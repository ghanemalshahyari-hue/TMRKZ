package ae.mover.update;

import java.io.IOException;
import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;
import jakarta.servlet.http.HttpServletRequest;

/** «مركز التحديث» (ADR-104). The maintenance worker does the work; these calls hand it the release, the files and the approval. */
@RestController
@RequestMapping("/api/v1")
public class UpdateController {

    private final AccessService access;
    private final UpdateService updates;

    public UpdateController(AccessService access, UpdateService updates) {
        this.access = access;
        this.updates = updates;
    }

    /** Public: when this backend process started (the worker's check that the new build runs). */
    @GetMapping("/system/liveness")
    public Map<String, Object> liveness() {
        return UpdateService.liveness();
    }

    @GetMapping("/updates")
    public Map<String, Object> overview(Actor actor) {
        return updates.overview(access.context(actor));
    }

    @PostMapping("/updates/sessions")
    public Map<String, Object> create(Actor actor, @RequestBody(required = false) UpdateService.CreateInput in) {
        return updates.create(access.context(actor), in);
    }

    @GetMapping("/updates/sessions/{id}")
    public Map<String, Object> view(Actor actor, @PathVariable String id) {
        return updates.view(access.context(actor), id);
    }

    @PutMapping("/updates/sessions/{id}/files")
    public ResponseEntity<Void> upload(Actor actor, @PathVariable String id, @RequestParam String path, HttpServletRequest request)
            throws IOException {
        updates.upload(access.context(actor), id, path, request.getInputStream());
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/updates/sessions/{id}/approve")
    public Map<String, Object> approve(Actor actor, @PathVariable String id, @RequestBody(required = false) UpdateService.ApproveInput in) {
        return updates.approve(access.context(actor), id, in);
    }

    @PostMapping("/updates/sessions/{id}/rollback")
    public Map<String, Object> rollback(Actor actor, @PathVariable String id, @RequestBody(required = false) UpdateService.ReasonInput in) {
        return updates.rollback(access.context(actor), id, in);
    }
}
