# Acceptance test environment (fictional data only)

This environment exists only to run the real sign-in path and the journeys end to end. A production deployment never
contains it: there is no demo mode, no user switch and no local password form in TMRKZ.

```sh
sh ops/test-env/up.sh                 # builds and starts TMRKZ + Keycloak + a fictional OpenLDAP, then seeds data
cat ops/test-env/.generated/user-password
```

**Migration gate (4 Nov 2026).** `up.sh` and `up-offline.sh` rebuild the backend from the working tree, and the backend
applies pending migrations on start. They now refuse when the migrations in the tree are ahead of this environment's
Flyway history, unless `TMRKZ_APPLY_MIGRATIONS` names exactly the pending versions. Upgrade the environment with a
release image instead: `EXPECT_PENDING="17" AFTER_SQL=ops/sql/checks/V17-after.sql sh ops/test-env/upgrade-backend.sh
<image> <label>` (the database must be labelled ACCEPTANCE; plan, backup verified by `ops/verify-backup.sh`, fingerprints
before and after; evidence in `docs/evidence/acceptance-upgrade/`).

**Stationing V3 acceptance data (4 Nov 2026, owner D4).** `sh ops/test-env/provision-acceptance-v3.sh` (plan, rolled
back) then `CONFIRM_TARGET=tmrkz-test sh ops/test-env/provision-acceptance-v3.sh` writes the fictional acceptance data
the workflow needs on an `ACCEPTANCE` database at V19 or later:
- HR levels;
- single-action roles and seats for selected fictional users;
- starting stationing;
- a missing boundary.

It is idempotent and publishes no policy. Terrain is loaded separately with `ops/terrain/load-slope.sh`.

**Stationing V3 page on the acceptance environment.**
- **Web image:** built with `--build-arg STATIONING_V3=true` (the unit tests still run with the flag off) and swapped with `sh ops/test-env/upgrade-web.sh <image> <label>`.
- **Map files:** mounts the offline map packages read-only under `/map-data/` (`compose.v3-maps.yml`).
- **Recovery:** `MAPS=0 sh ops/test-env/upgrade-web.sh mover/web:1.0.0 <label>`.
- **Policy:** import `acceptance-v3-policy-template.json` in «سياسة التمركز», set the routing levels and the deployment
  requirement, check, and publish as the System Administrator.

**Stationing V3 development environment (4 Nov 2026).** `sh ops/test-env/dev-v3.sh build|up|seed|down` runs the
disposable project `tmrkz-v3dev` on :8097. It has the same fictional directory and data, the backend built from the
working tree (never a release), memory caps, and illustrative development values for Stationing V3
(`ops/test-env/dev-v3-seed.sql`). The live frontend runs with `cd frontend && MOVER_API=http://localhost:8097
VITE_STATIONING_V3=true npx vite --config vite.dev.config.mjs --host 127.0.0.1`, then «إعادة التمركز» at `http://127.0.0.1:5173/#restationing`. It is
never the acceptance (`tmrkz-test`) or production (`tmrkz-mover`) project.

Open `http://localhost:8088` and choose either **الدخول الآلي بالحساب المؤسسي** (Keycloak) or **إدخال اسم المستخدم
وكلمة المرور يدوياً** (checked by the directory). Keycloak shows the TMRKZ sign-in page. The
directory (OpenLDAP, StartTLS with a test CA that only this environment trusts) verifies the password, and TMRKZ links
the account to the fictional HR record whose domain account equals the login name.

| Login | Role | Organisation |
|---|---|---|
| `t.admin` | System administrator (configuration, access, facilities — no request content) | GA |
| `t.requester` | Requester | SS |
| `t.requester2` | Requester | IT |
| `t.facilities` | Facilities reviewer | SS |
| `t.manager` | Organisation manager | SS |
| `t.manager.it` | Organisation manager | IT |
| `t.manager.ga` | Organisation manager | GA |
| `t.approver` | Approver | GA |
| `t.approver2` | Deputy approver | GA |
| `t.limited` | Limited (summary) viewer, sites 02/05/08 | SS |
| `t.auditor` | Auditor | GA |
| `t.unlinked` | In the directory only: sign-in is refused and queued for an access manager | — |

`t.requester2` also holds «مقدم طلب في موقع مشترك», a role scoped to the shared building (site 11), so a second
organisation can use it. `t.manager` is also «مسؤول صلاحيات الجهة» for SS: in «مركز الصلاحيات» they may grant
«مقدم الطلب», «اطلاع محدود» and «مقدم طلب في موقع مشترك» inside SS only. `t.manager.it` holds a summary view whose scope
is SS (with branches) AND the shared building — an example of an explicit intersection. `t.admin` is the global access
manager (drafts, publication, rollback, rebuild).

Certificate signatures use a fictional signing PKI generated once under `.generated/signing/` (`signing-pki.sh`):
`t.approver` has a valid certificate, `t.approver2` a revoked one, and «الإدارة العامة» a seal. Switch «نمط التوقيع» to
PKI in الإعدادات (as `t.admin`) to sign approvals with them; switch back to «توثيق داخلي» before running the map and
journey suites. The CRL is valid for 30 days: delete `.generated/signing/` to regenerate the whole test PKI. Sites: `00` main campus (no parent) with sub-sites `01`–`08`; `10` a main site of the remote
branch «فريق مرافق الشمال» (إدارة المشاريع ‹ قسم مشاريع المباني ‹ وحدة الصيانة الإدارية); `11` a shared main building with a
shared resource and two exclusive rooms. No boundaries are seeded: they are imported or drawn through the application
(`tests/acceptance/fixtures/`).

```sh
sh ops/test-env/up-offline.sh                # same project without internet egress (internal-only network)
node tests/acceptance/map-workspace.mjs      # MAP-01 … MAP-18 in Microsoft Edge (cd tests/acceptance && npm ci first)
sh ops/test-env/relink.sh                    # only after rebuilding the fictional directory: reset fictional links
```

The browser test uploads a fictional facility plan package (`fixtures/campus-plan`, CC0) through the map manager and
disables the copies of earlier runs.

All users share the password in `ops/test-env/.generated/user-password`. The directory administrator password and the
test CA are also there. Everything under `.generated/` is git-ignored and is regenerated if deleted. To stop, run
`docker compose -p tmrkz-test -f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml down` (add `-v` to delete the data).

The organisations, people and facilities are fictional and illustrative; they do not describe any real site.

Stationing workspace demo (ADR-025, fictional): after `up.sh`, load example distance rules (1–6 km for premises, up to
3 km for a work area), two sections of «الخدمات المشتركة», an occupied site 05 with an illustrative boundary and the
sections' bookings with `docker exec -i tmrkz-test-db-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ops/test-env/stationing-demo.sql`,
then sign in as `t.requester` and open `#stationing`. The acceptance suites run without it.
