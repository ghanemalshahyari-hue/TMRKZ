# VM console and MOVER speed report — evidence (27 Nov 2026)

The USB's shared console (`VM_CONSOLE.cmd`, in `F:\MOVER_FINAL_20261126_d27e5fe7` and `F:\DUTY_FINAL_20261126_3f9d898`) and
MOVER's VM helper (`0_UPDATE_TOOL\vm-tools\mover-vm.sh`) were checked on this PC. Fictional stand-ins only: no data, no VM.

## `run1/`, `run1.out` — the VM helper on a stand-in VM: 40 of 40

`bash tests/acceptance/vm-console/run-speed-tests.sh <mover-vm.sh> <evidence>`: a `python:3.12-slim` container (dash as
`/bin/sh`, mawk, as on the Ubuntu VMs); `fake-docker.sh` plays MOVER's compose project, `fake-mover.py` its web and TLS
proxy with adjustable delays, and a `/proc/stat` pipe gives the CPU sample two readings. Each scenario sets one cause up
and checks that `speedreport` names it first, or that `speedfix` repairs it:
healthy (no cause invented), web connection-limit stall, full CPU (names the biggest container), VMware steal, disk wait,
slow readiness/database, slow network between PC and server, slow TLS proxy, stuck web threads, the page-profile table
(queue-heavy and SQL-heavy routes), «server busy» refusals, «database is locked», errors, 5xx, restarts; speedfix on a
stall, on a stuck web, and on a healthy web (left alone); web down. No log line or client address is ever printed.

## `console/`, `console.out` — the real console on Windows: 24 of 24

`bash tests/acceptance/vm-console/run-console-test.sh <kit> <evidence>`: a working copy of the kit (nothing written on the
USB), `VM_CONSOLE.cmd` run by cmd.exe with stand-in ssh/scp (`fake-ssh.sh`, `fake-scp.sh`) reaching a test VM container
whose fake proxy is published on 127.0.0.1:19443, so menu P really times the app from this PC with curl.exe.
H (helpers sent from `0_UPDATE_TOOL\vm-tools`), P (report saved in the kit's `REPORTS\`, stall named first, PC timings in
it, the scratch timing file removed), W (stall fixed), P again (stall gone); and every menu that had a bracket inside an
`if ( … )` message — 2, I, F, 4, 6, 1 for MOVER, 2 and 4 for DUTY — now runs to its end with no cmd.exe error.

Found and fixed by these runs: H, 2, I and F stopped cmd.exe at once («. was unexpected at this time» / «The syntax of the
command is incorrect»); H and 2 looked for the helpers in `vm-tools\` beside the console instead of `0_UPDATE_TOOL\vm-tools\`.

Not shown here: the real VMs, real PAM and sudo prompts, real MOVER containers.
