-- V2: independent actions and requester decisions (owner decisions of 2026-10-29).
--
-- Actions are now independent: EDIT (revising a returned request) is separate from CREATE; administering access
-- (MANAGE_ACCESS) and facilities (MANAGE_FACILITIES) are separate from CONFIGURE; VIEW_SUMMARY replaces the
-- summary-only flavour of VIEW. Existing custom roles keep their effective behaviour: whoever could create could
-- revise, and whoever could configure could administer access and facilities. Those rights can now be removed
-- independently from the permissions screen.

update role_def set permissions = array_append(permissions, 'EDIT'), updated_at = now()
 where 'CREATE' = any(permissions) and not ('EDIT' = any(permissions));

update role_def set permissions = array_append(permissions, 'MANAGE_ACCESS'), updated_at = now()
 where 'CONFIGURE' = any(permissions) and not ('MANAGE_ACCESS' = any(permissions));

update role_def set permissions = array_append(permissions, 'MANAGE_FACILITIES'), updated_at = now()
 where 'CONFIGURE' = any(permissions) and not ('MANAGE_FACILITIES' = any(permissions));

update role_def set permissions = array_replace(permissions, 'VIEW', 'VIEW_SUMMARY'), updated_at = now()
 where summary_only and 'VIEW' = any(permissions);

-- The protected system administrator role administers configuration, access and facilities. It no longer reads
-- request content, exports, audits or decides; a person who also needs those rights receives them explicitly through
-- another membership.
update role_def
   set permissions = array['CONFIGURE', 'MANAGE_ACCESS', 'MANAGE_FACILITIES', 'VIEW_SOURCE_IDENTIFIERS'], updated_at = now()
 where code = 'SYSTEM_ADMIN' and system;

-- A requester may decide a stage of their own request when a grant satisfies that stage exactly as it would for
-- anyone else; the decision records that it was taken by the requester.
alter table decision add column by_requester boolean not null default false;
