-- The PostGIS image's first start creates its extensions and the tiger and topology schemas in a NEW empty database. A dump of
-- a TMRKZ database holds those objects too, so pg_restore --exit-on-error stops on the first "already exists". Run this on the
-- freshly initialised, empty database before restoring: the dump then recreates them as they were. It refuses a database that
-- already holds TMRKZ tables, so it can never touch a live installation.
\set ON_ERROR_STOP on
do $$
begin
  if to_regclass('public.flyway_schema_history') is not null then
    raise exception 'refused: this database already holds TMRKZ data; a restore targets an empty database only';
  end if;
end $$;
drop extension if exists postgis_tiger_geocoder cascade;
drop extension if exists postgis_topology cascade;
drop extension if exists fuzzystrmatch cascade;
drop extension if exists postgis_raster cascade;
drop extension if exists postgis cascade;
drop schema if exists tiger cascade;
drop schema if exists tiger_data cascade;
drop schema if exists topology cascade;
