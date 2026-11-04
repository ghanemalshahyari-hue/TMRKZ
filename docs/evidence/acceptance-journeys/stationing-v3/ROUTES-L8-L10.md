# Routes from L8, L9 and L10 on `tmrkz-test` (4 Nov 2026)

Owner decision of 4 Nov 2026: add fictional acceptance data for L8, L9 and L10, so that routes of 3 to 5 stages are
seen in the real application.

## Fictional data

Provisioned with `ops/test-env/provision-acceptance-v3-deep-routes.sh` (plan, then write; the rerun is idempotent):
`docs/evidence/acceptance-data/tmrkz-test-v3-deep-routes/`. It wrote four directory accounts and their fictional HR
people, affiliations and single-action acceptance roles:

| Account | Role | Unit |
|---|---|---|
| `t.requester.pm` | `ACC_V3_RESTATIONING_REQUESTER` | HR-T-PM-1 (L8), covering its L9 and L10 units |
| `t.seat.l8` | `ACC_V3_UNIT_APPROVER` | HR-T-PM-1 (L8) |
| `t.seat.l9` | `ACC_V3_UNIT_APPROVER` | HR-T-PM-1-1 (L9) |
| `t.seat.l10` | `ACC_V3_UNIT_APPROVER` | HR-T-PM-1-1-1 (L10) |

No level, policy, stationing, boundary or terrain was changed. The L7 seat (`t.manager.ga`, HR-T-PM) and the L6 seat
(`t.approver`) already existed.

## Journey R

Run with `ONLY=R SHIFT_M=-70000 node tests/acceptance/restationing-acceptance.mjs`, on web `rel-cea09c7-v3` and
backend `rel-99c7ede`. Results: `results-R-run1.json` and `results-R.json`.

| Request | From | Route (HR ancestry, L6 final) | Result |
|---|---|---|---|
| RS-2026-0017 | L8 قسم مشاريع المباني | L8 → L7 إدارة المشاريع → L6 المؤسسة (3 stages) | approved by the 3 seat holders |
| RS-2026-0018 | L9 وحدة الصيانة الإدارية | L9 → L8 → L7 → L6 (4 stages) | approved by the 4 seat holders |
| RS-2026-0020 | L10 فريق مرافق الشمال | L10 → L9 → L8 → L7 → L6 (5 stages) | each stage pressed on the real page by its own seat holder: five different people |

**RS-2026-0019 (left as a DRAFT).** The first L10 attempt stopped correctly on «حدّد معالجة الوحدة من فرع آخر: وحدة
الصيانة الإدارية» (O-03). The L10 unit's parent shares site 10 «مستودع اللوازم الشمالي», and the requester must decide
what happens to it. The script now records that decision as EXCLUDED (the parent stays), and RS-2026-0020 completed.

**Defect found in this run.** The three new seat holders hold only the approval right, with no view right. The app
shell asked them for `/sites`, `/request-types` and `/organizations/tree`, and got 403 on each. This was not
functional, but it put 3 console errors per sign-in.

The same cause hid a real gap: the editor built its unit list from the organisation tree, so a requester holding only
«طلب إعادة التمركز» could not choose a unit.

Fixed in `57d7820`:

- `GET /restationing-requests/units` lists exactly where the right acts;
- the editor uses it;
- the shell asks for each list only with a right its endpoint accepts.

The general organisation tree remains a view right.

## Deployed and re-checked (same day)

**Release.**
- Local commit `57d7820` (functional, owner-approved, not pushed).
- Backend `mover/backend:rel-57d7820` (`sha256:b9c53f7e…c167`), no migration, through `upgrade-backend.sh`: backup
  verified by restore, all 6,841 rows unchanged (`docs/evidence/acceptance-upgrade/tmrkz-test-backend-57d7820/`).
- Web `mover/web:rel-57d7820-v3` (`sha256:2a16df25…97f8`) (`docs/evidence/acceptance-upgrade/tmrkz-test-web-v3-57d7820/`).
- Previous images kept: `rel-99c7ede`, `rel-cea09c7-v3`.

**Re-check.** `ONLY=A,U,R R_LEVELS=10 SHIFT_M=-110000`: 15 pass, 0 fail, 0 console errors, 0 external requests
(`results-AUR.json`).

| Check | Result |
|---|---|
| A3b | the stage labels are exactly «اعتماد المستوى L7» / «اعتماد المستوى L6»; the page shows «الجهة: الخدمات المشتركة» and «الجهة: المؤسسة» on their own lines (RS-2026-0022, decided and activated on the page) |
| R10 | RS-2026-0023: 5 stages, labels «اعتماد المستوى L10 … L6» with the units apart, decided on the page by five different people. No console error for the seat-only approvers (before the fix: 3 × 403 per sign-in) |
| U1 | `t.requester.pm`, holding only «طلب إعادة التمركز», sees exactly قسم مشاريع المباني، وحدة الصيانة الإدارية، فريق مرافق الشمال in the editor, and the branch of the chosen one (`U-editor-units.png`) |
| Map | labels no longer overlap: the proposed site and the alternative area are placed apart, and the primary area's label waits for a closer zoom (`MAP-street.png`) |

**Still visible.** The long mixed label «موقع RS-2026-0012 (الحالي)» wraps onto two lines and splits the number. It is
older than this batch and left for the next functional batch (a wider label width).

**Aborted run.** RS-2026-0021 is UNDER_REVIEW, left by a run of the script that stopped on a script error after the
page had submitted it. The error was a name clash in the new check, corrected.

**Audit.** The new policy-audit fields are proven by `StationingFoundationIT`. Version 1 predates them, and by owner
decision no further version was published only to show them.
