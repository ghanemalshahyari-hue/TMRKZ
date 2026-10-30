// One administrative journey driven through the interface (owner brief of 30 Oct 2026 §11), in Microsoft Edge against
// the acceptance environment: select a facility on the map, create and submit a request from the docked panel, return
// it with comments, correct and resubmit, see what changed, refer for study, approve, record the communication,
// complete the handover and receipt, record the administrative completion and close, then read the retained history.
// Also: final rejection needs a reason, out-of-scope access is denied, a draft survives navigation, opening a facility
// writes nothing, a repeated click creates one request, and the phone sheet keeps its buttons on screen.
// Each persona signs in through the directory sign-in page. The API is used only to cross-check what the screen shows.
// Usage: sh ops/test-env/up-offline.sh && node tests/acceptance/admin-journey.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE, PASSWORD, apiSession, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const OUT = new URL('../../docs/evidence/admin-journey/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const results = [];
const t0 = Date.now();
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name + '.png', OUT)) });
async function step(id, title, page, fn) {
  try {
    const details = await fn();
    results.push({ id, title, pass: true, details: details ?? '' });
    console.log('PASS ', id, title, details ? '— ' + details : '');
  } catch (e) {
    const lines = String(e?.message ?? e).split('\n');
    const waiting = lines.find((l) => l.includes('waiting for'));
    results.push({ id, title, pass: false, details: (lines[0] + (waiting ? ' — ' + waiting.trim() : '')).slice(0, 500) });
    console.log('FAIL ', id, title, '—', lines[0], waiting ? '— ' + waiting.trim() : '');
    if (page) await page.screenshot({ path: fileURLToPath(new URL('fail-' + id + '.png', OUT)) }).catch(() => undefined);
  }
}

const requesterApi = await apiSession('t.requester');
const outsiderApi = await apiSession('t.requester2');
const sites = (await requesterApi.get('/sites')).body;
const SITE = sites.find((s) => s.code === '02');
const types = (await requesterApi.get('/request-types')).body;
const TYPE = types.find((t) => t.code === 'TEMP_OCCUPANCY');

// a free three-day window on the facility for this run (asked from the server, never assumed)
const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const dubai = (day) => new Date(day + 'T00:00:00+04:00').toISOString();
let DAY = addDays('2034-01-01', (Math.floor(Date.now() / 60000) % 2000) * 4);
for (let i = 0; ; i++) {
  const c = (await requesterApi.post('/availability/check', { resourceIds: SITE.resources.map((r) => r.id), start: dubai(DAY), end: dubai(addDays(DAY, 5)) })).body;
  if (c?.available && !c.pendingRequests) break;
  if (i === 30) throw new Error('no free window for the journey');
  DAY = addDays(DAY, 9000 + i * 5);
}
const SUBJECT = 'رحلة القبول الإدارية ' + DAY;
const total = async () => (await requesterApi.get('/requests?size=1')).body.total;

const browser = await launch();
async function persona(login, opts) {
  const ctx = await newContext(browser, opts);
  const page = await ctx.newPage();
  watch(page, login);
  await signInManual(page, login);
  await page.waitForSelector('.map-workspace', { timeout: 30000 });
  return page;
}
async function openReview(page, number) {
  await page.goto(BASE + '/#docs');
  await page.goto(BASE + '/#review');
  const item = page.locator('.inbox-item').filter({ hasText: number });
  await item.waitFor({ timeout: 15000 });
  await item.click();
  await page.locator('.review-actions').waitFor();
}
async function decide(page, button, note) {
  await page.locator('.review-actions').getByRole('button', { name: button }).first().click();
  const dialog = page.locator('.small-dialog, .large-dialog, .detail-dialog').filter({ has: page.getByRole('button', { name: 'تأكيد القرار' }) });
  await dialog.waitFor();
  if (note) await dialog.getByPlaceholder('اكتب سبب القرار أو الملاحظة…').fill(note);
  return dialog;
}
async function openDetails(page, number) {
  await page.goto(BASE + '/#docs');
  await page.goto(BASE + '/#requests');
  const row = page.locator('tr').filter({ hasText: number });
  await row.waitFor({ timeout: 15000 });
  await row.getByRole('button', { name: number }).click();
  // reviewers are taken to the review desk; others get the details dialog — both show the same request document
  const doc = page.locator('.detail-dialog, .review-layout').filter({ hasText: number }).first();
  await doc.waitFor();
  return doc;
}

