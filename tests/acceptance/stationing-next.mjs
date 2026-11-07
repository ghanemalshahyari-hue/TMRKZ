// The complete access, site, request and posture phase on real pages and real sign-ins (ADR-045), in the separate fictional
// environment (ops/test-env/owner-review.sh, project tmrkz-next on :8096). Every step is a person at the page; forged calls prove
// that hiding a button is not the boundary. Needs a fresh environment: it changes the fictional units it uses.
//
//   BROWSER_PATH=… MOVER_URL=http://localhost:8096 node tests/acceptance/stationing-next.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiSession, BASE, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';
import { partVectors, proposedParts, ringCentre, slowDrag, toScreen } from './geometry-helpers.mjs';

// On the one application (ops/acceptance-main): ACC_NS and ACC_PREFIX name the loaded run; ACC_EVIDENCE keeps evidence out of Git,
// because pages on :8088 can show real units. Defaults keep the separate fictional environments working.
const NS = process.env.ACC_NS ?? 't';
const SFX = process.env.ACC_SUFFIX ?? ' (وهمي)';
const LABEL = (name) => (process.env.ACC_SUFFIX ? name + process.env.ACC_SUFFIX : name);
const PFX = process.env.ACC_PREFIX ?? '';
const UP = process.env.ACC_USER_PREFIX ?? '';
const DY = Number(process.env.ACC_DY ?? 0);
const Y = (lat) => lat + DY;
const DB = process.env.DB_CONTAINER ?? 'tmrkz-next-db-1';
const evidence = process.env.ACC_EVIDENCE ?? fileURLToPath(new URL('../../docs/evidence/stationing-next/', import.meta.url));
mkdirSync(evidence, { recursive: true });
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail: String(detail).slice(0, 400) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 220) : ''}`);
};
const org = (x) => sql(`select md5('${NS}:org:${x}')::uuid`);
const browser = await launch();
const pages = new Map();
const pageAs = async (user) => {
  if (pages.has(user)) return pages.get(user);
  const ctx = await newContext(browser);
  await ctx.addInitScript(() => localStorage.setItem('tmrkz-theme', 'dark'));
  const p = await ctx.newPage();
  watch(p, user);
  await signInManual(p, user);
  pages.set(user, p);
  return p;
};
const go = async (p, hash) => {
  await p.goto(BASE + '/' + hash);
  await p.reload();
  await p.waitForSelector('main#main');
  await p.waitForTimeout(1200);
};
const shot = (p, name) => p.screenshot({ path: evidence + name });
const button = (p, name) => p.getByRole('button', { name, exact: true });
/** MOVER-style visibility: the buttons that must be there, and those that must not. */
const buttons = async (p, id, what, yes, no) => {
  const has = {};
  for (const n of [...yes, ...no]) has[n] = (await button(p, n).count()) > 0;
  const bad = [...yes.filter((n) => !has[n]).map((n) => 'ناقص: ' + n), ...no.filter((n) => has[n]).map((n) => 'زائد: ' + n)];
  ok(bad.length === 0, id, what, bad.join(' | '));
};
// what a new person asks for: one of the roles the installation shows new people
const ASK = process.env.ACC_ASK_ROLE ?? 'POSTURE_VIEWER';
const FINAL_ACCESS = 'اعتماد وتفعيل';
const RECOMMEND = 'إرسال التوصية';
const DECISIONS = ['اعتماد', 'اعتماد عمليات الوحدة', 'اعتماد نهائي', 'تحديد وحدات العلم', 'تفعيل', 'إرجاع للتعديل', 'رفض'];

const openRequest = (p, id) => go(p, '#restationing/' + id);
/** One holder at one stage: sees their own button and nobody else's, then decides. */
const stage = async (who, id, label, code, name) => {
  const p = await pageAs(who);
  await openRequest(p, id);
  await p.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 10000 }).catch(() => undefined);
  await buttons(p, code, `${who}: ${label} فقط`, [label, 'إرجاع للتعديل', 'رفض'], DECISIONS.filter((d) => ![label, 'إرجاع للتعديل', 'رفض'].includes(d)));
  if (name) await shot(p, name);
  await button(p, label).click();
  await p.waitForTimeout(1200);
};
const FULL = (r) => [['p06.h1', 'اعتماد', '09-hierarchy-route.png'], ['p07.h2', 'اعتماد'], ['p08.ops', 'اعتماد عمليات الوحدة', '10-unit-operations.png'], ['p09.fin', 'اعتماد نهائي', '11-final-approval.png']].filter((x) => r || !x[2] || true);
const wholeRoute = async (id, code, { shots = false, fyiUnit = null } = {}) => {
  for (const [who, label, name] of FULL()) await stage(who, id, label, code, shots ? name : null);
  const act = await pageAs('p11.act');
  await openRequest(act, id);
  ok((await button(act, 'تفعيل').count()) === 0, code, 'لا زر تفعيل قبل تحديد وحدات العلم');
  const f = await pageAs('p10.fyi');
  await openRequest(f, id);
  await buttons(f, code, 'p10: تحديد وحدات العلم فقط', ['تحديد وحدات العلم'], DECISIONS.filter((d) => d !== 'تحديد وحدات العلم'));
  await button(f, 'تحديد وحدات العلم').click();
  await f.getByTestId('fyi-send').waitFor();
  if (fyiUnit) await f.locator(`[data-fyi-unit="${fyiUnit}"]`).check();
  if (shots) await shot(f, '12-fyi-units.png');
  await f.getByTestId('fyi-send').click();
  await f.getByTestId('fyi-done').waitFor({ timeout: 10000 });
  await openRequest(act, id);
  await buttons(act, code, 'p11: تفعيل فقط', ['تفعيل'], ['اعتماد', 'اعتماد عمليات الوحدة', 'اعتماد نهائي', 'تحديد وحدات العلم']);
  if (shots) await shot(act, '13-activation.png');
  await button(act, 'تفعيل').click();
  await act.waitForTimeout(1500);
};
const stateOf = (id) => sql(`select state from restationing_request where id = '${id}'`);
const placeArea = async (p, lng, lat) => {
  await button(p, 'تحديد المنطقة على الخريطة').click();
  await p.waitForTimeout(900);
  const at = await toScreen(p, [lng, lat]);
  await p.mouse.click(at.x, at.y);
  await p.waitForTimeout(800);
};
const submitted = async (p) => {
  await p.waitForFunction(() => /^#restationing\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  return p.evaluate(() => location.hash.split('/')[1]);
};

try {
  // ---- ACCESS --------------------------------------------------------------------------------------------------------
  // ACC_RESUME=1 continues a run whose access journey already passed on the same code, since it can run only once per load
  if (process.env.ACC_RESUME !== '1') {
  const p01 = await pageAs('p01.new');
  await p01.getByTestId('access-request').waitFor({ timeout: 10000 });
  ok(true, 'ACCESS-01', 'مستخدم بلا صلاحيات يرى شاشة طلب الصلاحية فقط');
  const nav = (await p01.locator('.tz-top .tz-nav').innerText()).replace(/\s+/g, ' ').trim();
  ok(nav === 'طلب صلاحية', 'ACCESS-02', 'القائمة لا تحوي غيرها', nav);
  await p01.locator('[data-role]').first().waitFor({ timeout: 10000 });
  const offered = await p01.locator('[data-role]').evaluateAll((l) => l.map((e) => e.getAttribute('data-role')));
  ok(offered.includes(ASK) && !offered.includes('SITE_SETUP_ADMIN') && !offered.includes('STATIONING_UNIT_APPROVER'), 'ACCESS-03', 'يختار مما يعرضه مدير النظام، بأسماء عربية', offered.join());
  ok(!(await p01.locator('[data-role]').first().evaluate((e) => e.closest('label').innerText)).includes('VIEW'), 'ACCESS-04', 'لا تظهر أسماء داخلية');
  ok((await p01.locator('[data-scope=ALL]').count()) === 0, 'ACCESS-05', 'النظام بالكامل ليس خياراً');
  await p01.locator(`[data-role=${ASK}]`).check();
  await p01.locator('[data-scope=UNIT_TREE]').check();
  await p01.getByLabel('سبب الطلب').fill('أتابع موقف وحدتي');
  await shot(p01, '01-no-access-request.png');
  await button(p01, 'إرسال طلب الصلاحية').click();
  await p01.getByTestId('access-open').waitFor({ timeout: 10000 });
  ok((await p01.getByTestId('access-status').first().innerText()).includes('بانتظار التوصية'), 'ACCESS-06', 'الحالة بانتظار التوصية');
  const accessId = sql(`select a.request_id from access_request a join person p on p.id = a.person_id where p.username = '${UP}p01.new'`);

  const p02 = await pageAs('p02.access');
  await go(p02, '#accessInbox');
  await p02.getByTestId('access-item').waitFor({ timeout: 10000 });
  await buttons(p02, 'ACCESS-07', 'p02: إرسال التوصية بلا اعتماد وتفعيل', [RECOMMEND, 'إرجاع للتعديل', 'رفض'], [FINAL_ACCESS]);
  ok((await p02.getByTestId('access-extras').count()) === 1, 'ACCESS-08', 'صلاحيات إضافية يضيفها المدير ولا يراها مقدم الطلب');
  await p02.getByLabel('ملاحظة').fill('وضّح حاجتك للمتابعة');
  await button(p02, 'إرجاع للتعديل').click();
  await p02.getByText('لا توجد طلبات تنتظرك').waitFor({ timeout: 10000 });
  await go(p01, '#requestAccess');
  await p01.getByTestId('access-returned').waitFor({ timeout: 10000 });
  ok(true, 'ACCESS-09', 'أُعيد إليه الطلب نفسه للتعديل');
  await p01.locator(`[data-role=${ASK}]`).check();
  await p01.locator('[data-scope=UNIT_TREE]').check();
  await p01.getByLabel('سبب الطلب').fill('أتابع موقف وحدتي وما يتبعها في عملي');
  await button(p01, 'إعادة إرسال الطلب').click();
  await p01.getByTestId('access-open').waitFor({ timeout: 10000 });
  ok(sql(`select count(*) from access_request a join person p on p.id = a.person_id where p.username = '${UP}p01.new'`) === '1', 'ACCESS-10', 'طلب واحد لا طلبان');
  await go(p02, '#accessInbox');
  await p02.getByTestId('access-item').waitFor({ timeout: 10000 });
  // the viewing right is a manager's extra here, so a new person's own list stays the owner's
  if (ASK !== 'POSTURE_VIEWER') await p02.locator('[data-testid=access-extras] [data-role=POSTURE_VIEWER]').check();
  await shot(p02, '02-access-recommendation.png');
  await button(p02, RECOMMEND).click();
  await p02.getByText('لا توجد طلبات تنتظرك').waitFor({ timeout: 10000 });
  ok(sql(`select count(*) from membership m join person p on p.id = m.person_id where p.username = '${UP}p01.new'`) === '0', 'ACCESS-11', 'التوصية لا تمنح شيئاً');
  const api01 = await apiSession('p01.new');
  const openTask = sql(`select id from task_assignment where request_id = '${accessId}' and status = 'OPEN'`);
  const self = await api01.post(`/access-requests/${accessId}/decision`, { taskId: openTask, decision: 'APPROVE', roles: [ASK] });
  ok(self.status >= 400, 'ACCESS-12', 'مقدم الطلب لا يعتمد طلبه بطلب مصنوع', self.status);
  const api02 = await apiSession('p02.access');
  const forged = await api02.post(`/access-requests/${accessId}/decision`, { taskId: openTask, decision: 'APPROVE', roles: [ASK] });
  ok(forged.status >= 400, 'ACCESS-13', 'المراجع المحلي لا يفعّل بطلب مصنوع', forged.status);
  const p03 = await pageAs('p03.final');
  await go(p03, '#accessInbox');
  // this approver reaches every unit, so a request of another acceptance batch may wait here too
  const finalItem = p03.getByTestId('access-item').filter({ hasText: SFX });
  await finalItem.first().waitFor({ timeout: 10000 });
  await buttons(p03, 'ACCESS-14', 'p03: اعتماد وتفعيل بلا إرسال التوصية', [FINAL_ACCESS, 'إرجاع للتعديل', 'رفض'], [RECOMMEND]);
  ok((await finalItem.getByTestId('access-person').innerText()).includes('نشط'), 'ACCESS-15', 'يرى حال الشخص الآن');
  await shot(p03, '03-final-access-approval.png');
  await finalItem.getByRole('button', { name: FINAL_ACCESS, exact: true }).click();
  await finalItem.first().waitFor({ state: 'detached', timeout: 10000 });
  await p01.reload();
  await p01.waitForTimeout(2000);
  const after = (await p01.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
  const postureNow = await api01.get('/operational-posture');
  ok(postureNow.status === 200 && postureNow.body.units.some((u) => u.id === org('N-A111')), 'ACCESS-16', 'الصلاحية نافذة بنطاقها، وOpenFGA يوافق', postureNow.status);
  ok(sql(`select count(*) from audit_event where entity_id = '${accessId}' and action in ('ACCESS_REQUEST_RECOMMENDED', 'ACCESS_REQUEST_FINAL_APPROVED', 'ACCESS_REQUEST_RESUBMITTED', 'ACCESS_REQUEST_SUBMITTED')`) === '4', 'ACCESS-17', 'سجل التدقيق كامل');
  ok(!after.includes('طلب جديد'), 'ACCESS-18', 'لا تظهر له طلبات أخرى', after.slice(0, 200));

  }

  // ---- SITES ---------------------------------------------------------------------------------------------------------
  const p04 = await pageAs('p04.sites');
  await go(p04, '#siteSetup');
  await p04.getByTestId('setup-tree').waitFor({ timeout: 15000 });
  // free ground east of this batch's sites: other acceptance batches may be on the map, and a site that overlaps one is refused
  const freeGround = async () => {
    await p04.evaluate(([x, y]) => document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap.jumpTo({ center: [x, y], zoom: 12 }), [56.3, Y(24.86)]);
    await p04.waitForTimeout(800);
  };
  await p04.getByTestId('add-site').click();
  await shot(p04, '04-site-bootstrap.png');
  await freeGround();
  await p04.getByTestId('draw-site').click();
  await p04.waitForTimeout(500);
  const box = await p04.locator('.tz-mapframe .tz-map-layer canvas').first().boundingBox();
  for (const [dx, dy] of [[0.45, 0.4], [0.55, 0.4], [0.55, 0.5], [0.45, 0.5]]) {
    await p04.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await p04.waitForTimeout(250);
  }
  await p04.waitForTimeout(800);
  await p04.getByLabel('اسم الموقع').fill('موقع جديد للتجربة' + SFX);
  await p04.getByLabel('رمز الموقع').fill(PFX + 'SITE-NEW-1');
  await p04.getByLabel('الموقع الرئيسي').selectOption({ label: 'مجمع الخدمات' + SFX });
  await p04.getByLabel('سبب تسجيل الموقع').fill('تهيئة أولى لموقع جديد');
  await p04.getByTestId('save-site').click();
  await p04.locator(`[data-site="${PFX}SITE-NEW-1"]`).waitFor({ timeout: 15000 });
  ok(true, 'SITE-01', 'موقع يُرسم على الخريطة ويُسجل بسبب');
  ok(sql(`select count(*) from site_geometry_version g join site s on s.id = g.site_id where s.code = '${PFX}SITE-NEW-1'`) === '1', 'SITE-02', 'بحدوده');
  ok(sql(`select count(*) from audit_event where action = 'SITE_CREATED' and detail::text like '%${PFX}SITE-NEW-1%'`) === '1', 'SITE-03', 'مُدقَّق');
  ok(sql(`select count(*) from site s join site p on p.id = s.parent_id where s.code = '${PFX}SITE-NEW-1' and p.code = '${PFX}SITE-02'`) === '1', 'SITE-04', 'موقع فرعي تحت موقع رئيسي، بلا هيكل Oracle');
  // a site of two parts: drawn with the same editor, and it moves as one
  await p04.getByTestId('add-site').click();
  await freeGround();
  await p04.getByTestId('draw-site').click();
  await p04.waitForTimeout(400);
  for (const [dx, dy] of [[0.2, 0.72], [0.26, 0.72], [0.26, 0.8], [0.2, 0.8]]) {
    await p04.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await p04.waitForTimeout(250);
  }
  await p04.waitForTimeout(600);
  await p04.getByTestId('add-part').click();
  await p04.waitForTimeout(400);
  for (const [dx, dy] of [[0.72, 0.42], [0.78, 0.42], [0.78, 0.5], [0.72, 0.5]]) {
    await p04.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await p04.waitForTimeout(250);
  }
  await p04.waitForTimeout(1500);
  const twoParts = await proposedParts(p04);
  ok(twoParts.length === 2, 'SITE-11', 'موقع من جزأين', twoParts.length);
  const from = await toScreen(p04, ringCentre(twoParts[0][0]));
  await slowDrag(p04, from, { x: from.x, y: from.y - 40 }, { steps: 10, pause: 100 });
  const moved2 = await proposedParts(p04);
  const vectors = partVectors(twoParts, moved2);
  ok(moved2.length === 2 && vectors.metres > 1 && vectors.spread < 1, 'SITE-12', 'يتحرك الجزءان معاً', JSON.stringify({ m: Math.round(vectors.metres), spread: vectors.spread }));
  await p04.getByLabel('اسم الموقع').fill('موقع من جزأين للتجربة' + SFX);
  await p04.getByLabel('رمز الموقع').fill(PFX + 'SITE-NEW-2');
  await p04.getByLabel('سبب تسجيل الموقع').fill('تهيئة موقع من جزأين');
  await p04.getByTestId('save-site').click();
  await p04.locator(`[data-site="${PFX}SITE-NEW-2"]`).waitFor({ timeout: 15000 });
  ok(sql(`select GeometryType(g.geom) from site_geometry_version g join site s on s.id = g.site_id where s.code = '${PFX}SITE-NEW-2'`) === 'MULTIPOLYGON', 'SITE-13', 'يُسجل موقعاً واحداً متعدد الأجزاء');
  await p04.locator(`[data-site="${PFX}SITE-NEW-1"]`).click();
  await p04.getByTestId('edit-site').waitFor({ timeout: 10000 });
  await p04.getByTestId('edit-site').getByLabel('الموقع الرئيسي').selectOption('');
  await p04.getByTestId('edit-site').getByLabel('سبب التعديل').fill('صار موقعاً رئيسياً مستقلاً');
  await p04.getByTestId('save-edit').click();
  await p04.waitForTimeout(1500);
  ok(sql(`select parent_id is null from site where code = '${PFX}SITE-NEW-1'`) === 't', 'SITE-04b', 'يتغير الموقع الرئيسي بسبب مسجل');
  await p04.locator(`[data-site="${PFX}SITE-NEW-1"]`).click();
  await p04.getByTestId('edit-shape').waitFor({ timeout: 10000 });
  await p04.getByTestId('edit-site').getByLabel('سبب التعديل').fill('حدود مصححة للتجربة');
  await p04.getByTestId('edit-shape').click();
  await p04.waitForTimeout(800);
  await p04.getByTestId('save-shape').click();
  await p04.waitForTimeout(1500);
  ok(sql(`select count(*) from site_geometry_version g join site s on s.id = g.site_id where s.code = '${PFX}SITE-NEW-1'`) === '2', 'SITE-04c', 'نسخة حدود جديدة تُحفظ، والقديمة باقية');
  await p04.locator(`[data-site="${PFX}SITE-02"]`).first().click();
  await p04.waitForTimeout(800);
  await shot(p04, '06-main-sub-sites.png');
  await p04.locator(`[data-site="${PFX}SITE-01"]`).click();
  await p04.getByTestId('stationed-here').waitFor();
  await p04.waitForTimeout(1500);
  const here = await p04.getByTestId('stationed-here').innerText();
  ok(['القيادة الرئيسية أ', 'القيادة الرئيسية ب', 'القيادة الرئيسية ج', 'القيادة الرئيسية د'].every((n) => here.includes(n)), 'SITE-05', 'أربع جهات رئيسية في موقع واحد', here.slice(0, 200));
  ok((await p04.locator(`[data-site="${PFX}SITE-01"]`).count()) === 1, 'SITE-06', 'موقع واحد لا أربعة');
  await p04.getByLabel('بحث وحدة الربط').fill('إدارة ب1');
  await p04.getByLabel('وحدة الربط', { exact: true }).selectOption({ label: LABEL('إدارة ب1') });
  await p04.getByLabel('سبب الربط').fill('ربط إداري للتجربة');
  await p04.getByTestId('add-link').click();
  await p04.waitForTimeout(1500);
  await shot(p04, '05-one-site-four-units.png');
  const links = await p04.getByTestId('linked-here').innerText();
  ok(links.includes('إدارة ب1'), 'SITE-07', 'الربط يُضاف');
  ok(sql(`select count(*) from org_stationing where organization_id = md5('${NS}:org:N-B1')::uuid and site_id = md5('${NS}:site:SITE-01')::uuid`) === '0', 'SITE-08', 'الربط لا يصنع تمركزاً');
  ok(sql(`select parent_id is null from organization where id = md5('${NS}:org:N-B')::uuid`) === 't', 'SITE-09', 'لا يتغير هيكل Oracle بالمشاركة في الموقع');
  const reqApi = await apiSession('p05.req');
  const seen = await reqApi.get('/sites/' + sql(`select md5('${NS}:site:SITE-01')::uuid`) + '/occupants');
  ok(seen.status === 200 && !JSON.stringify(seen.body).includes('القيادة الرئيسية ب') && seen.body.otherStationed === 4, 'SITE-10', 'جهة من فرع آخر تُعد ولا تُسمّى', JSON.stringify(seen.body).slice(0, 180));

  // ---- THE HUB, INITIAL STATIONING --------------------------------------------------------------------------------------
  const p05 = await pageAs('p05.req');
  await go(p05, '#newRequest');
  await p05.getByTestId('hub-units').waitFor({ timeout: 15000 });
  const row = (x) => p05.locator(`[data-unit="${org(x)}"]`);
  ok((await row('N-A111').getAttribute('data-state')) === 'NO_STATIONING', 'INITIAL-STATIONING-01', 'الحالة من الخادم');
  ok((await row('N-A111').locator('[data-go=INITIAL_STATIONING]').count()) === 1 && (await row('N-A111').locator('[data-go=RESTATIONING]').count()) === 0, 'INITIAL-STATIONING-02', 'وحدة بلا تمركز: طلب تمركز أولي، لا إعادة تمركز');
  ok((await row('N-A112').locator('[data-go=DEPLOYMENT_AREAS]').count()) === 0 && (await row('N-A11').locator('[data-go=DEPLOYMENT_AREAS]').count()) === 1, 'DEPLOYMENT-01', 'طلب منطقة انتشار لمن ينقصه فقط');
  ok((await row('N-A112').locator('[data-go=RESTATIONING]').count()) === 1, 'RESTATIONING-01', 'إعادة التمركز لوحدة متمركزة');
  await shot(p05, '07-new-request-hub.png');
  const noOrigin = await reqApi.post('/restationing-requests', { requestingUnitId: org('N-A11'), content: { kind: 'PERMANENT', scope: [org('N-A113')], reason: 'محاولة مصنوعة', site: { geometry: { type: 'Polygon', coordinates: [[[55.9, 24.7], [55.901, 24.7], [55.901, Y(24.701)], [55.9, 24.7]]] }, shape: 'DRAWN' } } });
  const refused = noOrigin.status === 200 ? await reqApi.post(`/restationing-requests/${noOrigin.body.id}/submit`, {}) : noOrigin;
  ok(refused.status === 400, 'RESTATIONING-02', 'وحدة بلا تمركز لا تُعاد تمركزها بطلب مصنوع', refused.status);
  await row('N-A111').locator('[data-go=INITIAL_STATIONING]').click();
  await p05.getByTestId('initial-sites').waitFor({ timeout: 15000 });
  await p05.locator(`[data-testid=initial-sites] [data-site="${PFX}SITE-01"]`).click();
  await p05.waitForTimeout(1200);
  await shot(p05, '07b-initial-stationing.png');
  await p05.getByTestId('initial-next').click();
  await p05.waitForTimeout(1200);
  await p05.locator('.tz-flow-review textarea').fill('تمركز أولي للشعبة في الموقع المشترك');
  await button(p05, 'حفظ المسودة والفحص').click();
  await p05.waitForTimeout(1200);
  await button(p05, 'إرسال للاعتماد').click();
  const initial = await submitted(p05);
  ok(stateOf(initial) === 'UNDER_REVIEW', 'INITIAL-STATIONING-03', 'أُرسل الطلب');
  const stages = sql(`select string_agg(kind, ',' order by position) from restationing_stage where request_id = '${initial}'`);
  ok(stages === 'HIERARCHY,HIERARCHY,UNIT_OPERATIONS,FINAL', 'APPROVAL-01', 'المسار: تسلسل حقيقي ثم عمليات الوحدة ثم النهائي', stages);
  const forge = await (await apiSession('p08.ops')).post(`/restationing-requests/${initial}/decision`, { decision: 'APPROVE' });
  ok(forge.status === 403, 'APPROVAL-02', 'مرحلة ليس دورها مرفوضة بطلب مصنوع', forge.status);
  const outOfScope = await (await apiSession('p13.other')).post(`/restationing-requests/${initial}/decision`, { decision: 'APPROVE' });
  ok(outOfScope.status >= 403, 'APPROVAL-03', 'من خارج النطاق مرفوض', outOfScope.status);
  const selfDecide = await reqApi.post(`/restationing-requests/${initial}/decision`, { decision: 'APPROVE' });
  ok(selfDecide.body?.code === 'SEPARATION_OF_DUTIES', 'APPROVAL-04', 'مقدم الطلب لا يقرر طلبه', selfDecide.status);
  await wholeRoute(initial, 'APPROVAL-05', { shots: true, fyiUnit: org('N-B1') });
  ok(stateOf(initial) === 'ACTIVATED_PERMANENT', 'INITIAL-STATIONING-04', 'فُعّل');
  ok(sql(`select s.code from org_stationing o join site s on s.id = o.site_id where o.organization_id = md5('${NS}:org:N-A111')::uuid and o.valid_to is null`) === PFX + 'SITE-01', 'INITIAL-STATIONING-05', 'صار للوحدة تمركز معتمد');
  ok(sql(`select count(*) from org_stationing where organization_id = md5('${NS}:org:N-A113')::uuid`) === '0', 'INITIAL-STATIONING-06', 'لا تنتقل الوحدات الأخرى');

  // ---- FYI -------------------------------------------------------------------------------------------------------------
  const p13Api = await apiSession('p13.other');
  ok((await p13Api.get('/restationing-requests/' + initial)).status === 200, 'FYI-01', 'وحدة العلم تقرأ هذا الطلب');
  ok(sql(`select count(*) from notification n join person p on p.id = n.person_id where p.username = '${UP}p13.other' and n.title like 'للعلم:%'`) === '1', 'FYI-02', 'وصل إليها إشعار');
  ok(sql(`select count(*) from membership m join person p on p.id = m.person_id where p.username = '${UP}p13.other' and m.role_code <> 'POSTURE_VIEWER'`) === '0', 'FYI-03', 'لا صلاحية دائمة');
  const p13 = await pageAs('p13.other');
  await openRequest(p13, initial);
  await buttons(p13, 'FYI-04', 'لا أزرار لها', [], DECISIONS);
  ok(sql(`select count(*) from audit_event where entity_id = '${initial}' and action = 'RESTATIONING_FYI_DISTRIBUTED'`) === '1', 'FYI-05', 'مُدقَّق');
  // a person of that unit with no permission at all opens it from their own page; the unit's parent inherits nothing
  const p15 = await pageAs('p15.fyi');
  await p15.getByTestId('fyi-list').waitFor({ timeout: 15000 });
  ok(((await p15.locator('.tz-top .tz-nav').innerText()).replace(/\s+/g, ' ').trim()) === 'طلب صلاحية', 'FYI-07', 'بلا صلاحية: القائمة كما هي، ولا صلاحية جديدة');
  ok(sql(`select count(*) from notification n join person p on p.id = n.person_id where p.username = '${UP}p15.fyi' and n.title like 'للعلم:%'`) === '1', 'FYI-08', 'وصله الإشعار');
  await p15.getByTestId('fyi-list').locator('a').first().click();
  await p15.getByTestId('fyi-read-only').waitFor({ timeout: 15000 });
  await buttons(p15, 'FYI-09', 'يفتح الطلب للاطلاع، بلا أي زر', [], [...DECISIONS, 'تعديل الطلب', 'إرسال للاعتماد']);
  await p15.waitForTimeout(800);
  await shot(p15, '19-fyi-read-only.png');
  const p15Api = await apiSession('p15.fyi');
  ok((await p15Api.get('/restationing-requests/' + initial)).status === 200, 'FYI-10', 'يفتح هذا الطلب');
  const otherReq = sql(`select id from restationing_request where number = 'SEED-N-A112'`);
  ok((await p15Api.get('/restationing-requests/' + otherReq)).status === 404, 'FYI-11', 'ولا يفتح طلباً آخر');
  const f15 = await Promise.all([p15Api.post(`/restationing-requests/${initial}/decision`, { decision: 'APPROVE' }), p15Api.post(`/restationing-requests/${initial}/activate`, {}), p15Api.post(`/restationing-requests/${initial}/fyi`, { units: [] })]);
  ok(f15.every((r) => r.status === 403 || r.status === 400), 'FYI-12', 'الطلبات المصنوعة مرفوضة', f15.map((r) => r.status).join());
  ok(sql(`select count(*) from membership m join person p on p.id = m.person_id where p.username = '${UP}p15.fyi'`) === '0', 'FYI-13', 'لا منحة ولا VIEW');
  const p16Api = await apiSession('p16.branch');
  ok((await p16Api.get('/restationing-requests/' + initial)).status === 404, 'FYI-14', 'الجهة الأعلى لا ترث الاطلاع');
  const fyiForge = await (await apiSession('p06.h1')).post(`/restationing-requests/${initial}/fyi`, { units: [] });
  ok(fyiForge.status === 403, 'FYI-06', 'بلا صلاحيتها مرفوض', fyiForge.status);

  // ---- DEPLOYMENT AREAS ------------------------------------------------------------------------------------------------
  await go(p05, '#newRequest');
  await row('N-A11').locator('[data-go=DEPLOYMENT_AREAS]').click();
  await p05.getByTestId('area-controls').waitFor({ timeout: 20000 });
  await p05.waitForTimeout(2500);
  await placeArea(p05, 56.1195, Y(24.86));
  await p05.getByRole('tab', { name: 'منطقة الانتشار البديلة' }).click();
  await p05.waitForTimeout(900);
  await placeArea(p05, 56.1195, Y(24.8965));
  // moved on the map with the same editor, and nothing is saved while it moves
  const writes = [];
  const onWrite = (r) => { if (r.method() !== 'GET' && !r.url().includes('/stationing/terrain/assess')) writes.push(r.url()); };
  p05.on('request', onWrite);
  const before = await proposedParts(p05);
  const areaAt = await toScreen(p05, ringCentre(before[0][0]));
  await slowDrag(p05, areaAt, { x: areaAt.x + 8, y: areaAt.y + 6 }, { steps: 8, pause: 100 });
  const dragged = await proposedParts(p05);
  p05.off('request', onWrite);
  ok(partVectors(before, dragged).metres > 1, 'DEPLOYMENT-09', 'تُسحب المنطقة على الخريطة');
  ok(writes.length === 0, 'DEPLOYMENT-10', 'صفر كتابة أثناء التعديل على الخريطة', writes.join(' '));
  await shot(p05, '08-deployment-request.png');
  await button(p05, '3D').click();
  await p05.waitForTimeout(3000);
  await shot(p05, '08b-deployment-3d.png');
  await button(p05, '2D').click().catch(() => undefined);
  await button(p05, 'التالي: الفحص والمراجعة').click();
  await p05.waitForTimeout(2000);
  await p05.locator('.tz-flow-review textarea').fill('منطقتا الانتشار لقسم الحركة');
  await button(p05, 'حفظ المسودة والفحص').click();
  await p05.waitForTimeout(2000);
  const review = await p05.locator('.tz-flow-review').innerText();
  ok(review.includes('مستوفاة'), 'DEPLOYMENT-02', 'يفحصها الخادم', review.slice(0, 260));
  await button(p05, 'إرسال للاعتماد').click();
  const deployment = await submitted(p05);
  const dup = await reqApi.post('/restationing-requests', { requestingUnitId: org('N-A11'), purpose: 'DEPLOYMENT_AREAS', content: { kind: 'PERMANENT', scope: [org('N-A11')], reason: 'طلب مكرر' } });
  ok(dup.status === 400, 'DEPLOYMENT-03', 'طلب مكرر مرفوض', dup.status);
  ok(sql(`select count(*) from deployment_area where organization_id = md5('${NS}:org:N-A11')::uuid`) === '0', 'DEPLOYMENT-04', 'لا شيء يُسجل قبل التفعيل');
  await wholeRoute(deployment, 'APPROVAL-06');
  ok(stateOf(deployment) === 'ACTIVATED_PERMANENT', 'DEPLOYMENT-05', 'فُعّل');
  ok(sql(`select count(*) from deployment_area where organization_id = md5('${NS}:org:N-A11')::uuid and state = 'ACTIVE'`) === '2', 'DEPLOYMENT-06', 'منطقتان للوحدة نفسها');
  ok(sql(`select count(*) from org_stationing where organization_id = md5('${NS}:org:N-A11')::uuid and valid_to is null and site_id = md5('${NS}:site:SITE-03')::uuid`) === '1', 'DEPLOYMENT-07', 'لم يتغير تمركزها');
  ok(sql(`select count(*) from deployment_area a where a.organization_id = md5('${NS}:org:N-A')::uuid and a.state = 'ACTIVE'`) === '2', 'DEPLOYMENT-08', 'مناطق الجهات الأخرى كما هي');

  // ---- RE-STATIONING ---------------------------------------------------------------------------------------------------
  await go(p05, '#newRequest');
  await row('N-A112').locator('[data-go=RESTATIONING]').click();
  await p05.getByTestId('units-to-move').waitFor({ timeout: 20000 });
  ok((await p05.getByTestId('flow-question').innerText()).includes('الوحدات'), 'RESTATIONING-03', 'يبدأ من الموقع الحالي المعتمد ولا يسأل عن الأصل');
  await p05.getByTestId('units-to-move').locator('input[type=checkbox]').first().check();
  await shot(p05, '15-restationing-from-current.png');
  await button(p05, 'التالي: نوع إعادة التمركز').click();
  await button(p05, 'التالي: الموقع الجديد').click();
  await p05.waitForTimeout(2500);
  // zoomed out with the wheel, as a person would, until the new place is on the map
  const mapBox = await p05.locator('.tz-mapframe .tz-map-layer canvas').first().boundingBox();
  await p05.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  for (let i = 0; i < 8; i++) {
    await p05.mouse.wheel(0, 400);
    await p05.waitForTimeout(250);
  }
  await p05.waitForTimeout(800);
  await button(p05, 'تحديد الموقع على الخريطة').click();
  await p05.waitForTimeout(500);
  const dest = await toScreen(p05, [55.945, Y(24.92)]);
  await p05.mouse.click(dest.x, dest.y);
  await p05.waitForTimeout(1200);
  await button(p05, 'التالي: منطقة الانتشار').click();
  await p05.getByTestId('area-controls').waitFor({ timeout: 20000 });
  await p05.waitForTimeout(2000);
  await placeArea(p05, 55.945 + 0.0595, Y(24.92));
  await p05.getByRole('tab', { name: 'منطقة الانتشار البديلة' }).click();
  await p05.waitForTimeout(900);
  await placeArea(p05, 55.945 + 0.0595, Y(24.9565));
  await button(p05, '3D').click();
  await p05.waitForTimeout(3500);
  await shot(p05, '16-3d-current-proposed-deployment.png');
  await button(p05, '2D').click().catch(() => undefined);
  await button(p05, 'التالي: الفحص والمراجعة').click();
  await p05.waitForTimeout(2000);
  await p05.locator('.tz-flow-review textarea').fill('نقل الشعبة إلى موقع جديد');
  await button(p05, 'حفظ المسودة والفحص').click();
  await p05.waitForTimeout(2500);
  await button(p05, 'إرسال للاعتماد').click();
  const moved = await submitted(p05);
  ok(stateOf(moved) === 'UNDER_REVIEW', 'RESTATIONING-04', 'أُرسل');
  await wholeRoute(moved, 'APPROVAL-07');
  ok(stateOf(moved) === 'ACTIVATED_PERMANENT', 'RESTATIONING-05', 'فُعّل');
  ok(sql(`select s.code from org_stationing o join site s on s.id = o.site_id where o.organization_id = md5('${NS}:org:N-A112')::uuid and o.valid_to is null`).startsWith('RS-'), 'RESTATIONING-06', 'الموقع الجديد هو التمركز المعتمد الآن');
  ok(sql(`select count(*) from deployment_area where organization_id = md5('${NS}:org:N-A112')::uuid and state = 'ACTIVE' and site_id = md5('${NS}:site:SITE-04')::uuid`) === '0', 'RESTATIONING-07', 'مناطق الموقع القديم تُحال مع تمركزها');

  // ---- SITE REGISTRATION on the page ---------------------------------------------------------------------------------
  await go(p05, '#newRequest');
  await p05.locator('[data-action=SITE_REGISTRATION] a').click();
  await p05.getByTestId('site-register-form').waitFor({ timeout: 20000 });
  await p05.waitForTimeout(2500);
  await p05.getByRole('tab', { name: /رسم حدود جديدة/ }).click();
  await p05.waitForTimeout(800);
  // typed through the editor's own coordinates box, on open ground, so this site overlaps nothing registered
  await p05.locator('.stw-coords-box summary').first().click();
  for (const [lat, lng] of [[Y(24.98), 56.18], [Y(24.98), 56.185], [Y(24.985), 56.185], [Y(24.985), 56.18]]) {
    await p05.getByLabel('خط عرض الرأس', { exact: true }).fill(String(lat));
    await p05.getByLabel('خط طول الرأس', { exact: true }).fill(String(lng));
    await button(p05, 'إضافة رأس').click();
    await p05.waitForTimeout(250);
  }
  await p05.waitForTimeout(1000);
  await p05.getByLabel('اسم الموقع').fill('موقع مطلوب اعتماده' + SFX);
  await p05.getByLabel('رمز الموقع').fill(PFX + 'SITE-REG-1');
  await shot(p05, '18-site-registration.png');
  await p05.getByTestId('reg-next').click();
  await p05.waitForTimeout(1500);
  await p05.locator('.tz-flow-review textarea').fill('موقع جديد تحتاجه الوحدة');
  await button(p05, 'حفظ المسودة والفحص').click();
  await p05.waitForTimeout(1500);
  ok(sql(`select count(*) from site where code = '${PFX}SITE-REG-1'`) === '0', 'SITE-14', 'لا يُسجل الموقع قبل الاعتماد والتفعيل');
  const regProblems = await p05.getByTestId('review-problems').innerText().catch(() => '');
  ok(regProblems === '', 'SITE-15', 'الفحوص مستوفاة', regProblems);
  await button(p05, 'إرسال للاعتماد').click();
  const registration = await submitted(p05);
  await wholeRoute(registration, 'APPROVAL-10');
  ok(stateOf(registration) === 'ACTIVATED_PERMANENT', 'SITE-16', 'فُعّل');
  ok(sql(`select count(*) from site where code = '${PFX}SITE-REG-1'`) === '1', 'SITE-17', 'سُجل الموقع مرة واحدة');
  ok(sql(`select count(*) from org_stationing o join site s on s.id = o.site_id where s.code = '${PFX}SITE-REG-1'`) === '0', 'SITE-18', 'التسجيل ليس تمركزاً');
  // a point, up to the check: the same page, and a second request over the same place is told so
  const again = await reqApi.post('/restationing-requests', { requestingUnitId: org('N-A11'), purpose: 'SITE_REGISTRATION', content: { kind: 'PERMANENT', scope: [org('N-A11')], reason: 'تسجيل مكرر للتجربة', site: { geometry: sql(`select g.geojson from site_geometry_version g join site s on s.id = g.site_id where s.code = '${PFX}SITE-REG-1'`) ? JSON.parse(sql(`select g.geojson from site_geometry_version g join site s on s.id = g.site_id where s.code = '${PFX}SITE-REG-1'`)) : null, shape: 'DRAWN' }, siteInfo: { name: 'مكرر', code: 'SITE-REG-2', kind: 'موقع' } } });
  const dupChecks = (await reqApi.get(`/restationing-requests/${again.body.id}/checks`)).body;
  ok(JSON.stringify(dupChecks.problems).includes('يتداخل مع موقع مسجل'), 'SITE-19', 'التسجيل المكرر يُبلَّغ ويُمنع', JSON.stringify(dupChecks.problems).slice(0, 160));

  // ---- occupied ground and terrain, by the server ------------------------------------------------------------------------
  const occupied = await reqApi.post('/restationing-requests', { requestingUnitId: org('N-A11'), content: { kind: 'PERMANENT', scope: [org('N-A111')], reason: 'محاولة على أرض مشغولة', site: { geometry: { type: 'Polygon', coordinates: [[[56.0085, Y(24.8025)], [56.0100, Y(24.8025)], [56.0100, Y(24.8040)], [56.0085, Y(24.8040)], [56.0085, Y(24.8025)]]] }, shape: 'DRAWN' } } });
  const blocked = (await reqApi.get(`/restationing-requests/${occupied.body.id}/checks`)).body;
  ok(!blocked.ok && JSON.stringify(blocked.problems).includes('أرض مشغولة' + SFX), 'RESTATIONING-08', 'الأرض المشغولة منع صريح', JSON.stringify(blocked.problems).slice(0, 200));
  ok((await reqApi.post(`/restationing-requests/${occupied.body.id}/submit`, {})).status === 400, 'RESTATIONING-09', 'ولا يُرسل');
  const rugged = await reqApi.post('/stationing/terrain/assess', { geometry: { type: 'Polygon', coordinates: [[[56.133614, 24.75809], [56.135173, 24.756104], [56.133922, 24.753811], [56.131232, 24.7546], [56.131, 24.7568], [56.133614, 24.75809]]] } });
  ok(rugged.status === 200 && rugged.body.controllingClass && rugged.body.controllingClass !== 'FLAT', 'TERRAIN-01', 'تحليل GLO-30 للموقع الوعر من الخادم', rugged.body.controllingClass);

  // ---- OPERATIONAL POSTURE ---------------------------------------------------------------------------------------------
  const p12 = await pageAs('p12.view');
  await go(p12, '#posture');
  await p12.getByTestId('posture-tree').waitFor({ timeout: 20000 });
  await p12.locator(`[data-unit="${org('N-A11')}"]`).click();
  await p12.waitForTimeout(2500);
  ok((await p12.getByTestId('posture-primary').innerText()).includes('معتمدة') && (await p12.getByTestId('posture-alternative').innerText()).includes('معتمدة'), 'POSTURE-01', 'يرى منطقتي الانتشار بعد التفعيل');
  await shot(p12, '14-operational-posture.png');
  const tree = await p12.getByTestId('posture-tree').innerText();
  ok(tree.includes('شعبة أ1') && !tree.includes('القيادة الرئيسية ب') && !tree.includes('إدارة ب1'), 'POSTURE-02', 'وحدته وما يتبعها فقط', tree.replace(/\s+/g, ' ').slice(0, 200));
  await buttons(p12, 'POSTURE-03', 'لا أزرار تعديل أو قرار', [], [...DECISIONS, 'حفظ المسودة والفحص', 'إرسال للاعتماد', 'إضافة ربط', 'تعديل الطلب']);
  ok(!(await p12.locator('.tz-top').innerText()).includes('طلب جديد'), 'POSTURE-04', 'لا طلب جديد');
  await button(p12, '3D').click();
  await p12.waitForTimeout(3500);
  await shot(p12, '14b-operational-posture-3d.png');
  const p12Api = await apiSession('p12.view');
  const mutations = await Promise.all([
    p12Api.post('/restationing-requests', { requestingUnitId: org('N-A11'), purpose: 'DEPLOYMENT_AREAS', content: { kind: 'PERMANENT', scope: [org('N-A11')], reason: 'محاولة مصنوعة' } }),
    p12Api.post('/site-links', { siteId: sql(`select md5('${NS}:site:SITE-01')::uuid`), organizationId: org('N-A11'), reason: 'محاولة مصنوعة' }),
    p12Api.post('/stationing/corrections', { organizationId: org('N-A11'), siteId: sql(`select md5('${NS}:site:SITE-01')::uuid`), reason: 'محاولة مصنوعة' }),
    p12Api.post(`/restationing-requests/${moved}/activate`, {}),
  ]);
  ok(mutations.every((m) => m.status === 403 || m.status === 404), 'POSTURE-05', 'لا يغيّر شيئاً حتى بطلبات مصنوعة', mutations.map((m) => m.status).join());
  const other = await p13Api.get('/operational-posture');
  ok(other.status === 200 && !JSON.stringify(other.body).includes('قسم الحركة أ'), 'POSTURE-06', 'مستخدم فرع آخر لا يرى هذا الفرع');
  const sharedView = (await (await apiSession('p01.new')).get('/operational-posture')).body.units.find((u) => u.id === org('N-A111'));
  ok(sharedView.otherUnitsAtSite === 4 && !JSON.stringify(sharedView).includes('القيادة الرئيسية ب'), 'POSTURE-07', 'جهات الموقع المشترك تُعد ولا تُسمّى', sharedView.otherUnitsAtSite);

  // ---- the list, and the counts ---------------------------------------------------------------------------------------
  await go(p05, '#allRequests');
  await p05.getByTestId('overview-list').waitFor({ timeout: 15000 });
  const types = await p05.locator('[data-type]').evaluateAll((l) => [...new Set(l.map((e) => e.getAttribute('data-type')))]);
  ok(['INITIAL_STATIONING', 'DEPLOYMENT_AREAS', 'RESTATIONING'].every((t) => types.includes(t)), 'APPROVAL-08', 'الطلبات كلها في قائمة واحدة بنوعها', types.join());
  await p05.locator('[data-filter=DEPLOYMENT]').click();
  await p05.waitForTimeout(1000);
  ok(await p05.locator('[data-type]').evaluateAll((l) => l.length > 0 && l.every((e) => e.getAttribute('data-type') === 'DEPLOYMENT_AREAS')), 'APPROVAL-08b', 'وتصفّي بالنوع');
  await shot(p05, '17-all-requests.png');
  const p14 = await pageAs('p14.admin');
  await go(p14, '#stationingPolicy');
  await p14.getByTestId('policy-stages').waitFor({ timeout: 15000 });
  ok(await p14.locator('[data-stage=unitOperations]').isChecked(), 'APPROVAL-08c', 'المراحل تُضبط من السياسة، لا من الكود');
  const cards = (await reqApi.get('/request-hub/home-cards')).body;
  ok(cards.every((c) => c.value < 40), 'APPROVAL-09', 'العدادات ضمن النطاق', JSON.stringify(cards.map((c) => c.key + ':' + c.value)));
  ok(consoleErrors.length === 0, 'NEXT-01', 'لا أخطاء في المتصفح', consoleErrors.slice(0, 4).join(' | '));
  ok(external.length === 0, 'NEXT-02', 'صفر طلب خارجي', external.slice(0, 3).join(' | '));
} catch (e) {
  ok(false, 'ABORT', 'توقف التشغيل', e.message);
  for (const [u, p] of pages) await p.screenshot({ path: `${process.env.ABORT_DIR ?? evidence}abort-${u}.png` }).catch(() => undefined);
} finally {
  await browser.close();
}
writeFileSync(evidence + 'results.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 1) + '\n');
const failed = results.filter((x) => !x.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
