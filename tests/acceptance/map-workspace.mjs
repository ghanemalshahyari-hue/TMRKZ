// Browser acceptance of the administrative map workspace — MAP-01 … MAP-18 (docs/MAP_WORKSPACE_COMPLETION_AR.md §8)
// and MAP-19, the on-site request menu (docs/OWNER_CONTINUATION_PROMPT.md §3).
// Real sign-in (Keycloak page and the manual directory path), real API and PostgreSQL/PostGIS in the acceptance
// environment, Microsoft Edge driven by clicks and the keyboard. The API is used only to prepare test data (earlier
// review stages, reservations with known periods, a concurrent edit) and to cross-check what the screen shows; those
// calls are listed separately in the report. Every request from the browser outside localhost is blocked and recorded.
//
// Usage: sh ops/test-env/up-offline.sh && node tests/acceptance/map-workspace.mjs
// Evidence: docs/evidence/map/results.json and screenshots in the same folder (fictional data only).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, apiSession, consoleErrors, evidenceDir, expectServerErrors, external, launch, newContext, signInAutomatic, signInManual, watch, zip } from './lib/browser.mjs';

const FIX = new URL('./fixtures/', import.meta.url);
const OUT = evidenceDir();
const results = [];
// ONLY=MAP-19,MAP-16 runs just those checks (setup still runs); the evidence file is then results-only.json
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const setup = [];
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(id, title, pass, details) {
  results.push({ id, title, pass, details });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${details ? '  — ' + details : ''}`);
}
async function step(id, title, page, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  try {
    const details = await fn();
    record(id, title, true, details ?? '');
  } catch (e) {
    const lines = (e && e.message ? e.message : String(e)).split('\n');
    const waiting = lines.find((l) => l.includes('waiting for'));
    record(id, title, false, (lines[0] + (waiting ? ' — ' + waiting.trim() : '')).slice(0, 500));
    if (page) await page.screenshot({ path: fileURLToPath(new URL(`fail-${id}.png`, OUT)) }).catch(() => undefined);
  }
}
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function shot(page, name) {
  await page.screenshot({ path: fileURLToPath(new URL(name + '.png', OUT)) });
}
async function setupCall(label, promise) {
  const r = await promise;
  setup.push({ label, status: r.status });
  if (r.status >= 300) throw new Error(label + ' failed: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 300));
  return r.body;
}

// ---- dates: a fresh day per run so periods never collide with earlier runs ---------------------------------
const run = Math.floor(Date.now() / 60000);
const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
// each run uses its own 10-day window; the start is checked against the server below (windows recycle every 200 minutes)
let D = addDays('2027-01-01', (run % 200) * 10);
const dubai = (local) => new Date(local.length === 10 ? local + 'T00:00:00+04:00' : local + ':00+04:00').toISOString();

// ---- setup sessions (API) ---------------------------------------------------------------------------------------
const admin = await apiSession('t.admin');
const approverApi = await apiSession('t.approver');
const requesterApi = await apiSession('t.requester');
const facilitiesApi = await apiSession('t.facilities');
const managerApi = await apiSession('t.manager');
const managerItApi = await apiSession('t.manager.it');
const requester2Api = await apiSession('t.requester2');

const sites = (await approverApi.get('/sites')).body;
// an earlier run may have booked this window: move on until no resource has an approved booking in it
for (let i = 0, ids = sites.flatMap((x) => x.resources).map((r) => r.id); ; i++) {
  const c = (await approverApi.post('/availability/check', { resourceIds: ids, start: dubai(D), end: dubai(addDays(D, 12)) })).body;
  if (c?.available) break;
  if (i === 40) throw new Error('no free 12-day window found for this run');
  D = addDays(D, 2000 + 10 * i);
}
const site = (code) => sites.find((s) => s.code === code);
const res = (code) => sites.flatMap((s) => s.resources).find((r) => r.code === code);
const types = (await requesterApi.get('/request-types')).body;
const TYPE = types.find((t) => t.kind === 'NEW_RESERVATION').code;
const TYPE_NAME = types.find((t) => t.code === TYPE).name;

/** Presses a site request action (menu or panel) and, when several published types fit it, picks the named type. */
async function requestAction(scope, label, typeName = TYPE_NAME) {
  await scope.getByRole('button', { name: label, exact: true }).click();
  const list = scope.locator('.site-actions.types');
  if (await list.waitFor({ timeout: 1500 }).then(() => true, () => false)) await list.getByRole('button', { name: typeName, exact: true }).click();
}
const geometryVersion = async (code) => (await admin.get('/sites/' + site(code).id)).body.geometryVersion ?? 0;

/** Runs the earlier stages (and optionally the final one) of a request through the API: test setup only. */
async function decideStages(requestId, includeFinal) {
  for (let round = 0; round < 6; round++) {
    const detail = (await requesterApi.get('/requests/' + requestId)).body ?? (await approverApi.get('/requests/' + requestId)).body;
    if (detail?.status === 'APPROVED') return;
    let acted = false;
    for (const u of [facilitiesApi, managerApi, managerItApi, approverApi]) {
      const tasks = (await u.get('/tasks')).body ?? [];
      const t = tasks.find((x) => x.requestId === requestId);
      if (!t || (t.final && !includeFinal)) continue;
      const rev = (await u.get('/requests/' + requestId)).body.revision;
      await setupCall('decide ' + t.stageKey, u.post('/tasks/' + t.id + '/decision', { decision: 'APPROVE', expectedRevision: rev, signature: t.final ? { confirm: true } : undefined, __key: createHash('sha1').update(t.id + Math.random()).digest('hex') }));
      acted = true;
    }
    if (!acted) return;
  }
}
async function submitted(api, owner, resources, start, end, subject) {
  const d = await setupCall('create ' + subject, api.post('/requests', { typeCode: TYPE, origin: 'LIST', ownerOrgId: owner, resourceIds: resources, subject, unit: 'HOURS', period: { start, end }, values: { reason: 'مبرر بيانات اختبار القبول للخريطة' } }));
  await setupCall('submit ' + subject, api.post('/requests/' + d.id + '/submit', { expectedVersion: d.version, __key: createHash('sha1').update(d.id).digest('hex') }));
  return d.id;
}

const meSS = (await requesterApi.get('/me')).body.primaryOrg.id;
const meIT = (await requester2Api.get('/me')).body.primaryOrg.id;

// disable map packages uploaded by earlier runs (their version names differ per run)
for (const p of (await admin.get('/map/packages?all=true')).body.filter((x) => x.code === 'campus-plan-test' && x.role === 'overlay')) {
  if (p.status === 'ACTIVE') await setupCall('disable earlier test package', admin.post(`/map/packages/${p.code}/${encodeURIComponent(p.version)}/status`, { status: 'DISABLED', reason: 'إصدار تشغيل سابق للاختبار' }));
  if (p.status === 'PENDING_REVIEW') await setupCall('reject earlier test package', admin.post(`/map/packages/${p.code}/${encodeURIComponent(p.version)}/status`, { status: 'REJECTED', reason: 'إصدار تشغيل سابق للاختبار' }));
}

// known reservations: R-02 [D 08:00, D 12:00) Dubai; site 11: exclusive R-11A and shared R-11 (two organisations) on [D, D+2)
const r02 = await submitted(requesterApi, meSS, [res('R-02').id], dubai(D + 'T08:00'), dubai(D + 'T12:00'), 'حجز معروف R-02');
await decideStages(r02, true);
const r11a = await submitted(requesterApi, meSS, [res('R-11A').id], dubai(D), dubai(addDays(D, 2)), 'حجز R-11A');
await decideStages(r11a, true);
const r11ss = await submitted(requesterApi, meSS, [res('R-11').id], dubai(D), dubai(addDays(D, 2)), 'استخدام مشترك SS');
await decideStages(r11ss, true);
const r11it = await submitted(requester2Api, meIT, [res('R-11').id], dubai(D), dubai(addDays(D, 2)), 'استخدام مشترك IT');
await decideStages(r11it, true);
for (const id of [r02, r11a, r11ss, r11it]) {
  const s = (await approverApi.get('/requests/' + id)).body.status;
  if (s !== 'APPROVED') throw new Error('setup reservation not approved: ' + id + ' ' + s);
}
console.log('setup: known reservations approved for day', D);

const browser = await launch();

// =================================================================================================================
// A. Map manager and facility manager (t.admin: facilities and access administration, no request content)
// =================================================================================================================
const ctxA = await newContext(browser);
const pageA = await ctxA.newPage();
watch(pageA, 't.admin');
await signInAutomatic(pageA, 't.admin');
await pageA.waitForSelector('.map-workspace');
await pageA.waitForSelector('.pin-wrap');
const firstView = await pageA.getAttribute('.map', 'data-view');

const openTab = async (page, name) => page.getByRole('tab', { name }).click();
async function searchSite(page, text) {
  await openTab(page, 'المواقع');
  const box = page.getByLabel('البحث في المواقع', { exact: true });
  await box.fill('');
  await box.fill(text);
  const hit = page.locator('.tree-hit').filter({ hasText: text }).first();
  await hit.waitFor({ timeout: 10000 });
  await hit.click();
}
async function selectSite(page, code) {
  await searchSite(page, code);
  await page.locator('.map-detail h2').filter({ hasText: site(code).name }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(700);
}
/** Opens the background panel (if closed) and picks a background by name; the panel closes on selection. */
async function pickBackground(page, name) {
  if (!(await page.locator('.map-popover').filter({ hasText: 'الخلفية' }).isVisible().catch(() => false)))
    await page.getByRole('button', { name: 'الخلفية', exact: true }).click();
  await page.locator('.map-popover .radio-row').filter({ hasText: name }).locator('input').click();
}
const pathCount = (page, code) => page.locator(`path[data-site="${site(code).id}"]`).count();
const subpaths = async (page, code) => ((await page.locator(`path[data-site="${site(code).id}"]`).first().getAttribute('d')) ?? '').split(/[Mm]/).filter((x) => x.trim()).length;

// MAP-07 preparation and package manager: upload, preview, review, activate
const plan = readFileSync(new URL('campus-plan/plan.svg', FIX));
const manifest = readFileSync(new URL('campus-plan/manifest.template.json', FIX), 'utf8')
  .replace('__SHA256__', createHash('sha256').update(plan).digest('hex'))
  .replace('"version": "2026.10-test"', `"version": "2026.10-test-${run}"`);
const zipPath = pathToFileURL(join(tmpdir(), `tmrkz-campus-plan-${run}.zip`)); // test artefact, not evidence
writeFileSync(zipPath, zip({ 'manifest.json': manifest, 'plan.svg': plan }));
let planId = null;
await step('MAP-07a', 'مدير الخرائط: رفع حزمة مخطط مرفق ومراجعتها ومعاينتها ثم تفعيلها', pageA, async () => {
  await pageA.getByRole('button', { name: 'مدير الخرائط' }).click();
  await pageA.getByLabel('ملف الحزمة').setInputFiles(fileURLToPath(zipPath));
  const row = pageA.locator('tr').filter({ hasText: `2026.10-test-${run}` });
  await row.waitFor({ timeout: 15000 });
  check((await row.innerText()).includes('قيد المراجعة'), 'uploaded package not pending review');
  await row.getByRole('button', { name: 'معاينة على الخريطة' }).click();
  await pageA.waitForSelector('.leaflet-image-layer');
  const pkgs = (await admin.get('/map/packages?all=true')).body;
  planId = pkgs.find((p) => p.version === `2026.10-test-${run}` && p.role === 'overlay').id;
  check((await pageA.getAttribute('.leaflet-image-layer', 'src')).includes(planId), 'preview did not show the uploaded package');
  await shot(pageA, 'map-07-preview-pending-package');
  await pageA.getByRole('button', { name: 'مدير الخرائط' }).click();
  await pageA.getByPlaceholder('مثال: روجع الترخيص والتغطية').fill('روجع المصدر والترخيص والتغطية');
  await pageA.locator('tr').filter({ hasText: `2026.10-test-${run}` }).getByRole('button', { name: 'تفعيل' }).click();
  await pageA.locator('tr').filter({ hasText: `2026.10-test-${run}` }).filter({ hasText: 'مفعّلة' }).waitFor({ timeout: 10000 });
  await pageA.getByRole('button', { name: 'إغلاق مدير الخرائط' }).click();
  return 'حزمة ' + planId.slice(0, 8) + ' قيد المراجعة → معاينة للمدير فقط → مفعّلة بسبب مسجل';
});

// MAP-05: refused imports leave nothing published
const before04 = await geometryVersion('04');
const before03 = await geometryVersion('03');
async function importFile(page, file, crs) {
  await page.getByRole('button', { name: 'استيراد حدود المواقع' }).click();
  await page.getByLabel('ملف الحدود').setInputFiles(fileURLToPath(new URL(file, FIX)));
  if (crs) await page.getByLabel('نظام الإحداثيات').selectOption(crs);
  await page.getByRole('button', { name: 'معاينة وفحص' }).click();
}
await step('MAP-05', 'CRS مجهول وهندسة غير صالحة وصيغة غير معلنة: تقرير رفض ولا نشر جزئي', pageA, async () => {
  await importFile(pageA, 'boundaries-no-crs.geojson');
  await pageA.locator('.import-report').filter({ hasText: 'مرفوض' }).waitFor({ timeout: 10000 });
  check((await pageA.locator('.import-report').innerText()).includes('CRS'), 'no CRS message');
  check(await pageA.getByRole('button', { name: 'نشر الحدود' }).isDisabled(), 'publish enabled for rejected file');
  await pageA.getByRole('button', { name: 'إلغاء دون نشر' }).click();
  await importFile(pageA, 'boundaries-self-intersecting.geojson');
  await pageA.locator('.import-report').filter({ hasText: 'تقاطع ذاتي' }).waitFor({ timeout: 10000 });
  check(await pageA.getByRole('button', { name: 'نشر الحدود' }).isDisabled(), 'publish enabled with an invalid shape');
  await shot(pageA, 'map-05-rejected-self-intersection');
  await pageA.getByRole('button', { name: 'إلغاء دون نشر' }).click();
  await importFile(pageA, 'sites.shp', 'EPSG:4326');
  await pageA.locator('.large-dialog .error-text').filter({ hasText: 'GeoJSON' }).waitFor({ timeout: 10000 });
  await pageA.getByRole('button', { name: 'إلغاء دون نشر' }).click();
  check((await geometryVersion('04')) === before04 && (await geometryVersion('03')) === before03, 'a refused file changed a boundary version');
  return 'ملف بلا CRS ← مرفوض؛ تقاطع ذاتي ← مرفوض (الشكل الصالح في الملف نفسه لم يُنشر)؛ ‎.shp ← صيغة غير معلنة؛ الإصدارات 03/04 دون تغيير';
});

// MAP-04: irregular polygon, MultiPolygon, polygon with hole (GeoJSON) and KML; reload; same geometry and versions
const v = {};
for (const c of ['01', '02', '05', '11']) v[c] = await geometryVersion(c);
await step('MAP-04', 'استيراد مضلع غير منتظم وMultiPolygon وKML ثم إعادة التحميل: الحدود والإصدار مطابقان', pageA, async () => {
  await importFile(pageA, 'boundaries-campus.geojson');
  await pageA.locator('.import-report').filter({ hasText: 'جاهز للنشر' }).waitFor({ timeout: 10000 });
  check((await pageA.locator('.import-report tbody tr').count()) === 3, 'expected 3 shapes in preview');
  await pageA.getByPlaceholder('مثال: حدود معتمدة من مسح المرافق').fill('حدود اختبار القبول المعتمدة');
  await pageA.getByRole('button', { name: 'نشر الحدود' }).click();
  await pageA.locator('.import-report').filter({ hasText: 'نُشرت الحدود' }).waitFor({ timeout: 10000 });
  await pageA.getByRole('button', { name: 'إغلاق', exact: true }).click();
  await importFile(pageA, 'boundary-01.kml');
  await pageA.locator('.import-report').filter({ hasText: 'جاهز للنشر' }).waitFor({ timeout: 10000 });
  await pageA.getByPlaceholder('مثال: حدود معتمدة من مسح المرافق').fill('حدود KML لاختبار القبول');
  await pageA.getByRole('button', { name: 'نشر الحدود' }).click();
  await pageA.locator('.import-report').filter({ hasText: 'نُشرت الحدود' }).waitFor({ timeout: 10000 });
  await pageA.getByRole('button', { name: 'إغلاق', exact: true }).click();
  await pageA.reload();
  await pageA.waitForSelector('.pin-wrap');
  await selectSite(pageA, '05');
  const detail = await pageA.locator('.map-detail').innerText();
  check(detail.includes('مسجلة · الإصدار ' + (v['05'] + 1)) && detail.includes('عدة أجزاء'), 'site 05 detail: ' + detail.slice(0, 200));
  await pageA.waitForFunction((id) => document.querySelectorAll(`path[data-site="${id}"]`).length > 0, site('05').id);
  check((await subpaths(pageA, '05')) === 2, 'MultiPolygon drawn as ' + (await subpaths(pageA, '05')) + ' parts');
  await shot(pageA, 'map-04-multipolygon-after-reload');
  await selectSite(pageA, '11');
  check((await subpaths(pageA, '11')) === 2, 'polygon with hole not drawn with its hole');
  const fixture = JSON.parse(readFileSync(new URL('boundaries-campus.geojson', FIX), 'utf8'));
  for (const f of fixture.features) {
    const d = (await admin.get('/sites/' + site(f.properties.site_code).id)).body;
    check(d.geometry.version === v[f.properties.site_code] + 1, 'version for ' + f.properties.site_code);
    check(JSON.stringify(d.geometry.geojson.coordinates) === JSON.stringify(f.geometry.coordinates), 'stored coordinates differ for ' + f.properties.site_code);
  }
  check((await geometryVersion('01')) === v['01'] + 1, 'KML version');
  return 'الإصدارات: 02→' + (v['02'] + 1) + '، 05→' + (v['05'] + 1) + ' (MultiPolygon)، 11→' + (v['11'] + 1) + ' (فناء داخلي)، 01→' + (v['01'] + 1) + ' (KML)؛ الإحداثيات المخزنة مطابقة للملف';
});

// MAP-06: draw then cancel (nothing saved), click-draw and edit by the vertex table then save, concurrent edit refused
await step('MAP-06', 'رسم ثم إلغاء، تعديل رؤوس ثم حفظ، وتعديلان متزامنان: لا حفظ عند الإلغاء ولا كتابة فوق التحديث', pageA, async () => {
  await selectSite(pageA, '04');
  const start = await geometryVersion('04');
  await pageA.getByRole('button', { name: 'تحرير سجل الموقع — الحدود' }).click();
  await pageA.locator('.boundary-editor').waitFor();
  const startOver = async () => {
    const b = pageA.getByRole('button', { name: 'البدء برسم جديد' });
    if (await b.isVisible().catch(() => false)) await b.click();
  };
  await startOver();
  const centre = site('04').location;
  const ring = [[0, 0], [0.0012, 0], [0.0012, 0.0009], [0, 0.0009]].map(([a, b]) => (centre.lat - 0.0004 + b).toFixed(6) + ', ' + (centre.lng - 0.0006 + a).toFixed(6)).join('\n');
  await pageA.locator('.boundary-editor textarea').fill(ring);
  await pageA.getByRole('button', { name: 'إضافة كجزء من الحدود' }).click();
  check((await pageA.locator('.vertex-table input').count()) === 8, 'vertex table not filled');
  await pageA.getByRole('button', { name: 'تحقق من الحدود' }).click();
  await pageA.locator('.boundary-editor .note').filter({ hasText: 'الحدود صالحة' }).waitFor();
  await pageA.getByRole('button', { name: 'إلغاء دون حفظ' }).click();
  check((await geometryVersion('04')) === start, 'cancel saved a version');

  await pageA.getByRole('button', { name: 'تحرير سجل الموقع — الحدود' }).click();
  await pageA.locator('.boundary-editor').waitFor();
  await startOver();
  await pageA.getByRole('button', { name: 'رسم الحدود بالنقر' }).click();
  const box = await pageA.locator('.map').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const pts = [[-130, -95], [120, -105], [140, 95], [-110, 115]];
  for (const [dx, dy] of pts) {
    await pageA.mouse.click(cx + dx, cy + dy);
    await pageA.waitForTimeout(150);
  }
  await pageA.mouse.click(cx + pts[0][0], cy + pts[0][1]);
  await pageA.locator('.vertex-table input').first().waitFor({ timeout: 5000 });
  const lat = pageA.locator('.vertex-table input').first();
  const old = Number(await lat.inputValue());
  await lat.fill(String((old + 0.0001).toFixed(7)));
  await lat.blur();
  await pageA.getByPlaceholder('مثال: تحديث الحدود وفق مخطط الصيانة المعتمد').fill('رسم حدود قاعة الاجتماعات للاختبار');
  await pageA.getByRole('button', { name: 'حفظ إصدار جديد' }).click();
  await pageA.locator('#toast').filter({ hasText: 'حُفظت حدود' }).waitFor({ timeout: 10000 });
  const saved = (await admin.get('/sites/' + site('04').id + '/geometry/versions')).body[0];
  check(saved.version === start + 1 && saved.format === 'COORDINATES', 'saved ' + JSON.stringify(saved).slice(0, 120));

  // concurrent edit: the editor starts from version start+1; another session saves start+2 meanwhile
  await pageA.getByRole('button', { name: 'تحرير سجل الموقع — الحدود' }).click();
  await pageA.locator('.boundary-editor').waitFor();
  const other = (await admin.get('/sites/' + site('04').id)).body.geometry.geojson;
  const admin2 = await apiSession('t.admin');
  await setupCall('concurrent save (second session)', admin2.post('/sites/' + site('04').id + '/geometry', { geometry: other, crs: 'EPSG:4326', expectedVersion: start + 1, reason: 'تعديل متزامن من جلسة أخرى', method: 'COORDINATES' }));
  const first = pageA.locator('.vertex-table input').nth(1);
  await first.fill(String((Number(await first.inputValue()) + 0.0002).toFixed(7)));
  await first.blur();
  await pageA.getByPlaceholder('مثال: تحديث الحدود وفق مخطط الصيانة المعتمد').fill('تعديل يبدأ من إصدار أقدم');
  await pageA.getByRole('button', { name: 'حفظ إصدار جديد' }).click();
  await pageA.locator('.boundary-editor .error-text').filter({ hasText: 'تغيّرت حدود' }).waitFor({ timeout: 10000 });
  await shot(pageA, 'map-06-concurrent-edit-refused');
  await pageA.getByRole('button', { name: 'إلغاء دون حفظ' }).click();
  const now = (await admin.get('/sites/' + site('04').id + '/geometry/versions')).body[0];
  check(now.version === start + 2 && now.reason === 'تعديل متزامن من جلسة أخرى', 'stale save overwrote: ' + JSON.stringify(now).slice(0, 120));
  return 'إلغاء ← لا إصدار؛ رسم بالنقر + تعديل بالجدول ← الإصدار ' + (start + 1) + '؛ حفظ من إصدار قديم ← GEOMETRY_STALE والإصدار ' + (start + 2) + ' للجلسة الأخرى';
});

// MAP-07: two installed backgrounds, independent layers and labels, missing aerial imagery stated
await step('MAP-07', 'التبديل بين خلفيتين مثبتتين، وإظهار/إخفاء المناطق والأسماء باستقلال، ونقص الصور الجوية معلن', pageA, async () => {
  const pick = (name) => pickBackground(pageA, name);
  await pick('مخطط المرفق — بيئة القبول');
  await pageA.waitForFunction((id) => document.querySelector('.leaflet-image-layer')?.getAttribute('src')?.includes(id), planId);
  await pick('خلفية إقليمية توضيحية');
  await pageA.waitForFunction((id) => !document.querySelector('.leaflet-image-layer')?.getAttribute('src')?.includes(id), planId);
  check((await pageA.locator('.leaflet-image-layer').count()) === 1, 'more than one background drawn');
  await pageA.getByRole('button', { name: 'الخلفية', exact: true }).click();
  const panel = await pageA.locator('.map-popover').innerText();
  check(panel.includes('لم تثبت حزمة صور جوية'), 'missing aerial imagery not stated');
  await pageA.getByRole('button', { name: 'الخلفية', exact: true }).click();
  await selectSite(pageA, '02');
  await pageA.getByRole('button', { name: 'ملاءمة الاختيار' }).click();
  await pageA.waitForTimeout(1200);
  check((await pathCount(pageA, '02')) > 0, 'zone 02 not drawn');
  await pageA.getByRole('button', { name: 'الطبقات', exact: true }).click();
  await pageA.locator('.map-popover label').filter({ hasText: 'المناطق والمواقع الفرعية' }).locator('input').uncheck();
  await pageA.waitForTimeout(300);
  check((await pathCount(pageA, '02')) === 0, 'zones still drawn after hiding');
  await pageA.getByRole('button', { name: 'الطبقات', exact: true }).click();
  const labelsBefore = await pageA.locator('.pin-label').count();
  await pageA.getByRole('button', { name: 'الأسماء', exact: true }).click();
  check((await pageA.locator('.pin-label').count()) === 0 && labelsBefore > 0, 'labels toggle');
  check((await pathCount(pageA, '02')) === 0, 'labels toggle changed zones');
  await pageA.getByRole('button', { name: 'الطبقات', exact: true }).click();
  await pageA.locator('.map-popover label').filter({ hasText: 'المناطق والمواقع الفرعية' }).locator('input').check();
  await pageA.getByRole('button', { name: 'الطبقات', exact: true }).click();
  await pageA.waitForTimeout(300);
  check((await pathCount(pageA, '02')) > 0 && (await pageA.locator('.pin-label').count()) === 0, 'zones back while labels stay hidden');
  await pageA.getByRole('button', { name: 'الأسماء', exact: true }).click();
  return 'خلفيتان (طرق إقليمية + مخطط مرفق) · المناطق تُخفى دون الأسماء والعكس · «لم تثبت حزمة صور جوية» ظاهرة';
});

// MAP-08: coverage of the selected package for the actual viewport and zoom
await step('MAP-08', 'خارج التغطية وتغطية جزئية: تنبيه مطابق للحزمة المختارة دون خلفية بديلة', pageA, async () => {
  await pickBackground(pageA, 'مخطط المرفق — بيئة القبول');
  await selectSite(pageA, '05');
  await pageA.getByRole('button', { name: 'ملاءمة الموقع على الخريطة' }).click();
  await pageA.waitForSelector('.map-caption.coverage[data-coverage="FULL"]', { timeout: 10000 });
  for (let i = 0; i < 2; i++) {
    await pageA.getByRole('button', { name: 'تصغير الخريطة' }).click();
    await pageA.waitForTimeout(450);
  }
  await pageA.waitForSelector('.map-caption.coverage[data-coverage="PARTIAL"]', { timeout: 10000 });
  const partial = await pageA.locator('.map-caption.coverage').innerText();
  await shot(pageA, 'map-08-partial-coverage');
  await selectSite(pageA, '06');
  await pageA.getByRole('button', { name: 'ملاءمة الموقع على الخريطة' }).click();
  await pageA.waitForSelector('.map-caption.coverage[data-coverage="NONE"]', { timeout: 10000 });
  const none = await pageA.locator('.map-caption.coverage').innerText();
  check(none.includes('مخطط المرفق') && none.includes('خارج تغطية'), 'none message: ' + none);
  check((await pageA.locator('.leaflet-image-layer').count()) === 1, 'a substitute background appeared');
  await pickBackground(pageA, 'خلفية إقليمية توضيحية');
  await pageA.waitForSelector('.map-caption.coverage[data-coverage="FULL"]', { timeout: 10000 });
  return 'جزئي: «' + partial.slice(0, 70) + '…» · خارج: «' + none.slice(0, 60) + '…» · الخلفية الإقليمية: كاملة';
});

// =================================================================================================================
// B. Requester (t.requester, shared services) — manual sign-in path
// =================================================================================================================
const ctxB = await newContext(browser);
const pageB = await ctxB.newPage();
watch(pageB, 't.requester');
const peopleCalls = [];
pageB.on('request', (r) => r.url().includes('/api/v1/people') && peopleCalls.push(r.url()));
await signInManual(pageB, 't.requester');
await pageB.waitForSelector('.pin-wrap');

await step('MAP-01b', 'جهة خارج نطاق مقدم الطلب لا تظهر في البحث', pageB, async () => {
  await openTab(pageB, 'الجهات');
  await pageB.getByLabel('البحث في الجهات', { exact: true }).fill('فريق مرافق');
  await pageB.locator('.tree-note').filter({ hasText: 'لا نتائج ضمن نطاقك' }).waitFor({ timeout: 8000 });
  await pageB.getByLabel('البحث في الجهات', { exact: true }).fill('');
  return 'بحث «فريق مرافق» ← لا نتائج ضمن النطاق';
});

await step('MAP-02', 'موقع رئيسي بلا أب ثم موقع فرعي: يتزامن التحديد والتكبير والمسار والتفاصيل', pageB, async () => {
  await openTab(pageB, 'المواقع');
  const rootRow = pageB.locator('.tree-row').filter({ hasText: 'مجمع المؤسسة' }).first();
  await rootRow.waitFor();
  check((await rootRow.innerText()).includes('سياق للتنقل فقط'), 'ancestor outside scope should be context only');
  const before = await pageB.getAttribute('.map', 'data-view');
  await pageB.getByRole('button', { name: 'فتح مجمع المؤسسة' }).click();
  await pageB.locator('.tree-label').filter({ hasText: 'مركز التدريب الإداري' }).click();
  await pageB.locator('.map-detail h2').filter({ hasText: 'مركز التدريب الإداري' }).waitFor();
  check((await pageB.locator('.map-detail .detail-path').innerText()).includes('مجمع المؤسسة'), 'path missing');
  await pageB.waitForSelector(`.pin-wrap.selected[data-site="${site('05').id}"]`);
  await pageB.waitForFunction((b) => document.querySelector('.map')?.getAttribute('data-view') !== b, before);
  check((await pageB.locator('.tree-row.active').innerText()).includes('مركز التدريب'), 'tree selection not synchronised');
  await pageB.locator('.tree-label').filter({ hasText: 'المبنى المشترك' }).click();
  await pageB.locator('.map-detail h2').filter({ hasText: 'المبنى المشترك' }).waitFor();
  check((await pageB.locator('.map-detail .detail-path').innerText()).includes('موقع رئيسي'), 'main site not labelled');
  // selecting a marker on the map (keyboard: focus + Enter) updates the details too
  await pageB.locator('.leaflet-marker-icon').filter({ has: pageB.locator(`.pin-wrap[data-site="${site('05').id}"]`) }).focus();
  await pageB.keyboard.press('Enter');
  await pageB.locator('.map-detail h2').filter({ hasText: 'مركز التدريب الإداري' }).waitFor();
  await shot(pageB, 'map-02-sub-site-selected');
  return 'الأب خارج النطاق سياق فقط · فرعي ← مسار «مجمع المؤسسة ‹» + تكبير + تحديد في الشجرة · رئيسي بلا أب «المبنى المشترك»';
});

await step('MAP-03', 'موقع بنقطة فقط: علامة وعبارة غياب الحدود بلا مضلع مولد', pageB, async () => {
  await selectSite(pageB, '08');
  check((await pageB.locator('.map-detail').innerText()).includes('حدود الموقع غير مسجلة'), 'no "boundary not registered" text');
  await pageB.waitForSelector(`.pin-wrap.no-boundary[data-site="${site('08').id}"]`);
  check((await pathCount(pageB, '08')) === 0, 'a polygon is drawn for a point-only site');
  return 'العلامة بإطار متقطع + «حدود الموقع غير مسجلة» + لا path للموقع 08';
});

async function setPeriod(page, mode, start, end) {
  const label = { HOURS: 'بالساعات', DAYS: 'بالأيام', OPEN: 'مفتوحة المدة' }[mode];
  await page.getByRole('radio', { name: label }).click();
  await page.getByLabel('بداية الفترة').fill(start);
  if (end) await page.getByLabel('نهاية الفترة').fill(end);
  await page.waitForTimeout(900);
}
async function resourcePill(page, name) {
  const row = page.locator('.resource-list li').filter({ hasText: name }).first();
  await row.waitFor();
  return (await row.locator('.pill').innerText()).trim();
}
/** Waits until the resource shows the given state label (the screen follows the server; no fixed sleep). */
async function waitPill(page, name, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = (await resourcePill(page, name)).replace(/^[^\s]+\s/, '');
    if (last === label) return last;
    await sleep(250);
  }
  throw new Error(`«${name}» shows «${last}», expected «${label}»`);
}
async function apiState(api, siteCode, resCode, from, to) {
  const q = '/map/features?siteIds=' + site(siteCode).id + '&from=' + encodeURIComponent(from) + (to ? '&to=' + encodeURIComponent(to) : '&open=true');
  const f = (await api.get(q)).body.features[0];
  return f.resources.find((r) => r.code === resCode).state;
}
const LABEL = { FREE: 'متاح', BLOCKED: 'غير متاح', SHARED_IN_USE: 'مشترك — مستخدم' };

await step('MAP-09', 'الفترة بالساعات ثم الأيام ثم المفتوحة: الألوان ونتيجة API مطابقتان عند الحدود الزمنية', pageB, async () => {
  await selectSite(pageB, '02');
  const cases = [
    ['HOURS', D + 'T12:00', D + 'T14:00', 'FREE'],
    ['HOURS', D + 'T11:00', D + 'T13:00', 'BLOCKED'],
    ['HOURS', D + 'T06:00', D + 'T08:00', 'FREE'],
    ['DAYS', D, addDays(D, 1), 'BLOCKED'],
    ['DAYS', addDays(D, 1), addDays(D, 2), 'FREE'],
    ['OPEN', D, null, 'BLOCKED'],
  ];
  const seen = [];
  for (const [mode, s, e, expected] of cases) {
    await setPeriod(pageB, mode, s, e);
    const from = mode === 'HOURS' ? dubai(s) : dubai(s.slice(0, 10));
    const to = e ? (mode === 'HOURS' ? dubai(e) : dubai(e.slice(0, 10))) : null;
    const api = await apiState(requesterApi, '02', 'R-02', from, to);
    check(api === expected, `${mode} ${s}→${e}: API ${api}, expected ${expected}`);
    await waitPill(pageB, 'مركز الخدمات', LABEL[api]);
    seen.push(`${mode} ${s.slice(5)}→${e ? e.slice(5) : '∞'}: ${LABEL[api]}`);
  }
  await shot(pageB, 'map-09-open-period');
  return seen.join(' · ');
});

await step('MAP-10', 'موقع مشترك ومورد حصري فرعي: إشغال جزئي وحالة كل مورد', pageB, async () => {
  await selectSite(pageB, '11');
  await setPeriod(pageB, 'DAYS', D, addDays(D, 2));
  await pageB.locator('.state-banner').filter({ hasText: 'إشغال جزئي' }).waitFor({ timeout: 8000 });
  const a = await waitPill(pageB, 'مكتب الاستقبال', 'غير متاح');
  const b = await waitPill(pageB, 'القاعة متعددة الاستخدام', 'متاح');
  const s = await waitPill(pageB, 'استخدام المبنى المشترك', 'مشترك — مستخدم');
  const detail = await pageB.locator('.map-detail').innerText();
  check(detail.includes('الخدمات المشتركة') && detail.includes('إدارة التقنية'), 'both occupants should be listed');
  await shot(pageB, 'map-10-partial-occupancy');
  return 'المكتب: ' + a + ' · القاعة: ' + b + ' · الاستخدام المشترك: ' + s + ' · الشاغلون: جهتان';
});

let mapRequest = null;
const H1 = addDays(D, 3);
await step('MAP-11', 'طلب من الخريطة يحتفظ بالجهة والموارد والفترة، والعودة للخريطة لا تفقد الإدخال', pageB, async () => {
  await selectSite(pageB, '05');
  await setPeriod(pageB, 'HOURS', H1 + 'T09:00', H1 + 'T11:00');
  await pageB.getByLabel('اختيار مركز التدريب الإداري — قاعة التدريب أ').check();
  const mainBox = pageB.getByLabel('اختيار مركز التدريب الإداري', { exact: true });
  if (await mainBox.isChecked()) await mainBox.uncheck();
  await requestAction(pageB.locator('.map-detail'), 'طلب استخدام مؤقت');
  const drawer = pageB.locator('aside.request-drawer');
  await drawer.waitFor();
  await drawer.getByPlaceholder('مثال: استخدام مركز الخدمات لاستقبال الموظفين').fill('تدريب الموظفين الجدد — اختبار الخريطة');
  await drawer.getByRole('button', { name: 'التالي ←' }).click();
  check(await drawer.getByRole('checkbox', { name: /قاعة التدريب أ/ }).isChecked(), 'resource not carried');
  check(!(await drawer.getByRole('checkbox', { name: /قاعة التدريب ب/ }).isChecked()), 'unexpected resource');
  const inputs = drawer.locator('input[type="datetime-local"]');
  check((await inputs.nth(0).inputValue()) === H1 + 'T09:00' && (await inputs.nth(1).inputValue()) === H1 + 'T11:00', 'period not carried');
  await shot(pageB, 'map-11-drawer-beside-map');
  await drawer.getByRole('button', { name: /^تصغير/ }).click();
  await pageB.locator('.request-drawer.minimized').waitFor();
  await pageB.getByLabel('اختيار مركز التدريب الإداري — قاعة التدريب ب').check();
  await requestAction(pageB.locator('.map-detail'), 'طلب استخدام مؤقت');
  const banner = pageB.locator('.selection-change');
  await banner.waitFor();
  check((await banner.innerText()).includes('الموارد'), 'change not shown before applying');
  await banner.getByRole('button', { name: 'إبقاء المسودة كما هي' }).click();
  check(!(await drawer.getByRole('checkbox', { name: /قاعة التدريب ب/ }).isChecked()), 'draft changed without confirmation');
  await drawer.getByRole('button', { name: 'السابق' }).click();
  check((await drawer.getByPlaceholder('مثال: استخدام مركز الخدمات لاستقبال الموظفين').inputValue()).includes('تدريب الموظفين'), 'subject lost');
  return 'الجهة والمورد والفترة منقولة · التصغير يُظهر الخريطة · اختيار جديد يُعرض أثره (الموارد) ولا يطبق إلا بالموافقة · العنوان محفوظ';
});

await step('MAP-12a', 'إرسال الطلب: قيد المراجعة دون حجز نهائي، والإلغاء لا يحفظ شيئاً', pageB, async () => {
  const drawer = pageB.locator('aside.request-drawer');
  await drawer.getByRole('button', { name: 'التالي ←' }).click();
  await drawer.getByRole('button', { name: 'التالي ←' }).click();
  await drawer.getByPlaceholder('مبرر الطلب').fill('تدريب دوري للموظفين الجدد في قاعة التدريب أ');
  await drawer.getByRole('button', { name: 'التالي ←' }).click();
  check((await drawer.innerText()).includes('نسخ الحدود'), 'summary does not mention boundary versions');
  await drawer.getByRole('button', { name: 'إرسال الطلب' }).click();
  await pageB.locator('#toast').filter({ hasText: 'لم ينشأ حجز نهائي' }).waitFor({ timeout: 15000 });
  const mine = (await requesterApi.get('/requests?status=SUBMITTED&size=50')).body.items.find((r) => r.subject?.includes('تدريب الموظفين الجدد'));
  check(mine, 'submitted request not found');
  mapRequest = mine.id;
  const d = (await requesterApi.get('/requests/' + mapRequest)).body;
  check(d.origin === 'MAP' && d.resources.length === 1, 'origin/resources');
  check(d.reservations.length === 0, 'a reservation exists for a submitted request');
  await waitPill(pageB, 'قاعة التدريب أ', 'متاح');
  await pageB.getByRole('radio', { name: 'حالة الطلبات' }).click();
  await pageB.waitForSelector(`.pin-wrap[data-site="${site('05').id}"] .pin-badge`, { timeout: 8000 });
  await shot(pageB, 'map-12-pending-orange');
  await pageB.getByRole('radio', { name: 'الإتاحة للفترة' }).click();
  const count = (await requesterApi.get('/requests?size=200')).body.total;
  await requestAction(pageB.locator('.map-detail'), 'طلب استخدام مؤقت');
  await pageB.locator('aside.request-drawer').waitFor();
  await pageB.getByRole('button', { name: 'إغلاق الطلب دون حفظ' }).click();
  check((await requesterApi.get('/requests?size=200')).body.total === count, 'closing the drawer saved a request');
  return 'الطلب ' + d.number + ' قيد المراجعة (⏳) · لا حجز ولا قفل · المورد يبقى متاحاً · الإغلاق دون حفظ لا ينشئ طلباً';
});

/** A point on the map whose topmost element is the map itself (no marker, boundary or control). */
async function emptyMapPoint(page) {
  return page.evaluate(() => {
    const m = document.querySelector('.map').getBoundingClientRect();
    for (let fy = 0.85; fy > 0.2; fy -= 0.05)
      for (let fx = 0.1; fx < 0.9; fx += 0.04) {
        const x = m.left + m.width * fx, y = m.top + m.height * fy;
        const el = document.elementFromPoint(x, y);
        if (el && (el.classList.contains('leaflet-container') || el.classList.contains('leaflet-image-layer') || el.tagName === 'svg' || el.classList.contains('leaflet-pane'))) return { x, y };
      }
    return null;
  });
}
/** A point inside the site's drawn boundary that is not covered by a marker. */
async function boundaryPoint(page, siteId) {
  return page.evaluate((id) => {
    const paths = [...document.querySelectorAll(`path[data-site="${id}"]`)];
    for (const p of paths) {
      const b = p.getBoundingClientRect();
      for (let fy = 0.2; fy < 0.85; fy += 0.07)
        for (let fx = 0.2; fx < 0.85; fx += 0.07) {
          const x = b.left + b.width * fx, y = b.top + b.height * fy;
          if (document.elementFromPoint(x, y) === p) return { x, y };
        }
    }
    return null;
  }, siteId);
}

await step('MAP-19', 'نقر الموقع على الخريطة يفتح قائمة بالإجراءين بجوار الموقع، تتبعه عند التحريك، تغلق بـEsc والنقر خارجها، وتنقل النوع والموقع إلى النموذج دون كتابة', pageB, async () => {
  const before = (await requesterApi.get('/requests?size=200')).body.total;
  const S = site('11');
  await selectSite(pageB, '11');
  await pageB.getByRole('button', { name: 'إغلاق التفاصيل' }).click();
  const pin = pageB.locator(`.pin-wrap[data-site="${S.id}"]`);
  const menu = pageB.locator('.site-menu');
  const menuOpen = (label) => menu.waitFor({ timeout: 8000 }).catch(() => { throw new Error('menu not shown after ' + label); });
  const mapBox = await pageB.locator('.map').boundingBox();
  const within = (b, box) => b.x >= box.x - 1 && b.y >= box.y - 1 && b.x + b.width <= box.x + box.width + 1 && b.y + b.height <= box.y + box.height + 1;

  // 1. one click on the marker: compact menu at the site, two labelled actions from the published types
  await pin.click();
  await menuOpen('marker click');
  check((await menu.innerText()).includes(S.name), 'menu does not show the site name');
  const temp = menu.getByRole('button', { name: 'طلب استخدام مؤقت', exact: true });
  const open = menu.getByRole('button', { name: 'طلب استخدام مفتوح المدة', exact: true });
  await pageB.waitForFunction(() => document.querySelector('.site-menu .site-actions:not([aria-busy])'));
  check((await temp.isEnabled()) && (await open.isEnabled()), 'actions not available to the requester');
  const mb = await menu.boundingBox();
  const pb = await pin.boundingBox();
  check(within(mb, mapBox), 'menu leaves the map');
  check(Math.abs(mb.x + mb.width / 2 - pb.x) <= mb.width / 2 + 2 && mb.y + mb.height <= pb.y + 4, 'menu not anchored above the marker');
  await shot(pageB, 'map-19-site-menu');

  // 2. panning the map keeps the menu on the same site
  const e = await emptyMapPoint(pageB);
  check(e, 'no empty map point found');
  await pageB.mouse.move(e.x, e.y);
  await pageB.mouse.down();
  await pageB.mouse.move(e.x - 80, e.y + 50, { steps: 10 });
  await pageB.mouse.up();
  await pageB.waitForTimeout(300);
  check(await menu.isVisible(), 'menu closed while panning');
  const pb2 = await pin.boundingBox();
  const mb2 = await menu.boundingBox();
  check(Math.abs(pb2.x - pb.x + 80) < 6 && Math.abs(pb2.y - pb.y - 50) < 6, 'the map did not pan');
  // the menu may be held inside the map edge, but its pointer stays on the site and it keeps its distance above it
  const ab = await menu.locator('.site-menu-arrow').boundingBox();
  check(ab && Math.abs(ab.x + ab.width / 2 - (pb2.x + pb2.width / 2)) < 6, 'menu pointer left the site while panning');
  check(Math.abs(pb2.y - (mb2.y + mb2.height) - (pb.y - (mb.y + mb.height))) < 4, 'menu did not follow the site vertically');
  check(within(mb2, mapBox), 'menu left the map while panning');

  // 3. Escape closes and returns focus to the marker; Enter on the marker reopens it with focus on the first action
  await pageB.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  const focused = await pageB.evaluate(() => document.activeElement?.querySelector('.pin-wrap')?.getAttribute('data-site'));
  check(focused === S.id, 'focus not returned to the marker');
  await pageB.keyboard.press('Enter');
  await menuOpen('Enter on the focused marker');
  await pageB.waitForFunction(() => document.activeElement?.closest('.site-menu') && document.activeElement.textContent.includes('طلب استخدام مؤقت'), null, { timeout: 5000 });

  // 4. a click on the empty map closes; a click on the registered boundary opens it at that point
  const e2 = await emptyMapPoint(pageB);
  await pageB.mouse.click(e2.x, e2.y);
  await menu.waitFor({ state: 'detached' });
  const bp = await boundaryPoint(pageB, S.id);
  check(bp, 'no clickable point inside the boundary of ' + S.code);
  await pageB.mouse.click(bp.x, bp.y);
  await menuOpen('boundary click');
  const mb3 = await menu.boundingBox();
  check(Math.abs(mb3.x + mb3.width / 2 - bp.x) <= mb3.width / 2 + 2, 'boundary menu not anchored at the clicked point');

  // 5. temporary use: the chosen type and the site go to the drawer; with several resources none is claimed silently
  await requestAction(menu, 'طلب استخدام مؤقت');
  await menu.waitFor({ state: 'detached' });
  const drawer = pageB.locator('aside.request-drawer');
  await drawer.waitFor();
  const ctxText = await drawer.locator('.wizard-context').innerText();
  check(ctxText.includes(S.name) && ctxText.includes(TYPE_NAME), 'drawer does not show the site and the chosen type: ' + ctxText);
  check((await drawer.locator('.type-button.active').innerText()).includes(TYPE_NAME), 'wizard selected another type');
  await drawer.getByRole('button', { name: 'التالي ←' }).click();
  const siteBoxes = drawer.locator('.site-pick-grid').first().locator('input[type="checkbox"]');
  const n = await siteBoxes.count();
  check(n === S.resources.length, 'the drawer does not offer the site resources first (' + n + ')');
  for (let i = 0; i < n; i++) check(!(await siteBoxes.nth(i).isChecked()), 'a resource was preselected on a multi-resource site');
  await drawer.getByRole('button', { name: 'التالي ←' }).click();
  check((await drawer.locator('#wizardError').innerText()).includes(S.name), 'missing resource not explained');
  await shot(pageB, 'map-19-drawer-asks-resource');
  await drawer.getByRole('button', { name: 'إغلاق الطلب دون حفظ' }).click();

  // 6. open-ended use from the same menu: the drawer opens with an open end
  await pin.click();
  await menuOpen('second marker click');
  await pageB.waitForFunction(() => document.querySelector('.site-menu .site-actions:not([aria-busy])'));
  await requestAction(menu, 'طلب استخدام مفتوح المدة');
  await drawer.waitFor();
  check((await drawer.locator('.wizard-context').innerText()).includes('مفتوحة المدة'), 'open end not carried');
  await drawer.getByRole('button', { name: 'التالي ←' }).click();
  check(await drawer.getByRole('checkbox', { name: /استخدام دائم/ }).isChecked(), 'open-ended flag not set');
  await drawer.getByRole('button', { name: 'إغلاق الطلب دون حفظ' }).click();

  // 7. the site tree opens the same menu beside the row
  await openTab(pageB, 'المواقع');
  const rowButton = pageB.getByRole('button', { name: 'طلب استخدام «' + S.name + '»' }).first();
  await rowButton.click();
  await menuOpen('tree row button');
  check((await menu.innerText()).includes(S.name), 'tree menu shows another site');
  check(await menu.getByRole('button', { name: 'طلب استخدام مؤقت', exact: true }).isVisible(), 'tree menu without the actions');
  await shot(pageB, 'map-19-tree-menu');
  await pageB.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });

  check((await requesterApi.get('/requests?size=200')).body.total === before, 'opening or closing the menu or the drawer created a request');
  return 'نقرة واحدة ← قائمة «' + S.name + '» فوق العلامة · تتبع الموقع عند السحب · Esc يعيد التركيز للعلامة · Enter يفتحها والتركيز على الإجراء · نقر الحدود يفتحها عند النقطة · النوع «' + TYPE_NAME + '» والموقع في النموذج · ' + n + ' موارد دون اختيار صامت · المفتوح المدة يصل بنهاية مفتوحة · الشجرة تفتح القائمة نفسها · لا طلب أنشئ';
});

// =================================================================================================================
// C. Reviewer / approver (t.approver)
// =================================================================================================================
const ctxC = await newContext(browser);
const pageC = await ctxC.newPage();
watch(pageC, 't.approver');
const peopleCallsC = [];
pageC.on('request', (r) => r.url().includes('/api/v1/people') && peopleCallsC.push(r.url()));
await signInAutomatic(pageC, 't.approver');
await pageC.waitForSelector('.pin-wrap');

await step('MAP-01', 'جهة من فرع بعيد بالبحث وبالشجرة ترشح المواقع المخولة دون تنزيل الأشخاص', pageC, async () => {
  await openTab(pageC, 'الجهات');
  await pageC.getByLabel('البحث في الجهات', { exact: true }).fill('فريق مرافق');
  const hit = pageC.locator('.tree-hit').filter({ hasText: 'فريق مرافق الشمال' });
  await hit.waitFor({ timeout: 8000 });
  check((await hit.innerText()).includes('إدارة المشاريع'), 'path of the remote branch missing');
  await hit.click();
  await pageC.locator('.context-summary').filter({ hasText: 'فريق مرافق الشمال' }).waitFor();
  const list = pageC.locator('.org-sites');
  await list.filter({ hasText: 'مستودع اللوازم الشمالي' }).waitFor({ timeout: 10000 });
  check((await list.innerText()).includes('الجهة مسؤولة'), 'relation not shown');
  check((await pageC.locator('.org-sites li').count()) === 1, 'other sites were included');
  await shot(pageC, 'map-01-remote-branch');
  // by tree: a fresh page, then open the branch level by level
  await pageC.getByRole('button', { name: 'إزالة' }).click();
  await pageC.reload();
  await pageC.waitForSelector('.pin-wrap');
  await openTab(pageC, 'الجهات');
  await pageC.getByRole('button', { name: 'فتح المؤسسة' }).click();
  await pageC.getByRole('button', { name: 'فتح إدارة المشاريع' }).click();
  await pageC.getByRole('button', { name: 'فتح قسم مشاريع المباني' }).click();
  await pageC.getByRole('button', { name: 'فتح وحدة الصيانة الإدارية' }).click();
  await pageC.locator('.tree-label').filter({ hasText: 'فريق مرافق الشمال' }).click();
  await pageC.locator('.org-sites').filter({ hasText: 'مستودع اللوازم الشمالي' }).waitFor({ timeout: 10000 });
  check(peopleCalls.length === 0 && peopleCallsC.length === 0, 'people were requested: ' + peopleCallsC.length);
  await pageC.getByRole('button', { name: 'إزالة' }).click();
  return 'بحث: مسار «… إدارة المشاريع …» ← موقع واحد «مستودع اللوازم الشمالي» (الجهة مسؤولة) · الشجرة: 4 مستويات تحميل تدريجي · طلبات /people: 0';
});

await step('MAP-12b', 'المراجع يرى الطلب بحدوده المسجلة ويعيده بسبب، ثم يعدّله مقدمه ويعيد تقديمه', pageC, async () => {
  await decideStages(mapRequest, false);
  await pageC.goto(BASE + '/#review');
  const number = (await approverApi.get('/requests/' + mapRequest)).body.number;
  await pageC.locator('.inbox-item').filter({ hasText: number }).click();
  await pageC.locator('.pinned-boundaries').filter({ hasText: 'المراجعة 1' }).waitFor({ timeout: 10000 });
  check((await pageC.locator('.pinned-boundaries').innerText()).includes('الإصدار'), 'boundary version not shown to the reviewer');
  await shot(pageC, 'map-12-review-with-pinned-boundaries');
  await pageC.getByRole('button', { name: /^(إرجاع للتصحيح|طلب تصحيح)$/ }).click();
  await pageC.getByPlaceholder('اكتب سبب القرار أو الملاحظة…').fill('يرجى تعديل وقت الانتهاء إلى الظهر');
  await pageC.getByRole('button', { name: 'تأكيد القرار' }).click();
  await pageC.locator('#toast').filter({ hasText: 'أعيد الطلب' }).waitFor({ timeout: 10000 });
  // requester edits and resubmits from the requests list
  await pageB.goto(BASE + '/#requests');
  await pageB.locator('tr').filter({ hasText: number }).getByRole('button', { name: 'تعديل وإرسال' }).click();
  const dlg = pageB.locator('dialog.large-dialog[open]');
  await dlg.waitFor();
  await dlg.getByRole('button', { name: 'التالي ←' }).click();
  await dlg.locator('input[type="datetime-local"]').nth(1).fill(H1 + 'T12:00');
  await dlg.getByRole('button', { name: 'التالي ←' }).click();
  await dlg.getByRole('button', { name: 'التالي ←' }).click();
  await dlg.getByPlaceholder('ما الذي تغيّر بعد الإرجاع؟').fill('مُدد وقت الانتهاء إلى الظهر');
  await pageB.locator('#toast').waitFor({ state: 'hidden', timeout: 10000 }); // the first submission's message is gone
  await dlg.getByRole('button', { name: 'إرسال الطلب' }).click();
  await pageB.locator('#toast').filter({ hasText: 'لم ينشأ حجز نهائي' }).waitFor({ timeout: 15000 });
  const d = (await requesterApi.get('/requests/' + mapRequest)).body;
  check(d.status === 'SUBMITTED' && d.revision === 2 && d.reservations.length === 0, 'resubmission: ' + d.status + ' r' + d.revision);
  return 'إرجاع بسبب ← تعديل الفترة ← المراجعة 2 قيد المراجعة · لا حجز';
});

let winner = null;
await step('MAP-13', 'اعتمادان متزامنان لمورد حصري متعارض: ينجح أحدهما فقط وتتحدث الخريطة من الخادم', pageC, async () => {
  const P = addDays(D, 5);
  const x = await submitted(requesterApi, meSS, [res('R-02').id], dubai(P + 'T09:00'), dubai(P + 'T13:00'), 'تعارض X');
  const y = await submitted(requesterApi, meSS, [res('R-02').id], dubai(P + 'T10:00'), dubai(P + 'T14:00'), 'تعارض Y');
  await decideStages(x, false);
  await decideStages(y, false);
  const ctxC1 = await newContext(browser);
  const pageC1 = await ctxC1.newPage();
  watch(pageC1, 't.approver (fresh)');
  await signInAutomatic(pageC1, 't.approver');
  const ctxC2 = await newContext(browser);
  const pageC2 = await ctxC2.newPage();
  watch(pageC2, 't.approver2');
  await signInAutomatic(pageC2, 't.approver2');
  const open = async (page, id) => {
    await page.goto(BASE + '/#review');
    const number = (await approverApi.get('/requests/' + id)).body.number;
    await page.locator('.inbox-item').filter({ hasText: number }).click();
    await page.getByRole('button', { name: /اعتماد وتوقيع/ }).click();
    await page.getByRole('checkbox', { name: /أؤكد اعتماد المراجعة/ }).check();
  };
  await open(pageC1, x);
  await open(pageC2, y);
  await Promise.all([pageC1.getByRole('button', { name: 'تأكيد القرار' }).click(), pageC2.getByRole('button', { name: 'تأكيد القرار' }).click()]);
  await sleep(3000);
  const sx = (await approverApi.get('/requests/' + x)).body.status;
  const sy = (await approverApi.get('/requests/' + y)).body.status;
  check([sx, sy].sort().join() === 'APPROVED,SUBMITTED', 'statuses ' + sx + '/' + sy);
  const loserPage = sx === 'APPROVED' ? pageC2 : pageC1;
  await loserPage.locator('dialog[open] .error-text').filter({ hasText: 'تعذر تثبيت الحجز' }).waitFor({ timeout: 8000 });
  await shot(loserPage, 'map-13-conflict-refused');
  winner = sx === 'APPROVED' ? x : y;
  const reservations = (await approverApi.get('/reservations?resourceId=' + res('R-02').id + '&status=ACTIVE')).body.filter((r) => r.period.start.startsWith(P.slice(0, 7)) && [x, y].includes(r.requestId));
  check(reservations.length === 1, 'reservations created: ' + reservations.length);
  await ctxC1.close();
  await ctxC2.close();
  await pageC.goto(BASE + '/#map');
  await selectSite(pageC, '02');
  await setPeriod(pageC, 'HOURS', P + 'T10:00', P + 'T12:00');
  await waitPill(pageC, 'مركز الخدمات', 'غير متاح');
  return 'نجح ' + (sx === 'APPROVED' ? 'X' : 'Y') + ' فقط، الآخر «تعذر تثبيت الحجز» ويبقى قيد المراجعة · حجز واحد · الخريطة: غير متاح';
});

await step('MAP-14', 'تعديل الحدود بعد الاعتماد: الطلب ومستنده على النسخة الأصلية والخريطة على الإصدار الجديد', pageC, async () => {
  const pinnedBefore = (await approverApi.get('/requests/' + winner + '/boundaries')).body.boundaries[0];
  const current = (await admin.get('/sites/' + site('02').id)).body;
  const moved = JSON.parse(JSON.stringify(current.geometry.geojson));
  moved.coordinates[0] = moved.coordinates[0].map(([x, y]) => [Number((x + 0.0002).toFixed(7)), y]);
  await setupCall('later boundary change (facility manager)', admin.post('/sites/' + site('02').id + '/geometry', { geometry: moved, crs: 'EPSG:4326', expectedVersion: current.geometryVersion, reason: 'توسعة لاحقة بعد الاعتماد', method: 'COORDINATES' }));
  const pinned = (await approverApi.get('/requests/' + winner + '/boundaries')).body.boundaries[0];
  check(pinned.version === pinnedBefore.version && pinned.currentVersion === current.geometryVersion + 1, 'pinned version changed');
  check(JSON.stringify(pinned.geojson.coordinates) === JSON.stringify(current.geometry.geojson.coordinates), 'pinned geometry changed');
  const doc = (await approverApi.get('/requests/' + winner)).body.approvalDocument;
  check(doc?.boundaryVersions?.[0]?.version === pinned.version, 'approval document lost the boundary version');
  await pageC.goto(BASE + '/#review');
  const number = (await approverApi.get('/requests/' + winner)).body.number;
  await pageC.locator('.inbox-item').filter({ hasText: number }).click();
  await pageC.locator('.pinned-boundaries').filter({ hasText: 'عُدّلت حدود السجل لاحقاً' }).waitFor({ timeout: 10000 });
  check((await pageC.locator('.document-boundaries').innerText()).includes('الإصدار ' + pinned.version), 'document view lost the version');
  await shot(pageC, 'map-14-document-keeps-original-version');
  await pageC.goto(BASE + '/#map');
  await selectSite(pageC, '02');
  check((await pageC.locator('.map-detail').innerText()).includes('الإصدار ' + (current.geometryVersion + 1)), 'map not on the new version');
  return 'الطلب ' + number + ': الإصدار ' + pinned.version + ' (المستند كذلك) · الخريطة: الإصدار ' + (current.geometryVersion + 1);
});

// =================================================================================================================
// D. Roles: summary viewer, facility manager, requester (MAP-15)
// =================================================================================================================
await step('MAP-15', 'عارض ملخص ومدير مرافق ومقدم طلب: لا كشف خارج النطاق في الطبقات والعدادات والبحث والطباعة', pageA, async () => {
  const ctxD = await newContext(browser);
  const pageD = await ctxD.newPage();
  watch(pageD, 't.limited');
  await signInAutomatic(pageD, 't.limited');
  await pageD.waitForSelector('.pin-wrap');
  await pageD.waitForTimeout(1000);
  const drawn = await pageD.$$eval('.pin-wrap', (els) => els.map((e) => e.getAttribute('data-site')));
  const allowed = ['02', '05', '08'].map((c) => site(c).id);
  check(drawn.length > 0 && drawn.every((id) => allowed.includes(id)), 'summary viewer sees other sites: ' + drawn.length);
  check((await pageD.locator('.pin-badge').count()) === 0, 'request counts shown to a summary viewer');
  await selectSite(pageD, '05');
  const detail = await pageD.locator('.map-detail').innerText();
  check(detail.includes('محجوبة في العرض المختصر') && !detail.includes('الخدمات المشتركة'), 'responsible organisation revealed');
  await openTab(pageD, 'المواقع');
  await pageD.getByLabel('البحث في المواقع', { exact: true }).fill('المبنى المشترك');
  await pageD.locator('.tree-note').filter({ hasText: 'لا نتائج' }).waitFor({ timeout: 8000 });
  await pageD.emulateMedia({ media: 'print' });
  const printed = await pageD.locator('.map-detail').innerText();
  check(!printed.includes('الخدمات المشتركة') && (await pageD.locator('.pin-badge').count()) === 0, 'print shows hidden data');
  await shot(pageD, 'map-15-summary-viewer-print');
  await ctxD.close();
  // facility manager (no VIEW): facility data, no request badges or layer
  await pageA.goto(BASE + '/#map');
  await pageA.waitForSelector('.pin-wrap');
  await pageA.waitForTimeout(800);
  check((await pageA.locator('.pin-badge').count()) === 0, 'facility manager sees request counts');
  await pageA.getByRole('button', { name: 'الطبقات', exact: true }).click();
  check(!(await pageA.locator('.map-popover').innerText()).includes('شارات الطلبات'), 'request layer offered to facility manager');
  await pageA.getByRole('button', { name: 'الطبقات', exact: true }).click();
  // requester: other organisations' sites are absent from layers and search
  await pageB.goto(BASE + '/#map');
  await pageB.waitForSelector('.pin-wrap');
  const reqDrawn = await pageB.$$eval('.pin-wrap', (els) => els.map((e) => e.getAttribute('data-site')));
  check(!reqDrawn.includes(site('06').id) && !reqDrawn.includes(site('10').id), 'requester sees sites outside scope');
  await openTab(pageB, 'المواقع');
  await pageB.getByLabel('البحث في المواقع', { exact: true }).fill('مكتب التقنية');
  await pageB.locator('.tree-note').filter({ hasText: 'لا نتائج' }).waitFor({ timeout: 8000 });
  await pageB.getByLabel('البحث في المواقع', { exact: true }).fill('');
  return 'الملخص: 3 مواقع فقط، لا جهة مسؤولة ولا شارات طلبات، البحث والطباعة دون كشف · مدير المرافق: لا عدادات طلبات · مقدم الطلب: لا مواقع جهات أخرى (الاختبارات الخلفية MAP-15 تغطي API والتصدير)';
});

// =================================================================================================================
// E. Slow, reversed and failed responses; scope change in session (MAP-16)
// =================================================================================================================
await step('MAP-16', 'استجابات بطيئة ومعكوسة وفاشلة وتغيير النطاق: لا بيانات قديمة كحديثة ولا إعادة تكبير إجبارية', pageB, async () => {
  const page = pageB;
  await page.goto(BASE + '/#map');
  await page.waitForSelector('.pin-wrap');
  let n = 0;
  const viewportCalls = (url) => url.pathname === '/api/v1/map/features' && url.searchParams.has('bbox');
  await page.route(viewportCalls, async (route) => {
    n++;
    if (n === 1) {
      const resp = await route.fetch();
      const body = await resp.json();
      body.features = body.features.map((f) => ({ ...f, name: 'بيانات-متأخرة' }));
      await sleep(2500);
      await route.fulfill({ response: resp, json: body }).catch(() => undefined);
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'تكبير الخريطة' }).click();
  await sleep(600);
  await page.getByRole('button', { name: 'تكبير الخريطة' }).click();
  await sleep(3500);
  check(!(await page.locator('body').innerText()).includes('بيانات-متأخرة'), 'a late response was shown as current');
  const view = await page.getAttribute('.map', 'data-view');
  await page.unroute(viewportCalls);
  // failed refresh: neutral state, no previous colours presented as current
  expectServerErrors(true);
  const failing = (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'خطأ اختباري في الخادم' }) });
  await page.route(viewportCalls, failing);
  await page.getByRole('button', { name: 'تصغير الخريطة' }).click();
  await page.locator('.map-status.error').waitFor({ timeout: 8000 });
  const colours = await page.$$eval('.pin-wrap', (els) => [...new Set(els.map((e) => e.style.getPropertyValue('--pin')))]);
  check(colours.length === 1 && colours[0].toLowerCase() === '#8c9a9e', 'pins not neutral after failure: ' + colours.join());
  check((await page.locator('.map-legend').innerText()).includes('تعذر التحديث'), 'legend not neutral');
  await shot(page, 'map-16-failed-refresh-neutral');
  await page.unroute(viewportCalls, failing);
  expectServerErrors(false);
  await page.getByRole('button', { name: 'تكبير الخريطة' }).click();
  await page.locator('.map-status.error').waitFor({ state: 'detached', timeout: 8000 });
  // the view is never changed by data arriving
  const v1 = await page.getAttribute('.map', 'data-view');
  await setPeriod(page, 'DAYS', addDays(D, 1), addDays(D, 2));
  await sleep(1500);
  check((await page.getAttribute('.map', 'data-view')) === v1, 'the map re-zoomed after a response');
  // scope change in an open session
  const ctxE = await newContext(browser);
  const pageE = await ctxE.newPage();
  watch(pageE, 't.requester2');
  await signInManual(pageE, 't.requester2');
  await pageE.waitForSelector('.pin-wrap');
  const pmOrg = (await approverApi.get('/organizations/search?q=' + encodeURIComponent('فريق مرافق'))).body[0].id;
  const r2 = (await requester2Api.get('/me')).body;
  const m = await setupCall('grant a temporary scope', admin.post('/memberships', { personId: r2.id, organizationId: pmOrg, roleCode: 'REQUESTER', validFrom: new Date(Date.now() - 60000).toISOString() }));
  await selectSite(pageE, '10');
  await pageE.waitForSelector(`.pin-wrap[data-site="${site('10').id}"]`, { timeout: 10000 });
  await setupCall('end the temporary scope', admin.post('/memberships/' + m.id + '/end', { reason: 'انتهاء التكليف المؤقت (اختبار)' }));
  await pageE.getByRole('button', { name: 'تكبير الخريطة' }).click();
  await pageE.waitForSelector(`.pin-wrap[data-site="${site('10').id}"]`, { state: 'detached', timeout: 10000 });
  await pageE.locator('.map-notice').filter({ hasText: 'لم يعد ضمن نطاقك' }).waitFor({ timeout: 10000 });
  check((await pageE.locator('.map-detail h2').count()) === 0, 'details of a site outside the new scope stayed on screen');
  await ctxE.close();
  return 'ردّ متأخر معكوس لم يظهر · فشل ← ألوان محايدة و«تعذر التحديث» · الرد لا يغيّر العرض (' + view + ') · سحب النطاق ← اختفاء الموقع وتفاصيله في الطلب التالي';
});

// =================================================================================================================
// F. Phone width and keyboard (MAP-17)
// =================================================================================================================
await step('MAP-17', 'عرض هاتف ولوحة مفاتيح: اختيار وإكمال طلب دون سحب ولا أزرار مخفية ولا تمرير أفقي', null, async () => {
  const ctxF = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctxF.newPage();
  watch(page, 't.requester2 phone');
  const noHScroll = async (where) => {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    check(sw <= iw + 1, 'horizontal scroll at ' + where + ': ' + sw + ' > ' + iw);
  };
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: 'إدخال اسم المستخدم وكلمة المرور يدوياً' }).focus();
  await page.keyboard.press('Enter');
  await page.locator('#tm-username').focus();
  await page.keyboard.type('t.requester2');
  await page.keyboard.press('Tab');
  await page.keyboard.type((await import('./lib/browser.mjs')).PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.map-workspace', { timeout: 30000 });
  await page.waitForSelector('.pin-wrap');
  await noHScroll('map');
  await page.locator('.pin-wrap').first().tap();
  const sheet = page.locator('.site-menu.sheet');
  await sheet.waitFor();
  for (const name of ['طلب استخدام مؤقت', 'طلب استخدام مفتوح المدة']) {
    const b = await sheet.getByRole('button', { name, exact: true }).boundingBox();
    check(b && b.x >= 0 && b.x + b.width <= 391 && b.y + b.height <= 845, name + ' outside the phone screen');
  }
  await shot(page, 'map-19-phone-sheet');
  await sheet.getByRole('button', { name: 'إغلاق قائمة الموقع' }).tap();
  await sheet.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'المواقع' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('البحث في المواقع', { exact: true }).focus();
  await page.keyboard.type('مكتب التقنية');
  await page.locator('.tree-hit').first().waitFor();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.locator('.map-detail h2').filter({ hasText: 'مكتب التقنية' }).waitFor({ timeout: 10000 });
  await noHScroll('detail');
  const H2 = addDays(D, 9);
  await page.getByRole('radio', { name: 'بالساعات' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('بداية الفترة').fill(H2 + 'T09:00');
  await page.getByLabel('نهاية الفترة').fill(H2 + 'T10:00');
  const action = page.locator('.map-detail').getByRole('button', { name: 'طلب استخدام مؤقت', exact: true });
  await action.focus();
  const bb = await action.boundingBox();
  check(bb && bb.x >= 0 && bb.x + bb.width <= 391, 'primary action outside the screen');
  await page.keyboard.press('Enter');
  // several published types fit: focus moves to the type list, Enter picks the first one
  if (await page.locator('.map-detail .site-actions.types').waitFor({ timeout: 1500 }).then(() => true, () => false)) {
    await page.waitForFunction((n) => document.activeElement?.textContent?.includes(n), TYPE_NAME);
    await page.keyboard.press('Enter');
  }
  const drawer = page.locator('aside.request-drawer');
  await drawer.waitFor();
  await noHScroll('drawer');
  await drawer.getByPlaceholder('مثال: استخدام مركز الخدمات لاستقبال الموظفين').focus();
  await page.keyboard.type('اجتماع فريق التقنية — اختبار الهاتف');
  for (let i = 0; i < 2; i++) {
    await drawer.getByRole('button', { name: 'التالي ←' }).focus();
    await page.keyboard.press('Enter');
  }
  await drawer.getByPlaceholder('مبرر الطلب').focus();
  await page.keyboard.type('اجتماع أسبوعي لفريق التقنية في المكتب المشترك');
  await drawer.getByRole('button', { name: 'التالي ←' }).focus();
  await page.keyboard.press('Enter');
  await noHScroll('summary');
  const send = drawer.getByRole('button', { name: 'إرسال الطلب' });
  const sb = await send.boundingBox();
  check(sb && sb.x >= 0 && sb.x + sb.width <= 391, 'send button outside the screen');
  await shot(page, 'map-17-phone-summary');
  await send.focus();
  await page.keyboard.press('Enter');
  await page.locator('#toast').filter({ hasText: 'لم ينشأ حجز نهائي' }).waitFor({ timeout: 15000 });
  await noHScroll('after submit');
  await ctxF.close();
  return '390×844 · دخول وتصفح واختيار وطلب وإرسال بلوحة المفاتيح فقط · لا تمرير أفقي · الأزرار داخل الشاشة · لا سحب';
});

// =================================================================================================================
// G. No internet (MAP-18) — the browser blocked every external host throughout; the stack runs without egress
// =================================================================================================================
record('MAP-18', 'حجب الإنترنت مع الحزم المحلية: الخلفيات والحدود والطلب والمراجعة تعمل دون تحميل خارجي', external.length === 0,
  external.length ? 'طلبات خارجية: ' + external.slice(0, 5).join(', ') : 'طلبات المتصفح الخارجية: 0 في كل الجلسات (الخلفيات والحدود والطلب والمراجعة والاعتماد) · تحقق الحاويات: ops/test-env/up-offline.sh');

await shot(pageA, 'map-workspace-overview');
await browser.close();

const summary = {
  run: new Date().toISOString(),
  base: BASE,
  browser: 'Microsoft Edge (playwright-core 1.64.1, headless)',
  day: D,
  durationSeconds: Math.round((Date.now() - t0) / 1000),
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
  externalRequests: external,
  consoleErrors,
  setupCalls: setup.length,
};
writeFileSync(new URL(ONLY ? 'results-only.json' : 'results.json', OUT), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${summary.failed} failed · ${setup.length} setup API calls · external requests ${external.length} · console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.slice(0, 10).join('\n'));
process.exit(summary.failed ? 1 : 0);
