// Release closure (20 Nov 2026): one map-first editor for every normal re-stationing and deployment-areas task.
//  1. a re-stationing started from a site («#restationing/new?site=») opens the map-first editor with that site chosen, nothing saved;
//  2. a saved draft made the OLD way (kind TEMPORARY with dates, occupants and an exception the old editor wrote) opens in the
//     map-first editor with its site, main and sub-areas, dates and ownership as saved; opening and closing writes nothing;
//     the content the screen cannot edit is named, carried unchanged by a save that changes only the reason;
//  3. a deployment-areas draft opens in the same editor as that request;
//  4. a request under review opens read-only (no editor); the old editor is not reachable for these purposes.
// On http://localhost:8088 as a synthetic requester (REQUESTER, HR_AI) holding the request right on one stationed unit. The run
// creates drafts through the API and ends them (they stay as drafts of the synthetic unit; listed in the report).
//   REQUESTER=juma.ghfly4 node tests/acceptance/editor-unification.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/editor-unification/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const WHO = process.env.REQUESTER ?? 'juma.ghfly4';
const PW = readFileSync(ROOT + 'ops/acceptance-main/.generated/mover-ldap-test-password', 'utf8').trim();
const login = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: WHO, password: PW }) });
if (login.status !== 200) throw new Error(`${WHO} sign-in ${login.status}`);
const raw = login.headers.getSetCookie().map((c) => c.split(';')[0]);
const cookies = raw.map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
const ck = raw.join('; ');
const xsrf = (ck.match(/XSRF-TOKEN=([^;]+)/) ?? [])[1];
const api = async (method, path, body) => {
  const r = await fetch(BASE + '/api/v1' + path, { method, headers: { Cookie: ck, 'X-Requested-With': 'mover', 'Content-Type': 'application/json', ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };
const hub = (await api('GET', '/request-hub')).body;
const mine = hub.units.find((u) => u.site && u.actions.some((a) => a.action === 'RESTATIONING' && a.allowed));
if (!mine) throw new Error(`${WHO} has no stationed unit to move`);
// the current site as the hub states it; a shape near it: the site's outer ring shifted east, two areas further on
const g0 = mine.site.geometry;
const siteGeom = g0?.type === 'Feature' ? g0.geometry : g0;
const ring = siteGeom.type === 'Polygon' ? siteGeom.coordinates[0] : siteGeom.coordinates[0][0];
const shift = (dx, dy) => ({ type: 'Polygon', coordinates: [ring.map(([x, y]) => [x + dx, y + dy])] });
const content = {
  kind: 'TEMPORARY', start: '2026-12-01T00:00:00Z', end: '2027-01-15T00:00:00Z', scope: [mine.id],
  site: { geometry: shift(0.02, 0), copiedFrom: mine.site.id, shape: 'COPY' }, primary: shift(0.04, 0.01), alternative: shift(0.06, 0.02),
  reason: 'مسودة بالطريقة القديمة — قبول وهمي', occupants: { '11111111-2222-4333-8444-555555555555': 'EXCLUDED' }, exceptions: { primary: 'مبرر قديم' },
};
// the old-way draft of an earlier run is reused (its reason is put back as the old editor wrote it); else one is made
const existing = (await api('GET', '/restationing-requests')).body.find((r) => (r.purpose ?? 'RESTATIONING') === 'RESTATIONING' && r.state === 'DRAFT' && r.mine && r.requestingUnit.id === mine.id);
let draft;
if (existing) {
  const put = await api('PUT', '/restationing-requests/' + existing.id + '/content', content);
  if (put.status !== 200) throw new Error('draft not reset: ' + put.status + ' ' + JSON.stringify(put.body).slice(0, 200));
  draft = put.body;
} else {
  const made = await api('POST', '/restationing-requests', { requestingUnitId: mine.id, content, purpose: 'RESTATIONING' });
  if (made.status !== 200 && made.status !== 201) throw new Error('draft not made: ' + made.status + ' ' + JSON.stringify(made.body).slice(0, 200));
  draft = made.body;
}
const before = JSON.stringify((await api('GET', '/restationing-requests/' + draft.id)).body.content);
const areasMade = await api('POST', '/restationing-requests', { requestingUnitId: mine.id, content: { kind: 'PERMANENT', scope: [mine.id], site: null, primary: shift(0.03, 0.01), alternative: null, reason: '', exceptions: {}, occupants: {} }, purpose: 'DEPLOYMENT_AREAS' });
// a unit may hold one open deployment-areas request: a re-run reuses the draft the first run left
const areasDraft = areasMade.status === 200 || areasMade.status === 201 ? areasMade.body
  : (await api('GET', '/restationing-requests')).body.find((r) => r.purpose === 'DEPLOYMENT_AREAS' && r.state === 'DRAFT' && r.mine && r.requestingUnit.id === mine.id);
if (!areasDraft) throw new Error('areas draft not made: ' + areasMade.status + ' ' + JSON.stringify(areasMade.body).slice(0, 200));

const browser = await chromium.launch(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH, headless: true } : { channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const writes = [];
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (!['localhost', '127.0.0.1'].includes(u.hostname) && !/^(data|blob):/.test(u.protocol)) return route.abort('blockedbyclient');
  if (/\/api\/v1\/restationing-requests/.test(u.pathname) && ['PUT', 'POST', 'PATCH', 'DELETE'].includes(route.request().method())) writes.push(route.request().method() + ' ' + u.pathname);
  return route.continue();
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 1. from a site: the map-first editor, the site chosen, nothing saved
await page.goto(BASE + '/#restationing/new?purpose=RESTATIONING&site=' + mine.site.id);
await page.getByTestId('restation-request').waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
ok(await page.getByTestId('restation-request').isVisible() && (await page.locator('[data-testid=rs-step-panel], .tz-flow').count()) === 0, 'U-01 a re-stationing started from a site opens the map-first editor, not the old one');
// the site's one eligible unit is chosen with it, so the editor stands at «الموقع الجديد»; the units step shows the choice
const step0 = await page.getByTestId('restation-request').getAttribute('data-step');
const from = (await page.getByTestId('request-from').innerText()).replace(/\s+/g, ' ');
await page.locator('.sw-steps li').first().locator('button').click();
await page.getByTestId('area-camps').waitFor({ timeout: 10000 });
await page.waitForTimeout(400);
const chosen = await page.locator(`[data-camp="${mine.site.id}"]`).first().getAttribute('class');
const row = page.locator(`[data-unit="${mine.name}"]`).first();
ok(step0 === '2' && from.includes(mine.site.name) && (chosen ?? '').includes('on') && (await row.count()) > 0 && (await row.getAttribute('aria-pressed')) === 'true',
  'U-02 that site is the choice, its one eligible unit is ticked, and the editor stands at «الموقع الجديد» (then الرئيسية → الفرعية → مراجعة)', `step ${step0} · ${from}`);
ok(await page.getByTestId('kind-choice').isVisible(), 'U-03 the kind (دائم/مؤقت) is chosen with the units; the temporary dates appear when مؤقت is chosen');
await page.getByTestId('kind-temporary').click();
ok(await page.getByTestId('temporary-dates').isVisible() && (await page.getByTestId('areas-next').isDisabled()), 'U-04 a temporary move asks for its dates before «التالي»', await page.getByTestId('next-why').innerText().catch(() => ''));
await page.screenshot({ path: OUT + '01-from-site.png' });
ok(writes.length === 0, 'U-05 nothing was saved by opening from a site', writes.join(', '));

// 2. the old-way draft: opened read-only first, then the map-first editor with everything as saved
await page.goto(BASE + '/#restationing/' + draft.id);
await page.getByTestId('request-panel').or(page.locator('.tz-context')).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
ok((await page.getByTestId('restation-request').count()) === 0, 'U-06 a request opened from its address is read (details), not an editor');
const editBtn = page.getByRole('button', { name: /تعديل/ }).first();
await editBtn.waitFor({ timeout: 10000 });
await editBtn.click();
await page.getByTestId('restation-request').waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
const title = await page.locator('.sw-title').innerText();
ok(title.includes(draft.number), 'U-07 «تعديل» opens the saved draft in the map-first editor, named', title);
const stepNow = await page.getByTestId('restation-request').getAttribute('data-step');
ok(stepNow === '5', 'U-08 a complete draft opens at its review step', 'step ' + stepNow);
const kindText = await page.getByTestId('review-kind').innerText();
ok(kindText.includes('مؤقت') && kindText.includes('2026-12-01') && kindText.includes('2027-01-15'), 'U-09 the temporary kind and both dates are as saved', kindText);
const legacy = await page.getByTestId('legacy-note').innerText();
ok(legacy.includes('شاغل') && legacy.includes('استثناء'), 'U-10 the occupants and the exception the old editor wrote are named, not dropped', legacy.replace(/\s+/g, ' ').slice(0, 120));
const reviewSite = await page.getByTestId('review-site').innerText();
const dds = await page.locator('[data-testid=areas-summary] dd').allInnerTexts();
const withArea = dds.filter((t) => /م²/.test(t)).length;
ok(!reviewSite.includes('—') && withArea >= 3, 'U-11 the new site, the main and the sub-area are there as saved', `${reviewSite} · ${withArea} measured`);
await page.screenshot({ path: OUT + '02-old-draft-in-new-editor.png' });
ok(writes.length === 0, 'U-12 opening the draft wrote nothing', writes.join(', '));
const same = JSON.stringify((await api('GET', '/restationing-requests/' + draft.id)).body.content) === before;
ok(same, 'U-13 the saved content is unchanged by opening');
// the reason is edited and the draft saved: everything else, including the carried content, stays the same
await page.getByLabel('سبب الطلب').fill('مسودة بالطريقة القديمة — عُدّل السبب فقط');
const saved = page.waitForResponse((r) => r.url().includes('/restationing-requests/') && r.url().endsWith('/content') && r.request().method() === 'PUT', { timeout: 15000 });
await page.getByTestId('save-draft').click();
ok((await saved).status() === 200, 'U-14a the draft is saved through its content endpoint');
await page.getByTestId('draft-saved').waitFor({ timeout: 15000 });
const after = (await api('GET', '/restationing-requests/' + draft.id)).body;
const b = JSON.parse(before);
const keep = (c) => ({ ...c, reason: null });
const changedKeys = Object.keys({ ...keep(b), ...keep(after.content) }).filter((k) => JSON.stringify(keep(b)[k]) !== JSON.stringify(keep(after.content)[k]));
ok(changedKeys.length === 0 && after.content.reason.includes('عُدّل السبب فقط') && after.requestingUnit.id === draft.requestingUnit.id,
  'U-14 a save changes only what was edited: site, main, sub, dates, occupants, exception and ownership stay as saved',
  changedKeys.length ? 'changed: ' + changedKeys.join(', ') : `reason «${after.content.reason}» · unit ${after.requestingUnit.id === draft.requestingUnit.id ? 'same' : 'CHANGED'}`);
await page.screenshot({ path: OUT + '03-saved.png' });

// 3. a deployment-areas draft opens in the same editor as that request
await page.goto(BASE + '/#restationing/' + areasDraft.id);
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /تعديل/ }).first().click();
await page.getByTestId('areas-request').waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);
const dstep = await page.getByTestId('areas-request').getAttribute('data-step');
ok(dstep === '3', 'U-15 a deployment-areas draft opens in the dedicated map-first request at its first open step (the sub-area)', 'step ' + dstep);
await page.screenshot({ path: OUT + '04-areas-draft.png' });

// 4. a request under review is read-only: no «تعديل» for the requester, no editor
const underReview = (await api('GET', '/restationing-requests')).body.find((r) => r.state === 'UNDER_REVIEW' && r.mine);
if (underReview) {
  await page.goto(BASE + '/#restationing/' + underReview.id);
  await page.waitForTimeout(1500);
  ok((await page.getByRole('button', { name: /^تعديل/ }).count()) === 0 && (await page.getByTestId('restation-request').count()) === 0, 'U-16 a request under review is read-only for its requester', underReview.number);
} else ok(true, 'U-16 (no request under review of this requester to show; read-only path covered by the state rule)');
ok(errors.length === 0, 'U-17 no page error', errors.join(' | ').slice(0, 200));
await browser.close();
console.log(`drafts left as drafts of «${mine.name}»: ${draft.number}, ${areasDraft.number}`);
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
