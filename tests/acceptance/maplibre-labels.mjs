// Offline MapLibre labels (owner decision 5 of 4 Nov 2026) on the harness prototypes/maplibre-offline, which runs the
// not-yet-wired frontend module frontend/src/components/map/maplibre with local data only (map-data/, git-ignored):
//   - shaping and order of Arabic, English, mixed, route-number, punctuation and digit labels, scored against the
//     browser's own text engine in the same font, and three deliberately broken candidates that must fail the score;
//   - Arabic and English road names, route numbers and placed-label collisions on the real UAE basemap;
//   - zoom transitions, street mode, terrain mode (GLO-30 hillshade) with overlay, selection and camera kept;
//   - an air-gapped run: every request that is not to the harness is aborted and counted, and names outside the harness
//     do not resolve.
// Headless Edge (playwright-core), no internet, no acceptance environment needed. Usage: node tests/acceptance/maplibre-labels.mjs
// Evidence: docs/evidence/maplibre-labels/ (results.json and pictures).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SRC = REPO + 'docs/evidence/maplibre-labels/';
// LABELS_OUT keeps a later run's evidence apart (map packaging gate: the same checks on the installed package)
const OUT = process.env.LABELS_OUT ? REPO + process.env.LABELS_OUT.replace(/\/?$/, '/') : SRC;
mkdirSync(OUT, { recursive: true });
const HOST = '127.0.0.1';
// LABELS_PORT=<port> runs the harness on another port (default 5197, the harness's own; e.g. while an application dev
// server already holds 5197)
const PORT = process.env.LABELS_PORT ?? '5197';
const BASE = `http://${HOST}:${PORT}`;
const HILLSHADE = 'map-data/terrain/glo30/visualization/hillshade.pmtiles';
const CMAP = new Set(JSON.parse(readFileSync(SRC + 'font-cmap.json', 'utf8')).codepoints);

const checks = [];
const check = (id, title, ok, detail) => {
  checks.push({ id, title, result: ok ? 'PASS' : 'FAIL', detail });
  console.log(ok ? 'PASS' : 'FAIL', id, title, '—', typeof detail === 'string' ? detail : JSON.stringify(detail));
};
/** A recorded finding that is neither a pass nor a failure (a known upstream defect, or its disappearance). */
const note = (id, title, result, detail) => {
  checks.push({ id, title, result, detail });
  console.log(result, id, title, '—', detail);
};

for (const f of ['map-data/basemap/uae.pmtiles', 'frontend/node_modules/maplibre-gl/package.json']) {
  if (!existsSync(REPO + f)) {
    console.error('missing ' + f + ' — see prototypes/maplibre-offline/README.md');
    process.exit(2);
  }
}
const hasHillshade = existsSync(REPO + HILLSHADE);

