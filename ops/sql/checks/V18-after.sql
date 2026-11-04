-- V18 (ADR-031) after-migration checks: the Stationing foundation objects exist, start empty (nothing existing is
-- reinterpreted or copied into them), and carry their guards.
select 'tables=' || count(*) from information_schema.tables
 where table_schema = 'public' and table_name in ('stationing_policy_version', 'org_stationing', 'site_link', 'stationing_outbox',
                                                  'terrain_dataset', 'terrain_slope');
select 'rows=' || ((select count(*) from stationing_policy_version) + (select count(*) from org_stationing)
                 + (select count(*) from site_link) + (select count(*) from stationing_outbox)
                 + (select count(*) from terrain_dataset) + (select count(*) from terrain_slope));
select 'postgis_raster=' || coalesce((select extversion from pg_extension where extname = 'postgis_raster'), 'missing');
select 'append_only_trigger=' || count(*) from pg_trigger where tgname = 'stationing_policy_version_frozen';
select 'overlap_exclusion=' || count(*) from pg_constraint where conname = 'org_stationing_no_overlap' and contype = 'x';
select 'legacy_relocation_rows_unchanged=' || (select count(*) from request_relocation) || '/' || (select count(*) from placement_rule);
select 'mismatches=' || ((select case when count(*) = 6 then 0 else 1 end from information_schema.tables
                           where table_schema = 'public' and table_name in ('stationing_policy_version', 'org_stationing', 'site_link',
                                 'stationing_outbox', 'terrain_dataset', 'terrain_slope'))
                       + (select count(*) from stationing_policy_version) + (select count(*) from org_stationing)
                       + (select count(*) from stationing_outbox));