/** Desktop map: the ring around the site first; «طلب استخدام» opens the card with the use types. */
async function openUse(page) {
  const ring = page.locator('.site-ring');
  await page.locator('.site-ring, .site-menu').first().waitFor();
  if (await ring.isVisible().catch(() => false)) {
    await page.waitForFunction(() => !document.querySelector('.site-ring .ring-seg.right:disabled'));
    await ring.getByRole('button', { name: /طلب استخدام/ }).click();
  }
  await page.locator('.site-menu').waitFor();
}

let id = null;
let number = null;
const R = await persona('t.requester');

await step('J1', 'اختيار المرفق على الخريطة وفتح الطلب في اللوحة الجانبية دون كتابة، ثم الإرسال مرة واحدة رغم تكرار النقر', R, async () => {
  const before = await total();
  await R.getByRole('radio', { name: 'بالأيام' }).click();
  await R.getByLabel('بداية الفترة').fill(DAY);
  await R.getByLabel('نهاية الفترة').fill(addDays(DAY, 2));
  await R.getByRole('tab', { name: 'المواقع' }).click();
  await R.getByLabel('البحث في المواقع', { exact: true }).fill(SITE.name);
  await R.locator('.tree-hit').filter({ hasText: SITE.name }).first().click();
  await R.locator('.map-detail h2').filter({ hasText: SITE.name }).waitFor();
  await R.waitForTimeout(800);
  await R.locator(`.pin-wrap[data-site="${SITE.id}"]`).click();
  await openUse(R);
  const menu = R.locator('.site-menu');
  await R.waitForFunction(() => document.querySelector('.site-menu .site-actions:not([aria-busy])'));
  await shot(R, 'j1-facility-workspace');
  await menu.getByRole('button', { name: 'طلب استخدام مؤقت', exact: true }).click();
  const types = menu.locator('.site-actions.types');
  if (await types.waitFor({ timeout: 1500 }).then(() => true, () => false)) await types.getByRole('button', { name: TYPE.name, exact: true }).click();
  const panel = R.locator('aside.request-drawer.docked');
  await panel.waitFor();
  const ctx = await panel.locator('.wizard-context').innerText();
  check(ctx.includes(SITE.name) && ctx.includes(TYPE.name), 'site and type not shown in the panel: ' + ctx);
  check((await total()) === before, 'selecting the facility or opening the panel wrote a request');
  await panel.getByPlaceholder('مثال: استخدام مركز الخدمات لاستقبال الموظفين').fill(SUBJECT);
  await panel.getByRole('button', { name: 'التالي ←' }).click();
  await panel.getByRole('button', { name: 'التالي ←' }).click();
  await panel.getByPlaceholder('مبرر الطلب').fill('استقبال دفعة الموظفين الجدد في مركز الخدمات');
  await panel.getByRole('button', { name: 'التالي ←' }).click();
  await shot(R, 'j1-request-panel');
  const send = panel.getByRole('button', { name: 'إرسال الطلب' });
  await send.dblclick();
  await R.locator('#toast').filter({ hasText: 'لم ينشأ حجز نهائي' }).waitFor({ timeout: 15000 });
  const mine = (await requesterApi.get('/requests?size=200')).body.items.filter((x) => x.subject === SUBJECT);
  check(mine.length === 1, 'expected one request, found ' + mine.length);
  id = mine[0].id;
  number = mine[0].number;
  return number + ' · لا كتابة عند الاختيار وفتح اللوحة · طلب واحد بعد نقرتين';
});

const F = await persona('t.facilities');
await step('J2', 'مراجعة الاكتمال: إرجاع للتصحيح بسبب محدد', F, async () => {
  await openReview(F, number);
  await shot(F, 'j2-review-screen');
  const dialog = await decide(F, 'إرجاع للتصحيح', 'الفترة تتعارض مع صيانة مجدولة؛ انقلها يوماً واحداً');
  await dialog.getByRole('button', { name: 'تأكيد القرار' }).click();
  await F.locator('#toast').filter({ hasText: 'أعيد الطلب' }).waitFor({ timeout: 15000 });
  const d = (await requesterApi.get('/requests/' + id)).body;
  check(d.status === 'RETURNED', 'status ' + d.status);
  return 'معاد للتصحيح بسبب مسجل';
});

