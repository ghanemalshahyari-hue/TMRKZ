#!/bin/sh
# Creates the identity provider's and the authorisation service's own databases and roles once. Business data (mover),
# identity data (keycloak) and authorisation tuples (openfga) stay in separate databases with separate owners; re-running
# only re-applies the role passwords from the environment.
set -eu
export PGPASSWORD="$MOVER_DB_PASSWORD"
# The network may still be settling when this one-shot starts: wait for the server's name and port (up to a minute).
i=0
until pg_isready -h db -U mover -d mover >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -ge 30 ] && break; sleep 2
done
psql -h db -U mover -d mover -v ON_ERROR_STOP=1 -v kcpass="$TMRKZ_KEYCLOAK_DB_PASSWORD" -v fgapass="$TMRKZ_OPENFGA_DB_PASSWORD" <<'SQL'
select format('create role keycloak login password %L', :'kcpass')
 where not exists (select from pg_roles where rolname = 'keycloak') \gexec
select format('alter role keycloak password %L', :'kcpass') \gexec
select 'create database keycloak owner keycloak'
 where not exists (select from pg_database where datname = 'keycloak') \gexec
select format('create role openfga login password %L', :'fgapass')
 where not exists (select from pg_roles where rolname = 'openfga') \gexec
select format('alter role openfga password %L', :'fgapass') \gexec
select 'create database openfga owner openfga'
 where not exists (select from pg_database where datname = 'openfga') \gexec
SQL
echo "identity and authorisation databases ready"
