-- ACCEPTANCE / FICTIONAL — the deployment areas fictional units already hold; runs after the acceptance policy exists.
\set ON_ERROR_STOP on
begin;
-- deployment areas need the request they came from, so the acceptance requests below stand for earlier approved ones
insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind, start_at, reason, content, policy_version, route_no, route_path, hierarchy_snapshot, final_approver_id, activated_by, activated_at, site_id, created_at, updated_at, purpose)
select md5('__NS__:seedreq:' || v.org)::uuid, '__PFX__SEED-' || v.org, md5('__NS__:person:p14.admin')::uuid, md5('__NS__:org:' || v.org)::uuid, 'ACTIVATED_PERMANENT', 'PERMANENT', now() - interval '30 days', 'اختبار قبول — وهمي',
       jsonb_build_object('kind', 'PERMANENT', 'scope', jsonb_build_array(md5('__NS__:org:' || v.org)::uuid), 'occupants', '{}'::jsonb, 'exceptions', '{}'::jsonb, 'reason', 'اختبار قبول — وهمي'),
       v.pv, 0, array[md5('__NS__:org:' || v.org)::uuid], jsonb_build_object('requestingUnit', md5('__NS__:org:' || v.org)::uuid, 'path', jsonb_build_array(md5('__NS__:org:' || v.org)::uuid), 'externalPath', jsonb_build_array(v.org), 'takenAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), md5('__NS__:person:p14.admin')::uuid, md5('__NS__:person:p14.admin')::uuid, now() - interval '30 days', md5('__NS__:site:' || v.code)::uuid, now(), now(), 'DEPLOYMENT_AREAS'
  from (select org, code, (select max(version) from stationing_policy_version) as pv from (values ('N-A', 'SITE-01'), ('N-B', 'SITE-01'), ('N-A112', 'SITE-04')) x(org, code)) v
on conflict do nothing;
insert into deployment_area(id, request_id, site_id, role, geom, state, valid_from, organization_id, stationing_id)
select md5('__NS__:area:' || v.org || v.role)::uuid, md5('__NS__:seedreq:' || v.org)::uuid, md5('__NS__:site:' || v.code)::uuid, v.role, ST_Translate(ST_MakeEnvelope(v.x - 0.0015, v.y - 0.0014, v.x + 0.0015, v.y + 0.0014, 4326), 0, __DY__), 'ACTIVE', now() - interval '30 days',
       md5('__NS__:org:' || v.org)::uuid, md5('__NS__:st:' || v.org)::uuid
  from (values ('N-A', 'SITE-01', 'PRIMARY', 56.0900, 24.8400), ('N-A', 'SITE-01', 'ALTERNATIVE', 56.0900, 24.8760),
               ('N-B', 'SITE-01', 'PRIMARY', 55.9710, 24.8400), ('N-B', 'SITE-01', 'ALTERNATIVE', 55.9710, 24.8760),
               ('N-A112', 'SITE-04', 'PRIMARY', 56.0595, 24.8800), ('N-A112', 'SITE-04', 'ALTERNATIVE', 56.0595, 24.9160)) v(org, code, role, x, y)
on conflict do nothing;
commit;