await step('J3', 'مقدم الطلب يصحح الطلب المعاد ويعيد تقديمه بالمرجع نفسه', R, async () => {
  await R.goto(BASE + '/#requests');
  const row = R.locator('tr').filter({ hasText: number });
  await row.getByRole('button', { name: 'تعديل وإرسال' }).click();
  const w = R.locator('.large-dialog').filter({ hasText: 'تعديل وإعادة تقديم' });
  await w.waitFor();
  await w.getByRole('button', { name: 'التالي ←' }).click();
  const dates = w.locator('input[type="date"]');
  await dates.nth(0).fill(addDays(DAY, 1));
  await dates.nth(1).fill(addDays(DAY, 3));
  await w.getByRole('button', { name: 'التالي ←' }).click();
  await w.getByRole('button', { name: 'التالي ←' }).click();
  await w.getByPlaceholder('ما الذي تغيّر بعد الإرجاع؟').fill('نُقلت الفترة يوماً واحداً بعد الصيانة');
  await w.getByRole('button', { name: 'إرسال الطلب' }).click();
  // the wizard closes once the server accepted the resubmission (an earlier toast may still be on screen)
  await w.waitFor({ state: 'detached', timeout: 20000 });
  const d = (await requesterApi.get('/requests/' + id)).body;
  check(d.status === 'SUBMITTED' && d.number === number && d.revision === 2, 'resubmission ' + d.status + ' r' + d.revision);
  return number + ' · المراجعة 2';
});

await step('J4', 'المراجع يرى ما تغيّر ثم يحيل للدراسة', F, async () => {
  await openReview(F, number);
  const changes = F.locator('.revision-changes');
  await changes.waitFor({ timeout: 10000 });
  const text = await changes.innerText();
  check(text.includes('بداية الفترة') && text.includes('نهاية الفترة') && text.includes('نُقلت الفترة'), 'changes not shown: ' + text);
  await shot(F, 'j4-review-changes');
  const dialog = await decide(F, /^إحالة للدراسة/);
  await dialog.getByRole('button', { name: 'تأكيد القرار' }).click();
  await F.locator('#toast').filter({ hasText: 'أُحيل الطلب للدراسة' }).waitFor({ timeout: 15000 });
  return 'الحقلان المتغيران معروضان قبل/بعد مع سبب التعديل';
});

const M = await persona('t.manager');
await step('J5', 'مرحلة الجهة: إحالة للقرار النهائي', M, async () => {
  await openReview(M, number);
  const dialog = await decide(M, /^إحالة للدراسة/);
  await dialog.getByRole('button', { name: 'تأكيد القرار' }).click();
  await M.locator('#toast').filter({ hasText: 'أُحيل' }).waitFor({ timeout: 15000 });
  const d = (await requesterApi.get('/requests/' + id)).body;
  check(d.stages.find((s) => s.state === 'ACTIVE')?.key === 'final_approval', 'not at the final stage');
  return 'المرحلة الحالية: الاعتماد النهائي';
});

const A = await persona('t.approver');
await step('J6', 'القرار: الرفض النهائي يتطلب سبباً، ثم الاعتماد مع التوثيق', A, async () => {
  await openReview(A, number);
  const reject = await decide(A, 'رفض نهائي');
  await reject.getByRole('button', { name: 'تأكيد القرار' }).click();
  await reject.locator('[role="alert"]').filter({ hasText: 'سبباً' }).waitFor();
  await reject.getByRole('button', { name: 'إلغاء' }).click();
  check((await requesterApi.get('/requests/' + id)).body.status === 'SUBMITTED', 'rejected without a reason');
  const approve = await decide(A, /^اعتماد/);
  const ack = approve.getByRole('checkbox');
  if (await ack.count()) await ack.check();
  await approve.getByRole('button', { name: 'تأكيد القرار' }).click();
  const password = approve.getByLabel('كلمة المرور');
  const done = A.locator('#toast').filter({ hasText: 'اكتمل الاعتماد' });
  await Promise.race([done.waitFor({ timeout: 20000 }), password.waitFor({ timeout: 20000 })]);
  if (await password.isVisible().catch(() => false)) {
    await password.fill(PASSWORD);
    await approve.getByRole('button', { name: 'تأكيد الهوية والاعتماد' }).click();
    await done.waitFor({ timeout: 20000 });
  }
  const d = (await requesterApi.get('/requests/' + id)).body;
  check(d.status === 'APPROVED' && d.reservations.length === 1, 'approval ' + d.status);
  return 'رفض بلا سبب ← رسالة ولا قرار · اعتماد ← حجز واحد · الحالة: معتمد بانتظار الإنجاز الإداري';
});

await step('J7', 'تسجيل إبلاغ القرار: من أُبلغ ومتى وبأي مستند', A, async () => {
  const dialog = await openDetails(A, number);
  await dialog.getByRole('button', { name: 'تسجيل إبلاغ' }).click();
  await dialog.locator('.communication-form').getByLabel('مرجع المراسلة — اختياري').fill('خطاب 77/2026');
  await dialog.getByRole('button', { name: 'حفظ الإبلاغ' }).click();
  await A.locator('#toast').filter({ hasText: 'سُجّل إبلاغ القرار' }).waitFor({ timeout: 15000 });
  const item = dialog.locator('.communication-log li').first();
  await item.waitFor();
  const t = await item.innerText();
  check(t.includes('خطاب 77/2026') && t.includes('مراجعة 2'), 'communication not shown: ' + t);
  return t.split('\n')[0];
});

