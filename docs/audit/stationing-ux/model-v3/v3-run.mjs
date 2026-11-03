// Browser evidence for the stationing V3 prototype (owner brief of 3 Nov 2026, «COMPLETE STATIONING / RE-STATIONING /
// DEPLOYMENT REDESIGN»): scenarios A–S at 1920×1080, 1366×768, 768×1024 and 390×844, the map interactions of §46 with
// frame timing, a full journey from a clean world counting the user's actions, and the key screenshots.
// Headless Microsoft Edge (playwright-core); fictional data; every request outside 127.0.0.1 is blocked and recorded.
// Usage (from tests/acceptance, with the prototype on :5194): node ../../docs/audit/stationing-ux/model-v3/v3-run.mjs
// SIZES=1920,390 for a subset.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = await import(pathToFileURL(fileURLToPath(new URL('../../../../tests/acceptance/lib/browser.mjs', import.meta.url))).href);
const BASE = process.env.PROTO_URL ?? 'http://127.0.0.1:5194/restationing.html';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const SHOTS = OUT + 'screenshots/';
mkdirSync(SHOTS, { recursive: true });
const ALL = { 1920: [1920, 1080, false], 1366: [1366, 768, false], 768: [768, 1024, true], 390: [390, 844, true] };
const SIZES = (process.env.SIZES ?? '1920,1366,768,390').split(',');
const CODES = [...'ABCDEFGHIJKLMNOPQRST'.split(''), 'T2', ...'UVWXYZ'.split('')];
const browser = await lib.launch();
const results = { scenarios: [], interactions: [], journey: [], external: lib.external, consoleErrors: [] };

// geography in the driver itself, independent of the page's code
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2));
const centre = (ring) => ({ lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length });
const area = (ring) => {
  const c = centre(ring);
  const xy = ring.map((p) => [rad(p.lng - c.lng) * R * Math.cos(rad(c.lat)), rad(p.lat - c.lat) * R]);
  return Math.abs(xy.reduce((s, [x, y], i) => s + x * xy[(i + 1) % xy.length][1] - xy[(i + 1) % xy.length][0] * y, 0) / 2);
};

async function open(page, code) {
  await page.goto(BASE + (code ? '#s=' + code : ''), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__v3?.map && document.querySelectorAll('.leaflet-tile-loaded').length > 2, null, { timeout: 20000 });
  await page.waitForTimeout(700);
}

async function facts(page) {
  return page.evaluate(() => {
    const dock = document.querySelector('.v3-dock')?.getBoundingClientRect();
    const map = document.querySelector('.v3-map')?.getBoundingClientRect();
    const v = window.__v3;
    const req = v.sel && 'id' in v.sel ? v.world.requests.find((r) => r.id === v.sel.id) : null;
    return {
      card: document.querySelector('.v3-card')?.getAttribute('data-card'),
      state: req?.state ?? null,
      steps: [...document.querySelectorAll('.v3-steps li')].map((l) => (l.classList.contains('on') ? '[' : '') + l.textContent.trim().replace(/^\d+/, '') + (l.classList.contains('on') ? ']' : '')),
      problems: [...document.querySelectorAll('.v3-problems li')].map((l) => l.textContent.trim()),
      route: [...document.querySelectorAll('.v3-route li b')].map((b) => b.textContent.trim()),
      sitePins: document.querySelectorAll('.v3-pin').length,
      siteRecords: v.world.sites.filter((s) => s.state === 'REGISTERED').length,
      bands: document.querySelectorAll('.v3-band').length,
      conflicts: document.querySelectorAll('.v3-conflict').length,
      mode: document.querySelector('.v3-map')?.getAttribute('data-mode'),
      dockShare: dock && map ? Math.round(((dock.width * dock.height) / (map.width * map.height)) * 100) : null,
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      notice: document.querySelector('.v3-notice')?.textContent ?? null,
    };
  });
}

