-- Fingerprint of the Stationing records over the columns they had at V19 (ops/sql/upgrade-rows.sql does not cover these
-- tables). Run before and after a Stationing migration: every line must be equal. The outbound outbox is left out
-- because its delivery state changes on its own.
select 'stationing_policy_version=' || count(*) || ' ' || coalesce(md5(string_agg(t::text, '|' order by t.id)), '-')
  from (select id, version, previous_id, policy_values, effective_from, reason, reference, created_by, created_at from stationing_policy_version) t;
select 'org_stationing=' || count(*) || ' ' || coalesce(md5(string_agg(t::text, '|' order by t.id)), '-')
  from (select id, organization_id, site_id, kind, base_id, valid_from, valid_to, planned_end, origin, request_id, reason, reference,
               recorded_by, recorded_at, end_reason, ended_by, ended_at from org_stationing) t;
select 'site_link=' || count(*) || ' ' || coalesce(md5(string_agg(t::text, '|' order by t.id)), '-') from site_link t;
select 'restationing_request=' || count(*) || ' ' || coalesce(md5(string_agg(t::text, '|' order by t.id)), '-')
  from (select id, number, requester_id, requesting_unit_id, state, kind, start_at, end_at, reason, content, policy_version, route_no,
               route_path, hierarchy_snapshot, returned, paused, final_approver_id, activated_by, activated_at, site_id, created_at,
               updated_at, version from restationing_request) t;
select 'restationing_stage=' || count(*) || ' ' || coalesce(md5(string_agg(t::text, '|' order by t.id)), '-') from restationing_stage t;
select 'restationing_revision=' || count(*) || ' ' || coalesce(md5(string_agg(t::text, '|' order by t.request_id, t.n)), '-') from restationing_revision t;
select 'deployment_area=' || count(*) || ' ' || coalesce(md5(string_agg(t::text, '|' order by t.id)), '-') from deployment_area t;
