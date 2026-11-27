#!/usr/bin/env bash
# Stand-in for scp in the VM_CONSOLE.cmd test: `scp [-r] -P PORT SRC... DEST`. DEST "LOGIN:" = the VM account's home
# (/root in the test VM container $VMC); a SRC "LOGIN:/path" is copied back from the VM.
export MSYS_NO_PATHCONV=1
args=(); while [ $# -gt 0 ]; do case "$1" in -r) ;; -P) shift ;; *) args+=("$1") ;; esac; shift; done
dest=${args[-1]}; unset 'args[-1]'
echo "[fake scp] ${args[*]} -> $dest" >> "$WORK/scp-calls.log"
for src in "${args[@]}"; do
    case "$src" in
        *:/*) docker cp "$VMC:/${src#*:/}" "$dest" || exit 1 ;;
        *) case "$dest" in *:) docker cp "$src" "$VMC:/root/" || exit 1 ;; *) exit 2 ;; esac ;;
    esac
done
