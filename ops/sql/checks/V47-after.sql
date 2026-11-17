-- V47 after-migration checks (modelled on V20-after.sql): additive snapshot lineage, PREVIEWED retention status and the
-- unit-import audit objects. These checks are read-only and validate structure/invariants, never a deployment-specific
-- unit total. Import publication carries people forward in service code, not this migration or check; it proves no live
-- Oracle connectivity. Run after V47 and require the final mismatches count to be zero.
select 'snapshot_origin=' || count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'hr_snapshot' and column_name = 'origin'
   and data_type = 'text' and is_nullable = 'NO' and column_default = '''ORACLE_SYNC''::text';
select 'nullable_snapshot_lineage=' || count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'hr_snapshot' and column_name in ('run_id', 'mapping_version_id')
   and is_nullable = 'YES';
select 'snapshot_lineage_violations=' || count(*) from hr_snapshot
 where (origin = 'ORACLE_SYNC' and (run_id is null or mapping_version_id is null))
    or (origin = 'ORACLE_UNIT_IMPORT' and (run_id is not null or mapping_version_id is not null))
    or origin not in ('ORACLE_SYNC', 'ORACLE_UNIT_IMPORT');
select 'snapshot_guards=' || count(*) from pg_constraint
 where conrelid = 'hr_snapshot'::regclass and contype = 'c'
   and conname in ('hr_snapshot_origin_check', 'hr_snapshot_origin_lineage_check', 'hr_snapshot_status_check');
select 'preview_status_guard=' || count(*) from pg_constraint
 where conrelid = 'hr_snapshot'::regclass and conname = 'hr_snapshot_status_check'
   and pg_get_constraintdef(oid) like '%PREVIEWED%';
select 'unit_import_table=' || count(*) from information_schema.tables
 where table_schema = 'public' and table_name = 'oracle_unit_import_run';
select 'unit_import_columns=' || count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'oracle_unit_import_run'
   and (column_name, data_type, is_nullable) in (
     ('id', 'uuid', 'NO'),
     ('storage_key', 'text', 'NO'),
     ('payload_sha256', 'text', 'NO'),
     ('payload_size', 'bigint', 'NO'),
     ('schema_version', 'text', 'NO'),
     ('source_name', 'text', 'NO'),
     ('source_synced_at', 'timestamp with time zone', 'NO'),
     ('source_contract', 'jsonb', 'NO'),
     ('structure_fingerprint', 'text', 'NO'),
     ('expected', 'jsonb', 'NO'), ('actual', 'jsonb', 'YES'),
     ('snapshot_id', 'uuid', 'YES'),
     ('carried_person_snapshot_id', 'uuid', 'YES'),
     ('previewed_by', 'uuid', 'NO'),
     ('preview_expires_at', 'timestamp with time zone', 'NO'),
     ('committed_by', 'uuid', 'YES'),
     ('committed_at', 'timestamp with time zone', 'YES'),
     ('reason', 'text', 'NO'),
     ('status', 'text', 'NO'),
     ('error_message', 'text', 'YES'),
     ('created_at', 'timestamp with time zone', 'NO'));
select 'unit_import_defaults=' || count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'oracle_unit_import_run'
   and ((column_name = 'expected' and column_default = '''{}''::jsonb')
     or (column_name = 'created_at' and column_default = 'now()'));
select 'unit_import_guards=' || count(*) from pg_constraint
 where conrelid = 'oracle_unit_import_run'::regclass and contype = 'c'
   and conname in ('oracle_unit_import_payload_sha256_check', 'oracle_unit_import_payload_size_check',
                   'oracle_unit_import_reason_check', 'oracle_unit_import_status_check',
                   'oracle_unit_import_error_message_check', 'oracle_unit_import_commit_check');
select 'unit_import_foreign_keys=' || count(*) from pg_constraint
 where conrelid = 'oracle_unit_import_run'::regclass and contype = 'f';
select 'unit_import_primary_key=' || count(*) from pg_constraint
 where conrelid = 'oracle_unit_import_run'::regclass and contype = 'p';
select 'one_run_per_snapshot=' || count(*) from pg_constraint
 where conrelid = 'oracle_unit_import_run'::regclass and contype = 'u'
   and conname = 'oracle_unit_import_snapshot_unique';
select 'unit_import_indexes=' || count(*) from pg_indexes
 where schemaname = 'public' and tablename = 'oracle_unit_import_run'
   and indexname in ('oracle_unit_import_one_published_payload', 'oracle_unit_import_status_created_idx');
select 'published_payload_unique=' || count(*) from pg_index i
 join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'oracle_unit_import_one_published_payload'
   and i.indisunique and i.indpred is not null;
