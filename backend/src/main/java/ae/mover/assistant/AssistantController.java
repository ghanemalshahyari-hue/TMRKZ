package ae.mover.assistant;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.knowledge.KnowledgeController;
import ae.mover.security.Actor;

/** «المساعد الذكي» (ADR-056): its state, and one question answered from the guides the person may see. */
@RestController
@RequestMapping("/api/v1/assistant")
public class AssistantController {

    private final AccessService access;
    private final AssistantService assistant;
    private final KnowledgeController help;

    public AssistantController(AccessService access, AssistantService assistant, KnowledgeController help) {
        this.access = access;
        this.assistant = assistant;
        this.help = help;
    }

    @GetMapping("/status")
    public Map<String, Object> status(Actor actor) {
        return assistant.status();
    }

    public record AskInput(String question, String screen) {
    }

    @PostMapping("/ask")
    public Map<String, Object> ask(Actor actor, @RequestBody AskInput in) {
        AssistantService.Answer a = assistant.ask(access.context(actor), in == null ? null : in.question(), in == null ? null : in.screen(),
                help.visible(actor));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("mode", a.mode());
        m.put("answer", a.answer());
        m.put("model", a.model());
        m.put("degraded", a.degraded());
        m.put("sources", a.sources().stream().map(h -> {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("resource", h.doc().resource());
            s.put("title", h.doc().title());
            s.put("screen", h.doc().screen());
            s.put("snippet", h.snippet());
            return s;
        }).toList());
        return m;
    }
}
