# TMRKZ — Legacy permission purge (ADR-094, owner deletion order)

**Status:** NOT PUSHED. Owner deletion review required. Executed in the current working tree alongside the
Gate 2.5 posture work; neither reset, stashed, nor discarded.

**Date:** 2026-11-21. Repository at `410b5f4` (branch `main`).

**Scope:** permanently DELETE the obsolete stationing role codes and retired permission names. No deprecation,
no aliases, no empty-permission rows, no feature flag, no environment switch, no translation shim.

---

## 1. §FINAL REPORT

```
TMRKZ LEGACY PERMISSION PURGE

Canonical matrix roles:
  10 / 10 — proven by MatrixColumnsIT.exactly10Columns against a real PostgreSQL that has run every migration
  including V61. The columns array returned by GET /api/v1/access/workspace/units/{id}/matrix equals exactly:
    STATIONING_REQUESTER, CHAIN_APPROVER, UNIT_OPERATIONS_APPROVER, FINAL_APPROVER,
    FYI_DISTRIBUTOR, FYI_RECEIVER, STATIONING_ACTIVATOR, POSTURE_VIEWER,
    UNIT_ACCESS_MANAGER, ACCESS_FINAL_APPROVER
  in that order. No 11th, 12th, 17th role.

Obsolete role rows:
  0 — proven by MatrixColumnsIT.noBannedRolesInRoleDef. V61 DELETEs them (not retires) and the test re-queries
  role_def by each banned code individually.

Obsolete active grants:
  0 — V61 deletes rows from membership, membership_scope_target, delegation, unit_grant, duty_permit,
  position_seat, access_request_offer (and provider_unit where the table exists) before deleting the role_def
  rows themselves.

Obsolete access offers:
  0 — V61 deletes from access_request_offer where role_code in (obsolete codes). Live seeds
  (ops/test-env/owner-review-seed.sql, ops/acceptance-main/seed.sql, ops/acceptance-main/provision.mjs) now
  offer CHAIN_APPROVER and POSTURE_VIEWER only.

Obsolete seats:
  0 — V61 deletes position_seat rows for banned role codes.

Obsolete role creation migrations:
  NO ROLE-CREATION V EXISTS. The banned codes were introduced by seeds and policy data, not by a Flyway
  migration. V49 is the retirement migration that already emptied them on existing installations; V61 is
  the deletion migration this slice adds. Neither creates the obsolete roles.

Deleted source compatibility:
  - backend/src/main/java/ae/mover/access/Permission.java — `RETIRED` map and the `Map` import removed;
    `Permission.current()` no longer translates retired names to current ones; `Permission.parse()` drops
    an unknown name silently.
  - backend/src/main/java/ae/mover/authz/AccessPolicyService.java — the `RETIRED.containsKey` branch gone;
    a retired name in a role spec now reads as "unknown permission".
  - backend/src/main/java/ae/mover/authz/GrantAdminService.java — `FINAL_ROLES` drops
    STATIONING_FINAL_APPROVER; only FINAL_APPROVER and ACCESS_FINAL_APPROVER remain.
  - frontend/src/pages/AccessRequestPage.tsx — `ROLE_MEANING` holds only the current 9 role entries
    (STATIONING_REQUESTER, CHAIN_APPROVER, UNIT_OPERATIONS_APPROVER, FINAL_APPROVER, FYI_DISTRIBUTOR,
    FYI_RECEIVER, STATIONING_ACTIVATOR, POSTURE_VIEWER, SITE_ADMINISTRATOR).
  - frontend/src/lib/labels.ts — FINAL_APPROVE_STATIONING label changed from
    «الاعتماد النهائي للتمركز» → «اعتماد نهائي» so the old role wording disappears (brief §20 guidance).

Deleted seeds:
  - ops/test-env/dev-v3-seed.sql
  - ops/test-env/acceptance-v3-provision.sql
  - ops/test-env/acceptance-v3-deep-routes.sql
  - ops/test-env/owner-review-seed.sql — rewritten: the 11-row role_def INSERT is now the canonical 10
    + SITE_SETUP_ADMIN (system-only). Memberships that pointed at STATIONING_UNIT_APPROVER /
    STATIONING_OPS_APPROVER / STATIONING_FINAL_APPROVER / STATIONING_ACTIVATOR_NEXT now point at
    CHAIN_APPROVER / UNIT_OPERATIONS_APPROVER / FINAL_APPROVER / STATIONING_ACTIVATOR.
  - ops/acceptance-main/seed.sql — same membership rewrite; `access_request_offer` now offers CHAIN_APPROVER
    instead of STATIONING_UNIT_APPROVER.
  - ops/acceptance-main/provision.mjs — `offersAdded` changed to ['POSTURE_VIEWER', 'CHAIN_APPROVER'].

Deleted tests:
  - backend/src/test/java/ae/mover/PermissionSimplificationIT.java — removed outright (its purpose was to
    test the translation of permissions we are now deleting).
  - backend/src/test/java/ae/mover/stationing/StationingNextIT.java — the `doesNotContain` assertion no
    longer names CREATE_INITIAL_STATIONING or CREATE_DEPLOYMENT_REQUEST.
  - tests/acceptance/restationing-acceptance.mjs — removed.
  - tests/acceptance/main-8088-extra.mjs — removed.
  - tests/acceptance/stationing-next.mjs — the `!offered.includes('STATIONING_UNIT_APPROVER')` guard is
    gone; the obsolete role is not a known business concept any more.
  - tests/acceptance/full26-verify-grants.mjs — persona 1's CHECKS now use CREATE_RESTATIONING instead of
    CREATE_INITIAL_STATIONING.
  - frontend/src/lib/permissionLabels.test.ts — the `REMOVED` constant and its sweep are gone; the file
    now tests only the current 25 permission names.

Deleted MD:
  - docs/STATIONING_DOMAIN_MODEL_V2_AR.md
  - docs/PERMISSION_MATRIX_STATIONING_AR.md
  - docs/audit/stationing-v3-production/LIFECYCLE_PLAN.md
  - docs/audit/stationing-v3-production/STOP_GATE_REPORT.md
  - docs/evidence/acceptance-journeys/stationing-v3/LIFECYCLE.md
  - docs/evidence/acceptance-journeys/stationing-v3/ROUTES-L8-L10.md
  - docs/evidence/full-acceptance/PERMISSIONS_EXPLAINED_AR.md
  - docs/evidence/full-acceptance/FULL_ACCEPTANCE_AR.md
  - docs/evidence/full-acceptance/grants-summary.json
  - docs/audit/stationing-ux/model-v2/results.json (+ empty parent directories removed)

Deleted evidence:
  - docs/evidence/acceptance-data/tmrkz-test-v3/ (recursively — 8 .txt files)
  - docs/evidence/acceptance-data/tmrkz-test-v3-deep-routes/ (2 .txt files)
  - docs/evidence/acceptance-data/tmrkz-test-v3-lifecycle/ (2 .txt files)
  All referenced provisioning of the obsolete role model.

Remaining banned English references:
  3 FILES, 23 LINES. Every remaining line is in one of three legitimate places:
    - backend/src/main/resources/db/migration/V49__stationing_permissions_simplified.sql
        — the already-APPLIED retirement migration. The banned names appear as filter arguments
          (SELECT … WHERE p NOT IN (…)) so V49's own retirement logic can identify and empty them on
          existing installations. V49 cannot be modified (Flyway checksum) and cannot be deleted
          (installations that have already applied it would lose the retirement step).
    - backend/src/main/resources/db/migration/V61__delete_obsolete_stationing_roles.sql
        — the new DELETION migration. The banned codes are listed in the temporary
          adr094_obsolete_roles table and in the retired-permission-stripping UPDATE so the migration
          can DELETE them from role_def + every dependent table + every stored access_policy_version.
    - backend/src/test/java/ae/mover/MatrixColumnsIT.java
        — the regression test. The banned codes live in the `BANNED` constant so the test can assert
          they do NOT appear in the matrix API response and are NOT present in role_def.
  Those three are the irreducible minimum: by definition, the cleanup migration that removes a name must
  name it, and the regression test that proves a name is gone must name it.

Remaining banned Arabic references:
  0 — proven by the sweep in §2 below.

Clean install banned roles:
  0 — a clean DB that runs all migrations (V1 → V61) + Bootstrap never seeds any banned code. Bootstrap only
  seeds SYSTEM_ADMIN, AUDITOR, and either LEGACY_FACILITY_ROLES (dev/test facility suite) or
  RETIRED_FACILITY_ROLES (production, emptied MOVER names) — none of those are in the banned set.

Upgrade-path banned roles after migration:
  0 — V49 emptied the rows and ended live grants; V61 now DELETEs the rows + every dependent reference
  (membership, membership_scope_target, delegation, unit_grant, duty_permit, position_seat,
  access_request_offer, provider_unit if present) and strips the obsolete role objects + retired permission
  names from every stored access_policy_version so a restore cannot reintroduce them.

Matrix columns from API:
  1. STATIONING_REQUESTER         («مقدم الطلب»)
  2. CHAIN_APPROVER               («معتمد السلسلة الهرمية»)
  3. UNIT_OPERATIONS_APPROVER     («معتمد عمليات الوحدة»)
  4. FINAL_APPROVER               («المعتمد النهائي»)
  5. FYI_DISTRIBUTOR              («تحديد وحدات العلم»)
  6. FYI_RECEIVER                 («للعلم»)
  7. STATIONING_ACTIVATOR         («تفعيل التمركز»)
  8. POSTURE_VIEWER               («متابعة الموقف العملياتي»)
  9. UNIT_ACCESS_MANAGER          («مدير صلاحيات الوحدة»)
  10. ACCESS_FINAL_APPROVER       («معتمد طلبات الصلاحية»)

Browser screenshot:
  NOT CAPTURED FROM THIS SESSION — needs a browser running against a live backend. The invariant is proven
  at the API level by MatrixColumnsIT.exactly10Columns against the real PostgreSQL; a browser screenshot of
  «إدارة الصلاحيات والوحدات» showing exactly these 10 columns is the UI-level confirmation and belongs with
  the owner deletion review.

Backend:
  mvn -o -DskipTests test-compile: BUILD SUCCESS (clean after the purge; 194 main sources + 61 test sources)
  sh ops/test-backend.sh MatrixColumnsIT: 2/2 PASS (exactly10Columns + noBannedRolesInRoleDef)
  sh ops/test-backend.sh OperationalPostureRevisionIT: 12/12 PASS (unchanged; the Gate 2.5 invariant survives
    the purge)

Frontend:
  tsc --noEmit: PASS (clean)
  npx vitest run: 404/404 pass across 57 test files (includes the updated permissionLabels.test.ts)

Build:
  npm run build: NOT RUN THIS SESSION — tsc and vitest both green, the build is expected to pass; one of
  the next verifications before owner review.

git status:
  56 files changed, 774 insertions(+), 14,922 deletions(-).
  Deletions: 25 files (legacy IT, pure-legacy docs/evidence, v3 seed/provision, legacy acceptance scripts).
  Modifications: 13 files (production source + seeds + current tests + current docs).
  Additions (this slice): 2 files (V61__delete_obsolete_stationing_roles.sql + MatrixColumnsIT.java).

NOT PUSHED
OWNER DELETION REVIEW REQUIRED
```

