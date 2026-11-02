// Visual UX audit of «مساحة التمركز» (owner brief of 2 Nov 2026): drives the real application in a headed Microsoft
// Edge, captures full screenshots and close-ups per scenario, and records facts measured in the page (marker/label/symbol
// overlaps, map size and zoom, horizontal scroll, keyboard stops, timings). It changes no code and writes nothing except
// re-saving one existing fictional draft in scenario F. Fictional tmrkz-test data only.
// Usage (from tests/acceptance): HEADED=1 node ../../docs/audit/stationing-ux/audit-run.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = await import(pathToFileURL(fileURLToPath(new URL('../../../tests/acceptance/lib/browser.mjs', import.meta.url))).href);
const OUT = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const manifest = [];
let n = 0;
const pad = (i) => String(i).padStart(2, '0');

const ROLE = {
  't.requester': 'مقدم طلب (عادي)',
  't.manager': 'مسؤول صلاحيات الجهة (إداري جهة)',
  't.facilities': 'مراجع المرافق',
  't.admin': 'مدير النظام (ومدير سجل المواقع)',
  't.limited': 'اطلاع محدود (ملخص فقط)',
  't.approver': 'صاحب الاعتماد',
};

async function open(login, viewport = { width: 1920, height: 1080 }, extra = {}) {
  const ctx = await lib.newContext(browser, { viewport, ...extra });
  const page = await ctx.newPage();
  lib.watch(page, login);
  await lib.signInManual(page, login);
  return { ctx, page, login, viewport };
}

/** Facts measured in the page: what is drawn in the map and what overlaps what. */
async function facts(page) {
  return page.evaluate(() => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const mapEl = document.querySelector('.map');
    const m = mapEl?.getBoundingClientRect();
    const inMap = (r) => m && r.right > m.left && r.left < m.right && r.bottom > m.top && r.top < m.bottom;
    const boxes = (sel) => [...document.querySelectorAll(sel)].filter(vis).map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => inMap(x.r));
    const inter = (a, b) => !(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1);
    const pairs = (A, B, same) => {
      let c = 0;
      for (let i = 0; i < A.length; i++) for (let j = same ? i + 1 : 0; j < B.length; j++) if (A[i].e !== B[j].e && inter(A[i].r, B[j].r)) c++;
      return c;
    };
    const labels = boxes('.pin-label'), heads = boxes('.pin-head'), syms = boxes('.org-symbol-wrap');
    const controls = boxes('.stw-chips, .stw-zoom, .stw-popup, .stw-status, .leaflet-control-scale, .stw-bg-pop');
    const markers = [...labels, ...heads, ...syms];
    let underControls = 0;
    for (const c of controls) for (const x of markers) if (inter(c.r, x.r)) underControls++;
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    return {
      viewport: [innerWidth, innerHeight],
      horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1,
      pageHeight: document.documentElement.scrollHeight,
      map: box('.map'),
      tree: box('.stw-tree'),
      panel: box('aside.stw-panel'),
      popup: box('.stw-popup'),
      zoom: Number(mapEl?.getAttribute('data-view')?.split(',')[0] ?? NaN),
      pinsInView: heads.length,
      labelsInView: labels.length,
      symbolStripsInView: syms.length,
      symbolButtonsInView: boxes('.map-org-symbol-btn').length,
      overlaps: { labelOverLabel: pairs(labels, labels, true), symbolOverLabel: pairs(syms, labels), symbolOverPin: pairs(syms, heads), symbolOverSymbol: pairs(syms, syms, true), pinOverPin: pairs(heads, heads, true), markersUnderControls: underControls },
      selectedPins: document.querySelectorAll('.pin-wrap.selected').length,
      polygons: document.querySelectorAll('.leaflet-overlay-pane path').length,
    };
  });
}

