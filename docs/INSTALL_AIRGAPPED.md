# MOVER — Installation in an isolated network

## 0. This folder is the offline installation (owner, 16 Nov 2026)

The TMRKZ folder itself is carried to the isolated machine; nothing else is needed. It holds the runtime images saved with
`docker save` in `images/` (with `SHA256SUMS` and each image id), the newest verified backup in `backups/tmrkz-mover-*/`
(business, identity and authorisation databases, files, and `oracle-hr-demo-data.tgz` for the demo HR source), the installed
offline map in `map-data/runtime/current` (official `tmrkz-map-2026.11.2`, the only map kept), and the settings `.env`,
`ops/local/.generated/` and `ops/hr-demo/.generated/` (git-ignored; secrets — carry them only on the approved medium).

On the isolated machine (Docker Desktop or Docker Engine with compose, Git Bash or any POSIX shell):

```sh
sh ops/local/offline.sh          # loads missing images (checksums first), restores the backup on a machine without data, starts everything
sh ops/local/offline.sh check    # proves the application network has no route to the internet
sh ops/local/offline.sh stop     # stops everything; data kept in the Docker volumes
```

Nothing is built or pulled (`--no-build --pull never`), and the application's compose network is `internal` (no route out;
only the web container also joins `edge` to publish its port on this host) — `ops/local/compose.offline.yml`. Before a
transfer, refresh `images/` and the backup from the running installation (`docker save`; `ops/backup.sh` then
`ops/verify-backup.sh`, then archive the demo Oracle volume beside it) so the folder carries the latest state.

The procedure below (a separate bundle directory) remains for building a release bundle on a connected build host.

## 1. Build the offline bundle (connected build host)

```sh
sh ops/airgap-bundle.sh            # → offline-bundle/mover-1.0.0/
```

The bundle contains the runtime images saved with `docker save` (`mover/backend:1.0.0`, `mover/web:1.0.0`,
`tmrkz/keycloak:26.7.5-2`, `postgis/postgis:17-3.5-alpine` — PostgreSQL 17.11 with PostGIS 3.5, GEOS and PROJ, whose
coordinate transformations run locally with network access disabled) with their image IDs, `docker-compose.yml`, `.env.example`, operational scripts, the local
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

`install.sh` runs `ops/init-env.sh`, which generates the secrets. Before the first start, fill in the directory
settings (`LDAP_*`) and place the organisation's CA in `ops/keycloak/truststores/` (see OPERATIONS §Sign-in). There is
no demo mode, user switch or local password in the build; the first administrator receives a `SYSTEM_ADMIN`
membership once their HR record is mirrored.

## 3. Network and TLS

- Only the `web` service publishes a port (`MOVER_HTTP_PORT`, default 8088). The database and backend are reachable
  only on the internal compose network.
- **https (ADR-051):** TMRKZ serves it itself, as TNQL: `ops/tls/make-csr.sh` (key on the server, request to the PKI
  team), `ops/tls/install-cert.sh` (checks the issued certificate), `ops/tls/enable.sh` (sets `.env` and the identity
  provider), then restart; see `ops/tls/README.md`. The plain port is then bound to this host only. An organisation that
  prefers its own reverse proxy may instead terminate TLS there, in front of `web`, and set `TMRKZ_PUBLIC_URL` and
  `MOVER_SECURE_COOKIE=true`. Either way the organisation's internal CA is used; nothing contacts external certificate
  services.
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

Built-in packages are under `map-packages/<name>/` with a `manifest.json` (source, licence, attribution, coverage,
zoom range, kind, CRS, version, data date, files with SHA-256); rebuild/restart the backend image to add one, or mount
the directory at `/opt/mover/map-packages`. Packages whose checksums do not match are refused and logged.

Normally an authorised map manager uploads packages from the map («مدير الخرائط»): they are checked, wait for review,
can be previewed, and are activated or disabled with a recorded reason (`docs/OPERATIONS.md`). Nothing is downloaded by
the server; there is no network source to configure. Aerial imagery appears only when a licensed package is installed.
