# MOVER — Installation in an isolated network

## 1. Build the offline bundle (connected build host)

```sh
sh ops/airgap-bundle.sh            # → offline-bundle/mover-1.0.0/
```

The bundle contains the three runtime images saved with `docker save` (`mover/backend:1.0.0`, `mover/web:1.0.0`,
`postgres:17.11-alpine`) with their image IDs, `docker-compose.yml`, `.env.example`, operational scripts, the local
map packages, all documentation, and a `SHA256SUMS` manifest. Build-only images (Maven, Node) are not needed in the
isolated network. Transfer the directory through the organisation's approved media/transfer process.

## 2. Install (isolated host)

Requirements: Docker Engine 24+ with the compose plugin, 4 CPU / 8 GB RAM minimum for evaluation, disk for the
database and attachment volumes.

```sh
cd mover-1.0.0
sha256sum -c SHA256SUMS            # integrity of every transferred file
sh install.sh                       # loads images, creates .env with random secrets, starts the stack
```

`install.sh` runs `ops/init-env.sh` without `--demo`, so no fictional data and no demo user switching are enabled.
Create the first administrator by inserting a person and a `SYSTEM_ADMIN` membership (see OPERATIONS §User
administration) or run once with `--demo` in a non-production evaluation environment only.

## 3. Network and TLS

- Only the `web` service publishes a port (`MOVER_HTTP_PORT`, default 8088). The database and backend are reachable
  only on the internal compose network.
- Terminate TLS on the organisation's internal reverse proxy in front of `web`, then set `MOVER_SECURE_COOKIE=true`.
  Use the organisation's internal CA; nothing in MOVER contacts external certificate services.
- **Docker networking is not isolation.** A default bridge network can still reach the outside. Enforce egress
  denial at the host/firewall level and verify it, e.g. from inside the backend container:
  `docker compose exec backend wget -T 5 -qO- https://example.com` must fail.
- The application itself makes no outbound calls at run time: fonts, Leaflet, map packages and documentation are
  served locally, and the web CSP allows only same-origin resources (checked by `tests/acceptance/journey.mjs`).

## 4. Verify the installation

```sh
curl -s http://localhost:8088/api/v1/system/health          # {"status":"UP"}
docker compose ps                                           # db, backend, web healthy
sh ops/verify-restore.sh                                    # optional: proves backup/restore on this host
```

## 5. Time and time zone

Server time is authoritative and stored in UTC; display uses the organisation setting (default `Asia/Dubai`).
Synchronise host clocks with the internal time source; containers inherit the host clock.

## 6. Map packages

Place additional packages under `map-packages/<name>/` with a `manifest.json` (source, licence, attribution,
coverage, CRS, version, data date, files with SHA-256) and rebuild/restart the backend image, or mount the directory at
`/opt/mover/map-packages`. Packages whose checksums do not match are refused and logged.
