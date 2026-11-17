/**
 * The shape tools of «أدوات الرسم والتحكم (مثل Word)» (owner brief §7 and reference image panel 5): ready shapes (circle,
 * ellipse, square, rectangle) of a given area, and the frame around a shape with its handles — corners scale it evenly,
 * sides change its width or its length alone (a square becomes a rectangle, a circle an ellipse), the round handle
 * turns it. Everything is computed in metres on a local plane around the shape (accurate at the size of a deployment
 * area), then given back as latitude and longitude.
 */
import type { LatLng } from './geo';

const M_LAT = 110_540;
const mLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
export type XY = { x: number; y: number };
export const toXY = (p: LatLng, c: LatLng): XY => ({ x: (p.lng - c.lng) * mLng(c.lat), y: (p.lat - c.lat) * M_LAT });
export const fromXY = (q: XY, c: LatLng): LatLng => ({ lat: c.lat + q.y / M_LAT, lng: c.lng + q.x / mLng(c.lat) });
export const rot = (q: XY, a: number): XY => ({ x: q.x * Math.cos(a) - q.y * Math.sin(a), y: q.x * Math.sin(a) + q.y * Math.cos(a) });

export type ShapeKind = 'CIRCLE' | 'ELLIPSE' | 'SQUARE' | 'RECTANGLE';
/** The rectangle's and the ellipse's width to length when first placed. */
export const ASPECT = 1.6;
const ROUND = 32;

/** A ready shape of {@code areaM2} centred on {@code c}, north-aligned: its ring, without the closing point. */
export function readyShape(c: LatLng, kind: ShapeKind, areaM2: number): LatLng[] {
  const a = kind === 'RECTANGLE' || kind === 'ELLIPSE' ? ASPECT : 1;
  let pts: XY[];
  if (kind === 'SQUARE' || kind === 'RECTANGLE') {
    const h = Math.sqrt(areaM2 / a);
    const w = h * a;
    pts = [{ x: -w / 2, y: h / 2 }, { x: w / 2, y: h / 2 }, { x: w / 2, y: -h / 2 }, { x: -w / 2, y: -h / 2 }];
  } else {
    // a regular polygon of ROUND sides with the given area, stretched for the ellipse (the area is kept)
    const r = Math.sqrt((2 * areaM2) / (ROUND * Math.sin((2 * Math.PI) / ROUND)));
    const sx = Math.sqrt(a);
    pts = Array.from({ length: ROUND }, (_, i) => {
      const t = (2 * Math.PI * i) / ROUND;
      return { x: r * sx * Math.cos(t), y: (r / sx) * Math.sin(t) };
    });
  }
  return pts.map((q) => fromXY(q, c));
}

/** The frame of a set of points turned by {@code angle}: its centre and its extent along and across that direction. */
export type Frame = { c: LatLng; angle: number; minU: number; maxU: number; minV: number; maxV: number };

export function frameOf(points: readonly LatLng[], angle: number): Frame | null {
  if (!points.length) return null;
  const c0 = { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length };
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of points) {
    const q = rot(toXY(p, c0), -angle);
    minU = Math.min(minU, q.x);
    maxU = Math.max(maxU, q.x);
    minV = Math.min(minV, q.y);
    maxV = Math.max(maxV, q.y);
  }
  // the frame's own centre as the reference point
  const mid = rot({ x: (minU + maxU) / 2, y: (minV + maxV) / 2 }, angle);
  const c = fromXY(mid, c0);
  const hw = (maxU - minU) / 2;
  const hh = (maxV - minV) / 2;
  return { c, angle, minU: -hw, maxU: hw, minV: -hh, maxV: hh };
}

/** Width (across the frame's direction) and length (along it) in metres. */
export const frameSize = (f: Frame) => ({ width: f.maxU - f.minU, length: f.maxV - f.minV });

/**
 * The eight handles in frame coordinates, in order: corners at even numbers, sides at odd ones —
 * 0 (minU,minV) 1 (0,minV) 2 (maxU,minV) 3 (maxU,0) 4 (maxU,maxV) 5 (0,maxV) 6 (minU,maxV) 7 (minU,0).
 */
export function handleUV(f: Frame, i: number): XY {
  const u = [f.minU, 0, f.maxU, f.maxU, f.maxU, 0, f.minU, f.minU][i];
  const v = [f.minV, f.minV, f.minV, 0, f.maxV, f.maxV, f.maxV, 0][i];
  return { x: u, y: v };
}
export const handleAt = (f: Frame, i: number): LatLng => fromXY(rot(handleUV(f, i), f.angle), f.c);

/** The smallest side a handle leaves (metres): a shape never folds over itself. */
export const MIN_SIDE = 5;

/**
 * The points after handle {@code i} is dragged to {@code to}: a corner scales the shape evenly from the opposite corner,
 * a side moves only that side (width or length), the opposite side staying where it is.
 */
export function resizeBy(points: readonly LatLng[], f: Frame, i: number, to: LatLng): LatLng[] {
  const h = handleUV(f, i);
  const a = handleUV(f, (i + 4) % 8);
  const q = rot(toXY(to, f.c), -f.angle);
  const w = f.maxU - f.minU;
  const l = f.maxV - f.minV;
  let su = 1;
  let sv = 1;
  if (i % 2 === 0) {
    const d = { x: h.x - a.x, y: h.y - a.y };
    const s = ((q.x - a.x) * d.x + (q.y - a.y) * d.y) / (d.x * d.x + d.y * d.y || 1);
    su = sv = Math.max(s, MIN_SIDE / Math.max(Math.min(w, l), MIN_SIDE));
  } else if (h.x === 0) sv = Math.max((q.y - a.y) / (h.y - a.y || 1), MIN_SIDE / Math.max(l, MIN_SIDE));
  else su = Math.max((q.x - a.x) / (h.x - a.x || 1), MIN_SIDE / Math.max(w, MIN_SIDE));
  return points.map((p) => {
    const r = rot(toXY(p, f.c), -f.angle);
    const n = { x: a.x + (r.x - a.x) * su, y: a.y + (r.y - a.y) * sv };
    return fromXY(rot(n, f.angle), f.c);
  });
}

/** The points turned by {@code by} radians (counter-clockwise) around {@code c}. */
export function rotateBy(points: readonly LatLng[], c: LatLng, by: number): LatLng[] {
  return points.map((p) => fromXY(rot(toXY(p, c), by), c));
}

/** The angle (radians) of {@code p} seen from {@code c}, east = 0, counter-clockwise. */
export const angleFrom = (c: LatLng, p: LatLng) => {
  const q = toXY(p, c);
  return Math.atan2(q.y, q.x);
};
