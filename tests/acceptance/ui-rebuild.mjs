// Owner brief «FULL APPLICATION UI REBUILD» (5 Nov 2026), first delivery: the operational shell, the Stationing /
// re-stationing workspace and the home dashboard on the REAL application, headless Edge, fictional acceptance data.
//
//   REUSE_DRAFT=RS-2026-0057 node tests/acceptance/ui-rebuild.mjs   # dev server (UI_URL, default :5180); reuses a draft, creates none
//   UI_URL=http://localhost:8088 node tests/acceptance/ui-rebuild.mjs   # against a web image that carries this UI
//
// Sign-in is the real Keycloak/LDAP one of tmrkz-test (AUTH_URL, default http://localhost:8088); the session cookie of
// localhost serves both. Writes ONE fictional draft (labelled «بيانات قبول وهمية») for screenshots C–E and the
// geometry check; it is never submitted. Evidence: docs/evidence/ui-rebuild/first-delivery/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { partVectors, proposedParts, recordOf, rendersRole, ringCentre, slowDrag, toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5180';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8088';
const OUT = new URL('../../docs/evidence/ui-rebuild/first-delivery/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, OUT));
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const require = createRequire(new URL('./package.json', import.meta.url));
const { chromium } = require('playwright-core');
const DATA = 'بيانات قبول وهمية';
const UNDER_REVIEW = process.env.UNDER_REVIEW ?? 'RS-2026-0043';
const SIZES = { desktop: [1920, 1080], laptop: [1366, 768], tablet: [1024, 768], mobile: [390, 844] };

const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const external = [];
const consoleErrors = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function pageAs(user, [w, h]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 500, hasTouch: w < 500 });
  const page = await ctx.newPage();
  page.on('request', (q) => { const u = q.url(); if (!u.startsWith(UI) && !u.startsWith(AUTH) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${user}@${w}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${user}@${w}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(AUTH + '/api/v1/auth/oidc/start');
  await page.waitForSelector('#kc-form-login', { timeout: 30000 });
  await page.fill('#username', user);
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.toString().startsWith(AUTH) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
  return page;
}
const api = (page, path, init) => page.evaluate(async ([p, i]) => { const r = await fetch('/api/v1' + p, i); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, init]);
const idOf = async (page, number) => (await api(page, '/restationing-requests')).body.find((r) => r.number === number)?.id;
async function open(page, hash, settle = 3500) {
  await page.goto(UI + '/#' + hash);
  await page.waitForSelector('.tz-top', { timeout: 30000 });
  if (hash.startsWith('restationing') || hash.startsWith('stationing')) await page.waitForSelector('.tz-mapframe canvas.maplibregl-canvas, .tz-empty', { timeout: 30000 });
  await page.waitForTimeout(settle);
}
const box = (page, sel) => page.locator(sel).first().boundingBox();
const noHorizontalScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

// ---- A + B at every size, and the layout checks ------------------------------------------------------------------------
let rid;
for (const [name, size] of Object.entries(SIZES)) {
  const [w] = size;
  const page = await pageAs('t.requester', size);
  await open(page, 'home');
  await page.screenshot({ path: shot(`A-home-${name}.png`) });
  const rtl = await page.evaluate(() => document.documentElement.dir);
  const brand = await box(page, '.tz-brand');
  ok(rtl === 'rtl' && brand && brand.x > w / 2 && (await noHorizontalScroll(page)), `SHELL-${name}`, `RTL shell at ${size.join('×')}: brand on the right, no horizontal scroll`, `dir=${rtl}, brand x=${Math.round(brand?.x ?? -1)}`);
  rid ??= await idOf(page, UNDER_REVIEW);
  await open(page, 'restationing/' + rid);
  await page.screenshot({ path: shot(`B-request-${name}.png`) });
  const map = await box(page, '.tz-mapframe');
  const ctxBox = await box(page, '.tz-col-context');
  const rail = await box(page, '.tz-col-rail');
  if (name === 'desktop' || name === 'laptop') {
    ok(map.width >= w * 0.45 && ctxBox.x > map.x && rail.x < map.x && (await noHorizontalScroll(page)), `LAYOUT-${name}`,
      'three-column console: context panel right, map centre (dominant), action panel left', `map ${Math.round(map.width)}px of ${w}; context x ${Math.round(ctxBox.x)}, rail x ${Math.round(rail.x)}`);
    const strip = await box(page, '.tz-strip');
    ok(strip && strip.y + strip.height <= size[1] + 1 && strip.y > map.y, `STRIP-VISIBLE-${name}`, 'the approval strip sits along the bottom of the map, inside the screen', `strip y ${Math.round(strip?.y ?? -1)}`);
  }
  if (name === 'tablet') {
    const railW = rail.width;
    const textShown = await page.locator('.tz-action-text').first().isVisible();
    await page.getByRole('button', { name: 'طي التفاصيل' }).click();
    await page.waitForTimeout(400);
    const wider = (await box(page, '.tz-mapframe')).width;
    await page.screenshot({ path: shot(`B-request-tablet-context-collapsed.png`) });
    ok(railW < 100 && !textShown && wider > map.width + 150, 'TABLET', 'tablet: compact action rail; the context panel collapses and the map widens', `rail ${Math.round(railW)}px; map ${Math.round(map.width)} → ${Math.round(wider)}px`);
  }
  if (name === 'mobile') {
    const sheetBefore = await page.locator('.tz-col-context').evaluate((e) => e.getBoundingClientRect().top >= window.innerHeight - 5);
    await page.locator('.tz-sheet-tabs button').nth(2).click();
    await page.waitForTimeout(500);
    const sheetAfter = await page.locator('.tz-col-context').evaluate((e) => e.getBoundingClientRect().top < window.innerHeight * 0.6);
    await page.screenshot({ path: shot(`B-request-mobile-details-sheet.png`) });
    await page.locator('.tz-sheet-tabs button').nth(0).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot(`B-request-mobile-requests-sheet.png`) });
    ok(map.y < 140 && sheetBefore && sheetAfter && (await noHorizontalScroll(page)), 'MOBILE', 'phone: map first; details and requests open as bottom sheets', `map top ${Math.round(map.y)}px`);
  }
  await page.context().close();
}

