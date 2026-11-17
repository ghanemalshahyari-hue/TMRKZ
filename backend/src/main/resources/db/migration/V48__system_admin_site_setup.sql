-- V48 (owner decision, 17 Nov 2026; ADR-076): «مدير النظام» sets up sites with their stationing.
--
-- «تهيئة المواقع والتمركز» is «تهيئة المواقع», and the unit responsible for a site is the unit stationed there. The protected
-- system role already manages facilities over everything; it now also records stationing as a setup correction
-- (CORRECT_STATIONING) and links units to sites (MANAGE_SITE_LINKS), over its existing ALL scope — so the system administrator
-- has the six-step «موقع جديد» (SiteSetupService.admin: facilities and corrections over everything) and «تثبيت» on a site's
-- card. It still reads no request content and decides nothing.
--
-- As V46: the system role is outside policy publication, so it is changed here; a fresh installation seeds it (Bootstrap); an
-- open draft carries the same definition; published versions are immutable and stay as published.
update role_def
   set permissions = permissions
                     || case when 'MANAGE_SITE_LINKS' = any(permissions) then array[]::text[] else array['MANAGE_SITE_LINKS'] end
                     || case when 'CORRECT_STATIONING' = any(permissions) then array[]::text[] else array['CORRECT_STATIONING'] end,
       updated_at = now()
 where code = 'SYSTEM_ADMIN' and system
   and not (permissions @> array['MANAGE_SITE_LINKS', 'CORRECT_STATIONING']);

update access_policy_version v
   set roles = (select jsonb_agg(case
                                     when e->>'code' = 'SYSTEM_ADMIN'
                                         then jsonb_set(e, '{permissions}',
                                                        coalesce(e->'permissions', '[]'::jsonb)
                                                        || case when coalesce(e->'permissions', '[]'::jsonb) ? 'MANAGE_SITE_LINKS' then '[]'::jsonb else '["MANAGE_SITE_LINKS"]'::jsonb end
                                                        || case when coalesce(e->'permissions', '[]'::jsonb) ? 'CORRECT_STATIONING' then '[]'::jsonb else '["CORRECT_STATIONING"]'::jsonb end)
                                     else e end
                                 order by n)
                  from jsonb_array_elements(v.roles) with ordinality as t(e, n))
 where v.status = 'DRAFT'
   and jsonb_typeof(v.roles) = 'array'
   and exists (select 1 from jsonb_array_elements(v.roles) e
                where e->>'code' = 'SYSTEM_ADMIN'
                  and not (coalesce(e->'permissions', '[]'::jsonb) ?& array['MANAGE_SITE_LINKS', 'CORRECT_STATIONING']));
