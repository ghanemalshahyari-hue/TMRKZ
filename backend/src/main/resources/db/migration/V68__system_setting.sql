-- V68: key-value store for system settings managed through the admin UI
-- (embedding allowed origins, future UI-managed configuration)

create table if not exists system_setting (
  key    text primary key,
  value  text not null
);
