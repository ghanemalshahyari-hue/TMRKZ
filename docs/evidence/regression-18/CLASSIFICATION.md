# The 18 pre-existing backend test failures — classification (25 Nov 2026)

**Scope:** the 18 failures in `RestationingWorkflowIT` (8), `StationingNextIT` (9) and `SiteSetupIT` (1). They were
identical on an untouched `e30c1c1` extract, so they predate ADR-103 and ADR-104.

**How I checked:**

- **Application code:** `8800b58` (HEAD). No application file was changed.
- **Database:** a throw-away PostgreSQL 17 + PostGIS database with OpenFGA, run by the isolated test runner.
- **Before:** [`run-before.txt`](run-before.txt), 40 run, 18 failures.
- **After:** [`run-after.txt`](run-after.txt), 40 run, 0 failures.

**Changed:** only the three test classes.

- No test was deleted, and none was disabled or skipped.
- No authorization or scope check was weakened.
- Every replaced assertion now checks the current designed behaviour. Most also gained a check, for example who activated
  the request, that the request was not activated, record counts that must not change, or that no audit event was written.

## Root causes

Two deliberate design changes left the test expectations behind. Neither is an application defect.

- **A — ADR-095 (owner, 21 Nov 2026, commit `7df000b`): activation is part of the final approval.**
  - *Text of the decision:* «The request moves from UNDER_REVIEW directly to ACTIVATED_PERMANENT (or TEMPORARY_SCHEDULED /
    ACTIVE_TEMPORARY for a temporary purpose) without ever surfacing APPROVED_NOT_ACTIVATED to any UI.»
  - *The activate endpoint:* `POST /restationing-requests/{id}/activate` «is retained as an idempotent no-op».
  - *The FYI endpoints:* «The three FYI endpoints (`GET /fyi-options`, `POST /fyi`, `POST /fyi/{unit}/end`) are REMOVED».
  - *Separation of duties:* «The previous D1 rule — «the final approver cannot activate» — is retired by construction».
  - *The ADR itself flagged this migration as unfinished:* «The remaining stationing ITs (`RestationingWorkflowIT`, …,
    `StationingNextIT`) still carry the pre-ADR-095 two-step assertions and are being migrated as part of this change».
- **B — ADR-094 Gate 2 §C (commit `7df000b`): `GET /operational-posture` now returns the compact Site-Hub summary by
  default.**
  - The default answer holds `siteHubs`, `summary`, `noStationingSummary` and `unitsTotal`, but no `units` and no
    `pending` array.
  - The per-unit records are now served at `?view=UNITS`. `RequestHubController.posture` documents this, and
    [docs/PERFORMANCE_HARDENING.md](../../PERFORMANCE_HARDENING.md) §3 item 3 says the «POSTURE-* semantic-parity scenarios»
    run «against the legacy `?view=UNITS` shape».
  - `PostureViewerScopeIT` already uses `?view=UNITS`.

## Per test

