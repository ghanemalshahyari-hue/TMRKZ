import type { GeoJsonGeometry } from '../api/types';

/** Small spherical helpers for the stationing map (display and live feedback only; the server measures with PostGIS). */
const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export type LatLng = { lat: number; lng: number };

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(a: LatLng, bearingDeg: number, meters: number): LatLng {
  const d = meters / R;
  const b = rad(bearingDeg);
  const lat1 = rad(a.lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = rad(a.lng) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: ((deg(lng2) + 540) % 360) - 180 };
}

/** Ring of a geodesic circle as [lat, lng] pairs (for drawing a range on the map). */
export function circle(center: LatLng, meters: number, steps = 96): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const p = destination(center, (i * 360) / steps, meters);
    out.push([p.lat, p.lng]);
  }
  return out;
}

/**
 * Keeps a dragged point inside [min, max] metres of the centre along the same bearing. The margin (0.5 %, at least
 * 10 m) absorbs the difference between this sphere and the server's ellipsoid, so a clamped point is never refused.
 */
export function clampToRange(center: LatLng, p: LatLng, min: number, max: number | null | undefined): { point: LatLng; clamped: 'MIN' | 'MAX' | null } {
  const d = distanceM(center, p);
  const margin = (v: number) => Math.max(10, v * 0.005);
  if (max != null && d > max - margin(max)) return { point: destination(center, bearing(center, p), max - margin(max)), clamped: d > max ? 'MAX' : null };
  if (d < min + margin(min)) return { point: destination(center, d < 0.5 ? 90 : bearing(center, p), min + margin(min)), clamped: d < min ? 'MIN' : null };
  return { point: p, clamped: null };
}

function inRing(p: LatLng, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point inside a GeoJSON Polygon/MultiPolygon (holes respected). */
export function pointInGeometry(p: LatLng, g: GeoJsonGeometry | null | undefined): boolean {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates as number[][][]] : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]) : [];
  return polys.some((rings) => rings.length > 0 && inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h)));
}

/** Moves every coordinate of a polygon by the same offset (a drawn footprint follows its dragged marker). */
export function translate(g: GeoJsonGeometry, dLat: number, dLng: number): GeoJsonGeometry {
  const move = (c: unknown): unknown => (Array.isArray(c) && typeof c[0] === 'number' ? [(c[0] as number) + dLng, (c[1] as number) + dLat] : (c as unknown[]).map(move));
  return { type: g.type, coordinates: move(g.coordinates) };
}

export function formatKm(m: number): string {
  if (m >= 1000) return (m / 1000).toLocaleString('ar', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' كم';
  return Math.round(m).toLocaleString('ar') + ' م';
}
