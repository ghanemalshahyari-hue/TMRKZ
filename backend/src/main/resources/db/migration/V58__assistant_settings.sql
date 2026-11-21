-- V58: the AI model of «المساعد الذكي» (ADR-056) is now configurable from «إعدادات التكامل» (owner, 20 Nov 2026):
-- enabled, base URL (OpenAI-compatible), model name, API key (encrypted with TMRKZ_HR_SETTINGS_KEY), timeout. The saved
-- value wins over TMRKZ_AI_* in the environment, applied without a restart. The widening of the kind check also lets
-- later integration sections be added as ordinary rows.
alter table integration_setting drop constraint integration_setting_kind_check;
alter table integration_setting add constraint integration_setting_kind_check
  check (kind in ('DIRECTORY', 'OIDC', 'ASSISTANT'));
