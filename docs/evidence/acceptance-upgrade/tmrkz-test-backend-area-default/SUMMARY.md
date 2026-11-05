# tmrkz-test backend swap — Stationing policy `deploymentAreaDefault` (5 Nov 2026, owner-approved for tmrkz-test only)

- Image `mover/backend:rel-b60dafc-area-default` (`sha256:12024edb…`), built from a git archive of local commit b60dafc
  plus the uncommitted backend change in `backend-working-tree.patch` (sha256 5bb7a2e3f329…; StationingPolicy +
  tests). Build context verified identical to the working tree (`build.txt`).
- Guarded swap `EXPECT_PENDING="" sh ops/test-env/upgrade-backend.sh …` (`run.log`): target labelled ACCEPTANCE, plan
  empty, schema **V20 before and after**, backup `backups/tmrkz-test-20261105T053913Z` verified (6 checks),
  upgrade-check **7771 rows present and unchanged**, schema diff only pg_dump's random `\restrict` tokens.
- OpenFGA: 220 relation tuples, same fingerprint before and after; its container was not restarted
  (`openfga-before.txt`, `openfga-after.txt`).
- Rollback: `ops/restore.sh backups/tmrkz-test-20261105T053913Z` into a clean project with image `sha256:8031a505…`
  (rel-b60dafc).
- Acceptance policy version 2 published through the studio as t.admin (no SQL): only `deploymentAreaDefault` =
  SQUARE 90,000 m² (300 m × 300 m), reference «ACCEPTANCE-V3-POLICY-2 · قيمة قبول تجريبية — ليست قيمة إنتاجية معتمدة»
  (`docs/evidence/acceptance-journeys/stationing-v3/area-default/`). No production value exists anywhere.
- The database description was updated to name the backend image and policy version 2.
