// TMRKZ :8088 configured with MOVER's settings (owner, 17 Nov 2026; ADR-079), through the same API the settings screens use,
// as the platform administrator: the role definitions of ops/policy, the Oracle HR source with MOVER's connection fields, MOVER's
// column mapping, the first sync. After ops/local/use-mover-sources.sh. Secrets are read from git-ignored files, never printed.
// On the isolated server the administrator enters the same values in «إعدادات النظام ← مصدر الموارد البشرية».
//   node ops/local/mover-settings.mjs roles|source|sync|all
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://127.0.0.1:8088';
const env = (file) => Object.fromEntries(readFileSync(ROOT + file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const adminPw = env('.env').TMRKZ_PLATFORM_ADMIN_PASSWORD;

const login = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: 'admin', password: adminPw }) });
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
if (login.status !== 200) throw new Error('admin sign-in ' + login.status);
const api = async (method, path, body) => {
  const r = await fetch(BASE + '/api/v1' + path, { method, headers: { Cookie: cookie, 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, body: b };
};
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ' ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 600)); return r.body; };
const what = process.argv[2] ?? 'all';

// ---- 1. the role definitions published by the owner on 16 Nov 2026 (ADR-063), as on every other installation -------------
if (what === 'roles' || what === 'all') {
  const live = (must(await api('GET', '/roles'), 'roles') ?? []).some((r) => r.code === 'UNIT_ACCESS_MANAGER');
  if (live) console.log('roles: already published');
  else {
    const a = JSON.parse(readFileSync(ROOT + 'ops/policy/approval-roles.json', 'utf8'));
    const s = JSON.parse(readFileSync(ROOT + 'ops/policy/stationing-capabilities.json', 'utf8'));
    const note = 'أدوار الاعتماد وطلبات الصلاحية وقدرات التمركز من ops/policy (ADR-063، ADR-078) — تهيئة :8088 بإعدادات MOVER، 17 نوفمبر 2026';
    const dr = await api('POST', '/access/policy/draft', { note });
    console.log('draft:', dr.status);
    for (const role of [...s.roles, ...a.roles]) must(await api('PUT', '/access/policy/draft/roles', role), 'role ' + role.code);
    const pub = must(await api('POST', '/access/policy/draft/publish', { note }), 'publish');
    console.log('roles: published version', pub.version ?? pub.published?.version ?? '?', '—', a.roles.length + s.roles.length, 'roles');
  }
}

// ---- 2. the Oracle HR source, with MOVER's connection fields and column mapping ------------------------------------------------
if (what === 'source' || what === 'all') {
  const o = env('ops/local/.generated/mover-oracle-hr.env');
  must(await api('PUT', '/hr/source', {
    name: 'Oracle HR', enabled: true, hostOrUrl: o.HOST, port: Number(o.PORT), serverName: o.SERVICE, nameType: 'service_name',
    username: o.USER, password: o.PASSWORD, unitView: o.UNIT_VIEW || 'HR_AI.HR_ENV_UNITS_AI', personView: o.PERSON_VIEW || 'HR_AI.HR_PRS_EMPLOYEES_ALL',
    connectTimeoutS: 10, callTimeoutMs: 30000, dropPercent: 10, dropMinimum: 3, maxAgeHours: 26,
  }), 'save source');
  const t = await api('POST', '/hr/source/test');
  console.log('connection test:', t.status, JSON.stringify(t.body).slice(0, 300));
  const F = (entity, field, column, transform = 'none', alternates = []) => ({ entity, field, column, transform, alternates, enabled: true });
  const fields = [
    // units: MOVER's mapping (ID, CODE, NAME, NAME_E, UNT_LEVEL, STATUS = 1 active). The parent: MOVER takes it from the ID path
    // (SORT_ORDER); this sandbox's HR_AI view has no ID path and its MAIN_UNIT_ID is the parent (the older TNQL demo shape).
    F('UNIT', 'external_unit_id', 'ID'), F('UNIT', 'name', 'NAME'), F('UNIT', 'parent_external_unit_id', 'MAIN_UNIT_ID'),
    F('UNIT', 'status', 'STATUS'), F('UNIT', 'code', 'CODE'), F('UNIT', 'name_en', 'NAME_E'), F('UNIT', 'level', 'UNT_LEVEL'),
    // people: MOVER's mapping (PRS_ID, the new military number else the old, PERSON_USER_ID, FULL_NAME, rank, position, unit,
    // EMP_STATUS_DESC = «في الخدمة» active). This sandbox names the numbers NEW_MIL_NO / MIL_NUMBER.
    F('PERSON', 'external_person_id', 'PRS_ID'), F('PERSON', 'employee_number', 'NEW_MIL_NO', 'first_non_empty', ['MIL_NUMBER']),
    F('PERSON', 'legacy_employee_number', 'MIL_NUMBER'), F('PERSON', 'domain_account', 'PERSON_USER_ID'),
    F('PERSON', 'full_name', 'FULL_NAME'), F('PERSON', 'unit_external_id', 'ORG_UNIT_ID'), F('PERSON', 'status_text', 'EMP_STATUS_DESC'),
    F('PERSON', 'rank', 'FULL_GRADE_NAME', 'first_non_empty', ['GRADE_NAME']), F('PERSON', 'position_id', 'POSITION_ID'),
    F('PERSON', 'position', 'EMP_POSITION_DESC', 'first_non_empty', ['JOB_NAME']), F('PERSON', 'job', 'JOB_NAME'),
  ];
  const activeRules = {
    UNIT: { column: 'STATUS', operator: 'EQUALS', values: ['1'] },
    PERSON: { column: 'EMP_STATUS_DESC', operator: 'EQUALS', values: ['في الخدمة'] },
  };
  const d = must(await api('POST', '/hr/mappings/draft', { fields, activeRules }), 'mapping draft');
  const disc = must(await api('POST', `/hr/mappings/${d.id}/discover`), 'discover');
  console.log('discovered problems:', JSON.stringify(disc.problems ?? []));
  const p = must(await api('POST', `/hr/mappings/${d.id}/publish`), 'publish mapping');
  console.log('mapping published: version', p.version, p.status);
}

// ---- 3. the first sync: the unit tree (people only those linked to TMRKZ — none yet) -------------------------------------------
if (what === 'sync' || what === 'all') {
  const run = must(await api('POST', '/hr/sync', {}), 'sync');
  console.log('sync started', JSON.stringify(run).slice(0, 200));
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = (await api('GET', '/hr/status')).body;
    const last = st?.lastRun ?? st?.runs?.[0] ?? st;
    if (last?.finishedAt || last?.status === 'SUCCEEDED' || last?.status === 'FAILED') { console.log('sync:', JSON.stringify(last).slice(0, 500)); break; }
  }
}
