// Administrative UI regression and map pointer alignment (ADR-105), headless Edge against the throw-away installation of
// update-center/setup.sh (tmrkz-vmsim). Fictional data; the map geometry is synthetic and only drawn in the page (nothing saved).
//   node tests/acceptance/ui-regression.mjs <base-dir> [port]
//
// UI-01 every main page at seven window sizes and scalings: no horizontal overflow, no fixed or sticky panel over another, the
//       main content not under the top bar, no script error; UI-02 navigation reaches each page (the menu button on narrow
//       screens); UI-03 loading states show while data is slow and give way to the content; UI-04 failed calls show a message,
//       never an empty or broken page; MAP-A pointer alignment: a real pointer over synthetic points lands on the same
//       coordinates and the same rendered feature at browser zoom 100/125/150/200 % and display scaling 125/150 %.
// Timings are measured on the development machine and say nothing about the VM.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = process.argv[2];
const PORT = process.argv[3] ?? '8188';
if (!BASE) throw new Error('usage: node tests/acceptance/ui-regression.mjs <base-dir> [port]');
const VM = join(BASE, 'vm', 'TMRKZ');
const URL_ = `http://localhost:${PORT}`;
const OUT = join(BASE, 'evidence-ui');
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(join(VM, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const results = [];
const timings = [];
const ok = (cond, id, label, extra = '') => {
  results.push({ id, pass: !!cond, label, extra: String(extra).slice(0, 400) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = [
  { name: '1920x1080', width: 1920, height: 1080, dsf: 1 },
  { name: '1440x900', width: 1440, height: 900, dsf: 1 },
  { name: '1366x768', width: 1366, height: 768, dsf: 1 },
  { name: '1280x800@125%', width: 1280, height: 800, dsf: 1.25 },
  { name: '1024x768', width: 1024, height: 768, dsf: 1 },
  { name: 'tablet-768x1024@2x', width: 768, height: 1024, dsf: 2 },
  { name: 'phone-390x844@3x', width: 390, height: 844, dsf: 3 },
];
const PAGES = ['home', 'settings', 'org', 'allRequests', 'posture', 'stationing', 'review', 'audit'];

const { chromium } = await import(pathToFileURL(join(ROOT, 'tests/acceptance/node_modules/playwright-core/index.mjs')).href);
const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function signedIn(size) {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dsf, isMobile: size.width < 800, hasTouch: size.width < 800 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (let attempt = 1; ; attempt++) {
    await page.goto(URL_ + '/');
    await page.getByText('إدخال رقم الـــــ U وكلمة المرور يدويا').click({ timeout: 60000 });
    await page.locator('#tm-username').fill('admin');
    await page.locator('#tm-password').fill(env.TMRKZ_PLATFORM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
    try {
      await page.waitForSelector('main#main', { timeout: 30000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
  return { ctx, page, errors };
}

/** Layout problems of the page as it is now: horizontal overflow, fixed or sticky panels over each other, content under the bar. */
const layout = (page) => page.evaluate(() => {
  const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, overlaps: [], underBar: 0 };
  const panels = [...document.querySelectorAll('body *')].filter((e) => {
    const s = getComputedStyle(e);
    if (!(s.position === 'fixed' || s.position === 'sticky') || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight && !e.hidden;
  });
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '');
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i];
      const b = panels[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2) {
        // what the person sees there: an overlap counts when one of the two is on top at the shared area (a panel parked
        // fully behind a third one, such as a collapsed bottom sheet under the tab bar, is not seen)
        const x = Math.max(ra.left, rb.left) + w / 2;
        const y = Math.max(ra.top, rb.top) + h / 2;
        const top = document.elementFromPoint(Math.min(window.innerWidth - 1, Math.max(0, x)), Math.min(window.innerHeight - 1, Math.max(0, y)));
        // a panel whose whole visible part lies under a higher one is parked there (a collapsed sheet under the tab bar)
        const z = (e) => Number(getComputedStyle(e).zIndex) || 0;
        const [low, high] = z(a) <= z(b) ? [ra, rb] : [rb, ra];
        const vis = { l: Math.max(0, low.left), t: Math.max(0, low.top), r: Math.min(window.innerWidth, low.right), b: Math.min(window.innerHeight, low.bottom) };
        const parked = vis.l >= high.left - 0.5 && vis.r <= high.right + 0.5 && vis.t >= high.top - 0.5 && vis.b <= high.bottom + 0.5;
        if (!parked && top && (a.contains(top) || b.contains(top))) out.overlaps.push(`${name(a)} × ${name(b)} (${Math.round(w)}×${Math.round(h)})`);
      }
    }
  }
  const bar = document.querySelector('header');
  const main = document.querySelector('main#main');
  if (bar && main && getComputedStyle(bar).position !== 'static') {
    out.underBar = Math.max(0, bar.getBoundingClientRect().bottom - main.getBoundingClientRect().top - 1);
  }
  return out;
});

async function goTo(page, view) {
  const t0 = Date.now();
  await page.evaluate((v) => { window.location.hash = v; }, view);
  await page.waitForSelector('main#main', { timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(400);
  return Date.now() - t0;
}

try {
  // ---- UI-01 / UI-02 every page at every size ------------------------------------------------------------------------------
  for (const size of SIZES) {
    const { ctx, page, errors } = await signedIn(size);
    const problems = [];
    for (const view of PAGES) {
      const ms = await goTo(page, view);
      timings.push({ size: size.name, view, ms });
      const l = await layout(page);
      if (l.overflow > 1) problems.push(`${view}: horizontal overflow ${l.overflow}px`);
      if (l.overlaps.length) problems.push(`${view}: ${l.overlaps.slice(0, 3).join('; ')}`);
      if (l.underBar > 0) problems.push(`${view}: content under the top bar by ${Math.round(l.underBar)}px`);
      if (['home', 'settings', 'stationing'].includes(view)) {
        await page.screenshot({ path: join(OUT, `ui-${size.name}-${view}.png`) }).catch(() => {});
      }
    }
    ok(problems.length === 0, 'UI-01', `${size.name}: ${PAGES.length} pages without overflow, overlapping panels or hidden content`, problems.join(' | '));
    ok(errors.length === 0, 'UI-01', `${size.name}: no script error`, errors.slice(0, 3).join(' | '));
    // «المزيد» (owner report 25 Nov 2026): its menu must really be on screen — the element under its first item is the item
    await goTo(page, 'home');
    const moreBtn = page.locator('.tz-more > button');
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
      await sleep(400);
      const seen = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.tz-menu [role=menuitem]')];
        if (!items.length) return { items: 0, onTop: 0 };
        const onTop = items.filter((it) => { const r = it.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && e && it.contains(e); }).length;
        return { items: items.length, onTop };
      });
      if (size.name === '1440x900') await page.screenshot({ path: join(OUT, 'ui-more-menu.png') }).catch(() => {});
      ok(seen.items > 0 && seen.onTop === seen.items, 'UI-02', `${size.name}: «المزيد» opens a menu whose every item is visible and clickable`, `${seen.onTop}/${seen.items}`);
      await page.keyboard.press('Escape');
      await page.mouse.click(5, size.height - 5);
    }
    // navigation: the menu (the menu button on narrow screens) reaches «إدارة النظام» and back home
    // narrow screens: the menu button; medium ones: items that do not fit are under «المزيد» (priority navigation)
    const burger = page.locator('.tz-burger');
    let via = '';
    if (await burger.isVisible().catch(() => false)) { await burger.click(); via = ' through the menu button'; }
    const link = () => page.getByText('إدارة النظام', { exact: true }).filter({ visible: true }).first();
    if (!(await link().count())) {
      const more = page.getByText('المزيد', { exact: true }).filter({ visible: true }).first();
      if (await more.count()) { await more.click(); via = ' through «المزيد»'; }
    }
    const onTop = await link().evaluate((el) => { const r = el.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && el.contains(e); });
    ok(onTop, 'UI-02', `${size.name}: «إدارة النظام» is visible where it is clicked${via}`);
    await link().click({ timeout: 10000 });
    const reached = await page.locator('[data-testid=update-center]').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    ok(reached, 'UI-02', `${size.name}: the navigation reaches «إدارة النظام»${via}`);
    await ctx.close();
  }

  // ---- UI-03 loading states and UI-04 error messages ---------------------------------------------------------------------------
  {
    const { ctx, page, errors } = await signedIn(SIZES[1]);
    await page.route('**/api/v1/settings/certificates', async (route) => { await sleep(2500); await route.continue(); });
    await goTo(page, 'home');
    await page.evaluate(() => { window.location.hash = 'settings'; });
    await page.locator('[data-testid=cert-summary]').waitFor({ timeout: 30000 });
    const during = await page.locator('[data-testid=cert-summary]').innerText();
    await sleep(3500);
    const after = await page.locator('[data-testid=cert-summary]').innerText();
    ok(during.includes('تحميل') && !after.includes('تحميل'), 'UI-03', 'a slow call shows its loading state, then the content', `${during} → ${after.slice(0, 60)}`);
    const updatesBefore = await page.locator('[data-testid=update-worker]').innerText();
    ok(!updatesBefore.includes('التحقق من عامل'), 'UI-03', 'the Update Center leaves its loading state', updatesBefore);
    await page.unroute('**/api/v1/settings/certificates');
    await page.route('**/api/v1/settings/certificates', (route) => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'تعذر الوصول إلى الخدمة (اختبار)' }) }));
    await page.route('**/api/v1/updates', (route) => route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'خطأ اختبار في الخادم' }) }));
    await page.reload();
    await page.waitForSelector('main#main', { timeout: 30000 });
    await page.evaluate(() => { window.location.hash = 'settings'; });
    await page.locator('[data-testid=cert-summary]').waitFor({ timeout: 30000 });
    await sleep(1500);
    const certErr = await page.locator('[data-testid=cert-summary]').innerText();
    const toast = await page.locator('#toast').innerText().catch(() => '');
    const blank = await page.evaluate(() => (document.querySelector('main#main')?.innerText ?? '').trim().length);
    await page.screenshot({ path: join(OUT, 'ui-04-errors.png') }).catch(() => {});
    ok(certErr.includes('تعذر الوصول') && toast.includes('خطأ اختبار') && blank > 200, 'UI-04',
      'a failed call shows its message (in place and as a notice); the rest of the page stays usable', `${certErr} | ${toast}`);
    ok(errors.length === 0, 'UI-04', 'failed calls cause no script error', errors.join(' | '));
    await ctx.close();
  }

  // ---- UI-05 «إعدادات النظام» organised in groups; MAP-B every map page opens on the whole country (owner, 25 Nov 2026) ------------
  {
    const { ctx, page } = await signedIn(SIZES[1]);
    await goTo(page, 'settings');
    await page.locator('[data-testid=settings-nav]').waitFor({ timeout: 30000 });
    const visibleIds = () => page.evaluate(() => [...document.querySelectorAll('.settings-section')].filter((x) => !x.hidden).map((x) => x.id));
    const all = await visibleIds();
    await page.screenshot({ path: join(OUT, 'ui-settings-all.png') }).catch(() => {});
    await page.locator('[data-testid=settings-nav-security]').click();
    const one = await visibleIds();
    const certShown = await page.locator('[data-testid=cert-center]').isVisible();
    await page.screenshot({ path: join(OUT, 'ui-settings-security.png') }).catch(() => {});
    await page.locator('[data-testid=settings-search]').fill('LDAP');
    const found = await visibleIds();
    await page.locator('[data-testid=settings-nav-all]').click();
    const back = await visibleIds();
    ok(all.length >= 7 && one.length === 1 && one[0] === 'settings-security' && certShown && found.includes('settings-identity') && !found.includes('settings-security')
      && back.length === all.length, 'UI-05', 'settings: every group in «الكل», one group from the menu, search narrows, «الكل» restores', `${all.length}/${one.join()}/${found.join()}`);
    const tiles = await page.locator('[data-testid=settings-overview] button').count();
    ok(tiles >= 4, 'UI-05', 'settings: status cards open their group', tiles + ' cards');
    for (const view of ['stationing', 'siteSetup']) {
      await goTo(page, view);
      const loaded = await page.waitForFunction(() => { const w = document.querySelector('.tz-map-layer'); return !!(w && w.tmrkzMap && w.tmrkzMap.loaded()); }, null, { timeout: 60000 })
        .then(() => true).catch(() => false);
      const country = () => page.evaluate(() => { const b = document.querySelector('.tz-map-layer').tmrkzMap.getBounds();
        return b.getWest() <= 52.2 && b.getEast() >= 56.0 && b.getSouth() <= 23.2 && b.getNorth() >= 25.8; });
      const opens = loaded && await country();
      await page.evaluate(() => document.querySelector('.tz-map-layer').tmrkzMap.jumpTo({ center: [55.3, 25.2], zoom: 13 }));
      const zoomedIn = !(await country());
      await page.locator('[data-testid=map-full-view]').first().click();
      await sleep(1200);
      const returns = await country();
      if (view === 'siteSetup') await page.screenshot({ path: join(OUT, 'map-full-view.png') }).catch(() => {});
      ok(opens && zoomedIn && returns, 'MAP-B', `«${view}» opens on the whole country; «الخريطة كاملة» returns to it after zooming in`, `${opens}/${zoomedIn}/${returns}`);
    }
    await goTo(page, 'home');
    ok(await page.locator('[data-testid=map-full-view]').count() > 0, 'MAP-B', 'the home map carries «الخريطة كاملة» too');
    await ctx.close();
  }

  // ---- MAP-A pointer alignment with synthetic geometry -----------------------------------------------------------------------
  const ZOOMS = [
    { name: 'browser 100%', width: 1440, height: 900, dsf: 1 },
    { name: 'browser 125%', width: 1152, height: 720, dsf: 1.25 },
    { name: 'browser 150%', width: 960, height: 600, dsf: 1.5 },
    { name: 'browser 200%', width: 720, height: 450, dsf: 2 },
    { name: 'display 125%', width: 1440, height: 900, dsf: 1.25 },
    { name: 'display 150%', width: 1280, height: 720, dsf: 1.5 },
  ];
  for (const z of ZOOMS) {
    const { ctx, page } = await signedIn(z);
    await goTo(page, 'stationing');
    const ready = await page.waitForFunction(() => {
      const w = document.querySelector('.tz-map-layer');
      return !!(w && w.tmrkzMap && w.tmrkzMap.isStyleLoaded && w.tmrkzMap.loaded());
    }, null, { timeout: 60000 }).then(() => true).catch(() => false);
    if (!ready) {
      ok(false, 'MAP-A', `${z.name}: the map did not load`);
      await ctx.close();
      continue;
    }
    // synthetic geometry around the map's centre: five points and a polygon, drawn in the page only
    const pts = await page.evaluate(() => {
      const m = document.querySelector('.tz-map-layer').tmrkzMap;
      const c = m.getCenter();
      const d = 0.02;
      const points = [[c.lng, c.lat], [c.lng + d, c.lat + d], [c.lng - d, c.lat + d], [c.lng + d, c.lat - d], [c.lng - d, c.lat - d]];
      m.addSource('e2e-align', { type: 'geojson', data: { type: 'FeatureCollection', features: [
        ...points.map((p, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: p } })),
        { type: 'Feature', properties: { i: 'poly' }, geometry: { type: 'Polygon', coordinates: [[points[1], points[2], points[4], points[3], points[1]]] } },
      ] } });
      m.addLayer({ id: 'e2e-align-fill', type: 'fill', source: 'e2e-align', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#d33', 'fill-opacity': 0.15 } });
      m.addLayer({ id: 'e2e-align-points', type: 'circle', source: 'e2e-align', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#d33' } });
      window.__align = [];
      m.on('mousemove', (e) => { window.__align.push({ lng: e.lngLat.lng, lat: e.lngLat.lat, x: e.point.x, y: e.point.y,
        hit: m.queryRenderedFeatures(e.point, { layers: ['e2e-align-points'] }).map((f) => f.properties.i) }); });
      return points;
    });
    await page.waitForFunction(() => document.querySelector('.tz-map-layer').tmrkzMap.loaded(), null, { timeout: 20000 }).catch(() => {});
    let worst = 0;
    let worstGeo = 0;
    let hits = 0;
    for (let i = 0; i < pts.length; i++) {
      const target = await page.evaluate(([lng, lat]) => {
        const m = document.querySelector('.tz-map-layer').tmrkzMap;
        const p = m.project([lng, lat]);
        const r = m.getCanvas().getBoundingClientRect();
        return { x: r.left + p.x, y: r.top + p.y, inside: p.x > 0 && p.y > 0 && p.x < r.width && p.y < r.height };
      }, pts[i]);
      if (!target.inside) continue;
      // a pointer is at whole CSS pixels (up to 0.71 px from a point) and the map reads it back within a few tenths: move to the
      // nearest pixel, then compare where the map says the pointer is (its event
      // point) with where the pointer really is on its canvas, and the coordinates it reports with the synthetic point
      const px = Math.round(target.x);
      const py = Math.round(target.y);
      await page.mouse.move(px - 25, py - 25);
      await page.mouse.move(px, py, { steps: 4 });
      await sleep(150);
      const m = await page.evaluate(([x, y, ll]) => {
        const map = document.querySelector('.tz-map-layer').tmrkzMap;
        const last = window.__align.at(-1);
        const r = map.getCanvas().getBoundingClientRect();
        const p = map.project([last.lng, last.lat]);
        const q = map.project(ll);
        const expected = map.project(map.unproject([x - r.left, y - r.top]));
        return { pointer: Math.hypot(last.x - (x - r.left), last.y - (y - r.top)), geo: Math.hypot(p.x - q.x, p.y - q.y),
          hit: last.hit, drift: Math.hypot(expected.x - (x - r.left), expected.y - (y - r.top)) };
      }, [px, py, pts[i]]);
      worst = Math.max(worst, m.pointer);
      worstGeo = Math.max(worstGeo, m.geo);
      if (m.hit.includes(i)) hits++;
    }
    await page.screenshot({ path: join(OUT, `map-align-${z.name.replace(/[ %]/g, '')}.png`) }).catch(() => {});
    ok(worst <= 0.5 && worstGeo <= 1.0 && hits >= 3, 'MAP-A',
      `${z.name}: the map reads the pointer where it is (worst ${worst.toFixed(2)} px) and on the synthetic points (worst ${worstGeo.toFixed(2)} px, whole-pixel pointer; ${hits}/5 hit)`);
    await ctx.close();
  }
} catch (e) {
  ok(false, 'XX', 'unexpected error', e.stack);
} finally {
  await browser.close();
  const byView = {};
  for (const t of timings) (byView[t.view] ??= []).push(t.ms);
  const summary = Object.fromEntries(Object.entries(byView).map(([v, l]) => [v, { medianMs: l.sort((a, b) => a - b)[Math.floor(l.length / 2)], maxMs: Math.max(...l) }]));
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ results, timings: { note: 'development machine (Docker Desktop, headless Edge); not VM measurements', summary, all: timings } }, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed — evidence in ${OUT}`);
  console.log('page timings (development machine only):', JSON.stringify(summary));
  process.exit(failed ? 1 : 0);
}
