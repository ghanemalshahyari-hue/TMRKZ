// Owner review items of 6 Nov 2026 (provisional acceptance of the 3D terrain), on the REAL page in headless Edge (GPU),
// every request outside the application's origins refused and counted, nothing saved:
//   R1 §6  a deployment area dragged in 3D from a mountain flank to a plain at the SAME 5.8 km from the primary area:
//          class, allowance, effective maximum and verdict follow the ground (policy DEV-3D) — and the slope colours
//          («الانحدار», owner request) shown over the same ground;
//   R2 §3  draped request geometries and occupied ground on slopes, seen from two bearings;
//   R3 §4  the two-part MultiPolygon in 3D: a press on ONE part moves the whole site, both parts drape where they land,
//          part order and the stored 2D geometry unchanged;
//   R4 §5  «رسم حدود جديدة» in 3D with the accepted editor: numbered vertices, live edges and lengths, closing on the
//          first vertex, a vertex edited, undo, redo, reset.
//
//   node tests/acceptance/terrain-3d-review.mjs   (UI_URL default http://localhost:5197, AUTH_URL http://localhost:8097)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5197';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8097';
const OUT = fileURLToPath(new URL('../../docs/evidence/terrain-3d/review/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
const SIZE = { width: 1920, height: 1032 };
const MAP = '.tz-mapframe .tz-map-layer';
// fictional points on real GLO-30 relief; MTN and FLAT are both 5.8 km from the primary area's centre
const P = { mountain: { lat: 24.77, lng: 56.075 }, primary: { lat: 24.825, lng: 56.125 }, MTN: { lat: 24.8511, lng: 56.0753 }, FLAT: { lat: 24.825, lng: 56.0676 } };

const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const external = [];
const consoleErrors = [];
const writes = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function signIn(user) {
  const ctx = await browser.newContext({ viewport: SIZE });
  const p = await ctx.newPage();
  await p.goto(AUTH + '/api/v1/auth/oidc/start');
  await p.waitForSelector('#kc-form-login', { timeout: 30000 });
  await p.fill('#username', user);
  await p.fill('#password', PASSWORD);
  await p.click('#kc-login');
  await p.waitForURL((u) => u.toString().startsWith(AUTH) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
  await p.goto(UI + '/');
  const state = await ctx.storageState();
  const current = await p.evaluate(async () => (await fetch('/api/v1/stationing/current')).json());
  await ctx.close();
  return { state, current };
}

async function session(state, name, run) {
  const dir = OUT + '.video-' + name;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, storageState: state, recordVideo: { dir, size: SIZE } });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(UI) || u.startsWith(AUTH) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    external.push(`${name}: ${u}`);
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('request', (q) => q.method() !== 'GET' && !q.url().endsWith('/api/v1/stationing/terrain/assess') && writes.push(`${name}: ${q.method()} ${q.url()}`));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  const t0 = Date.now();
  const marks = {};
  try {
    await run(page, (k) => (marks[k] = (Date.now() - t0) / 1000));
  } finally {
    const v = page.video();
    const path = await v.path();
    await ctx.close();
    renameSync(path, OUT + name + '-full.webm');
    rmSync(dir, { recursive: true, force: true });
    if (marks.start != null) {
      try {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, marks.start - 0.5)), '-to', String((marks.end ?? marks.start + 30) + 0.5), '-i', OUT + name + '-full.webm', '-c:v', 'libvpx-vp9', '-b:v', '2500k', '-an', OUT + name + '.webm']);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', OUT + name + '.webm', '-vf', 'fps=6,scale=840:-1:flags=lanczos', '-loop', '0', OUT + name + '.gif']);
      } catch (e) {
        console.log('ffmpeg: ' + e.message);
      }
    }
    rmSync(OUT + name + '-full.webm', { force: true });
  }
}