await step('J8', 'التسليم والاستلام ثم الإنجاز الإداري والإغلاق بصلاحية الإغلاق، وبقاء السجل', F, async () => {
  let dialog = await openDetails(F, number);
  check(!(await dialog.locator('.closure-form').count()), 'closure offered before execution');
  const handover = dialog.locator('.exec-complete').first();
  await handover.locator('input').fill('سُلّم المرفق بمحضر رقم 91');
  await handover.getByRole('button', { name: 'إكمال' }).click();
  await F.waitForTimeout(800);
  dialog = await openDetails(R, number);
  const receipt = dialog.locator('.exec-complete').first();
  await receipt.locator('input').fill('استُلم المرفق');
  await receipt.getByRole('button', { name: 'إكمال' }).click();
  await R.waitForTimeout(800);
  check(!(await (await openDetails(R, number)).locator('.closure-form').count()), 'the requester was offered closing');
  dialog = await openDetails(F, number);
  const form = dialog.locator('.closure-form');
  await form.waitFor({ timeout: 10000 });
  await form.getByPlaceholder('ما الذي نُفّذ وسُلّم، ومتى').fill('سُلّم المرفق واستُلم وفق المحضر 91 وانتهى الاستخدام الإداري المطلوب');
  await form.getByLabel('مرجع الإثبات — اختياري (محضر، خطاب)').fill('محضر 91');
  await form.getByRole('button', { name: 'تسجيل الإنجاز وإغلاق الطلب' }).click();
  await F.locator('#toast').filter({ hasText: 'أُغلق الطلب' }).waitFor({ timeout: 15000 });
  const d = (await requesterApi.get('/requests/' + id)).body;
  check(d.status === 'CLOSED' && d.reservations[0].status === 'ACTIVE', 'closure ' + d.status);
  const events = d.history.map((h) => h.event);
  for (const e of ['إحالة للدراسة', 'تسجيل إبلاغ القرار', 'الإنجاز الإداري وإغلاق الطلب']) check(events.includes(e), 'history lacks ' + e);
  dialog = await openDetails(R, number);
  await dialog.locator('.record-summary').waitFor();
  await shot(R, 'j8-closed-history');
  return d.history.length + ' حدثاً في السجل · الحجز باقٍ';
});

await step('J9', 'خارج النطاق: مقدم طلب من جهة أخرى لا يرى الطلب ولا سجل إبلاغه', null, async () => {
  const a = await outsiderApi.get('/requests/' + id);
  const b = await outsiderApi.get('/requests/' + id + '/communications');
  check(a.status === 404 && b.status === 404, a.status + '/' + b.status);
  return 'GET الطلب 404 · سجل الإبلاغ 404';
});

await step('J10', 'المسودة تبقى عند التنقل إلى سجل الطلبات والعودة، والإغلاق دون حفظ لا ينشئ طلباً', R, async () => {
  const before = await total();
  await R.goto(BASE + '/#map');
  await R.locator(`.pin-wrap[data-site="${SITE.id}"]`).waitFor();
  await R.waitForTimeout(600);
  await R.locator(`.pin-wrap[data-site="${SITE.id}"]`).click();
  await openUse(R);
  const menu = R.locator('.site-menu');
  await R.waitForFunction(() => document.querySelector('.site-menu .site-actions:not([aria-busy])'));
  await menu.getByRole('button', { name: 'طلب استخدام مؤقت', exact: true }).click();
  const types = menu.locator('.site-actions.types');
  if (await types.waitFor({ timeout: 1500 }).then(() => true, () => false)) await types.getByRole('button', { name: TYPE.name, exact: true }).click();
  await R.locator('aside.request-drawer.docked').getByPlaceholder('مثال: استخدام مركز الخدمات لاستقبال الموظفين').fill('مسودة تبقى عند التنقل');
  await R.goto(BASE + '/#requests');
  await R.locator('.request-drawer.minimized').waitFor();
  await R.goto(BASE + '/#map');
  await R.locator('.request-drawer.minimized').getByRole('button', { name: 'متابعة الطلب' }).click();
  const kept = await R.locator('aside.request-drawer').getByPlaceholder('مثال: استخدام مركز الخدمات لاستقبال الموظفين').inputValue();
  check(kept === 'مسودة تبقى عند التنقل', 'draft lost: ' + kept);
  await R.getByRole('button', { name: 'إغلاق الطلب دون حفظ' }).click();
  check((await total()) === before, 'closing without saving created a request');
  return 'المسودة مصغرة في سجل الطلبات ومحفوظة عند العودة · لا طلب بلا حفظ';
});

