-- V5: manual sign-in against the enterprise directory (TNQL's second path). Failed attempts are throttled per login
-- name and per client address; no password or directory answer is stored.
create table login_throttle (
  key               text primary key,          -- 'u:<login name>' or 'ip:<address>'
  failures          int not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until      timestamptz
);
