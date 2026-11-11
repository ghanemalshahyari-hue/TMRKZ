package ae.mover.knowledge;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.common.ApiException;
import ae.mover.security.Actor;
import ae.mover.support.SupportService;

/** «دليل تمركز» (ADR-054): search and read the verified knowledge documents the person may see, each with its citation. */
@RestController
@RequestMapping("/api/v1/help")
public class KnowledgeController {

    private final AccessService access;
    private final KnowledgeService knowledge;
    private final SupportService support;

    public KnowledgeController(AccessService access, KnowledgeService knowledge, SupportService support) {
        this.access = access;
        this.knowledge = knowledge;
        this.support = support;
    }

    /** A document is for everyone (`all`), for holders of one of its permissions anywhere, or for support seats. */
    public Predicate<KnowledgeService.Doc> visible(Actor actor) {
        AccessContext ctx = access.context(actor);
        boolean seat = support.seat(ctx.personId()) != null;
        return d -> d.audience().stream().anyMatch(a -> {
            if ("all".equals(a)) {
                return true;
            }
            if ("SUPPORT_SEAT".equals(a)) {
                return seat;
            }
            try {
                return ctx.has(Permission.valueOf(a));
            } catch (IllegalArgumentException e) {
                return false;
            }
        });
    }

    private static Map<String, Object> head(KnowledgeService.Doc d) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("resource", d.resource());
        m.put("title", d.title());
        m.put("type", d.type());
        m.put("screen", d.screen());
        return m;
    }

    @GetMapping("/search")
    public List<Map<String, Object>> search(Actor actor, @RequestParam String q) {
        if (q.length() > 300) {
            throw ApiException.validation("السؤال أطول من المسموح.");
        }
        return knowledge.search(q, visible(actor), 6).stream().map(h -> {
            Map<String, Object> m = head(h.doc());
            m.put("snippet", h.snippet());
            m.put("score", h.score());
            return m;
        }).toList();
    }

    @GetMapping("/index")
    public List<Map<String, Object>> index(Actor actor) {
        return knowledge.all(visible(actor)).stream().map(KnowledgeController::head).toList();
    }

    @GetMapping("/doc")
    public Map<String, Object> doc(Actor actor, @RequestParam String resource) {
        KnowledgeService.Doc d = knowledge.byResource(resource);
        if (d == null || !visible(actor).test(d)) {
            throw ApiException.notFound();
        }
        Map<String, Object> m = head(d);
        m.put("verified", d.verified());
        m.put("origin", d.origin());
        m.put("body", d.body());
        return m;
    }

    /** The bundle's state: how many documents are served; the refused ones only for a configuration administrator. */
    @GetMapping("/status")
    public Map<String, Object> status(Actor actor) {
        AccessContext ctx = access.context(actor);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("bundle", knowledge.bundle());
        m.put("documents", knowledge.size());
        if (ctx.canEverywhere(Permission.CONFIGURE)) {
            m.put("refused", knowledge.refused());
        }
        return m;
    }
}
