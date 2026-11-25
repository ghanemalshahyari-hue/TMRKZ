# The 20 remaining backend failures: investigation and correction (25 Nov 2026)

**Scope:** the 20 tests listed as open in [`PRE-EXISTING-OTHERS.md`](PRE-EXISTING-OTHERS.md). All 20 also failed on an
untouched `8800b58`.

**How I checked:**

- **Runner:** the isolated runner (`ops/test-backend.sh` logic, private container names). It copies `backend/` to a
  private tree, then runs it against a throw-away PostgreSQL 17 + PostGIS database with OpenFGA in the loop.
- **Diagnostics:** the posture test ran once more with `auto_explain` (every statement over 40 ms logged with its
  analysed plan).
- **History:** each failure was traced through the test, the application path, `git log -S` and the ADRs.

**Changed:** seven test classes. No application file was changed.

- No test was deleted, disabled or skipped.
- No bound was raised.
- No authorization or scope assertion was loosened. Three were strengthened (details in the table).

## Totals

| Class | Tests | Result after |
|---|---|---|
| (a) application defect | 0 | none found |
| (b) obsolete expectation, documented design change | 11 | 11 pass |
| (c) test fixture or measurement defect | 9 | 9 pass |
| (d) environment limit | 0 | none |
| **Total** | **20** | **20 pass** (the posture gate: in the intermediate run, with the same code; see Runs) |

Three tests could not reach their own assertions until a first cause was fixed. Once the shared `AccessScopeParityIT`
fixture ran, three of its tests failed again, on assertions that had never executed before. Each is listed with both causes.

## Root causes

**A. ADR-095, commit `7df000b` (owner, 21 Nov 2026): activation is part of the final approval.**

- The request moves from `UNDER_REVIEW` directly to `ACTIVATED_PERMANENT`, `TEMPORARY_SCHEDULED` or `ACTIVE_TEMPORARY`,
  without ever surfacing `APPROVED_NOT_ACTIVATED`.
- «An approved extension's activation runs the same way inside the final approver's transaction (D10)».
- `POST /restationing-requests/{id}/activate` «is retained as an idempotent no-op».
  - `RestationingService.activate` returns the view for every state except `APPROVED_NOT_ACTIVATED`.
- The ADR names `RestationingLifecycleIT` and `RestationingHrSyncIT` as «still carry[ing] the pre-ADR-095 two-step
  assertions».
- The migration follows the precedent in [`CLASSIFICATION.md`](CLASSIFICATION.md).

**B. ADR-094, V55, commit `410b5f4`: people are no longer read in bulk.**

- The rule: «`people_sync` (off: people are never read in bulk) … With `people_sync` on, the earlier behaviour (linked
  people refreshed in every run) remains».
- With the switch off, the run carries the linked people forward unchanged (`HrSyncService`, `peopleCarried`).
  - An HR transfer therefore does not move an affiliation until that person is refreshed on demand.
- Precedent: `HrSyncAcceptanceIT` and `HrLinkedPeopleIT` already set `peopleSync: true`, because they check people
  following HR in every run.

**C. ADR-095 (assistant, owner, 20 Nov 2026; implemented in `410b5f4`): the assistant never answers from a
preprogrammed template.**

- «When the assistant is off … the response's `answer` is null (mode `OFF`, with `degraded` naming the reason) … the
  matching OKF documents remain as links».
- `AssistantService.ask` returns `new Answer("OFF", null, hits, null, "OFF")`.

**D. The access-request offer list (ADR-044 V29; ADR-078 V49 `0d6852c`; ADR-095 Q3 V64 `7df000b`).**

- What a person may ask for is the administrator's setting.
- V49 put «مقدم الطلب» (`STATIONING_REQUESTER`) in `REQUESTER`'s place.
- V64 deleted MOVER's facility roles, `REQUESTER` among them, from `access_request_offer` on every installation.
- The test environment still seeds the `REQUESTER` role (`legacy-facility-roles=true`) for the facilities engine, but no
  longer offers it.
- `AccessRequestService.submit` checks the list before the scope. A request for `REQUESTER` was therefore refused with
  400 «اختر صلاحية واحدة على الأقل من القائمة» before any other rule ran.

