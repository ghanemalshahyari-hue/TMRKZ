// Stage 3 of the stationing UX brief (2 Nov 2026): the current «مساحة التمركز» (tmrkz-test, fictional data, t.requester)
// and the isolated prototype (prototypes/stationing-ux, fictional data, no server) side by side in headed Microsoft Edge,
// at four sizes, through eight scenarios. Each step records what was attempted, whether it worked and measured facts.
// Nothing is written to the application: the current page reopens an existing fictional draft without saving it; the
// prototype keeps its draft in the browser only.
// Usage (from tests/acceptance, with the prototype running on :5194): HEADED=1 node ../../docs/audit/stationing-ux/redesign/compare-run.mjs
// ONLY=keyboard repeats the keyboard check alone, ONLY=prototype the prototype side with it; either replaces those
// entries in the existing results.json and keeps the rest.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = await import(pathToFileURL(fileURLToPath(new URL('../../../../tests/acceptance/lib/browser.mjs', import.meta.url))).href);
const PROTO = process.env.PROTO_URL ?? 'http://127.0.0.1:5194/';
const OUT = fileURLToPath(new URL('./screenshots/', import.meta.url));
for (const d of ['current', 'prototype']) mkdirSync(OUT + d, { recursive: true });
const draftId = JSON.parse(readFileSync(new URL('../../../evidence/stationing/results.json', import.meta.url), 'utf8')).draftId;

const SIZES = [
  ['1920', { width: 1920, height: 1080 }, false],
  ['1366', { width: 1366, height: 768 }, false],
  ['768', { width: 768, height: 1024 }, true],
  ['390', { width: 390, height: 844 }, true],
];
const SCENARIOS = ['initial', 'organisation', 'shared-site', 'relocation-start', 'polygon-drag', 'vertex-edit', 'new-polygon', 'draft-reopen'];
const results = [];
const browser = await lib.launch();
const settle = (p, ms = 1500) => p.waitForTimeout(ms);
const centre = async (loc) => {
  const b = await loc.boundingBox();
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
};

/** Facts in the page: map size and share of the screen, horizontal scroll, overlapping names, the editor readout's visibility. */
async function facts(page, side) {
  return page.evaluate((side) => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const named = (e) => (e.closest('.stw-prop-sym') ? 'مقترح' : e.closest('.stw-dist') ? 'المسافة' : '') || e.textContent.trim().slice(0, 30);
    const map = document.querySelector(side === 'current' ? '.stw-mapwrap .map' : '.ux-map')?.getBoundingClientRect();
    const els = [...document.querySelectorAll(side === 'current' ? '.pin-label, .stw-prop-sym .lbl, .stw-orig-sym .lbl, .stw-dist span' : '.ux-lbl, .ux-orig-tag, .stw-prop-sym .lbl, .stw-dist span, .ux-ring-tag')].filter(vis);
    const labels = els.map((e) => e.getBoundingClientRect());
    let overlaps = 0;
    const pairs = [];
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++, pairs.push(named(els[i]) + ' ⟷ ' + named(els[j]));
    }
    const readout = document.querySelector(side === 'current' ? 'aside.stw-panel .stw-live' : '.ux-readout, .ux-compact');
    let readoutVisible = null;
    if (readout) {
      const r = readout.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 12);
      const top = document.elementFromPoint(x, y);
      readoutVisible = r.top >= 0 && r.bottom <= innerHeight + 1 && !!top && readout.contains(top);
    }
    return {
      viewport: innerWidth + '×' + innerHeight,
      map: map ? Math.round(map.width) + '×' + Math.round(Math.min(map.height, innerHeight - Math.max(0, map.top))) : null,
      mapShareOfScreen: map ? Math.round((Math.max(0, Math.min(map.right, innerWidth) - Math.max(0, map.left)) * Math.max(0, Math.min(map.bottom, innerHeight) - Math.max(0, map.top)) / (innerWidth * innerHeight)) * 100) + '%' : null,
      horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1,
      visibleNames: labels.length,
      overlappingNames: overlaps,
      overlapping: pairs,
      editorReadoutVisible: readoutVisible,
    };
  }, side);
}

async function touchDrag(ctx, page, from, dx, dy) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= 24; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / 24, y: from.y + (dy * i) / 24 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle(page, 1300);
}
async function mouseDrag(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 24 });
  await page.mouse.up();
  await settle(page, 1300);
}

