# TMRKZ

Initial concept and implementation handoff for an Arabic RTL enterprise **administrative facilities, reservations, and approvals** platform. The interface prototypes retain their working name **MOVER**.

This repository contains the full prototype source, five earlier HTML design concepts, a unified interactive demo, map assets, research references, requirements, decisions, architecture, API behavior, data model, acceptance criteria, and a Claude implementation brief.

## Start with Claude

Ask Claude Code to read `CLAUDE.md`, then `handoff/START_HERE.md` and `handoff/CLAUDE_BUILD_PROMPT.md`, followed by all specification files under `handoff/`. Begin implementation from the recorded assumptions and open decisions; do not ask the original 30 questions again.

The prototype uses browser-local data and simulated roles/signatures. A production backend, real authentication and authorization, database concurrency protection, and production signing are still to be implemented.

## Preview

Open `dist/prototype.html` directly in a modern browser, or serve `dist` locally:

```sh
python3 -m http.server 8080 --directory dist
```

Then open http://localhost:8080. Map, font, and Leaflet assets are embedded for offline preview. `DecompressionStream` is needed for the embedded basemap. All named facilities, people, requests, and facility bounds are fictional.

- `dist/index.html`, `dist/prototype.html`, `dist/06-unified.html`: unified prototype.
- `dist/concepts.html`: gallery of the five earlier concepts.
- `dist/01-atlas.html` through `dist/05-calendar.html`: individual concepts.
- `dist/questions.html`: original administrative discovery questionnaire.
- `dist/mover-claude-handoff.zip`: prior packaged handoff.
- `handoff/`: authoritative requirements and implementation documentation.
- `unified/`: editable unified HTML, CSS, and JavaScript sources.
- `assets/`, `basemap.svg`, `basemap.geojson`: local third-party assets and illustrative public geographic extract.
- `docs/previews/`: screenshots of the concept.
- `MANIFEST.sha256`: import checksums for the initial handoff files; regenerate when sources change.

## Rebuild

Requires Python 3 with only its standard library; no dependency installation is needed.

```sh
python3 build_concepts.py
python3 build_unified.py
```

Run the unified builder last so `dist/index.html` remains the unified prototype. The original five-concept gallery is retained in `dist/concepts.html`.

## Implementation direction

Proposed architecture: React + TypeScript + Vite, Spring Boot with embedded Flowable Open Source, Keycloak, OpenFGA, PostgreSQL and optional PostGIS, local attachment storage, transactional outbox, and isolated Docker deployment. The handoff explains component compatibility and the open decisions. These are proposals, not components already implemented by this repository.

Target record counts are approximately 7,000 organizational entities and 200,000 people; concurrent usage and performance objectives remain to be established.

## Scope and licenses

The implementation scope is administrative facility and reservation management. It excludes military deployment planning, tactical positioning, and operational recommendations. Public geographic data is illustrative and is not a navigation product.

Preserve third-party licenses and map attribution. See `FONT-LICENSE.txt`, `assets/leaflet-license.txt`, `handoff/SOURCES.md`, and the basemap metadata. No license for original project code has been selected yet; do not assume it is open source.

The original private Site preview is available to its authorized owner at https://mover-map-concepts-ghanem.ghanemalshahyari.chatgpt.site . No Site credentials or hosting identity are required to use this repository.
