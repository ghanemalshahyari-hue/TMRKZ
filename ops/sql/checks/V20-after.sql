-- V20 (ADR-034) after-migration checks: the lifecycle objects exist, the unnamed activation check of V19 is replaced by
-- named constraints, and no earlier row gained a lifecycle value (no parent, lapse or held start; no action rows).
select 'action_table=' || count(*) from information_schema.tables where table_schema = 'public' and table_name = 'restationing_action';
select 'action_rows=' || count(*) from restationing_action;
select 'new_columns=' || count(*) from information_schema.columns
 where table_schema = 'public' and (table_name, column_name) in (('restationing_request', 'parent_request_id'),
       ('restationing_request', 'lapsed_at'), ('restationing_request', 'lapse_reason'), ('org_stationing', 'start_held_at'));
select 'named_constraints=' || count(*) from pg_constraint
 where conname in ('restationing_request_kind_check', 'restationing_request_state_check', 'restationing_request_activated_check',
                   'restationing_request_parent_check', 'restationing_request_lapse_check', 'org_stationing_held_check',
                   'org_stationing_end_reason_check');
select 'old_activation_check=' || count(*) from pg_constraint where conname = 'restationing_request_check3';
select 'lifecycle_values_on_earlier_rows=' || ((select count(*) from restationing_request where parent_request_id is not null or lapsed_at is not null)
                                               + (select count(*) from org_stationing where start_held_at is not null));
select 'mismatches=' || ((select case when count(*) = 1 then 0 else 1 end from information_schema.tables
                           where table_schema = 'public' and table_name = 'restationing_action')
                       + (select count(*) from restationing_action)
                       + (4 - (select count(*) from information_schema.columns
                                where table_schema = 'public' and (table_name, column_name) in (('restationing_request', 'parent_request_id'),
                                      ('restationing_request', 'lapsed_at'), ('restationing_request', 'lapse_reason'), ('org_stationing', 'start_held_at'))))
                       + (7 - (select count(*) from pg_constraint
                                where conname in ('restationing_request_kind_check', 'restationing_request_state_check',
                                                  'restationing_request_activated_check', 'restationing_request_parent_check',
                                                  'restationing_request_lapse_check', 'org_stationing_held_check', 'org_stationing_end_reason_check')))
                       + (select count(*) from pg_constraint where conname = 'restationing_request_check3')
                       + (select count(*) from restationing_request where parent_request_id is not null or lapsed_at is not null)
                       + (select count(*) from org_stationing where start_held_at is not null));
