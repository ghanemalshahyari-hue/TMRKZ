# TMRKZ ADR-102 — Full Process Report

**Date:** 24 November 2026  
**Commit:** `78ac0a3` (main, pushed)  
**AirGap:** `tmrkz-images.tar` (1.1 GB, all 7 images)

---

## What was delivered

### 1. CLI Recovery Engine — `ops/tmrkzctl.sh`
Eight modes for server recovery and diagnostics:
- **doctor** — 21 checks (Docker Compose, images, source mounts, `.env`, persistent dirs, map packages, port conflicts, disk space, DB health, schema version, TLS, trust store, service health, caches, images tar)
- **setup** — guided first-time installation
- **status** — running services and health
- **verify** — end-to-end application verification
- **update** — validates update bundle, creates pre-update backup, staged extract, restart with health wait
- **rollback** — restore from a named backup
- **backup** — full backup of DB + configuration
- **inventory** — list images, volumes, ports

All 21 doctor checks PASS on the development machine.

### 2. Management Center (Browser UI)
New section in settings page «مركز إدارة النظام» (CONFIGURE-gated):
- System status cards (organisations, people, requests, sites, schema version)
- TLS certificate info (subject, issuer, expiry, SAN)
- Embedding allowlist CRUD (add/remove `https://host[:port]` origins)
- Backup information
- CLI emergency command reference

### 3. Embedding Allowlist
- `system_setting` table (V68 migration)
- `PUT /system/embedding` — save origins (audit-logged, strict validation)
- `GET /system/embedding` — read current origins
- `GET /system/embedding/csp` — public text/plain for nginx consumption
- `ops/local/workspace/gen-csp-embedding.sh` — generates nginx include

### 4. AI Conversation Context
- Backend `AssistantService` builds bounded conversation with up to 6 prior turns
- Frontend `FloatingAssist` accumulates completed turns and sends them
- The assistant remembers what was discussed in the current session

### 5. GIS Cursor Alignment Fix
- **Root cause:** `html { zoom: 0.9 }` in `prototype.css` causes MapLibre/Leaflet to miscalculate pointer position
- **Fix:** counter-zoom `.maplibregl-map, .leaflet-container { zoom: calc(1 / 0.9); }` in `map.css`
- `prototype.css` is NOT modified (per CLAUDE.md constraint)

### 6. Administrator Lifecycle
- List/add/remove system administrators from settings page
- Add by username lookup (directory-aware)
- Self-escalation, duplicates and last-admin removal prevented
- Backend: `OrganizationService.listAdministrators/addAdministrator/removeAdministrator`
- Frontend: `AdminLifecycle.tsx` in `SettingsPage.tsx`

### 7. Arabic Documentation
| File | Content |
|------|---------|
| `docs/ADMIN_UI_QUICK_START_AR.md` | Admin UI quick-start guide |
| `docs/VM_BOOTSTRAP_AR.md` | VM bootstrap from scratch |
| `docs/VM_QUICK_START_AR.md` | VM quick-start for updates |
| `docs/VM_RUNBOOK.md` | Operations runbook |

---

## Files changed (22 files, +1865 lines)

### New files (9)
| File | Purpose |
|------|---------|
| `ops/tmrkzctl.sh` | CLI recovery engine |
| `ops/local/workspace/gen-csp-embedding.sh` | nginx CSP generator |
| `backend/src/main/resources/db/migration/V68__system_setting.sql` | system_setting table |
| `frontend/src/components/ManagementCenter.tsx` | Management Center UI |
| `frontend/src/components/AdminLifecycle.tsx` | Admin lifecycle UI |
| `docs/ADMIN_UI_QUICK_START_AR.md` | Arabic admin guide |
| `docs/VM_BOOTSTRAP_AR.md` | Arabic VM bootstrap |
| `docs/VM_QUICK_START_AR.md` | Arabic VM quick start |
| `docs/VM_RUNBOOK.md` | Operations runbook |

