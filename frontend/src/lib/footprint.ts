import type { GeoJsonGeometry } from '../api/types';
import { bearing, destination, distanceM, type LatLng } from './geo';

/**
 * Footprint geometry for the stationing preview (approved polygon prototype, 2 Nov 2026). A ring is an open list of
 * vertices (the closing vertex is implied). A footprint is moved RIGIDLY: every vertex keeps its geodesic distance and
 * bearing from the anchor and is rebuilt around the new anchor — never by adding latitude/longitude offsets, which
 * stretches the shape away from the equator. Display and live feedback only: the server measures with PostGIS.
 */
export type Ring = LatLng[];

/** WGS84 equatorial radius, as used by common geodesic area implementations. */
const AREA_R = 6378137;
const rad = (d: number) => (d * Math.PI) / 180;

export type Offsets = { d: number; b: number }[];

export const offsetsOf = (ring: Ring, anchor: LatLng): Offsets => ring.map((v) => ({ d: distanceM(anchor, v), b: bearing(anchor, v) }));

export const rebuild = (o: Offsets, anchor: LatLng): Ring => o.map((x) => (x.d < 1e-6 ? { ...anchor } : destination(anchor, x.b, x.d)));

/** The ring moved so that its anchor (centroid) lands on {@code to}, shape and area unchanged. */
export function moveRigid(ring: Ring, to: LatLng): Ring {
  return rebuild(offsetsOf(ring, centroid(ring)), to);
}

/** Area-weighted centroid in longitude/latitude (accurate enough for administrative footprints). */
export function centroid(ring: Ring): LatLng {
  let a = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const f = p.lng * q.lat - q.lng * p.lat;
    a += f;
    x += (p.lng + q.lng) * f;
    y += (p.lat + q.lat) * f;
  }
  if (Math.abs(a) < 1e-15) {
    const n = ring.length || 1;
    return { lat: ring.reduce((s, p) => s + p.lat, 0) / n, lng: ring.reduce((s, p) => s + p.lng, 0) / n };
  }
  return { lat: y / (3 * a), lng: x / (3 * a) };
}

/** Geodesic area of a ring in square metres (spherical excess approximation). */
export function areaM2(ring: Ring): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    const p3 = ring[(i + 2) % n];
    total += (rad(p3.lng) - rad(p1.lng)) * Math.sin(rad(p2.lat));
  }
  return Math.abs((total * AREA_R * AREA_R) / 2);
}

export const edgeLengths = (ring: Ring): number[] => ring.map((p, i) => distanceM(p, ring[(i + 1) % ring.length]));

function segmentsCross(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const o = (p: LatLng, q: LatLng, r: LatLng) => (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Number of crossings between non-adjacent edges (0 for a valid simple polygon). */
export function kinks(ring: Ring): number {
  const n = ring.length;
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) k++;
    }
  }
  return k;
}

export function pointInRing(p: LatLng, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

/** Outer rings of a Polygon or MultiPolygon (closing vertex dropped); empty for a point. */
export function ringsOf(g: GeoJsonGeometry | null | undefined): Ring[] {
  if (!g) return [];
  const toRing = (r: number[][]) => {
    const ring = r.map(([lng, lat]) => ({ lat, lng }));
    const f = ring[0];
    const l = ring[ring.length - 1];
    return f && l && f.lat === l.lat && f.lng === l.lng ? ring.slice(0, -1) : ring;
  };
  if (g.type === 'Polygon') return [toRing((g.coordinates as number[][][])[0])];
  if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).map((p) => toRing(p[0]));
  return [];
}

/** The largest outer ring of a registered boundary, the footprint a relocation starts from. */
export function mainRing(g: GeoJsonGeometry | null | undefined): Ring | null {
  const rings = ringsOf(g);
  return rings.length ? rings.reduce((best, r) => (areaM2(r) > areaM2(best) ? r : best)) : null;
}

/**
 * Within this distance a vertex lies on an edge and two vertices are one: geometric coincidence of the same registered or
 * copied coordinates, not a business tolerance (the server's rules keep their own, ADR-025/ADR-026).
 */
const ON_EDGE_M = 1e-3;

type XY = { x: number; y: number };

/** The rings in one local plane, metres east and north of `at`; repeated vertices (and a closing vertex) dropped. */
function planar(ring: Ring, at: LatLng): XY[] {
  const k = (Math.PI / 180) * 6371008.8;
  const c = Math.cos(rad(at.lat));
  const out: XY[] = [];
  for (const p of ring) {
    const q = { x: (p.lng - at.lng) * c * k, y: (p.lat - at.lat) * k };
    const last = out[out.length - 1];
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) > ON_EDGE_M) out.push(q);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= ON_EDGE_M) out.pop();
  return out;
}

/** Side of r from the line p→q: 1 left, -1 right, 0 on it (within ON_EDGE_M). */
function side(p: XY, q: XY, r: XY): number {
  const d = ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / Math.hypot(q.x - p.x, q.y - p.y);
  return Math.abs(d) <= ON_EDGE_M ? 0 : Math.sign(d);
}

