// Basemap rendering in the real application (owner approval of 3 Nov 2026: "the map is lagging"). At four screen sizes it
// opens «مساحة التمركز» and
//   - measures animation-frame times while panning (mouse drags) and zooming (wheel) at the first view and at the working
//     zooms of site and polygon editing (four and six steps closer);
//   - checks, at three zoom levels, that the installed SVG basemap is drawn where an independent Web-Mercator placement of
//     the same file puts it (best pixel offset between the two pictures, everything else on the page hidden);
//   - records every registered boundary and marker position, so two builds can be compared.
// Read-only: one sign-in, then only looking — no request, draft or setting is saved. Headless Edge, no internet.
// Usage: LABEL=after node tests/acceptance/map-basemap.mjs        (SIZES=1366x768,... to narrow; LABEL=before was the
//        previous build; RECHECK=1 re-scores saved pictures). Evidence: docs/evidence/map-basemap/<LABEL>/; with before/
//        and after/ present, compare.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const LABEL = process.env.LABEL ?? 'after';
const ROOT = fileURLToPath(new URL('../../docs/evidence/map-basemap/', import.meta.url));
const OUT = ROOT + LABEL + '/';
mkdirSync(OUT, { recursive: true });
const SIZES = (process.env.SIZES ?? '1920x1080,1366x768,768x1024,390x844').split(',').map((s) => s.split('x').map(Number));
const STEPS = [0, 2, 4, 6]; // keyboard zoom steps above the first view; the last two are the zooms of site and polygon editing
// frame budget after the fix (checked only for LABEL=after): no frame over 50 ms, p95 within 25 ms
const LIMIT = { over50: 0, p95: 25 };

const results = [];
const check = (size, id, title, ok, detail) => {
  results.push({ size, id, title, result: ok ? 'PASS' : 'FAIL', detail });
  console.log(ok ? 'PASS' : 'FAIL', size, id, title, '—', typeof detail === 'string' ? detail : JSON.stringify(detail));
};

const ONLY_BASEMAP = `body *{visibility:hidden!important}
.map,.leaflet-background-pane,.leaflet-background-pane *,#bm-ref,#bm-ref *{visibility:visible!important}`;

const browser = await launch();
const ctx = await newContext(browser);
const page = await ctx.newPage();
watch(page, 't.requester');
const cdp = await ctx.newCDPSession(page);
await cdp.send('Performance.enable');
const cmp = await ctx.newPage(); // image comparison runs here, on decoded screenshots
await cmp.goto('about:blank');

/** Best integer offset (|dx|,|dy| ≤ max) between two same-size screenshots: mean absolute luma difference. */
async function compare(a, b, max = 4) {
  return cmp.evaluate(
    async ({ a, b, max }) => {
      const luma = async (b64) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
        c.drawImage(bmp, 0, 0);
        const d = c.getImageData(0, 0, bmp.width, bmp.height).data;
        const l = new Float32Array(bmp.width * bmp.height);
        const rgb = [0, 0, 0];
        for (let i = 0; i < l.length; i++) {
          l[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
          for (let k = 0; k < 3; k++) rgb[k] += d[4 * i + k];
        }
        let mean = 0;
        for (let i = 0; i < l.length; i++) mean += l[i];
        mean /= l.length;
        let v = 0;
        for (let i = 0; i < l.length; i++) v += (l[i] - mean) ** 2;
        return { l, w: bmp.width, h: bmp.height, rgb: rgb.map((x) => Math.round(x / l.length)), texture: +Math.sqrt(v / l.length).toFixed(1) };
      };
      const A = await luma(a);
      const B = await luma(b);
      const w = Math.min(A.w, B.w);
      const h = Math.min(A.h, B.h);
      const m = max + 2;
      const mae = (dx, dy) => {
        let s = 0;
        let n = 0;
        for (let y = m; y < h - m; y += 2)
          for (let x = m; x < w - m; x += 2) {
            s += Math.abs(A.l[y * A.w + x] - B.l[(y + dy) * B.w + x + dx]);
            n++;
          }
        return s / n;
      };
      let best = { dx: 0, dy: 0, mae: Infinity };
      for (let dy = -max; dy <= max; dy++)
        for (let dx = -max; dx <= max; dx++) {
          const e = mae(dx, dy);
          if (e < best.mae - 1e-9) best = { dx, dy, mae: e };
        }
      return { dx: best.dx, dy: best.dy, maeBest: +best.mae.toFixed(2), maeAt0: +mae(0, 0).toFixed(2), texture: B.texture, refTexture: A.texture, rgb: B.rgb, refRgb: A.rgb };
    },
    { a: a.toString('base64'), b: b.toString('base64'), max },
  );
}