const mapEval = (page, fn, arg) => page.evaluate(([sel, src, a]) => new Function('m', 'a', src)(document.querySelector(sel).tmrkzMap, a), [MAP, fn, arg]);
const settle = async (page, ms = 600) => {
  await page.waitForTimeout(ms);
  await page.waitForFunction((sel) => {
    const m = document.querySelector(sel)?.tmrkzMap;
    return !!m && m.loaded() && m.areTilesLoaded() && !m.isMoving();
  }, MAP, { timeout: 45000 }).catch(() => undefined);
  await page.waitForTimeout(400);
};
const editParts = (page) => mapEval(page, `return (m.getSource('rs-edit').serialize().data.features || []).map((f) => f.geometry.coordinates);`);
const panel = (page) => page.locator('[data-testid=terrain-panel]').evaluate((e) => ({ ...e.dataset }));
const waitPanel = (page) => page.waitForFunction(() => document.querySelector('[data-testid=terrain-panel]')?.dataset.pending === 'false', null, { timeout: 30000 }).catch(() => undefined);
const clickAt = async (page, ll) => {
  const s = await toScreen(page, [ll.lng, ll.lat]);
  await page.mouse.move(s.x, s.y, { steps: 12 });
  await page.waitForTimeout(200);
  await page.mouse.click(s.x, s.y);
};
const slowDrag = async (page, from, to, steps = 70) => {
  await page.mouse.move(from.x, from.y, { steps: 12 });
  await page.waitForTimeout(400);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { steps: 1 });
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(400);
  await page.mouse.up();
};
const rotate = async (page, dx, steps = 60) => {
  const box = await page.locator(MAP).boundingBox();
  const c = { x: box.x + box.width / 2, y: box.y + box.height * 0.45 };
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(c.x + (dx * i) / steps, c.y, { steps: 1 });
    await page.waitForTimeout(40);
  }
  await page.mouse.up({ button: 'right' });
};
const handle = (page) => page.evaluate(() => {
  const b = document.querySelector('.stw-prop-sym').getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
});
const elevOf = (page, coords) => mapEval(page, `return a.map((c) => m.queryTerrainElevation(c));`, coords);
const km = (a, b) => Math.hypot((b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 110900) / 1000;
const shot = (page, f) => page.screenshot({ path: OUT + f });

const req = await signIn('t.requester');
const cur = req.current.find((c) => c.siteName === 'موقع السهل الغربي (وهمي)');

// ---- R1 + R2: deployment area mountain → plain at the same distance; slopes; occupied ground from two bearings -------
await session(req.state, 'R1-deployment-mountain-to-plain', async (page, mark) => {
  await toNewSiteStep(page, UI, cur.siteId, cur.orgName);
  await settle(page, 1500);
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'تصغير' }).click();
    await settle(page, 500);
  }
  await page.getByRole('button', { name: 'تحديد الموقع على الخريطة' }).click();
  await clickAt(page, P.mountain);
  await settle(page, 900);
  await page.getByRole('button', { name: 'الخطوة 5: الانتشار' }).click();
  await page.waitForSelector('[data-testid=area-controls]', { timeout: 20000 });
  await settle(page, 1200);
  await page.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).click();
  await settle(page, 800);
  await clickAt(page, P.primary);
  await settle(page, 900);
  await page.locator('[data-testid=area-controls]').getByRole('tab', { name: 'منطقة الانتشار البديلة' }).click();
  await settle(page, 1200);
  await page.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).click();
  await settle(page, 800);
  await clickAt(page, P.MTN);
  await settle(page, 900);
  await page.locator('[data-testid=view-switch] button', { hasText: '3D' }).click();
  await settle(page, 2500);
  // the leg in view: primary and alternative
  await page.locator('.tz3-chip[data-leg=alternative]').click();
  await settle(page, 2000);
  await waitPanel(page);
  await page.waitForTimeout(800);
  const before = await panel(page);
  await shot(page, 'R1-before-mountain.png');
  mark('start');
  const from = await handle(page);
  const toS = await toScreen(page, [P.FLAT.lng, P.FLAT.lat]);
  const fromG = await toScreen(page, [P.MTN.lng, P.MTN.lat]);
  await slowDrag(page, from, { x: from.x + toS.x - fromG.x, y: from.y + toS.y - fromG.y });
  await settle(page, 800);
  await waitPanel(page);
  await page.waitForTimeout(1500);
  mark('end');
  const after = await panel(page);
  const alt = await editParts(page);
  const c = alt[0][0].slice(0, -1).reduce((s, v, _, r) => ({ lng: s.lng + v[0] / r.length, lat: s.lat + v[1] / r.length }), { lng: 0, lat: 0 });
  await shot(page, 'R1-after-plain.png');
  const chip = await page.locator('.tz3-chip[data-leg=alternative]').innerText();
  ok(before.class === 'MOUNTAINOUS' && before.verdict === 'OK' && Number(before.effectiveMax) === 7000 &&
     ['FLAT', 'UNDULATING'].includes(after.class) && after.verdict === 'OUT_OF_RANGE' && Number(after.effectiveMax) < 7000 && Math.abs(km(P.primary, c) - 5.8) < 0.15,
    'R1', 'deployment area dragged in 3D from a mountain flank to a plain at the same distance: class, allowance, effective maximum and verdict follow the ground',
    `${km(P.primary, P.MTN).toFixed(2)} km → ${km(P.primary, c).toFixed(2)} km; class ${before.class} → ${after.class}; allowance ${before.allowance} → ${after.allowance} m; effective max ${before.effectiveMax} → ${after.effectiveMax} m; verdict ${before.verdict} → ${after.verdict}; heights ${before.min}–${before.max} → ${after.min}–${after.max} m; chip «${chip.replace(/\s+/g, ' ')}»`);
  // the owner's slope colours over the same ground
  await page.locator('[data-testid=slope-control] button').click();
  await settle(page, 2500);
  const slope = await mapEval(page, `const l = m.getLayer('terrain3d-slope'); return { layer: !!l, visible: l && m.getLayoutProperty('terrain3d-slope', 'visibility') === 'visible', loaded: m.isSourceLoaded('terrain3d-slope'), last: m.getStyle().layers.map((x) => x.id).filter((x) => x.startsWith('terrain3d')).at(-1) };`);
  await shot(page, 'R1-slope-colours.png');
  ok(slope.layer && slope.visible && slope.loaded && slope.last === 'terrain3d-slope' && (await page.locator('.tz-slope-legend li').count()) === 5, 'R1b', '«الانحدار»: the policy\'s five slope classes coloured over the terrain (display only), above the tint and shade', JSON.stringify(slope));
  await page.locator('[data-testid=slope-control] button').click();
  await settle(page, 800);
  // R2: the proposed site and the occupied ground on slopes, from two bearings
  await page.locator('.tz3-card.r-SITE').click();
  await settle(page, 2500);
  const geo = await mapEval(page, `
    const occ = m.getSource('occ').serialize().data.features.filter((f) => f.properties.role === 'OCC_SITE');
    const rs = m.getSource('rs').serialize().data.features.filter((f) => ['CURRENT', 'SITE', 'PRIMARY'].includes(f.properties.role) && f.geometry.type.endsWith('Polygon'));
    const ring = (f) => (f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates.flatMap((p) => p[0]));
    const span = (cs) => { const h = cs.map((c) => m.queryTerrainElevation(c)).filter((v) => v != null); return h.length ? Math.round(Math.max(...h) - Math.min(...h)) : null; };
    return { occ: occ.map((f) => span(ring(f))), rs: rs.map((f) => [f.properties.role, span(ring(f))]), bearing: m.getBearing() };`);
  await shot(page, 'R2-bearing-a.png');
  await rotate(page, 300);
  await settle(page, 1500);
  const b2 = await mapEval(page, `return m.getBearing();`);
  await shot(page, 'R2-bearing-b.png');
  ok(geo.rs.some(([r, s]) => r === 'SITE' && s > 100) && geo.occ.some((s) => s > 20) && Math.abs(b2 - geo.bearing) > 20, 'R2', 'draped on slopes, seen from two bearings: proposed site and occupied ground span real height differences',
    `proposed/current/primary height spans ${geo.rs.map(([r, s]) => r + ' ' + s + ' m').join(', ')}; occupied sites ${geo.occ.map((s) => s + ' m').join(', ')}; bearing ${geo.bearing.toFixed(0)}° → ${b2.toFixed(0)}°`);
});

