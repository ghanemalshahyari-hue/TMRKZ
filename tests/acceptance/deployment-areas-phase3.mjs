// OWNER REVIEW — «إعادة تنظيم التمركز والمواقع ومناطق الانتشار», phase 3 (owner, 17 Nov 2026): «طلب مناطق انتشار» as its own
// screen — it starts from the unit's current site by itself, the main area, then the sub-area («الفرعية»: dashed, lighter),
// small chips with «ⓘ», the review and «إرسال للاعتماد» (not yet connected: the screen first). On http://localhost:8088 as a
// synthetic requester of MOVER's directory (HR_AI) holding «مقدم الطلب» on one stationed unit; both themes. Nothing is sent.
//   REQUESTER=juma.ghfly4 node tests/acceptance/deployment-areas-phase3.mjs
// The requester's directory password is ops/acceptance-main/.generated/mover-ldap-test-password (acceptance accounts only).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/stationing-redesign/phase3/';
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
// the camp of the unit this person may ask for (from the server)
const mine = (await apiGet('/request-hub')).units.find((u) => u.site && ['DEPLOYMENT_MISSING', 'DEPLOYMENT_COMPLETE'].includes(u.state));
if (!mine) throw new Error(`${WHO} has no stationed unit to ask areas for`);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const external = [];
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };
const digits = (t) => t.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace('٫', '.');
const km = (t) => Number((digits(t).match(/([\d.]+)\s*كم/) ?? [])[1]);
const centre = async (loc) => { const b = await loc.boundingBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; };

/**
 * Places the step's area with «ضع المنطقة على الخريطة» at {@code targetM} from where it is measured: a first click, then the
 * distance chip (half-way between the origin and the area) gives the origin and the scale, and a second click lands in range.
 */
async function placeAt(page, role, targetM, shot = null) {
  const box = await page.locator('.maplibregl-canvas').first().boundingBox();
  const p1 = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 };
  await page.getByTestId('place-' + role).click();
  // the distance under the pointer, with its verdict, before the click (owner, 17 Nov 2026)
  await page.mouse.move(p1.x - 30, p1.y + 10);
  await page.mouse.move(p1.x, p1.y, { steps: 4 });
  const tip = await page.getByTestId('pointer-distance').innerText().catch(() => '');
  if (shot) await page.screenshot({ path: shot });
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
  return { origin: o, at: p2, pxPerM: Math.hypot(p2.x - o.x, p2.y - o.y) / targetM, tip };
}

