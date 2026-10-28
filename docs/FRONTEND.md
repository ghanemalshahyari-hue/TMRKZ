# MOVER frontend

React 19 + TypeScript + Vite single-page app in `frontend/`, Arabic RTL, served by nginx inside the isolated network.

## Visual fidelity

The approved prototype (`dist/prototype.html`, source `unified/`, identical to the hosted concept site apart from a host-injected
Cloudflare script) is the visual reference:

- `src/styles/prototype.css` is the prototype stylesheet **verbatim** — do not edit it. Additions live in `src/styles/app.css`.
- `src/icons.ts` holds the prototype's SVG icon fragments; `<Icon>` renders the same `<svg class="icon">` wrapper.
- The DOM structure and class names of each screen mirror the prototype's render functions (sidebar, header, map card,
  wizard, review desk, calendar, studios, permissions matrix, settings, audit).
- Font: Noto Sans Arabic (OFL) served from `/fonts/NotoSansArabic.ttf`. Map: Leaflet 1.9.4 from npm with the local SVG
  basemap (from `GET /api/v1/map/packages`, fallback `/map/basemap.svg`).

## Offline / isolation

No CDN, web fonts, analytics or tile servers. The built bundle was scanned: the only `http(s)` strings are XML namespaces,
attribution anchor links (not fetched) and React error-doc URLs. nginx sends a CSP with no external origins
(`connect-src 'self'`). `/docs/` uses a separate CSP so the archived self-contained prototype can run, still with `connect-src 'none'`.

## Behaviour notes

- Identity, permissions and scope come from `GET /me`; screens are hidden with the prototype's "no access" card, but every
  rule is enforced by the server. Summary-only users see only the map, calendar and docs.
- Mutations send `X-Requested-With: mover`; submit/decision/close/execution/export send an `Idempotency-Key`
  (kept across a network failure so a retry replays instead of duplicating).
- Draft edits send `expectedVersion`; decisions send `expectedRevision`. `STALE_REVISION` and `RESERVATION_CONFLICT` are
  shown with explicit guidance.
- Counts and notifications use 30 s short polling through scoped endpoints, so revoked access stops updates immediately.
- Times are stored/sent as UTC and displayed in `Asia/Dubai`; period ends are exclusive.

## Commands

```bash
cd frontend
npm ci
npm run dev        # http://localhost:5173, proxies /api → http://localhost:8080
npm test           # vitest: date helpers, rule evaluator, API error parsing, CSV parsing
npm run build      # tsc -b && vite build → dist/
```

Docker (context = repository root): `docker build -f frontend/Dockerfile -t mover-frontend .` — the image listens on
port 80, proxies `/api/` to `http://backend:8080`, serves `/docs/` from the repository `docs/` folder and exposes `/healthz`.
`frontend/Dockerfile.dockerignore` keeps `node_modules`, `backend/` and `.git` out of the build context.
