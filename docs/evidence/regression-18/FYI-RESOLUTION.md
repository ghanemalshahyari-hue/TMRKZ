# One source for the FYI units informed after final approval (25 Nov 2026, owner brief item 5)

Closes the defect recorded in `CLASSIFICATION.md` («Application defect found during the review») and in
`docs/TRACEABILITY.md` row `FYI-DESIGNATION-WRITE`. Before this change, the screen «الجهات الرئيسية للعلم» wrote one table and
the re-stationing final approval read another, so an administrator's choice never reached a re-stationing request.

## 1. Investigation (code as found at `12f9415` plus the working tree)

| | `fyi_main_command` | `fyi_designation` |
|---|---|---|
| Created by | V26 (6 Nov 2026), ADR-042 «للعلم حسب المكان» | V64 (21 Nov 2026), ADR-095 B2 |
| Columns | `organization_id` (PK, FK organization), `added_by` (NOT NULL, FK person), `added_at` | `id`, `unit_id` (FK organization), `include_descendants`, `set_by` (nullable), `set_at`; unique (`unit_id`, `include_descendants`) |
| Written by | `GrantAdminService.setFyiMain` via `PUT/DELETE /access/fyi-mains/{id}` — the screen `FyiMains` (`UnitRouting.tsx`) in «إدارة الصلاحيات والوحدات» | **nothing** in `backend/src/main` or `frontend/src`; only the SQL fixture `StationingNextIT.designateFyi` |
| Who may write | `ctx.canEverywhere(MANAGE_ACCESS)` — an access manager whose scope is everything | V64's comment promised SYSTEM_ADMIN and scoped UNIT_ACCESS_MANAGER (B3) — never implemented |
| Audit | `FYI_MAIN_COMMAND_ADDED` / `_REMOVED` (no reason, no detail; a repeat was recorded too) | `ACCESS_FYI_DESIGNATION_SET` / `_REMOVED` promised by V64 (B4) — never written |
| Read by | `PlaceInfo.route` (MAIN_COMMAND parties) at the final approval of every request other than an access request (`DecisionService`) | `RestationingService.autoFyi` at the final approval of re-stationing, deployment areas, site registration and extensions |
| Migration centre | catalogued (`DbMigrationCatalog`, ORGANISATIONS) | not catalogued (falls into «أخرى»); absent from any database older than V64 |
| Data on an installation | the administrators' choices made on the screen | only rows inserted by hand in SQL (no writer, no seed in `ops/` or any migration) |
| Tests | `WorkflowGraphIT.forInformationByPlace` (through the endpoint), `scope-approvals.mjs` M05 | `StationingNextIT` (SQL fixture) |

The owner's decision of 21 Nov 2026 (ADR-095 B2, quoted in `RestationingService` and V64) is that the re-stationing FYI units
are «one organisation-wide flat list matching «الجهات الرئيسية للعلم»». The screen that carries exactly that name writes
`fyi_main_command`. V64 created a second table for the same concept instead of extending the existing one, and the work to
move the writer (B3/B4) was never done.

## 2. Decision — `fyi_main_command` is the one authoritative source

Reasons, from the evidence above:

1. It is the only table the application writes, with today's authorisation and an audit trail; it is what administrators
   have actually configured. `fyi_designation` can only hold hand-made SQL rows.
2. It is the list the owner named («الجهات الرئيسية للعلم»); making re-stationing read it is the literal reading of B2.
3. It already feeds every other final approval (`PlaceInfo`), so one list now serves all final approvals, as the screen says.
4. The migration centre carries it from older TMRKZ databases (back to V26); `fyi_designation` does not exist before V64 and
   is not catalogued.
5. Its audit history continues under the same event names and entity (`ORGANIZATION`, unit id).

What `fyi_designation` had and `fyi_main_command` lacked — the «وما دونها» choice — is added to `fyi_main_command`.
Authorisation is **not** broadened: B3's scoped UNIT_ACCESS_MANAGER maintenance stays unimplemented (only a global access
manager changes the list, as before).

## 3. Implementation