### Modified files (13)
| File | Change |
|------|--------|
| `backend/.../SystemController.java` | Management, embedding endpoints |
| `backend/.../SessionFilter.java` | CSP endpoint in PUBLIC set |
| `backend/.../AssistantController.java` | History in AskInput |
| `backend/.../AssistantService.java` | Bounded conversation builder |
| `backend/.../OrgController.java` | Administrator CRUD endpoints |
| `backend/.../OrganizationService.java` | Administrator logic |
| `frontend/src/api/client.ts` | Management, embedding, admin API methods |
| `frontend/src/api/types.ts` | SystemManagement type |
| `frontend/src/components/assist/FloatingAssist.tsx` | History accumulation |
| `frontend/src/pages/SettingsPage.tsx` | Management Center + Admin Lifecycle |
| `frontend/src/styles/map.css` | GIS counter-zoom |
| `docs/STATUS.md` | ADR-102 section |
| `docs/TRACEABILITY.md` | ADR-102 entries |

---

## Test results

| Suite | Result |
|-------|--------|
| AuthorizationIT | 10/10 |
| IntegrationSettingsIT | 2/2 |
| AdministrationAcceptanceIT | 8/8 |
| OracleAbsenceIT | 2/2 |
| DbMigrationIT | 1/1 |
| Frontend (vitest) | 405/405 |
| Frontend type check | Clean |
| Frontend build | Clean |
| `tmrkzctl.sh doctor` | 21/21 PASS |
| App health on :8088 | UP |

---

## Transfer to the VM

### Which folder
`~/Desktop/TMRKZ/` — the whole folder.

### What to exclude
`data/`, `backups/`, `.git/`, `node_modules/`, `frontend/node_modules/`

### No new images needed
All 7 Docker images are unchanged. The existing `tmrkz-images.tar` on the VM works as-is.

### Steps

**On this Mac:**
```bash
cd ~/Desktop
tar czf TMRKZ-update-20261124.tar.gz \
  --exclude='TMRKZ/data' \
  --exclude='TMRKZ/backups' \
  --exclude='TMRKZ/.git' \
  --exclude='TMRKZ/node_modules' \
  --exclude='TMRKZ/frontend/node_modules' \
  TMRKZ/
```

Transfer via PAM (port 4422):
```bash
scp -P 4422 TMRKZ-update-20261124.tar.gz user@server:/tmp/
```

**On the VM:**
```bash
# 1. Backup first
cd /opt/tmrkz
sh ops/tmrkzctl.sh backup

# 2. Stop
docker compose stop

# 3. Extract over existing folder
cd /opt
tar xzf /tmp/TMRKZ-update-20261124.tar.gz

# 4. Start
cd /opt/tmrkz
sh start.sh

# 5. Verify
sh ops/tmrkzctl.sh doctor
sh ops/tmrkzctl.sh verify
```

### What happens automatically
1. **V67 + V68 migrations** — Flyway applies `V67__organization_level.sql` and `V68__system_setting.sql`
2. **Backend rebuild** — first start recompiles; subsequent restarts reuse the build (ADR-099)
3. **Frontend rebuild** — web container builds from updated sources

### Verification checklist
- [ ] `sh ops/tmrkzctl.sh doctor` — all PASS
- [ ] Sign in works
- [ ] Settings → «مركز إدارة النظام» shows system status
- [ ] Settings → «مديرو النظام» shows administrators
- [ ] The AI assistant remembers context from the same session
- [ ] Map click places the menu at the pointer position
- [ ] Directory → unit management works (create, rename, reparent)

---

## Git history

```
78ac0a3 docs: VM transfer process for ADR-099 through ADR-102
a3832f5 docs: add VM_RUNBOOK.md reference to STATUS.md and TRACEABILITY.md
ab8519a docs: ADR-101 and ADR-102 entries in ARCHITECTURE_DECISIONS.md
33dc7b6 CLI recovery, Management Center, AI context, GIS cursor, admin lifecycle, embedding allowlist, Arabic docs (ADR-102)
3014677 docs: STATUS.md and TRACEABILITY.md entries for ADR-101
79cf308 Unit management, level management, employee number admin, screen transitions, Oracle absence proof (ADR-101)
65f0e92 Directory sign-in never needs a service account; Active Directory's own names are accepted (ADR-100)
982045e A small server: background tabs ask nothing, a restart does not rebuild (ADR-099)
```

All pushed to `main` on GitHub.