**E. ADR-061 (owner, 16 Nov 2026, `a917d53`): a unit's users are those who were added.**

- «an HR posting, a position seat or a sign-in alone lists no one. Counts, the tree, the people search, the unit file and
  the whole-unit check use that set».
  - Implemented as `AccessWorkspaceService.USERS`: `unit_member`, `membership` and `duty_permit`.
- `AccessScopeParityIT` was written on 21 Nov (`410b5f4`) and assumed that an HR posting alone lists a person.

**F. One shared database across test classes and Spring contexts (fixture defect).**

- Several classes seed the same canonical role codes (`CHAIN_APPROVER`, `UNIT_OPERATIONS_APPROVER`, …) with different
  names and permissions, using `on conflict do nothing`. Whichever class runs first decides for the rest.
- `MatrixColumnsIT` runs before `WorkflowGraphIT`.
  - It names each role by its code.
  - It gives `UNIT_OPERATIONS_APPROVER` no `REVIEW`.
- Other contexts (`IntegrationTest` sets `legacy-facility-roles=true`) seed MOVER's facility roles.
- Other classes add `T_…` roles through `IntegrationTest.role()`.
- The 21 Nov acceptance report had already recorded this leak for `MatrixColumnsIT`
  (`docs/FINAL_REAL_ACCEPTANCE_2026-11-21.md`, Phase 1 caveat).

**G. The posture scan-count gate read a counter that one call cannot be attributed to (measurement defect).**

- `pg_stat_user_tables` is shared by every backend.
- Each backend flushes its counters at most once a second and defers the rest by up to 10 s. A delta taken around one
  HTTP call therefore:
  - drops the call's own deferred scans;
  - picks up whatever other backends flush meanwhile. In the full suite, these include the schedulers of every cached
    Spring context on the same tables.

| Run | Global delta at 100 / 1,000 / 5,000 units | JDBC statements at 100 / 1,000 / 5,000 |
|---|---|---|
| Full suite on `8800b58` | 0 / **494** / **61** (failed, bound 50) | 11 / 12 / 15 |
| The class alone | 0 / 6 / 6 | 11 / 12 / 15 |

- **Exact count:** `pg_stat_xact_user_tables` gives the computation's own count, read inside one transaction: **5 / 6 / 6**.
- **auto_explain:** no posture statement took 40 ms, even at 5,000 units.
- **Conclusion:** no query grew.

## Per test

