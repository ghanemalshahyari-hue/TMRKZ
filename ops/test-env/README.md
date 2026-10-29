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

All users share the password in `ops/test-env/.generated/user-password`. The directory administrator password and the
test CA are also there. Everything under `.generated/` is git-ignored and is regenerated if deleted. To stop, run
`docker compose -p tmrkz-test -f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml down` (add `-v` to delete the data).

The organisations, people and facilities are fictional and illustrative; they do not describe any real site.
