# ADR-107 evidence — Linux images, image parts, start diagnostics, «permission denied»

- `pack-images.log` — `sh ops/local/workspace/pack-images.sh` on the development PC (26 Nov 2026): both images build the folder's
  source with no network, `pg_restore (PostgreSQL) 17.12`, every image `linux/amd64`, `tmrkz-images.tar` 1,052,575,232 bytes,
  sha256 `614bed635cb3c7b526b816d6d742cf85bd0b5817a22c9ff139254af623970990`.
- `run1-repo-tree/` — `tests/acceptance/vm-sim/vmsim.sh` (first version) on the working tree: 12 of 12.
- `run2-usb/`, `run2-usb.out` — the same simulation on exactly what the USB delivers:
  `F:\TMRKZ_FINAL_20261125_9c280bf\2_FIRST_BROWSER_UPDATE\TMRKZ` (signed release `20261126-025729-134ed77-local`) and the 11 parts
  of `F:\TMRKZ_FINAL_20261125_9c280bf\0_IMAGES_IF_NEEDED`, plus the USB helper (`ops/vm/tmrkz-vm.sh` check, install, cleanup).
- `IMAGES_MANIFEST.txt` — the packaging manifest the VM deployment report asked for (26 Nov), read from the 11 USB parts
  themselves: target platform, every tag with its ID for both Docker storages, build date, source/release, the old arm64
  IDs seen on the VM, and the report's own load-and-inspect check adapted to the parts. Same file in the USB's
  `0_IMAGES_IF_NEEDED`. The Keycloak image (16 Nov, from `ops/keycloak/Dockerfile`) carries an older realm import file than
  the repository; `keycloak-setup` applies the current sign-in page and password client on every start, shown by T4's fresh
  sign-in.

The simulated VM: Docker 29.10.1 in a privileged DinD container on an internal network with no route out (checked), GNU tools
and sudo like the VM, the TMRKZ folder owned by a non-root «PAM» account, `.env` owned by root. Fictional only: no data, the
secrets are generated on the spot, everything created in Docker is removed at the end.

Not shown here: the real VM. Whether PAM lets the USB connector run commands with `ssh -t` is unknown until the owner tries it;
the same steps by hand are in the USB's `0_COMMANDS.txt`.
