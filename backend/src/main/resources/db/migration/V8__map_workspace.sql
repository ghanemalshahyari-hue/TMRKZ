-- Administrative map workspace (docs/MAP_WORKSPACE_COMPLETION_AR.md, ADR-017).
-- PostGIS stores site boundaries as geometry in EPSG:4326 with x = longitude and y = latitude (GeoJSON order).
-- Existing sites, reservations and their history are kept as they are: legacy point records stay points and are never
-- turned into assumed areas. A site's display marker (site.lat/lng) is separate from its registered boundary.

create extension if not exists postgis;

-- Display marker as an indexed point (derived from the stored coordinates, never a boundary).
alter table site add column marker geometry(Point, 4326)
  generated always as (case when lat is not null and lng is not null then ST_SetSRID(ST_MakePoint(lng, lat), 4326) end) stored;
create index site_marker_idx on site using gist (marker);

-- Boundary versions: normalised geometry plus provenance of the original input.
alter table site_geometry_version
  add column geom              geometry(Geometry, 4326),
  add column geometry_type     text,
  add column original_format   text,
  add column original_crs      text,
  add column original_content  text,
  add column original_sha256   text,
  add column source_file_name  text,
  add column transform         text,
  add column reason            text,
  add column created_by        uuid references person(id),
  add column import_job_id     uuid;

-- One-time backfill of the new columns on existing rows; the append-only guard is restored immediately after.
alter table site_geometry_version disable trigger site_geometry_append_only;
update site_geometry_version set
  geom = case when crs = 'EPSG:4326' then ST_SetSRID(ST_GeomFromGeoJSON(geojson::text), 4326) end,
  geometry_type = geojson ->> 'type',
  original_format = 'LEGACY',
  original_crs = crs,
  original_content = geojson::text,
  transform = 'لا تحويل (سجل سابق بنظام ' || crs || ')';
alter table site_geometry_version enable trigger site_geometry_append_only;

alter table site_geometry_version alter column geometry_type set not null;
alter table site_geometry_version add constraint site_geometry_type_check
  check (geometry_type in ('Point', 'Polygon', 'MultiPolygon'));
alter table site_geometry_version add constraint site_geometry_matches_type
  check (geom is null or GeometryType(geom) = upper(geometry_type));
create index site_geometry_geom_idx on site_geometry_version using gist (geom);

-- Rows inserted without the new columns (older tooling) still get a type and, for EPSG:4326 input, a geometry.
create function site_geometry_fill() returns trigger language plpgsql as $$
begin
  if new.geometry_type is null then new.geometry_type := new.geojson ->> 'type'; end if;
  if new.geom is null and new.crs = 'EPSG:4326' then new.geom := ST_SetSRID(ST_GeomFromGeoJSON(new.geojson::text), 4326); end if;
  return new;
end $$;
create trigger site_geometry_fill before insert on site_geometry_version for each row execute function site_geometry_fill();

-- Current geometry version of each site (the latest published one). Publishing compares and sets it under a row lock,
-- so a save based on an older version is refused instead of overwriting a newer one.
alter table site add column geometry_version int;
update site s set geometry_version = g.v from (select site_id, max(version) as v from site_geometry_version group by site_id) g
where g.site_id = s.id;
alter table site add constraint site_geometry_version_fk foreign key (id, geometry_version)
  references site_geometry_version(site_id, version) deferrable initially deferred;

-- Boundary imports: preview with a report first; nothing is published until an authorised publish of the whole job.
create table map_import_job (
  id               uuid primary key,
  file_name        text not null,
  format           text not null check (format in ('GEOJSON', 'KML')),
  declared_crs     text,
  effective_crs    text,
  status           text not null check (status in ('PREVIEWED', 'REJECTED', 'PUBLISHED', 'CANCELLED')),
  report           jsonb not null,
  candidates       jsonb not null default '[]',
  original_sha256  text not null,
  original_content text,
  target_site_id   uuid references site(id),
  created_by       uuid not null references person(id),
  created_at       timestamptz not null default now(),
  decided_by       uuid references person(id),
  decided_at       timestamptz,
  reason           text
);
create index map_import_job_creator_idx on map_import_job(created_by, created_at desc);
alter table site_geometry_version add constraint site_geometry_import_fk foreign key (import_job_id) references map_import_job(id);

-- Map packages: review before activation, background kind, zoom range, built-in or managed storage.
alter table map_package drop constraint if exists map_package_format_check;
alter table map_package add constraint map_package_format_check check (format in ('SVG_OVERLAY', 'RASTER_IMAGE', 'GEOJSON'));
alter table map_package drop constraint if exists map_package_status_check;
alter table map_package add constraint map_package_status_check
  check (status in ('PENDING_REVIEW', 'ACTIVE', 'DISABLED', 'REJECTED', 'RETIRED'));
alter table map_package
  add column role               text not null default 'overlay' check (role in ('overlay', 'source')),
  add column kind               text not null default 'ROADS' check (kind in ('ROADS', 'AERIAL', 'FACILITY_PLAN', 'SOURCE_DATA')),
  add column min_zoom           numeric(4, 1),
  add column max_zoom           numeric(4, 1),
  add column storage            text not null default 'BUILTIN' check (storage in ('BUILTIN', 'MANAGED')),
  add column manifest           jsonb,
  add column uploaded_by        uuid references person(id),
  add column status_changed_by  uuid references person(id),
  add column status_changed_at  timestamptz,
  add column status_reason      text;
update map_package set role = 'source', kind = 'SOURCE_DATA' where format = 'GEOJSON';

-- Whether a reservation request type allows open-ended use (no end until an approved administrative action ends it).
alter table request_type add column open_end_allowed boolean not null default true;
