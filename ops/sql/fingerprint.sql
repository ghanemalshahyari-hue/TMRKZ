-- Deterministic fingerprints of the records that must survive backup/restore unchanged.
-- One line per table: name|row count|md5 of all rows ordered by their text form.
select 'organization|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from organization t
union all select 'person|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from person t
union all select 'membership|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from membership t
union all select 'delegation|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from delegation t
union all select 'role_def|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from role_def t
union all select 'site|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from site t
union all select 'resource|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from resource t
union all select 'form_version|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from form_version t
union all select 'workflow_version|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from workflow_version t
union all select 'policy_version|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from policy_version t
union all select 'request|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from request t
union all select 'request_revision|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from request_revision t
union all select 'decision|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from decision t
union all select 'approval_document|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from approval_document t
union all select 'reservation|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from reservation t
union all select 'reservation_change|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from reservation_change t
union all select 'attachment|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from attachment t
union all select 'audit_event|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from audit_event t
union all select 'map_package|' || count(*) || '|' || coalesce(md5(string_agg(t::text, '§' order by t::text)), '-') from map_package t
union all select 'act_re_procdef|' || count(*) || '|' || coalesce(md5(string_agg(t.id_ || t.key_ || t.version_, '§' order by t.id_)), '-') from act_re_procdef t;