// ---- owner decisions of 5 Nov 2026: one re-stationing workflow, MAP FIRST, the Sites page, registered sites -----------
/** A registered site drawn on the map (optionally one given site) not covered by the request's shapes: its pixel. */
const findRefSite = (page, only = null) => page.evaluate((only) => {
  const wrap = document.querySelector('.tz-mapframe .tz-map-layer');
  const map = wrap?.tmrkzMap;
  if (!map) return null;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const own = ['rs-fill', 'rs-hatch', 'rs-line', 'rs-move', 'rs-label'].filter((l) => map.getLayer(l));
  const ref = ['ref-fill', 'ref-marker', 'ref-dot'].filter((l) => map.getLayer(l));
  for (const f of map.queryRenderedFeatures({ layers: ref })) {
    if (only && f.properties.siteId !== only) continue;
    let pts;
    if (f.geometry.type === 'Point') pts = [f.geometry.coordinates];
    else {
      const ring = (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates[0])[0];
      const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
      pts = [c, ...ring.map((p) => [c[0] * 0.6 + p[0] * 0.4, c[1] * 0.6 + p[1] * 0.4])];
    }
    for (const ll of pts) {
      const p = map.project(ll);
      if (p.x < 40 || p.y < 40 || p.x > w - 40 || p.y > h - 40) continue;
      const here = map.queryRenderedFeatures([p.x, p.y], { layers: ref });
      if (here.some((x) => x.properties.siteId === f.properties.siteId) && map.queryRenderedFeatures([p.x, p.y], { layers: own }).length === 0)
        return { x: p.x, y: p.y, siteId: f.properties.siteId, name: f.properties.name };
    }
  }
  return null;
}, only);
const clickInCanvas = async (page, p) => {
  const c = await box(page, '.tz-mapframe canvas.maplibregl-canvas');
  await page.mouse.click(c.x + p.x, c.y + p.y);
};
const attr = async (page, name) => page.locator('.tz-mapframe .tz-map-layer').first().getAttribute(name);
const unitNamesAt = (current, siteId) => [...new Set(current.filter((c) => c.siteId === siteId).map((c) => c.orgName))];
{
  const page = await pageAs('t.requester', SIZES.desktop);
  const features = (await (async () => { await page.goto(UI + '/'); return api(page, '/map/features'); })()).body.features.filter((f) => f.view !== 'CONTEXT');
  const current = (await api(page, '/stationing/current')).body;
  const stationedSite = features.find((f) => current.some((c) => c.siteId === f.siteId));

  // 1. #restationing opens no request by itself
  await open(page, 'restationing', 4500);
  const summary = await page.locator('.rs-summary').count();
  const hint = await page.locator('.tz-map-hint').isVisible().catch(() => false);
  const hash = await page.evaluate(() => location.hash);
  const startSites = Number(await attr(page, 'data-sites'));
  await page.screenshot({ path: shot('H-restationing-start-registered-sites.png') });
  ok(summary === 0 && hint && hash === '#restationing', 'NO-AUTO-OPEN', '«إعادة التمركز» opens no request by itself: the start view waits for a choice', `hash ${hash}, summary cards ${summary}, hint ${hint}`);
  ok(startSites > 0, 'REF-SITES-START', 'the registered sites are drawn on the re-stationing start map', `${startSites} sites`);

  // 2. a request view: registered sites as reference; a click shows information and changes nothing
  await open(page, 'restationing/' + rid, 4500);
  const refCount = Number(await attr(page, 'data-ref-sites'));
  const before = (await api(page, '/restationing-requests/' + rid)).body;
  // zoomed out, neighbouring sites are one group bubble whose click zooms in; zoom to a site first, as a user would
  await page.evaluate(() => {
    const map = document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap;
    const f = map.querySourceFeatures('ref-sites').find((x) => x.properties.role === 'REF_LABEL' || x.properties.role === 'REF_MARKER');
    if (f) map.jumpTo({ center: f.geometry.coordinates, zoom: 13 });
  });
  await page.waitForTimeout(1500);
  const target = await findRefSite(page);
  let card = '';
  if (target) {
    await clickInCanvas(page, target);
    await page.waitForTimeout(600);
    card = (await page.locator('[data-testid=site-info]').textContent().catch(() => '')) ?? '';
    await page.screenshot({ path: shot('H-request-registered-site-info.png') });
  }
  const after = (await api(page, '/restationing-requests/' + rid)).body;
  const same = JSON.stringify({ c: before.content, s: before.state, v: before.revisions.length }) === JSON.stringify({ c: after.content, s: after.state, v: after.revisions.length });
  ok(refCount > 0, 'REF-SITES-REQUEST', 'the registered sites are drawn as a reference layer on the request map', `${refCount} sites`);
  ok(target && card.includes(target.name) && card.includes('للمرجع فقط') && same && !card.includes('استخدام هذا الموقع'), 'REF-CLICK',
    'a click on a registered site shows its information only; the request is unchanged (server, before and after)', target ? `«${target.name}»; request unchanged ${same}` : 'no registered site found in view');

  // 3. a NEW request starts MAP FIRST: step 1 is the map with the registered sites, nothing chosen, no list, no ring
  const countBefore = (await api(page, '/restationing-requests')).body.length;
  const writes = [];
  page.on('request', (q) => q.method() !== 'GET' && q.url().includes('/restationing-requests') && writes.push(q.method() + ' ' + q.url()));
  await open(page, 'restationing/new', 4500);
  const q1 = await page.locator('[data-testid=flow-question]').textContent();
  const panel1 = (await page.locator('.tz-flow').textContent()) ?? '';
  const lists1 = (await page.locator('.tz-flow .rs-check, .tz-flow select, [data-testid=site-pick]').count()) + (await page.locator('.rs-list').count());
  const ctx1 = (await page.locator('[data-testid=request-context]').textContent()) ?? '';
  const bands1 = await attr(page, 'data-bands');
  const ref1 = Number(await attr(page, 'data-ref-sites'));
  const strip1 = await page.locator('.tz-strip').count();
  await page.screenshot({ path: shot('K-step1-map-first.png') });
  ok(q1.trim() === 'اختر الموقع الحالي' && panel1.includes('اضغط على أحد المواقع في الخريطة') && panel1.includes('الخطوة 1 من 6') && lists1 === 0 && bands1 === '0' && ref1 > 0 && strip1 === 0 && ctx1.includes('لم يتم اختيار موقع بعد'),
    'STEP1', 'a new request opens MAP FIRST: «الخطوة 1 من 6 · اختر الموقع الحالي · اضغط على أحد المواقع في الخريطة», registered sites on the map, the context waiting; no list, no selected site, no ring, no route',
    `${ref1} sites drawn; lists ${lists1}; bands ${bands1}; strip ${strip1}`);

  // 4. search is a second way to the map: the map flies to the site and shows its card
  const z0 = await page.evaluate(() => document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap.getZoom());
  await page.locator('.tz-flow input[type=search]').fill(stationedSite.name.slice(0, 6));
  await page.locator('.tz-flow-hits button', { hasText: stationedSite.name }).first().click();
  await page.waitForTimeout(1500);
  const flown = await page.evaluate((s) => {
    const map = document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap;
    const ll = s.boundary ? null : [s.lng, s.lat];
    const c = map.getCanvas();
    const p = ll ? map.project(ll) : map.project(map.getCenter());
    return { zoom: map.getZoom(), dx: Math.abs(p.x - c.clientWidth / 2) / c.clientWidth, dy: Math.abs(p.y - c.clientHeight / 2) / c.clientHeight };
  }, stationedSite);
  const pickCard = (await page.locator('[data-testid=site-pick]').textContent().catch(() => '')) ?? '';
  await page.screenshot({ path: shot('K-search-flies-to-site.png') });
  ok(flown.zoom > z0 + 0.5 && flown.dx < 0.25 && flown.dy < 0.25 && pickCard.includes(stationedSite.name), 'SEARCH-ZOOM', 'a search result flies the map to the site, highlights it and opens the same card',
    `zoom ${z0.toFixed(1)} → ${flown.zoom.toFixed(1)}; offset ${(flown.dx * 100).toFixed(0)}% / ${(flown.dy * 100).toFixed(0)}%`);

  // 5. a click on a site on the map picks it (its context on the right); «اختيار هذا الموقع» chooses it; a click alone starts nothing
  const onMap = await findRefSite(page, stationedSite.siteId);
  if (onMap) await clickInCanvas(page, onMap);
  await page.waitForTimeout(700);
  const clicked = (await page.locator('[data-testid=site-pick]').textContent().catch(() => '')) ?? '';
  const qAfterClick = await page.locator('[data-testid=flow-question]').textContent();
  await page.screenshot({ path: shot('K-site-card.png') });
  await page.getByRole('button', { name: 'اختيار هذا الموقع' }).click();
  await page.waitForTimeout(800);
  const q2 = await page.locator('[data-testid=flow-question]').textContent();
  ok(onMap && clicked.includes(stationedSite.name) && qAfterClick.trim() === 'اختر الموقع الحالي' && q2.trim() === 'حدد الوحدات التي ستنتقل', 'CLICK-SELECT',
    'a click on the map shows the site’s context (nothing starts); «اختيار هذا الموقع» makes it the current site', `«${stationedSite.name}»`);

  // 6. only the units stationed at that site, none chosen; the hierarchy and context follow the choice
  const expected = unitNamesAt(current, stationedSite.siteId);
  const offered = (await page.locator('[data-testid=units-to-move] .rs-check').allTextContents()).map((t) => t.split(' — ')[0].trim());
  const checked = await page.locator('[data-testid=units-to-move] .rs-check input:checked').count();
  await page.screenshot({ path: shot('K-step2-units-at-site.png') });
  ok(JSON.stringify(offered) === JSON.stringify(expected) && checked === 0, 'UNITS-AT-SITE', 'only the units stationed at the chosen site are offered (the register), none chosen by itself', `${offered.join('، ')} (register: ${expected.join('، ')})`);
  await page.locator('[data-testid=units-to-move] .rs-check').first().locator('input').check();
  await page.waitForTimeout(400);
  const hier = (await page.locator('[data-testid=moving-hierarchy]').textContent()) ?? '';
  const ctx2 = (await page.locator('[data-testid=request-context]').textContent()) ?? '';
  ok(hier.includes(expected[0]) && hier.includes('الوحدة الطالبة') && ctx2.includes(stationedSite.name), 'CONTEXT', 'the context shows the site, the units there and each moving unit in its ancestry with the derived requesting unit', hier.replace(/\s+/g, ' ').trim());

  // 7. type, then the new site: no ring and no distance limit while choosing it
  await page.getByRole('button', { name: 'التالي: نوع إعادة التمركز' }).click();
  const q3 = await page.locator('[data-testid=flow-question]').textContent();
  await page.getByRole('button', { name: 'التالي: الموقع الجديد' }).click();
  const q4 = await page.locator('[data-testid=flow-question]').textContent();
  const bands4 = await attr(page, 'data-bands');
  // the site here is a marker: drawing has started by itself; a click adds the first vertex
  await page.waitForSelector('[data-testid=draw-readout]');
  const c0 = await box(page, '.tz-mapframe canvas.maplibregl-canvas');
  await page.mouse.click(c0.x + c0.width * 0.3, c0.y + c0.height * 0.4);
  await page.waitForTimeout(800);
  const bandsDrawn = await attr(page, 'data-bands');
  const body4 = (await page.locator('body').textContent()) ?? '';
  await page.screenshot({ path: shot('K-step4-new-site-no-ring.png') });
  ok(q3.trim() === 'نوع إعادة التمركز' && q4.trim() === 'حدد موقع إعادة التمركز الجديد على الخريطة' && bands4 === '0' && bandsDrawn === '0' && !body4.includes('خارج نطاق مسافة الانتشار'),
    'NO-RING-NEW-SITE', 'type comes before the new site; choosing the new site draws no deployment ring and shows no distance limit', `bands ${bands4} → ${bandsDrawn}`);
  const deployOpen = await page.getByRole('button', { name: 'الخطوة 5: الانتشار' }).isEnabled();
  ok(!deployOpen || bandsDrawn === '0', 'NO-RING-BEFORE-DEPLOY', 'no deployment ring before the deployment step', `deployment step open ${deployOpen}`);
  await page.getByRole('button', { name: 'العودة إلى الطلبات' }).click();
  await page.waitForTimeout(1200);

  // 8. the Sites page: sites and details, no re-stationing flow, no «النطاق المسموح»; its action keeps the site
  await open(page, 'stationing', 4500);
  const listed = await page.locator('[data-testid=site-list] .rs-item').count();
  const mapSites = Number(await attr(page, 'data-sites'));
  await page.locator('[data-testid=site-list] .rs-item', { hasText: stationedSite.name }).first().click();
  await page.waitForTimeout(2500);
  const details = (await page.locator('[data-testid=site-details]').textContent()) ?? '';
  const body = (await page.locator('body').textContent()) ?? '';
  const flow = (await page.locator('.tz-flow, [data-testid=site-readout], .stw-proposal-panel').count());
  await page.screenshot({ path: shot('I-sites-page-details.png') });
  ok(listed === features.length && mapSites === features.length && details.includes(stationedSite.name) && details.includes('التمركز الحالي') && details.includes('الوحدات المرتبطة') && details.includes('الإشغال والحجوزات'),
    'SITES-PAGE', '«المواقع» lists and draws every site the server returns and shows the chosen site’s record', `${listed} listed, ${mapSites} drawn of ${features.length}; «${stationedSite.name}»`);
  ok(flow === 0 && !body.includes('النطاق المسموح') && !body.includes('اقترح موقعاً') && !body.includes('نقل المقر'), 'SITES-NO-FLOW', 'the Sites page has no re-stationing flow and no «النطاق المسموح» rule', `flow elements ${flow}`);
  await page.getByRole('link', { name: 'طلب إعادة تمركز من هذا الموقع' }).click();
  await page.waitForSelector('.tz-flow', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const fromSitesHash = await page.evaluate(() => location.hash);
  const qS = await page.locator('[data-testid=flow-question]').textContent();
  const sum = (await page.locator('.tz-flow-summary').textContent()) ?? '';
  const offeredS = (await page.locator('[data-testid=units-to-move] .rs-check').allTextContents()).map((t) => t.split(' — ')[0].trim());
  await page.screenshot({ path: shot('J-sites-to-restationing-site-kept.png') });
  ok(fromSitesHash === '#restationing/new?site=' + stationedSite.siteId && qS.trim() === 'حدد الوحدات التي ستنتقل' && sum.includes(stationedSite.name) && JSON.stringify(offeredS) === JSON.stringify(expected),
    'SITES-TO-RESTATIONING', '«طلب إعادة تمركز من هذا الموقع» opens «إعادة التمركز» with that site as the current site and only its units offered', `${fromSitesHash}; ${offeredS.join('، ')}`);
  await page.getByRole('button', { name: 'العودة إلى الطلبات' }).click();
  await page.waitForTimeout(1200);
  const countAfter = (await api(page, '/restationing-requests')).body.length;
  ok(writes.length === 0 && countAfter === countBefore, 'NOTHING-SAVED', 'choosing site, units, type and drawing a boundary saved nothing (the draft is created only by an explicit action at the new-site step)', `writes ${writes.length}; requests ${countBefore} → ${countAfter}`);
  await page.context().close();
}

// ---- the geometry itself is the control (owner correction of 5 Nov 2026): copy, drag, edit, draw — all before a save --
{
  const page = await pageAs('t.requester', SIZES.desktop);
  await page.goto(UI + '/');
  const countBefore = (await api(page, '/restationing-requests')).body.length;
  const writes = [];
  page.on('request', (q) => q.method() !== 'GET' && writes.push(q.method() + ' ' + q.url()));
  const mp = await recordOf(page, 'قسم الخدمات العامة');
  const poly = await recordOf(page, 'الخدمات المشتركة');
  const pt = await recordOf(page, 'قسم النقل والحركة الإدارية');
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const step4 = () => page.locator('[data-testid=flow-question]').textContent();
  // the accepted Stationing editor's readouts (dt → dd) in the proposal panel
  const read = async (label) => (await page.locator('.stw-proposal-panel dt', { hasText: label }).locator('xpath=following-sibling::dd[1]').first().innerText()).trim();

  // MultiPolygon: the copy appears at once, every part, the current site still drawn, no ring
  await toNewSiteStep(page, UI, mp.siteId, mp.orgName);
  const copy = await proposedParts(page);
  const currentShown = await rendersRole(page, 'rs-fill', 'CURRENT');
  const bands = await attr(page, 'data-bands');
  const instruction = (await page.locator('[data-testid=drag-instruction]').textContent().catch(() => '')) ?? '';
  const tabA = await page.getByRole('tab', { name: 'أ · نقل الحدود الحالية' }).getAttribute('aria-selected');
  ok((await step4()).trim() === 'حدد موقع إعادة التمركز الجديد على الخريطة' && same(copy, mp.siteGeometry.coordinates) && currentShown && bands === '0' && instruction.includes('اسحب الموقع') && tabA === 'true'
    && (await page.locator('.stw-prop-sym').count()) === 1 && (await page.locator('.stw-orig-sym').count()) === 1 && (await read('المساحة المقترحة')) === (await read('المساحة الحالية')),
    'G-AUTO-COPY', 'step 4 («أ · نقل الحدود الحالية») shows the current MultiPolygon copied whole at once (no save), with its «مقترح» symbol; the current site and its symbol stay; equal areas; no ring', `${copy.length} parts`);

  // dragging one part moves every part by the same vector
  const p0 = await toScreen(page, ringCentre(copy[0][0]));
  await slowDrag(page, p0, { x: p0.x + 300, y: p0.y + 120 }, { steps: 20, pause: 100 });
  const dropped = await proposedParts(page);
  const v = partVectors(copy, dropped);
  ok(v.metres > 300 && v.spread < 0.5 && (await read('الفرق في المساحة')) === '0٪', 'G-GROUP-DRAG', 'a drag of one part moves all parts by the same vector; area difference 0٪', `${Math.round(v.metres)} m; parts differ by ${v.spread.toFixed(3)} m`);

  // a vertex of one part: the other part stays byte-identical; undo, redo, reset
  await page.getByRole('button', { name: 'تعديل الرؤوس' }).click();
  await page.waitForTimeout(500);
  const areaA = await read('المساحة المقترحة');
  const vx = await toScreen(page, dropped[0][0][0]);
  await slowDrag(page, vx, { x: vx.x - 50, y: vx.y - 40 }, { steps: 15, pause: 100 });
  const edited = await proposedParts(page);
  const areaB = await read('المساحة المقترحة');
  ok(!same(edited[0], dropped[0]) && same(edited[1], dropped[1]) && areaA !== areaB, 'G-PART-EDIT', 'a numbered vertex of one part dragged on the map changes that part only (the other is byte-identical) and the area', `${areaA} → ${areaB}`);
  await page.getByRole('button', { name: '↶ تراجع', exact: true }).click();
  await page.waitForTimeout(400);
  const undone = await proposedParts(page);
  await page.getByRole('button', { name: '↷ إعادة', exact: true }).click();
  await page.waitForTimeout(400);
  const redone = await proposedParts(page);
  await page.getByRole('button', { name: 'إعادة الضبط', exact: true }).click();
  await page.waitForTimeout(500);
  const reset = await proposedParts(page);
  ok(same(undone, dropped) && same(redone, edited) && same(reset, copy), 'G-UNDO-REDO-RESET', 'undo restores, redo reapplies, reset returns to the starting copy (geometry equality)');
  await page.getByRole('button', { name: 'تعديل الرؤوس' }).click();

  // occupied ground: another unit's site is drawn in red; a boundary finished over it warns at once
  const occ = poly.siteGeometry.coordinates[0];
  const oc = ringCentre(occ);
  // «ب · رسم حدود جديدة» with the default four vertices: the fourth click closes the shape
  await page.getByRole('tab', { name: 'ب · رسم حدود جديدة' }).click();
  await page.waitForTimeout(700);
  await page.evaluate((c) => document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap.jumpTo({ center: c, zoom: 15 }), oc);
  await page.waitForTimeout(900);
  const occShown = await rendersRole(page, 'occ-fill', 'OCC_SITE');
  const ocs = await toScreen(page, oc);
  for (const [dx, dy] of [[-110, -100], [110, -100], [110, 100], [-110, 100]]) {
    await page.mouse.click(ocs.x + dx, ocs.y + dy);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(700);
  const warn = (await page.locator('[data-testid=occupied-warning]').textContent().catch(() => '')) ?? '';
  await page.screenshot({ path: shot('G-occupied-feedback.png') });
  ok(occShown && warn.includes('يتداخل مع أرض مشغولة') && warn.includes(poly.siteName), 'G-OCCUPIED', 'occupied ground is drawn in red while placing; a boundary over it warns at once (the server still decides on save)', warn.trim());

  // a marker-only current site: drawing at once («عدد الرؤوس» 5), four clicks, finished early with Enter; then a new
  // drawing of three vertices closes by itself on the third click
  await toNewSiteStep(page, UI, pt.siteId, pt.orgName);
  await page.waitForTimeout(600);
  const msg = (await page.locator('[data-testid=draw-readout]').textContent()) ?? '';
  await page.getByLabel('عدد الرؤوس').fill('5');
  const c = await box(page, '.tz-mapframe canvas.maplibregl-canvas');
  const [cx, cy] = [c.x + c.width / 2, c.y + c.height / 2];
  for (const [dx, dy] of [[-40, -35], [45, -40], [50, 40], [-35, 45]]) {
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(250);
  }
  const count4 = await page.locator('[data-testid=draw-readout]').getAttribute('data-count');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const drawn = await proposedParts(page);
  const shape = await page.locator('[data-testid=site-readout]').getAttribute('data-shape');
  ok(msg.includes('الموقع الحالي علامة فقط — ارسم حدود الموقع الجديد على الخريطة') && count4 === '4' && drawn.length === 1 && drawn[0][0].length === 5 && shape === 'DRAWN',
    'G-DRAW-ENTER', 'a marker-only current site starts drawing at once; four clicks (of five chosen), Enter finishes a DRAWN polygon of four vertices (no fixed square)', `vertices ${count4}; ${shape}`);
  await page.getByRole('tab', { name: 'ب · رسم حدود جديدة' }).click();
  await page.getByLabel('عدد الرؤوس').fill('3');
  await page.waitForTimeout(700);
  for (const [dx, dy] of [[-60, 20], [0, -55], [65, 25]]) {
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
  const tri = await proposedParts(page);
  ok(tri.length === 1 && tri[0][0].length === 4 && (await page.locator('[data-testid=site-readout]').getAttribute('data-shape')) === 'DRAWN' && (await page.locator('.stw-vtx').count()) === 3,
    'G-DRAW-COUNT', '«ب · رسم حدود جديدة» with «عدد الرؤوس» 3: the third map click closes the shape, its three numbered vertices stay on');
  ok((await attr(page, 'data-bands')) === '0', 'G-NO-RING', 'no deployment ring and no distance limit while the new site is placed');

  await page.getByRole('button', { name: 'العودة إلى الطلبات' }).click();
  await page.waitForTimeout(1200);
  const countAfter = (await api(page, '/restationing-requests')).body.length;
  ok(writes.length === 0 && countAfter === countBefore, 'G-NO-DRAFT', 'copy/draw/drag does not create a draft: copy, drag, vertex edit, undo, redo, reset and drawing wrote nothing',
    `writes ${writes.length}${writes.length ? ' (' + writes.slice(0, 3).join(', ') + ')' : ''}; requests ${countBefore} → ${countAfter}`);
  await page.context().close();
}

// ---- C, D, E: a new request in the same workspace (one fictional draft) and geometry editing -----------------------------
let draftId = null;
{
  const page = await pageAs('t.requester', SIZES.desktop);
  if (process.env.REUSE_DRAFT) {
    // a draft an earlier run of this script wrote (REUSE_DRAFT=RS-…): reopened in the editor, nothing new is created
    draftId = await idOf(page, process.env.REUSE_DRAFT);
    await open(page, 'restationing/' + draftId);
    await page.getByRole('button', { name: 'تعديل الطلب' }).click();
    await page.waitForSelector('.tz-flow');
    await page.waitForTimeout(1500);
    // the reopened draft already holds its site: it is on the map, ready to drag
    await page.getByRole('button', { name: 'الخطوة 4: الموقع الجديد' }).click();
  } else {
    // map first: the unit's site located, confirmed, the unit chosen, permanent; the copy creates the draft
    const unit = (await (async () => { await page.goto(UI + '/'); return api(page, '/stationing/current'); })()).body.find((c) => c.orgName === 'قسم الخدمات العامة');
    await open(page, 'restationing/new?unit=' + unit.orgId);
    await page.getByRole('button', { name: 'اختيار هذا الموقع' }).click();
    await page.locator('[data-testid=units-to-move] .rs-check', { hasText: unit.orgName }).first().locator('input').check();
    await page.getByRole('button', { name: 'التالي: نوع إعادة التمركز' }).click();
    await page.getByRole('button', { name: 'التالي: الموقع الجديد' }).click();
    // the copy is on the map at once; the draft is created by the explicit save
    await page.waitForSelector('[data-testid=site-readout]');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/restationing-requests') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'حفظ المسودة والفحص' }).click();
    draftId = (await (await created).json()).id;
  }
  await page.waitForSelector('[data-testid=site-readout]');
  await page.waitForTimeout(1200);
  // the copy is stored with the next save
  await page.getByRole('button', { name: 'حفظ المسودة والفحص' }).click();
  await page.waitForResponse((r) => /\/restationing-requests\/[^/]+\/checks$/.test(r.url()));
  await page.waitForTimeout(1200);
  const copied = (await api(page, '/restationing-requests/' + draftId)).body.content.site?.geometry;
  // drag the whole site 220 px east (about 1 km at the editor's zoom 15): no distance rule applies to this move
  const canvas = await box(page, '.tz-mapframe canvas.maplibregl-canvas');
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(cx + i * 11, cy, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const valid = await page.locator('[data-testid=site-validity]').textContent();
  await page.getByRole('button', { name: 'حفظ المسودة والفحص' }).click();
  await page.waitForResponse((r) => /\/restationing-requests\/[^/]+\/checks$/.test(r.url()));
  await page.waitForTimeout(1500);
  const moved = (await api(page, '/restationing-requests/' + draftId)).body.content.site?.geometry;
  const mean = (g) => { const pts = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flatMap((p) => p[0].slice(0, -1)); return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]; };
  const [a, b] = [mean(copied), mean(moved)];
  const metres = Math.hypot((b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * 110900);
  const moveInfo = await page.locator('.stw-proposal-panel .stw-live').allTextContents();
  await page.screenshot({ path: shot('C-new-request-site-desktop.png') });
  ok(copied && moved && moved.type === copied.type && metres > 400 && valid.includes('صالح') && moveInfo.some((t) => t.includes('المسافة من الموقع الحالي') && t.includes('للعلم فقط')), 'GEOMETRY',
    'geometry editing still works in the new workspace: copy whole, drag, saved by the server; the move distance is information only', `${copied?.type}, moved ${Math.round(metres)} m; ${moveInfo.join(' | ')}`);

  // the deployment step opens only now that the new site exists
  await page.getByRole('button', { name: 'التالي: منطقة الانتشار' }).click();
  await page.waitForResponse((r) => /\/restationing-requests\/[^/]+\/checks$/.test(r.url()));
  await page.waitForTimeout(800);
  // place both deployment areas with «تحديد المنطقة على الخريطة» (owner decision of 5 Nov 2026): the map frames the
  // leg's distance around its start, one click puts the initial area there; aimed geographically from the server's own
  // centres, then saved and compared with the server's measured distance
  const km = (m) => (m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 1 });
  const meanOf = (g) => {
    const pts = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flatMap((part) => part[0].slice(0, -1));
    return { lng: pts.reduce((a, q) => a + q[0], 0) / pts.length, lat: pts.reduce((a, q) => a + q[1], 0) / pts.length };
  };
  const towards = (c, deg, m) => ({ lat: c.lat + (m * Math.cos((deg * Math.PI) / 180)) / 110900, lng: c.lng + (m * Math.sin((deg * Math.PI) / 180)) / (111320 * Math.cos((c.lat * Math.PI) / 180)) });
  const saveAndLegs = async () => {
    await page.getByRole('button', { name: 'حفظ المسودة والفحص' }).click();
    await page.waitForResponse((r) => /\/restationing-requests\/[^/]+\/checks$/.test(r.url()));
    await page.waitForTimeout(1500);
    return (await api(page, `/restationing-requests/${draftId}/checks`)).body.legs ?? [];
  };
  const place = async (k, deg, wantM) => {
    const content = (await api(page, '/restationing-requests/' + draftId)).body.content;
    const from = meanOf(k === 'primary' ? content.site.geometry : content.primary);
    await page.getByRole('tab', { name: k === 'primary' ? 'منطقة الانتشار الرئيسية' : 'منطقة الانتشار البديلة', exact: true }).click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).click();
    await page.waitForTimeout(900);
    if (k === 'primary') await page.screenshot({ path: shot('D-primary-placing-desktop.png') });
    const t = towards(from, deg, wantM);
    const px = await toScreen(page, [t.lng, t.lat]);
    await page.mouse.click(px.x, px.y);
    await page.waitForTimeout(800);
    const leg = (await saveAndLegs()).find((l) => l.leg === k);
    return { leg };
  };
  const { leg: p } = await place('primary', 0, 6200);
  await page.screenshot({ path: shot('D-primary-placed-band-desktop.png') });
  const primaryCard = await page.locator('[data-leg=primary]').first().textContent();
  ok(p && p.distanceM != null && primaryCard.includes(km(p.distanceM)) && primaryCard.includes(`${km(p.baseMinM)}–${km(p.baseMaxM)}`), 'DEPLOY-PRIMARY',
    'primary deployment: the card shows the server’s leg-1 distance and the policy range', `${p?.status}; ${primaryCard.replace(/\s+/g, ' ').slice(0, 160)}`);
  const { leg: al } = await place('alternative', 90, 4000);
  await page.screenshot({ path: shot('E-alternative-placed-desktop.png') });
  const legs2 = (await api(page, `/restationing-requests/${draftId}/checks`)).body.legs ?? [];
  const altCard = await page.locator('[data-leg=alternative]').first().textContent();
  ok(al && al.distanceM != null && altCard.includes(km(al.distanceM)) && altCard.includes(`${km(al.baseMinM)}–${km(al.baseMaxM)}`), 'DEPLOY-ALTERNATIVE',
    'alternative deployment: the card shows the server’s leg-2 distance (from the primary area) and its policy range', `${al?.status}; ${altCard.replace(/\s+/g, ' ').slice(0, 160)}`);
  const text = await page.locator('body').textContent();
  const legend = await page.locator('.rs-legend').textContent();
  ok(!text.includes('استثناء مسافة إعادة التمركز') && legend.includes('مسافة الانتشار من مركز إلى مركز') && legend.includes('لا قيد') && !legs2.some((l) => !['primary', 'alternative'].includes(l.leg)) && (await attr(page, 'data-bands')) === '0', 'NO-RESTATIONING-RULE',
    'no distance rule on the re-stationing move and no ring anywhere: checks and leg connectors exist only for the two deployment legs', legend.replace(/\s+/g, ' ').trim());
  await page.context().close();
}
// C/D/E at the other sizes: the same draft reopened in the editor (nothing more is written)
for (const name of ['laptop', 'tablet', 'mobile']) {
  const page = await pageAs('t.requester', SIZES[name]);
  await open(page, 'restationing/' + draftId);
  if (name === 'mobile') {
    await page.locator('.tz-sheet-tabs button').nth(2).click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: 'تعديل الطلب' }).click();
  await page.waitForSelector('.tz-flow', { state: 'attached', timeout: 20000 });
  // the step panel is the left column (a bottom sheet on a phone)
  if (name === 'mobile') await page.locator('.tz-sheet-tabs button').nth(0).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'الخطوة 4: الموقع الجديد' }).click();
  await page.waitForSelector('[data-testid=site-readout]', { timeout: 20000 });
  await page.waitForTimeout(2000);
  if (name === 'mobile') {
    await page.screenshot({ path: shot(`C-editor-form-sheet-mobile.png`) });
    await page.locator('.tz-sheet-tabs button').nth(1).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot(`C-editor-${name}.png`) });
  } else {
    await page.screenshot({ path: shot(`C-editor-${name}.png`) });
    await page.getByRole('button', { name: 'الخطوة 5: الانتشار' }).click();
    await page.getByRole('tab', { name: 'منطقة الانتشار الرئيسية' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot(`D-primary-placing-${name}.png`) });
    await page.getByRole('tab', { name: 'منطقة الانتشار البديلة' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot(`E-alternative-placing-${name}.png`) });
  }
  await page.context().close();
}

