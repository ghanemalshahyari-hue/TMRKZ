# MOVER — Operations guide

## Backup

```sh
sh ops/backup.sh [project] [output-root]     # default project tmrkz-mover → backups/<project>-<UTC stamp>/
```

Produces `db.dump` (pg_dump custom format: business data, identities, roles, delegations, policies, form and
workflow versions, Flowable runtime/history, audit trail), `files.tgz` (attachments and exports), `map-packages.tgz`,
`fingerprint.txt` (row counts + md5 per critical table) and `manifest.json` (SHA-256 of every file). Run it on a quiet
system or accept that the fingerprint reflects the moment after the dump. Copy backups off-host according to the
organisation's retention policy (D-05 open).

## Restore

```sh
sh ops/restore.sh <backup-dir> [target-project] [http-port]
```

Restores into a **clean** project only (it refuses if the target database volume exists), verifies manifest checksums
first, restores the database, then the files volume, then starts the stack.

## Proving restore (AT-30)

```sh
sh ops/verify-restore.sh [source-project]
```

Backs up the source, restores into `<project>-restoretest` on port 18088, compares the 20 table fingerprints and
the SHA-256 of every stored attachment, checks the restored entry point, and removes the throw-away project.
Last run (28 Oct 2026): 20/20 tables identical, 2/2 attachments identical — PASSED.

## Upgrade and rollback

1. `sh ops/backup.sh` and keep the backup until the upgrade is accepted.
2. Load the new images (offline bundle) and `docker compose up -d --no-build`. Flyway applies new migrations on
   start; migrations are forward-only and additive by policy.
3. Verify `/api/v1/system/health`, sign in, run `tests/acceptance/journey.mjs` in a test environment.
4. **Rollback:** stop the stack, restore the pre-upgrade backup into a clean project (`ops/restore.sh`) with the
   previous image tags. Do not run an older image against a newer schema.

Published form, workflow and policy versions are immutable, and running requests stay on their pinned versions, so
configuration changes never require data migration of in-flight requests.

## Monitoring (local only)

- Health: `GET /api/v1/system/health`, `GET /actuator/health` (backend network).
- Metrics: `GET /actuator/prometheus` on the backend (not published through `web`). Useful series:
  `http_server_requests_seconds` (API latency by URI/status), `mover_auth_failures_total{reason}` (failed sign-ins),
  `mover_api_errors_total{code}` (incl. `FORBIDDEN`, `RESERVATION_CONFLICT`), `mover_outbox_delivered_total`,
  `mover_outbox_failures_total`, and `GET /api/v1/system/info` → `outboxPending`.
- Review backlog: `GET /api/v1/reports/kpis` (overdue reviews and execution tasks, with definitions).
- Logs are written to stdout with a `traceId` per request (also returned as `X-Trace-Id`). Attachment content,
  passwords, session tokens and attestation keys are never logged.

## Secrets and key rotation

- `.env` holds `MOVER_DB_PASSWORD`, `MOVER_ATTESTATION_KEY`, optional demo password; permissions 600; never committed.
- Rotating `MOVER_ATTESTATION_KEY` affects only new attestations. Keep the retired key in the organisation's key
  vault to re-verify evidence on historical approval documents.
- Production hardening: create a restricted runtime database role (DML on business tables, no DDL, no `TRUNCATE`)
  and run migrations with a separate owner role; keep the audit table's triggers owned by that owner.

## User administration

- People, memberships (dated) and delegations are managed in «الهيكل التنظيمي» by `CONFIGURE` holders; ending a
  membership withdraws access immediately and is audited (open tasks stay with the remaining role holders).
- Initial administrator in a non-demo installation:
  ```sql
  -- inside: docker compose exec db psql -U mover -d mover
  -- password hash: generate a BCrypt hash with the organisation's approved tool
  insert into person(id, employee_no, display_name, username, password_hash)
    values (gen_random_uuid(), 'E-0001', 'مدير النظام', 'admin', '<bcrypt-hash>');
  insert into organization(id, code, name) values (gen_random_uuid(), 'ORG', 'المؤسسة');
  insert into membership(id, person_id, organization_id, role_code, valid_from)
    select gen_random_uuid(), p.id, o.id, 'SYSTEM_ADMIN', now() from person p, organization o
    where p.username = 'admin' and o.code = 'ORG';
  ```
- Organisation structure in bulk: «إعدادات النظام» → import (CSV: `code,name,parentCode`) with preview before commit.

## Running the tests

```sh
sh ops/test-backend.sh                                        # 36 backend acceptance tests on a throw-away PostgreSQL
MOVER_DEMO_PASSWORD=... node tests/acceptance/journey.mjs      # end-to-end journey through the web entry point
(cd frontend && npm ci && npm test && npm run build)          # frontend unit tests and type-checked build
python ops/tools/gen-openapi.py                               # regenerate docs/api/openapi.json from the controllers
```
