// Publishes the Stationing V3 ACCEPTANCE policy through the real «سياسة التمركز» studio (owner gate of 4 Nov 2026):
// headless Edge, real sign-in through Keycloak and LDAP as t.admin, the JSON template imported with the page's own
// button, the owner's remaining decisions set in the page, «فحص على الخادم», then «نشر نسخة جديدة». No SQL, no direct
// API publication. The published version is then read back from the server and compared with the owner's values.
// Usage: MOVER_URL=http://localhost:8088 node tests/acceptance/publish-acceptance-policy.mjs   (fictional data only)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = new URL('../../docs/evidence/acceptance-journeys/stationing-v3/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, OUT));
const TEMPLATE = fileURLToPath(new URL('../../ops/test-env/acceptance-v3-policy-template.json', import.meta.url));
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const require = createRequire(new URL('./package.json', import.meta.url));
const { chromium } = require('playwright-core');

// the owner's decisions of 4 Nov 2026 for this acceptance policy (ACCEPTANCE TEST VALUES — NOT PRODUCTION DEFAULTS)
const REASON = 'سياسة اختبار قبول Stationing V3 — بيانات وهمية، ليست إعدادات إنتاج (ACCEPTANCE TEST POLICY — NOT A PRODUCTION DEFAULT; exception.maxExtra 2 km = ACCEPTANCE TEST VALUE)';
const APPROVING = [6, 7, 8, 9, 10];
const FINAL = 6;
// what a hierarchy stage rests on: the owner-approved model (V2 §4.5 as kept by V3) — scope, classification, duration
// and the site, whose facts included the two deployment areas (a separate fact in V3)
const HIERARCHY_FACTS = ['الوحدات المنتقلة', 'النوع (دائم / مؤقت)', 'المدة', 'الموقع المقترح', 'الانتشار'];

