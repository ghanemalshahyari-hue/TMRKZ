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

/** Whether two rings share any area (edges crossing, or one inside the other). */
export function ringsIntersect(a: Ring, b: Ring): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return (a.length > 0 && pointInRing(a[0], b)) || (b.length > 0 && pointInRing(b[0], a));
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