// ---- F: an under-review request for its approver, the strip against the server route; G: terrain ---------------------
for (const [name, size] of Object.entries(SIZES)) {
  const page = await pageAs('t.manager', size);
  await open(page, 'restationing/' + rid);
  const route = (await api(page, '/restationing-requests/' + rid)).body;
  const expected = ['مقدم الطلب', ...route.route.map((s) => s.label), 'التفعيل'];
  const shown = (await page.locator('.tz-steps > li > b').allTextContents()).map((t) => t.trim());
  const current = await page.locator('.tz-steps > li.current > b').allTextContents();
  if (name !== 'mobile') await page.getByRole('button', { name: 'السجل الكامل', exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot(`F-under-review-${name}.png`) });
  if (name === 'desktop') {
    const cur = route.route.find((s) => s.current)?.label;
    ok(JSON.stringify(shown) === JSON.stringify(expected) && (!cur || current.map((t) => t.trim()).includes(cur)), 'ROUTE', 'approval strip = the request\'s actual route, the current stage marked', shown.join(' ← '));
    const before = await page.locator('.ml-offline').first().getAttribute('data-mode');
    const hill = page.waitForRequest((q) => q.url().includes('hillshade.pmtiles'), { timeout: 15000 }).then(() => true).catch(() => false);
    await page.getByRole('button', { name: 'طبيعة الأرض' }).click();
    const fetched = await hill;
    await page.waitForTimeout(2500);
    const after = await page.locator('.ml-offline').first().getAttribute('data-mode');
    await page.screenshot({ path: shot(`G-terrain-${name}.png`) });
    await page.getByRole('button', { name: 'الشوارع' }).click();
    await page.waitForTimeout(800);
    const back = await page.locator('.ml-offline').first().getAttribute('data-mode');
    ok(before === 'street' && after === 'terrain' && back === 'street' && fetched, 'TERRAIN', 'street → terrain (GLO-30 hillshade from the local package) → street on the same map', `${before} → ${after} → ${back}; hillshade fetched ${fetched}`);
    // hierarchy panel = the server's tree
    await page.getByRole('tab', { name: 'الوحدات التابعة' }).click();
    await page.waitForTimeout(500);
    const rows = await page.locator('[data-testid=org-tree] [role=treeitem]').evaluateAll((els) => els.map((e) => ({ id: e.dataset.unit, name: e.querySelector('.tz-node-name span').textContent, cls: e.className })));
    const tree = (await api(page, '/organizations/tree')).body;
    const order = [];
    const walk = (ns) => ns.forEach((n) => (order.push(n.id), walk(n.children ?? [])));
    walk(tree);
    const idx = rows.map((r) => order.indexOf(r.id));
    const inOrder = idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
    const req = rows.find((r) => r.id === route.requestingUnit.id);
    await page.screenshot({ path: shot(`F-hierarchy-panel-${name}.png`) });
    ok(rows.length > 0 && inOrder && req?.cls.includes('requesting') && rows[0].id === tree[0].id, 'HIERARCHY', 'the hierarchy panel shows the server\'s tree in its order, the requesting unit highlighted', rows.map((r) => r.name).join(' / '));
  }
  if (name === 'laptop' || name === 'tablet' || name === 'mobile') {
    if (name === 'mobile') await page.locator('.tz-sheet-tabs button').nth(1).click();
    await page.getByRole('button', { name: 'طبيعة الأرض' }).click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot(`G-terrain-${name}.png`) });
  }
  await page.context().close();
}

