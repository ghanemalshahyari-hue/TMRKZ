-- Fingerprints of records that an application upgrade must preserve, restricted to the columns that existed before
-- the upgrade (new columns added by a migration do not change the fingerprint). One line per table:
-- name|row count|md5 of the rows ordered by their text form. Used by ops/upgrade-check.sh.
select 'organization|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-')
  from (select id, code, name, parent_id, status, valid_from from organization) t
union all select 'person|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-')
  from (select id, employee_no, display_name, username, status from person) t
union all select 'membership|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from membership t
union all select 'site|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-')
  from (select id, code, name, kind, parent_id, status, capacity, lat, lng, created_at, version from site) t
union all select 'site_responsibility|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from site_responsibility t
union all select 'site_geometry_version|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-')
  from (select id, site_id, version, geojson, crs, source, valid_from, valid_to, created_at from site_geometry_version) t
union all select 'resource|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from resource t
union all select 'request_type|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-')
  from (select code, name, kind, multi_sites, multi_orgs, sort_order, active from request_type) t
union all select 'request|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from request t
union all select 'request_resource|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from request_resource t
union all select 'request_revision|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from request_revision t
union all select 'decision|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from decision t
union all select 'approval_document|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from approval_document t
union all select 'reservation|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from reservation t
union all select 'reservation_lock|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from reservation_lock t
union all select 'reservation_change|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from reservation_change t
union all select 'attachment|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from attachment t
union all select 'map_package|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-')
  from (select id, code, name, version, data_date, source, license, attribution_html, crs, min_lat, min_lng, max_lat, max_lng,
               format, local_path, content_sha256, status, installed_at from map_package) t;