/** Max frame gap while {@code fn} runs (a rAF loop in the page), plus long tasks. */
async function timed(page, fn) {
  await page.evaluate(() => {
    window.__f = [];
    window.__lt = [];
    window.__run = true;
    const loop = (t) => {
      window.__f.push(t);
      if (window.__run) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ type: 'longtask', buffered: false });
    } catch {}
  });
  const t0 = Date.now();
  await fn();
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    window.__run = false;
    const f = window.__f;
    const gaps = f.slice(1).map((t, i) => t - f[i]);
    gaps.sort((a, b) => b - a);
    return { frames: f.length, worstFrameMs: Math.round(gaps[0] ?? 0), p95FrameMs: Math.round(gaps[Math.floor(gaps.length * 0.05)] ?? 0), longTasks: window.__lt.map(Math.round) };
  });
  return { ...r, wallMs: Date.now() - t0 };
}

let TOUCH = false;
async function zoomOnSite(page, siteId) {
  let b = await pinBox(page, siteId);
  if (TOUCH) return b; // no wheel on a touch screen; the first view already shows the sites above the sheet
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(900);
  b = await pinBox(page, siteId);
  return b;
}
async function settle(page) {
  await page.waitForTimeout(900);
}
async function pinBox(page, siteId) {
  const el = await page.$('.v3-pin[data-site="' + siteId + '"]');
  return el ? el.boundingBox() : null;
}
const proposal = (page, key) => page.evaluate((k) => {
  const v = window.__v3;
  const r = v.world.requests.find((x) => x.id === v.sel?.id);
  return k === 'site' ? r?.content.site?.ring : r?.content[k];
}, key);
async function dragShape(page, ring, dx, dy) {
  const at = await page.evaluate((c) => {
    const p = window.__v3.map.latLngToContainerPoint([c.lat, c.lng]);
    const r = document.querySelector('.v3-map').getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, centre(ring));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(at.x + (dx * i) / 24, at.y + (dy * i) / 24);
  await page.mouse.up();
}
async function clickLatLng(page, ll) {
  const at = await page.evaluate((c) => {
    const p = window.__v3.map.latLngToContainerPoint([c.lat, c.lng]);
    const r = document.querySelector('.v3-map').getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, ll);
  await page.mouse.click(at.x, at.y);
}

// every scenario at 1920 (the report picks the key 16); the other sizes get a representative subset
const KEY_SHOTS = {
  1920: Object.fromEntries(CODES.map((c) => [c, 's' + c + '-1920'])),
};

for (const size of SIZES) {
  const [width, height, touch] = ALL[size];
  const ctx = await lib.newContext(browser, { viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  TOUCH = touch;
  const tapAt = (b) => (touch ? page.tap('.v3-pin[data-site="SITE-0101"]') : page.mouse.click(b.x + b.width / 2, b.y + b.height / 2));
  page.on('console', (m) => m.type() === 'error' && results.consoleErrors.push(size + ': ' + m.text()));
  page.on('pageerror', (e) => results.consoleErrors.push(size + ': ' + e.message));

  // ---- every scenario: what the page shows ----
  for (const code of CODES) {
    await open(page, code);
    const f = await facts(page);
    results.scenarios.push({ size, code, ...f });
    const shot = KEY_SHOTS[size]?.[code];
    if (shot || (size !== '1920' && ['C', 'E', 'T', 'U', 'W'].includes(code))) await settle(page);
    if (shot) await page.screenshot({ path: SHOTS + shot + '.png' });
    else if (size !== '1920' && ['C', 'E', 'T', 'U', 'W'].includes(code)) await page.screenshot({ path: SHOTS + 'size-' + size + '-' + code + '.png' });
  }

  // ---- §46 interactions with timing ----
  const I = (name, extra) => results.interactions.push({ size, name, ...extra });
  await open(page, '');
  let box = await zoomOnSite(page, 'SITE-0101');
  I('select site', { ...(await timed(page, () => tapAt(box))), card: (await facts(page)).card, title: await page.textContent('.v3-card h2') });
  I('open hierarchy (organisation card)', { ...(await timed(page, () => page.click('.v3-tree-name >> text=قسم الخدمات الفنية'))), card: (await facts(page)).card, children: await page.$$eval('[data-testid=children] li', (l) => l.length) });

  await open(page, 'E');
  const before = await proposal(page, 'site');
  const t = await timed(page, () => dragShape(page, before, -120, -80));
  const after = await proposal(page, 'site');
  I('drag proposed site', { ...t, movedM: Math.round(dist(centre(before), centre(after))), areaBefore: Math.round(area(before)), areaAfter: Math.round(area(after)) });
  const lt = await timed(page, async () => {
    await page.click('[data-layer=terrain]');
    await page.waitForTimeout(600);
    await page.click('[data-layer=streets]');
  });
  const kept = await proposal(page, 'site');
  I('switch layers streets → terrain → streets', { ...lt, proposalUnchanged: JSON.stringify(kept) === JSON.stringify(after), card: (await facts(page)).card });
  const H = await page.evaluate(() => window.__v3.world.sites.find((s) => s.id === 'SITE-0108').ring);
  const toH = await page.evaluate(([a, b]) => {
    const m = window.__v3.map;
    const p = m.latLngToContainerPoint([a.lat, a.lng]);
    const q = m.latLngToContainerPoint([b.lat, b.lng]);
    return { dx: q.x - p.x, dy: q.y - p.y };
  }, [centre(after), centre(H)]);
  const tc = await timed(page, () => dragShape(page, after, toH.dx, toH.dy));
  I('show conflict (drop on occupied site H)', { ...tc, readout: await page.textContent('[data-testid=site-readout]'), conflictShapes: (await facts(page)).conflicts });

  await open(page, 'P');
  await page.$eval('.v3-steps li:nth-child(4) button', (b) => (b.scrollIntoView({ inline: 'center', block: 'nearest' }), b.click()));
  await page.waitForTimeout(900);
  const site = await page.evaluate(() => window.__v3.world.requests[0].content.site.ring);
  const bands = (await facts(page)).bands;
  const c = centre(site);
  const tp = await timed(page, () => clickLatLng(page, { lat: c.lat + 0.055, lng: c.lng + 0.02 }));
  await page.waitForTimeout(300);
  const placed = await proposal(page, 'primary');
  I('place primary deployment area inside its guidance band', { ...tp, bands, placed: !!placed, distanceKm: placed ? +(dist(c, centre(placed)) / 1000).toFixed(2) : null, status: await page.getAttribute('[data-testid=leg-primary]', 'data-status') });
  if (placed) {
    const td = await timed(page, () => dragShape(page, placed, 60, 30));
    I('drag deployment area', { ...td, status: await page.getAttribute('[data-testid=leg-primary]', 'data-status') });
    const a0 = area(await proposal(page, 'primary'));
    const ts = await timed(page, () => page.fill('[data-testid=size]', '1000'));
    I('resize deployment area', { ...ts, areaBeforeM2: Math.round(a0), areaAfterM2: Math.round(area(await proposal(page, 'primary'))) });
  }
  await open(page, 'T');
  const tt = await timed(page, async () => {
    await page.evaluate(() => window.__v3.map.setView([25.26, 55.37], 13, { animate: false }));
    await page.waitForTimeout(800);
  });
  I('terrain layer at zoom 13 (relief + contours)', { ...tt, mode: (await facts(page)).mode, band: await page.textContent('[data-testid=band-primary]') });
  await open(page, 'R');
  I('occupied deployment area is blocked', { worstFrameMs: 0, conflict: await page.textContent('[data-testid=deploy-conflict-primary]').catch(() => null), problems: null });
  await open(page, 'U');
  const zs = await timed(page, async () => {
    await page.evaluate(() => window.__v3.map.setView([25.215, 55.31], 16, { animate: false }));
    await page.waitForTimeout(900);
  });
  I('streets with road names at zoom 16', { ...zs, mode: (await facts(page)).mode });
  if (size === '1920') await settle(page), await page.screenshot({ path: SHOTS + '19-street-names-z16.png' });
  if (size === '1920') await settle(page), await page.screenshot({ path: SHOTS + '18-terrain-layer-relief.png' });

  // ---- the full journey from a clean world, counting the user's actions ----
  if (!touch || size === '768') {
    await open(page, '');
    const steps = [];
    const step = async (what, fn) => {
      await fn();
      await page.waitForTimeout(250);
      steps.push(what);
    };
    if (touch) box = await pinBox(page, 'SITE-0101');
    else await step('تقريب الخريطة على المنطقة (عجلة الفأرة)', async () => void (box = await zoomOnSite(page, 'SITE-0101')));
    await step('اختيار الموقع A على الخريطة', () => tapAt(box));
    await step('«إعادة تمركز»', () => page.click('[data-testid=restation]'));
    await step('«+ الموجودون معها»', () => page.click('[data-preset=WITH_COLOCATED]'));
    await step('قسم الشبكات: «تبقى في موقعها»', () => page.click('[data-occupant=u802] input >> nth=0'));
    if (size === '1920') await settle(page), await page.screenshot({ path: SHOTS + '03-select-who-moves.png' });
    await step('التالي', () => page.click('[data-testid=next]'));
    await step('«دائم» (الافتراضي) + كتابة السبب', () => page.fill('[data-testid=reason]', 'تجميع القسم ووحداته في موقع واحد'));
    await step('التالي', () => page.click('[data-testid=next]'));
    await page.waitForTimeout(600);
    const s0 = await proposal(page, 'site');
    const toNew = await page.evaluate((a) => {
      const m = window.__v3.map;
      const p = m.latLngToContainerPoint([a.lat, a.lng]);
      const q = m.latLngToContainerPoint([25.229, 55.292]);
      return { dx: q.x - p.x, dy: q.y - p.y };
    }, centre(s0));
    await step('سحب الموقع إلى المكان الجديد', () => dragShape(page, s0, toNew.dx, toNew.dy));
    if (size === '1920') await settle(page), await page.screenshot({ path: SHOTS + '06-drag-site-new-location.png' });
    await step('التالي', () => page.click('[data-testid=next]'));
    await page.waitForTimeout(700);
    const sNew = centre(await proposal(page, 'site'));
    await step('نقرة لوضع منطقة الانتشار الرئيسية', () => clickLatLng(page, { lat: sNew.lat + 0.033, lng: sNew.lng + 0.044 }));
    await step('التالي', () => page.click('[data-testid=next]'));
    await page.waitForTimeout(700);
    const pr = centre(await proposal(page, 'primary'));
    await step('نقرة لوضع منطقة الانتشار البديلة', () => clickLatLng(page, { lat: pr.lat + 0.028, lng: pr.lng - 0.026 }));
    if (size === '1920') await settle(page), await page.screenshot({ path: SHOTS + '07-alternative-placed.png' });
    await step('التالي: المراجعة', () => page.click('[data-testid=next]'));
    if (size === '1920') await settle(page), await page.screenshot({ path: SHOTS + '08-review-route-preview.png' });
    const review = await facts(page);
    await step('«إرسال الطلب»', () => page.click('[data-act=SUBMIT]'));
    const end = await facts(page);
    results.journey.push({ size, actions: steps.length, steps, reviewProblems: review.problems, route: review.route, finalCard: end.card, finalState: end.state });
  }
  await ctx.close();
}
await browser.close();
writeFileSync(OUT + 'results.json', JSON.stringify(results, null, 2));
const bad = results.journey.filter((j) => j.finalState !== 'UNDER_REVIEW');
console.log('scenarios', results.scenarios.length, '· interactions', results.interactions.length, '· journeys', results.journey.length, '· journey failures', bad.length, '· external', results.external.length, '· console errors', results.consoleErrors.length);
for (const i of results.interactions) console.log(i.size, i.name, 'worst', i.worstFrameMs, 'ms p95', i.p95FrameMs, 'ms', i.longTasks?.length ? 'long tasks ' + i.longTasks.join('/') : '');
for (const j of results.journey) console.log(j.size, 'journey', j.actions, 'actions →', j.finalState, j.reviewProblems.join(' | '));
