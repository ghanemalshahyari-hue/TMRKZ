package ae.mover.hr;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.http.HttpStatus;
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

@RestController
@RequestMapping("/api/v1")
@EnableConfigurationProperties(HrProperties.class)
public class HrController {

    private final AccessService access;
    private final HrAdminService hr;

    public HrController(AccessService access, HrAdminService hr) {
        this.access = access;
        this.hr = hr;
    }

    public record SyncInput(String overrideReason) {
    }

    public record ReasonInput(String reason) {
    }

    @GetMapping("/hr/status")
    public Map<String, Object> status(Actor actor) {
        return hr.status(access.context(actor));
    }

    @GetMapping("/hr/runs")
    public List<Map<String, Object>> runs(Actor actor, @RequestParam(required = false) Integer size) {
        return hr.runs(access.context(actor), size == null ? 20 : size);
    }

    @GetMapping("/hr/runs/{id}/issues")
    public List<Map<String, Object>> issues(Actor actor, @PathVariable UUID id) {
        return hr.issues(access.context(actor), id);
    }

    @PostMapping("/hr/sync")
    public ResponseEntity<Map<String, Object>> sync(Actor actor, @RequestBody(required = false) SyncInput in) {
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(hr.runNow(access.context(actor), in == null ? null : in.overrideReason()));
    }

    @GetMapping("/hr/source")
    public Map<String, Object> source(Actor actor) {
        return hr.sourceView(access.context(actor));
    }

    @PutMapping("/hr/source")
    public Map<String, Object> saveSource(Actor actor, @RequestBody HrAdminService.SourceInput in) {
        return hr.saveSource(access.context(actor), in);
    }

    @PostMapping("/hr/source/test")
    public Map<String, Object> test(Actor actor) {
        return hr.testConnection(access.context(actor));
    }

    @GetMapping("/hr/contract")
    public List<Map<String, Object>> contract(Actor actor) {
        access.context(actor).require(ae.mover.access.Permission.CONFIGURE);
        return hr.contract();
    }

    @GetMapping("/hr/mappings")
    public List<Map<String, Object>> mappings(Actor actor) {
        return hr.mappings(access.context(actor));
    }

    @PostMapping("/hr/mappings/draft")
    public Map<String, Object> draft(Actor actor, @RequestBody(required = false) HrAdminService.MappingInput in) {
        return hr.saveDraft(access.context(actor), in);
    }

    @PostMapping("/hr/mappings/{id}/discover")
    public Map<String, Object> discover(Actor actor, @PathVariable UUID id) {
        return hr.discover(access.context(actor), id);
    }

    @PostMapping("/hr/mappings/{id}/publish")
    public Map<String, Object> publish(Actor actor, @PathVariable UUID id) {
        return hr.publish(access.context(actor), id);
    }

    @GetMapping("/position-seats")
    public List<Map<String, Object>> seats(Actor actor) {
        return hr.seats(access.context(actor));
    }

    @PostMapping("/position-seats")
    public Map<String, Object> createSeat(Actor actor, @RequestBody HrAdminService.SeatInput in) {
        return hr.createSeat(access.context(actor), in);
    }

    @PostMapping("/position-seats/{id}/deactivate")
    public ResponseEntity<Void> deactivateSeat(Actor actor, @PathVariable UUID id, @RequestBody(required = false) ReasonInput in) {
        hr.deactivateSeat(access.context(actor), id, in == null ? null : in.reason());
        return ResponseEntity.noContent().build();
    }

    @PutMapping("/organizations/{id}/local")
    public Map<String, Object> local(Actor actor, @PathVariable UUID id, @RequestBody HrAdminService.LocalInput in) {
        return hr.saveLocal(access.context(actor), id, in);
    }
}
