-- V17 (ADR-028) after-migration checks: every execution step has the purpose of the template it came from.
select 'purpose ' || key || '=' || purpose || ' x' || count(*) from execution_task group by key, purpose order by 1;
select 'purpose mismatches=' || count(*) from execution_task
 where purpose <> case key when 'handover' then 'HANDOVER' when 'receipt' then 'RECEIPT' when 'relocated' then 'ACKNOWLEDGEMENT' else 'TASK' end;
select 'purpose column=' || data_type || ' nullable=' || is_nullable || ' default=' || column_default
  from information_schema.columns where table_name = 'execution_task' and column_name = 'purpose';
