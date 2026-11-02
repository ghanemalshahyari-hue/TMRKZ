// A–H walkthrough of the polygon-footprint prototype in Microsoft Edge, with measured frame times during the drags.
//   HEADLESS=1 node footprint-probe.mjs   (headed by default)
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'evidence'); mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? 'http://127.0.0.1:5190';
const b = await chromium.launch({ channel: 'msedge', headless: !!process.env.HEADLESS });
const ctx = await b.newContext({ locale: 'ar-AE', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [], external = [];
await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !/^(data|blob)/.test(u.protocol)) { external.push(u.href); return r.abort(); } return r.continue(); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(m.text()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: join(OUT, 'fp-' + n + '.png') });
const S = () => page.evaluate(() => window.__fp.state());
const pt = (c) => page.evaluate(([lng, lat]) => window.__fp.pt(lng, lat), c);
const dst = (c, m, br) => page.evaluate(([lng, lat, m, br]) => window.__fp.dest(lng, lat, m, br), [c[0], c[1], m, br]);
const sampler = () => page.evaluate(() => {
  const rt = { f: [], last: 0, on: false, long: 0 }; window.__rt = rt;
  const loop = (t) => { if (rt.on) { if (rt.last) rt.f.push(t - rt.last); rt.last = t; } else rt.last = 0; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => { for (const _ of l.getEntries()) if (rt.on) rt.long++; }).observe({ entryTypes: ['longtask'] }); } catch {}
});
const stats = () => page.evaluate(() => { const rt = window.__rt; const x = rt.f.slice().sort((a, b) => a - b); const m = x.reduce((a, b) => a + b, 0) / (x.length || 1); return { frames: x.length, meanMs: +m.toFixed(2), p95Ms: +(x[Math.floor(x.length * 0.95)] ?? 0).toFixed(2), worstMs: +(x[x.length - 1] ?? 0).toFixed(2), janky: x.filter((d) => d > 25).length, longTasks: rt.long }; });
async function dragPath(from, waypoints, steps = 22, shotsAt = {}) {
  await page.evaluate(() => { window.__rt.f = []; window.__rt.on = true; });
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  let cur = from;
  for (let w = 0; w < waypoints.length; w++) {
    const to = waypoints[w];
    for (let i = 1; i <= steps; i++) { await page.mouse.move(cur.x + (to.x - cur.x) * (i / steps), cur.y + (to.y - cur.y) * (i / steps)); await sleep(8); }
    cur = to;
    if (shotsAt[w]) { await sleep(60); await shot(shotsAt[w].name); shotsAt[w].state = await S(); }
  }
  await page.mouse.up();
  await page.evaluate(() => { window.__rt.on = false; });
  return stats();
}
const R = { errs, external };

await page.goto(BASE + '/footprint.html', { waitUntil: 'load' });
await page.waitForSelector('.fp-sym.orig .svg', { timeout: 20000 }); // the symbol container is 0×0 by design; its SVG has size
await sampler();
await sleep(500);
const orig0 = await page.evaluate(() => JSON.stringify(window.__fp.origRing()));
R.A = { origVertices: (await page.evaluate(() => window.__fp.origRing().length)) - 1, origArea: (await S()).origArea };
await shot('A-existing');

// ---- B: Mode A — drag the complete footprint (polygon + symbol) ----
await page.locator('#fp-tA').click();
await sleep(900); // fly to the allowed range
const A0 = await page.evaluate(() => window.__fp.anchor);
const grab = await pt(A0);
const pOverlap = await pt(await dst(A0, 2050, 0));   // onto the northern occupied zone
const pOut = await pt(await dst(A0, 5450, 270));     // past the maximum distance
const pValid = await pt(await dst(A0, 1900, 150));   // a valid spot
const sh = { 0: { name: 'B1-overlap' }, 1: { name: 'B2-out-of-range' } };
R.B_drag = await dragPath(grab, [pOverlap, pOut, pValid], 24, sh);
R.B_overlapState = sh[0].state; R.B_outState = sh[1].state;
await sleep(700); // simulated server check
R.B_dropped = await S();
await shot('B3-valid-drop');
// undo / redo / reset
await page.keyboard.press('Control+z'); await sleep(150); R.B_afterUndo = await S();
await page.keyboard.press('Control+y'); await sleep(150); R.B_afterRedo = await S();
await page.locator('#fp-reset').click(); await sleep(150); R.B_afterReset = await S();
await shot('B4-reset');

