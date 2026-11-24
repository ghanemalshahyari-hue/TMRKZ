-- V67: administrative unit management and organisation levels
-- adds the organization_level reference table and a level column on organization

create table if not exists organization_level (
  level  int primary key check (level >= 1 and level <= 20),
  name   text not null
);

alter table organization add column if not exists level int references organization_level(level);
