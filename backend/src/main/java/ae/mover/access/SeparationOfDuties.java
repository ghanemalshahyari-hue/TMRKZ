package ae.mover.access;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;

/**
 * Separation of duties (owner decision of 2 Nov 2026, ADR-027): nobody decides a request they made, at any stage and
 * whatever roles, organisations or seats they hold. "They" is the human ({@link PersonKeys}): the creator's record and
 * every record sharing one of its sign-in keys. A grant received through a delegation acts for its delegator, so the
 * requester's authority delegated to someone else does not decide the request either. There is no switch: relaxing the
 * rule needs a recorded owner decision and a code change.
 */
@Component
public class SeparationOfDuties {

    public static final String REFUSAL = "لا يجوز البت في طلب قدمته أنت، ولا بصفة فوّضتها أنت لغيرك؛ يبت فيه صاحب صفة مستقل.";

    private final JdbcClient jdbc;
    private final PersonKeys keys;

    public SeparationOfDuties(JdbcClient jdbc, PersonKeys keys) {
        this.jdbc = jdbc;
        this.keys = keys;
    }

    public static ApiException refusal() {
        return new ApiException(ErrorCode.SEPARATION_OF_DUTIES, REFUSAL);
    }

    /** The person records that count as the requester of each request. */
    public Map<UUID, Set<UUID>> requesters(Collection<UUID> requestIds) {
        Map<UUID, UUID> creators = new HashMap<>();
        if (!requestIds.isEmpty()) {
            jdbc.sql("select id, created_by from request where id = any(string_to_array(:ids, ',')::uuid[])")
                    .param("ids", Db.ids(requestIds))
                    .query((rs, n) -> creators.put(Db.uuid(rs, "id"), Db.uuid(rs, "created_by"))).list();
        }
        Map<UUID, Set<UUID>> same = keys.samePeople(Set.copyOf(creators.values()));
        Map<UUID, Set<UUID>> out = new HashMap<>();
        creators.forEach((request, creator) -> out.put(request, Set.copyOf(same.get(creator))));
        return out;
    }

    /**
     * Everyone who approved another step of this request, and whoever they acted for: nobody among them decides a step that
     * must be independent of earlier approvals (ADR-042, as in the movement programme). Compared by the human, not the record.
     */
    public Set<UUID> earlierApprovers(UUID requestId, String stageKey) {
        Set<UUID> signers = new java.util.HashSet<>(jdbc.sql("""
                select de.actor_person_id from decision de
                where de.request_id = :r and de.stage_key <> :s and de.decision in ('APPROVE', 'REFER')
                union
                select dl.delegator_id from decision de join delegation dl on dl.id = de.via_delegation_id
                where de.request_id = :r and de.stage_key <> :s and de.decision in ('APPROVE', 'REFER')""")
                .param("r", requestId).param("s", stageKey).query(UUID.class).list());
        Set<UUID> out = new java.util.HashSet<>();
        keys.samePeople(signers).values().forEach(out::addAll);
        return out;
    }

    public static final String EARLIER_REFUSAL = "لا يبت في هذه الخطوة من وافق على الطلب في خطوة سابقة؛ يبت فيها شخص آخر مخوّل.";

    public Set<UUID> requester(UUID requestId) {
        return requesters(List.of(requestId)).getOrDefault(requestId, Set.of());
    }

    /**
     * Who may not complete an execution step, and why it cannot be completed yet (ADR-028). A HANDOVER is never made by
     * the requester (nor through their delegation): the facility is not handed to oneself. A RECEIPT is the receiving
     * party's confirmation of a completed handover: it waits for the handover and is never made by the human who handed
     * over. An ACKNOWLEDGEMENT or other step has no exclusion — the requester may record completing their own work.
     */
    public record StepRule(Set<UUID> excluded, String waiting) {
    }

