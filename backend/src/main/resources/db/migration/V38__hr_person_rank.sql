-- The person's rank from HR (owner, 16 Nov 2026): «إدارة الصلاحيات» shows الرقم العسكري | الرتبة | الاسم | رقم الـU | المنصب as
-- separate columns, as TNQL does. An optional canonical field «الرتبة» (HrMapping) the administrator maps to the view's grade
-- column (TNQL's GRADE_NAME); empty until a mapping version that maps it is published and a sync runs. Additive only.
alter table hr_person add column rank_name text;
