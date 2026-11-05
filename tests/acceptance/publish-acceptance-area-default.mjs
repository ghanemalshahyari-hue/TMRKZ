// The ACCEPTANCE-ONLY initial deployment area on tmrkz-test (owner approval of 5 Nov 2026): SQUARE, 300 m × 300 m,
// 90,000 m², labelled «قيمة قبول تجريبية — ليست قيمة إنتاجية معتمدة», published as a new Stationing policy version
// through the real «سياسة التمركز» studio (Keycloak + LDAP sign-in as t.admin; no SQL, no direct API publication).
// Before it: the unset state is recorded (no click placement, drawing still offered). After it: the version is read back
// (only deploymentAreaDefault changed against version 1) and the requester's deployment step shows the labelled value.
//
//   node tests/acceptance/publish-acceptance-area-default.mjs   (UI_URL :5180 — the studio with the field; AUTH_URL :8088)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const UI = process.env.UI_URL ?? 'http://localhost:5180';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8088';
const DRAFT = process.env.REUSE_DRAFT ?? 'RS-2026-0057';
const OUT = fileURLToPath(new URL('../../docs/evidence/acceptance-journeys/stationing-v3/area-default/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
const LABEL = 'قيمة قبول تجريبية — ليست قيمة إنتاجية معتمدة';
const REFERENCE = 'ACCEPTANCE-V3-POLICY-2 · ' + LABEL;
const REASON = LABEL + ': المنطقة الابتدائية لمنطقة الانتشار عند وضعها بنقرة مربع 300 م × 300 م (90,000 م²) لاختبار القبول على tmrkz-test فقط؛ '
  + 'بقية القيم كما في النسخة 1 (ACCEPTANCE TEST VALUE — NOT A PRODUCTION DEFAULT; the owner has not chosen the production value)';
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const external = [];
const consoleErrors = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function as(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on('request', (q) => {
    const u = q.url();
    if (!u.startsWith(UI) && !u.startsWith(AUTH) && !u.startsWith('http://localhost:8180') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${user}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${user}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(AUTH + '/api/v1/auth/oidc/start');
  await page.waitForSelector('#kc-form-login', { timeout: 30000 });
  await page.fill('#username', user);
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.toString().startsWith(AUTH) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
  await page.goto(UI + '/');
  return page;
}
const getJson = (page, path) => page.evaluate(async (u) => (await fetch('/api/v1' + u)).json(), path);

async function deploymentStep(page) {
  const draft = (await getJson(page, '/restationing-requests')).find((r) => r.number === DRAFT);
  await page.goto(`${UI}/#restationing/${draft.id}`);
  await page.getByRole('button', { name: 'تعديل الطلب' }).click();
  await page.waitForSelector('.tz-flow', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'الخطوة 5: الانتشار' }).click();
  await page.waitForSelector('[data-testid=area-controls]', { timeout: 20000 });
  await page.waitForTimeout(1500);
}

// 1 — before: the policy in force has no initial area; click placement is not offered, drawing is
const req = await as('t.requester');
const before = await getJson(req, '/stationing/policy');
await deploymentStep(req);
const placeOff = await req.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).isDisabled();
const drawOn = await req.getByRole('button', { name: 'رسم حدود المنطقة' }).isEnabled();
const unsetText = (await req.locator('[data-testid=area-default]').textContent())?.trim();
await req.screenshot({ path: OUT + '1-unset-no-click-placement.png' });
ok(before.inForce && before.inForce.values.deploymentAreaDefault == null && placeOff && drawOn && unsetText.includes('لم يُحدَّد'),
  'UNSET', 'without a configured value no size is invented: «تحديد المنطقة على الخريطة» is unavailable, «رسم حدود المنطقة» stays', `version ${before.inForce?.version}; «${unsetText}»`);
await req.context().close();

// 2 — publish through the studio as the fictional administrator
const admin = await as('t.admin');
await admin.goto(UI + '/#stationingPolicy');
await admin.waitForSelector('text=مسار الاعتماد', { timeout: 30000 });
await admin.waitForTimeout(1200);
await admin.getByLabel('غير محددة').uncheck();
await admin.waitForTimeout(300);
const shape = admin.locator('select').filter({ has: admin.locator('option[value=CIRCLE]') }).first();
await shape.selectOption('SQUARE');
await admin.getByLabel('المساحة (م²)').fill('90000');
await admin.getByLabel('سبب التغيير').fill(REASON);
await admin.getByLabel('المرجع').fill(REFERENCE);
await admin.screenshot({ path: OUT + '2-studio-filled.png', fullPage: true });
await admin.getByRole('button', { name: 'فحص على الخادم' }).click();
await admin.waitForTimeout(2000);
const publish = admin.getByRole('button', { name: 'نشر نسخة جديدة' });
ok(await publish.isEnabled(), 'DRY-RUN', 'the server dry run accepts the values (publishing enabled)');
await publish.click();
await admin.waitForTimeout(3000);
await admin.screenshot({ path: OUT + '3-studio-published.png', fullPage: true });
const after = await getJson(admin, '/stationing/policy');
const versions = await getJson(admin, '/stationing/policy/versions');
const v2 = versions.find((v) => v.version.version === after.inForce?.version);
const strip = (v) => {
  const c = structuredClone(v);
  delete c.deploymentAreaDefault;
  return JSON.stringify(c);
};
ok(after.inForce?.version === before.inForce.version + 1 && JSON.stringify(after.inForce.values.deploymentAreaDefault) === JSON.stringify({ shape: 'SQUARE', areaM2: 90000 })
  && strip(after.inForce.values) === strip(before.inForce.values) && after.inForce.reference === REFERENCE && after.inForce.reason === REASON,
  'PUBLISHED', 'a new version holds exactly SQUARE 90,000 m², every other value as before, with the acceptance label as reference and reason',
  `version ${after.inForce?.version} · ${after.inForce?.createdByName} · ${after.inForce?.reference}`);
ok(v2 && v2.changes.length === 1 && v2.changes[0].key.includes('deploymentAreaDefault') && v2.changes[0].previous == null, 'ONE-CHANGE', 'the version history records one change: deploymentAreaDefault (was not configured)',
  JSON.stringify(v2?.changes ?? []).slice(0, 200));
await admin.context().close();

// 3 — after: the requester's click placement uses the policy value, labelled as acceptance-only
const req2 = await as('t.requester');
await deploymentStep(req2);
const setText = (await req2.locator('[data-testid=area-default]').textContent())?.trim();
const placeOn = await req2.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).isEnabled();
await req2.screenshot({ path: OUT + '4-requester-sees-labelled-value.png' });
ok(placeOn && setText.includes('مربع 90,000 م² (300 م × 300 م)') && setText.includes(LABEL) && setText.includes(`النسخة ${after.inForce?.version}`), 'LABELLED',
  'the deployment step offers click placement with the policy value, shown as «قيمة قبول تجريبية — ليست قيمة إنتاجية معتمدة»', `«${setText}»`);
await req2.context().close();
await browser.close();

ok(external.length === 0, 'NET', 'no request leaves the application');
ok(consoleErrors.length === 0, 'CONSOLE', 'no console error', consoleErrors.slice(0, 3).join(' | '));
writeFileSync(OUT + 'results.json', JSON.stringify({ ui: UI, at: new Date().toISOString(), results, external, consoleErrors }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
