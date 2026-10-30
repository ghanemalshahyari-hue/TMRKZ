package ae.mover.requests;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ae.mover.access.AccessContext;
import ae.mover.access.Grant;
import ae.mover.access.Permission;
import ae.mover.facilities.SiteService;
import ae.mover.workflow.WorkflowService;

/**
 * The administrative use requests a person may start from one site: temporary use and open-ended use. Both come from
 * the published request types (kind NEW_RESERVATION; open-ended only where the type allows an open end) and from the
 * same predicates the create call applies — a CREATE right that acts for some organisation and a visible site with
 * active resources. Reading them never writes anything; the create, submit and final approval checks still run.
 */
@Service
public class SiteRequestActions {

    public static final String TEMPORARY = "TEMPORARY";
    public static final String OPEN_ENDED = "OPEN_ENDED";
    public static final String RELOCATE = "RELOCATE";

    private final SiteService sites;
    private final RequestTypes types;
    private final WorkflowService workflows;

    public SiteRequestActions(SiteService sites, RequestTypes types, WorkflowService workflows) {
        this.sites = sites;
        this.types = types;
        this.workflows = workflows;
    }

    public record ActionType(String code, String name, boolean multiSites, boolean ready, String reason) {
    }

    public record Action(String action, String label, boolean available, String reason, List<ActionType> types) {
    }

    public record View(String siteId, String siteName, String view, int resourceCount, boolean canCreate, List<Action> actions) {
    }

    /** Throws not-found when the site is outside the actor's view, exactly like the site record. */
    public View forSite(AccessContext ctx, UUID siteId) {
        SiteService.SiteDetail d = sites.detail(ctx, siteId);
        SiteService.SiteView s = d.site();
        boolean canCreate = ctx.has(Permission.CREATE) && ctx.grants().stream()
                .filter(g -> g.has(Permission.CREATE)).map(Grant::orgId).filter(Objects::nonNull).distinct()
                .anyMatch(org -> ctx.canFor(Permission.CREATE, org));
        String blocked = !canCreate ? "لا تملك صلاحية تقديم الطلبات لأي جهة؛ يمنحها مدير الصلاحيات ضمن نطاق جهتك."
                : "RETIRED".equals(s.status()) ? "الموقع موقوف ولا يقبل طلبات جديدة."
                : s.resources().isEmpty() ? "لا موارد قابلة للطلب مسجلة في هذا الموقع؛ يضيفها مسؤول المرافق من «إعداد الموارد وعلاقاتها»."
                : null;

        List<ActionType> temporary = new ArrayList<>();
        List<ActionType> open = new ArrayList<>();
        List<ActionType> relocate = new ArrayList<>();
        for (RequestTypes.Type t : types.all()) {
            if ("RELOCATION".equals(t.kind())) {
                boolean ready = workflows.latestPublished(t.code()) != null;
                relocate.add(new ActionType(t.code(), t.name(), false, ready,
                        ready ? null : "لم يُنشر تدفق اعتماد لهذا النوع بعد؛ ينشره مسؤول الإعداد من استوديو التدفقات."));
                continue;
            }
            if (t.requiresTarget()) {
                continue;
            }
            boolean ready = workflows.latestPublished(t.code()) != null;
            ActionType at = new ActionType(t.code(), t.name(), t.multiSites(), ready,
                    ready ? null : "لم يُنشر تدفق اعتماد لهذا النوع بعد؛ ينشره مسؤول الإعداد من استوديو التدفقات.");
            temporary.add(at);
            if (t.openEndAllowed()) {
                open.add(at);
            }
        }
        List<Action> actions = new ArrayList<>();
        if (!temporary.isEmpty()) {
            actions.add(action(TEMPORARY, "طلب استخدام مؤقت", blocked, temporary));
        }
        // open-ended use appears only where a published type permits an open end
        if (!open.isEmpty()) {
            actions.add(action(OPEN_ENDED, "طلب استخدام مفتوح المدة", blocked, open));
        }
        // moving an organisation's premises away from this site, to a location proposed on the map
        if (!relocate.isEmpty()) {
            actions.add(action(RELOCATE, "نقل المقر", blocked, relocate));
        }
                return new View(s.id(), s.name(), s.view(), s.resources().size(), canCreate, actions);
    }

    private static Action action(String code, String label, String blocked, List<ActionType> list) {
        boolean anyReady = list.stream().anyMatch(ActionType::ready);
        String reason = blocked != null ? blocked : anyReady ? null : "لا يوجد نوع طلب منشور جاهز لهذا الإجراء.";
        return new Action(code, label, reason == null, reason, List.copyOf(list));
    }
}
