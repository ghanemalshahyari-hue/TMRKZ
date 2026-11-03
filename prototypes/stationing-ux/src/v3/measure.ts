// Distance measurement for the V3 deployment rules (owner brief, 3 Nov 2026, §24–§29). The METHOD is a policy value,
// never an assumption: the brief asks that centre-to-centre is not chosen silently, so every method the owner may pick
// is implemented and the policy names one. Distances are geodesic between points; the distance from a point to an edge
// uses a local tangent-plane projection around the point (error well under 1 m at the few-kilometre scale used here).
import { centroid, pointInRing, ringsIntersect, type Ring } from '../../../../frontend/src/lib/footprint';
import { destination, distanceM, type LatLng } from '../../../../frontend/src/lib/geo';

/**
 * CENTROID_TO_CENTROID — the reference geometry's centre to the placed area's centre (what the current engine and the
 *   server measure today, see docs/STATIONING_MODEL_V3_AR.md §9).
 * CENTROID_TO_NEAREST_EDGE — the reference centre to the nearest point of the placed area (0 inside it).
 * EDGE_TO_EDGE — the nearest points of the two boundaries (0 when they touch or overlap).
 */
export type Method = 'CENTROID_TO_CENTROID' | 'CENTROID_TO_NEAREST_EDGE' | 'EDGE_TO_EDGE';

export const METHOD_LABEL: Record<Method, string> = {
  CENTROID_TO_CENTROID: 'من المركز إلى المركز',
  CENTROID_TO_NEAREST_EDGE: 'من المركز إلى أقرب حافة',
  EDGE_TO_EDGE: 'من أقرب حافة إلى أقرب حافة',
};

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Local metres east/north of {@code o}. */
function xy(o: LatLng, p: LatLng): [number, number] {
  return [rad(p.lng - o.lng) * R * Math.cos(rad(o.lat)), rad(p.lat - o.lat) * R];
}

function pointSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const [ax, ay] = xy(p, a);
  const [bx, by] = xy(p, b);
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Nearest distance from a point to a ring's boundary; 0 when the point is inside the ring. */
export function pointToRing(p: LatLng, ring: Ring): number {
  if (pointInRing(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) best = Math.min(best, pointSegment(p, ring[i], ring[(i + 1) % ring.length]));
  return best;
}

/** Nearest distance between two rings; 0 when they share area or touch. */
export function ringToRing(a: Ring, b: Ring): number {
  if (ringsIntersect(a, b) || pointInRing(a[0], b) || pointInRing(b[0], a)) return 0;
  let best = Infinity;
  for (const p of a) best = Math.min(best, pointToRing(p, b));
  for (const p of b) best = Math.min(best, pointToRing(p, a));
  return best;
}

export function measure(method: Method, from: Ring, to: Ring): number {
  if (method === 'CENTROID_TO_CENTROID') return distanceM(centroid(from), centroid(to));
  if (method === 'CENTROID_TO_NEAREST_EDGE') return pointToRing(centroid(from), to);
  return ringToRing(from, to);
}

/**
 * The outline at distance {@code d} from the reference under the method, for the guidance band only (the rule itself is
 * checked by {@link measure}). Centre methods: a circle around the centre. Edge-to-edge: the convex hull of circles
 * around the reference's vertices — exact for a convex footprint, slightly generous for a concave one.
 */
export function bandOutline(method: Method, from: Ring, d: number, steps = 72): Ring {
  const c = centroid(from);
  if (method !== 'EDGE_TO_EDGE' || d <= 0) return circleRing(c, Math.max(d, 1), steps);
  const pts: LatLng[] = [];
  for (const v of from) for (let i = 0; i < 24; i++) pts.push(destination(v, (i / 24) * 360, d));
  return hull(c, pts);
}

function hull(o: LatLng, pts: LatLng[]): Ring {
  const p = pts.map((q) => ({ q, v: xy(o, q) })).sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1]);
  const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const lower: typeof p = [];
  for (const x of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2].v, lower[lower.length - 1].v, x.v) <= 0) lower.pop();
    lower.push(x);
  }
  const upper: typeof p = [];
  for (const x of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2].v, upper[upper.length - 1].v, x.v) <= 0) upper.pop();
    upper.push(x);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map((x) => x.q);
}

/** The two nearest boundary points of two disjoint rings (for drawing the edge-to-edge distance). */
export function nearestPair(a: Ring, b: Ring): { p: LatLng; q: LatLng; d: number } {
  let best = { p: a[0], q: b[0], d: Infinity };
  const scan = (from: Ring, to: Ring, flip: boolean) => {
    for (const p of from)
      for (let i = 0; i < to.length; i++) {
        const s = to[i];
        const e = to[(i + 1) % to.length];
        const [ax, ay] = xy(p, s);
        const [bx, by] = xy(p, e);
        const dx = bx - ax;
        const dy = by - ay;
        const len = dx * dx + dy * dy;
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
        const q = { lat: s.lat + (e.lat - s.lat) * t, lng: s.lng + (e.lng - s.lng) * t };
        const d = distanceM(p, q);
        if (d < best.d) best = flip ? { p: q, q: p, d } : { p, q, d };
      }
  };
  scan(a, b, false);
  scan(b, a, true);
  return best;
}

/** A regular polygon approximating a circle: the simple default shape of a deployment area (§26), real geometry. */
export function circleRing(center: LatLng, radius: number, steps = 32): Ring {
  const out: Ring = [];
  for (let i = 0; i < steps; i++) out.push(destination(center, (i / steps) * 360, radius));
  return out;
}

/** The radius of the circle with the same area (shown as the «حجم» of a simple shape). */
export const equivalentRadius = (areaM2: number) => Math.sqrt(areaM2 / Math.PI);
