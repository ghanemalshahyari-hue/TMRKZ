# TMRKZ — final delivery acceptance report (25 Nov 2026, ADR-106)

**Status: delivered for VM acceptance — not production-accepted.** Nothing has been applied to the real VM. Production
acceptance needs the VM checklist in the guide (sections 4–6) to pass on `/data/TMRKZ`.

| | |
|---|---|
| Code commit (`main`) | `9c280bff0df7a416f3f0d56e4e13a15f9e2d6c79` |
| Signed release | `20261125-102411-9c280bf` — 843 files, 18,734,627 bytes, built from a clean tree (`localChanges: false`) |
| Manifest SHA-256 | `b62d5c4af83fd636cc6ddf6ff125a1cfb09a420fbf5f3dfd47e72c171b32b5c8` |
| Signature | Ed25519, verified with the public key the VM receives (`release-trust.pub`) |
| Bootstrap package | `TMRKZ-bootstrap-20261125-102411-9c280bf.tar` (76 files changed since `e30c1c1`, 6.4 MB) for a VM at `e30c1c1` |
| Guide | `TMRKZ_FINAL_DELIVERY_GUIDE.html` (Arabic, offline, screenshots embedded, no external resource) |

## The brief, item by item

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Verify the release | One folder, `main` only, one worktree, no branch; no tracked change left; signature and every checksum verified; no dependency file changed since `e30c1c1` (no new library); every Compose image present locally (no new image) | `release-verification.txt` |
| 2 | USB | One removable drive found (F:, «PRIVATE_USB», DL Sentry 5-M, FAT32); new folder, nothing deleted; package, guide, START_HERE.txt, checksums, this report, recovery, and the signed release files for the first browser update; secret review by name, place and content; every copied file verified on the USB against its source hash | `SHA256SUMS.txt` on the USB |
| 3 | Illustrated offline guide | Arabic, English commands kept exact; every step from the development PC to the Windows desktop, PAM and the offline VM | `3_GUIDE/` |
| 4 | VM layout | The bootstrap places every differing VM file (as at `e30c1c1`, an earlier committed version, or changed on the VM), stops before replacing a hand edit, never writes the database, maps, certificates, `.env`, generated keys or `docker-compose.dc-hosts.yml` | `bootstrap-test.txt` (13/13), `bootstrap-check-sample.txt`, rehearsal in `release-verification.txt` |
| 5 | FYI inconsistency | `fyi_main_command` authoritative (the one the screen writes, audits and the migration centre carries); V69 copies `fyi_designation` rows (kept, superseded); UI and notification read the same source | `FYI-RESOLUTION.md` |
| 6 | 20 backend failures | 11 obsolete expectations of documented design changes, 9 fixture or measurement defects, 0 application defects; nothing deleted, skipped or loosened; three scope assertions strengthened | `REMAINING-20.md`, `remaining-20-run.txt` |
| 7 | Final report | This file, START_HERE.txt | — |

Owner requests the same day, delivered: deployment areas stop at their farthest allowed distance (with the terrain
allowance); a site setup boundary above the policy's maximum footprint is refused; pages no longer choose or move by themselves.

## Tests run for this delivery

| Suite | Result |
|---|---|
| `SiteSetupFootprintIT`, `SiteSetupIT` | 2/2, 9/9 |
| `FyiConfigurationIT`, `StationingNextIT`, `RestationingWorkflowIT`, migration ITs (`DbMigrationIT`, `V17MigrationIT`, `V47MigrationIT`), `WorkflowGraphIT#forInformationByPlace` | 4/4, 14/14, 17/17, 3/3, 1/1 |
| The seven classes of the 20 formerly failing tests | every test passed; last combined run 66/67 — the posture gate hit an OpenFGA time-out (503) while another project saturated the Docker VM, and passed in the run before |
| Frontend unit tests, type check, production build | 415/415 (59 files), clean |
| `bootstrap-test.sh` (Git Bash) and the same package under dash/mawk/openssl (Ubuntu noble container, no network) | 13/13; check read-only, stop, `--keep-local`, baseline, exact restore |
| Final package rehearsal on a clean `e30c1c1` copy | 0 hand edits, 48 replaced + 28 added, 0 left differing |
| Read-only browser probe on the development installation (no write) | areas: 25 km → 8.5 km, 22 km → 5.5 km (undulating ground), free drawing and drag stopped; requests open at step 1 |

**Not re-run on the final tree (owner: skip — another project occupied the Docker VM):** the full backend suite, and the
three browser suites (`update-center.mjs`, `release-acceptance.mjs`, `ui-regression.mjs`; their last results, 33/33, 40/40,
48/48, are from the ADR-105 runs earlier the same day). Run them when the Docker VM is free:
`sh ops/test-backend.sh`, then `sh tests/acceptance/update-center/setup.sh <dir>` and the three suites.

## Open

- Real-VM acceptance (bootstrap check and apply, first browser update, certificates, import, administrator lookup).
- The posture reach confirms each reached unit with OpenFGA one by one: ~0.2 s at 100 units, 1.6 s at 1,000, 9 s at 5,000 on
  the development machine — owner's decision on a batch confirmation.
- «الجهات الرئيسية للعلم» managed by a unit-scoped access manager (V64's B3) not built: it widens who can change the list.
- A Compose change needs `docker compose up -d` by the operator; files over 24 MB and new npm libraries are not delivered
  through the browser.
