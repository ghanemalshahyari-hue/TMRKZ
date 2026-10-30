# Owner demo — map journeys (2026-10-30)

Before/during/after screenshots of three map journeys run in real Microsoft Edge against the acceptance
environment (`ops/test-env`, `http://localhost:8088`), signed in as `t.admin`. Fictional test data only. Captured
from the build at commit `fd034c6` (per-symbol organisation+site selection, uncapped symbol strip).

Test-data setup used for the symbol journey (CONFIGURE, no permission change): approved standard set to APP6-D,
five organisations assigned catalog SIDCs from `ops/test-env/seed.sql`, one approved shared booking so a site shows
two organisations. Zero browser console errors across the run.

## 1. Add a new site — button «إضافة موقع جديد بعلامة» (below the map)
- `A1-map-before` — the workspace before.
- `A2-add-editor-open` — editor open, map in marker-placing mode.
- `A3-marker-placed` — clicked an empty point; marker + coordinates appear.
- `A4-marker-dragged` — dragged the marker; coordinates update live.
- `A5-add-form-filled` — code and name entered.
- `A6-after-save` — saved («إضافة الموقع»).
- `A7-after-reload` — page reloaded; the marker persisted at the saved location.

## 2. Move an existing site's marker — button «تحرير سجل الموقع — نقل العلامة» (detail panel)
- `B1-move-editor-open` — move editor with the current coordinates and a reason field.
- `B2-marker-dragged` — dragged to a new position; coordinates update.
- `B3-after-cancel` — «إلغاء دون حفظ»: the original location is unchanged.
- `B4-move-save-reason` — dragged again, reason entered.
- `B5-after-save` — saved («حفظ موقع العلامة»).
- `B6-after-reload` — reloaded; the new position persisted.

## 3. Select an organisation by its symbol — «الطبقات» → «رموز الجهات المرتبطة بالمواقع»
- `C1-layers-panel` — the symbol layer toggled on.
- `C2-symbols-on-map` — real APP6-D symbols beside the markers.
- `C3-symbol-before-click` — before clicking a symbol.
- `C4-after-click-org-and-site` — one symbol click selects the organisation (filter + organisations tab) AND the
  site (its actions open).
- `C5-two-orgs-site11` — in the shared period, site 11 shows two organisations' symbols (none dropped).

Note: the unit symbol has no position of its own — it tracks the site marker. Only the site marker (journey 2) or
the boundary carries a location; there is no "move the symbol" action (ADR-021 scope exclusion).