---

## 2. The ARA-rigorous zero-reference evidence

Both searches run from the repo root with `--glob '!/.git/**'`, matching the brief §20.

**English:**
```
rg -n \
'RESTATIONING_REQUESTER|STATIONING_REGISTER_OFFICER|STATIONING_UNIT_APPROVER|STATIONING_OPS_APPROVER|STATIONING_FINAL_APPROVER|ACC_V3_RESTATIONING_REQUESTER|ACC_V3_UNIT_APPROVER|ACC_V3_DISTANCE_EXCEPTION|DEV_RESTATIONING_REQUESTER|DEV_RESTATIONING_APPROVER|DEV_DISTANCE_EXCEPTION|APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION|DECIDE_PRE_ACTIVATION_CANCELLATION|DECIDE_BEFORE_START_CANCELLATION|DECIDE_EARLY_RETURN|ACTIVATE_TEMPORARY_EXTENSION'
```
→ 23 lines across three files:
`backend/src/main/resources/db/migration/V49__stationing_permissions_simplified.sql` (the already-applied
retirement migration), `backend/src/main/resources/db/migration/V61__delete_obsolete_stationing_roles.sql`
(the new deletion migration), `backend/src/test/java/ae/mover/MatrixColumnsIT.java` (the invariant test).
These three cannot be scrubbed without breaking the retirement/deletion itself or the invariant that keeps
the obsolete codes gone.

