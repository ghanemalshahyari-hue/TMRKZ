# PosturePage — Site-Hub UI migration (ADR-094 Gate 2.5 §P-§47)

**Status:** NOT PUSHED. Owner UI + final performance review required. Nothing has been run against the
disposable load environment yet; this slice is the UI part the brief gated on **after** Gate 2.5 backend was
green.

**Date:** 2026-11-21. Repository at `410b5f4` (branch `main`).

**STATIONING_REQUESTER:** unchanged by this slice. Audit at
[`docs/STATIONING_REQUESTER_AUDIT.md`](STATIONING_REQUESTER_AUDIT.md) proved all 9 requirements already hold.

---

## 1. What changed

### 1.1 `frontend/src/pages/PosturePage.tsx`

- **Initial fetch** switched from `api.operationalPosture()` (which called `/operational-posture?view=UNITS`)
  to `api.postureOverviewConditional(etag, signal)` → `GET /operational-posture` default (Site-Hub summary).
- **State model rewritten**. The old `units: PostureUnit[] | null` is replaced by:
  - `overview: PostureOverview | null` — the server's compact `{dataRevision, unitsTotal, sitesTotal, summary,
    siteHubs, noStationingSummary}` payload, direct from the wire.
  - `overviewEtag: string | null` — the weak ETag from the last 200; sent back as `If-None-Match` on refresh.
  - `siteDetails`, `unitDetails`, `requestGeoms` — three in-memory caches keyed by
    `${dataRevision}:${kind}:${id}` (brief §25). When the server bumps `dataRevision`, old keys stop matching
    and the next selection re-fetches.
  - `units: PostureUnit[]` — now an **accumulator** that grows as site/unit details land. It is empty on
    initial render; downstream code that iterates it just sees "no rows yet" until the operator drills in.
- **Three new lazy-fetch effects** (brief §10-§22), each with its own `AbortController`:
  - `siteDetailTarget` → `GET /operational-posture/sites/{siteId}` when the selection is a site.
  - `revealedUnitId` → `GET /operational-posture/units/{unitId}` when a unit is revealed.
  - `selectedRequestId` → `GET /operational-posture/requests/{requestId}` when a request is picked, plus the
    existing `/restationing-requests/{id}` call that fills the detail card's stage label.
- **Visibility-aware refresh** uses the shared [`startVisibilityPoll`](../frontend/src/lib/visibilityPoll.ts)
  helper (brief §30, same one proven in `visibilityPoll.test.ts`). Interval 30 s (brief §31). Hidden tabs do
  not refresh; a wake-up triggers exactly one conditional refresh (`startVisibilityPoll`'s contract).
- **Site-Hub source** now comes straight from the server. The client-side projection
  `operationalSiteHubs(units, pending, filter)` is retained in `lib/operationalSiteHubs.ts` for the existing
  unit tests but no longer called by the page. A thin `adaptServerHubs(overview)` adapter converts the
  server's `PostureSiteHub` to the existing `SiteHub` shape (adding `centroid` from `anchor`, defaulting
  `unitIds`/`noGeometryCount`/`hasOutsideReach` to their safe values).
- **Selection auto-clear on revision change** (brief §28): when a refresh returns a 200 whose siteHubs no
  longer include the current `selection.siteId`, the selection is cleared. Unit/request selections are not
  pre-validated — their lazy fetches would 404 if authority changed, and the catch branch leaves the drawn
  state alone.
- **ETag silent 304** (brief §27): a 304 updates no state at all. Map sources are not touched, camera is not
  moved, right rail is not collapsed, loading skeleton is not shown.

### 1.2 `frontend/src/api/client.ts`

- New `conditionalGet<T>` helper and `postureOverviewConditional(ifNoneMatch, signal)` returning a
  discriminated `ConditionalResult<PostureOverview>`:
  - `{ status: 304, etag }` — the caller reuses its in-memory overview.
  - `{ status: 200, body, etag }` — fresh payload.
- `api.operationalPosture()` is kept only as a test escape hatch and is **not called by PosturePage** any
  more.
- `api.postureOverview`, `api.postureSite`, `api.postureUnit`, `api.postureRequest` — unchanged, used by the
  new lazy effects.

### 1.3 Nothing else moved

The map wiring (one MapLibre instance, `setData` on three sources, cluster-expansion zoom, selected-request
proposal layers) is unchanged from the prior slice: it was already `setData`-only, already keyed on memoised
FeatureCollections (brief §32-§33). Only the DATA feeding those sources now comes from the new state model.

---

## 2. Network acceptance — per-gesture evidence

The brief's §40-§43 ask for an exact per-gesture URL list. This is what the code now issues, read straight off
`PosturePage.tsx` and `api/client.ts`.

### 2.1 Initial PosturePage open (brief §40)

| # | URL | Purpose | Added or removed |
|---|---|---|---|
| 1 | `GET /operational-posture` | Site-Hub summary — the only business read on open | kept (default) |

Not called on open:
- `GET /operational-posture?view=UNITS` — **removed** (ADR-094 Gate 2 wired the server's default to the
  Site-Hub summary; this slice removes the frontend call site too).
- `GET /map/features` — **not called**. PosturePage passes `registeredCatalogue="off"` to its embedded
  `<RequestMap>`, and `useRegisteredSites({ enabled: false })` returns an empty view without a network call
  ([`useRegisteredSites.ts:19-44`](../frontend/src/components/workspace/useRegisteredSites.ts)).
- `GET /stationing/current` — **not called** for the same reason.
- No per-unit detail calls, no per-pending geometry calls, no map-catalogue calls.

### 2.2 Site hub click (brief §10-§12, §41)

| # | URL | Purpose |
|---|---|---|
| 1 | `GET /operational-posture/sites/{siteId}` | compact units at the site + visible pending summaries |

If the operator clicks the same site again (same `dataRevision`), the detail is served from the cache and
there is **no network call** (brief §25 cache key `${dataRevision}:site:${siteId}`). A rapid A→B→A click
sequence aborts A's in-flight response before B's fires (brief §13).

### 2.3 Unit click (brief §14-§16, §42)

| # | URL | Purpose |
|---|---|---|
| 1 | `GET /operational-posture/units/{unitId}` | site boundary + PRIMARY + SUB + kind/plannedEnd + open request |

Same cache + abort semantics as the site click. A unit click does NOT re-fetch the site's units or the
map catalogue.

### 2.4 Request click (brief §19-§22, §43)

| # | URL | Purpose |
|---|---|---|
| 1 | `GET /operational-posture/requests/{requestId}` | proposal geometry only (site / PRIMARY / SUB) |
| 2 | `GET /restationing-requests/{requestId}` | existing stage-label/revisions call for the right-hand detail card |

The second call pre-dates this slice and carries the stage-label text and revision history for the detail
card — it does not drive any map layer. If the brief's intent is "ONE request-detail request", this can be
collapsed into the lazy `postureRequest` response in a later slice by extending the server payload; today
both calls fire.

### 2.5 Conditional refresh (brief §26-§29)

Every `OVERVIEW_POLL_MS` (30 s) while the tab is visible, PosturePage sends:

```
GET /operational-posture
If-None-Match: W/"<last-etag>"
```

- If the server answers **304 Not Modified** → the client does nothing (brief §27 silent). No map
  recreation, no camera jump, no right-rail collapse.
- If the server answers **200 + new ETag** → the overview is replaced; the selection stays if its site is
  still in the hubs list, otherwise cleared (brief §28). Open detail is re-fetched under the new revision
  via the same lazy effects (brief §29: the `detailKey` changes, cache misses, fetch fires).

Hidden tabs do not refresh ([`startVisibilityPoll`](../frontend/src/lib/visibilityPoll.ts)). Wake-up triggers
exactly one refresh (regression-tested in [`visibilityPoll.test.ts`](../frontend/src/lib/visibilityPoll.test.ts)).

---

## 3. Local checks — ran today

| Check | Command | Result |
|---|---|---|
| TypeScript | `cd frontend && npx tsc --noEmit` | PASS (clean, no errors) |
| Frontend tests | `cd frontend && npx vitest run` | **404/404 pass across 57 test files** (includes `abort.test.ts`, `visibilityPoll.test.ts`, `operationalSiteHubs.test.ts`) |
| Backend compile | docker Maven test-compile | PASS (unchanged since Gate 2.5 §A/B) |
| Backend ITs | `sh ops/test-backend.sh OperationalPostureRevisionIT,OperationalPostureScaleIT` | **RevisionIT 12/12 PASS**, **ScaleIT 5/5 PASS** — see [`docs/PERFORMANCE_HARDENING.md`](PERFORMANCE_HARDENING.md) |

Not run from here (need the disposable load env or a real browser):
- The 50 / 200 / 500-user load pass on `ops/load/up-load-env.sh`.
- The browser timing probe (first-useful hubs, site click, unit click, request click < 100 ms immediate
  highlight) and the network-tab recording for §45.
- Screenshot capture (§44). The UI is interactive but I cannot render the browser from this session.

---

## 4. §FINAL REPORT

```
POSTURE SITE-HUB UI MIGRATION

