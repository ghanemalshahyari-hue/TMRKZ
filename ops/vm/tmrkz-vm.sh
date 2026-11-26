#!/bin/sh
# TMRKZ VM helper (ADR-107) — sent by CONNECT_VM.cmd into /data/tmrkz-incoming and run there over PAM (ssh -t).
# The PAM account is not root: every step that touches Docker or root-owned files runs through sudo (it asks for your
# password on the screen). Nothing here reads or changes .env, data/, certs/, backups/ or map data.
#
#   sh tmrkz-vm.sh state   <incoming> <app>    before sending: are these parts already whole in <app>? else = check <incoming>
#   sh tmrkz-vm.sh check   <incoming>          which image parts arrived whole (names the ones to send again)
#   sh tmrkz-vm.sh install <incoming> <app>    verified parts -> <app>; the old single tmrkz-images.tar is removed; a newer
#                                              start.sh replaces <app>'s (also when the parts were already there)
#   sh tmrkz-vm.sh cleanup <incoming>          after a good start: remove the old TMRKZ images no container uses
set -u
ACTION="${1:-}"
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
dock() { if docker info >/dev/null 2>&1; then docker "$@"; else as_root docker "$@"; fi; }
sums() { sha256sum -c "$1" 2>/dev/null; }
sum_of() { cat "$1" 2>/dev/null | tr -d '\r' | cut -c1-64; }   # the checksum in a .sha256 file, "" when there is none

case "$ACTION" in
state)
  # menu 2 sends only the checksums first and asks this: a run that broke off, or a second run, sends nothing already there
  IN="${2:?incoming folder}"; APP="${3:?TMRKZ folder}"
  want="$(sum_of "$IN/tmrkz-images.tar.sha256")"
  [ -n "$want" ] || { echo "MISSING $IN/tmrkz-images.tar.sha256"; exit 1; }
  if [ "$(sum_of "$APP/tmrkz-images.tar.sha256")" = "$want" ] && sh "$0" check "$APP" >/dev/null 2>&1; then
    echo "ALREADY INSTALLED - every part of this archive is whole in $APP: nothing to send"
    if [ "$(sum_of "$APP/ops/local/.generated/images-loaded.sha256")" = "$want" ]; then
      echo "  start.sh has already loaded these images"
    else
      echo "  start.sh has not loaded them yet: menu 3 does"
    fi
    exit 0
  fi
  exec sh "$0" check "$IN"
  ;;
check)
  IN="${2:?incoming folder}"; cd "$IN" || exit 1
  [ -f tmrkz-images.tar.parts.sha256 ] && [ -f tmrkz-images.tar.sha256 ] || { echo "MISSING tmrkz-images.tar.parts.sha256 / tmrkz-images.tar.sha256"; exit 1; }
  bad=0
  for p in $(tr -d '\r' < tmrkz-images.tar.parts.sha256 | awk '{print $2}' | tr -d '*'); do
    want="$(tr -d '\r' < tmrkz-images.tar.parts.sha256 | awk -v p="$p" '{n=$2; sub(/^\*/,"",n)} n==p{print $1}')"
    if [ ! -f "$p" ]; then echo "RESEND $p (missing)"; bad=1
    elif [ "$(sha256sum < "$p" | cut -c1-64)" != "$want" ]; then echo "RESEND $p ($(wc -c < "$p" | tr -d ' ') bytes, damaged)"; bad=1
    else echo "ok     $p"; fi
  done
  [ $bad = 0 ] || exit 3
  want="$(tr -d '\r' < tmrkz-images.tar.sha256 | cut -c1-64)"
  # shellcheck disable=SC2046
  got="$(cat $(tr -d '\r' < tmrkz-images.tar.parts.sha256 | awk '{print $2}' | tr -d '*') | sha256sum | cut -c1-64)"
  [ "$got" = "$want" ] || { echo "the parts are whole but do not join to tmrkz-images.tar.sha256 — send the whole set again"; exit 1; }
  echo "ALL PARTS OK — joined they match tmrkz-images.tar ($want)"
  ;;
