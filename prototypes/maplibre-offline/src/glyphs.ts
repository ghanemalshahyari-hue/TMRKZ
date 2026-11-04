import { Map as MlMap, getRTLTextPluginStatus, getVersion, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LABEL_FONT } from '../../../frontend/src/components/map/maplibre/offlineStyle';
import { ensureOfflineMapSetup } from '../../../frontend/src/components/map/maplibre/setup';
import { drawGlyphsLeftToRight } from '../../../frontend/src/components/map/maplibre/glyphDirection';
import { SAMPLES, firstStrongDirection, forcedLtr, forcedLtrIsolated, hasArabic, isolated, swapBrackets } from './samples';

/**
 * Objective check of label shaping and order. Every sample is drawn by MapLibre (its built-in shaping and bidi, glyphs
 * from the local font) and, as references, by the browser's own text engine on a 2D canvas in the same font file:
 * correctly, with isolated letters, and forced left to right. Each picture is cropped to its ink, resampled to one size
 * and compared by correlation. A correct MapLibre label must match the correct reference closely and clearly better than
 * either broken one; three deliberately broken candidates must fail the same test.
 */

const SIZE = 32;
const ROW = 84;
const W = 1100;
const NW = 240;
const NH = 48;

type Candidate = { id: string; kind: string; text: string; source: 'maplibre' | 'canvas'; draw: string; broken: boolean };

const candidates: Candidate[] = [
  ...SAMPLES.map((s) => ({ ...s, source: 'maplibre' as const, draw: s.text, broken: false })),
  { id: 'broken-isolated', kind: 'broken', text: SAMPLES[0].text, source: 'maplibre', draw: isolated(SAMPLES[0].text), broken: true },
  { id: 'broken-reversed', kind: 'broken', text: SAMPLES[2].text, source: 'maplibre', draw: forcedLtr(SAMPLES[2].text), broken: true },
  { id: 'broken-no-shaping-no-bidi', kind: 'broken', text: SAMPLES[1].text, source: 'canvas', draw: forcedLtrIsolated(SAMPLES[1].text), broken: true },
];

type Gray = { w: number; h: number; d: Float32Array };

function darkness(img: ImageData): Gray {
  const d = new Float32Array(img.width * img.height);
  for (let i = 0; i < d.length; i++) {
    const l = 0.299 * img.data[4 * i] + 0.587 * img.data[4 * i + 1] + 0.114 * img.data[4 * i + 2];
    d[i] = 1 - l / 255;
  }
  return { w: img.width, h: img.height, d };
}

function inkBox(g: Gray, thr = 0.3) {
  let x0 = g.w, y0 = g.h, x1 = -1, y1 = -1;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (g.d[y * g.w + x] > thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Ink box resampled to NW×NH (4×4 supersampling), lightly blurred. */
function normalize(g: Gray) {
  const b = inkBox(g);
  if (!b) return null;
  const out = new Float32Array(NW * NH);
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  for (let y = 0; y < NH; y++) {
    for (let x = 0; x < NW; x++) {
      let s = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = Math.min(g.w - 1, Math.floor(b.x0 + ((x + (sx + 0.5) / 4) / NW) * bw));
          const py = Math.min(g.h - 1, Math.floor(b.y0 + ((y + (sy + 0.5) / 4) / NH) * bh));
          s += g.d[py * g.w + px];
        }
      }
      out[y * NW + x] = s / 16;
    }
  }
  const bl = new Float32Array(out.length);
  for (let y = 0; y < NH; y++) {
    for (let x = 0; x < NW; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < NW && yy < NH) {
            s += out[yy * NW + xx];
            n++;
          }
        }
      }
      bl[y * NW + x] = s / n;
    }
  }
  return { v: bl, aspect: bw / bh, box: b };
}

function corr(a: Float32Array, b: Float32Array) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db || 1);
}

function canvasText(text: string, dir: 'rtl' | 'ltr'): Gray {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = ROW;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, ROW);
  ctx.fillStyle = '#000';
  ctx.font = `${SIZE}px TmrkzRef`;
  ctx.direction = dir;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, ROW / 2);
  return darkness(ctx.getImageData(0, 0, W, ROW));
}

export const THRESHOLDS = { match: 0.8, margin: 0.08, aspect: 0.15 };

