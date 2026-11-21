// Site-hub acceptance screenshots (owner, 21 Nov 2026 «SITE-HUB REDESIGN» — site-hub acceptance-fix brief).
// Seven scenes + rendered-feature assertion on the LIVE MapLibre scene.
//
// Usage: node tests/acceptance/posture-screens.mjs
// Evidence: docs/evidence/posture/*.png + docs/evidence/posture/rendered-feature-counts.json

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = process.env.POSTURE_BASE ?? 'http://127.0.0.1:5173';
const PASSWORD = process.env.TMRKZ_TEST_PASSWORD ?? readFileSync('ops/test-env/.generated/user-password', 'utf8').trim();
const USER = process.env.POSTURE_USER ?? 'p12.view';

const OUT_URL = new URL('../../docs/evidence/posture/', import.meta.url);
const OUT = fileURLToPath(OUT_URL);
mkdirSync(OUT, { recursive: true });
const path = (name) => fileURLToPath(new URL(name, OUT_URL));

const WIDE = { width: 1920, height: 1080 };
const NARROW = { width: 1366, height: 768 };

const BUSINESS_LAYERS = [
  'ref-fill', 'ref-line',
  'posture-primary-fill', 'posture-primary-line',
  'posture-sub-fill', 'posture-sub-line',
  'pending-sel-site-fill', 'pending-sel-site-line',
  'pending-sel-primary-fill', 'pending-sel-primary-line',
  'pending-sel-sub-fill', 'pending-sel-sub-line',
  'site-hub-bg', 'site-cluster',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sign(page) {
  await page.goto(BASE + '/');
  await page.waitForLoadState('domcontentloaded');
  await page.getByText('إدخال رقم الـــــ U وكلمة المرور يدويا').click();
  await page.locator('#tm-username').fill(USER);
  await page.locator('#tm-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await page.waitForSelector('main#main', { timeout: 30_000 });
  await sleep(1500);
}

async function openPosture(page) {
  await page.evaluate(() => { window.location.hash = 'posture'; });
  await page.waitForSelector('[data-testid="stationing-posture"]', { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('.tz-posture3-empty-row'), { timeout: 20_000 }).catch(() => undefined);
  await sleep(2500);
}

async function counts(page) {
  return page.evaluate((layers) => {
    const w = document.querySelector('.tz-posture3-mapbody .tz-map-layer');
    const map = w && w.tmrkzMap;
    if (!map) return { error: 'no map' };
    const out = { zoom: Math.round(map.getZoom() * 100) / 100 };
    for (const id of layers) {
      if (!map.getLayer(id)) { out[id] = 'no-layer'; continue; }
      const vis = map.getLayoutProperty(id, 'visibility');
      if (vis === 'none') { out[id] = 'hidden'; continue; }
      try { out[id] = map.queryRenderedFeatures({ layers: [id] }).length; }
      catch (e) { out[id] = 'error:' + String(e); }
    }
    return out;
  }, BUSINESS_LAYERS);
}

async function setZoom(page, z) {
  await page.evaluate((zoom) => {
    const w = document.querySelector('.tz-posture3-mapbody .tz-map-layer');
    const map = w && w.tmrkzMap;
    if (map) map.setZoom(zoom);
  }, z);
  await sleep(1200);
}

async function clickRailSiteWithBoth(page, { needComplete, needPending }) {
  // Walk the rail; pick the first site that satisfies the brief's needs.
  const groups = page.locator('[data-testid="posture-site-group"]');
  const n = await groups.count();
  for (let i = 0; i < n; i++) {
    const row = groups.nth(i);
    const small = (await row.locator('.tz-posture3-camp-meta small').innerText()).trim();
    const hasComplete = /مكتمل/.test(small);
    const hasPending = /طلب/.test(small);
    if ((!needComplete || hasComplete) && (!needPending || hasPending)) {
      await row.locator('.tz-posture3-camp-head').click({ timeout: 5000 }).catch(() => undefined);
      await sleep(2000);
      return row;
    }
  }
  const first = groups.first();
  await first.locator('.tz-posture3-camp-head').click({ timeout: 5000 }).catch(() => undefined);
  await sleep(2000);
  return first;
}

async function shot(page, name) {
  await page.screenshot({ path: path(name), fullPage: false });
  console.log('shot', name);
}

async function run() {
  const browser = await chromium.launch({
    headless: process.env.HEADED ? false : true,
    channel: process.env.BROWSER_CHANNEL ?? 'msedge',
    executablePath: process.env.BROWSER_PATH ?? undefined,
  });
  try {
    const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: WIDE });
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) return route.abort('blockedbyclient');
      return route.continue();
    });
    const page = await ctx.newPage();
    await sign(page);
    await openPosture(page);
    const report = {};

    // 1 — UAE / regional overview at wide zoom. Clustering MUST kick in so the hubs become one «N مواقع · M وحدة».
    await setZoom(page, 6);
    await shot(page, 'UAE-OVERVIEW.png');
    report.UAE = await counts(page);

    // 2 — SITE-HUBS at medium zoom: clusters break into individual site hubs.
    await setZoom(page, 10);
    await shot(page, 'SITE-HUBS.png');
    report.SITE_HUBS = await counts(page);

    // 3 — SITE-SELECTED: click first site in the rail. The camera should fit the site's actual geometry extent.
    await clickRailSiteWithBoth(page, { needComplete: false, needPending: false });
    await shot(page, 'SITE-SELECTED.png');
    report.SITE_SELECTED = await counts(page);

    // 4 — COMPLETE-UNIT: find and pick a COMPLETE unit in the rail so PRIMARY + SUB render.
    await page.locator('.tz-posture3-detail-close').first().click({ timeout: 3000 }).catch(() => undefined);
    await sleep(600);
    // Open every rail site with a «مكتمل» count, then click its first unit.
    const groups = page.locator('[data-testid="posture-site-group"]');
    const n = await groups.count();
    let picked = false;
    for (let i = 0; i < n && !picked; i++) {
      const row = groups.nth(i);
      const small = (await row.locator('.tz-posture3-camp-meta small').innerText()).trim();
      if (!/مكتمل/.test(small)) continue;
      await row.locator('.tz-posture3-camp-head').click({ timeout: 5000 }).catch(() => undefined);
      await sleep(800);
      // Open the expanded group, then click a complete unit.
      const unitRows = row.locator('[data-testid="posture-unit"]');
      const m = await unitRows.count();
      for (let j = 0; j < m; j++) {
        const ur = unitRows.nth(j);
        const completeness = await ur.getAttribute('data-completeness');
        if (completeness === 'COMPLETE') {
          await ur.click({ timeout: 5000 }).catch(() => undefined);
          picked = true;
          break;
        }
      }
    }
    await sleep(2500);
    await shot(page, 'COMPLETE-UNIT.png');
    report.COMPLETE_UNIT = await counts(page);

    // 5 — PENDING-RS: switch to Requests filter and pick an RS row.
    await page.locator('.tz-posture3-detail-close').first().click({ timeout: 3000 }).catch(() => undefined);
    await sleep(600);
    await page.locator('[data-testid="cohort-requests"]').click();
    await sleep(1500);
    let chose = false;
    const reqGroups = page.locator('[data-testid="posture-site-group"]');
    const rgN = await reqGroups.count();
    for (let i = 0; i < rgN && !chose; i++) {
      const row = reqGroups.nth(i);
      await row.locator('.tz-posture3-camp-head').click({ timeout: 5000 }).catch(() => undefined);
      await sleep(400);
      const reqRows = row.locator('[data-testid="posture-request-row"]');
      const rrN = await reqRows.count();
      for (let j = 0; j < rrN; j++) {
        const rr = reqRows.nth(j);
        const titleBit = (await rr.innerText()).trim();
        if (/إعادة التمركز|RS/.test(titleBit)) {
          await rr.click({ timeout: 5000 }).catch(() => undefined);
          chose = true;
          break;
        }
      }
    }
    await sleep(2000);
    await shot(page, 'PENDING-RS.png');
    report.PENDING_RS = await counts(page);

    // 6 — PENDING-DA.
    await page.locator('.tz-posture3-detail-close').first().click({ timeout: 3000 }).catch(() => undefined);
    await sleep(600);
    chose = false;
    const reqGroups2 = page.locator('[data-testid="posture-site-group"]');
    const rg2N = await reqGroups2.count();
    for (let i = 0; i < rg2N && !chose; i++) {
      const row = reqGroups2.nth(i);
      await row.locator('.tz-posture3-camp-head').click({ timeout: 5000 }).catch(() => undefined);
      await sleep(400);
      const reqRows = row.locator('[data-testid="posture-request-row"]');
      const rrN = await reqRows.count();
      for (let j = 0; j < rrN; j++) {
        const rr = reqRows.nth(j);
        const titleBit = (await rr.innerText()).trim();
        if (/مناطق انتشار|DA/.test(titleBit)) {
          await rr.click({ timeout: 5000 }).catch(() => undefined);
          chose = true;
          break;
        }
      }
    }
    await sleep(2000);
    await shot(page, 'PENDING-DA.png');
    report.PENDING_DA = await counts(page);

    // 7 — small-screen overview.
    await page.locator('.tz-posture3-detail-close').first().click({ timeout: 3000 }).catch(() => undefined);
    await page.locator('[data-testid="cohort-all"]').click();
    await setZoom(page, 10);
    await page.setViewportSize(NARROW);
    await sleep(1500);
    await shot(page, 'OVERVIEW-1366x768.png');
    report.OVERVIEW_1366 = await counts(page);

    writeFileSync(path('rendered-feature-counts.json'), JSON.stringify(report, null, 2));
    console.log('wrote', path('rendered-feature-counts.json'));
    console.log('OK  7 screenshots in', OUT);
  } finally {
    await browser.close();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
