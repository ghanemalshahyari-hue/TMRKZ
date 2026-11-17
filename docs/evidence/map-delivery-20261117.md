# Offline map delivery repair — 17 November 2026

## Scope and preserved state

- Target: the existing local application at `http://localhost:8088`, project `tmrkz-mover`, source revision `733b4aa` plus existing uncommitted work.
- Changed only map serving through the web container and the local startup path. No map package content, database schema, API contract, policy, TypeScript or MapLibre version was changed.
- Existing authentication and LDAP work in the same files/repository was preserved. No volume, backup, map archive or business record was deleted or overwritten.

## Reproduced defects and causes

1. `GET /map-data/manifest.json`, `/map-data/basemap/uae.pmtiles`, the hillshade and the map font returned **403**. Nginx logged `Permission denied` opening `/srv/tmrkz-map/current/…`.
   - The bind-mounted package is on VirtualBox `vboxsf`, retained as UID/GID `0:984`, mode `0770`, including every package directory and file.
   - Nginx workers run as `101:101`. Requested `chmod o+rX` changes were silently not retained by this filesystem.
   - Compose `group_add` reached only the root Nginx master. Nginx replaced its workers' supplementary groups with `101 101`, so that alone did not repair access.
2. After adding the mount group to the Nginx worker account in `/etc/group`, ordinary worker reads succeeded but responses still broke. Nginx logged `sendfile() failed (22: Invalid argument)` on the shared mount.
   - `/map-data/` now uses `sendfile off`; complete and ranged reads then succeeded.
3. The first reusable override candidate omitted the image's Nginx `command` when replacing its entrypoint, so its workers restarted. This was caught by the standard startup check and corrected before the successful run below. The backend came up healthy at V44 and Flyway reported no migration necessary.
4. After delivery was repaired, the recovered in-app browser opened a normal developer session but both `#siteSetup` and `#stationing` displayed the application's page error: `WebGL2 is required to display this map…`.
   - MapLibre 6.15.0 requests `webgl2` before style/PMTiles loading, including in 2D mode (`frontend/node_modules/maplibre-gl/src/ui/map.ts`). The verification browser does not supply that capability.
   - This is a separate browser/GPU limitation, not a failed map download. No non-WebGL general fallback exists in `RequestMap`/`SitesMap`/`MapFrame`. An interactive canvas pass is **not claimed** here. Use a current browser with WebGL2 and hardware acceleration available; replacing the map engine was outside this serving repair.

## Implemented repair

- `ops/local/map-worker.sh`: gives the non-root `nginx` account the map mount's numeric group, idempotently, then runs the preserved image entrypoint. It refuses invalid/changed group IDs rather than running workers as root.
- `ops/local/compose.map-access.yml`: retains the image command, supplies that group, keeps mounts read-only, and applies the map-serving Nginx configuration to the preserved offline web artifact.
- `ops/local/up.sh`: derives `TMRKZ_MAP_GID` from `TMRKZ_MAP_ROOT` (GNU/BSD `stat`) and includes the override in startup and restore Compose inputs.
- `frontend/nginx.conf`: streams `/map-data/` without `sendfile(2)`. The package remains GET-only, read-only, symlink-restricted, and its business analysis/source inputs remain unserved.

## Verification actually performed

### Standard offline startup and restart

`TMRKZ_OFFLINE=1 sh ops/local/up.sh web` — **exit 0**. The effective Compose inputs included both the existing manual-LDAP override and `ops/local/compose.map-access.yml`. Platform accounts/client were idempotently ready. Backend and database remained healthy; schema stayed V44 with **44 migrations validated, no migration necessary**.

After `docker restart tmrkz-mover-web-1`:

```text
home after restart HTTP 200
basemap after restart HTTP 206 bytes=1024
worker Groups: 101 101 984
```

`docker exec tmrkz-mover-web-1 nginx -t` — syntax and configuration both successful. `sh -n` on both changed shell scripts and `git diff --check` on the map changes passed.

### Package and served files

`python3 ops/map-package/readiness.py --root map-data/runtime --url http://localhost:8088 --db-container tmrkz-mover-db-1 --expect-package tmrkz-map-2026.11.2 --require-terrain-3d`

- **Passed:** installed package `tmrkz-map-2026.11.2`, its expected identity, 43-file manifest/content checks and all SHA-256 values; basemap PMTiles and coverage; required local font/style URLs; terrain coverage/provenance; 3D Terrain-RGB; matching loaded terrain dataset (6,300 tiles); identical served manifest; basemap, hillshade and Terrain-RGB range responses; map font full response; analysis file refusal (404).
- **One failure, intentionally not “fixed” by inventing configuration:** `terrain version expected: no Stationing policy in force`.
- Result was therefore **NOT READY / exit 1** for the complete business-policy check. All 22 other package/serving checks passed; this does not re-open the repaired asset-delivery defect.

Additional byte checks: the downloaded manifest equalled the installed file, and bytes 0–1023 of the served basemap equalled the same installed range. A complete hillshade `GET` returned 200 with 128,889,875 bytes. Basemap/font/manifest range probes returned 206 and 1,024 bytes. `analysis` returned 404.

`sh ops/local/offline.sh check` — passed: application network `internal: true`, no route to the internet. Recent Nginx logs contain no map permission or `sendfile` errors.

## Live authorised API check (read-only)

A temporary diagnostic used the normal TMRKZ → Keycloak OIDC path for the existing `developer` account, never exposed its password/cookie, and logged the temporary session out afterwards. It returned only statuses/counts:

```text
/me                       200
/map/features             200, features=1
/map/context              200
/map/packages             200, rows=2
/stationing/current       200, rows=0
/stationing/routes        200, policyInForce=false
/request-hub/home-cards   200, rows=0
/operational-posture      403 FORBIDDEN (scoped denial; no grant was added or bypassed)
```

Thus the permitted map APIs and site/package data are available independently of WebGL. Existing `useRegisteredSites.ts` and `CalendarPage.tsx` still catch map API failures and turn them into empty arrays; that pre-existing UX defect can disguise an authorisation/backend failure as “zero sites” and was **not changed** in this deployment-only repair.

## Remaining limits / not rerun

- The verification browser lacks WebGL2, so the interactive map canvas could not be accepted here. Delivery endpoints and the normal UI session were checked, but that is not a claim that canvas drawing, drag/edit or 3D was exercised in this run.
- No active Stationing policy exists on this restored application. It needs an authorised institution/acceptance policy; none was generated by this repair.
- Backend/API behaviour and TypeScript were unchanged, so full backend/frontend suites were not rerun. The known missing Linux Rollup package and JDK/build limitations from `docs/STATUS.md` remain; the preserved frontend artifact was patched only by mounting the Nginx configuration, not represented as a fresh application build. `python3 -m pytest ops/map-package -q` could not start because this offline host has no `pytest` module (`No module named pytest`); the independent full package/readiness checks above did run. No package was downloaded to fill that tooling gap.
