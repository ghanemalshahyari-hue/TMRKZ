#!/usr/bin/env sh
# Removes the HR people an installation copied before ADR-065 that are neither linked nor referenced (ops/hr-prune-unlinked.sql).
# A dry run by default: it prints counts and changes nothing. Run --apply only after a verified backup.
# Usage: ops/hr-prune-unlinked.sh [--apply] [compose-project]       (compose project: tmrkz-mover by default)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
APPLY=off
if [ "${1:-}" = "--apply" ]; then
  APPLY=on
  shift
fi
PROJECT="${1:-tmrkz-mover}"
echo "HR prune on compose project '$PROJECT': $([ "$APPLY" = on ] && echo 'APPLY (deletes)' || echo 'dry run (counts only)')"
docker compose -p "$PROJECT" exec -T -e PGOPTIONS="-c tmrkz.prune_apply=$APPLY" db \
  psql -U mover -d mover -v ON_ERROR_STOP=1 -q -At -F ' ' -f - < ops/hr-prune-unlinked.sql
