#!/usr/bin/env sh
# Sourced by up.sh and up-offline.sh before they rebuild the backend (owner decision of 4 Nov 2026: rebuilding the
# acceptance environment applies pending migrations, so check the migration gate first). When the acceptance database
# exists and the migrations in the working tree are ahead of its Flyway history, the rebuild is refused unless
# TMRKZ_APPLY_MIGRATIONS names exactly the pending versions, e.g. TMRKZ_APPLY_MIGRATIONS="18". A new, empty environment
# (no database container yet) has no data to protect and is allowed. Uses: $P (compose project, default tmrkz-test).
P="${P:-tmrkz-test}"
if docker inspect -f '{{.State.Running}}' "$P-db-1" 2>/dev/null | grep -q true; then
  APPLIED="$(docker exec "$P-db-1" psql -U mover -d mover -At -c \
    "select version from flyway_schema_history where success and version is not null" 2>/dev/null | sort -n | tr '\n' ' ')"
  PENDING=""
  for f in backend/src/main/resources/db/migration/V*__*.sql; do
    v="$(basename "$f")"; v="${v#V}"; v="${v%%__*}"
    case " $APPLIED " in *" $v "*) ;; *) PENDING="$PENDING $v";; esac
  done
  PENDING="$(echo $PENDING | tr ' ' '\n' | sort -n | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$PENDING" ] && [ "${TMRKZ_APPLY_MIGRATIONS:-}" != "$PENDING" ]; then
    echo "[migration-gate] REFUSED: rebuilding $P would apply migration(s) [$PENDING] to its database" >&2
    echo "[migration-gate] (Flyway history ends at $(echo "$APPLIED" | tr ' ' '\n' | sort -n | tail -1))." >&2
    echo "[migration-gate] Verify the path first (ops/verify-migration-path.sh), take a backup (ops/backup.sh $P), then" >&2
    echo "[migration-gate] re-run with TMRKZ_APPLY_MIGRATIONS=\"$PENDING\"." >&2
    exit 3
  fi
  [ -n "$PENDING" ] && echo "[migration-gate] applying [$PENDING] to $P as explicitly requested"
fi