/** Where r lies on the segment p→q (0 at p, 1 at q), or null when it is not on it. */
function along(p: XY, q: XY, r: XY): number | null {
  if (side(p, q, r) !== 0) return null;
  const len2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
  const t = ((q.x - p.x) * (r.x - p.x) + (q.y - p.y) * (r.y - p.y)) / len2;
  const m = ON_EDGE_M / Math.sqrt(len2);
  return t >= -m && t <= 1 + m ? Math.min(1, Math.max(0, t)) : null;
}

const onBoundary = (r: XY, ring: XY[]) => ring.some((p, i) => along(p, ring[(i + 1) % ring.length], r) !== null);

/** Even-odd test for a point that is not on the ring's boundary. */
function insideXY(r: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > r.y !== b.y > r.y && r.x < ((b.x - a.x) * (r.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const areaXY = (ring: XY[]) => Math.abs(ring.reduce((s, p, i) => s + p.x * ring[(i + 1) % ring.length].y - ring[(i + 1) % ring.length].x * p.y, 0)) / 2;

/**
 * The boundary of `from`, cut at every vertex of `to` that lies on it, piece by piece: each piece either lies on `to`'s
 * boundary or touches it only at its ends, so its midpoint tells where the whole piece runs. 'inside' as soon as a piece
 * runs inside `to`; otherwise 'outside' when some piece runs off `to`'s boundary, 'on' when every piece lies on it.
 */
function walk(from: XY[], to: XY[]): 'inside' | 'outside' | 'on' {
  let off = false;
  for (let i = 0; i < from.length; i++) {
    const p = from[i];
    const q = from[(i + 1) % from.length];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const cuts = [0, 1];
    for (const v of to) {
      const t = along(p, q, v);
      if (t !== null && t > 0 && t < 1) cuts.push(t);
    }
    cuts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < cuts.length; k++) {
      if ((cuts[k + 1] - cuts[k]) * len <= ON_EDGE_M) continue;
      const t = (cuts[k] + cuts[k + 1]) / 2;
      const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      if (onBoundary(m, to)) continue;
      if (insideXY(m, to)) return 'inside';
      off = true;
    }
  }
  return off ? 'outside' : 'on';
}

/**
 * Whether two rings share area — their interiors overlap — as this function has always been documented ("share any
 * area"); the owner's approval of 3 Nov 2026 fixed the misses without changing that rule. Crossing edges, one ring inside
 * the other (even when they share edges), partly coincident edges on the same side, and identical rings (any start
 * vertex, orientation or extra collinear vertices) overlap; a shared edge, a shared stretch of edge from opposite sides, a
 * shared vertex and a near miss share no area and do not. Display and live feedback only: the server decides with
 * PostGIS (`/placement/check` counts any contact, ADR-025; the boundary register allows a shared edge, ADR-026).
 *
 * Deterministic and exact up to ON_EDGE_M, without special cases for equal coordinates: two simple polygons share area
 * if and only if (1) two edges cross at a point inside both, or (2) a piece of one boundary that is not on the other
 * boundary runs inside the other polygon, or (3) the two boundaries coincide.
 */
export function ringsIntersect(a: Ring, b: Ring): boolean {
  if (a.length < 3 || b.length < 3) return false;
  // far apart: no plane needed (a millimetre is far below 1e-7 degrees)
  const box = (r: Ring) => r.reduce((x, p) => [Math.min(x[0], p.lat), Math.min(x[1], p.lng), Math.max(x[2], p.lat), Math.max(x[3], p.lng)], [Infinity, Infinity, -Infinity, -Infinity]);
  const [ba, bb] = [box(a), box(b)];
  if (ba[2] < bb[0] - 1e-7 || bb[2] < ba[0] - 1e-7 || ba[3] < bb[1] - 1e-7 || bb[3] < ba[1] - 1e-7) return false;
  const A = planar(a, a[0]);
  const B = planar(b, a[0]);
  // a ring without area (fewer than three distinct vertices, or all on one line) has no interior to share
  if (A.length < 3 || B.length < 3 || areaXY(A) <= ON_EDGE_M ** 2 || areaXY(B) <= ON_EDGE_M ** 2) return false;
  for (let i = 0; i < A.length; i++) {
    const p = A[i];
    const q = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const r = B[j];
      const s = B[(j + 1) % B.length];
      if (side(p, q, r) * side(p, q, s) < 0 && side(r, s, p) * side(r, s, q) < 0) return true;
    }
  }
  const ab = walk(A, B);
  if (ab === 'inside') return true;
  const ba2 = walk(B, A);
  return ba2 === 'inside' || ab === 'on' || ba2 === 'on';
}

export const toPolygon = (ring: Ring): GeoJsonGeometry => ({
  type: 'Polygon',
  coordinates: [[...ring, ring[0]].map((p) => [p.lng, p.lat])],
});

export function formatArea(m2: number): string {
  return m2 >= 1e6
    ? (m2 / 1e6).toLocaleString('ar', { maximumFractionDigits: 3 }) + ' كم²'
    : Math.round(m2).toLocaleString('ar') + ' م²';
}

export function formatMeters(m: number): string {
  return m >= 1000 ? (m / 1000).toLocaleString('ar', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) + ' كم' : Math.round(m).toLocaleString('ar') + ' م';
}
