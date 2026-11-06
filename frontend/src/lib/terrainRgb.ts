import { distanceM, type LatLng } from './geo';
import type { Part } from './siteGeometry';

/**
 * Elevations from the 3D view's Terrain-RGB tiles (package component `terrain-3d`, ADR-038): GLO-30 heights resampled
 * to Web Mercator 256 px tiles, height = -10000 + (R·65536 + G·256 + B) · 0.1 m. DISPLAY ONLY — the lowest and highest
 * point of an area, the profile of a connector. No Stationing rule reads them: terrain classes, allowances and verdicts
 * come from the server's slope analysis. The tiles' finest zoom (12, about 35 m a pixel in the UAE) bounds the precision.
 */
export const DEM_ZOOM = 12;
export const DEM_TILE = 256;

export const decodeMapbox = (r: number, g: number, b: number) => -10000 + (r * 65536 + g * 256 + b) * 0.1;

/** The tile of zoom {@code z} holding a point, and the point's fractional pixel inside it. */
export function tileOf(p: LatLng, z = DEM_ZOOM): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z;
  const fx = ((p.lng + 180) / 360) * n;
  const s = Math.sin((p.lat * Math.PI) / 180);
  const fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  return { x, y, px: (fx - x) * DEM_TILE, py: (fy - y) * DEM_TILE };
}

/** Bilinear height at a fractional pixel of one decoded RGBA tile (pixel centres at +0.5; clamped at the tile's edge). */
export function sampleTile(rgba: ArrayLike<number>, px: number, py: number, size = DEM_TILE): number {
  const cx = Math.min(Math.max(px - 0.5, 0), size - 1);
  const cy = Math.min(Math.max(py - 0.5, 0), size - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, size - 1);
  const y1 = Math.min(y0 + 1, size - 1);
  const h = (x: number, y: number) => {
    const i = (y * size + x) * 4;
    return decodeMapbox(rgba[i], rgba[i + 1], rgba[i + 2]);
  };
  const tx = cx - x0;
  const ty = cy - y0;
  return (h(x0, y0) * (1 - tx) + h(x1, y0) * tx) * (1 - ty) + (h(x0, y1) * (1 - tx) + h(x1, y1) * tx) * ty;
}

function inRing(p: LatLng, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

/** Whether a point lies inside a site or area (any part, outside its holes). */
export const insideParts = (p: LatLng, parts: Part[]) => parts.some((part) => inRing(p, part[0]) && !part.slice(1).some((h) => inRing(p, h)));

/**
 * The points an area's elevations are read at: a regular grid inside it (about one tile pixel apart, coarser for large
 * areas so at most {@code max} points) plus every vertex, so a narrow ridge or a small part is never missed.
 */
export function areaSamples(parts: Part[], max = 1600, minSpacingM = 35): LatLng[] {
  const all = parts.flatMap((p) => p[0]);
  if (!all.length) return [];
  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const kx = 111320 * Math.cos((((s + n) / 2) * Math.PI) / 180);
  const ky = 110900;
  const wM = (e - w) * kx;
  const hM = (n - s) * ky;
  const step = Math.max(minSpacingM, Math.sqrt((wM * hM) / max));
  const out: LatLng[] = [];
  for (let y = s + step / ky / 2; y < n; y += step / ky) {
    for (let x = w + step / kx / 2; x < e; x += step / kx) {
      const p = { lat: y, lng: x };
      if (insideParts(p, parts)) out.push(p);
    }
  }
  return [...out, ...all];
}

export type ElevationStats = { min: number; max: number; range: number; mean: number; samples: number };

export function elevationStats(heights: (number | null)[]): ElevationStats | null {
  const h = heights.filter((v): v is number => v != null && Number.isFinite(v));
  if (!h.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of h) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, range: max - min, mean: sum / h.length, samples: h.length };
}

/** Points along a connector, evenly spaced (at least one tile pixel apart, at most {@code max} + 1 points), with their distance from its start. */
export function profilePoints(a: LatLng, b: LatLng, max = 160, minSpacingM = 35): { at: LatLng; d: number }[] {
  const len = distanceM(a, b);
  const n = Math.max(2, Math.min(max, Math.ceil(len / minSpacingM)));
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return { at: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, d: len * t };
  });
}

export type Profile = { d: number[]; h: number[]; length: number; min: number; max: number; start: number; end: number; climb: number; descent: number; maxSlopePct: number };