| Test (class.method:line) | Classification | Evidence | Action taken | Result after |
|---|---|---|---|---|
| RestationingWorkflowIT.inheritedSeat:45 | Obsolete expectation | A; `RestationingService.settle` → `applyApprovedDecision` | Now expects `ACTIVATED_PERMANENT` after the final APPROVE | Pass |
| RestationingWorkflowIT.permanentJourney:71 | Obsolete expectation | A: «retired by construction» and «idempotent no-op»; `RestationingController.activate` returns the view | The final APPROVE activates, recorded as `activation.by` = the final approver. The old separation-of-duties checks on `/activate` became: the call is a no-op for the approver, the requester and a bystander (state unchanged, no new stationing rows, no audit event), and gives 404 to a person who cannot see the request. Every later check (stationing records, outbox, geometry, areas, site link untouched, audit) is unchanged | Pass |
| RestationingWorkflowIT.returnAndSelectiveReapproval:135 | Obsolete expectation | A: a temporary request starting later goes to `TEMPORARY_SCHEDULED` | Now expects `TEMPORARY_SCHEDULED`, plus a new check that the route marks stay `APPROVED, CARRIED, APPROVED` (the carried stage is not decided again) | Pass |
| RestationingWorkflowIT.partialApproval:196 | Obsolete expectation | A | Now expects `ACTIVATED_PERMANENT` | Pass |
| RestationingWorkflowIT.activationRefusedOnDrift:234 | Obsolete expectation | A: final approval «triggers the same server checks … hierarchy drift refusal»; `decide` → `pauseIfDrifted` | There is no longer a window between approval and activation. The hierarchy now moves just before the final APPROVE, and that APPROVE is refused with 400 and `HierarchyDrift.MESSAGE`. Checked: the request is paused, there is no REQUEST stationing, and `activated_at` is null | Pass |
| RestationingWorkflowIT.activationRefusedWhenGroundTakenSinceApproval:249 | Obsolete expectation | A: «geography re-check, atomic conflict prevention … INSIDE THE SAME TRANSACTION»; `applyApprovedDecision` refuses with «تغيّر إشغال الأرض منذ الاعتماد» | The ground is now taken after the earlier stages and before the final APPROVE, which is refused with 400 and the same message. New checks: the whole decision rolls back (still `UNDER_REVIEW`, no activation, the final stage undecided, no REQUEST stationing for either unit, no `RESTATIONING_FINAL_APPROVAL` or `RESTATIONING_ACTIVATED` audit) | Pass |
| RestationingWorkflowIT.checks:354 | Obsolete expectation | A | Now expects `ACTIVATED_PERMANENT`. The rest of the test still passes after the activation, including the final approver's later rejection of a second request | Pass |
| RestationingWorkflowIT.crossBranchInclusion:386 | Obsolete expectation | A | Now expects `ACTIVATED_PERMANENT` | Pass |
| StationingNextIT.initialStationingIsSiteSetup:204 | Obsolete expectation | A (no FYI or activation step, `/fyi` removed); ADR-095 B2 `fyi_designation` (V64) | Details below this table | Pass |
| StationingNextIT.hierarchyLevelsWithNobodyAreSkipped:302 | Obsolete expectation | A | Now expects `ACTIVATED_PERMANENT`, plus a new check that `finalApprover` is the actual person (never approved by nobody) | Pass |
| StationingNextIT.aPathForEachType:389 | Obsolete expectation | A: the last level of a published path is final | Now expects `ACTIVATED_PERMANENT` | Pass |
| StationingNextIT.nearestScopeDecides:413 | Obsolete expectation | A | Now expects `ACTIVATED_PERMANENT`, plus a new check that `finalApprover` is the nearest holder | Pass |
| StationingNextIT.seatSurvivesHolderChange:452 | Obsolete expectation | A | Now expects `ACTIVATED_PERMANENT` | Pass |
| StationingNextIT.fyiReadsOneRequestOnly:533 | Obsolete expectation | A; B2 `fyi_designation`; `RestationingService.autoFyi` / `fyiReader` | Details below this table | Pass |
| StationingNextIT.deploymentAndPosture:619 (via `wholeRoute`:107) | Obsolete expectation (A + B) | A for `wholeRoute`; B for the posture checks | `wholeRoute` migrated as below. The per-unit posture reads use `?view=UNITS`. The 403 checks for people without the right still use the default endpoint, which enforces the same permission | Pass |
| StationingNextIT.operationalPosturePending:707 | Obsolete expectation | B: `pending` is in the `?view=UNITS` shape only | The three posture reads use `?view=UNITS`. Every scope and leak check is kept: the posture right alone reveals no proposal, another branch's proposal never shows, drafts are excluded, and the row fields are checked | Pass |
| StationingNextIT.siteRegistration:755 (via `wholeRoute`:107) | Obsolete expectation | A | `wholeRoute` migrated | Pass |
| SiteSetupIT.readsLikeActivated:296 | Obsolete expectation | B | New check: the default Site-Hub summary lists the set-up site as a complete hub. The per-unit record is read from `?view=UNITS` with the same site, kind and area checks | Pass |

**`wholeRoute` (StationingNextIT helper):**

- The final approver's APPROVE returns `ACTIVATED_PERMANENT`.
- `activation.by` is the final approver.
- `fyi_done_at` is set within that same transaction.
- The removed `/fyi` call and the separate `/activate` call were dropped.

**initialStationingIsSiteSetup:**