| Test | Root cause (evidence) | Class | Action | Result |
|---|---|---|---|---|
| AccessScopeParityIT.addUserLookup | The `@BeforeEach` `update unit_member set ended_at = now()` sets no `ended_by` and violates V33 `check ((ended_at is null) = (ended_by is null))` (`unit_member_check1`; the failing row has `ended_by` null and `ended_at` after `added_at`, so the preliminary «timing» reading was wrong). Written in `410b5f4` after V33 (`f0552ac`), so it never ran. Then: the error bodies were compared including the per-request `traceId` | (c) | The entry is ended as `UnitMemberService` ends it: `ended_at`, `ended_by`, `ended_reason`. The bodies are compared without `traceId`, which is all that differs; added a check that the trace ids differ | Pass |
| AccessScopeParityIT.addUserLookupByUsername | Fixture, as above | (c) | Fixture fixed | Pass |
| AccessScopeParityIT.attachmentActive | Fixture, as above | (c) | Fixture fixed | Pass |
| AccessScopeParityIT.countsScoped | Fixture, as above. Then: it read `GET /access/workspace/units/{id}/summary`, which has never existed (404). The controller has had `/summary` and `/units/{id}` since `f0552ac` | (c) | Reads `/access/workspace/summary`. The range 3..6 became exact counts: 2 units, 4 people (P1, P2, P6, M1). The A1 unit file must count exactly 3. A unit outside the reach is refused (403/404) | Pass |
| AccessScopeParityIT.searchByName | Fixture, as above. Then: P1 and P2 were only HR-posted, which lists no one in the people search (E) | (c), then (b) E | P1–P5 become users of the units they are posted at (`unit_member`), so P3–P5 are real users outside the reach. Added a control: a manager over everything finds P1–P6, so the absence for M1 comes from the scope rule | Pass |
| AccessScopeParityIT.treeStartsAtReach | Fixture, as above | (c) | Fixture fixed | Pass |
| MatrixColumnsIT.exactly8Columns | F. In the suite the matrix also listed the 5 MOVER facility roles and 6 `T_SCOPE_MGR_…` roles. Its own `legacy-facility-roles=false` stops only this context's seeding. V64 deletes those roles on every installation | (c) | The 8 canonical roles must lead, in order. With only the 5 test-environment facility codes and the `T_` helper roles set aside, the columns must be exactly the 8. Every banned code is still checked against the full list. The seed uses the ADR-095 role names instead of the codes | Pass |
| OperationalPostureScaleIT.postureScales | G | (c) | The gate now reads the exact per-transaction count of the same overview (`RequestHubService.postureOverview`, same viewer), with the **same bound (< 50)**. Added: no growth from 100 to 5,000 units (≤ +5). The global delta stays reported, not asserted. Reach and overview times are reported separately | Pass (5 / 6 / 6) |
| SupportIT.assistantOff | C | (b) | Expects `mode` = `OFF`, `degraded` = `OFF`, no `answer`, no `model`, and the same first source link. The admin-only guide never leaks, the 501-character question gives 400, and the audit is unchanged | Pass |
| WorkflowGraphIT.askingForPermissions | D (alone it fails on the 400). In the suite it failed first on the role name `UNIT_OPERATIONS_APPROVER` (F) | (b) D + (c) F | Fixture: the administrator offers `REQUESTER` with the three V29 roles through `PUT /access-requests/offer` (ADR-044); the whole offer row is restored after each test. The role definitions these journeys are written for are upserted | Pass |
| WorkflowGraphIT.askingWithScope | D. The 400 came from the list check before the scope rule. **Verified:** `AccessRequestService.checkScope` still refuses `ALL` with 403 at submission (line 455) | (b) | The 403 assertion is kept and **strengthened**: the role is shown to be on the person's list first (so only the scope rule can refuse), the message is checked, and nothing is recorded | Pass |
| WorkflowGraphIT.askingWithoutReviewer | D (no id came back, hence «Invalid UUID string») | (b) | Fixture as above | Pass |
| WorkflowGraphIT.finalApproverSetsEachRole | D | (b) | Fixture as above | Pass |
| WorkflowGraphIT.movedBeforeFinalIsRerouted | D | (b) | Fixture as above | Pass |
| WorkflowGraphIT.routesByTime | F. It passes alone; in the suite `UNIT_OPERATIONS_APPROVER` came from `MatrixColumnsIT` without `REVIEW`, so publication was refused with «تعريف التدفق غير صالح» | (c) | Upserts its definition (`WorkflowGraphIT` runs last in the suite) | Pass |
| RestationingHrSyncIT.hierarchyChangeThroughHrSync | A. `/activate` on a paused request answers 200 (no-op). The `ACTIVATE_STATIONING` right was deleted (V62) | (b) | The bystander keeps VIEW only. The no-op changes nothing while the request is paused or under review (state and zero stationing records checked). The new route's final APPROVE activates, recorded as `activation.by` = the final approver | Pass |
| RestationingHrSyncIT.transfersThroughHrSync | B. The source was saved without `peopleSync`, so holder A's affiliation never moved (got DEPT_A, expected DEPT_B) | (b) | `peopleSync: true`, and the saved source is checked. The seat-release and ownership checks are unchanged | Pass |
| RestationingLifecycleIT.cancellationBeforeActivation | A. `approvedPermanent` is now `ACTIVATED_PERMANENT`, so «يُطلب الإلغاء قبل التفعيل فقط» | (b) | New check: an activated request is refused with that exact message. The cancellation is asked with only the final stage left. A pending cancellation blocks the final APPROVE (400, nothing activated). A rejection restores `UNDER_REVIEW`. The separation-of-duties checks are unchanged. Once cancelled, the final APPROVE is refused and `/activate` is a no-op (no stationing, no `RESTATIONING_ACTIVATED`) | Pass |
| RestationingLifecycleIT.extension | A (D10) | (b) | The final APPROVE gives `EXTENSION_ACTIVATED`, by the final approver, with exactly one `RESTATIONING_EXTENSION_ACTIVATED` event. For the requester, the final approver, the bystander and the activator, `/activate` is a no-op: no activation action, no new record, no audit event. The record and date checks are unchanged | Pass |
| RestationingLifecycleIT.extensionLapses | A. An extension not yet activated is one still under review | (b) | The extension is approved by every stage but the final one, then lapses (`LAPSED_NOT_ACTIVATED`, reason set). New checks: the final APPROVE is refused, the no-op changes nothing, there is no stationing or activation event, and only the permanent stationing stays in force | Pass |