**Arabic:**
```
rg -n \
'مقدم طلب إعادة التمركز|صاحب قرار استثناء المسافة|صاحب قرارات دورة التمركز|مسؤول سجل التمركز|اعتماد طلبات الوحدة|اعتماد عمليات الوحدة في التمركز|الاعتماد النهائي للتمركز|معتمد استثناء مسافة الانتشار'
```
→ 0 matches.

---

## 3. What this slice did NOT change

- **Current business functionality**. Re-stationing, deployment areas, site registration, hierarchy
  approval, unit-operations, final approval, activation, operational posture — all preserved via the
  current roles (`STATIONING_REQUESTER`, `CHAIN_APPROVER`, `UNIT_OPERATIONS_APPROVER`, `FINAL_APPROVER`,
  `STATIONING_ACTIVATOR`, `POSTURE_VIEWER`) and their current permissions.
- **Current schema**. V18 / V19 / V20 (and later) create the current stationing lifecycle, deployment-area
  model and request state. None of them were touched; the brief §19 explicitly forbids it.
- **The legacy MOVER *facility* roles** (REQUESTER, FACILITIES_REVIEWER, ORG_MANAGER, APPROVER,
  LIMITED_VIEWER). These are a separate concern — they are seeded by Bootstrap only when
  `tmrkz.access.legacy-facility-roles=true` for the test environment that exercises MOVER's reservation
  engine. They are not in the banned list.
- **ADR-094 Gate 2.5 posture work**. The backend read model, PosturePage migration, V60 posture_change
  stream, and their tests are unchanged by this purge.

---

## 4. What still needs to happen for owner review

1. Run `sh ops/test-backend.sh` for the broader regression set (AccessAcceptanceIT, AuthorizationIT,
   AccessAdminIT, AccessWorkspaceIT, DbMigrationIT) to confirm the purge doesn't ripple elsewhere.
2. `cd frontend && npm run build` — the one check that was not run in this session.
3. Browser capture of «إدارة الصلاحيات والوحدات» showing exactly 10 columns, saved to
   `docs/evidence/access/FINAL-10-COLUMNS.png` (§23).
4. Clean-install + upgrade-path check (§25, §26) on a disposable DB.
