-- V22: the administrative requests list stays fast with many requests. It lists by last update, alone or within a status.
-- Measured on 300,000 fictional rows (6 Nov 2026): first page 51 ms → 5 ms, first page of a status 30 ms → 2 ms.
create index request_updated_idx on request (updated_at desc, id);
create index request_status_updated_idx on request (status, updated_at desc, id);