install)
  IN="${2:?incoming folder}"; APP="${3:?TMRKZ folder}"
  [ -f "$APP/start.sh" ] || { echo "$APP is not the TMRKZ folder (no start.sh)"; exit 1; }
  # the parts: whole in <incoming> -> moved; already whole in <app> (an earlier run) -> left there; else nothing is changed
  move=1
  if ! sh "$0" check "$IN" >/dev/null 2>&1; then
    sh "$0" state "$IN" "$APP" 2>/dev/null | grep -q '^ALREADY INSTALLED' || { sh "$0" check "$IN" | grep -v '^ok'; exit 1; }
    move=0
  fi
  # a newer start.sh (it loads parts and checks the processor, ADR-107): also when the parts were already there
  new=0; [ -f "$IN/start.sh" ] && ! cmp -s "$IN/start.sh" "$APP/start.sh" && new=1
  if [ $move = 0 ] && [ $new = 0 ]; then
    rm -f "$IN/start.sh"; echo "DONE - the parts and start.sh are already in $APP, nothing changed: now start (menu 3)"; exit 0
  fi
  # the TMRKZ images in use now: «cleanup» removes exactly these once the new ones run (nothing else on the machine)
  [ $move = 0 ] || dock image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^tmrkz/' > "$IN/old-images.txt" || true
  echo "installing into $APP (as root) …"
  as_root sh -c '
    cd "$1" || exit 1
    if [ "$3" = 1 ]; then
      rm -f tmrkz-images.tar.part-* tmrkz-images.tar.parts.sha256
      if [ -f tmrkz-images.tar ]; then echo "  removing the old single image file tmrkz-images.tar ($(wc -c < tmrkz-images.tar | tr -d " ") bytes)"; rm -f tmrkz-images.tar; fi
      mv "$2"/tmrkz-images.tar.part-* "$2"/tmrkz-images.tar.parts.sha256 "$2"/tmrkz-images.tar.sha256 . || exit 1
    fi
    if [ "$4" = 1 ]; then
      b="backups/start.sh.before-$(date +%Y%m%d-%H%M%S)"
      mkdir -p backups && cp -p start.sh "$b" || { echo "  start.sh NOT updated: its backup could not be written"; exit 1; }
      cat "$2/start.sh" > start.sh && echo "  start.sh updated (the previous one kept as $b)"
    fi
    rm -f "$2/start.sh"
    ls -l tmrkz-images.tar.* | sed "s/^/  /"
  ' sh "$APP" "$IN" "$move" "$new" || exit 1
  echo "DONE — now start (menu 3): start.sh checks the parts again and loads them"
  ;;
cleanup)
  IN="${2:?incoming folder}"
  echo "TMRKZ images on this machine:"
  dock image ls --format '  {{.Repository}}:{{.Tag}}  {{.ID}}  {{.CreatedSince}}' | grep 'tmrkz/' || true
  # what containers use now (their image IDs), and the IDs of the three images TMRKZ runs
  used=" $(for c in $(dock ps -aq); do dock inspect -f '{{.Image}}' "$c"; done | sed 's/^sha256://' | cut -c1-12 | tr '\n' ' ') "
  keep=" $(for t in tmrkz/folder-backend:1 tmrkz/folder-web:1 tmrkz/keycloak:26.7.5-2; do dock image inspect -f '{{.Id}}' "$t" 2>/dev/null; done | sed 's/^sha256://' | cut -c1-12 | tr '\n' ' ') "
  # 1. TMRKZ tags the folder does not run (e.g. tmrkz/folder-backend:1.2-pgrestore)
  for t in $(dock image ls --format '{{.Repository}}:{{.Tag}}' | grep '^tmrkz/' | grep -vxE 'tmrkz/folder-backend:1|tmrkz/folder-web:1|tmrkz/keycloak:26.7.5-2'); do
    id="$(dock image inspect -f '{{.Id}}' "$t" | sed 's/^sha256://' | cut -c1-12)"
    case "$used" in *" $id "*) echo "  kept $t (a container uses it)"; continue ;; esac
    dock image rm "$t" >/dev/null && echo "  removed $t"
  done
  # 2. the images TMRKZ ran before «install» (old-images.txt), now replaced and unused
  if [ -f "$IN/old-images.txt" ]; then
    for id in $(awk '{print $2}' "$IN/old-images.txt" | sed 's/^sha256://' | cut -c1-12 | sort -u); do
      case "$keep$used" in *" $id "*) continue ;; esac
      dock image rm "$id" >/dev/null 2>&1 && echo "  removed the replaced image $id"
    done
  fi
  echo "now:"; dock image ls --format '  {{.Repository}}:{{.Tag}}  {{.ID}}' | grep 'tmrkz/' || true
  ;;
*) echo "usage: sh tmrkz-vm.sh check <incoming> | install <incoming> <app> | cleanup <incoming>"; exit 2 ;;
esac
