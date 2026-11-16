-- V43 (LDAP first login specification, owner 16 Nov 2026): what was asked, recommended and granted stay apart — the access
-- manager's recommended scope no longer overwrites the scope column the final approval writes — and a review step passed
-- because the unit has no access manager is recorded, like a hierarchy unit with no approver (ADR-062), instead of inferred.
alter table access_request add column recommended_scope jsonb;
-- rows recommended before V43 kept the advice in granted_scope while nothing was granted yet
update access_request set recommended_scope = granted_scope, granted_scope = null where granted is null and granted_scope is not null;
alter table request_route_skip drop constraint request_route_skip_reason_code_check;
alter table request_route_skip add constraint request_route_skip_reason_code_check
    check (reason_code in ('NO_HIERARCHY_APPROVER', 'NO_ACCESS_MANAGER'));

-- «الصلاحيات المتاحة للطلب» (same specification): how each offered role is described to the person asking and with which
-- scopes it may be asked, set by the system administrator instead of fixed in the page; empty means all four, as before.
alter table access_request_offer add column description text;
alter table access_request_offer add column scope_modes text[];
alter table access_request_offer add column default_scope text;
alter table access_request_offer add constraint access_request_offer_scope_modes_check
    check (scope_modes is null or scope_modes <@ array['UNIT', 'UNIT_TREE', 'UNITS', 'SITES']::text[]);
alter table access_request_offer add constraint access_request_offer_default_scope_check
    check (default_scope is null or (default_scope in ('UNIT', 'UNIT_TREE', 'UNITS', 'SITES') and (scope_modes is null or default_scope = any(scope_modes))));