const ONLY = process.env.ONLY;
for (const [size, viewport, touch] of ONLY === 'keyboard' ? [] : SIZES) {
  for (const side of ONLY === 'prototype' ? ['prototype'] : ['current', 'prototype']) {
    const ctx = await lib.newContext(browser, { viewport, deviceScaleFactor: 1, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
    const page = await ctx.newPage();
    lib.watch(page, side + ' ' + size);
    const drag = (from, dx, dy) => (touch ? touchDrag(ctx, page, from, dx, dy) : mouseDrag(page, from, dx, dy));
    let n = 0;
    const run = async (scenario, attempted, fn) => {
      n++;
      const file = side + '/' + size + '-' + String(n).padStart(2, '0') + '-' + scenario + '.png';
      let ok = true, note = '';
      try {
        note = (await fn()) ?? '';
      } catch (e) {
        ok = false;
        note = String(e.message ?? e).split('\n')[0].slice(0, 300);
      }
      await page.screenshot({ path: OUT + file }).catch(() => undefined);
      const f = await facts(page, side).catch(() => null);
      results.push({ size, side, scenario, attempted, worked: ok, note, file: 'screenshots/' + file, facts: f });
      console.log((ok ? 'OK  ' : 'FAIL') + ' ' + size + ' ' + side.padEnd(9) + ' ' + scenario.padEnd(17) + ' ' + note.slice(0, 110));
    };

    if (side === 'current') {
      await lib.signInManual(page, 't.requester');
      const panel = page.locator('aside.stw-panel');
      const distance = () => panel.locator('.stw-live b').innerText();
      await run('initial', 'فتح «مساحة التمركز» دون اختيار', async () => {
        await page.goto(lib.BASE + '/#stationing');
        await page.waitForSelector('.pin-wrap', { timeout: 20000 });
        await settle(page, 2200);
      });
      await run('organisation', 'اختيار «الخدمات المشتركة» من الشجرة', async () => {
        await page.locator('.stw-tree-label').filter({ hasText: 'الخدمات المشتركة' }).first().click();
        await page.locator('.stw-site-row').first().waitFor({ timeout: 8000 });
        await settle(page, 2200);
        return (await page.locator('.stw-site-row').count()) + ' مواقع تحت الجهة';
      });
      await run('shared-site', 'فتح «مركز الخدمات» (جهتان) من البحث', async () => {
        await page.getByLabel('البحث عن جهة أو موقع').fill('مركز الخدمات');
        await page.locator('.stw-search-pop button', { hasText: 'مركز الخدمات' }).first().click();
        await page.locator('.stw-popup').waitFor({ timeout: 8000 });
        await settle(page, 1800);
        return 'رموز الجهات للموقع: ' + (await page.locator('.map-org-symbol-btn[aria-label$="مركز الخدمات"]').count());
      });
      await run('relocation-start', '«طلب تمركز / إعادة تمركز»', async () => {
        await page.getByRole('button', { name: /طلب تمركز/ }).first().click();
        await panel.getByText('اقتراح الموقع على الخريطة').waitFor({ timeout: 8000 });
        await settle(page, 2000);
      });
      await run('polygon-drag', touch ? 'سحب النسخة باللمس' : 'سحب النسخة بالفأرة', async () => {
        const sym = page.locator('.stw-prop-sym').first();
        await sym.scrollIntoViewIfNeeded();
        const before = await distance();
        await drag(await centre(sym), touch ? 130 : 150, touch ? -80 : -90);
        return 'المسافة ' + before + ' ← ' + (await distance());
      });
      await run('vertex-edit', 'تعديل الرؤوس ثم سحب رأس', async () => {
        await page.getByRole('button', { name: 'تعديل الرؤوس' }).click();
        await page.getByRole('button', { name: '◎ المقترح' }).click();
        await settle(page, 1200);
        const v = page.locator('.stw-vtx').first();
        await v.scrollIntoViewIfNeeded();
        const area = () => panel.locator('dt', { hasText: 'المساحة المقترحة' }).locator('xpath=following-sibling::dd[1]').innerText();
        const before = await area();
        await drag(await centre(v), 30, 30);
        const after = await area();
        if (after === before) throw new Error('الرأس لم يتحرك: المساحة بقيت ' + after);
        return 'المساحة المقترحة: ' + before + ' ← ' + after;
      });
      await run('new-polygon', 'رسم حدود جديدة بخمسة رؤوس', async () => {
        await page.getByRole('tab', { name: 'ب · رسم حدود جديدة' }).click();
        await page.getByLabel('عدد الرؤوس').fill('5');
        await settle(page, 1200);
        const m = await page.locator('.stw-mapwrap .leaflet-container').boundingBox();
        const cx = m.x + m.width * 0.4, cy = m.y + Math.min(m.height, viewport.height - m.y) * 0.45;
        for (const [dx, dy] of [[0, -40], [38, -12], [24, 34], [-24, 34], [-38, -12]]) {
          await page.mouse.click(cx + dx, cy + dy);
          await page.waitForTimeout(250);
        }
        await settle(page, 1200);
        return (await page.locator('.stw-vtx').count()) + ' رؤوس';
      });
      await run('draft-reopen', 'فتح مسودة قائمة من رابطها (دون حفظ)', async () => {
        await panel.getByRole('button', { name: 'إلغاء', exact: true }).click().catch(() => undefined);
        await page.goto(lib.BASE + '/#stationing/' + draftId);
        await page.reload();
        await panel.getByText('اقتراح الموقع على الخريطة').waitFor({ timeout: 20000 });
        await settle(page, 2500);
        return (await page.locator('path.stw-prop-path').count()) ? 'المسودة مفتوحة بمضلعها' : 'لا مضلع';
      });
    } else {
      const panel = page.locator('.ux-editor');
      const distance = () => page.locator('.ux-readout .ux-dist b').innerText();
      await run('initial', 'فتح النموذج دون اختيار', async () => {
        await page.goto(PROTO);
        await page.waitForSelector('.ux-dot, .ux-cluster', { timeout: 20000 });
        await settle(page, 2200);
        return (await page.locator('.ux-cluster').count()) + ' مجموعات و' + (await page.locator('.ux-dot').count()) + ' مواقع منفردة';
      });
      await run('organisation', 'اختيار «الخدمات المشتركة» من الهيكل', async () => {
        if (!(await page.locator('.ux-tree').isVisible().catch(() => false))) await page.getByRole('button', { name: /الجهات/ }).click();
        await page.locator('.ux-tree-label').filter({ hasText: 'الخدمات المشتركة' }).first().click();
        await page.locator('.ux-card').waitFor({ timeout: 8000 });
        await settle(page, 2200);
        // the selection's sites: single markers plus the members of its own (outlined) groups
        const grouped = await page.locator('.ux-cluster.hl b').allInnerTexts();
        return (await page.locator('.ux-pin.hl, .ux-pin.sel').count()) + ' مواقع مبرزة منفردة و' + grouped.reduce((n, t) => n + Number(t), 0) + ' في ' + grouped.length + ' مجموعات مبرزة';
      });
      await run('shared-site', 'فتح «المبنى المشترك» (أربع جهات) من البحث', async () => {
        await page.getByLabel('البحث عن جهة أو موقع').fill('المبنى المشترك');
        await page.locator('.ux-hits button', { hasText: 'المبنى المشترك' }).first().click();
        await page.locator('.ux-org-row').first().waitFor({ timeout: 8000 });
        await settle(page, 2000);
        return (await page.locator('.ux-org-row').count()) + ' جهات قابلة للاختيار';
      });
      await run('relocation-start', '«طلب تمركز / إعادة تمركز»', async () => {
        await page.getByRole('button', { name: /طلب تمركز/ }).click();
        await page.locator('.stw-prop-sym').first().waitFor({ timeout: 8000 });
        await settle(page, 2000);
      });
      await run('polygon-drag', touch ? 'سحب النسخة باللمس' : 'سحب النسخة بالفأرة', async () => {
        const sym = page.locator('.stw-prop-sym').first();
        const before = await distance();
        await drag(await centre(sym), touch ? 130 : 170, touch ? -80 : -60);
        return 'المسافة ' + before + ' ← ' + (await distance());
      });
      await run('vertex-edit', 'تعديل الزوايا ثم سحب رأس', async () => {
        await page.getByRole('button', { name: 'تعديل الزوايا', exact: true }).click();
        await page.getByRole('button', { name: 'التكبير على المقترح', exact: true }).click();
        await settle(page, 1200);
        const area = async () => (await page.locator('.ux-readout dd').first().innerText()).trim();
        const before = await area();
        await drag(await centre(page.locator('.stw-vtx').first()), 30, 30);
        const after = await area();
        if (after === before) throw new Error('الرأس لم يتحرك: المساحة بقيت ' + after);
        return before + ' ← ' + after;
      });
      // on touch sizes the lowered sheet shows only the status and the main action: a tap on its handle raises it
      const raiseSheet = async () => {
        if (await page.locator('.ux-sheet.peek').count()) await page.locator('.ux-handle').tap();
        await settle(page, 400);
      };
      await run('new-polygon', 'رسم حدود جديدة بخمسة رؤوس', async () => {
        await raiseSheet();
        await page.getByRole('tab', { name: 'رسم حدود جديدة' }).click();
        await settle(page, 1200);
        const m = await page.locator('.ux-map').boundingBox();
        const cx = m.x + m.width * 0.42, cy = m.y + m.height * (touch ? 0.32 : 0.45);
        for (const [dx, dy] of [[0, -40], [38, -12], [24, 34], [-24, 34], [-38, -12]]) {
          await page.mouse.click(cx + dx, cy + dy);
          await page.waitForTimeout(250);
        }
        await settle(page, 1200);
        return (await page.locator('.stw-vtx').count()) + ' رؤوس';
      });
      await run('draft-reopen', 'حفظ مسودة ثم فتحها من رابطها بعد إعادة التحميل', async () => {
        await raiseSheet();
        await page.getByRole('tab', { name: 'نقل الحدود الحالية' }).click();
        await settle(page, 900);
        await drag(await centre(page.locator('.stw-prop-sym').first()), touch ? 130 : 170, touch ? -80 : -60);
        await page.getByRole('button', { name: 'التالي: التفاصيل' }).click();
        await page.getByPlaceholder('مثال: المبنى الإداري الجديد').fill('مقر الخدمات المقترح');
        await page.getByPlaceholder('لماذا يلزم هذا التمركز؟').fill('مقارنة التصميم: حفظ مسودة وإعادة فتحها');
        await page.getByRole('button', { name: 'حفظ كمسودة' }).click();
        await page.waitForFunction(() => /#draft\//.test(location.hash), null, { timeout: 8000 });
        const hash = await page.evaluate(() => location.hash);
        await page.reload();
        await page.locator('.stw-prop-sym').first().waitFor({ timeout: 15000 });
        await settle(page, 2500);
        return 'المسودة ' + hash + ' أعيد فتحها بمضلعها';
      });
    }
    await ctx.close();
  }
}

// keyboard check on the prototype (desktop): a marker reached by Tab, Enter opens its card with the focus, Escape closes
{
  const ctx = await lib.newContext(browser, { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  lib.watch(page, 'prototype keyboard');
  await page.goto(PROTO);
  await page.waitForSelector('.ux-dot, .ux-cluster', { timeout: 20000 });
  await settle(page, 1500);
  try {
    const marker = page.locator('.leaflet-marker-icon.ux-pin-icon:has(.ux-dot)').first();
    await marker.focus();
    await page.keyboard.press('Enter');
    await page.locator('.ux-card').waitFor({ timeout: 5000 });
    await settle(page, 600);
    const focusInCard = await page.evaluate(() => !!document.activeElement?.closest('.ux-card'));
    await page.screenshot({ path: OUT + 'prototype/1366-keyboard-card.png' });
    await page.keyboard.press('Escape');
    await settle(page, 500);
    const closed = (await page.locator('.ux-card').count()) === 0;
    const back = await page.evaluate(() => !!document.activeElement?.closest('.ux-pin-icon'));
    results.push({ size: '1366', side: 'prototype', scenario: 'keyboard', attempted: 'التركيز على علامة، Enter، ثم Escape', worked: focusInCard && closed && back, note: 'التركيز في البطاقة: ' + focusInCard + ' · Escape يغلق: ' + closed + ' · يعود للعلامة: ' + back, file: 'screenshots/prototype/1366-keyboard-card.png' });
  } catch (e) {
    results.push({ size: '1366', side: 'prototype', scenario: 'keyboard', attempted: 'التركيز على علامة، Enter، ثم Escape', worked: false, note: String(e.message ?? e).split('\n')[0] });
  }
  await ctx.close();
}

await browser.close();
const RESULTS = fileURLToPath(new URL('./results.json', import.meta.url));
let report = { run: new Date().toISOString(), current: lib.BASE + '/#stationing (t.requester)', prototype: PROTO, browser: 'Microsoft Edge (playwright-core), ' + (process.env.HEADED ? 'headed' : 'headless'), draftReopened: draftId, results, consoleErrors: lib.consoleErrors, externalRequests: lib.external };
if (ONLY) {
  const prev = JSON.parse(readFileSync(RESULTS, 'utf8'));
  const replaced = (r) => (ONLY === 'keyboard' ? r.scenario === 'keyboard' : r.side === ONLY);
  report = { ...prev, ['rerun_' + ONLY]: report.run, results: [...prev.results.filter((r) => !replaced(r)), ...results], consoleErrors: [...prev.consoleErrors, ...lib.consoleErrors], externalRequests: [...prev.externalRequests, ...lib.external] };
  delete report.keyboardRerun;
}
writeFileSync(RESULTS, JSON.stringify(report, null, 2));
const failed = results.filter((r) => !r.worked);
console.log(`\n${results.length - failed.length}/${results.length} steps worked · console errors ${lib.consoleErrors.length} · external ${lib.external.length}`);
if (lib.consoleErrors.length) console.log(lib.consoleErrors.slice(0, 12).join('\n'));
