-- V24: which units the HR source flags as a main unit («الوحدة الرئيسية», MAIN_UNIT_FLAG in the TNQL contract). A flow's
-- approvals can climb the hierarchy until they reach it, whatever its level is in that branch (ADR-041).
alter table hr_unit add column is_main boolean not null default false;
