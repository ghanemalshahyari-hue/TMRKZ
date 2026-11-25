# Further backend failures found by the full suite (25 Nov 2026) — pre-existing, open

The brief named 18 failing tests (`CLASSIFICATION.md`). The first full run of the whole backend suite in this work found more.
Each was compared with the same full suite on an untouched export of commit `8800b58` (`git archive`, run by
`ops/test-backend.sh` against real PostgreSQL + PostGIS with OpenFGA in the loop):

| Run | Tests | Failing |
|---|---|---|
| `8800b58` untouched | 444 | 42 |
| this delivery (ADR-105) | 454 | 21 → 20 after the EC-key fix |

- Fixed by this delivery: the 18 of `CLASSIFICATION.md`, `RestationingWorkflowIT.siteGeometryParity`, and three that pass now
  (`AdministrationAcceptanceIT.mapCoverage`, `AuthorizationIT.modelPublished`, `MapWorkspaceAcceptanceIT.coverage`).
- Caused by this delivery and fixed: `CertificateInspectorTest.keyFormats` — with Bouncy Castle registered as a JVM provider
  (the signature library does it), an EC key reports «ECDSA» while its certificate reports «EC»; the key match compared the
  names and refused a matching EC key. The signature check alone now decides.
- **Still failing, identical on `8800b58` — not changed, open.** Preliminary reading of each first assertion:

| Test | First failure | Preliminary class |
|---|---|---|
| `AccessScopeParityIT` × 6 (`addUserLookup`, `addUserLookupByUsername`, `attachmentActive`, `countsScoped`, `searchByName`, `treeStartsAtReach`) | fixture `update unit_member set ended_at = now()` violates `ended_at >= added_at` (the row was added later in the same transaction) | test fixture timing |
| `MatrixColumnsIT.exactly8Columns` | the 8 canonical roles in the brief's order (ADR-095) differ | likely obsolete expectation — to review |
| `OperationalPostureScaleIT.postureScales` | SQL scan count at 5,000 units above its bound (Gate 2 §I) | possible performance regression — to review |
| `SupportIT.assistantOff` | with the model off the answer mode is `OFF`, the test expects `GUIDE` | behaviour change or defect — to review |
| `WorkflowGraphIT` × 6 (`askingForPermissions`, `askingWithScope`, `askingWithoutReviewer`, `finalApproverSetsEachRole`, `movedBeforeFinalIsRerouted`, `routesByTime`) | «اختر صلاحية واحدة على الأقل من القائمة» / «تعريف التدفق غير صالح» / whole-system request not refused | access-request flow changed after these tests — to review (one assertion concerns a scope refusal: not to be loosened without review) |
| `RestationingHrSyncIT` × 2 (`hierarchyChangeThroughHrSync`, `transfersThroughHrSync`) | 200 where 400 expected; another unit than expected | likely ADR-095 (activation at final approval) — to review |
| `RestationingLifecycleIT` × 3 (`cancellationBeforeActivation`, `extension`, `extensionLapses`) | `APPROVED_NOT_ACTIVATED` expected, `EXTENSION_ACTIVATED`; cancellation «قبل التفعيل فقط» | obsolete expectation (ADR-095) — to update as `CLASSIFICATION.md` did |

None of these tests was edited, skipped or loosened. Logs: `run-baseline-8800b58.txt` (summary) and
`../release-acceptance/backend-final.txt`.