Legacy ?view=UNITS:
  REMOVED from PosturePage. The api.operationalPosture() method still exists as an escape hatch for the
  per-unit legacy shape but is no longer called by the posture surface. The default /operational-posture
  response (Site-Hub summary) is the only business read on initial open.

Initial posture network:
  GET /operational-posture
  (plus the static SPA / map package assets; no other business reads)

Global /map/features:
  NOT CALLED. PosturePage passes registeredCatalogue="off" to <RequestMap>, and
  useRegisteredSites({ enabled: false }) short-circuits without a network call.

Global /stationing/current:
  NOT CALLED (same reason).

Overview:
  site hubs: rendered directly from overview.siteHubs — one MapLibre point per PhysicalSite, clustered via
             the site-hubs source (clusterRadius 60, clusterMaxZoom 12).
  clusters:  render as before; cluster click uses getClusterExpansionZoom → map.easeTo(expansionZoom + 0.5).
  polygons rendered: NONE at overview. No PRIMARY, no SUB, no site boundaries, no proposal geometry, no
             connectors. Only the hub circles + attention badges.

Site selection:
  API:     GET /operational-posture/sites/{siteId}
  immediate highlight: the selected hub's `selected` property flips to 1 in siteHubsFC on the next render
                      (synchronous React re-render; the network call does NOT gate the highlight).
  geometry fit: fitBounds against the site's returned polygon (if present) with safe padding; point-only
               sites fall back to easeTo(center, zoom 15).

