-- ADR-094 step 2 (owner brief, 20 Nov 2026): the units preview before an import (read-only; its last result is kept with the
-- source so the screen can state source counts against local counts), and the person refresh period as a setting
-- («تحديث بيانات الشخص بعد»; 0 = never refresh automatically, manual refresh still possible).
alter table hr_source add column person_refresh_hours int not null default 24 check (person_refresh_hours between 0 and 8760);
alter table hr_source add column last_preview jsonb;
alter table hr_source add column last_preview_at timestamptz;
