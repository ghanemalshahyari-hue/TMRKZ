import L from '../../../../frontend/src/lib/leaflet';
import type { LatLng } from '../../../../frontend/src/lib/geo';

/**
 * The two offline map modes of §35–§37, drawn as canvas tiles from the local package's GeoJSON
 * (map-packages/regional-basemap-2026.10/basemap.geojson, ODbL, attribution kept). No network: the file is served with
 * the prototype.
 *
 * «الشوارع»: road classes in a clear hierarchy (motorway > trunk > primary > secondary > tertiary), casings, widths that
 *   grow with zoom, minor classes appearing only when zoomed in; water and land use as quiet tints. Road NAMES come
 *   from a separate offline extract (`data/road-names.json`, OpenStreetMap names from a local Protomaps PMTiles file,
 *   ODbL, NON-AUTHORITATIVE) drawn with the local Arabic font — no glyph server. Official names (Abu Dhabi NRN, FGIC
 *   NSDI) replace them once their licence is confirmed.
 * «طبيعة الأرض»: land cover in natural tints, hillshade and 10 m contours, major roads only for orientation. The
 *   repository has NO elevation data (open decision O-11); the relief drawn here comes from a GENERATED illustrative
 *   elevation field (`elevation`), consistent with the fictional terrain-class zones, and is labelled as such on screen.
 *
 * Switching mode swaps this one layer; every overlay (selection, proposal, deployment areas) lives in other panes and
 * is untouched (§37).
 */
export type Mode = 'streets' | 'terrain';
type Feature = { layer: string; cls: string; polys: Float64Array[][]; lines: Float64Array[]; x0: number; y0: number; x1: number; y1: number };

const merc = (lng: number, lat: number): [number, number] => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
};
const unmerc = (x: number, y: number): LatLng => ({ lng: x * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI });

function load(json: { features: { properties: { layer: string; class: string }; geometry: { type: string; coordinates: unknown } }[] }): Feature[] {
  const out: Feature[] = [];
  for (const f of json.features) {
    const g = f.geometry;
    const polys: Float64Array[][] = [];
    const lines: Float64Array[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const conv = (pts: number[][]) => {
      const a = new Float64Array(pts.length * 2);
      pts.forEach(([lng, lat], i) => {
        const [x, y] = merc(lng, lat);
        a[i * 2] = x;
        a[i * 2 + 1] = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      });
      return a;
    };
    if (g.type === 'Polygon') polys.push((g.coordinates as number[][][]).map(conv));
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates as number[][][][]) polys.push(p.map(conv));
    else if (g.type === 'LineString') lines.push(conv(g.coordinates as number[][]));
    else if (g.type === 'MultiLineString') for (const l of g.coordinates as number[][][]) lines.push(conv(l));
    else continue;
    out.push({ layer: f.properties.layer, cls: f.properties.class, polys, lines, x0, y0, x1, y1 });
  }
  return out;
}