// the harness (Vite dev server of prototypes/maplibre-offline) for the duration of the run
const server = spawn(process.execPath, ['frontend/node_modules/vite/bin/vite.js', '--config', 'prototypes/maplibre-offline/vite.config.mjs', ...(process.env.LABELS_PORT ? ['--port', PORT] : [])], {
  cwd: REPO,
  stdio: 'ignore',
});
const stop = () => server.kill();
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
/** A step that does not finish in time fails the run instead of hanging it. */
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ': no result within ' + ms / 1000 + ' s')), ms))]);
for (let i = 0; ; i++) {
  try {
    if ((await fetch(BASE + '/')).ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 120) throw new Error('harness did not start on ' + BASE);
  await new Promise((r) => setTimeout(r, 250));
}

const external = [];
const local = [];
const consoleErrors = [];
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: true,
  // air gap: no name other than the harness resolves
  args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${HOST}, EXCLUDE localhost`],
});
const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
  if (u.hostname !== HOST && u.hostname !== 'localhost') {
    external.push(u.href);
    return route.abort('blockedbyclient');
  }
  local.push(u.pathname);
  return route.continue();
});

async function open(query) {
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  await page.goto(BASE + '/?' + query);
  return page;
}

/** Waits until the map is idle with every source loaded, and records MapLibre error events. */
async function ready(page) {
  await page.waitForFunction(() => !!window.__ml, null, { timeout: 30000 });
  page.setDefaultTimeout(60000);
  await page.evaluate(() => {
    const m = window.__ml.map;
    if (!window.__mlErrors) {
      window.__mlErrors = [];
      m.on('error', (e) => window.__mlErrors.push(String(e.error?.message ?? e.error ?? e)));
    }
  });
  await idle(page);
}

async function idle(page) {
  await within(page.evaluate(
    () =>
      new Promise((resolve) => {
        const m = window.__ml.map;
        const done = () => (m.loaded() && m.areTilesLoaded() ? resolve() : m.once('idle', done));
        m.once('idle', done);
        m.triggerRepaint();
      }),
  ), 60000, 'map idle');
}

/** Screen box of the fictional test-label column of the harness overlay. */
const labelClip = (page) =>
  page.evaluate(() => {
    const m = window.__ml.map;
    const r = m.getContainer().getBoundingClientRect();
    const pts = window.__ml.labelPoints.map((c) => m.project(c));
    const ys = pts.map((p) => p.y + r.top);
    return { x: Math.max(0, pts[0].x + r.left - 120), y: Math.max(0, Math.min(...ys) - 16), width: 240, height: Math.max(...ys) - Math.min(...ys) + 32 };
  });

const labelsOf = (page, layers) =>
  page.evaluate((layers) => {
    const m = window.__ml.map;
    return m.queryRenderedFeatures({ layers }).map((f) => {
      const p = f.properties;
      return { layer: f.layer.id, text: f.layer.id === 'label-route' ? p.ref : (p['name:ar'] ?? p.name ?? p['name:en']), en: p['name:en'] ?? p.name ?? p['name:ar'] };
    });
  }, layers);
const AR = /[\u0600-\u06FF]/;
const LATIN = /[A-Za-z]/;
const rendered = new Set();
const remember = (labels, lang = 'ar') => labels.forEach((l) => rendered.add(lang === 'en' ? l.en : l.text));

// 1. Shaping, order and bracket mirroring, scored against the browser's text engine in the same font. Run on a document
// like the application's (<html dir="rtl">, frontend/index.html) with the module's fix (drawGlyphsLeftToRight: the
// glyph canvases are drawn left to right), on <html dir="ltr"> + <body dir="rtl"> as a cross-check, and on the
// application's document WITHOUT the fix as the control: MapLibre mirrors brackets itself, and a glyph canvas left at
// "inherit" takes the document direction, so the browser mirrors each bracket a second time (finding G-8a).
async function glyphRun(dir) {
  const page = await open('page=glyphs' + (dir === 'split' ? '&dir=split' : dir === 'rtl-nofix' ? '&glyphfix=off' : ''));
  await page.waitForFunction(() => !!window.__glyphs, null, { timeout: 30000 });
  const res = await within(page.evaluate(() => window.__glyphs), 90000, 'glyph check');
  writeFileSync(OUT + `glyphs-${dir}.png`, Buffer.from(res.strip.split(',')[1], 'base64'));
  delete res.strip;
  writeFileSync(OUT + `glyphs-${dir}.json`, JSON.stringify(res, null, 2));
  await page.close();
  return res;
}
{
  const app = await glyphRun('rtl');
  const fixed = await glyphRun('split');
  const control = await glyphRun('rtl-nofix');
  const by = (kind, res = app) => res.results.filter((r) => r.kind === kind);
  const ok = (rs) => rs.length > 0 && rs.every((r) => r.ok);
  const brief = (rs) => rs.map((r) => `${r.id} match=${r.match}${r.margin === null ? '' : ' margin=' + r.margin} aspect=${r.aspectDiff}`).join('; ');
  const res = app;
  // 'requested' only records that a tile held right-to-left text (src/tile/tile.ts lazyLoad); with no plugin URL set,
  // nothing is loaded. 'loading', 'loaded' or 'deferred' would mean a plugin was configured.
  check(
    'G-0',
    `MapLibre ${res.version}: no right-to-left plugin configured or loaded`,
    ['unavailable', 'requested'].includes(res.rtlPluginStatus) && !local.some((p) => /rtl/i.test(p)),
    'deprecated plugin API status: ' + res.rtlPluginStatus + '; no rtl-text script requested',
  );
  for (const [id, kind, title] of [
    ['G-1', 'arabic', 'Arabic labels joined and ordered right to left'],
    ['G-2', 'english', 'English labels'],
    ['G-3', 'mixed', 'mixed Arabic + Latin labels in bidirectional order'],
    ['G-4', 'route', 'route numbers'],
    ['G-5', 'punctuation', 'punctuation (brackets, Arabic comma, guillemets, question mark)'],
    ['G-6', 'numerals', 'Arabic-Indic and Western numerals'],
  ]) {
    check(id, title + ' (both document setups)', ok(by(kind)) && ok(by(kind, fixed)), 'rtl document: ' + brief(by(kind)) + ' || ltr document, rtl body: ' + brief(by(kind, fixed)));
  }
  const broken = by('broken');
  check('G-7', 'the score rejects deliberately broken text (isolated letters, reversed order, no shaping and no bidi)', broken.length === 3 && broken.every((r) => !r.ok), brief(broken));
  check('G-8a', 'bracket and guillemet mirroring on the application RTL document (<html dir="rtl">) with the module fix (left-to-right glyph canvases)', ok(by('mirroring')), brief(by('mirroring')));
  check('G-8b', 'bracket and guillemet mirroring on <html dir="ltr">, <body dir="rtl"> (cross-check: the same result)', ok(by('mirroring', fixed)), brief(by('mirroring', fixed)));
  const mirrorControl = by('mirroring', control);
  note(
    'G-8c',
    'control: the same RTL document without the fix (MapLibre/TinySDF upstream behaviour)',
    mirrorControl.every((r) => !r.ok) ? 'KNOWN-DEFECT' : 'CHANGED',
    (mirrorControl.every((r) => !r.ok) ? 'double mirror reproduced without the fix — brackets point outwards: ' : 'no longer reproduced upstream — the fix may become unnecessary: ') + brief(mirrorControl),
  );
}

// 2. Street mode on the real basemap: Arabic and English names, route numbers
let page = await open('page=map&center=55.2744,25.1972&zoom=14' + (hasHillshade ? '&hillshade=/' + HILLSHADE + '&kind=raster' : ''));
await ready(page);
{
  const labels = await labelsOf(page, ['label-road', 'label-route', 'label-place']);
  remember(labels);
  const road = labels.filter((l) => l.layer === 'label-road');
  const ar = road.filter((l) => AR.test(l.text));
  const latinOnly = road.filter((l) => LATIN.test(l.text) && !AR.test(l.text));
  const routes = labels.filter((l) => l.layer === 'label-route');
  await page.screenshot({ path: OUT + 'street-dubai-z14-ar.png' });
  check('M-1', 'Arabic road names drawn on the basemap (Dubai, z14)', ar.length >= 10, `${ar.length} Arabic of ${road.length} road labels; e.g. ${[...new Set(ar.map((l) => l.text))].slice(0, 4).join(' | ')}`);
  // the fictional overlay labels (incl. brackets) as drawn on this RTL document by the module (with its glyph fix)
  await page.screenshot({ path: OUT + 'overlay-labels-dir-rtl.png', clip: await labelClip(page) });
  check('M-2', 'route numbers drawn as shields', routes.length >= 1, `${routes.length} route labels: ${[...new Set(routes.map((l) => l.text))].slice(0, 6).join(', ')}`);
  await page.evaluate(() => window.__ml.setLabels('en'));
  await idle(page);
  const en = (await labelsOf(page, ['label-road'])).filter((l) => LATIN.test(l.en) && !AR.test(l.en));
  remember(await labelsOf(page, ['label-road']), 'en');
  await page.screenshot({ path: OUT + 'street-dubai-z14-en.png' });
  check('M-3', 'English road names (label language English)', en.length >= 10, `${en.length} English road labels; e.g. ${[...new Set(en.map((l) => l.en))].slice(0, 4).join(' | ')}`);
  await page.evaluate(() => window.__ml.setLabels('ar'));
  await idle(page);
}

// the same overlay on <html dir="ltr"> + <body dir="rtl">, for comparison
{
  const p2 = await open('page=map&dir=split&center=55.2744,25.1972&zoom=14');
  await ready(p2);
  await p2.screenshot({ path: OUT + 'overlay-labels-dir-split.png', clip: await labelClip(p2) });
  await p2.close();
}

// 3. Collisions: no two placed basemap labels overlap at a dense zoom (MapLibre 6.15.0 collision grid, exact version)
{
  await page.evaluate(() => window.__ml.map.jumpTo({ center: [55.2708, 25.2048], zoom: 16 }));
  await idle(page);
  const r = await page.evaluate(() => {
    const m = window.__ml.map;
    const grid = m.style.placement.collisionIndex.grid;
    const items = [];
    grid.boxKeys.forEach((k, i) => {
      if (k.overlapMode === 'never') items.push({ k: k.bucketInstanceId + ':' + k.featureIndex, box: grid.bboxes.slice(4 * i, 4 * i + 4) });
    });
    grid.circleKeys.forEach((k, i) => {
      if (k.overlapMode === 'never') items.push({ k: k.bucketInstanceId + ':' + k.featureIndex, c: grid.circles.slice(3 * i, 3 * i + 3) });
    });
    const overlap = (a, b) => {
      if (a.box && b.box) return Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0]) > 0.5 && Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]) > 0.5;
      if (a.c && b.c) return Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) < a.c[2] + b.c[2] - 0.5;
      const [bx, cc] = a.box ? [a.box, b.c] : [b.box, a.c];
      const dx = Math.max(bx[0] - cc[0], 0, cc[0] - bx[2]);
      const dy = Math.max(bx[1] - cc[1], 0, cc[1] - bx[3]);
      return Math.hypot(dx, dy) < cc[2] - 0.5;
    };
    const pairs = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (items[i].k !== items[j].k && overlap(items[i], items[j])) pairs.push([items[i].k, items[j].k]);
    const placed = new Set(items.map((x) => x.k)).size;
    m.showCollisionBoxes = true;
    return { boxes: grid.boxKeys.length, circles: grid.circleKeys.length, placedFeatures: placed, overlaps: pairs.length, sample: pairs.slice(0, 5) };
  });
  remember(await labelsOf(page, ['label-road', 'label-route', 'label-place']));
  await idle(page);
  await page.screenshot({ path: OUT + 'collision-boxes-z16.png' });
  await page.evaluate(() => (window.__ml.map.showCollisionBoxes = false));
  check('M-4', 'collision handling: no overlapping placed labels (z16, Dubai)', r.placedFeatures >= 10 && r.overlaps === 0, r);
}

// 4. Zoom transitions
{
  const zooms = [8, 10, 12, 13, 14, 15, 16, 17, 15, 12, 9];
  const seen = [];
  for (const z of zooms) {
    await page.evaluate((z) => window.__ml.map.easeTo({ center: [55.2744, 25.1972], zoom: z, duration: 500 }), z);
    await page.waitForTimeout(550);
    await idle(page);
    const l = await labelsOf(page, ['label-road', 'label-route', 'label-place']);
    remember(l);
    seen.push({ zoom: z, labels: l.length });
  }
  const errors = await page.evaluate(() => window.__mlErrors);
  await page.screenshot({ path: OUT + 'zoom-end-z9.png' });
  check('M-5', 'zoom transitions 8→17→9: idle at every step, labels present, no map errors', errors.length === 0 && seen.every((s) => s.labels > 0), { steps: seen, errors });
}
await page.close();

// 5. Street and terrain mode at a relief area: background only changes; overlay, selection and camera stay
{
  page = await open('page=map&center=56.1300,24.8100&zoom=12' + (hasHillshade ? '&hillshade=/' + HILLSHADE + '&kind=raster' : ''));
  await ready(page);
  const state = () =>
    page.evaluate(() => {
      const m = window.__ml.map;
      const c = m.getCenter();
      const vis = (id) => (m.getLayer(id) ? m.getLayoutProperty(id, 'visibility') ?? 'visible' : 'absent');
      const g = m.getCanvas();
      const t = document.createElement('canvas');
      t.width = g.width;
      t.height = g.height;
      const tc = t.getContext('2d', { willReadFrequently: true });
      tc.drawImage(g, 0, 0);
      const d = tc.getImageData(0, 0, t.width, t.height).data;
      let s = 0, s2 = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        s += l;
        s2 += l * l;
        n++;
      }
      return {
        camera: { lng: +c.lng.toFixed(7), lat: +c.lat.toFixed(7), zoom: +m.getZoom().toFixed(6), bearing: m.getBearing(), pitch: m.getPitch() },
        overlay: ['test-area-fill', 'test-area-line', 'test-labels'].map(vis),
        selected: m.getFeatureState({ source: 'test-area', id: 1 }).selected === true,
        street: vis('road-highway'),
        terrain: vis('terrain-hillshade'),
        labels: vis('label-road'),
        notice: document.querySelector('[data-testid=map-source-notice]').textContent,
        attribution: document.querySelector('.maplibregl-ctrl-attrib')?.textContent ?? '',
        lumaStd: +Math.sqrt(s2 / n - (s / n) ** 2).toFixed(2),
      };
    });
  const before = await state();
  await page.screenshot({ path: OUT + 'street-hatta-z12.png' });
  check('M-6', 'street mode: OSM notice and attribution shown, overlay drawn', before.street === 'visible' && before.notice.includes('OpenStreetMap') && before.attribution.includes('OpenStreetMap') && before.overlay.every((v) => v === 'visible'), before);
  await page.getByTestId('mode-terrain').click();
  await idle(page);
  const terrain = await state();
  await page.screenshot({ path: OUT + 'terrain-hatta-z12.png' });
  const same = (a, b) => JSON.stringify(a.camera) === JSON.stringify(b.camera) && a.selected && b.selected && b.overlay.every((v) => v === 'visible');
  check(
    'M-7',
    hasHillshade ? 'terrain mode: GLO-30 hillshade drawn, DSM notice and Copernicus attribution, overlay/selection/camera unchanged' : 'terrain mode (no hillshade installed): notice shown, overlay/selection/camera unchanged',
    same(before, terrain) && terrain.street === 'none' && terrain.labels === 'visible' && (hasHillshade
      ? terrain.terrain === 'visible' && terrain.notice.includes('GLO-30') && terrain.notice.includes('DSM') && terrain.attribution.includes('Copernicus') && terrain.lumaStd > 8
      : terrain.notice.length > 0),
    { hillshade: hasHillshade ? HILLSHADE : null, ...terrain },
  );
  await page.getByTestId('mode-street').click();
  await idle(page);
  const back = await state();
  check('M-8', 'back to street mode: same camera, overlay and selection; terrain hidden', same(before, back) && back.street === 'visible' && back.terrain !== 'visible', back);
  await page.close();
}

// 6. Every drawn label character is in the packaged font (no system-font fallback)
{
  const missing = new Set();
  for (const t of rendered) for (const ch of t ?? '') if (!CMAP.has(ch.codePointAt(0)) && !/\s/.test(ch)) missing.add(ch + ' U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
  check('F-1', 'every character of every drawn label is covered by the packaged Noto Sans Arabic file', missing.size === 0, `${rendered.size} distinct labels; missing: ${[...missing].join(', ') || 'none'}`);
}

// 7. Air gap
const fonts = local.filter((p) => p.startsWith('/fonts/'));
check('A-1', 'air-gapped run: zero requests outside the harness', external.length === 0, { external: external.length, sample: external.slice(0, 5), localRequests: local.length, fontRequests: [...new Set(fonts)] });
const relevantErrors = consoleErrors.filter((e) => !/favicon/.test(e));
check('A-2', 'no console or page errors', relevantErrors.length === 0, relevantErrors.slice(0, 5));

await browser.close();
stop();
const summary = {
  passed: checks.filter((c) => c.result === 'PASS').length,
  failed: checks.filter((c) => c.result === 'FAIL').length,
  knownDefects: checks.filter((c) => c.result === 'KNOWN-DEFECT').map((c) => c.id),
  changed: checks.filter((c) => c.result === 'CHANGED').map((c) => c.id),
};
writeFileSync(
  OUT + 'results.json',
  JSON.stringify({ ranAt: new Date().toISOString(), browser: 'Microsoft Edge (headless, playwright-core)', harness: BASE, hillshade: hasHillshade ? HILLSHADE : null, summary, external: external.length, checks }, null, 2),
);
console.log(`\n${summary.passed} passed, ${summary.failed} failed, known defects: ${summary.knownDefects.join(', ') || 'none'}; external requests: ${external.length}`);
process.exit(summary.failed ? 1 : 0);