Unit selection:
  API:     GET /operational-posture/units/{unitId}
  Primary: drawn from the server's returned polygon.
  Sub:     drawn from the server's returned polygon.
  other-unit areas: NONE. Only the selected unit's PRIMARY/SUB are drawn.

Request selection:
  API: GET /operational-posture/requests/{requestId}
       + GET /restationing-requests/{requestId}  (existing: stage label + revisions for the detail card)
  RS current/proposed: current site/Primary/Sub from the previously-fetched unit detail (cached);
                       proposed site/Primary/Sub from the request geometry response.
  DA current/proposed: current Primary/Sub from unit detail cache; proposed Primary/Sub from the request
                       geometry response.

ETag:
  200:  Site-Hub overview + weak ETag; client stores the ETag.
  304:  SILENT. No state is updated, no map source is touched, no camera is moved, no selection is reset,
        no loading skeleton is shown. The client reuses its in-memory overview and detail caches.
  read-model-free refresh behaviour: the Gate 2 §A short-circuit on the backend means a 304 does NOT
        invoke the bulk read model — proven by `OperationalPostureScaleIT.shortCircuitSkipsReadModel`.
        The client-side 304 handling matches: zero state change.

Abort stale site/unit/request:
  PASS (code). Each lazy fetch creates its own AbortController; the effect's cleanup aborts in-flight on
  rapid re-selection. A late response from Site A will throw AbortError and be swallowed by the catch
  branch without touching state, so Site B's selection stays intact.

Detail cache keyed by revision:
  PASS (code). Cache key is `${overview.dataRevision}:${kind}:${id}`. When the server returns a new
  dataRevision on refresh, old keys stop matching and the next selection re-fetches under the new key.

Screenshots:
  NOT CAPTURED FROM THIS SESSION — needs the browser running against a live backend. Suggested capture
  plan for the review pass:
    A-UAE-OVERVIEW.png            — PosturePage on open, site clusters only
    B-SITE-HUBS.png               — mid-zoom, individual site hubs
    C-SITE-SELECTED.png           — one site selected, boundary visible
    D-COMPLETE-UNIT.png           — unit selected (PRIMARY/SUB both drawn)
    E-INCOMPLETE-UNIT.png         — unit selected, deployment areas missing
    F-REQUEST-FILTER.png          — REQUESTS filter active, hubs narrowed
    G-PENDING-RS.png              — selected RS request with current → proposed chain
    H-PENDING-DA.png              — selected DA request (no proposed site)
    I-OVERVIEW-1366x768.png       — small viewport sanity

Browser timings:
  NOT MEASURED FROM THIS SESSION — needs browser. The implementation guarantees:
    navigation → first useful hubs:  gated on ONE GET /operational-posture (compact body, index-backed
                                      dataRevision computation).
    site click → immediate highlight: synchronous React setState → next paint; no network gate.
    site click → detail loaded:       one GET /operational-posture/sites/{id}.
    unit click → immediate highlight: synchronous setState.
    unit click → areas loaded:        one GET /operational-posture/units/{id}.
    request click → proposal loaded:  one GET /operational-posture/requests/{id}
                                     + one GET /restationing-requests/{id} (detail card text only).

Tests:
  tsc --noEmit: PASS
  vitest full: 404/404 pass across 57 files
  Backend OperationalPostureRevisionIT: 12/12 PASS (unchanged from Gate 2.5)
  Backend OperationalPostureScaleIT: 5/5 PASS; jdbc-ratio 1.36× at 50× data (unchanged from Gate 2.5)
  Backend StationingNextIT: ran at Gate 2.5 — 14/14 pass (unchanged from the prior gate)

NOT PUSHED
OWNER UI + FINAL PERFORMANCE REVIEW REQUIRED
```
