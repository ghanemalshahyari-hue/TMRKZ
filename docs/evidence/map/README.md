# Map workspace — browser evidence (MAP-01 … MAP-18)

Produced by `node tests/acceptance/map-workspace.mjs` against the acceptance environment started without internet
egress (`sh ops/test-env/up-offline.sh`), in Microsoft Edge (playwright-core 1.64.1, headless), on 29 October 2026.
All data are fictional. `results.json` lists every check with its result and the observed values, the number of
setup API calls (test data only), external browser requests (none) and console errors (none).

| File | Shows |
|---|---|
| `map-01-remote-branch.png` | an organisation four levels down, found by search; its one responsible site listed |
| `map-02-sub-site-selected.png` | a sub-site selected from the tree: path, zoom, marker and details in step |
| `map-04-multipolygon-after-reload.png` | an imported two-part MultiPolygon drawn after reloading the page |
| `map-05-rejected-self-intersection.png` | an import refused for a self-intersecting shape; publish disabled |
| `map-06-concurrent-edit-refused.png` | a save based on an older boundary version refused |
| `map-07-preview-pending-package.png` | a facility plan package under review, previewed by the map manager |
| `map-08-partial-coverage.png` | the selected background covering part of the viewport, stated as such |
| `map-09-open-period.png` | resource state for an open-ended period |
| `map-10-partial-occupancy.png` | a shared building: one room blocked, the other free, shared use in progress |
| `map-11-drawer-beside-map.png` | the request drawer prefilled from the map, map still visible |
| `map-12-pending-orange.png` | the submitted request shown as under review (⏳) without blocking the resource |
| `map-12-review-with-pinned-boundaries.png` | the reviewer's view with the boundary versions recorded in the revision |
| `map-13-conflict-refused.png` | the second of two concurrent approvals refused |
| `map-14-document-keeps-original-version.png` | the approved request keeps its boundary version after a later edit |
| `map-15-summary-viewer-print.png` | a summary viewer in print mode: no organisation names or request counts |
| `map-16-failed-refresh-neutral.png` | a failed refresh: neutral colours and «تعذر التحديث» |
| `map-17-phone-summary.png` | phone width: the request summary reached by keyboard |
| `map-workspace-overview.png` | the workspace at the end of the run |

Screenshots document the experience; the rights, conflict and history guarantees are proven by the backend tests
(`MapWorkspaceAcceptanceIT`) and the API cross-checks inside the browser test.