await step('J12', 'نقل المقر: خياران حول الموقع، رسم الموقع الجديد على الخريطة، إرسال الطلب دون تغيير سجل المواقع', R, async () => {
  const sitesBefore = (await requesterApi.get('/sites')).body.length;
  await R.goto(BASE + '/#map');
  const pin = R.locator(`.pin-wrap[data-site="${SITE.id}"]`);
  await pin.waitFor();
  await R.waitForTimeout(600);
  await pin.click();
  const ring = R.locator('.site-ring');
  await ring.waitFor();
  await R.waitForFunction(() => !document.querySelector('.site-ring .ring-seg.left:disabled'));
  await shot(R, 'j12-ring');
  await ring.getByRole('button', { name: /نقل المقر/ }).click();
  const panel = R.locator('.relocation-panel');
  await panel.waitFor();
  await panel.getByPlaceholder('مثال: المبنى الإداري الجديد').fill('المقر الجديد — رحلة القبول');
  await panel.getByPlaceholder('لماذا تنتقل الجهة؟').fill('انتهاء عقد المبنى الحالي والحاجة إلى مساحة أكبر');
  await panel.getByRole('button', { name: /ارسم الموقع الجديد/ }).click();
  await R.waitForTimeout(400);
  const m = await R.locator('.map').boundingBox();
  const x0 = m.x + m.width * 0.66, y0 = m.y + m.height * 0.3;
  await R.mouse.click(x0, y0);
  await R.mouse.move(x0 + 110, y0 + 70, { steps: 8 });
  await R.mouse.click(x0 + 110, y0 + 70);
  await panel.getByText('الموقع المقترح مرسوم').waitFor();
  await shot(R, 'j12-relocation-proposal');
  await panel.getByRole('button', { name: 'إرسال طلب النقل' }).click();
  await R.locator('#toast').filter({ hasText: 'طلب نقل المقر' }).waitFor({ timeout: 15000 });
  const sent = (await requesterApi.get('/requests?size=50')).body.items.find((x) => x.type.code === 'ORG_RELOCATION' && x.status === 'SUBMITTED');
  check(sent, 'relocation request not submitted');
  const rel = (await requesterApi.get('/requests/' + sent.id + '/relocation')).body;
  check(rel.proposedName === 'المقر الجديد — رحلة القبول' && rel.geometry.type === 'Polygon' && rel.fromSite.id === SITE.id, 'proposal not stored');
  check((await requesterApi.get('/sites')).body.length === sitesBefore, 'the proposal changed the site register');
  return sent.number + ' · مستطيل ' + Math.round(rel.areaM2) + ' م² · سجل المواقع دون تغيير';
});

await step('J11', 'الهاتف: لمسة على المرفق تفتح ورقة سفلية بالإجراءين داخل الشاشة', null, async () => {
  const P = await persona('t.requester2', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await P.waitForSelector('.pin-wrap');
  await P.locator('.pin-wrap').first().tap();
  const sheet = P.locator('.site-menu.sheet');
  await sheet.waitFor();
  await P.waitForFunction(() => document.querySelector('.site-menu .site-actions:not([aria-busy])'));
  for (const name of ['طلب استخدام مؤقت', 'طلب استخدام مفتوح المدة']) {
    const b = await sheet.getByRole('button', { name, exact: true }).boundingBox();
    check(b && b.x >= 0 && b.x + b.width <= 391 && b.y + b.height <= 845, name + ' off screen');
  }
  const [sw, iw] = await P.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(sw <= iw + 1, 'horizontal scroll');
  await shot(P, 'j11-phone-sheet');
  return '390×844 · الزران داخل الشاشة · لا تمرير أفقي';
});

await browser.close();
const summary = {
  run: new Date().toISOString(),
  base: BASE,
  browser: 'Microsoft Edge (playwright-core, headless)',
  window: DAY,
  request: number,
  durationSeconds: Math.round((Date.now() - t0) / 1000),
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
  externalRequests: external.length,
  consoleErrors: consoleErrors.length,
};
writeFileSync(new URL('results.json', OUT), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${summary.failed} failed in ${summary.durationSeconds}s · external requests ${external.length} · console errors ${consoleErrors.length}`);
process.exit(summary.failed ? 1 : 0);
