package ae.mover.system;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.security.Actor;

/** «إرشادات صفحة الدخول» (ADR-083): what the sign-in page shows today, and the board in the settings. */
@RestController
@RequestMapping("/api/v1")
public class SignInNotesController {

    private final AccessService access;
    private final SignInNotesService notes;

    public SignInNotesController(AccessService access, SignInNotesService notes) {
        this.access = access;
        this.notes = notes;
    }

    /** Read before anyone signs in: only the notes shown today. */
    @GetMapping("/auth/notices")
    public Map<String, Object> forSignIn() {
        return notes.forSignIn();
    }

    @GetMapping("/settings/sign-in-notes")
    public Map<String, Object> forSettings(Actor actor) {
        SignInNotesService.Board b = notes.forSettings(access.context(actor));
        return b == null ? Map.of("saved", false) : Map.of("saved", true, "board", b);
    }

    @PutMapping("/settings/sign-in-notes")
    public SignInNotesService.Board save(Actor actor, @RequestBody SignInNotesService.Board board) {
        return notes.save(access.context(actor), board);
    }
}