// ---- C: Mode B — draw a four-vertex footprint by clicking the map ----
await page.locator('#fp-tB').click();
await sleep(300);
const c0 = await dst(A0, 2300, 140);
await page.evaluate(([lng, lat]) => window.__fp.view(lng, lat, 15), c0); // a user zooms in to draw a site
await sleep(300);
const corners = [await dst(c0, 330, 315), await dst(c0, 300, 45), await dst(c0, 360, 135), await dst(c0, 280, 225)];
for (const c of corners) { const p = await pt(c); await page.mouse.click(p.x, p.y); await sleep(120); }
await sleep(900); // focus on the closed shape
R.C_drawn = await S();
await shot('C-drawn-4');

// ---- D: edit an individual vertex ----
const v2 = await page.locator('.fp-vtx', { hasText: '2' }).boundingBox();
const v2c = { x: v2.x + v2.width / 2, y: v2.y + v2.height / 2 };
R.D_drag = await dragPath(v2c, [{ x: v2c.x + 70, y: v2c.y - 50 }], 18);
await sleep(700);
R.D_edited = await S();
await shot('D-vertex-edited');
// self-intersection check: drag vertex 1 (NW) past vertex 2 (NE) so edge 4→1 crosses edge 2→3, then undo
const v1 = await page.locator('.fp-vtx', { hasText: '1' }).boundingBox();
const v2b = await page.locator('.fp-vtx', { hasText: '2' }).boundingBox();
await dragPath({ x: v1.x + 11, y: v1.y + 11 }, [{ x: v2b.x + 11 + 90, y: v2b.y + 11 + 10 }], 16);
await sleep(300);
R.D_bowtie = await S();
await shot('D2-self-intersection');
await page.keyboard.press('Control+z'); await sleep(300);
R.D_bowtieUndone = await S();

// ---- E: move the newly drawn footprint as one object ----
const areaBefore = (await S()).area;
// grab the polygon BODY: a point inside it, between its symbol and vertex 3
const sym = await page.locator('.fp-sym.prop .svg').boundingBox();
const v3b = await page.locator('.fp-vtx', { hasText: '3' }).boundingBox();
const symc = { x: sym.x + sym.width / 2, y: sym.y + sym.height / 2 };
const body = { x: (symc.x + v3b.x + 11) / 2, y: (symc.y + v3b.y + 11) / 2 };
R.E_grabTarget = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? (el.getAttribute('class') ?? el.tagName) : null; }, [body.x, body.y]);
R.E_drag = await dragPath(body, [{ x: body.x - 220, y: body.y - 80 }, { x: body.x - 160, y: body.y + 60 }], 24);
await sleep(700);
const E = await S();
R.E_moved = { ...E, areaBefore, areaDeltaPct: ((E.area - areaBefore) / areaBefore) * 100 };
await shot('E-new-moved');

// ---- F/G are the readouts captured above; H: cancel → original unchanged ----
await page.keyboard.press('Escape'); await sleep(300);
R.H = { state: await S(), originalUnchanged: (await page.evaluate(() => JSON.stringify(window.__fp.origRing()))) === orig0 };
await shot('H-cancelled');

writeFileSync(join(OUT, 'footprint-results.json'), JSON.stringify(R, null, 2));
console.log(JSON.stringify(R, null, 1));
await ctx.close(); await b.close();