/** Full screenshot plus optional close-up (a locator or a {x,y,width,height} clip), with what was attempted and seen. */
async function snap(s, scenario, name, attempted, opts = {}) {
  n++;
  const file = pad(n) + '-' + name + '.png';
  await s.page.screenshot({ path: OUT + file, fullPage: !!opts.fullPage });
  let close = null;
  if (opts.close) {
    close = pad(n) + 'b-' + name + '-closeup.png';
    try {
      if (typeof opts.close.screenshot === 'function') await opts.close.screenshot({ path: OUT + close });
      else await s.page.screenshot({ path: OUT + close, clip: opts.close });
    } catch (e) {
      close = null;
    }
  }
  const f = await facts(s.page).catch(() => null);
  manifest.push({ file, closeup: close, scenario, role: s.login + ' — ' + (ROLE[s.login] ?? ''), viewport: s.viewport.width + '×' + s.viewport.height, attempted, measured: f, note: opts.note ?? null });
  console.log(file, '|', scenario, '|', s.login, s.viewport.width + '×' + s.viewport.height, '|', JSON.stringify(f?.overlaps ?? {}), 'zoom', f?.zoom, 'pins', f?.pinsInView);
}
const mapClip = async (page, inset = 0) => {
  const b = await page.locator('.map').boundingBox();
  return { x: b.x + inset, y: b.y + inset, width: Math.min(b.width - 2 * inset, 1900), height: Math.min(b.height - 2 * inset, page.viewportSize().height - b.y - inset) };
};
const around = async (page, locator, w = 420, h = 300) => {
  const b = await locator.boundingBox();
  const vp = page.viewportSize();
  const x = Math.max(0, Math.min(vp.width - w, b.x + b.width / 2 - w / 2));
  const y = Math.max(0, Math.min(vp.height - h, b.y + b.height / 2 - h / 2));
  return { x, y, width: Math.min(w, vp.width), height: Math.min(h, vp.height) };
};
const settle = (page, ms = 1500) => page.waitForTimeout(ms);
const scenario = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log('SCENARIO ERROR', name, String(e.message ?? e).split('\n')[0]);
    manifest.push({ scenario: name, error: String(e.message ?? e).split('\n')[0] });
  }
};
const searchSite = async (page, text) => {
  await page.getByLabel('البحث عن جهة أو موقع').fill(text);
  await page.locator('.stw-search-pop button', { hasText: text }).first().click();
  await page.locator('.stw-popup').waitFor({ timeout: 10000 });
  await settle(page, 1800);
};
const drag = async (page, from, dx, dy, steps = 24) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await page.mouse.up();
  await settle(page, 1200);
};
const centre = async (loc) => {
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const timings = {};
const browser = await lib.launch();

try {
  // ---------------- A. Initial opening, five roles (desktop 1920×1080) ----------------
  for (const login of ['t.requester', 't.manager', 't.facilities', 't.admin', 't.limited']) {
    await scenario('A ' + login, async () => {
      const s = await open(login);
      const t0 = Date.now();
      await s.page.goto(lib.BASE + '/#stationing');
      await s.page.waitForSelector('.pin-wrap', { timeout: 20000 });
      timings['A-firstPin-' + login] = Date.now() - t0;
      await settle(s.page, 2500);
      await snap(s, 'A — الفتح الأول دون اختيار', 'A-initial-' + login.replace('t.', ''), 'فتح «مساحة التمركز» دون اختيار أي شيء', { close: await mapClip(s.page) });
      if (login === 't.requester') {
        await snap(s, 'A — الفتح الأول: أدوات الطبقات والتكبير', 'A-controls-requester', 'قراءة أدوات الخريطة (الطبقات، التكبير، القياس)', { close: s.page.locator('.stw-chips') });
        // hover a marker: is anything explained on hover?
        const pin = s.page.locator('.pin-wrap').first();
        await pin.hover();
        await settle(s.page, 800);
        const hover = await s.page.evaluate(() => {
          const icon = document.querySelector('.pin-icon:hover, .leaflet-marker-icon:hover');
          return { title: icon?.getAttribute('title') ?? null, tooltips: document.querySelectorAll('.leaflet-tooltip').length };
        });
        manifest.push({ scenario: 'A — المرور فوق علامة', role: login, viewport: '1920×1080', measured: hover });
        // selected versus unselected: open one site's menu
        await pin.click();
        await settle(s.page, 1500);
        await snap(s, 'A — موقع محدد مقابل غير محدد', 'A-selected-requester', 'النقر على علامة موقع', { close: await around(s.page, s.page.locator('.stw-popup'), 640, 460) });
      }
      if (login === 't.admin' || login === 't.limited') {
        await s.page.locator('.pin-wrap').first().click();
        await settle(s.page, 1500);
        await snap(s, 'A — قائمة الموقع حسب الدور', 'A-menu-' + login.replace('t.', ''), 'النقر على علامة موقع لرؤية الإجراءات المتاحة للدور', { close: await around(s.page, s.page.locator('.stw-popup'), 560, 420) });
      }
      await s.ctx.close();
    });
  }

  // ---------------- B. Dense location: several organisation symbols at one site ----------------
  await scenario('B', async () => {
    const s = await open('t.approver');
    await s.page.goto(lib.BASE + '/#stationing');
    await s.page.waitForSelector('.pin-wrap', { timeout: 20000 });
    await searchSite(s.page, 'مركز الخدمات');
    await s.page.locator('.stw-popup .stw-x').click();
    await settle(s.page, 800);
    const strip = s.page.locator('.org-symbol-wrap').filter({ has: s.page.locator('[aria-label*="مركز الخدمات"]') }).first();
    await snap(s, 'B — موقع مشترك برمزين', 'B-shared-site', 'تكبير موقع «مركز الخدمات» الذي ترتبط به جهتان', { close: await around(s.page, strip, 360, 260) });
    const buttons = strip.locator('.map-org-symbol-btn');
    const count = await buttons.count();
    const picks = [];
    for (let i = 0; i < count; i++) {
      const label = await buttons.nth(i).getAttribute('aria-label');
      await buttons.nth(i).click();
      await settle(s.page, 1200);
      const head = await s.page.locator('.stw-popup-head b').innerText().catch(() => null);
      const treeActive = await s.page.locator('.stw-tree-row.active').innerText().catch(() => null);
      picks.push({ symbol: label, popupOrganisation: head, treeActive: treeActive?.replace(/\s+/g, ' ') });
      await snap(s, 'B — اختيار كل رمز على حدة', 'B-symbol-' + (i + 1), 'النقر على الرمز ' + (i + 1) + ' من ' + count + ' (' + label + ')', { close: await around(s.page, s.page.locator('.stw-popup'), 600, 460) });
      await s.page.locator('.stw-popup .stw-x').click().catch(() => undefined);
    }
    manifest.push({ scenario: 'B — نتيجة اختيار كل رمز', role: 't.approver', viewport: '1920×1080', measured: picks });
    for (let i = 0; i < 3; i++) {
      await s.page.getByRole('button', { name: 'تصغير', exact: true }).click();
      await settle(s.page, 700);
    }
    await settle(s.page, 1500);
    await snap(s, 'B — تداخل الرموز والأسماء عند التصغير', 'B-zoomed-out', 'التصغير ثلاث درجات من الموقع المشترك', { close: await mapClip(s.page, 60) });
    await s.ctx.close();
  });

  // ---------------- C. Organisational hierarchy: parent, child, switching ----------------
  await scenario('C', async () => {
    const s = await open('t.approver');
    await s.page.goto(lib.BASE + '/#stationing');
    await s.page.waitForSelector('.pin-wrap', { timeout: 20000 });
    await settle(s.page, 1500);
    const tree = s.page.locator('.stw-tree');
    const view = () => s.page.getAttribute('.map', 'data-view');
    const v0 = await view();
    await tree.locator('.stw-tree-label').filter({ hasText: 'المؤسسة' }).first().click();
    await settle(s.page, 2200);
    await snap(s, 'C — اختيار جهة أم', 'C-parent', 'اختيار الجهة الأم «المؤسسة» من الشجرة', { close: tree });
    const v1 = await view();
    await tree.locator('.stw-tree-label').filter({ hasText: 'الخدمات المشتركة' }).first().click();
    await settle(s.page, 2500);
    await snap(s, 'C — اختيار جهة فرعية', 'C-child', 'اختيار الجهة الفرعية «الخدمات المشتركة»', { close: await mapClip(s.page) });
    const v2 = await view();
    const open1 = s.page.getByRole('button', { name: 'فتح الخدمات المشتركة', exact: true });
    if (await open1.isVisible().catch(() => false)) await open1.click();
    await settle(s.page, 1200);
    const grand = tree.locator('.stw-tree-label').filter({ hasText: 'قسم الخدمات العامة' }).first();
    if (await grand.isVisible().catch(() => false)) {
      await grand.click();
      await settle(s.page, 2200);
      await snap(s, 'C — اختيار وحدة دون مواقع', 'C-grandchild', 'اختيار «قسم الخدمات العامة» (وحدة فرعية)', { close: tree });
    }
    const v3 = await view();
    await tree.locator('.stw-tree-label').filter({ hasText: 'المؤسسة' }).first().click();
    await settle(s.page, 2200);
    await snap(s, 'C — العودة إلى الجهة الأم', 'C-back-to-parent', 'العودة إلى «المؤسسة» بعد اختيار فرعها', { close: tree });
    manifest.push({ scenario: 'C — تغيّر عرض الخريطة عند كل اختيار', role: 't.approver', viewport: '1920×1080', measured: { initial: v0, parent: v1, child: v2, grandchild: v3, backToParent: await view() } });
    await s.ctx.close();
  });

  // ---------------- D + E. Relocation proposal and a new footprint (requester) ----------------
  await scenario('D/E', async () => {
    const s = await open('t.requester');
    await s.page.goto(lib.BASE + '/#stationing');
    await s.page.waitForSelector('.pin-wrap', { timeout: 20000 });
    await s.page.locator('.stw-tree').getByText('الخدمات المشتركة').first().click();
    await settle(s.page, 1500);
    await searchSite(s.page, 'مركز الخدمات');
    await snap(s, 'D — قائمة المقر قبل بدء المقترح', 'D-site-menu', 'اختيار الجهة ثم مقرها «مركز الخدمات»', { close: await around(s.page, s.page.locator('.stw-popup'), 560, 420) });
    await s.page.getByRole('button', { name: /طلب تمركز/ }).first().click();
    const panel = s.page.locator('aside.stw-panel');
    await panel.getByText('اقتراح الموقع على الخريطة').waitFor();
    await settle(s.page, 2000);
    await snap(s, 'D — بداية المقترح: الأصل والنسخة متطابقان', 'D-proposal-start', 'بدء «طلب تمركز / إعادة تمركز»', { close: await mapClip(s.page, 40) });
    // drag the copy by its symbol; measure frame intervals while dragging
    const sym = s.page.locator('.stw-prop-sym').first();
    const from = await centre(sym);
    await s.page.evaluate(() => {
      window.__frames = [];
      window.__rec = true;
      const tick = (t) => {
        window.__frames.push(t);
        if (window.__rec) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const tDrag = Date.now();
    await drag(s.page, from, 150, -90, 40);
    timings['D-drag-wall-ms'] = Date.now() - tDrag;
    const fr = await s.page.evaluate(() => {
      window.__rec = false;
      const f = window.__frames;
      const d = f.slice(1).map((x, i) => x - f[i]).sort((a, b) => a - b);
      return { frames: f.length, medianMs: Math.round(d[Math.floor(d.length / 2)] * 10) / 10, p95Ms: Math.round(d[Math.floor(d.length * 0.95)] * 10) / 10, maxMs: Math.round(d[d.length - 1] * 10) / 10 };
    });
    timings['D-drag-frames'] = fr;
    await snap(s, 'D — بعد سحب المضلع والرمز', 'D-dragged', 'سحب نسخة المضلع من رمزها 150×90 بكسل', { close: await mapClip(s.page, 40) });
    await snap(s, 'D — لوحة القراءات أثناء المقترح', 'D-panel-readouts', 'قراءة المسافة والنطاق والمساحة', { close: panel });
    await s.page.getByRole('button', { name: '⇆ مقارنة الموقعين' }).click();
    await settle(s.page, 1800);
    await snap(s, 'D — مقارنة الموقعين', 'D-compare', 'مقارنة الموقع المعتمد بالمقترح', { close: await mapClip(s.page, 40) });
    await s.page.getByRole('button', { name: 'تعديل الرؤوس' }).click();
    await s.page.getByRole('button', { name: '◎ المقترح' }).click();
    await settle(s.page, 1500);
    const v = s.page.locator('.stw-vtx').first();
    await snap(s, 'D — وضع تعديل الرؤوس', 'D-vertex-mode', 'تفعيل «تعديل الرؤوس» والتكبير على المقترح', { close: await mapClip(s.page, 40) });
    await drag(s.page, await centre(v), 30, 30);
    await snap(s, 'D — بعد تحريك رأس', 'D-vertex-moved', 'سحب الرأس 1 مسافة 30×30 بكسل', { close: await around(s.page, s.page.locator('.stw-vtx').first(), 520, 380) });

    // E. new footprint
    await s.page.getByRole('tab', { name: 'ب · رسم حدود جديدة' }).click();
    await settle(s.page, 1200);
    await snap(s, 'E — تعليمات رسم حدود جديدة', 'E-draw-instructions', 'التبديل إلى «ب · رسم حدود جديدة»', { close: panel });
    await s.page.getByLabel('عدد الرؤوس').fill('5');
    await settle(s.page, 1000);
    const m = await s.page.locator('.stw-mapwrap .leaflet-container').boundingBox();
    const cx = m.x + m.width * 0.3, cy = m.y + m.height * 0.45;
    for (const [dx, dy] of [[0, -50], [48, -15], [30, 42], [-30, 42], [-48, -15]]) {
      await s.page.mouse.click(cx + dx, cy + dy);
      await s.page.waitForTimeout(250);
    }
    await settle(s.page, 1500);
    await snap(s, 'E — مضلع جديد من خمسة رؤوس', 'E-drawn', 'رسم خمسة رؤوس بالنقر على الخريطة', { close: await mapClip(s.page, 40) });
    await s.page.getByLabel('عدد الرؤوس').fill('3');
    await s.page.getByRole('button', { name: 'إعادة الضبط' }).click();
    await settle(s.page, 600);
    for (const [lat, lng] of [['25.2125', '55.3005'], ['25.2125', '55.3025'], ['25.2140', '55.3015']]) {
      await s.page.getByLabel('خط عرض الرأس', { exact: true }).fill(lat);
      await s.page.getByLabel('خط طول الرأس', { exact: true }).fill(lng);
      await s.page.getByRole('button', { name: 'إضافة رأس' }).click();
      await s.page.waitForTimeout(300);
    }
    await settle(s.page, 1500);
    await snap(s, 'E — إدخال الإحداثيات', 'E-coordinates', 'إدخال ثلاثة رؤوس بخطوط العرض والطول', { close: panel });
    await s.page.getByRole('button', { name: '↶ تراجع' }).click();
    await settle(s.page, 800);
    await snap(s, 'E — بعد التراجع', 'E-undo', 'التراجع خطوة', { close: panel });
    await s.page.getByRole('button', { name: '↷ إعادة' }).click();
    await settle(s.page, 600);
    await s.page.getByRole('button', { name: 'إعادة الضبط' }).click();
    await settle(s.page, 1000);
    await snap(s, 'E — بعد إعادة الضبط', 'E-reset', 'الإعادة ثم «إعادة الضبط»', { close: panel });
    await panel.getByRole('button', { name: 'إلغاء', exact: true }).click();
    await settle(s.page, 800);
    await s.ctx.close();
  });

  // ---------------- F. Requests: details step, save and reopen an existing draft ----------------
  await scenario('F', async () => {
    const draftId = JSON.parse(readFileSync(new URL('../../evidence/stationing/results.json', import.meta.url), 'utf8')).draftId;
    const s = await open('t.requester');
    await s.page.goto(lib.BASE + '/#stationing/' + draftId);
    await s.page.reload();
    const panel = s.page.locator('aside.stw-panel');
    await panel.getByText('اقتراح الموقع على الخريطة').waitFor({ timeout: 20000 });
    await settle(s.page, 2500);
    await snap(s, 'F — فتح مسودة محفوظة', 'F-draft-reopened', 'فتح مسودة تمركز محفوظة من رابطها', { close: panel });
    const go = s.page.getByRole('button', { name: 'متابعة إلى تفاصيل الطلب' });
    await s.page.waitForFunction(() => [...document.querySelectorAll('aside.stw-panel button')].some((b) => b.textContent.includes('متابعة إلى تفاصيل الطلب') && !b.disabled), null, { timeout: 15000 });
    await go.click();
    await panel.getByText('تفاصيل الطلب').first().waitFor();
    await settle(s.page, 1000);
    await snap(s, 'F — خطوة تفاصيل الطلب', 'F-details', 'المتابعة إلى «تفاصيل الطلب»', { close: panel, fullPage: false });
    await panel.getByRole('button', { name: /العودة إلى الخريطة/ }).click();
    await settle(s.page, 1000);
    await snap(s, 'F — العودة من التفاصيل إلى الخريطة', 'F-back-to-map', '«العودة إلى الخريطة» من خطوة التفاصيل', { close: panel });
    await go.click();
    await panel.getByText('تفاصيل الطلب').first().waitFor();
    await panel.getByRole('button', { name: 'حفظ كمسودة' }).click();
    await s.page.locator('#toast').waitFor({ state: 'visible', timeout: 10000 });
    await snap(s, 'F — حفظ المسودة', 'F-saved', 'حفظ كمسودة (تحديث المسودة نفسها، لا سجل جديد)', { close: s.page.locator('#toast') });
    await s.page.reload();
    await panel.getByText('اقتراح الموقع على الخريطة').waitFor({ timeout: 20000 });
    await settle(s.page, 2500);
    await snap(s, 'F — المسودة بعد إعادة التحميل', 'F-reopened-after-save', 'إعادة تحميل الصفحة بعد الحفظ', { close: await mapClip(s.page, 40) });
    manifest.push({ scenario: 'F — المسودة المستخدمة', role: 't.requester', measured: { draftId, note: 'مسودة وهمية قائمة من تشغيل سابق؛ أُعيد حفظها دون إنشاء طلب جديد' } });
    await s.ctx.close();
  });

  // ---------------- G. Screen sizes ----------------
  const sizes = [
    ['desktop', { width: 1920, height: 1080 }, {}],
    ['laptop', { width: 1366, height: 768 }, {}],
    ['tablet', { width: 768, height: 1024 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
    ['mobile', { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ];
  for (const [label, vp, extra] of sizes) {
    await scenario('G ' + label, async () => {
      const s = await open('t.requester', vp, extra);
      await s.page.goto(lib.BASE + '/#stationing');
      await s.page.waitForSelector('.pin-wrap', { timeout: 20000 });
      await settle(s.page, 2500);
      await snap(s, 'G — مقاس ' + label, 'G-' + label + '-open', 'فتح «مساحة التمركز»', { fullPage: label === 'mobile' || label === 'tablet' });
      await searchSite(s.page, 'مركز الخدمات');
      await snap(s, 'G — مقاس ' + label + ': قائمة الموقع', 'G-' + label + '-menu', 'اختيار «مركز الخدمات» من البحث', { close: await around(s.page, s.page.locator('.stw-popup'), Math.min(560, vp.width), 420) });
      await s.page.getByRole('button', { name: /طلب تمركز/ }).first().click();
      await s.page.locator('aside.stw-panel').getByText('اقتراح الموقع على الخريطة').waitFor();
      await settle(s.page, 2200);
      await snap(s, 'G — مقاس ' + label + ': المقترح', 'G-' + label + '-proposal', 'بدء المقترح', { fullPage: label === 'mobile' || label === 'tablet' });
      if (label === 'mobile') {
        // a real touch drag on the proposal symbol (CDP touch events), then read the distance
        const sym = s.page.locator('.stw-prop-sym').first();
        await sym.scrollIntoViewIfNeeded();
        const before = await s.page.locator('aside.stw-panel .stw-live b').innerText().catch(() => null);
        const c = await centre(sym);
        const cdp = await s.ctx.newCDPSession(s.page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
        for (let i = 1; i <= 20; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + i * 4, y: c.y - i * 3 }] });
          await s.page.waitForTimeout(16);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await settle(s.page, 1500);
        const after = await s.page.locator('aside.stw-panel .stw-live b').innerText().catch(() => null);
        manifest.push({ scenario: 'G — سحب باللمس على الهاتف', role: 't.requester', viewport: '390×844', measured: { distanceBefore: before, distanceAfter: after } });
        await snap(s, 'G — الهاتف بعد محاولة السحب باللمس', 'G-mobile-touch-drag', 'سحب رمز المقترح بأحداث لمس حقيقية (CDP)', {});
      }
      await s.ctx.close();
    });
  }

  // ---------------- H. Whole hierarchy and all sites (system administrator) ----------------
  await scenario('H', async () => {
    const s = await open('t.admin');
    await s.page.goto(lib.BASE + '/#stationing');
    await s.page.waitForSelector('.pin-wrap', { timeout: 20000 });
    await settle(s.page, 2000);
    for (let i = 0; i < 2; i++) {
      await s.page.getByRole('button', { name: 'تصغير', exact: true }).click();
      await settle(s.page, 700);
    }
    await settle(s.page, 1500);
    await snap(s, 'H — كل المواقع عند تصغير الخريطة', 'H-all-sites', 'التصغير لرؤية كل المواقع المسموحة (12 موقعاً)', { close: await mapClip(s.page, 40) });
    // expand the whole organisation tree
    for (let k = 0; k < 40; k++) {
      const t = s.page.locator('.stw-tree button[aria-label^="فتح "]').first();
      if (!(await t.isVisible().catch(() => false))) break;
      await t.click();
      await s.page.waitForTimeout(350);
    }
    const tree = await s.page.evaluate(() => {
      const rows = [...document.querySelectorAll('.stw-tree-row')];
      const depth = Math.max(...rows.map((r) => parseInt(r.style.paddingInlineStart || '4', 10)));
      const clipped = rows.filter((r) => {
        const b = r.querySelector('.stw-tree-label b');
        return b && b.scrollWidth > b.clientWidth + 1;
      }).length;
      return { rows: rows.length, maxIndentPx: depth, namesClipped: clipped };
    });
    manifest.push({ scenario: 'H — الشجرة كاملة', role: 't.admin', viewport: '1920×1080', measured: tree });
    await snap(s, 'H — الشجرة التنظيمية كاملة', 'H-tree-expanded', 'فتح كل مستويات شجرة الجهات', { close: s.page.locator('.stw-tree') });
    await s.ctx.close();
  });

  // ---------------- Keyboard and accessibility ----------------
  await scenario('K', async () => {
    const s = await open('t.requester', { width: 1366, height: 768 });
    await s.page.goto(lib.BASE + '/#stationing');
    await s.page.waitForSelector('.pin-wrap', { timeout: 20000 });
    await settle(s.page, 2000);
    await s.page.locator('.stw .page-heading h1').click();
    const stops = [];
    for (let i = 0; i < 60; i++) {
      await s.page.keyboard.press('Tab');
      stops.push(
        await s.page.evaluate(() => {
          const e = document.activeElement;
          if (!e) return '-';
          const where = e.closest('.stw-tree') ? 'tree' : e.closest('.stw-chips') ? 'chips' : e.closest('.stw-zoom') ? 'zoom' : e.closest('.leaflet-marker-pane') ? 'marker' : e.closest('.map') ? 'map' : e.closest('.stw-panel') ? 'panel' : e.closest('#sidebar') ? 'sidebar' : e.closest('.app-header') ? 'header' : e.closest('.stw') ? 'page' : 'other';
          return where + ':' + (e.getAttribute('aria-label') || e.textContent || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
        }),
      );
    }
    const firstMarker = stops.findIndex((x) => x.startsWith('marker'));
    // keyboard on a marker: Enter opens the site menu? focus inside it? Escape closes it?
    const pinIcon = s.page.locator('.leaflet-marker-icon.pin-icon').first();
    await pinIcon.focus();
    await s.page.keyboard.press('Enter');
    await settle(s.page, 1200);
    const opened = await s.page.locator('.stw-popup').count();
    const focusInPopup = await s.page.evaluate(() => !!document.activeElement?.closest('.stw-popup'));
    await snap(s, 'K — لوحة المفاتيح: Enter على علامة', 'K-keyboard-enter', 'التركيز على علامة موقع ثم Enter', { close: await around(s.page, s.page.locator('.stw-popup').first(), 560, 420).catch(() => null) });
    await s.page.keyboard.press('Escape');
    await settle(s.page, 600);
    const afterEsc = await s.page.locator('.stw-popup').count();
    manifest.push({ scenario: 'K — لوحة المفاتيح', role: 't.requester', viewport: '1366×768', measured: { tabStops: stops, firstMarkerAtTab: firstMarker >= 0 ? firstMarker + 1 : null, enterOpensMenu: opened > 0, focusMovesIntoMenu: focusInPopup, escapeClosesMenu: opened > 0 && afterEsc === 0 } });
    await s.ctx.close();
  });
} finally {
  await browser.close();
}

writeFileSync(OUT + 'manifest.json', JSON.stringify({ run: new Date().toISOString(), base: lib.BASE, browser: 'Microsoft Edge (playwright-core), ' + (process.env.HEADED ? 'headed' : 'headless'), timings, consoleErrors: lib.consoleErrors, externalRequests: lib.external, entries: manifest }, null, 2));
console.log('\nscreenshots:', n, '· console errors', lib.consoleErrors.length, '· external', lib.external.length);
console.log('timings', JSON.stringify(timings));
