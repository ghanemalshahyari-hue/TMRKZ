// FULL acceptance §23 (all levels empty), §25 FINAL-L2, §29 (non-admin site flow) — owner's specification, 16 Nov 2026.
// R2: U12 (the delegated user: «إنشاء طلبات التمركز» and «طلب اعتماد موقع» in «وحدة إضافية 1 · م9-4», level 9 — no site setup
// right) cannot bootstrap directly, so asks for a new site with «طلب اعتماد موقع» on the same map components. Every hierarchy
// level of م9-4 (م9-4 itself, م8-4, «وحدة إضافية 1») has no hierarchy approver → all skipped, straight to unit operations (U03),
// then the final approval of B (U05, level 9 under «وحدة إضافية 1»; A must not see it), «تحديد وحدات العلم» with no unit,
// activation (U09) → the site is registered (a registration, not a stationing).
//   node tests/acceptance/full26-request-allempty.mjs
import { writeFileSync } from 'node:fs';
import { DOCS, PRIVATE, button, buttons, closePage, contextFor, go, launch, recorder, session, shot, sql, unitId } from './lib/full26-ui.mjs';

const ok = recorder('R2-all-empty');
const B = 'وحدة إضافية 1';
const U = (n) => `${B} · ${n}`;
const L = (n) => 'full26.u' + String(n).padStart(2, '0');
const DECISIONS = ['اعتماد', 'اعتماد عمليات الوحدة', 'اعتماد نهائي', 'تحديد وحدات العلم', 'تفعيل', 'إرجاع للتعديل', 'رفض'];
const SITE = 'موقع مطلوب اعتماده — قبول 01';
const out = {};
const browser = await launch();
const api = async (n) => (await session(L(n))).api;
const stateOf = (id) => sql(`select state from restationing_request where id = '${id}'`);
const route = (id) => sql(`select string_agg(s.kind || ':' || coalesce(o.name, '-') || ':' || coalesce(s.mark, 'OPEN') || ':' || coalesce(p.username, '-'), ' → ' order by s.position) from restationing_stage s left join organization o on o.id = s.unit_id left join person p on p.id = s.decided_by where s.request_id = '${id}' and s.route_no = (select route_no from restationing_request where id = '${id}')`);
const openRequest = async (p, id) => {
  await go(p, '#restationing/' + id);
  await p.reload();
  await p.waitForSelector('main#main');
  await p.waitForTimeout(2500);
};
const stage = async (n, id, label, code, shotName) => {
  const p = await contextFor(browser, L(n));
  await openRequest(p, id);
  await p.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 15000 }).catch(() => undefined);
  const bad = await buttons(p, [label, 'إرجاع للتعديل', 'رفض'], DECISIONS.filter((d) => ![label, 'إرجاع للتعديل', 'رفض'].includes(d)));
  ok(bad.length === 0, code, `${L(n)} يرى «${label}» فقط`, bad.join(' | '));
  if (shotName) {
    await p.locator('.tz-strip-head .tz-tool').click().catch(() => undefined);
    await p.waitForTimeout(800);
    await shot(p, shotName);
  }
  await button(p, label).click();
  await p.waitForTimeout(2500);
  await closePage(p);
};

