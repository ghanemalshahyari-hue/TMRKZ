# Stationing V3 lifecycle on `tmrkz-test` (4 Nov 2026, ADR-034)

**Environment.** `ACCEPTANCE / V20`:
- backend `mover/backend:rel-86a58db`;
- web `mover/web:rel-d05a7c2-v3`;
- real Keycloak/LDAP sign-in, OpenFGA in the loop, and the real 60-second scheduler (no test clock).

**Migration.** V20 was applied with owner approval (`../../acceptance-upgrade/tmrkz-test-v20/summary.txt`):
- plan [20], backup verified by restore;
- applied in 51 ms;
- 6,878 earlier rows unchanged; the Stationing fingerprint equal on 7 tables;
- schema change identical to the clean path (107 lines);
- OpenFGA 425 relations.

**Fictional lifecycle accounts.** Each holds one single-action right over the fictional organisation
(`../../acceptance-data/tmrkz-test-v3-lifecycle/`):

| Account | Right |
|---|---|
| `t.lc.cancel` | DECIDE_PRE_ACTIVATION_CANCELLATION |
| `t.lc.start` | DECIDE_BEFORE_START_CANCELLATION |
| `t.lc.return` | DECIDE_EARLY_RETURN |
| `t.lc.ext` | ACTIVATE_TEMPORARY_EXTENSION |

**Runs.** `ONLY=L SHIFT_M=-140000 node tests/acceptance/restationing-acceptance.mjs`:

| Run | Cases | Result | Files |
|---|---|---|---|
| 1 | all six | L1 and L3 passed. L2, L4, L5 and L6 stopped in the script's own sign-in: two cases signed in as the same account at once, and the second Keycloak flow returned no redirect. Not a product defect | `lifecycle-run1.txt`, `results-L-run1.json` |
| 2 | L2, L4, L5, L6 (`L_CASES=2,4,5,6`) after one shared sign-in per account | all passed | `lifecycle-run2.txt`, `results-L.json` |

0 console errors and 0 external requests in both runs.

| Case | Request(s) | Observed |
|---|---|---|
| L1 extension | RS-2026-0025 (temporary, IT), RS-2026-0027 (extension) | see below |
| L2 early return | RS-2026-0029 (SS) | see below |
| L3 cancellation before start | RS-2026-0024 (PM-1-1) | see below |
| L4 held start, refused after the start | RS-2026-0031 (PM-1) | see below |
| L5 window ends without a start | RS-2026-0030 (PM-1-1-1) | see below |
| L6 cancellation before activation | RS-2026-0028 (SS, permanent) | see below |

**L1 — extension**
- The temporary started with the real scheduler.
- The extension is a request of its own (2 stages), approved through its route.
- Activation was refused for «تفعيل التمركز» (403) and for its requester (403); `t.lc.ext` activated it.
- Past the original end the stationing stayed in force; it returned at the extended end.
- Records: 09:33:51 → 09:36:21 (SUPERSEDED), then 09:36:21 → 09:39:21 (RETURNED). No earlier date was edited.

**L2 — early return**
- The asker could not decide it (403).
- `t.lc.return` approved it on the page; the temporary ended at the decision, 09:42:12 (ENDED_EARLY), against a
  planned end of 10:00:58.
- Only the permanent stationing remains in force.

**L3 — cancellation before start**
- The early-return right could not decide it (403).
- `t.lc.start` approved it on the page. The record has an empty window (09:47:21 → 09:47:21, CANCELLED) and never
  took effect.
- State TEMPORARY_CANCELLED_BEFORE_START.

**L4 — held start, refused after the start**
- At the approved start (09:42:13) the scheduler held it: START_HELD_PENDING_CANCELLATION, and only the permanent
  stationing in force.
- `t.lc.start` refused the cancellation on the page with a reason.
- The temporary is in force from the decision (09:43:13), not backdated; the planned end is unchanged (10:00:58).
- It is ACTIVE_TEMPORARY until the scheduler returns it at its end.

**L5 — window ends without a start**
- The start was held; the end passed with the cancellation still pending.
- State TEMPORARY_WINDOW_EXPIRED_WITHOUT_START; the action is NO_LONGER_ACTIONABLE.
- A late decision was refused: 400 «انقضت نافذة النفاذ دون بدء؛ لم يعد القرار ممكناً».
- The record has an empty window (WINDOW_EXPIRED).

**L6 — cancellation before activation**
- The request became CANCELLATION_PENDING. Activation was refused while pending (400), and the asker could not
  decide (403).
- `t.lc.cancel` approved it on the page: CANCELLED_BEFORE_ACTIVATION.
- Activation was refused afterwards (400).

**Defect found while preparing the run, fixed in local commit `d05a7c2` (functional, separate).** The page's access
rule did not list the four lifecycle rights. A person holding only one of them would have seen «لا صلاحية» on the page
of the request to decide; the server already authorised them. Frontend 94/94; web `mover/web:rel-d05a7c2-v3`.

**Leftover.** RS-2026-0026 (UNDER_REVIEW) is the early-return case's first request. The script stopped on the sign-in
clash during its approvals; it is acceptance data, not a business request.

**Observations.**
- The lifecycle panel shows the effective end as a date only; for a short temporary the time matters too.
- A few map labels sit close to small markers at low zoom.

Screenshots: `L-before-start.png`, `L-early-return.png`, `L-held-refused.png`, `L-pre-activation.png`.
