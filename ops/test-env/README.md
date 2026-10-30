# Acceptance test environment (fictional data only)

This environment exists only to run the real sign-in path and the journeys end to end. A production deployment never
contains it: there is no demo mode, no user switch and no local password form in TMRKZ.

```sh
sh ops/test-env/up.sh                 # builds and starts TMRKZ + Keycloak + a fictional OpenLDAP, then seeds data
cat ops/test-env/.generated/user-password
```

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