/**
 * B1: the application drew the file's content — the same mean colour as the independent rendering (a close view can be
 * one colour: a road or a field filling the map). B2: where the view has texture, the best offset is at most 1 px; a
 * one-colour view has no offset to measure.
 */
function pictureChecks(size, step, zoom, align, ov) {
  const drawn = align.rgb.every((v, k) => Math.abs(v - align.refRgb[k]) <= 3) && align.refRgb.some((v) => v < 250);
  check(size, 'B1-' + step, 'الخلفية مرسومة بمحتوى الملف نفسه عند التكبير ' + zoom, drawn, `اللون الوسيط ${align.rgb.join(',')} مقابل ${align.refRgb.join(',')} · تباين ${align.texture}`);
  const textured = align.refTexture > 4;
  check(
    size,
    'B2-' + step,
    'الخلفية في موضعها الجغرافي (مقارنة بوضع مستقل للملف نفسه) عند التكبير ' + zoom,
    textured ? Math.abs(align.dx) <= 1 && Math.abs(align.dy) <= 1 : drawn,
    (textured ? `أفضل إزاحة (${align.dx},${align.dy}) بكسل · فرق ${align.maeAt0} عند (0,0)` : `منظر بلون واحد (تباين المرجع ${align.refTexture}): لا إزاحة تُقاس، اللون مطابق`) +
      ` · ${ov.boundaries.length} حدود · ${ov.markers.length} علامات`,
  );
}

const view = async () => (await page.getAttribute('.map', 'data-view')).split(',').map(Number);

/** The basemap is fully drawn and the map's view attribute has caught up (the map's tab in front: a background tab
 *  gets one animation frame per second). */
async function settle() {
  await page.bringToFront();
  await page.waitForFunction(
    () => {
      const p = document.querySelector('.leaflet-background-pane');
      if (!p || !p.children.length) return false;
      for (const i of p.querySelectorAll('img')) if (!i.complete) return false;
      return !p.querySelector('.leaflet-tile:not(.leaflet-tile-loaded)');
    },
    null,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1000);
}

const background = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.leaflet-background-pane');
    const img = pane?.querySelector('img.leaflet-image-layer');
    const tagged = pane?.querySelector('[data-background]');
    const first = pane?.firstElementChild;
    return {
      renderer: img ? 'image-overlay' : pane?.querySelector('.leaflet-tile') ? 'tiles' : 'none',
      tiles: pane?.querySelectorAll('.leaflet-tile').length ?? 0,
      id: tagged?.getAttribute('data-background') ?? img?.getAttribute('src')?.match(/packages\/([^/]+)\/content/)?.[1] ?? null,
      opacity: first ? getComputedStyle(first).opacity : '1',
    };
  });

/** Registered boundaries and marker heads, relative to the map. */
const overlays = () =>
  page.evaluate(() => {
    const m = document.querySelector('.map').getBoundingClientRect();
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return [b.left - m.left, b.top - m.top, b.width, b.height].map((v) => Math.round(v * 100) / 100);
    };
    return {
      boundaries: [...document.querySelectorAll('.map path[data-site]')].map((p) => ({ site: p.getAttribute('data-site'), r: r(p) })),
      markers: [...document.querySelectorAll('.map .pin-wrap[data-site] .pin-head')].map((p) => ({ site: p.closest('.pin-wrap').getAttribute('data-site'), r: r(p) })),
    };
  });

