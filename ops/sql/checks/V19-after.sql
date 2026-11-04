-- V19 (ADR-033) after-migration checks: the re-stationing request objects exist and start empty, org_stationing gains
-- its request foreign key, and nothing earlier is reinterpreted (the V18 foundation tables keep their rows).
select 'tables=' || count(*) from information_schema.tables
 where table_schema = 'public' and table_name in ('restationing_request', 'restationing_stage', 'restationing_revision', 'deployment_area');
select 'rows=' || ((select count(*) from restationing_request) + (select count(*) from restationing_stage)
                 + (select count(*) from restationing_revision) + (select count(*) from deployment_area));
select 'sequence=' || count(*) from pg_class where relkind = 'S' and relname = 'restationing_request_no';
select 'request_fk=' || count(*) from pg_constraint where conname = 'org_stationing_request_fk' and contype = 'f';
select 'v18_rows=' || ((select count(*) from stationing_policy_version) + (select count(*) from org_stationing)
                     + (select count(*) from site_link) + (select count(*) from stationing_outbox)
                     + (select count(*) from terrain_dataset));
select 'mismatches=' || ((select case when count(*) = 4 then 0 else 1 end from information_schema.tables
                           where table_schema = 'public' and table_name in ('restationing_request', 'restationing_stage',
                                 'restationing_revision', 'deployment_area'))
                       + (select count(*) from restationing_request) + (select count(*) from restationing_stage)
                       + (select count(*) from restationing_revision) + (select count(*) from deployment_area)
                       + (select case when count(*) = 1 then 0 else 1 end from pg_constraint where conname = 'org_stationing_request_fk'));
