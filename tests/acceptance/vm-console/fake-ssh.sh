#!/usr/bin/env bash
# Stand-in for ssh in the VM_CONSOLE.cmd test: `ssh [-t] -p PORT LOGIN COMMAND` runs COMMAND in the test VM container ($VMC)
# as its PAM account would (a `sudo` there just runs the command).
export MSYS_NO_PATHCONV=1
cmd=${!#}
echo "[fake ssh] $cmd" >> "$WORK/ssh-calls.log"
# no -i: the console's own input (the answers typed in) must stay with the console
docker exec "$VMC" sh -c "cd /root && $cmd" < /dev/null