let id = null;
try {
  // ---- what the delegated user may NOT do: the direct bootstrap ------------------------------------------------------
  const u12 = await api(12);
  const body = {
    site: { name: 'محاولة تهيئة مباشرة', kind: 'معسكر', location: { lat: 24.86, lng: 55.90 }, reason: 'محاولة مصنوعة' },
    boundary: null, units: [{ organizationId: unitId(U('م9-4')), primary: null, alternative: null }], reason: 'محاولة مصنوعة لتهيئة مباشرة',
  };
  const direct = await u12('POST', '/site-setup', body);
  const directCheck = await u12('POST', '/site-setup/check', body);
  ok(direct.status === 403 && directCheck.status === 403, 'NONADMIN-01', 'U12 لا يهيئ موقعاً وتمركزاً مباشرة (403 من الخادم)', `${direct.status} ${direct.body?.code} · check ${directCheck.status}`);
  const corr = await u12('POST', '/stationing/corrections', { organizationId: unitId(U('م9-4')), siteId: sql(`select id from site where code = 'S-0002'`), reason: 'محاولة مصنوعة' });
  ok(corr.status === 403, 'NONADMIN-02', 'ولا يصحح التمركز مباشرة', corr.status);
  ok(sql(`select count(*) from site where name = 'محاولة تهيئة مباشرة'`) === '0', 'NONADMIN-03', 'لم يُكتب شيء');
  const me12 = (await u12('GET', '/me')).body;
  ok(!me12.permissions.includes('MANAGE_FACILITIES') && !me12.permissions.includes('CORRECT_STATIONING'), 'NONADMIN-04', 'لم يحصل على صلاحية التهيئة ضمناً', me12.permissions.join(','));

  // ---- the request path on the page --------------------------------------------------------------------------------
  const p = await contextFor(browser, L(12), { video: 'C5-delegated-site-registration' });
  await go(p, '#siteSetup');
  await p.waitForTimeout(1500);
  out.siteSetupPage = (await p.locator('main#main').innerText()).replace(/\s+/g, ' ').slice(0, 300);
  out.nav = (await p.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
  ok(!out.nav.includes('تهيئة المواقع') && (await p.getByTestId('add-site').count()) === 0, 'NONADMIN-05', 'لا يرى «تهيئة المواقع» ولا «＋ إضافة موقع»', out.nav.slice(0, 200));
  await go(p, '#newRequest');
  await p.getByTestId('hub-units').waitFor({ timeout: 20000 });
  await p.waitForTimeout(1500);
  await shot(p, '15b-delegated-user-new-request.png');
  await p.locator('[data-action=SITE_REGISTRATION] a').first().click();
  await p.getByTestId('site-register-form').waitFor({ timeout: 20000 });
  await p.waitForTimeout(2500);
  await p.getByRole('tab', { name: /رسم حدود جديدة/ }).click();
  await p.waitForTimeout(800);
  // typed through the editor's own coordinates box, on open ground that overlaps no registered site
  await p.locator('.stw-coords-box summary').first().click();
  for (const [lat, lng] of [[24.860, 55.900], [24.860, 55.904], [24.8636, 55.904], [24.8636, 55.900]]) {
    await p.getByLabel('خط عرض الرأس', { exact: true }).fill(String(lat));
    await p.getByLabel('خط طول الرأس', { exact: true }).fill(String(lng));
    await button(p, 'إضافة رأس').click();
    await p.waitForTimeout(300);
  }
  await p.waitForTimeout(1000);
  await p.getByLabel('اسم الموقع').fill(SITE);
  if (await p.getByLabel('رمز الموقع').count()) await p.getByLabel('رمز الموقع').fill('ACC-REG-01');
  await shot(p, '15c-site-registration-request.png');
  await p.getByTestId('reg-next').click();
  await p.waitForTimeout(1800);
  await p.locator('.tz-flow-review textarea').fill('ACCEPTANCE ONLY — موقع تحتاجه م9-4: يُطلب اعتماده لأن المستخدم المفوَّض لا يهيئ مباشرة');
  await button(p, 'حفظ المسودة والفحص').click();
  await p.waitForTimeout(2500);
  out.problems = await p.getByTestId('review-problems').innerText().catch(() => '');
  ok(out.problems === '', 'NONADMIN-06', 'فحوص طلب اعتماد الموقع مستوفاة', out.problems);
  await button(p, 'إرسال للاعتماد').click();
  await p.waitForFunction(() => /^#restationing\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 20000 });
  id = await p.evaluate(() => location.hash.split('/')[1]);
  out.request = { id, number: sql(`select number from restationing_request where id = '${id}'`) };
  await openRequest(p, id);
  await p.locator('.tz-strip-head .tz-tool').click();
  await p.waitForTimeout(1000);
  await shot(p, '16b-route-all-levels-skipped.png');
  await closePage(p);
  ok(sql(`select count(*) from site where name = '${SITE}'`) === '0', 'NONADMIN-07', 'لا يُسجَّل الموقع قبل الاعتماد والتفعيل');

  // ---- the route: every level skipped, straight to unit operations ---------------------------------------------------
  out.routeAtSubmit = route(id);
  const exp = `HIERARCHY:${U('م9-4')}:SKIPPED:- → HIERARCHY:${U('م8-4')}:SKIPPED:- → HIERARCHY:${B}:SKIPPED:- → UNIT_OPERATIONS:-:OPEN:- → FINAL:-:OPEN:-`;
  ok(out.routeAtSubmit === exp, 'HIER-07', 'كل المستويات متجاوزة، والطلب عند «اعتماد عمليات الوحدة» مباشرة', out.routeAtSubmit);
  out.skips = sql(`select string_agg(organization_name || ' (L' || organization_level || ')', ' | ' order by hierarchy_order) from restationing_route_skip where request_id = '${id}'`);
  ok(out.skips.split(' | ').length === 3, 'HIER-08', 'ثلاث وحدات مسجلة «تم التجاوز» بسببها', out.skips);
  const v3 = (await (await api(3))('GET', `/restationing-requests/${id}`)).body;
  ok(v3?.can?.decide === true && v3?.can?.decideAs === 'اعتماد عمليات الوحدة', 'HIER-09', 'لا توقف ولا اعتماد خفي: U03 يقرر الآن', JSON.stringify(v3?.can ?? {}));
  const forgedChain = await (await api(2))('POST', `/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
  ok(forgedChain.status >= 403, 'SEC-13', 'معتمد السلسلة خارج نطاقه (م9-3/م8-3) لا يقرر', forgedChain.status + ' ' + (forgedChain.body?.code ?? ''));

  await stage(3, id, 'اعتماد عمليات الوحدة', 'BTN-U03b', null);
  // FINAL-L2: B receives it, A does not
  const vA = await (await api(4))('GET', `/restationing-requests/${id}`);
  ok(vA.status >= 403 || !vA.body?.can?.decide, 'FINAL-L2b', 'A (فرع م9-3) لا يرى الطلب ولا دور له', vA.status);
  const fA = await (await api(4))('POST', `/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
  ok(fA.status >= 403, 'FINAL-L2c', 'A يعتمد بطلب مصنوع — مرفوض', fA.status + ' ' + (fA.body?.code ?? ''));
  const vB = (await (await api(5))('GET', `/restationing-requests/${id}`)).body;
  ok(vB?.can?.decide === true, 'FINAL-L2a', 'B (المستوى 9) يستقبل طلب م9-4', JSON.stringify(vB?.can ?? {}));
  await stage(5, id, 'اعتماد نهائي', 'BTN-U05', '19b-final-approval-B-level9.png');
  ok(stateOf(id) === 'APPROVED_NOT_ACTIVATED', 'R2-01', 'معتمد نهائياً من B');

  // FYI with no unit (a recorded choice), then activation
  const f = await contextFor(browser, L(6));
  await openRequest(f, id);
  await button(f, 'تحديد وحدات العلم').click();
  await f.getByTestId('fyi-send').waitFor({ timeout: 15000 });
  await f.getByTestId('fyi-send').click();
  await f.getByTestId('fyi-done').waitFor({ timeout: 15000 });
  await closePage(f);
  await stage(9, id, 'تفعيل', 'BTN-U09b', null);
  ok(stateOf(id) === 'ACTIVATED_PERMANENT', 'R2-02', 'فُعّل');
  ok(sql(`select count(*) from site where name = '${SITE}'`) === '1', 'NONADMIN-08', 'سُجّل الموقع مرة واحدة بعد الاعتماد والتفعيل');
  ok(sql(`select count(*) from org_stationing o join site s on s.id = o.site_id where s.name = '${SITE}'`) === '0', 'NONADMIN-09', 'اعتماد الموقع ليس تمركزاً');
} catch (e) {
  ok(false, 'R2-ABORT', 'توقف', e.stack);
}
out.final = id ? { state: stateOf(id), route: route(id) } : null;
writeFileSync(PRIVATE + 'R2.json', JSON.stringify(out, null, 1));
writeFileSync(DOCS + 'R2-route.json', JSON.stringify({ request: out.request, routeAtSubmit: out.routeAtSubmit, skips: out.skips, final: out.final }, null, 1));
await browser.close();
process.exit(0);
