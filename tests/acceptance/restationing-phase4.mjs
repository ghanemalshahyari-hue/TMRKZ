// «إعادة تنظيم التمركز والمواقع ومناطق الانتشار», phase 4 (owner brief §5): «طلب إعادة تمركز» map-first and simple — the
// unit or units (by camp), the current site by itself, «موقع التمركز الجديد» with the Word-like toolbar, the new main and
// sub-areas, the review, then a draft and the sending. On http://localhost:8088 as a synthetic requester of MOVER's directory
// (HR_AI) holding «مقدم الطلب» on one stationed unit; the dark run looks, the light run SAVES and SENDS one request.
//   REQUESTER=juma.ghfly4 node tests/acceptance/restationing-phase4.mjs
// The requester's directory password is ops/acceptance-main/.generated/mover-ldap-test-password (acceptance accounts only).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/stationing-redesign/phase4/';
const SEND = process.env.SEND !== '0';
// SAVE=0: the whole journey, nothing written (a re-run after a small change)
const SAVE = process.env.SAVE !== '0';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const WHO = process.env.REQUESTER ?? 'juma.ghfly4';
const PW = readFileSync(ROOT + 'ops/acceptance-main/.generated/mover-ldap-test-password', 'utf8').trim();
const login = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: WHO, password: PW }) });
if (login.status !== 200) throw new Error(`${WHO} sign-in ${login.status}`);
const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
const apiGet = async (path) => (await fetch(BASE + '/api/v1' + path, { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'X-Requested-With': 'mover' } })).json();
const policy = (await apiGet('/stationing/policy')).inForce.values;
const requestsBefore = (await apiGet('/restationing-requests')).map((r) => r.id);
const mine = (await apiGet('/request-hub')).units.find((u) => u.site && u.actions.some((a) => a.action === 'RESTATIONING' && a.allowed));
if (!mine) throw new Error(`${WHO} has no stationed unit to move`);

const browser = await chromium.launch(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH, headless: true } : { channel: 'msedge', headless: true });
const external = [];
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };
const digits = (t) => t.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace('٫', '.');
const km = (t) => Number((digits(t).match(/([\d.]+)\s*كم/) ?? [])[1]);
const m2 = (t) => Number(((digits(t).match(/([\d,]+)\s*م²/) ?? [])[1] ?? '').replace(/,/g, ''));
const centre = async (loc) => { const b = await loc.boundingBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; };

