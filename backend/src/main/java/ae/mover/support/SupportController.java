package ae.mover.support;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** «مركز الدعم» (ADR-053): the person's cases, and «لوحة الدعم» with «مقاعد الدعم» for the support staff. */
@RestController
@RequestMapping("/api/v1/support")
public class SupportController {

    private final AccessService access;
    private final SupportService support;

    public SupportController(AccessService access, SupportService support) {
        this.access = access;
        this.support = support;
    }

    // the person's side: every signed-in person
    @PostMapping("/cases")
    public Map<String, Object> open(Actor actor, @RequestBody SupportService.CaseInput in) {
        return support.open(access.context(actor), in);
    }

    @GetMapping("/cases")
    public List<Map<String, Object>> mine(Actor actor) {
        return support.mine(access.context(actor));
    }

    @GetMapping("/cases/{id}")
    public Map<String, Object> get(Actor actor, @PathVariable UUID id) {
        return support.get(access.context(actor), id);
    }

    @PostMapping("/cases/{id}/messages")
    public ResponseEntity<Void> reply(Actor actor, @PathVariable UUID id, @RequestBody SupportService.MessageInput in) {
        support.reply(access.context(actor), id, in);
        return ResponseEntity.noContent().build();
    }

    public record ConfirmInput(Boolean solved, String note) {
    }

    @PostMapping("/cases/{id}/confirm")
    public ResponseEntity<Void> confirm(Actor actor, @PathVariable UUID id, @RequestBody ConfirmInput in) {
        support.confirm(access.context(actor), id, in != null && Boolean.TRUE.equals(in.solved()), in == null ? null : in.note());
        return ResponseEntity.noContent().build();
    }

    // «لوحة الدعم»: seat holders only
    @GetMapping("/console/cases")
    public List<Map<String, Object>> queue(Actor actor, @RequestParam(required = false) String filter) {
        return support.queue(access.context(actor), filter);
    }

    @GetMapping("/console/counts")
    public Map<String, Long> counts(Actor actor) {
        return support.counts(access.context(actor));
    }

    @PostMapping("/console/cases/{id}/act")
    public ResponseEntity<Void> act(Actor actor, @PathVariable UUID id, @RequestBody SupportService.ActInput in) {
        support.act(access.context(actor), id, in);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/seats")
    public List<Map<String, Object>> seats(Actor actor) {
        return support.seats(access.context(actor));
    }

    @PostMapping("/seats")
    public Map<String, Object> grantSeat(Actor actor, @RequestBody SupportService.SeatInput in) {
        return support.grantSeat(access.context(actor), in);
    }

    public record EndInput(String reason) {
    }

    @PostMapping("/seats/{id}/end")
    public ResponseEntity<Void> endSeat(Actor actor, @PathVariable UUID id, @RequestBody EndInput in) {
        support.endSeat(access.context(actor), id, in == null ? null : in.reason());
        return ResponseEntity.noContent().build();
    }
}