/**
 * A connector's profile from its sampled heights: lowest, highest, both ends, total climb and descent, and the steepest
 * stretch over at least {@code windowM} (shorter stretches between two samples of the same tile pixel only add noise).
 */
export function profileOf(points: { d: number }[], heights: (number | null)[], windowM = 100): Profile | null {
  const d: number[] = [];
  const h: number[] = [];
  points.forEach((p, i) => {
    const v = heights[i];
    if (v != null && Number.isFinite(v)) {
      d.push(p.d);
      h.push(v);
    }
  });
  if (h.length < 2) return null;
  let climb = 0;
  let descent = 0;
  for (let i = 1; i < h.length; i++) {
    const dh = h[i] - h[i - 1];
    if (dh > 0) climb += dh;
    else descent -= dh;
  }
  let maxSlope = 0;
  for (let i = 0, j = 0; i < h.length; i++) {
    while (j < h.length && d[j] - d[i] < windowM) j++;
    if (j >= h.length) break;
    maxSlope = Math.max(maxSlope, Math.abs(h[j] - h[i]) / (d[j] - d[i]));
  }
  return { d, h, length: d[d.length - 1], min: Math.min(...h), max: Math.max(...h), start: h[0], end: h[h.length - 1], climb, descent, maxSlopePct: maxSlope * 100 };
}

/** The tiles a set of points falls in (one fetch each), keyed "z/x/y". */
export function tilesFor(points: LatLng[], z = DEM_ZOOM): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const p of points) {
    const t = tileOf(p, z);
    out.set(`${z}/${t.x}/${t.y}`, { x: t.x, y: t.y });
  }
  return out;
}

/** One slope class of the Stationing policy in force: from ≤ slope % < to (no upper bound: null). */
export type SlopeBand = { code: string; label: string; fromPct: number; toPct: number | null };

/** Green (flat) → red (steepest): one colour per policy class, spread over the ramp whatever their number. */
export const SLOPE_RAMP: [number, number, number][] = [
  [46, 158, 79],
  [154, 205, 50],
  [242, 210, 46],
  [242, 140, 40],
  [215, 48, 31],
];
export function bandColours(n: number): [number, number, number][] {
  return Array.from({ length: n }, (_, i) => SLOPE_RAMP[n === 1 ? 0 : Math.round((i * (SLOPE_RAMP.length - 1)) / (n - 1))]);
}

/**
 * Slope classes of one decoded Terrain-RGB tile, as an RGBA image to lay over the map (DISPLAY ONLY): Horn's 3×3
 * gradient on the tile's own pixels (metric size per row in Web Mercator; the outer ring repeats its neighbour), slope
 * in percent, coloured by the policy's half-open classes. Sea level (0 m) stays clear. The server's classification of an
 * area, from the native slope analysis, remains the one the rules use.
 */
export function slopeTileImage(rgba: ArrayLike<number>, z: number, y: number, bands: SlopeBand[], alpha = 150, size = DEM_TILE): Uint8ClampedArray<ArrayBuffer> {
  const h = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) h[i] = decodeMapbox(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  const colours = bandColours(bands.length);
  const out = new Uint8ClampedArray(size * size * 4);
  const n = 2 ** z;
  const at = (x: number, yy: number) => h[Math.min(size - 1, Math.max(0, yy)) * size + Math.min(size - 1, Math.max(0, x))];
  for (let r = 0; r < size; r++) {
    // latitude of this pixel row, and the ground size of one pixel there
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (r + 0.5) / size)) / n))) * 180) / Math.PI;
    const cell = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (size * n);
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      if (h[i] <= 0.05 && h[i] >= -0.05) continue;
      const [a, b, cc, d, f, g, hh, ii] = [at(c - 1, r - 1), at(c, r - 1), at(c + 1, r - 1), at(c - 1, r), at(c + 1, r), at(c - 1, r + 1), at(c, r + 1), at(c + 1, r + 1)];
      // at the tile's edge the difference spans one cell, not two (no seam between tiles)
      const gx = (cc + 2 * f + ii - (a + 2 * d + g)) / ((c === 0 || c === size - 1 ? 4 : 8) * cell);
      const gy = (a + 2 * b + cc - (g + 2 * hh + ii)) / ((r === 0 || r === size - 1 ? 4 : 8) * cell);
      const pct = Math.hypot(gx, gy) * 100;
      const k = bands.findIndex((s) => pct >= s.fromPct && (s.toPct == null || pct < s.toPct));
      if (k < 0) continue;
      out.set([...colours[k], alpha], i * 4);
    }
  }
  return out;
}