const results = [];
const ok = (cond, id, label, extra = '') => {
  results.push({ id, label, result: cond ? 'PASS' : 'FAIL', extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${extra ? '  — ' + extra : ''}`);
  return cond;
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await ctx.newPage();
const external = [];
const errors = [];
page.on('request', (q) => { const u = q.url(); if (!u.startsWith(BASE) && !u.startsWith('http://localhost:8180') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
try {
  // real sign-in: TMRKZ → Keycloak login form → LDAP → back to TMRKZ
  await page.goto(BASE + '/api/v1/auth/oidc/start');
  await page.waitForSelector('#kc-form-login', { timeout: 30000 });
  const kc = new URL(page.url()).origin;
  await page.fill('#username', 't.admin');
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.toString().startsWith(BASE), { timeout: 30000 });
  const me = await (await page.request.get(BASE + '/api/v1/me')).json();
  ok(me.username === 't.admin' && me.signInMethod === 'PROVIDER', 'P1', 'signed in through Keycloak', `${me.displayName}, ${me.signInMethod}, identity provider ${kc}`);

  await page.goto(BASE + '/#stationingPolicy');
  await page.waitForSelector('text=مسار الاعتماد', { timeout: 30000 });
  const before = (await page.locator('.rs-policy-state').textContent()).trim();
  const already = before.includes('النسخة السارية');
  if (already) console.log('A policy is already in force: verification only, nothing is published again.');
  else ok(before.includes('لا توجد سياسة تمركز نافذة'), 'P2', 'no policy in force before publication', before);
  if (!already) {

  await page.locator('input[type=file]').setInputFiles(TEMPLATE);
  await page.waitForSelector('.rs-banner.orange', { timeout: 10000 });
  await page.locator('label', { hasText: 'مطلوبتان (الموقع والرئيسية والبديلة)' }).locator('input').check();
  await page.locator('label', { hasText: 'مسموح بمرحلة اعتماد منفصلة' }).locator('input').check();
  await page.locator('label', { hasText: 'أقصى زيادة (م)' }).locator('input').fill('2000');

  const routing = page.locator('section', { has: page.locator('h3', { hasText: 'مسار الاعتماد' }) });
  await routing.locator('label', { hasText: 'معتمد الوحدة الطالبة' }).locator('input').check();
  const rows = routing.locator('tbody tr');
  const n = await rows.count();
  const seen = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const level = Number(await row.locator('td').nth(0).locator('input').inputValue());
    seen.push(level);
    if (!APPROVING.includes(level)) continue;
    await row.locator('td').nth(2).locator('input').check();
    await row.locator('td').nth(3).locator('input').fill(`اعتماد المستوى L${level}`);
    if (level === FINAL) await row.locator('td').nth(4).locator('input').check();
  }
  // facts are offered only on the non-final rows (the final stage rests on every fact)
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const level = Number(await row.locator('td').nth(0).locator('input').inputValue());
    if (level === FINAL || !APPROVING.includes(level)) continue;
    for (const f of HIERARCHY_FACTS) await row.locator('td').nth(5).locator('label', { hasText: f }).first().locator('input').check();
  }
  ok(APPROVING.every((l) => seen.includes(l)), 'P3', 'routing rows for every HR level L6–L10 on the page', seen.map((l) => 'L' + l).join(' '));

  const publishCard = page.locator('section', { has: page.locator('h3', { hasText: 'النشر' }) });
  await publishCard.locator('textarea').fill(REASON);
  await page.screenshot({ path: shot('P-studio-filled.png'), fullPage: true });
  await page.getByRole('button', { name: 'فحص على الخادم' }).click();
  await page.waitForSelector('.rs-verdict', { timeout: 30000 });
  const verdict = (await page.locator('.rs-verdict').textContent()).trim();
  const problems = await page.locator('.rs-problems li').allTextContents();
  ok(verdict === 'القيم صالحة للنشر' && problems.length === 0, 'P4', '«فحص على الخادم»: the server validation passes', problems.join(' | ') || verdict);
  await page.screenshot({ path: shot('P-studio-validated.png'), fullPage: true });
  if (problems.length) throw new Error('validation failed: ' + problems.join(' | '));

  await page.getByRole('button', { name: 'نشر نسخة جديدة' }).click();
  await page.waitForFunction(() => document.querySelector('.rs-policy-state')?.textContent.includes('النسخة السارية'), null, { timeout: 30000 });
  const after = (await page.locator('.rs-policy-state').textContent()).trim();
  await page.screenshot({ path: shot('P-studio-published.png'), fullPage: true });
  ok(after.includes('النسخة السارية'), 'P5', '«نشر نسخة جديدة»: a version is in force', after);
  }

  // read back from the server and compare with every owner value
  const ov = await (await page.request.get(BASE + '/api/v1/stationing/policy')).json();
  const versions = await (await page.request.get(BASE + '/api/v1/stationing/policy/versions')).json();
  const p = ov.inForce;
  const v = p.values;
  const lv = Object.fromEntries(v.routing.levels.map((l) => [l.level, l]));
  // key order is not meaningful (the server stores the values as jsonb)
  const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
  const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  ok(versions.length === 1 && p.version === 1, 'V1', 'first published version, the only one', `version ${p.version}, ${versions.length} version(s)`);
  ok(new Date(p.effectiveFrom) <= new Date() && (p.effectiveTo ?? null) === null, 'V2', 'in force now, open-ended', `effective from ${p.effectiveFrom}`);
  ok(APPROVING.every((l) => lv[l]?.approves) && v.routing.startAt === 'SELF', 'V3', 'L6–L10 approve; the first stage is the requesting unit\'s own approver', v.routing.levels.map((l) => `L${l.level}:${l.approves ? 'approves' : 'no'}`).join(' '));
  ok(lv[6]?.finalStage && v.routing.levels.filter((l) => l.finalStage).length === 1, 'V4', 'final level L6, only L6');
  ok([7, 8, 9, 10].every((l) => eq([...lv[l].dependsOn].sort(), ['CLASSIFICATION', 'DEPLOYMENT', 'DURATION', 'SCOPE', 'SITE'])), 'V5', 'hierarchy stages rest on scope, classification, duration, site and deployment (owner model V2 §4.5)', [7, 8, 9, 10].map((l) => `L${l}: ${lv[l].dependsOn.join(',')}`).join(' | '));
  ok(v.deploymentRequirement === 'REQUIRED', 'V6', 'deployment areas REQUIRED', v.deploymentRequirement);
  ok(eq(v.primary, { minM: 5000, maxM: 8000, terrainApplies: true }) && eq(v.alternative, { minM: 3000, maxM: 5000, terrainApplies: true }), 'V7', 'base ranges 5–8 km and 3–5 km, terrain applies', JSON.stringify({ primary: v.primary, alternative: v.alternative }));
  ok(eq(v.terrainAllowancesM, { FLAT: 0, UNDULATING: 500, ROLLING: 1000, HILLY: 1500, MOUNTAINOUS: 2000 }) && v.terrainAppliesTo === 'MAX_ONLY', 'V8', 'allowances 0 / 0.5 / 1 / 1.5 / 2 km on the maximum only', JSON.stringify(v.terrainAllowancesM));
  ok(eq(v.terrainClassPriority, ['MOUNTAINOUS', 'HILLY', 'ROLLING', 'UNDULATING', 'FLAT']), 'V9', 'tie priority MOUNTAINOUS > HILLY > ROLLING > UNDULATING > FLAT');
  ok(v.maxFootprintAreaM2 === 500000, 'V10', 'footprint maximum 0.5 km²', String(v.maxFootprintAreaM2));
  ok(v.crossBranch.allowed && eq([...v.crossBranch.authorities].sort(), ['OTHER_UNIT', 'SITE_RESPONSIBLE']) && v.crossBranch.independent === false, 'V11', 'cross-branch OTHER_UNIT + SITE_RESPONSIBLE, independent approvals OFF', JSON.stringify(v.crossBranch));
  ok(v.exception.allowed === true && v.exception.maxExtraM === 2000, 'V12', 'distance exception enabled, maxExtra 2 km', JSON.stringify(v.exception));
  const tsc = v.terrainSlopeClassification;
  ok(tsc.datasetCode === 'copernicus-glo30' && tsc.datasetVersion === '2026.11' && eq(tsc.classes.map((c) => [c.code, c.fromPct, c.toPct]), [['FLAT', 0, 2], ['UNDULATING', 2, 10], ['ROLLING', 10, 15], ['HILLY', 15, 30], ['MOUNTAINOUS', 30, null]]) && tsc.classes[2].label === 'تضاريس متدرجة', 'V13', 'dataset copernicus-glo30 2026.11 and the approved FAO classes (ROLLING «تضاريس متدرجة»)');
  ok(p.createdByName && p.reason === REASON && p.reference === 'ACCEPTANCE-V3-POLICY-1', 'V14', 'author, reason and reference recorded', `${p.createdByName} · ${p.reference} · ${p.reason}`);
  const allowed = new Set(['maxFootprintAreaM2', 'deploymentRequirement', 'primary', 'alternative', 'terrainSlopeClassification', 'terrainAllowancesM', 'terrainClassPriority', 'terrainAppliesTo', 'exception', 'crossBranch', 'routing']);
  ok(Object.keys(v).every((k) => allowed.has(k)) && !JSON.stringify(v).includes('TEST_SLOPE') && !JSON.stringify(v).includes('dev'), 'V15', 'no development value or extra field in the published values', Object.keys(v).join(','));
  writeFileSync(new URL('policy-published.json', OUT), JSON.stringify({ readAt: new Date().toISOString(), inForce: p, versions }, null, 2));
} finally {
  ok(external.length === 0, 'NET', 'zero external requests from the studio (the identity provider is local)', external.slice(0, 3).join(' '));
  ok(errors.length === 0, 'CONSOLE', 'no console or page errors', errors.slice(0, 5).join(' | '));
  writeFileSync(new URL('policy-publication.json', OUT), JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, results }, null, 2));
  await browser.close();
  const failed = results.filter((r) => r.result === 'FAIL').length;
  console.log(`\n${failed === 0 ? 'Acceptance policy published and verified' : failed + ' check(s) FAILED'}`);
  process.exitCode = failed ? 1 : 0;
}