    public StepRule step(String purpose, UUID requestId, Set<UUID> requesters) {
        if ("HANDOVER".equals(purpose)) {
            return new StepRule(requesters, null);
        }
        if (!"RECEIPT".equals(purpose)) {
            return new StepRule(Set.of(), null);
        }
        boolean pending = false;
        java.util.Set<UUID> performers = new java.util.HashSet<>();
        for (Map<String, Object> h : jdbc.sql("select status, completed_by from execution_task where request_id = :r and purpose = 'HANDOVER'")
                .param("r", requestId).query().listOfRows()) {
            pending |= "OPEN".equals(h.get("status"));
            if (h.get("completed_by") != null) {
                performers.add((UUID) h.get("completed_by"));
            }
        }
        java.util.Set<UUID> excluded = new java.util.HashSet<>();
        keys.samePeople(performers).values().forEach(excluded::addAll);
        return new StepRule(excluded, pending ? "يؤكد الاستلامُ تسليماً تمّ؛ أكمل مهمة التسليم أولاً." : null);
    }

    public static ApiException stepRefusal(String purpose) {
        return new ApiException(ErrorCode.SEPARATION_OF_DUTIES, "RECEIPT".equals(purpose)
                ? "لا يؤكد الاستلام من سلّم المرفق؛ يؤكده طرف مستلم مستقل مخوّل."
                : "لا يسلّم مقدم الطلب المرفق لنفسه؛ يسلّمه صاحب صفة مستقل مخوّل.");
    }

    /** The actor's view: who delegated each of their delegated grants (loaded once per actor). */
    public Independence of(AccessContext ctx) {
        List<UUID> delegations = ctx.grants().stream().map(Grant::delegationId).filter(Objects::nonNull).distinct().toList();
        Map<UUID, UUID> delegators = new HashMap<>();
        if (!delegations.isEmpty()) {
            jdbc.sql("select id, delegator_id from delegation where id = any(string_to_array(:ids, ',')::uuid[])")
                    .param("ids", Db.ids(delegations))
                    .query((rs, n) -> delegators.put(Db.uuid(rs, "id"), Db.uuid(rs, "delegator_id"))).list();
        }
        return new Independence(ctx, delegators);
    }

    public static final class Independence {

        private final AccessContext ctx;
        private final Map<UUID, UUID> delegators;

        Independence(AccessContext ctx, Map<UUID, UUID> delegators) {
            this.ctx = ctx;
            this.delegators = delegators;
        }

        /** The actor is one of the requesters. */
        public boolean isRequester(Set<UUID> requesters) {
            return requesters.contains(ctx.personId());
        }

        /** A grant acting neither as nor for someone in {@code excluded}. */
        private boolean independentOf(Grant g, Set<UUID> excluded) {
            UUID delegator = g.delegationId() == null ? null : delegators.get(g.delegationId());
            return delegator == null || !excluded.contains(delegator);
        }

        /** A grant completing an execution step independently of {@code excluded} (see {@link #step}), or empty. */
        public Optional<Grant> executionGrant(String roleCode, UUID targetOrgId, RequestScope r, Set<UUID> excluded) {
            if (excluded.contains(ctx.personId())) {
                return Optional.empty();
            }
            return ctx.executionGrant(roleCode, targetOrgId, r, g -> independentOf(g, excluded));
        }

        /** Administrative closing by an authorised actor independent of the requester (ADR-028). */
        public boolean mayClose(RequestScope r, Set<UUID> requesters) {
            return !isRequester(requesters) && ctx.grants().stream()
                    .anyMatch(g -> g.has(Permission.CLOSE) && g.coversRequest(r) && independentOf(g, requesters));
        }

        /** A grant deciding the task without acting for a requester, or empty. */
        public Optional<Grant> taskGrant(String roleCode, UUID targetOrgId, RequestScope r, boolean finalStage, Set<UUID> requesters) {
            if (isRequester(requesters)) {
                return Optional.empty();
            }
            return ctx.taskGrant(roleCode, targetOrgId, r, finalStage, g -> independentOf(g, requesters));
        }

        /**
         * The grant for a decision, or the refusal: separation of duties when the actor is a requester or holds the task
         * only through a requester's delegation, otherwise the ordinary "no capacity" refusal.
         */
        public Grant require(String roleCode, UUID targetOrgId, RequestScope r, boolean finalStage, Set<UUID> requesters) {
            return taskGrant(roleCode, targetOrgId, r, finalStage, requesters).orElseThrow(() ->
                    isRequester(requesters) || ctx.taskGrant(roleCode, targetOrgId, r, finalStage).isPresent()
                            ? refusal() : ApiException.forbidden("لا تملك حالياً صفة هذه المهمة أو نطاقها."));
        }
    }
}
