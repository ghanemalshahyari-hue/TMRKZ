# Approvals by scope and for-information by place: evidence (6 Nov 2026, ADR-042)

Script: `tests/acceptance/scope-approvals.mjs`, on the real page and real sign-ins, in a temporary acceptance environment with fictional people, removed afterwards. Results: `results.json` (46/46).

| File | What it shows |
|---|---|
| `A-units-dialog.png` | The «تعيين» dialog: tree on the main unit, a unit with chosen levels, what it covers |
| `B-grant-saved.png` | The saved grant and its scope in words |
| `C-unit-matrix.png` | The matrix of a unit: its people, the roles, and how many units a grant covers |
| `D-periods.png` | A period for the unit operations step |

The whole request runs from the lowest unit: two levels of the climb, unit operations by scope, a different person's final approval, then for-information. Whoever approved earlier is not offered a later step; for-information sees nothing before the final approval, and a unit the request does not concern reads nothing after it.

Limits: fictional people and a fictional hierarchy, because people from Oracle cannot sign in yet. A re-stationing's notice is tested directly by `WorkflowGraphIT`, not through a whole re-stationing. Limits of the design: ADR-042.
