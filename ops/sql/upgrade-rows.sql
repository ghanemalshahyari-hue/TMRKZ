-- Per-row hashes of the records an upgrade must preserve, restricted to the columns that existed before the upgrade.
-- Output: table|primary key|md5(row). ops/upgrade-check.sh requires every line taken before the upgrade to be present
-- unchanged afterwards (rows added afterwards are allowed).
select 'organization|' || id || '|' || md5(t::text) from (select id, code, name, parent_id, status, valid_from from organization) t
union all select 'person|' || id || '|' || md5(t::text) from (select id, employee_no, display_name, username, status from person) t
union all select 'membership|' || id || '|' || md5(t::text) from membership t
union all select 'site|' || id || '|' || md5(t::text) from (select id, code, name, kind, parent_id, status, capacity, lat, lng, created_at, version from site) t
union all select 'site_responsibility|' || id || '|' || md5(t::text) from site_responsibility t
union all select 'site_geometry_version|' || id || '|' || md5(t::text)
  from (select id, site_id, version, geojson, crs, source, valid_from, valid_to, created_at from site_geometry_version) t
union all select 'resource|' || id || '|' || md5(t::text) from resource t
union all select 'request_type|' || code || '|' || md5(t::text) from (select code, name, kind, multi_sites, multi_orgs, sort_order, active from request_type) t
union all select 'request|' || id || '|' || md5(t::text) from request t
union all select 'request_resource|' || request_id || ':' || resource_id || '|' || md5(t::text) from request_resource t
union all select 'request_revision|' || id || '|' || md5(t::text) from request_revision t
union all select 'decision|' || id || '|' || md5(t::text) from decision t
union all select 'approval_document|' || id || '|' || md5(t::text) from approval_document t
union all select 'reservation|' || id || '|' || md5(t::text) from reservation t
union all select 'reservation_lock|' || id || '|' || md5(t::text) from reservation_lock t
union all select 'reservation_change|' || id || '|' || md5(t::text) from reservation_change t
union all select 'attachment|' || id || '|' || md5(t::text) from attachment t
union all select 'audit_event|' || id || '|' || md5(t::text) from audit_event t
union all select 'map_package|' || id || '|' || md5(t::text)
  from (select id, code, name, version, data_date, source, license, attribution_html, crs, min_lat, min_lng, max_lat, max_lng,
               format, local_path, content_sha256, status, installed_at from map_package) t
order by 1;
