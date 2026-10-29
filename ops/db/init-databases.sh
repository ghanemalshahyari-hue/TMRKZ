#!/bin/sh
# Creates the identity provider's own database and role once. Business data (mover) and identity data (keycloak) stay
# in separate databases with separate owners; re-running only re-applies the role password from the environment.
set -eu
export PGPASSWORD="$MOVER_DB_PASSWORD"
psql -h db -U mover -d mover -v ON_ERROR_STOP=1 -v kcpass="$TMRKZ_KEYCLOAK_DB_PASSWORD" <<'SQL'
select format('create role keycloak login password %L', :'kcpass')
 where not exists (select from pg_roles where rolname = 'keycloak') \gexec
select format('alter role keycloak password %L', :'kcpass') \gexec
select 'create database keycloak owner keycloak'
 where not exists (select from pg_database where datname = 'keycloak') \gexec
SQL
echo "identity database ready"
