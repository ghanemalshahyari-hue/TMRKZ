-- V59: owner, 20 Nov 2026.
--
-- (a) «مطور النظام»: a temporary wide-open role for the «developer» platform account that opens every current
--     permission. The owner has stated this is temporary («later we will change it»). The role is marked SYSTEM and
--     scope ALL. Only the «developer» platform login carries it (see IdentityService.platformPerson).
-- (b) The developer role is kept out of the review list and the request forms of normal users: it is never offered
--     through «مركز الصلاحيات»; it is bound to the platform login at sign-in time.

insert into role_def (code, name, permissions, scope, summary_only, system, sort_order)
values ('DEVELOPER', 'مطور النظام (مؤقت)',
        array['VIEW', 'VIEW_SUMMARY', 'CREATE', 'EDIT', 'REVIEW', 'APPROVE', 'EXPORT', 'EXECUTE',
              'MANAGE_FACILITIES', 'MANAGE_ACCESS', 'CONFIGURE', 'AUDIT', 'VIEW_SOURCE_IDENTIFIERS', 'CLOSE',
              'CORRECT_STATIONING', 'MANAGE_SITE_LINKS', 'REPLAY_STATIONING_EVENTS',
              'CREATE_RESTATIONING', 'ACTIVATE_STATIONING', 'REQUEST_SITE_REGISTRATION',
              'DECIDE_UNIT_OPERATIONS', 'FINAL_APPROVE_STATIONING', 'MANAGE_FYI_DISTRIBUTION',
              'VIEW_OPERATIONAL_POSTURE', 'APPROVE_HIERARCHY'],
        'ALL', false, true, 2)
on conflict (code) do update set permissions = excluded.permissions, name = excluded.name, scope = excluded.scope, system = true;