// ---- permissions: what each persona is offered ----------------------------------------------------------------------
{
  const offered = async (user) => {
    const page = await pageAs(user, SIZES.desktop);
    await open(page, 'restationing/' + rid);
    const nav = await page.locator('#navigation a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    const moreBtn = page.locator('.tz-more > button');
    let more = [];
    if (await moreBtn.count()) {
      await moreBtn.click();
      more = await page.locator('.tz-menu a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    }
    const quick = await page.locator('.tz-quick a').allTextContents();
    const rail = await page.locator('.tz-action b').allTextContents();
    await page.goto(UI + '/#permissions');
    await page.waitForTimeout(1500);
    const denied = await page.locator('.permission-denied').count();
    await page.context().close();
    return { nav, more, quick: quick.map((t) => t.trim()), rail, deniedPermissions: denied > 0 };
  };
  const rq = await offered('t.requester');
  ok(!rq.nav.concat(rq.more).some((h) => ['#permissions', '#audit', '#stationingPolicy', '#settings'].includes(h)) && !rq.quick.includes('الصلاحيات') && !rq.quick.includes('سجل التدقيق') && !rq.rail.includes('الصلاحيات والتدقيق') && rq.deniedPermissions,
    'PERM-REQUESTER', 'a requester is offered no permissions, audit or policy page, and #permissions answers «outside your rights»', JSON.stringify({ nav: rq.nav, more: rq.more, quick: rq.quick }));
  const au = await offered('t.auditor');
  ok(au.nav.includes('#audit') && au.quick.includes('سجل التدقيق') && !au.quick.includes('الصلاحيات') && au.rail.includes('الصلاحيات والتدقيق'), 'PERM-AUDITOR', 'an auditor gets the audit report and «سجل التدقيق», not «الصلاحيات»', JSON.stringify({ nav: au.nav, quick: au.quick }));
  const mg = await offered('t.manager');
  ok(mg.quick.includes('الصلاحيات') && !mg.quick.includes('سجل التدقيق'), 'PERM-MANAGER', 'a unit manager with MANAGE_ACCESS gets «الصلاحيات», not the audit log', JSON.stringify({ quick: mg.quick }));
}

ok(external.length === 0, 'NET', 'no request leaves the application (offline map, local font)', external.slice(0, 5).join(' '));
ok(consoleErrors.length === 0, 'CONSOLE', 'no console error on any page and size', consoleErrors.slice(0, 5).join(' | '));
writeFileSync(new URL('results.json', OUT), JSON.stringify({ ui: UI, at: new Date().toISOString(), draft: draftId, results, external, consoleErrors }, null, 2));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} PASS · draft ${draftId}`);
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