// the dark run reviews only; the light run saves a draft and SENDS it (the unit then has a request pending, so it comes last)
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
  await page.goto(BASE + '/#home');
  await page.waitForSelector('main#main', { timeout: 30000 });
  // one click on the tab: the request starts from the unit's current site, at the main area
  await page.locator('[data-nav=DEPLOYMENT_AREAS]').click();
  await page.getByTestId('areas-request').waitFor({ timeout: 30000 });
  await page.getByTestId('areas-step-2').waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  const from = (await page.getByTestId('request-from').innerText()).replace(/\s+/g, ' ');
  if (theme === 'light') {
    ok(from.includes('يبدأ الطلب من هذا الموقع') && from.includes('لا يتغير'), 'the request starts by itself from the unit\'s current camp, named first (no starting point asked)', from);
    ok(await page.evaluate(() => { const r = document.querySelector('[data-testid=areas-request]')?.getBoundingClientRect(); return !!r && r.left > window.innerWidth / 2; }), 'the steps are on the right, «ما يطلبه هذا الطلب» on the left');
    const steps = await page.locator('.sw-steps li span').allInnerTexts();
    ok(steps.join(' | ') === 'الموقع | الرئيسية | الفرعية | مراجعة وإرسال', 'the steps: the camp → main → sub-area → review', steps.join(' | '));
    ok((await page.locator('body').innerText()).includes('البديل') === false, 'the screen says «الفرعية», never the old word «البديلة»');
  }
  await page.screenshot({ path: `${OUT}01-main-area-start-${theme}.png` });
  // «الموقع»: the person's units by camp, the camp named first, units stationed nowhere folded away; a camp chooses its unit
  await page.locator('.sw-steps li').first().locator('button').click();
  await page.getByTestId('area-camps').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  const campsText = (await page.getByTestId('area-camps').innerText()).replace(/\s+/g, ' ');
  if (theme === 'light') {
    const folded = await page.getByTestId('area-unstationed').evaluate((el) => !el.open).catch(() => true);
    ok(campsText.includes(mine.site.name) && !campsText.includes(mine.name) && folded, 'step 1 lists the camps by name, folded at first (owner); the units stationed nowhere folded away too', campsText.slice(0, 160));
  }
  // the arrow opens a camp: its units under it
  await page.locator(`[data-camp="${mine.site.id}"] .rs-twisty`).first().click();
  await page.waitForTimeout(400);
  if (theme === 'light') ok((await page.getByTestId('area-camps').innerText()).includes(mine.name), 'the arrow opens the camp: its unit under it');
  await page.screenshot({ path: `${OUT}00-step1-camps-${theme}.png` });
  // a camp clicked is the choice, marked «المختار»; nothing moves on until «التالي» (owner, 17 Nov 2026)
  await page.locator('[data-camp-pick]').filter({ hasText: mine.site.name }).first().click();
  await page.waitForTimeout(600);
  if (theme === 'light') {
    const chosen = await page.locator(`[data-camp="${mine.site.id}"] .da-chosen`).count();
    ok(chosen === 1 && await page.getByTestId('areas-step-1').count() === 1, 'a camp clicked is marked «المختار» and the request stays on «الموقع» until «التالي»');
  }
  await page.getByTestId('areas-next').click();
  await page.getByTestId('areas-step-2').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  if (theme === 'light') ok(await page.getByTestId('areas-next').isDisabled() && (await page.getByTestId('next-why').innerText()).includes('الرئيسية'), '«التالي» waits for the main area, saying so');
  // the view stays where it is between steps (owner): the script zooms out itself to reach the range
  const cb = await page.locator('.maplibregl-canvas').first().boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.locator('.maplibregl-canvas').first().focus();
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Minus'); await page.waitForTimeout(450); }
  await page.waitForTimeout(800);
  // «منطقة الانتشار الرئيسية»: placed with the policy's shape by one click, then in range
  const target1 = (policy.primary.minM + policy.primary.maxM) / 2;
  const placed1 = await placeAt(page, 'primary', target1, `${OUT}02a-pointer-distance-${theme}.png`);
  if (theme === 'light') ok(/كم/.test(placed1.tip) && /المسموح|الحد/.test(placed1.tip), 'while placing, the pointer shows its distance from the current site with the verdict', placed1.tip);
  const chips1 = (await page.getByTestId('chips-primary').innerText()).replace(/\s+/g, ' ');
  if (theme === 'light') ok(chips1.includes('ضمن المسموح') && chips1.includes('م²'), 'the main area\'s chips: distance, area, «✓ ضمن المسموح»', chips1);
  await page.getByTestId('info-primary').click();
  const det = (await page.getByTestId('details-primary').innerText()).replace(/\s+/g, ' ');
  if (theme === 'light') ok(['المسافة', 'المساحة', 'التضاريس', 'الحد الأدنى', 'الحد الأقصى', 'سبب التجاوز', 'نسخة السياسة'].every((w) => det.includes(w)), '«ⓘ» opens the details: distance, area, terrain, minimum, maximum, reason, policy version', det.slice(0, 160));
  await page.screenshot({ path: `${OUT}02-main-area-placed-${theme}.png` });
  // «منطقة الانتشار الفرعية»: measured from the main area; drawn here, finished by a double click
  await page.getByTestId('areas-next').click();
  await page.getByTestId('areas-step-3').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  // the sub-area placed by one click takes the main area's own shape and size (owner, 17 Nov 2026)
  const shapes = await page.getByTestId('tools-alternative').locator('.da-tool span').allInnerTexts();
  if (theme === 'light') ok(shapes.includes('نسخة الرئيسية') && shapes.includes('بيضاوي') && shapes.includes('مستطيل'), 'the sub-area\'s toolbar adds «نسخة الرئيسية» (its shape and size)', shapes.join('، '));
  const cb3 = await page.locator('.maplibregl-canvas').first().boundingBox();
  await page.getByTestId('copy-alternative').click();
  await page.mouse.click(cb3.x + cb3.width * 0.4, cb3.y + cb3.height * 0.35);
  await page.getByTestId('chips-alternative').waitFor({ timeout: 10000 });
  const areaOf = async (r) => (await page.getByTestId('chips-' + r).locator('.da-chip').nth(1).innerText()).trim();
  const m2 = (t) => (digits(t).match(/([\d,]+)\s*م²/) ?? [])[1];
  if (theme === 'light') ok(!!m2(chips1) && m2(await areaOf('alternative')) === m2(chips1), 'one click places the sub-area as a copy of the main area (same size)', `${await areaOf('alternative')} = ${m2(chips1)} م²`);
  await page.screenshot({ path: `${OUT}03a-sub-area-copy-${theme}.png` });
  const target2 = (policy.alternative.minM + policy.alternative.maxM) / 2;
  const cal = await placeAt(page, 'alternative', target2);
  await page.getByTestId('draw-alternative').click();
  const r = Math.max(14, 350 * cal.pxPerM);
  const c = cal.at;
  for (const [dx, dy] of [[-r, -r], [r, -r], [r, r]]) { await page.mouse.click(c.x + dx, c.y + dy); await page.waitForTimeout(250); }
  await page.mouse.dblclick(c.x - r, c.y + r);
  await page.waitForTimeout(1000);
  const done2 = await page.getByTestId('done-alternative').innerText().catch(() => '');
  const chips2 = (await page.getByTestId('chips-alternative').innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (theme === 'light') ok(done2.includes('الفرعية') && chips2.includes('كم'), 'the sub-area is drawn (a double click finishes) and measured from the main area', chips2);
  await page.screenshot({ path: `${OUT}03-sub-area-drawn-${theme}.png` });
  await page.locator('.maplibregl-canvas').first().screenshot({ path: `${OUT}03b-map-main-solid-sub-dashed-${theme}.png` });
  if (theme === 'light') {
    // «أدوات الرسم والتحكم (مثل Word)» (owner brief §7, reference panel 5): the frame's handles on the sub-area
    const tools = await page.getByTestId('tools-alternative').locator('.da-tool span').allInnerTexts();
    ok(['تحديد', 'تحريك', 'دائرة', 'بيضاوي', 'مربع', 'مستطيل', 'رسم حر', 'الرؤوس', 'تراجع', 'إعادة', 'إعادة الضبط', 'حذف'].every((t) => tools.includes(t)), 'the toolbar as Word\'s: select, move, circle, ellipse, square, rectangle, free drawing, vertices, undo, redo, reset, delete', tools.join('، '));
    ok(await page.locator('.stw-hdl-wrap').count() === 9, 'a placed shape is selected with its frame: eight handles and the round one');
    // bring the area to the middle and closer (the person's own pan and zoom: the page never moves the view)
    const box0 = await page.locator('.maplibregl-canvas').first().boundingBox();
    const mid = { x: box0.x + box0.width / 2, y: box0.y + box0.height / 2 };
    const a0 = await centre(page.locator('.stw-hdl-wrap[data-handle="0"]'));
    const a4 = await centre(page.locator('.stw-hdl-wrap[data-handle="4"]'));
    const sc = { x: (a0.x + a4.x) / 2, y: (a0.y + a4.y) / 2 };
    const grab = { x: sc.x, y: sc.y + 90 };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + (mid.x - sc.x), grab.y + (mid.y - sc.y), { steps: 12 });
    await page.mouse.up();
    await page.locator('.maplibregl-canvas').first().focus();
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Equal'); await page.waitForTimeout(450); }
    await page.waitForTimeout(800);
    const dimsOf = async () => digits(await page.getByTestId('dims-alternative').innerText()).match(/[\d,]+/g).map((n) => Number(n.replace(/,/g, '')));
    const [w0, l0] = await dimsOf();
    const dragHandle = async (n, dx, dy) => {
      const h = await centre(page.locator(`.stw-hdl-wrap[data-handle="${n}"]`));
      await page.mouse.move(h.x, h.y);
      await page.mouse.down();
      await page.mouse.move(h.x + dx, h.y + dy, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    };
    // the side on the screen's right: handle 3 (east)
    await dragHandle(3, 70, 0);
    const [w1, l1] = await dimsOf();
    ok(w1 > w0 * 1.2 && Math.abs(l1 - l0) <= l0 * 0.02, 'a side handle changes the width alone: the square becomes a rectangle', `${w0}×${l0} → ${w1}×${l1} م`);
    await page.screenshot({ path: `${OUT}05-word-width-${theme}.png` });
    await page.locator('[data-tool=undo]').first().click();
    await page.waitForTimeout(500);
    const [w2] = await dimsOf();
    ok(Math.abs(w2 - w0) <= w0 * 0.02, '«تراجع» takes the change back', `${w2} م`);
    await dragHandle(3, 70, 0);
    const r = await centre(page.locator('.stw-hdl-wrap[data-handle="8"]'));
    await page.mouse.move(r.x, r.y);
    await page.mouse.down();
    await page.mouse.move(r.x + 90, r.y + 40, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const [w3, l3] = await dimsOf();
    ok(Math.abs(w3 - w1) <= w1 * 0.03 && Math.abs(l3 - l1) <= l1 * 0.03, 'the round handle turns the shape; its width and length stay', `${w3}×${l3} م`);
    await page.screenshot({ path: `${OUT}05b-word-rotate-${theme}.png` });
    // a circle stretched on one side is an ellipse
    const c0 = await centre(page.locator('.stw-hdl-wrap[data-handle="8"]'));
    await page.getByTestId('circle-alternative').click();
    await page.mouse.click(mid.x, mid.y);
    await page.waitForTimeout(600);
    await dragHandle(5, 0, -60);
    const [wc, lc] = await dimsOf();
    ok(lc > wc * 1.25, 'a circle stretched on one side becomes an ellipse', `${wc}×${lc} م`);
    await page.screenshot({ path: `${OUT}05c-word-circle-ellipse-${theme}.png` });
    void c0;
  }
  // «مراجعة وإرسال»
  await page.getByTestId('areas-next').click();
  await page.getByTestId('areas-step-4').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
  const sum = (await page.getByTestId('areas-summary').innerText()).replace(/\s+/g, ' ');
  if (theme === 'light') ok(sum.includes('لا يتغير') && sum.includes('منطقة الانتشار الرئيسية') && sum.includes('منطقة الانتشار الفرعية'), 'the review: the unit, its current site unchanged, both areas with their numbers', sum.slice(0, 220));
  await page.getByLabel('سبب الطلب').fill('مناطق انتشار الوحدة — اختبار قبول وهمي');
  await page.screenshot({ path: `${OUT}04-review-${theme}.png` });
  if (theme === 'light') {
    // connected (owner «next», 17 Nov 2026): a draft first, then sent through its route
    await page.getByTestId('save-draft').click();
    await page.getByTestId('draft-saved').waitFor({ timeout: 20000 });
    ok(true, '«حفظ كمسودة» saves the request as a draft', await page.getByTestId('draft-saved').innerText());
    await page.getByTestId('send-areas').click();
    const sent = await page.getByTestId('areas-sent').waitFor({ timeout: 30000 }).then(() => page.getByTestId('areas-sent').innerText(), async () => 'ERROR: ' + (await page.getByTestId('send-error').innerText().catch(() => '')));
    ok(sent.includes('أُرسل الطلب'), '«إرسال للاعتماد» sends the same request (the draft, kept current) through its route', sent.replace(/\s+/g, ' ').slice(0, 160));
    await page.screenshot({ path: `${OUT}06-sent-${theme}.png` });
  }
  await ctx.close();
}
const made = (await apiGet('/restationing-requests')).filter((r) => !requestsBefore.includes(r.id));
ok(made.length === 1 && made[0].purpose === 'DEPLOYMENT_AREAS' && made[0].state !== 'DRAFT', 'the server holds exactly one new request: deployment areas, sent (not a draft)', made.map((r) => `${r.number} ${r.purpose} ${r.state}`).join(' · '));
ok(!external.length, 'nothing outside localhost', external.slice(0, 2).join(' '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