// ---- R4: «رسم حدود جديدة» in 3D with the accepted editor ------------------------------------------------------------
await session(req.state, 'R4-draw-new-boundary-3d', async (page, mark) => {
  await toNewSiteStep(page, UI, cur.siteId, cur.orgName);
  await settle(page, 1500);
  await page.locator('[data-testid=view-switch] button', { hasText: '3D' }).click();
  await settle(page, 2500);
  mark('start');
  await page.getByRole('tab', { name: /رسم حدود جديدة/ }).click();
  await settle(page, 1500);
  const n = page.getByRole('spinbutton', { name: 'عدد الرؤوس' });
  await n.fill('6');
  await page.waitForTimeout(400);
  // a shape on the hills in the upper part of the visible map (north of the current site), placed by screen position
  const box = await page.locator(MAP).boundingBox();
  const c0 = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.3 };
  const ring = [[-110, -60], [110, -70], [130, 70], [-100, 80]].map(([dx, dy]) => ({ x: c0.x + dx, y: c0.y + dy }));
  for (const s of ring) {
    await page.mouse.move(s.x - 40, s.y - 30, { steps: 6 });
    await page.mouse.move(s.x, s.y, { steps: 14 });
    await page.waitForTimeout(250);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(500);
  }
  // live: numbered vertices, the length of every side so far, the rubber line to the pointer
  const live = await page.evaluate(() => ({
    numbers: [...document.querySelectorAll('.stw-vtx')].filter((e) => e.offsetParent).map((e) => e.textContent),
    sides: [...document.querySelectorAll('.stw-edge')].filter((e) => e.offsetParent && e.textContent).map((e) => e.textContent),
    closable: !!document.querySelector('.stw-vtx.first.closable'),
  }));
  const rubber = await mapEval(page, `return (m.getSource('rs-draw').serialize().data.features || []).map((f) => f.properties.role);`);
  await shot(page, 'R4-drawing-live.png');
  // close on the first vertex
  const first = await page.locator('.stw-vtx.first').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 14 });
  await page.waitForTimeout(300);
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await settle(page, 1500);
  const drawn = await editParts(page);
  const elev = await elevOf(page, drawn[0]?.[0].slice(0, -1) ?? []);
  const vtxAfter = await page.evaluate(() => [...document.querySelectorAll('.stw-vtx')].filter((e) => e.offsetParent).map((e) => e.textContent));
  ok(live.numbers.join(',') === '1,2,3,4' && live.sides.length >= 3 && live.sides.every((t) => /م|كم/.test(t)) && live.closable && rubber.includes('rubber') && rubber.includes('edges') &&
     drawn.length === 1 && drawn[0][0].length === 5 && vtxAfter.join(',') === '1,2,3,4',
    'R4', '«رسم حدود جديدة» in 3D: numbered vertices, live edges with lengths and rubber line, closed on the first vertex',
    `vertices ${live.numbers.join(',')}; sides ${live.sides.join(' / ')}; layers ${[...new Set(rubber)].join(',')}; closed ring ${drawn[0]?.[0].length - 1} vertices on terrain ${elev.map((h) => Math.round(h)).join(', ')} m`);
  // a vertex edited on the terrain, then undo, redo, reset
  const v3 = await page.locator('.stw-vtx', { hasText: '3' }).first().boundingBox();
  await page.mouse.move(v3.x + v3.width / 2, v3.y + v3.height / 2, { steps: 12 });
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.mouse.move(v3.x + v3.width / 2 + 90, v3.y + v3.height / 2 + 40, { steps: 35 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await settle(page, 1000);
  const edited = await editParts(page);
  await page.getByRole('button', { name: '↶ تراجع' }).click();
  await page.waitForTimeout(800);
  const undone = await editParts(page);
  await page.getByRole('button', { name: '↷ إعادة' }).click();
  await page.waitForTimeout(800);
  const redone = await editParts(page);
  await page.getByRole('button', { name: 'إعادة الضبط' }).click();
  await page.waitForTimeout(1000);
  const reset = await editParts(page);
  await settle(page, 1000);
  mark('end');
  await shot(page, 'R4-closed-and-edited.png');
  const S = JSON.stringify;
  ok(S(edited) !== S(drawn) && S(edited[0][0][0]) === S(drawn[0][0][0]) && S(undone) === S(drawn) && S(redone) === S(edited) && S(reset) === S(drawn), 'R4b', 'vertex 3 edited on the terrain (others unchanged); undo, redo and reset restore exact coordinates');
});