/**
 * The basemap as drawn by the application, and the same package file placed independently: the browser's own SVG
 * renderer draws the file with its viewBox cropped to the map's window — the Web-Mercator pixel positions of the coverage
 * corners at the map's current zoom and centre — into an <img> the size of the map. Unlike one image stretched over the
 * whole coverage, this works at every zoom.
 */
async function pictures(pkg, file) {
  if (process.env.NUDGE) {
    // diagnostic: one keyboard pan, so the reported centre is computed from the map pane, not cached
    await page.locator('.map').focus();
    await page.keyboard.press('ArrowRight');
    await settle();
  }
  const [z, lat, lng] = await view();
  await page.evaluate((css) => {
    const s = document.createElement('style');
    s.id = 'bm-only';
    s.textContent = css;
    document.head.append(s);
  }, ONLY_BASEMAP);
  const actual = await page.locator('.map').screenshot();
  await page.evaluate(
    async ({ pkg, z, lat, lng }) => {
      const map = document.querySelector('.map');
      const px = (la, ln) => {
        const s = 256 * 2 ** z;
        const sin = Math.sin((la * Math.PI) / 180);
        return [((ln + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
      };
      const c = px(lat, lng);
      const nw = px(pkg.coverage.maxLat, pkg.coverage.minLng);
      const se = px(pkg.coverage.minLat, pkg.coverage.maxLng);
      const W = map.clientWidth;
      const H = map.clientHeight;
      // the map's pixel window in the file's own units
      window.__svgText ??= await (await fetch(pkg.content)).text();
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(window.__svgText);
      const kx = +vb[1] / (se[0] - nw[0]);
      const ky = +vb[2] / (se[1] - nw[1]);
      const x0 = (c[0] - W / 2 - nw[0]) * kx;
      const y0 = (c[1] - H / 2 - nw[1]) * ky;
      const cropped = window.__svgText
        .replace(/viewBox="[^"]*"/, `viewBox="${x0} ${y0} ${W * kx} ${H * ky}"`)
        .replace('width="100%" height="100%"', `width="${vb[1]}" height="${vb[2]}"`);
      const ref = document.createElement('div');
      ref.id = 'bm-ref';
      ref.style.cssText = 'position:absolute;inset:0;overflow:hidden;z-index:100000;background:transparent';
      const img = new Image();
      if (pkg.full) {
        // diagnostic (REF=full): the whole file stretched between the corners, as L.imageOverlay draws it
        const ox = W / 2 - c[0];
        const oy = H / 2 - c[1];
        img.style.cssText = `position:absolute;left:${nw[0] + ox}px;top:${nw[1] + oy}px;width:${se[0] - nw[0]}px;height:${se[1] - nw[1]}px;opacity:${pkg.opacity};max-width:none!important;max-height:none!important`;
        img.src = pkg.content;
      } else {
        img.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;opacity:${pkg.opacity};max-width:none!important;max-height:none!important`;
        img.src = URL.createObjectURL(new Blob([cropped], { type: 'image/svg+xml' }));
      }
      ref.append(img);
      document.querySelector('.leaflet-background-pane').style.setProperty('visibility', 'hidden', 'important');
      map.append(ref);
      await img.decode();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    { pkg, z, lat, lng },
  );
  await page.waitForTimeout(400);
  const reference = await page.locator('.map').screenshot();
  await page.evaluate(() => {
    document.getElementById('bm-ref')?.remove();
    document.getElementById('bm-only')?.remove();
    document.querySelector('.leaflet-background-pane').style.removeProperty('visibility');
  });
  writeFileSync(OUT + file + '-basemap.png', actual);
  writeFileSync(OUT + file + '-reference.png', reference);
  await page.locator('.map').screenshot({ path: OUT + file + '-map.png' });
  // the map's own box, and Leaflet's idea of its centre (the pixel of the centre's tile point in the map pane)
  const dims = await page.evaluate(() => {
    const m = document.querySelector('.map');
    const r = m.getBoundingClientRect();
    const pane = document.querySelector('.map .leaflet-map-pane');
    return { client: [m.clientWidth, m.clientHeight], box: [Math.round(r.width), Math.round(r.height)], pane: pane?.style.transform ?? '' };
  });
  return { actual, reference, view: [z, lat, lng], dims };
}

/**
 * A visible point whose topmost element is the map itself (no marker, boundary, control or panel); else, when a boundary
 * fills the view at close zoom, a point on the boundary (a drag from it pans the map and Leaflet drops the click).
 */
const emptyPoint = () =>
  page.evaluate(() => {
    const m = document.querySelector('.map').getBoundingClientRect();
    const top = Math.max(m.top, 0);
    const bottom = Math.min(m.bottom, innerHeight);
    const empty = (el) => el && (el.classList.contains('leaflet-container') || el.classList.contains('leaflet-pane') || el.tagName === 'svg' || el.closest('.leaflet-background-pane'));
    const boundary = (el) => el && el.matches('.map path[data-site]');
    for (const ok of [empty, boundary])
      for (let fy = 0.5; fy > 0.15; fy -= 0.05)
        for (const fx of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
          for (const sy of [1, -1]) {
            const x = m.left + m.width * fx;
            const y = top + (bottom - top) * (0.5 + sy * (0.5 - fy));
            if (ok(document.elementFromPoint(x, y))) return { x, y, w: m.width, h: bottom - top, on: ok === empty ? 'map' : 'boundary' };
          }
        }
    return null;
  });

/** Frame times while panning four ways with the mouse and zooming in and out twice with the wheel. */
async function frames() {
  await page.bringToFront();
  const p = await emptyPoint();
  if (!p) throw new Error('no empty map point');
  await page.evaluate(() => {
    window.__fr = [];
    window.__frOn = true;
    let last = performance.now();
    const t = (n) => {
      window.__fr.push(n - last);
      last = n;
      if (window.__frOn) requestAnimationFrame(t);
    };
    requestAnimationFrame(t);
  });
  const d = Math.round(Math.min(300, p.w / 3, p.h / 3));
  const drag = async (dx, dy) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let i = 1; i <= 24; i++) {
      await page.mouse.move(p.x + (dx * i) / 24, p.y + (dy * i) / 24);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
  };
  // main-thread busy time (CDP) and long tasks over the same interaction
  await page.evaluate(() => {
    window.__lt = [];
    window.__lto = new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration)));
    window.__lto.observe({ type: 'longtask' });
  });
  const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value * 1000;
  const b0 = await busy();
  const t0 = Date.now();
  await drag(d, 0);
  await drag(-d, 0);
  await drag(0, d);
  await drag(0, -d);
  for (const w of [-120, 120, -120, 120]) {
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, w);
    await page.waitForTimeout(1000);
  }
  const f = await page.evaluate(() => {
    window.__frOn = false;
    window.__lto.disconnect();
    return { fr: window.__fr.slice(1), lt: window.__lt };
  });
  const mainMs = Math.round((await busy()) - b0);
  const wall = Date.now() - t0;
  const s = [...f.fr].sort((a, b) => a - b);
  const q = (x) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * x))] * 10) / 10;
  return {
    frames: s.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: Math.round(s[s.length - 1]),
    over33: s.filter((x) => x > 33.4).length,
    over50: s.filter((x) => x > 50).length,
    longTasks: f.lt.length,
    longTaskMs: Math.round(f.lt.reduce((a, b) => a + b, 0)),
    mainThreadMs: mainMs,
    mainThreadShare: +(mainMs / wall).toFixed(3),
    panPx: d,
    startedOn: p.on,
  };
}

const keyZoom = async (n) => {
  await page.locator('.map').focus();
  for (let i = 0; i < Math.abs(n); i++) {
    await page.keyboard.press(n > 0 ? 'NumpadAdd' : 'NumpadSubtract');
    await page.waitForTimeout(450);
  }
  await settle();
};

/** Keyboard pans (80 px each, no inertia) until a site with a registered boundary (the given one, else the first) is near
 *  the centre. */
async function centreOnSite(want) {
  const off = await page.evaluate((want) => {
    const m = document.querySelector('.map').getBoundingClientRect();
    for (const pin of document.querySelectorAll('.map .pin-wrap[data-site]')) {
      const site = pin.getAttribute('data-site');
      if (want ? site !== want : !document.querySelector(`.map path[data-site="${site}"]`)) continue;
      const b = pin.querySelector('.pin-head').getBoundingClientRect();
      return { site, dx: b.left + b.width / 2 - (m.left + m.width / 2), dy: b.top + b.height / 2 - (m.top + m.height / 2) };
    }
    return null;
  }, want ?? null);
  if (!off) return want ?? null;
  await page.locator('.map').focus();
  const press = async (key, n) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(350);
    }
  };
  await press(off.dx > 0 ? 'ArrowRight' : 'ArrowLeft', Math.round(Math.abs(off.dx) / 80));
  await press(off.dy > 0 ? 'ArrowDown' : 'ArrowUp', Math.round(Math.abs(off.dy) / 80));
  await settle();
  return off.site;
}

// RECHECK=1: score the saved pictures of LABEL again with the current picture checks (no sign-in, no measuring) — for a
// build that is no longer deployed; frame times and positions are kept as recorded.
if (process.env.RECHECK) {
  const saved = JSON.parse(readFileSync(OUT + 'results.json', 'utf8'));
  for (const run of saved.runs)
    for (const v of run.views) {
      const file = OUT + `${run.size}-z${v.step}`;
      v.align = await compare(readFileSync(file + '-reference.png'), readFileSync(file + '-basemap.png'));
      pictureChecks(run.size, v.step, v.view[0], v.align, v.overlays);
    }
  saved.results = [...saved.results.filter((r) => !/^B[12]-/.test(r.id)), ...results];
  saved.rechecked = new Date().toISOString();
  writeFileSync(OUT + 'results.json', JSON.stringify(saved, null, 1));
}

const runs = [];
if (!process.env.RECHECK) try {
  await signInManual(page, 't.requester');
  const packages = await page.evaluate(async () => (await fetch('/api/v1/map/packages', { headers: { 'X-Requested-With': 'mover' } })).json());
  for (const [w, h] of SIZES) {
    const size = w + 'x' + h;
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + '/#stationing');
    await page.reload();
    await page.waitForSelector('.pin-wrap', { timeout: 30000 });
    await settle();
    const bg = await background();
    const pkg = packages.find((x) => x.id === bg.id);
    check(size, 'B0', 'خلفية مثبتة معروضة', !!pkg, { renderer: bg.renderer, tiles: bg.tiles, package: pkg?.name, format: pkg?.format });
    if (!pkg) continue;
    const content = pkg.contentUrl?.startsWith('/') ? pkg.contentUrl : `/api/v1/map/packages/${pkg.id}/content`;
    const run = { size, renderer: bg.renderer, package: { id: pkg.id, name: pkg.name, format: pkg.format }, views: [], frames: {} };
    run.site = await centreOnSite();
    // the same path every time: first view, centred on the site, then two keyboard zoom steps at a time, re-centred
    const closer = async (n) => {
      await keyZoom(n);
      await centreOnSite(run.site);
    };
    let at = 0;
    for (const step of STEPS) {
      if (step > at) await closer(step - at);
      at = step;
      const file = `${size}-z${step}`;
      const pic = await pictures({ coverage: pkg.coverage, content, opacity: bg.opacity, full: process.env.REF === 'full' }, file);
      const align = await compare(pic.reference, pic.actual);
      const ov = await overlays();
      run.views.push({ step, view: pic.view, dims: pic.dims, align, overlays: ov });
      pictureChecks(size, step, pic.view[0], align, ov);
    }
    // frames at each level, every run from a fresh load along the same path (panning and wheel zoom move the view)
    for (const step of process.env.FRAMES === '0' ? [] : STEPS) {
      await page.reload();
      await page.waitForSelector('.pin-wrap', { timeout: 30000 });
      await settle();
      await centreOnSite(run.site);
      for (let s = 0; s < step; s += 2) await closer(Math.min(2, step - s));
      const f = { zoom: (await view())[0], ...(await frames()) };
      run.frames['z+' + step] = f;
      const ok = f.over50 <= LIMIT.over50 && f.p95 <= LIMIT.p95;
      if (LABEL === 'after') check(size, 'B3-' + step, 'سلاسة التحريك والتكبير عند التكبير ' + f.zoom, ok, f);
      else console.log('INFO', size, 'z+' + step, JSON.stringify(f));
    }
    runs.push(run);
  }
} finally {
  check('all', 'B4', 'لا طلبات خارجية ولا أخطاء في وحدة التحكم', external.length === 0 && consoleErrors.length === 0, { external: external.length, consoleErrors });
  writeFileSync(OUT + 'results.json', JSON.stringify({ label: LABEL, base: BASE, at: new Date().toISOString(), results, runs }, null, 1));
}

// before/after comparison: same views, same overlay positions, same basemap picture
if (existsSync(ROOT + 'before/results.json') && existsSync(ROOT + 'after/results.json')) {
  const B = JSON.parse(readFileSync(ROOT + 'before/results.json', 'utf8'));
  const A = JSON.parse(readFileSync(ROOT + 'after/results.json', 'utf8'));
  const rows = [];
  for (const a of A.runs) {
    const b = B.runs.find((x) => x.size === a.size);
    if (!b) continue;
    for (const va of a.views) {
      const vb = b.views.find((x) => x.step === va.step);
      if (!vb) continue;
      const delta = (xs, ys) => (xs.length !== ys.length ? Infinity : Math.max(0, ...xs.map((x, i) => Math.max(...x.r.map((v, k) => Math.abs(v - ys[i].r[k]))))));
      const file = `${a.size}-z${va.step}-basemap.png`;
      const pic = await compare(readFileSync(ROOT + 'before/' + file), readFileSync(ROOT + 'after/' + file));
      rows.push({
        size: a.size,
        step: va.step,
        sameView: JSON.stringify(va.view) === JSON.stringify(vb.view),
        view: va.view,
        boundaries: va.overlays.boundaries.length,
        markers: va.overlays.markers.length,
        boundaryDeltaPx: delta(va.overlays.boundaries, vb.overlays.boundaries),
        markerDeltaPx: delta(va.overlays.markers, vb.overlays.markers),
        basemapBeforeVsAfter: pic,
      });
    }
  }
  const frames = A.runs.map((a) => ({ size: a.size, before: B.runs.find((x) => x.size === a.size)?.frames, after: a.frames }));
  writeFileSync(ROOT + 'compare.json', JSON.stringify({ at: new Date().toISOString(), rows, frames }, null, 1));
  console.table(rows.map((r) => ({ size: r.size, step: r.step, sameView: r.sameView, boundaryDeltaPx: r.boundaryDeltaPx, markerDeltaPx: r.markerDeltaPx, offset: r.basemapBeforeVsAfter.dx + ',' + r.basemapBeforeVsAfter.dy, mae: r.basemapBeforeVsAfter.maeAt0 })));
}
await browser.close();
const failed = results.filter((r) => r.result === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} PASS`);
process.exit(LABEL === 'after' && failed ? 1 : 0);
