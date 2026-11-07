# Workflow studio as a flow chart: evidence (6 Nov 2026, ADR-041)

Script: `tests/acceptance/flow-studio.mjs`, on the real page in headless Chrome, signed in as `developer` on the one app, with real imported units and the real pointer. Results: `results.json`. It saves one draft and one responsibility and removes them; it publishes nothing.

| File | What it shows |
|---|---|
| `A-published-as-a-chart.png` | A published flow from before the chart, opened as the chart it means |
| `B-dragged-in.png` | A step dragged in from the palette |
| `C-question-rule.png` | A question's condition beside the chart |
| `D-approval-details.png` | An approval: a role at a unit found by name |
| `E-responsibilities.png` | A responsibility and its rule |
| `F-check.png` | The check: a problem marked on its step |
| `G-route-long-request.png` | A long request on a real unit: «yes» and the route lit |
| `H-route-short-request.png` | A short request: «no», the notice and the rejected end |
| `I-what-if-rejected.png` | «What if rejected here?» |

The engine itself (real Flowable, real PostgreSQL) is proven by `WorkflowGraphIT`.

## One approval climbing the hierarchy (`climb/`)

Script: `tests/acceptance/flow-climb.mjs`, same conditions, on the 123 units imported from Oracle. Results: `climb/results.json` (13/13). It saves one draft and removes it; it publishes nothing.

| File | What it shows |
|---|---|
| `climb/A-stop-at-levels.png` | The card stops at levels chosen from those in the source |
| `climb/B-question-about-the-unit.png` | The question «هل وحدة مقدم الطلب رئيسية؟» |
| `climb/C-climb-from-the-lowest-unit.png` | From the lowest unit: «no», and every unit up to the main unit |
| `climb/D-from-the-main-unit.png` | From a main unit: «yes», straight to the final approval |

Limit: this shows the route in «try it», with no person deciding, because nobody imported holds a role yet. Deciding along a climb is proven by `WorkflowGraphIT` with test people.

Limits: the question's condition reaches the saved draft through the same API the page uses, because the rule editor's own controls have their own suite; publishing from the page was not clicked here; no touch device; 123 units, not the 26,000 expected at scale.