/** `glyphFix` false leaves MapLibre's glyph canvases at their inherited direction: the control run for finding G-8a. */
export async function runGlyphCheck(host: HTMLElement, glyphFix = true) {
  const face = new FontFace('TmrkzRef', 'url(/fonts/NotoSansArabic.ttf)');
  await face.load();
  document.fonts.add(face);
  ensureOfflineMapSetup();
  host.style.cssText = `width:${W}px;height:${ROW * candidates.length}px;position:relative`;
  const map = new MlMap({
    container: host,
    style: {
      version: 8,
      'font-faces': { [LABEL_FONT]: [{ url: new URL('/fonts/NotoSansArabic.ttf', document.baseURI).href }] },
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
        {
          id: 't',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': ['get', 't'], 'text-font': [LABEL_FONT], 'text-size': SIZE, 'text-allow-overlap': true, 'text-ignore-placement': true, 'text-max-width': 100 },
          paint: { 'text-color': '#000000' },
        },
      ],
    },
    center: [0, 0],
    zoom: 3,
    attributionControl: false,
    interactive: false,
    fadeDuration: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  if (glyphFix) drawGlyphsLeftToRight(map);
  await map.once('load');
  const features = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.source === 'maplibre')
    .map(({ c, i }) => {
      const ll = map.unproject([W / 2, i * ROW + ROW / 2]);
      return { type: 'Feature' as const, properties: { t: c.draw }, geometry: { type: 'Point' as const, coordinates: [ll.lng, ll.lat] } };
    });
  (map.getSource('s') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  await new Promise<void>((r) => map.once('idle', () => r()));
  await new Promise((r) => setTimeout(r, 300));
  map.triggerRepaint();
  await new Promise<void>((r) => map.once('idle', () => r()));

  const gl = map.getCanvas();
  const snap = document.createElement('canvas');
  snap.width = gl.width;
  snap.height = gl.height;
  const sctx = snap.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(gl, 0, 0);

  const results = candidates.map((c, i) => {
    const dir = firstStrongDirection(c.text);
    const cand = c.source === 'maplibre' ? darkness(sctx.getImageData(0, i * ROW, W, ROW)) : canvasText(c.draw, 'ltr');
    const n = normalize(cand);
    const ref = normalize(canvasText(c.text, dir))!;
    const iso = normalize(canvasText(isolated(c.text), dir))!;
    const ltr = normalize(canvasText(forcedLtrIsolated(c.text), 'ltr'))!;
    const rev = normalize(canvasText(forcedLtr(c.text), 'ltr'))!;
    if (!n) return { ...c, ok: false, reason: 'nothing drawn' };
    const match = corr(n.v, ref.v);
    // a bracket sample is told apart from its double-mirrored picture; the other Arabic samples from isolated letters and wrong order
    const brokenRefs: Record<string, number> | null =
      c.kind === 'mirroring'
        ? { doubleMirrored: corr(n.v, normalize(canvasText(swapBrackets(c.text), dir))!.v) }
        : hasArabic(c.text)
          ? { isolated: corr(n.v, iso.v), ltrIsolated: corr(n.v, ltr.v), reversed: corr(n.v, rev.v) }
          : null;
    const bestBroken = brokenRefs ? Math.max(...Object.values(brokenRefs)) : null;
    const aspect = Math.abs(Math.log(n.aspect / ref.aspect));
    const ok = match >= THRESHOLDS.match && (bestBroken === null || match - bestBroken >= THRESHOLDS.margin) && aspect <= THRESHOLDS.aspect;
    return {
      id: c.id,
      kind: c.kind,
      text: c.text,
      drawn: c.draw,
      source: c.source,
      broken: c.broken,
      direction: dir,
      match: +match.toFixed(3),
      brokenRefs: brokenRefs && Object.fromEntries(Object.entries(brokenRefs).map(([k, v]) => [k, +v.toFixed(3)])),
      margin: bestBroken === null ? null : +(match - bestBroken).toFixed(3),
      aspectDiff: +aspect.toFixed(3),
      ok,
    };
  });

  // evidence picture: each candidate (left) beside the browser's correct rendering of the same text (right)
  const strip = document.createElement('canvas');
  strip.width = W * 2;
  strip.height = ROW * candidates.length;
  const st = strip.getContext('2d')!;
  st.drawImage(snap, 0, 0);
  const paint = (g: Gray, x: number, y: number) => {
    const img = st.createImageData(W, ROW);
    for (let k = 0; k < g.d.length; k++) {
      const v = Math.round(255 * (1 - g.d[k]));
      img.data.set([v, v, v, 255], 4 * k);
    }
    st.putImageData(img, x, y);
  };
  candidates.forEach((c, i) => {
    if (c.source === 'canvas') paint(canvasText(c.draw, 'ltr'), 0, i * ROW);
    paint(canvasText(c.text, firstStrongDirection(c.text)), W, i * ROW);
  });
  st.fillStyle = '#d0d0d0';
  st.fillRect(W - 1, 0, 2, strip.height);
  strip.id = 'glyph-strip';
  document.body.appendChild(strip);
  // no right-to-left plugin URL is set anywhere: the deprecated status reads 'unavailable', or 'requested' once a tile
  // held right-to-left text; nothing is ever loaded
  return {
    thresholds: THRESHOLDS,
    documentDir: document.documentElement.dir,
    bodyDir: document.body.dir || null,
    glyphFix,
    strip: strip.toDataURL('image/png'),
    results,
    version: getVersion(),
    rtlPluginStatus: getRTLTextPluginStatus(),
  };
}