/** Places the step's shape with its square at {@code targetM} from where it is measured (calibrated by a first click). */
async function placeAt(page, role, targetM) {
  const box = await page.locator('.maplibregl-canvas').first().boundingBox();
  const p1 = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 };
  await page.getByTestId('place-' + role).click();
  await page.mouse.move(p1.x - 30, p1.y + 10);
  await page.mouse.move(p1.x, p1.y, { steps: 4 });
  const tip = await page.getByTestId('pointer-distance').innerText().catch(() => '');
  await page.mouse.click(p1.x, p1.y);
  await page.getByTestId('chips-' + role).waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  const m = await centre(page.locator('.stw-dist span').first());
  const d1 = km(await page.getByTestId('chips-' + role).locator('.da-chip').first().innerText()) * 1000;
  const o = { x: 2 * m.x - p1.x, y: 2 * m.y - p1.y };
  const f = targetM / d1;
  const p2 = { x: o.x + (p1.x - o.x) * f, y: o.y + (p1.y - o.y) * f };
  await page.getByTestId('place-' + role).click();
  await page.mouse.click(p2.x, p2.y);
  await page.waitForTimeout(600);
  return { tip };
}

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(cookies);
  await ctx.addInitScript((t) => { try { localStorage.setItem('tmrkz-theme', t); } catch {} }, theme);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !/^(data|blob):/.test(u.protocol)) { external.push(u.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#restationing/new?purpose=RESTATIONING');
  await page.getByTestId('restation-request').waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  const light = theme === 'light';
  const steps = await page.locator('.sw-steps li').evaluateAll((l) => l.map((x) => x.getAttribute('title')));
  if (light) {
    ok(steps.join(' | ') === 'الوحدات | الموقع الجديد | الرئيسية | الفرعية | مراجعة وإرسال', 'one progress strip: units → new site → main → sub → review', steps.join(' | '));
    ok(await page.evaluate(() => { const r = document.querySelector('[data-testid=restation-request]')?.getBoundingClientRect(); return !!r && r.left > window.innerWidth / 2; }), 'the steps on the right, the context on the left (as the other requests)');
  }
  // the person's units by camp: one unit to move is chosen (from the server's own list), several may be ticked together
  if (await page.getByTestId('areas-step-1').count() === 0) await page.locator('.sw-steps li').first().locator('button').click();
  await page.getByTestId('area-camps').waitFor({ timeout: 10000 });
  await page.locator(`[data-camp="${mine.site.id}"] .rs-twisty`).first().click().catch(() => undefined);
  await page.waitForTimeout(500);
  const row = page.locator(`[data-unit="${mine.name}"]`).first();
  if ((await row.getAttribute('aria-pressed')) !== 'true') await row.click();
  await page.waitForTimeout(400);
  const scope = await page.getByTestId('restation-scope').innerText().catch(() => '');
  if (light) ok(scope.includes('تقدّم الطلب') && (await row.innerText()).includes('☑'), 'units are ticked (several may move together); the unit that asks is named', scope.replace(/\s+/g, ' '));
  await page.screenshot({ path: `${OUT}01-units-${theme}.png` });
  await page.getByTestId('areas-next').click();
  await page.getByTestId('restation-step-site').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  const from = (await page.getByTestId('request-from').innerText()).replace(/\s+/g, ' ');
  if (light) {
    ok(from.includes(mine.site.name) && from.includes('تلقائياً'), 'the current site shows by itself', from);
    ok(await page.getByTestId('areas-next').isDisabled() && (await page.getByTestId('next-why').innerText()).includes('موقع التمركز الجديد'), '«التالي» waits for the new site, saying so');
    const tools = await page.getByTestId('tools-site').locator('.da-tool span').allInnerTexts();
    ok(['تحديد', 'تحريك', 'دائرة', 'بيضاوي', 'مربع', 'مستطيل', 'رسم حر', 'الرؤوس', 'تراجع', 'إعادة', 'إعادة الضبط', 'حذف'].every((t) => tools.includes(t)), 'the new site has the Word-like toolbar (panel 5)', tools.join('، '));
  }
  // zoom out a little (the page never moves the view), then a square for the new site, a few kilometres away
  const cb = await page.locator('.maplibregl-canvas').first().boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.locator('.maplibregl-canvas').first().focus();
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Minus'); await page.waitForTimeout(450); }
  await page.waitForTimeout(800);
  const at = { x: cb.x + cb.width * 0.3, y: cb.y + cb.height * 0.45 };
  await page.getByTestId('place-site').click();
  await page.mouse.move(at.x - 20, at.y + 10);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  const tip = await page.getByTestId('pointer-distance').innerText().catch(() => '');
  if (light) ok(/كم/.test(tip) && tip.includes('من الموقع الحالي'), 'while placing, the pointer shows its distance from the current site', tip);
  await page.screenshot({ path: `${OUT}02a-site-pointer-${theme}.png` });
  await page.mouse.click(at.x, at.y);
  await page.getByTestId('chips-site').waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
  const chips = (await page.getByTestId('chips-site').innerText()).replace(/\s+/g, ' ');
  if (light) ok(chips.includes('من الموقع الحالي') && chips.includes('م²') && /×/.test(chips), 'the new site\'s chips: distance from the current site, area, width × length, against the maximum', chips);
  await page.screenshot({ path: `${OUT}02-site-placed-${theme}.png` });
  if (light) {
    // larger than the policy's maximum: may still be sent (the final approver decides), or fitted to it here (ADR-087)
    for (let i = 0; i < 6 && !(await page.getByTestId('site-over').count()); i++) {
      const h = await centre(page.locator('.stw-hdl-wrap[data-handle="0"]'));
      const c = await centre(page.locator('.stw-hdl-wrap[data-handle="4"]'));
      await page.mouse.move(h.x, h.y);
      await page.mouse.down();
      await page.mouse.move(h.x + (h.x - c.x) * 0.8, h.y + (h.y - c.y) * 0.8, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    }
    const over = await page.getByTestId('site-over').count();
    ok(over === 1 && !(await page.getByTestId('areas-next').isDisabled()), 'an oversized new site is flagged but «التالي» stays on: the final approver decides', (await page.getByTestId('site-verdict').innerText()));
    await page.screenshot({ path: `${OUT}02b-site-over-max-${theme}.png` });
    await page.getByTestId('fit-site').click();
    await page.waitForTimeout(600);
    const after = m2(await page.getByTestId('chips-site').innerText());
    ok(Math.abs(after - policy.maxFootprintAreaM2) <= policy.maxFootprintAreaM2 * 0.01 && !(await page.getByTestId('site-over').count()), '«ضبط المساحة على المسموح» scales it to the maximum', `${after} م²`);
  }
  await page.getByTestId('areas-next').click();
  await page.getByTestId('areas-step-2').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
  const look = await page.locator('.da-look').innerText();
  if (light) ok(look.includes('من مركز الموقع الجديد'), 'the main area is measured from the new site', look);
  const p1 = await placeAt(page, 'primary', (policy.primary.minM + policy.primary.maxM) / 2);
  const c1 = (await page.getByTestId('chips-primary').innerText()).replace(/\s+/g, ' ');
  if (light) ok(c1.includes('ضمن المسموح') && p1.tip.includes('الموقع الجديد'), 'the main area in range of the new site, the pointer measuring from it', `${c1} · ${p1.tip}`);
  await page.screenshot({ path: `${OUT}03-main-area-${theme}.png` });
  await page.getByTestId('areas-next').click();
  await page.getByTestId('areas-step-3').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
  await placeAt(page, 'alternative', (policy.alternative.minM + policy.alternative.maxM) / 2);
  const c2 = (await page.getByTestId('chips-alternative').innerText()).replace(/\s+/g, ' ');
  if (light) ok(c2.includes('ضمن المسموح'), 'the sub-area in range of the main area', c2);
  await page.screenshot({ path: `${OUT}04-sub-area-${theme}.png` });
  await page.locator('.maplibregl-canvas').first().screenshot({ path: `${OUT}04b-map-${theme}.png` });
  await page.getByTestId('areas-next').click();
  await page.getByTestId('areas-step-4').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1000);
  const sum = (await page.getByTestId('areas-summary').innerText()).replace(/\s+/g, ' ');
  if (light) ok(['الوحدات المنتقلة', 'تقدّم الطلب', 'الموقع الحالي', 'موقع التمركز الجديد', 'منطقة الانتشار الرئيسية', 'منطقة الانتشار الفرعية'].every((w) => sum.includes(w)) && sum.includes(mine.name), 'the review: the units, who asks, the current and new sites, both areas', sum.slice(0, 240));
  await page.getByLabel('سبب الطلب').fill('إعادة تمركز الوحدة — اختبار قبول وهمي');
  await page.screenshot({ path: `${OUT}05-review-${theme}.png` });
  if (light && SAVE) {
    await page.getByTestId('save-draft').click();
    const saved = await page.getByTestId('draft-saved').waitFor({ timeout: 20000 }).then(() => page.getByTestId('draft-saved').innerText(), async () => 'ERROR: ' + (await page.getByTestId('send-error').innerText().catch(() => '')));
    ok(saved.includes('حُفظت المسودة'), '«حفظ كمسودة» saves the re-stationing as a draft', saved);
    if (SEND) {
      await page.getByTestId('send-areas').click();
      const sent = await page.getByTestId('areas-sent').waitFor({ timeout: 30000 }).then(() => page.getByTestId('areas-sent').innerText(), async () => 'ERROR: ' + (await page.getByTestId('send-error').innerText().catch(() => '')));
      ok(sent.includes('أُرسل الطلب'), '«إرسال للاعتماد» sends it through its route', sent.replace(/\s+/g, ' ').slice(0, 160));
      await page.screenshot({ path: `${OUT}06-sent-${theme}.png` });
    }
  }
  await ctx.close();
}
const made = (await apiGet('/restationing-requests')).filter((r) => !requestsBefore.includes(r.id));
ok(!SAVE ? made.length === 0 : made.length === 1 && made[0].purpose === 'RESTATIONING' && (SEND ? made[0].state !== 'DRAFT' : made[0].state === 'DRAFT'), !SAVE ? 'nothing was written' : 'the server holds exactly one new re-stationing request' + (SEND ? ', sent' : ', a draft'), made.map((r) => `${r.number} ${r.purpose} ${r.state}`).join(' · '));
ok(!external.length, 'nothing outside localhost', external.slice(0, 2).join(' '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
