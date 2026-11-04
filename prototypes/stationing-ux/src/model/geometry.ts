// Distances between administrative geometries for the stationing prototype (owner correction of 3 Nov 2026, §6): the
// configured rules use the SHORTEST distance between the actual geometries — a site footprint (or point) and a
// deployment-area polygon, or two deployment-area polygons — and 0 when they touch or overlap. The nearest pair is found
// on a local metric projection and its distance measured on the sphere (haversine); the server would use PostGIS
// ST_Distance on geography. Centre-to-centre is kept only for information and for requests pinned to a profile that
// published that method.
import { centroid, pointInRing, ringsIntersect, type Ring } from '../../../../frontend/src/lib/footprint';
import { distanceM, type LatLng } from '../../../../frontend/src/lib/geo';

export type Nearest = { dist: number; from: LatLng; to: LatLng };

const M = 111_320;
const project = (ref: LatLng) => {
  const k = Math.cos((ref.lat * Math.PI) / 180);
  return {
    xy: (p: LatLng) => ({ x: (p.lng - ref.lng) * M * k, y: (p.lat - ref.lat) * M }),
    ll: (q: { x: number; y: number }) => ({ lat: ref.lat + q.y / M, lng: ref.lng + q.x / (M * k) }),
  };
};

/** The point of segment a–b nearest to p, in the projection. */
function onSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Shortest distance from a point or a polygon to a polygon; 0 when they touch or overlap (one inside the other included). */
export function nearest(a: Ring | LatLng, b: Ring): Nearest {
  const pts: Ring = Array.isArray(a) ? a : [a];
  const poly = Array.isArray(a) && a.length >= 3;
  if (poly ? ringsIntersect(a, b) || pointInRing(a[0], b) || pointInRing(b[0], a) : pointInRing(pts[0], b)) {
    const at = poly ? centroid(a) : pts[0];
    return { dist: 0, from: at, to: at };
  }
  const pr = project(centroid([...pts, ...b]));
  const A = pts.map(pr.xy);
  const B = b.map(pr.xy);
  let best = { d2: Infinity, from: A[0], to: B[0] };
  const consider = (p: { x: number; y: number }, ring: { x: number; y: number }[], pointIsFrom: boolean) => {
    for (let i = 0; i < ring.length; i++) {
      const q = onSegment(p, ring[i], ring[(i + 1) % ring.length]);
      const d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d2 < best.d2) best = pointIsFrom ? { d2, from: p, to: q } : { d2, from: q, to: p };
    }
  };
  for (const p of A) consider(p, B, true);
  if (poly) for (const q of B) consider(q, A, false);
  const from = pr.ll(best.from);
  const to = pr.ll(best.to);
  return { dist: distanceM(from, to), from, to };
}

/** Centre to centre, for information (and for requests pinned to a centre-to-centre profile). */
export const centreDistance = (a: Ring, b: Ring) => distanceM(centroid(a), centroid(b));
