# Stationing V3 — temporary and pre-activation lifecycle (implementation plan, 4 Nov 2026)

The owner's next item after the acceptance verdict ("functionally accepted, not production ready") is the missing
lifecycle: extension, early return and cancellation before start. The rules are the owner-approved model kept by V3
(`docs/STATIONING_DOMAIN_MODEL_V2_AR.md` §4.6–4.7: D9, D10, D12, D16, A4, A5, A6). This file records how they map onto
the V19 implementation. It is a plan, not a claim that anything is built.

## Migration V20 (schema only; applied to `tmrkz-test` only with the owner's approval)

| Change | Why |
|---|---|
| `restationing_request.kind` adds `EXTENSION`; new `parent_request_id` (→ the temporary request it extends) | D10: an extension is its own request with its own approval workflow |
| `restationing_request.state` adds `CANCELLATION_PENDING`, `CANCELLED_BEFORE_ACTIVATION`, `START_HELD_PENDING_CANCELLATION`, `TEMPORARY_WINDOW_EXPIRED_WITHOUT_START`, `EXTENSION_ACTIVATED`, `LAPSED_NOT_ACTIVATED` | D16, A6, D10, A5 |
| The "activated states need activation fields" check is recreated with the new activated states | integrity |
| New table `restationing_action` (`PRE_ACTIVATION_CANCELLATION`, `BEFORE_START_CANCELLATION`, `EARLY_RETURN`), states `REQUESTED` → `APPROVED` / `REJECTED` / `NO_LONGER_ACTIONABLE` / `SUPERSEDED` | D9/D16, A4/A6, D12. At most one open action per request (partial unique index). Fields: requester, reason, decider, decision reason, delegation, `held_at`, `closed_at` / `close_reason`, and the state to resume on rejection |
| `org_stationing.start_held_at` | A6: a temporary record whose start is held stays out of "in force", while still protecting its ground |
| `org_stationing.end_reason` adds `WINDOW_EXPIRED` | A6: the window ended without a start |

**A record that never took effect** (cancelled before start, window expired) keeps `planned_end`. It gets the empty
window `valid_to = valid_from`, which `valid_to >= valid_from` already allows, so it stays in history without ever
being in force.

## Permissions (separate, granted to no existing role)

| Permission | Purpose |
|---|---|
| `DECIDE_PRE_ACTIVATION_CANCELLATION` | D16 |
| `ACTIVATE_TEMPORARY_EXTENSION` | D10 |
| `DECIDE_EARLY_RETURN` | D12 |
| `DECIDE_BEFORE_START_CANCELLATION` | A4; never carried by `DECIDE_EARLY_RETURN`. The model's name is `DECIDE_TEMPORARY_BEFORE_START_CANCELLATION`; it is shortened because OpenFGA limits a relation name to 50 bytes and the generated `…_contains` relation would be 51 |

Asking for a cancellation, an early return or an extension needs the original requester (the same human) or
«طلب إعادة التمركز» for the requesting unit. The decider is never the human who asked; humans are compared with
PersonKeys, and delegations count for the delegator. The decider's right must cover every moving unit, as for
activation.

## Operations

1. **Cancellation before activation (D9, D16).**
   - **When:** from UNDER_REVIEW, RETURNED_FOR_CHANGES, PAUSED_HIERARCHY_CHANGED or APPROVED_NOT_ACTIVATED.
   - **Effect of the request:** the request becomes CANCELLATION_PENDING. Decisions and activation refuse it, because
     the activation transaction accepts only APPROVED_NOT_ACTIVATED.
   - **Approved:** CANCELLED_BEFORE_ACTIVATION.
   - **Rejected:** back to the recorded state.
2. **Extension (D10, A5).**
   - **When:** while the parent is TEMPORARY_SCHEDULED or ACTIVE_TEMPORARY, with no other open extension.
   - **The request:** a request of kind EXTENSION, for the same unit, units and site, with a later end. It goes
     through the normal submission (policy pinned, route derived from the requesting unit) and the normal stage
     decisions.
   - **Checks:** the new end must be after the current effective end; the geometry is not re-checked.
   - **Activation:** `ACTIVATE_TEMPORARY_EXTENSION` covering the units. The extension's requester and final approver
     may not activate it.
   - **Effect of activation:** the open temporary record closes at the current effective end (SUPERSEDED), and a
     following temporary record runs from that end to the new one. Earlier dates are never edited.
   - **Lapse:** if the parent ends, is cancelled or its window expires first, an unactivated extension becomes
     LAPSED_NOT_ACTIVATED, with a lapse reason and time.
3. **Cancellation before start (A4, A6).**
   - **When:** after activation, before the effective start (TEMPORARY_SCHEDULED).
   - **Approved:** the records end with the empty window (CANCELLED); the request becomes
     TEMPORARY_CANCELLED_BEFORE_START; deployment areas retire; extensions lapse.
   - **Rejected before the start:** nothing changes.
   - **Start reached while the cancellation is pending:** the scheduler holds the start.
     - The request becomes START_HELD_PENDING_CANCELLATION, and the records get `start_held_at`.
     - Event `STATIONING_START_HELD`, and `held_at` on the action.
     - Then, if approved: as above.
     - If rejected before the end: the start counts from the decision (`valid_from` = decision time, no backdating);
       the end is unchanged.
     - If the end passes first: TEMPORARY_WINDOW_EXPIRED_WITHOUT_START, the record ends WINDOW_EXPIRED, and the
       action becomes NO_LONGER_ACTIONABLE.
4. **Early return (D12).**
   - **When:** while ACTIVE_TEMPORARY.
   - **Approved:** in one transaction, the open temporary records end now (ENDED_EARLY, actor, time, reason, planned
     and actual end); the request becomes TEMPORARY_RETURNED; deployment areas retire; extensions lapse.
   - **Rejected:** nothing changes.
   - **Overtaken:** a natural end with the early return still pending marks it SUPERSEDED.
   - **Not before the start (A4).**

## Not in this step

D11 end-of-temporary reminders (advisory); a reminder settings model.

## Tests and verification

- **Backend:** `RestationingLifecycleIT` on PostgreSQL + OpenFGA covers every transition above, the separation by
  human, the scheduler guard, lapse and window expiry, and that the read contract never shows a held or cancelled
  record. The full suite follows.
- **`tmrkz-test`:** V20 needs the owner's approval to apply. The new permissions need fictional roles in the
  acceptance provisioning.
