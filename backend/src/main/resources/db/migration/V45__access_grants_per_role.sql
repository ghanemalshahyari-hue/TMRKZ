-- V45 (owner decision «LDAP FIRST LOGIN + ZERO ACCESS + UNIT-OWNED REQUESTS + UNIT-OWNED APPROVAL SEATS», 16 Nov 2026; ADR-069).
--
-- 1. The final access approver sets each granted role's own scope (§14): anchor unit, the unit alone or with its descendants,
--    chosen levels, chosen units or sites, and the validity period — through the grant/target/levels model every grant uses,
--    not a second scope engine. What was approved is kept exactly as previewed («الصلاحيات التي ستصبح فعالة», §15) and is
--    what the final step writes; null for a request approved with one scope for all its roles, as before.
alter table access_request add column granted_detail jsonb;

-- 2. «الصلاحيات المتاحة للطلب» (§36): a role may also be shown to the person asking without being requestable by them
--    (SHOWN: «تظهر للاطلاع ولا تُطلب»), besides shown and requestable (EVERYONE) and kept for the access manager (MANAGER).
alter table access_request_offer drop constraint access_request_offer_audience_check;
alter table access_request_offer add constraint access_request_offer_audience_check
    check (audience in ('EVERYONE', 'SHOWN', 'MANAGER'));
