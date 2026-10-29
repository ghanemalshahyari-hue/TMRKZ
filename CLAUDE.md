# TMRKZ implementation entry point

This repository is the initial concept and complete administrative handoff. Its prototype working name is MOVER.

Read, in order:
1. `handoff/START_HERE.md`
2. `handoff/CLAUDE_BUILD_PROMPT.md`
3. `handoff/DECISIONS.md`
4. `handoff/REQUIREMENTS.md`
5. `handoff/ARCHITECTURE.md`
6. `handoff/DATA_MODEL.md`
7. `handoff/API_CONTRACT.md`
8. `handoff/ACCEPTANCE_TESTS.md`
9. `handoff/SOURCES.md` and `handoff/PROTOTYPE_VERIFICATION.md`

Inspect `dist/prototype.html` and the editable sources under `unified/`. `handoff/` holds the authoritative specifications; `dist/handoff/` is a generated copy. The five previous designs remain as references in `dist/`.

Follow `handoff/CLAUDE_BUILD_PROMPT.md` for phased implementation. Preserve the existing prototype and documentation while adding production application modules in clearly named directories. Record decisions, keep requirement-to-test traceability, and explicitly report unimplemented items.

Build generic administrative facilities, reservations, identity, permissions, forms, approval workflows, audit, and offline deployment. Exclude military deployment optimization, tactical positioning, and operational recommendations. Do not solicit actual sensitive locations for demo data.

The local role picker and signature demonstration are not production authentication or PKI. Real authorization belongs on every server operation, and final booking confirmation must enforce atomic conflict prevention. Do not claim readiness from screenshots or mock data alone.

Do not rely on a cloud service or Vercel for the isolated production deployment. Use stable compatible dependency versions, retain third-party attribution, and keep secrets out of source control.

Start implementation from the recorded assumptions and open decisions without repeating the original questionnaire.

## Production implementation (added 2026-10-28)

Production modules live beside the preserved concept: `backend/` (Spring Boot 4.0.9 + embedded Flowable 8.0.0, Java 25 LTS, PostgreSQL 17 via Flyway), `frontend/` (React 19 + Vite, styles reuse `unified/style.css` verbatim), `map-packages/` (licensed local basemap with manifest and checksums), `ops/` (env generation, backup/restore/verify, air-gap bundle, load test, OpenAPI generator), `tests/acceptance/` (end-to-end journey). Production runs with `sh ops/init-env.sh`, directory settings in `.env`, then `docker compose up -d --build` (compose project `tmrkz-mover`, port 8088); sign-in is Keycloak + LDAP only. The fictional acceptance environment runs with `sh ops/test-env/up.sh` (compose project `tmrkz-test`).

Before changing behaviour, read `docs/STATUS.md` (delivered, limits, open decisions), `docs/TRACEABILITY.md` (R-xx/AT-xx → code → test) and `docs/ARCHITECTURE_DECISIONS.md` (why Keycloak/OpenFGA/PostGIS were replaced). Verify with `sh ops/test-backend.sh` (70 acceptance tests on real PostgreSQL + PostGIS), `node tests/acceptance/journey.mjs` (against the test environment), `sh ops/test-env/up-offline.sh && node tests/acceptance/map-workspace.mjs` (MAP-01…MAP-18 in Edge, no internet egress), `sh ops/verify-restore.sh`, and `cd frontend && npm test && npm run build`. Regenerate `docs/api/openapi.json` with `python ops/tools/gen-openapi.py` after changing controllers. Keep `docs/TRACEABILITY.md` and `docs/STATUS.md` current with every change.
## Administrative production direction — 2026-10-29

Before implementing further administrative features, read `docs/ADMIN_PRODUCTION_IMPLEMENTATION_PROMPT_AR.md`. It records the owner’s new choices for hourly read-only Oracle HR synchronization compatible with TNQL, Keycloak/LDAP, OpenFGA, scoped independent edit and approval rights, administrative facilities geometry, certificate-based signatures and electronic seals, and one production runtime configuration. These are implementation requirements, not a claim that the current build already meets them. The original administrative scope exclusions remain in force.

`docs/ui/INTERFACE_OPTIONS.fragment.html` is a self-contained inline design reference containing three administrative layouts and fictional facilities; it is not a production application or a substitute for the current frontend. The full-page styles and carousel use the visualization host runtime. Preserve existing code, follow the new acceptance checklist, and update status/traceability with measured evidence as work completes. Update ADRs when changes are implemented; retain the history of the existing choices.

## Map workspace completion — 2026-10-29

For the owner's report that the map is incomplete, read `docs/MAP_WORKSPACE_COMPLETION_AR.md` alongside the administrative production brief before implementing step 4. It records the source review at `93f3570`, the required administrative map journey, removal of fabricated boundaries, real geometry and background-layer management, and MAP-01…MAP-18 acceptance checks. Preserve the ongoing identity/permissions work and the scope exclusions above. This document is a completion requirement, not a claim that the map has been implemented or tested. Implementation status (2026-10-29): ADR-017; evidence per MAP criterion in `docs/TRACEABILITY.md` and `docs/evidence/map/`; remaining limits in `docs/STATUS.md`.