- `otherSec` is configured as an FYI unit before the final APPROVE. That APPROVE activates the request and sends the
  notification.
- The removed `/fyi` endpoint now answers 404 or 405, where it used to answer 403.
- `/activate` called by an FYI reader answers 200 with the read-only view and changes no stationing.
- Every reader-isolation check is kept: one notification, this request only, no decision, no lasting right.

**fyiReadsOneRequestOnly:**

- The recipients are created and `otherSec` is configured before the final APPROVE, which distributes the request
  automatically.
- These checks are kept:
  - read-only access to this one request only;
  - no actions offered;
  - parent and sibling units inherit nothing;
  - nobody without a permission gets in;
  - the audit names the unit and the recipient;
  - access ends when the person moves in HR or the request is cancelled.
- The forged-mutation checks are now:
  - `/decision` and `/content` are still refused;
  - `/activate` is a no-op;
  - the removed `/fyi` and `/fyi/{unit}/end` answer 404 or 405;
  - a new check that the reader's attempts write no audit event and leave the state `ACTIVATED_PERMANENT`.
- The holder's «end with a reason» step was removed with its endpoint (ADR-095). The test checks that the FYI record
  stays.

**Totals:**

- 18 fixed as obsolete expectations (A only: 15, B only: 2, A and B together: 1).
- 0 application defects among the 18.
- 0 environment limitations.
- 0 unresolved.

Final run of the three classes: `Tests run: 40, Failures: 0, Errors: 0, Skipped: 0`, BUILD SUCCESS
([`run-after.txt`](run-after.txt)).

## Application defect found during the review (not one of the 18; not fixed)

**FYI distribution after final approval cannot be configured from the application (ADR-095 B3/B4 not implemented).**

**What happens:**

- `RestationingService.autoFyi` reads only the table `fyi_designation`. The V64 comment says it is «Maintained by
  SYSTEM_ADMIN organisation-wide and by UNIT_ACCESS_MANAGER within their scope (ADR-095 B3). Changes audited as
  ACCESS_FYI_DESIGNATION_SET / _REMOVED».
- No application code writes `fyi_designation`, and no code writes those audit events. A search of `backend/src/main`
  and `frontend/src` finds only the `select` in `autoFyi`.
- The screen «الجهات الرئيسية للعلم» (`PUT/DELETE /access/fyi-mains/{id}`, `GrantAdminService.setFyiMain`) writes a
  different table, `fyi_main_command`. That table feeds `PlaceInfo`'s MAIN_COMMAND parties and the generic request FYI.
  `autoFyi` never reads it.

**Effect:** on a real installation, re-stationing FYI after final approval only reaches units inserted into
`fyi_designation` by SQL. An administrator who sets «الجهات الرئيسية للعلم» in the screen would reasonably expect
re-stationing requests to be shared with those units, and they are not.

**Evidence:** the two FYI tests above can configure FYI only through a SQL fixture (`StationingNextIT.designateFyi`)
because no endpoint exists.

**Proposed minimal patch (needs the owner's decision on which table is the source of truth):**

- **Either** add `PUT /access/fyi-designations/{unitId}?includeDescendants=` and `DELETE /access/fyi-designations/{id}`
  in `AccessController`, backed by a `GrantAdminService` method that:
  - requires `MANAGE_ACCESS` everywhere for organisation-wide rows, or `UNIT_ACCESS_MANAGER` covering the unit;
  - writes `fyi_designation` (`set_by`, `set_at`);
  - writes the `ACCESS_FYI_DESIGNATION_SET` or `_REMOVED` audit event.

  The screen «الجهات الرئيسية للعلم» would then offer the include-descendants choice. A test would drive the
  configuration through the API instead of the SQL fixture.
- **Or** make `autoFyi` read `fyi_main_command` (plus a descendants flag) and drop `fyi_designation`.

**Not fixed here:** application code was out of scope for this task.

## Related observation (passes today, no action taken)

`RestationingWorkflowIT.temporaryLifecycle` still calls `/activate` as the «activator» after the final approval and
expects `TEMPORARY_SCHEDULED`. It passes only because the no-op returns the current view. The test stays correct
because it is still checked against the current state; its wording simply predates ADR-095.