select 'mismatches=' || (
  (select case when count(*) = 1 then 0 else 1 end from information_schema.columns
    where table_schema = 'public' and table_name = 'hr_snapshot' and column_name = 'origin'
      and data_type = 'text' and is_nullable = 'NO' and column_default = '''ORACLE_SYNC''::text')
+ (select case when count(*) = 2 then 0 else 1 end from information_schema.columns
    where table_schema = 'public' and table_name = 'hr_snapshot' and column_name in ('run_id', 'mapping_version_id')
      and is_nullable = 'YES')
+ (select count(*) from hr_snapshot
    where (origin = 'ORACLE_SYNC' and (run_id is null or mapping_version_id is null))
       or (origin = 'ORACLE_UNIT_IMPORT' and (run_id is not null or mapping_version_id is not null))
       or origin not in ('ORACLE_SYNC', 'ORACLE_UNIT_IMPORT'))
+ (select case when count(*) = 3 then 0 else 1 end from pg_constraint
    where conrelid = 'hr_snapshot'::regclass and contype = 'c'
      and conname in ('hr_snapshot_origin_check', 'hr_snapshot_origin_lineage_check', 'hr_snapshot_status_check'))
+ (select case when count(*) = 1 then 0 else 1 end from pg_constraint
    where conrelid = 'hr_snapshot'::regclass and conname = 'hr_snapshot_status_check'
      and pg_get_constraintdef(oid) like '%PREVIEWED%')
+ (select case when count(*) = 1 then 0 else 1 end from information_schema.tables
    where table_schema = 'public' and table_name = 'oracle_unit_import_run')
+ (select case when count(*) = 21 then 0 else 1 end from information_schema.columns
    where table_schema = 'public' and table_name = 'oracle_unit_import_run'
      and (column_name, data_type, is_nullable) in (
        ('id', 'uuid', 'NO'), ('storage_key', 'text', 'NO'), ('payload_sha256', 'text', 'NO'),
        ('payload_size', 'bigint', 'NO'), ('schema_version', 'text', 'NO'), ('source_name', 'text', 'NO'),
        ('source_synced_at', 'timestamp with time zone', 'NO'), ('source_contract', 'jsonb', 'NO'),
        ('structure_fingerprint', 'text', 'NO'), ('expected', 'jsonb', 'NO'), ('actual', 'jsonb', 'YES'), ('snapshot_id', 'uuid', 'YES'),
        ('carried_person_snapshot_id', 'uuid', 'YES'), ('previewed_by', 'uuid', 'NO'),
        ('preview_expires_at', 'timestamp with time zone', 'NO'), ('committed_by', 'uuid', 'YES'),
        ('committed_at', 'timestamp with time zone', 'YES'), ('reason', 'text', 'NO'), ('status', 'text', 'NO'),
        ('error_message', 'text', 'YES'), ('created_at', 'timestamp with time zone', 'NO')))
+ (select case when count(*) = 2 then 0 else 1 end from information_schema.columns
    where table_schema = 'public' and table_name = 'oracle_unit_import_run'
      and ((column_name = 'expected' and column_default = '''{}''::jsonb')
        or (column_name = 'created_at' and column_default = 'now()')))
+ (select case when count(*) = 6 then 0 else 1 end from pg_constraint
    where conrelid = 'oracle_unit_import_run'::regclass and contype = 'c'
      and conname in ('oracle_unit_import_payload_sha256_check', 'oracle_unit_import_payload_size_check',
                      'oracle_unit_import_reason_check', 'oracle_unit_import_status_check',
                      'oracle_unit_import_error_message_check', 'oracle_unit_import_commit_check'))
+ (select case when count(*) = 4 then 0 else 1 end from pg_constraint
    where conrelid = 'oracle_unit_import_run'::regclass and contype = 'f')
+ (select case when count(*) = 1 then 0 else 1 end from pg_constraint
    where conrelid = 'oracle_unit_import_run'::regclass and contype = 'p')
+ (select case when count(*) = 1 then 0 else 1 end from pg_constraint
    where conrelid = 'oracle_unit_import_run'::regclass and contype = 'u'
      and conname = 'oracle_unit_import_snapshot_unique')
+ (select case when count(*) = 2 then 0 else 1 end from pg_indexes
    where schemaname = 'public' and tablename = 'oracle_unit_import_run'
      and indexname in ('oracle_unit_import_one_published_payload', 'oracle_unit_import_status_created_idx'))
+ (select case when count(*) = 1 then 0 else 1 end from pg_index i
    join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'oracle_unit_import_one_published_payload'
      and i.indisunique and i.indpred is not null));
