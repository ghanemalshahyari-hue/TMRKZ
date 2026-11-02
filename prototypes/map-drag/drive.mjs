// Drives both prototypes in the locally installed Microsoft Edge (playwright-core, no browser download).
// For each (prototype, facility count[, mode]) it: opens the page, performs a scripted drag that crosses the
// allowed-range boundary and an occupied zone, reads the REAL metrics the page measured (window.__proto.metrics),
// and saves screenshots + (for the demo scenes) a video that is converted to GIF with the local ffmpeg.
//
// Usage:  node drive.mjs            (headed by default so the GPU is real for MapLibre and you can watch)
//         HEADLESS=1 node drive.mjs (CI-style)   BASE=http://127.0.0.1:5191 (default)
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'evidence');
const FR = join(OUT, '_frames');
const BASE = process.env.BASE ?? 'http://127.0.0.1:5191';
const HEADLESS = !!process.env.HEADLESS;
mkdirSync(OUT, { recursive: true });

// scenes: A at 10/100/1000 (optimised) + A naive at 100 (the current pattern) + B at 10/100/1000
const SCENES = [
  { p: 'a', n: 10, mode: 'opt', video: false },
  { p: 'a', n: 100, mode: 'opt', video: true },
  { p: 'a', n: 1000, mode: 'opt', video: false },
  { p: 'a', n: 100, mode: 'naive', video: true },
  { p: 'b', n: 10, video: false },
  { p: 'b', n: 100, video: true },
  { p: 'b', n: 1000, video: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (s) => `${s.p}${s.p === 'a' ? '-' + (s.mode ?? 'opt') : ''}-n${s.n}`;

// the scripted gesture, in screen pixels from the grab point: out past the max-range boundary (SE),
// up across the NE occupied zone, then back inside.
function dragPath(sx, sy) {
  const path = [];
  const lerp = (a, b, t) => a + (b - a) * t;
  // phase 1: west toward the current premises — crosses the east occupied zone and into mid-range
  for (let i = 0; i <= 28; i++) path.push([lerp(sx, sx - 180, i / 28), lerp(sy, sy - 40, i / 28)]);
  // phase 2: east + down well past the max-range boundary (out of range; crosses the occupied zone again)
  for (let i = 1; i <= 30; i++) path.push([lerp(sx - 180, sx + 210, i / 30), lerp(sy - 40, sy + 120, i / 30)]);
  // phase 3: back inside
  for (let i = 1; i <= 26; i++) path.push([lerp(sx + 210, sx - 20, i / 26), lerp(sy + 120, sy - 10, i / 26)]);
  return path;
}

// A second, non-measured "cinematic" drag that screenshots each step; frames → GIF via system ffmpeg.
async function captureGif(page, pinSel, outGif) {
  const dir = join(FR, 'f');
  rmSync(FR, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const box = await page.locator(pinSel).boundingBox();
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  const path = dragPath(sx, sy);
  await page.mouse.move(sx, sy); await page.mouse.down();
  let n = 0;
  for (let i = 0; i < path.length; i += 2) {
    await page.mouse.move(path[i][0], path[i][1], { steps: 1 });
    await page.screenshot({ path: join(dir, String(n++).padStart(3, '0') + '.png'), clip: { x: 320, y: 60, width: 1120, height: 840 } });
  }
  await page.mouse.up();
  await page.screenshot({ path: join(dir, String(n++).padStart(3, '0') + '.png'), clip: { x: 320, y: 60, width: 1120, height: 840 } });
  try {
    const pal = join(FR, 'pal.png');
    execFileSync('ffmpeg', ['-y', '-framerate', '14', '-i', join(dir, '%03d.png'), '-vf', 'scale=720:-1:flags=lanczos,palettegen', pal], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-y', '-framerate', '14', '-i', join(dir, '%03d.png'), '-i', pal, '-lavfi', 'scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse', outGif], { stdio: 'ignore' });
  } catch (e) { console.warn('gif failed', e.message); }
}

async function run() {
  const browser = await chromium.launch({ channel: 'msedge', headless: HEADLESS });
  const external = [];
  const results = [];
  for (const s of SCENES) {
    const ctx = await browser.newContext({ locale: 'ar-AE', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    // enforce air-gap: fail loudly if the page tries to reach the public internet
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) {
        external.push(tag(s) + ' -> ' + u.href);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const page = await ctx.newPage();
    const url = `${BASE}/?p=${s.p}&n=${s.n}${s.p === 'a' ? '&mode=' + (s.mode ?? 'opt') : ''}`;
    await page.goto(url, { waitUntil: 'load' });

    // wait for the engine + the proposal marker, then let it settle a beat
    await page.waitForSelector(s.p === 'a' ? '.leaflet-container' : '.maplibregl-canvas', { timeout: 20000 });
    const pinSel = (s.p === 'a' ? '.pA-prop' : '.pB-prop') + ' .pin';
    await page.waitForSelector(pinSel, { timeout: 20000 });
    await sleep(800);
    await page.screenshot({ path: join(OUT, tag(s) + '-1-start.png') });

    // scripted drag: out past the boundary, sweep across an occupied zone, come back
    const box = await page.locator(pinSel).boundingBox();
    const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    const path = dragPath(sx, sy);
    let crossedOut = false, crossedOcc = false;
    for (const [x, y] of path) {
      await page.mouse.move(x, y, { steps: 1 });
      await sleep(9);
      const live = await page.evaluate(() => window.__proto.metrics.snapshot().live);
      if (!live.inRange) crossedOut = true;
      if (live.occupied) crossedOcc = true;
    }
    // hold on an occupied/out spot for the screenshot, then drop back inside
    await page.screenshot({ path: join(OUT, tag(s) + '-2-drag.png') });
    await page.mouse.up();
    await sleep(350);
    const snap = await page.evaluate(() => window.__proto.metrics.snapshot());
    await page.screenshot({ path: join(OUT, tag(s) + '-3-drop.png') });

    // a quick pan + zoom to confirm the camera is responsive and does not fight the drag
    await page.mouse.move(720, 450); await page.mouse.down(); await page.mouse.move(560, 360, { steps: 12 }); await page.mouse.up();
    await page.mouse.wheel(0, -240); await sleep(400);
    await page.screenshot({ path: join(OUT, tag(s) + '-4-panzoom.png') });

    results.push({ scene: tag(s), url, crossedOut, crossedOcc, ...snap });

    // cinematic GIF on a fresh page so the marker starts from its home position (perf NOT measured here)
    if (s.video) {
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector(pinSel, { timeout: 20000 });
      await sleep(700);
      await captureGif(page, pinSel, join(OUT, tag(s) + '.gif'));
    }
    await ctx.close();
    console.log('done', tag(s), JSON.stringify(results.at(-1).lastDrag));
  }
  await browser.close();
  try { rmSync(FR, { recursive: true, force: true }); } catch { /* ignore */ }

  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ base: BASE, when: new Date().toISOString(), external, results }, null, 2));
  // compact markdown table
  const row = (r) => `| ${r.scene} | ${r.lastDrag?.frames ?? '—'} | ${r.lastDrag?.meanMs ?? '—'} | ${r.lastDrag?.p95Ms ?? '—'} | ${r.lastDrag?.worstMs ?? '—'} | ${r.lastDrag?.fpsMean ?? '—'} | ${r.lastDrag?.janky ?? '—'} | ${r.lastDrag?.longTasks ?? '—'} | ${r.lastDrag?.heavyUpdates ?? '—'} | ${r.lastDrag?.serverValidations ?? '—'} | ${r.crossedOut ? '✓' : '—'}/${r.crossedOcc ? '✓' : '—'} |`;
  const md = [
    '# Measured drag performance (Edge, headed=' + (!HEADLESS) + ')',
    '',
    'Each row = one scripted drag crossing the allowed-range boundary and an occupied zone. Numbers are measured in the page (rAF frame intervals, PerformanceObserver long tasks), not estimated.',
    '',
    '| scene | frames | mean ms | p95 ms | worst ms | mean fps | janky>25ms | long tasks | state-updates during drag | server calls during drag | crossed out/occ |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(row),
    '',
    external.length ? '⚠ external requests attempted (air-gap breach): ' + external.length + '\n' + external.map((e) => '- ' + e).join('\n') : '✓ no external network requests — fully offline.',
  ].join('\n');
  writeFileSync(join(OUT, 'RESULTS.md'), md);
  console.log('\n' + md);
}
run().catch((e) => { console.error(e); process.exit(1); });