## Application defects

None of the 20 failures came from the application. Two findings are recorded, and neither was changed:

1. **Posture time grows with the unit count, from authorization rather than SQL.**
   - *Cause:* `RestationingService.reach` (line 1330, `ids.removeIf(u -> !ctx.canFor(permission, u))`, since `9aaf310`) asks
     OpenFGA once per reached unit.
   - *Measured:*

     | Units | Reach confirmation | Overview SQL (confirmations known) |
     |---|---|---|
     | 100 | 240 ms | 7 ms |
     | 1,000 | 1,643 ms | 8 ms |
     | 5,000 | 8,977 ms | 27 ms |

   - *Effect:* about 9 s for a 5,000-unit viewer, and proportionally more beyond.
   - *Why not changed:* the gate does not assert time («wall-clock is reported but not asserted»). A fix would change
     how authorization is confirmed, for example OpenFGA batch-check or one confirmation per grant subtree. That needs
     the owner's decision under the rule «Never cache authorization decisions», so no patch is proposed here.
   - *Where it is tracked:* the measurement is now printed by the test on every run.
2. **The order of checks in `AccessRequestService.submit`.** It refuses a role that is not on the list (400) before it
   looks at the scope (403). Both refuse, and nothing is created, so this is not a defect. The test now proves the scope
   refusal for a role that is on the list.

**Scope:** every hidden person stayed hidden in every path the suite checks, and no scope leak was found.

## Runs

The summary and failure lines of every run are in [`remaining-20-run.txt`](remaining-20-run.txt).

| Run | Result |
|---|---|
| Before: the seven classes, tests unchanged | 67 run, 10 failures, 9 errors: the same 20 as the list |
| `WorkflowGraphIT` alone, tests unchanged | 5 fail (D). `routesByTime` passes alone, so its failure was F |
| After, intermediate: the seven classes | 64 / 67. The three `AccessScopeParityIT` assertions that had never run before then failed |
| After: `AccessScopeParityIT` + `WorkflowGraphIT`, final fixtures | 46 / 46 |
| After, final: the seven classes | **66 / 67**. `OperationalPostureScaleIT.postureScales` received a 503 in its unchanged HTTP loop (line 238) |
| Full suite, private tree | Killed after 149 tests (exit 137) |

**Final posture failure.**

- *Cause:* OpenFGA `HttpTimeoutException`. The host was saturated: another project's containers used about 19 CPUs and
  13 GiB of the 15.5 GiB Docker VM.
- *Why the call fails:* with one check per unit, a single timed-out check fails the call closed.
- *Evidence for the final code:* the same test code passed in the intermediate run, with exact scans 5 / 6 / 6.
- *Still needed:* repeat `sh ops/test-backend.sh OperationalPostureScaleIT` on an idle host.

**Full suite.**

- *Why it stopped:* the forked JVM was killed (out of memory, same contention), with 149 tests run.
- *Of the 20 investigated:* `AccessScopeParityIT` ran there, 6 / 6.
- *The 4 errors before the crash (`AdministrationAcceptanceIT.mapCoverage`, `AuthorizationIT.modelPublished`,
  `DbMigrationIT.migrationCenter`, `HrLinkedPeopleIT.pruneRemovesOnlyUnreferenced`):*
  - None is among the 20.
  - Three read `../docs`, `../ops` or the map packages, which the private copy of `backend/` does not have.
  - `DbMigrationIT` failed to load its context (`AuthService` bean); not investigated here.
  - The working tree also held other agents' uncommitted application changes when it was copied.
- *Still needed:* the backend cannot be called green until the full suite has run on the whole tree with the Docker VM free.