// ---- R3: the two-part MultiPolygon in 3D ----------------------------------------------------------------------------
const mgr = await signIn('t.manager.ga');
const mp = mgr.current.find((c) => c.siteName === 'موقع من جزأين على السهل (وهمي)');
await session(mgr.state, 'R3-multipolygon-3d', async (page, mark) => {
  await toNewSiteStep(page, UI, mp.siteId, mp.orgName);
  await settle(page, 1500);
  await page.locator('[data-testid=view-switch] button', { hasText: '3D' }).click();
  await settle(page, 2500);
  // the site in view, close enough to see each part on its own ground
  await page.locator('.tz3-card.r-SITE').click();
  await settle(page, 2500);
  const before = await editParts(page);
  await shot(page, 'R3-before.png');
  mark('start');
  // press on the SECOND part only, drag towards the slopes to the south-east
  const centre = (part) => part[0].slice(0, -1).reduce((s, v, _, r) => [s[0] + v[0] / r.length, s[1] + v[1] / r.length], [0, 0]);
  const p2 = await toScreen(page, centre(before[1]));
  const T = { lng: centre(before[1])[0] + 0.012, lat: centre(before[1])[1] - 0.012 };
  const t = await toScreen(page, [T.lng, T.lat]);
  await slowDrag(page, p2, t);
  await settle(page, 1500);
  mark('end');
  const after = await editParts(page);
  await shot(page, 'R3-after.png');
  const vec = before.map((part, i) => {
    const [a, b] = [centre(part), centre(after[i])];
    return [(b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * 110900];
  });
  const spread = Math.hypot(vec[0][0] - vec[1][0], vec[0][1] - vec[1][1]);
  const heights = await Promise.all(after.map((part) => elevOf(page, part[0].slice(0, -1))));
  const span = heights.map((h) => [Math.round(Math.min(...h)), Math.round(Math.max(...h))]);
  const rendered = await mapEval(page, `return [...new Set(m.queryRenderedFeatures({ layers: ['rs-edit-fill'] }).map((f) => f.properties.part))].sort();`);
  // back to 2D: the stored geometry is the one the 3D drag produced, part for part
  await page.locator('[data-testid=view-switch] button', { hasText: '2D' }).click();
  await settle(page, 1500);
  const in2d = await editParts(page);
  ok(after.length === 2 && Math.hypot(...vec[0]) > 500 && spread < 0.5 && JSON.stringify(in2d) === JSON.stringify(after) && rendered.join(',') === '0,1' && after.every((part, i) => part[0].length === before[i][0].length),
    'R3', 'two-part MultiPolygon in 3D: a press on part 2 moves the whole site; both parts drape where they land; part order and stored 2D geometry unchanged',
    `move ${Math.hypot(...vec[0]).toFixed(0)} m, parts differ by ${spread.toFixed(3)} m; terrain under part 1 ${span[0].join('–')} m, part 2 ${span[1].join('–')} m; rendered parts ${rendered.join(',')}; 2D geometry identical: ${JSON.stringify(in2d) === JSON.stringify(after)}`);
});

ok(writes.length === 0, 'W', 'zero request writes (the only POSTs are the read-only terrain analysis)', writes.slice(0, 3).join(' '));
ok(external.length === 0, 'X', 'zero external requests', external.slice(0, 3).join(' '));
ok(consoleErrors.length === 0, 'C', 'zero console errors', consoleErrors.slice(0, 3).join(' | '));
await browser.close();
writeFileSync(OUT + 'results.json', JSON.stringify({ when: new Date().toISOString(), ui: UI, results, external, consoleErrors, writes }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