const ROADS = ['tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
// [fill, casing, width at z12 (px), first zoom shown]
const ROAD_STYLE: Record<string, [string, string, number, number]> = {
  motorway: ['#f9c66b', '#d99a35', 3.2, 0],
  trunk: ['#fcd98f', '#d8ad55', 2.7, 0],
  primary: ['#ffffff', '#c9c2b4', 2.2, 0],
  secondary: ['#ffffff', '#d3cdc1', 1.6, 11.5],
  tertiary: ['#ffffff', '#dcd6cb', 1.1, 13],
};
const FILL: Record<Mode, (layer: string, cls: string) => string | null> = {
  streets: (layer, cls) => {
    if (layer === 'water') return '#a9d6f5';
    if (layer === 'park' || ['grass', 'wood', 'park', 'pitch', 'farmland', 'wetland'].includes(cls)) return '#d6ebc8';
    if (cls === 'sand') return '#f2ead3';
    if (['industrial', 'commercial', 'retail'].includes(cls)) return '#efe9ef';
    if (['school', 'university', 'college', 'hospital'].includes(cls)) return '#f5ecda';
    if (['residential', 'neighbourhood', 'suburb'].includes(cls)) return null;
    return '#eeebe4';
  },
  terrain: (layer, cls) => {
    if (layer === 'water') return '#9fc9de';
    if (cls === 'sand') return '#e8d9ae';
    if (['grass', 'park', 'pitch', 'farmland'].includes(cls) || layer === 'park') return '#c5d9a5';
    if (cls === 'wetland') return '#b9d3c0';
    if (cls === 'wood') return '#a8c78f';
    if (cls === 'rock') return '#cfc6b8';
    if (['industrial', 'commercial', 'retail', 'school', 'university', 'college', 'hospital', 'stadium', 'military', 'cemetery'].includes(cls)) return '#e1ddd2';
    return null;
  },
};

/** The GENERATED illustrative elevation field (metres): gentle base plus fictional hills. Not real terrain. */
export function elevation(hills: { c: LatLng; h: number; r: number }[], p: LatLng): number {
  let e = 6 + 4 * Math.sin(p.lat * 90) * Math.cos(p.lng * 70);
  const k = Math.cos((p.lat * Math.PI) / 180);
  for (const h of hills) {
    const dy = (p.lat - h.c.lat) * 111_320;
    const dx = (p.lng - h.c.lng) * 111_320 * k;
    e += h.h * Math.exp(-(dx * dx + dy * dy) / (h.r * h.r));
  }
  return e;
}

/** A named road from the offline name extract (tools/extract_road_names.py): OSM names, ODbL, non-authoritative. */
type Named = { cls: string; ar: string; en: string; pts: Float64Array; x0: number; y0: number; x1: number; y1: number };
// first zoom at which a class is labelled (major roads first, residential streets only close in)
const LABEL_ZOOM: Record<string, number> = { motorway: 12, trunk: 12, primary: 13, secondary: 14, tertiary: 15, motorway_link: 16, trunk_link: 16, primary_link: 16, secondary_link: 16, tertiary_link: 16, unclassified: 16, residential: 16, living_street: 17 };

function loadNames(json: { features: { d: string; ar: string; en: string; g: [number, number][] }[] }): Named[] {
  return json.features.map((f) => {
    const pts = new Float64Array(f.g.length * 2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    f.g.forEach(([lat, lng], i) => {
      const [x, y] = merc(lng, lat);
      pts[i * 2] = x;
      pts[i * 2 + 1] = y;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    });
    return { cls: f.d, ar: f.ar, en: f.en, pts, x0, y0, x1, y1 };
  });
}

export function vectorBasemap(url: string, hills: { c: LatLng; h: number; r: number }[], attribution: string, namesUrl?: string) {
  let features: Feature[] | null = null;
  let names: Named[] = [];
  let mode: Mode = 'streets';
  const ready = Promise.all([
    fetch(url)
      .then((r) => r.json())
      .then((j) => (features = load(j))),
    namesUrl
      ? fetch(namesUrl)
          .then((r) => r.json())
          .then((j) => (names = loadNames(j)))
      : null,
    // the local Arabic font must be ready before the first label is drawn on a canvas
    document.fonts?.load('600 12px Arabic').catch(() => null),
  ]);

  // one tile per task: a mode switch redraws every visible tile, and drawing them in one task blocked frames (~90 ms)
  const queue: (() => void)[] = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    queue.shift()?.();
    if (queue.length) channel.port2.postMessage(0);
  };
  const schedule = (job: () => void) => {
    queue.push(job);
    if (queue.length === 1) channel.port2.postMessage(0);
  };

  const Layer = L.GridLayer.extend({
    createTile(coords: L.Coords, done: (e: Error | undefined, t: HTMLElement) => void) {
      const tile = document.createElement('canvas');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      tile.width = tile.height = 256 * dpr;
      tile.style.width = tile.style.height = '256px';
      ready.then(() => schedule(() => {
        draw(tile, coords, dpr);
        done(undefined, tile);
      }));
      return tile;
    },
  });

  function draw(tile: HTMLCanvasElement, c: L.Coords, dpr: number) {
    const ctx = tile.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const scale = 256 * 2 ** c.z;
    const ox = c.x * 256;
    const oy = c.y * 256;
    const pad = 8 / scale;
    const tx0 = ox / scale - pad, ty0 = oy / scale - pad, tx1 = (ox + 256) / scale + pad, ty1 = (oy + 256) / scale + pad;
    const hit = (f: Feature) => f.x1 >= tx0 && f.x0 <= tx1 && f.y1 >= ty0 && f.y0 <= ty1;
    const path = (a: Float64Array, close: boolean) => {
      ctx.moveTo(a[0] * scale - ox, a[1] * scale - oy);
      for (let i = 2; i < a.length; i += 2) ctx.lineTo(a[i] * scale - ox, a[i + 1] * scale - oy);
      if (close) ctx.closePath();
    };
    ctx.fillStyle = mode === 'streets' ? '#f6f4ef' : '#efe8d8';
    ctx.fillRect(0, 0, 256, 256);
    const fs = features!.filter(hit);
    // land use / land cover, then water
    for (const pass of ['land', 'water']) {
      for (const f of fs) {
        if (!f.polys.length || (pass === 'water') !== (f.layer === 'water')) continue;
        const color = FILL[mode](f.layer, f.cls);
        if (!color) continue;
        ctx.beginPath();
        for (const p of f.polys) for (const r of p) path(r, true);
        ctx.fillStyle = color;
        ctx.fill('evenodd');
      }
    }
    if (mode === 'terrain') relief(ctx, c, scale, ox, oy);
    for (const f of fs) {
      if (f.layer !== 'waterway') continue;
      ctx.beginPath();
      for (const l of f.lines) path(l, false);
      ctx.strokeStyle = '#8fc3e4';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // roads: all casings first, then fills, minor classes under major ones
    const grow = Math.max(0.55, Math.min(3, 2 ** ((c.z - 12) * 0.55)));
    const shown = ROADS.filter((cls) => c.z >= ROAD_STYLE[cls][3] && (mode === 'streets' || ['motorway', 'trunk', 'primary'].includes(cls) || (cls === 'secondary' && c.z >= 14)));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const casing of [true, false]) {
      for (const cls of shown) {
        const [fill, cas, w] = ROAD_STYLE[cls];
        ctx.beginPath();
        for (const f of fs) if (f.layer === 'transportation' && f.cls === cls) for (const l of f.lines) path(l, false);
        if (mode === 'terrain') {
          if (casing) continue;
          ctx.strokeStyle = cls === 'motorway' || cls === 'trunk' ? '#8a7f6e' : '#a69d8e';
          ctx.lineWidth = Math.max(0.8, w * grow * 0.45);
        } else {
          ctx.strokeStyle = casing ? cas : fill;
          ctx.lineWidth = w * grow + (casing ? 1.6 : 0);
        }
        ctx.stroke();
      }
    }
    if (mode === 'streets' && names.length) labels(ctx, c, scale, ox, oy);
  }

  /**
   * Road names along their longest in-tile segment, kept upright, never overlapping another label in the tile, one
   * label per name per tile. Only labels that fit entirely inside the tile are drawn (no cut text at tile edges).
   */
  function labels(ctx: CanvasRenderingContext2D, c: L.Coords, scale: number, ox: number, oy: number) {
    const pad = 2 / 256 / 2 ** c.z;
    const tx0 = ox / scale - pad, ty0 = oy / scale - pad, tx1 = (ox + 256) / scale + pad, ty1 = (oy + 256) / scale + pad;
    const boxes: [number, number, number, number][] = [];
    const seen = new Set<string>();
    const size = c.z >= 16 ? 11.5 : 11;
    ctx.font = '600 ' + size + 'px Arabic, Tahoma, sans-serif';
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const order = (n: Named) => ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].indexOf(n.cls) + 1 || 9;
    const cand = names.filter((n) => c.z >= (LABEL_ZOOM[n.cls] ?? 17) && n.x1 >= tx0 && n.x0 <= tx1 && n.y1 >= ty0 && n.y0 <= ty1).sort((a, b) => order(a) - order(b));
    for (const n of cand) {
      const text = n.ar || n.en;
      if (!text || seen.has(text)) continue;
      // the longest segment of this road inside the tile
      let best = -1, bx = 0, by = 0, ang = 0;
      for (let i = 0; i + 3 < n.pts.length; i += 2) {
        const ax = n.pts[i] * scale - ox, ay = n.pts[i + 1] * scale - oy, bx2 = n.pts[i + 2] * scale - ox, by2 = n.pts[i + 3] * scale - oy;
        const mx = (ax + bx2) / 2, my = (ay + by2) / 2;
        if (mx < 0 || mx > 256 || my < 0 || my > 256) continue;
        const len = Math.hypot(bx2 - ax, by2 - ay);
        if (len > best) {
          best = len;
          bx = mx;
          by = my;
          ang = Math.atan2(by2 - ay, bx2 - ax);
        }
      }
      const w = ctx.measureText(text).width;
      if (best < Math.min(w * 0.9, 120)) continue;
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      const hw = (Math.abs(Math.cos(ang)) * w + Math.abs(Math.sin(ang)) * size) / 2 + 2;
      const hh = (Math.abs(Math.sin(ang)) * w + Math.abs(Math.cos(ang)) * size) / 2 + 2;
      const box: [number, number, number, number] = [bx - hw, by - hh, bx + hw, by + hh];
      if (box[0] < 0 || box[1] < 0 || box[2] > 256 || box[3] > 256) continue;
      if (boxes.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
      boxes.push(box);
      seen.add(text);
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(ang);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = n.cls === 'motorway' || n.cls === 'trunk' ? '#6b4a12' : '#3d4a4f';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }

  /** Hillshade (sun from the north-west, 45°) and 10 m contours of the generated field, on a coarse grid per tile. */
  function relief(ctx: CanvasRenderingContext2D, c: L.Coords, scale: number, ox: number, oy: number) {
    const N = 64;
    const s = 256 / N;
    const E = new Float32Array((N + 3) * (N + 3));
    for (let j = -1; j <= N + 1; j++)
      for (let i = -1; i <= N + 1; i++) E[(j + 1) * (N + 3) + i + 1] = elevation(hills, unmerc((ox + i * s) / scale, (oy + j * s) / scale));
    const at = (i: number, j: number) => E[(j + 1) * (N + 3) + i + 1];
    const mid = unmerc((ox + 128) / scale, (oy + 128) / scale);
    const mpp = (156543.03 * Math.cos((mid.lat * Math.PI) / 180)) / 2 ** c.z;
    const img = ctx.createImageData(N, N);
    const az = (315 * Math.PI) / 180;
    const alt = (45 * Math.PI) / 180;
    // vertical exaggeration for readability, stronger when zoomed out so the relief stays legible
    const zf = Math.min(16, 4 * 2 ** Math.max(0, (14 - c.z) * 0.6));
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const dzdx = ((at(i + 1, j) - at(i - 1, j)) / (2 * s * mpp)) * zf;
        const dzdy = ((at(i, j + 1) - at(i, j - 1)) / (2 * s * mpp)) * zf;
        const slope = Math.atan(Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        const shade = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - Math.PI / 2 - aspect);
        const k = (j * N + i) * 4;
        const v = shade - Math.cos(alt); // 0 on flat ground
        if (v < 0) {
          img.data[k] = img.data[k + 1] = img.data[k + 2] = 40;
          img.data[k + 3] = Math.min(150, -v * 420);
        } else {
          img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
          img.data[k + 3] = Math.min(90, v * 300);
        }
      }
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = N;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, 256, 256);
    ctx.restore();
    // contours by marching squares (10 m; every 50 m darker)
    const lo = Math.floor(Math.min(...E) / 10) * 10;
    const hi = Math.max(...E);
    for (let lv = lo + 10; lv < hi; lv += 10) {
      ctx.beginPath();
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const a = at(i, j), b = at(i + 1, j), d = at(i, j + 1), e = at(i + 1, j + 1);
          const pts: [number, number][] = [];
          const edge = (v1: number, v2: number, x1: number, y1: number, x2: number, y2: number) => {
            if ((v1 < lv) !== (v2 < lv)) {
              const t = (lv - v1) / (v2 - v1);
              pts.push([(x1 + (x2 - x1) * t) * s, (y1 + (y2 - y1) * t) * s]);
            }
          };
          edge(a, b, i, j, i + 1, j);
          edge(b, e, i + 1, j, i + 1, j + 1);
          edge(e, d, i + 1, j + 1, i, j + 1);
          edge(d, a, i, j + 1, i, j);
          for (let q = 0; q + 1 < pts.length; q += 2) {
            ctx.moveTo(pts[q][0], pts[q][1]);
            ctx.lineTo(pts[q + 1][0], pts[q + 1][1]);
          }
        }
      ctx.strokeStyle = lv % 50 === 0 ? 'rgba(120,88,44,.55)' : 'rgba(140,105,60,.28)';
      ctx.lineWidth = lv % 50 === 0 ? 1 : 0.6;
      ctx.stroke();
    }
  }

  const layer = new (Layer as unknown as new (o: L.GridLayerOptions) => L.GridLayer)({ attribution, pane: 'tilePane', keepBuffer: 3, updateWhenZooming: false });
  return {
    layer,
    ready,
    get mode() {
      return mode;
    },
    setMode(m: Mode) {
      if (m === mode) return;
      mode = m;
      layer.getContainer()?.setAttribute('data-mode', m);
      layer.redraw();
    },
  };
}