- **V69** `V69__fyi_one_source_main_command.sql` (next free version after V68):
  - `fyi_main_command.include_descendants boolean not null default false` (`add column if not exists`; existing rows keep
    today's meaning, the unit only);
  - `added_by` becomes nullable — only for a row copied from `fyi_designation` without a recorded author (the application
    always sets it);
  - every `fyi_designation` row is copied in, grouped per unit: a unit in either list stays; «وما دونها» from either list
    stays (union — never narrowed); the earliest author and time are kept; a unit already on the screen keeps its author
    and time;
  - one audit event `FYI_MAIN_COMMAND_MERGED` (entity `POLICY`/`V69`) lists each unit added or widened — only when something
    changed, so a re-run records nothing;
  - `fyi_designation` is kept unchanged (not dropped, not turned into a view: a view would refuse the migration centre's
    inserts from a V64–V68 source) and commented as superseded.
- **One reader** `FyiMainCommands.effectiveUnits(jdbc)`: the chosen units plus, for «وما دونها», their active descendant
  units at that moment (the walk `autoFyi` used, now cycle-safe with `union`). Used by `PlaceInfo.route` and
  `RestationingService.autoFyi` — nothing else reads either table.
- **Writer** `GrantAdminService.setFyiMain(ctx, unit, chosen, includeDescendants, reason)`: same check
  (`canEverywhere(MANAGE_ACCESS)`, before anything else); unknown unit → 400; reason ≤ 500 characters; audit
  `FYI_MAIN_COMMAND_ADDED` / `_CHANGED` («وما دونها» switched) / `_REMOVED` through `AuditService.recordAs` with who
  (actor), when (`occurred_at`), the reason, the unit's name and the before/after flag; a call that changes nothing records
  nothing. `GET /access/fyi-mains` returns `includeDescendants`.
- **API** `PUT /access/fyi-mains/{id}` takes an optional body `{includeDescendants, reason}` (an empty `{}` still works);
  `DELETE /access/fyi-mains/{id}?reason=`. `docs/api/openapi.json` regenerated (only these two operations changed).
- **Screen** `FyiMains` (`UnitRouting.tsx`): shows «وما دونها» per unit, offers «تشمل الفروع التابعة» when adding, asks for
  the reason before an addition or a removal, and its text now says what both distributions do (requests: holders of
  «للعلم» covering a unit; re-stationing, deployment areas and site registration: the members of the unit).
- **Distribution text**: `autoFyi`'s note names «الجهات الرئيسية للعلم», and its audit `source` names `fyi_main_command`
  (it still said `unit_fyi_target`, the table V64 dropped).
- **Tests**: `StationingNextIT.designateFyi` now goes through `PUT /access/fyi-mains/{unit}` as a SYSTEM_ADMIN instead of an
  SQL insert; every check is unchanged. Because the list is organisation-wide and the test database is shared (and
  `WorkflowGraphIT.forInformationByPlace` leaves its unit on the list), `StationingNextIT` and `FyiConfigurationIT` clear the
  list before each test and put it back exactly after — the strict check «the record stays … isEqualTo(1)» stays strict.

## 4. Tests (synthetic administrative units and people only)

`FyiConfigurationIT` (new):

| Test | Proves |
|---|---|
| `screenWriteIsWhatFinalApprovalDistributes` | the screen's PUT (with «وما دونها» and a reason) is audited with who/when/why; the next re-stationing final approval writes `restationing_fyi` for exactly that unit and its active unit below; a member below is told once and reads that request read-only; a unit not on the list is told nothing; `FyiMainCommands` (the requests' reader) returns the same set; `fyi_designation` is not written |
| `changesAuditedAndRemovalStopsDistribution` | add → change → repeat → remove → repeat records exactly ADDED, CHANGED, REMOVED with their reasons, actor and time; an unknown unit is refused; after removal a final approval informs nobody and the note says so |
| `unauthorisedRefused` | a scoped holder of MANAGE_ACCESS (as UNIT_ACCESS_MANAGER would be), a requester and a holder of CONFIGURE everywhere are refused (403) to add, change or remove; the list is unchanged and no event is recorded for them; without MANAGE_ACCESS even the list is refused |
| `existingRowsMigrated` | the real V69 file, run on synthetic rows: union per unit, «وما دونها» kept and never narrowed, authors/times kept (null stays null), old rows kept, one `FYI_MAIN_COMMAND_MERGED` event listing exactly the units changed; run again: identical rows, no second event; the screen lists the merged units |

Results: see section 5.

## 5. Results

Run with `ops/test-backend.sh`'s procedure (real PostgreSQL 17 + PostGIS, OpenFGA in the loop) in private disposable
containers, on a copy of the working tree, classes in alphabetical order so `WorkflowGraphIT` (which leaves its unit on the
list) runs before the stationing classes — the leak case is exercised:

| Class | Result |
|---|---|
| `FyiConfigurationIT` (new) | 4/4 passed |
| `StationingNextIT` (fixture through the endpoint) | 14/14 passed |
| `RestationingWorkflowIT` | 17/17 passed (`siteGeometryParity` re-run with `frontend/src/lib/siteGeometryCases.json` present in the copy — the first run's copy lacked the file) |
| `WorkflowGraphIT#forInformationByPlace` (requests' FYI through `PlaceInfo`, the screen's PUT with an empty body) | 1/1 passed |
| `DbMigrationIT` (migration centre with V69 in the chain) | 1/1 passed |
| `V17MigrationIT` | 1/1 passed |
| `V47MigrationIT` (upgrade of a populated database through V69) | 1/1 passed (re-run with `ops/sql/checks/` present in the copy — the first run's copy lacked it) |

Total 39/39. Frontend: `npm run typecheck` clean; `vitest` for `src/components/access` and `src/api` 29/29. The full suites
were not run (focused checks; the final consolidated checkpoint runs them).

## 6. Left open

- **B3 scoped maintenance**: V64's comment promised that a UNIT_ACCESS_MANAGER could maintain the list within their scope.
  Not implemented — it would broaden who may change an organisation-wide list; it needs the owner's decision.
- **Recipients differ by family, by design of earlier ADRs**: for requests the holders of «للعلم» covering a listed unit
  read the summary (ADR-042); for re-stationing every member of a listed unit is notified and may read that request
  (ADR-045/095). The source is now one; the two recipient rules are unchanged and the screen states both.
- A migration-centre import from a V64–V68 source would bring `fyi_designation` rows into the superseded table, where
  nothing reads them (such rows can only have been inserted by hand). Not handled.
- `docs/STATUS.md` and `docs/ARCHITECTURE_DECISIONS.md` are not updated by this change (outside this task's files); the
  ADR text for V69 is still to be written there.
