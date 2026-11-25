# VM authorisation and identity incident — investigation (25 Nov 2026, ADR-103)

Scope: the incident report of 24–25 Nov 2026 from the VM (`aed-mod-tmk001`, `/data/TMRKZ`). The VM's database and its local
source edits were **not** inspected from development; everything below was reproduced with synthetic identities on the
development machine. No VM issue is declared fixed by these tests.

## 1. Root causes

| Reported symptom | Actual cause (in code) | The report's diagnosis |
|---|---|---|
| «رقم المستخدم هذا مستخدم لحساب خارج نطاقك» when adding a user | `UnitMemberService` accepted an existing account only when its employee number started with `USER-`. A person whose first directory sign-in created the record (ADR-068) carries the directory's number (or `DIR-login`), so even the global administrator was refused. A removed account got the same message. | «admin grants expired» — wrong |
| Units missing in «طلب مناطق انتشار» | The request hub listed the first 300 units of the reach in tree order, retired ones included; a stationed unit further down (with 23,674 units) was never offered. Units with no approved stationing are, by design, folded away (they cannot have a deployment-area request). | «grants expired → empty tree» — wrong |
| u123456: «سجل الشخص غير نشط في مصدر الموارد البشرية» | `AuthService` gave this HR message for **any** non-ACTIVE person. u123456 was DISABLED with access switched off — the signature of «حذف الحساب», which ends every grant; no way back existed except SQL. | «not in hr_person» — wrong (the HR row inserted by hand was not needed) |
| «＋ مدير جديد» (ADR-102) | Inserted a scope target of kind `ALL`, which the table refuses: every add failed (500). | not reported |

Facts the report missed:
- `authz_tuple` is only the **mirror** of what OpenFGA holds. The source of truth is `membership`, `delegation`, responsibility
  seats, unit grants and duty permits (`GrantSource`). `AuthzSync`'s full reconciliation rewrites the mirror from them and
  removes hand edits; the database decides first, OpenFGA can only narrow.
- An open-ended grant is stored as `valid_to = valid_from`, `open_ended = true`. The 27 «expired» rows were valid, open-ended
  grants (this PC has the same 27).
- The line-253 edit removed the **HR uniqueness** refusal, not the scope refusal at line 264; it would let an HR employee become
  a second, local identity. It was not adopted; the protection is kept.

## 2. Source changes

`UnitMemberService.requireAddableAccount`, `AuthService.inactive`, `AccessAdminService.reinstate` (+ route, «إعادة الحساب»),
`AdministratorService` / `AdministratorController` (two verified lookups, confirmation fingerprint, least privilege, audit,
last-administrator rule), `RequestHubService.offered` and `RestationingService.active`, frontend `AdminLifecycle.tsx`,
`AccessAdmin.tsx`, `NewRequestPage.tsx`, and the read-only `ops/diagnose.sh`. Details: ADR-103.

## 3. Test evidence (development machine, synthetic data)

- Reproduced on `e30c1c1` before any change: 6 failures out of 9 new checks (`docs/evidence/adr-103/reproduction-e30c1c1.txt`).
- After the change: `AuthzMirrorIT` 3/3 (open-ended grants valid in the database and in OpenFGA; hand edits of the mirror
  grant nothing and are undone by the full reconciliation, even when written into OpenFGA), `UnitMemberIdentityIT` 4/4,
  `RequestHubReachIT` 1/1, `AdministratorLifecycleIT` 4/4 (Oracle HR through a SELECT-only test source; unconfigured and
  unreachable HR refused without writing; directory account verified by a sign-in; forged confirmation 409; least privilege;
  last effective administrator kept), plus the affected existing classes (ADR-103).
- Pre-existing failures, identical on an untouched `e30c1c1` extract: `RestationingWorkflowIT` 8, `StationingNextIT` 9,
  `SiteSetupIT` 1 (they predate ADR-095's merged activation; `docs/evidence/adr-103/baseline-stationing-e30c1c1.txt`).
- Final backend run: 117/117 in 21 classes (`docs/evidence/adr-103/backend-final.txt`).

## 4. VM-specific blockers (not resolvable from development)

1. Whether the VM's line-253 edit was compiled and is running: `sh ops/diagnose.sh` §5 («build state»).
2. Whether the full reconciliation has already undone the mirror edits: §10 («open-ended rows EDITED BY HAND», «mirror holders
   with no grant behind them») — both should read 0.
3. The real state of u123456 and aeda123456: `sh ops/diagnose.sh --logins u123456,aeda123456` §11 (masked).
4. HR source reachability and the hand-inserted HR row: §12 and §11 («HR rows in the published snapshot not linked to anyone»).
5. The VM has no Update Center yet: the first transfer is the one-time PAM bootstrap of `docs/UPDATE_CENTER_AR.md`.

## 5. Proposed corrections on the VM — NOT performed; each needs review, a backup and the owner's authorisation

| # | Proposal | How (audited path, never SQL) |
|---|---|---|
| 1 | Replace the edited `UnitMemberService.java` and remove `UnitMemberService.java.bak` | the bootstrap package (tar) restores the reviewed file; the first browser update lists the `.bak` as «محذوف» |
| 2 | Mirror edits and copied rows | nothing to do once §10 reads 0; otherwise «إعادة بناء» of the authorisation store (existing `POST /access/rebuild`) |
| 3 | u123456's access | decide in «بطاقة الحساب»: keep it (record the decision) or switch it off; grants only through the access workspace or «مديرو النظام» |
| 4 | Administrators | «مديرو النظام» with the employee number (Oracle HR) or the directory account; the reason is audited |
| 5 | The hand-inserted HR row | leave it: it links to nobody and the next unit import does not carry it forward |
| 6 | Test unit `cd2bb2d5` | «إيقاف الوحدة» on the units page (ADR-101), not a DELETE |
