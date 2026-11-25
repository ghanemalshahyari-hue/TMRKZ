# Acceptance report — VM deployment standardisation and the browser Update Center (ADR-104, 25 Nov 2026)

Tested on the development PC with the existing images and libraries, on a throw-away installation laid out like the VM's
`/data/TMRKZ` (Compose project `tmrkz-vmsim`, port 8188, a third Compose file, no `tmrkz-images.tar`, fictional data). The
production VM and its database were not accessed. «Verified» below means on that simulation, not on the VM.

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Inspect runtime references, mounts, start/build scripts, docs, map and certificate paths | Done: the mounts read `./backend`, `./frontend`, `./docs`, `./handoff`, `./map-packages`, `./data/*`, `./backups`, `TMRKZ_MAP_ROOT` (default `./map-runtime`), `ops/local/.generated/{certs,ldap,truststore}`, single-file scripts under `ops/local/`; `docs/` and `handoff/` are optional (in-app documentation) | `docker-compose*.yml`, `ops/diagnose.sh` §3, §7 |
| 2 | Clean deployment folder with only necessary files | Superseded by the owner's «one folder» decision: no second folder. The necessary files are the `app`/`docs`/`config` classes of `ops/update/managed-paths.conf`; `make-release.sh --package` produces exactly them for the one-time transfer | `release/TMRKZ-app-*.tar` (no protected or dev path inside) |
| 3 | Missing directories; runtime vs development-only files | `ops/diagnose.sh` §3 lists missing folders; the rules file separates `dev` from runtime | `docs/UPDATE_CENTER_AR.md` §4 |
| 4 | Preserve `.env`, `certs/`, `data/`, `backups/`, `map-data/`, `map-runtime/`, `docker-compose.dc-hosts.yml`, `ops/local/.generated/` | `protected` in the rules and hard-coded in the worker; `data/`, `.env`, `ops/local/.generated/` also mounted read-only into the worker | E2E UC-04, UC-07 |
| 5 | Never replace VM Compose settings; compare and preview | Compose files are `config`: shown, never preselected, written only when chosen; extra Compose files `protected` | E2E UC-01, UC-04 |
| 6 | `start.sh` starts with loaded images without the archive or its checksum | Done | E2E UC-10; the simulation itself was started this way |
| 7 | Existing Maven and npm libraries only; no new dependency or image | The worker builds offline with the image's Maven repository; a changed `package-lock.json` is refused; nothing added to `pom.xml`/`package.json`; worker runs in `tmrkz/folder-backend:1` | E2E UC-08; `git diff` of the manifests |
| 8 | Identify the actual Compose project and files; never ignore extra files silently | `start.sh` stops on an unnamed `docker-compose.*.yml` and shows the files the running containers used; `ops/diagnose.sh` §1 | E2E UC-10 |
| 9 | Browser Update Center: discover, compare, protected paths, validate, apply approved changes through restricted maintenance | Done (signed release, comparison, per-file approval, offline build check, backup, apply, verify, automatic and requested rollback, audit, step-up) | E2E UC-01…UC-08; `UpdateCenterIT` 3/3 |
| 10 | Read-only diagnostics: folders, dependencies, mounts, certificates, maps, database, failed services | `ops/diagnose.sh` (also identities, authorisation mirror, HR sync, build state) | run on :8088 |
| 11 | Ubuntu, Windows CMD and PAM instructions; no PowerShell | `docs/UPDATE_CENTER_AR.md`, `RUN.md` §5a | — |
| T1 | Restart behaviour | A restart starts the last build without rebuilding | E2E UC-09 |
| T2 | Source updates | Backend and web rebuilt and verified after an update | E2E UC-03 |
| T3 | Missing-folder handling | `ops/diagnose.sh` §3 reports missing folders | diagnose run |
| T4 | Persistence and protected data | `.env`, `certs/`, the VM Compose file and the trust key unchanged byte for byte | E2E UC-04, UC-10 |
| T5 | Backups and rollback | Every replaced or deleted file backed up first; rollback restores exactly; a failing verification rolls back by itself | E2E UC-04, UC-06 |
| T6 | Offline map availability | The offline map manifest is served | E2E UC-11 |

**Transfer (one time, PAM):** `release/TMRKZ-app-<id>.tar`, `release/SHA256SUMS`, `release/config/docker-compose.yml`,
`release/config/docker-compose.override.yml`, `ops/local/.generated/release-signing.pub`.
**Never touched:** `.env`, `certs/`, `data/`, `backups/`, `map-data/`, `map-runtime/`, `docker-compose.dc-hosts.yml`,
`ops/local/.generated/`, `tmrkz-images.tar`.
**Not needed for deployment:** `tests/`, `backend/src/test/`, `prototypes/`, `docs/audit/`, `docs/evidence/`, `.github/`,
`.vscode/`, `.zcode/`, `AGENTS.md`, `CLAUDE.md`.

E2E result: 33/33 passed (`docs/evidence/update-center/results.json`, `e2e.txt`, screenshots)
