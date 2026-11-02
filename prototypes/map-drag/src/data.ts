// Synthetic, fictional, illustrative data shared by BOTH prototypes so the comparison is fair.
// Nothing here describes any real site. Canonical coordinates are {lat,lng}; engines convert at their boundary
// (Leaflet uses [lat,lng], MapLibre/GeoJSON use [lng,lat]).

export type LatLng = { lat: number; lng: number };
export type Facility = { id: string; name: string; at: LatLng; busy: boolean };
export type Occupied = { id: string; name: string; ring: LatLng[] }; // outer ring, closed
export type RangeRule = { minM: number; maxM: number | null };

// ---- geo math: identical to frontend/src/lib/geo.ts so A and B agree to the metre -------------------------
const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

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
export function circleRing(center: LatLng, meters: number, steps = 96): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i <= steps; i++) out.push(destination(center, (i * 360) / steps, meters));
  return out;
}
/** Keep p inside [min,max] of centre along the same bearing (margin absorbs projection error). */
export function clampToRange(center: LatLng, p: LatLng, min: number, max: number | null | undefined): { point: LatLng; clamped: 'MIN' | 'MAX' | null } {
  const d = distanceM(center, p);
  const margin = (v: number) => Math.max(10, v * 0.005);
  if (max != null && d > max - margin(max)) return { point: destination(center, bearing(center, p), max - margin(max)), clamped: d > max ? 'MAX' : null };
  if (d < min + margin(min)) return { point: destination(center, d < 0.5 ? 90 : bearing(center, p), min + margin(min)), clamped: d < min ? 'MIN' : null };
  return { point: p, clamped: null };
}
function inRing(p: LatLng, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat, xj = ring[j].lng, yj = ring[j].lat;
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInOccupied(p: LatLng, zones: Occupied[]): Occupied | null {
  return zones.find((z) => inRing(p, z.ring)) ?? null;
}
export function formatKm(m: number): string {
  if (m >= 1000) return (m / 1000).toLocaleString('ar', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' كم';
  return Math.round(m).toLocaleString('ar') + ' م';
}

// ---- the scene: a current facility, an allowed range, occupied zones, and N nearby facilities --------------
// Fictional centre (illustrative only).
export const CENTER: LatLng = { lat: 25.176, lng: 55.33 };
export const CURRENT: Facility = { id: 'cur', name: 'المقر الحالي (تجريبي)', at: CENTER, busy: false };
export const RULE: RangeRule = { minM: 1000, maxM: 6000 };

// Rectangle helper around a centre (metres half-width/height) → closed ring.
function rect(c: LatLng, halfW: number, halfH: number): LatLng[] {
  const w = destination(c, 90, halfW).lng - c.lng;
  const h = destination(c, 0, halfH).lat - c.lat;
  return [
    { lat: c.lat - h, lng: c.lng - w },
    { lat: c.lat - h, lng: c.lng + w },
    { lat: c.lat + h, lng: c.lng + w },
    { lat: c.lat + h, lng: c.lng - w },
    { lat: c.lat - h, lng: c.lng - w },
  ];
}

// Occupied zones (red). One sits ~east inside the ring so a drag crosses it; another near the max edge.
export const OCCUPIED: Occupied[] = [
  { id: 'z1', name: 'منطقة محجوزة — شرق', ring: rect(destination(CENTER, 90, 3000), 450, 400) },
  { id: 'z2', name: 'منطقة محجوزة — شمال شرق', ring: rect(destination(CENTER, 45, 4800), 500, 450) },
  { id: 'z3', name: 'منطقة محجوزة — جنوب', ring: rect(destination(CENTER, 180, 2200), 400, 350) },
];

// Deterministic PRNG (mulberry32) so 10/100/1000 scenes are identical across A and B and across runs.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** N fictional registered facilities scattered within ~9 km of centre; a deterministic ~18% are "busy" (red). */
export function makeFacilities(n: number): Facility[] {
  const rnd = mulberry32(0x7a3f01 + n);
  const out: Facility[] = [];
  for (let i = 0; i < n; i++) {
    const brg = rnd() * 360;
    const dist = 600 + Math.sqrt(rnd()) * 8400; // denser near centre
    out.push({ id: 'f' + i, name: 'موقع ' + (i + 1), at: destination(CENTER, brg, dist), busy: rnd() < 0.18 });
  }
  return out;
}

export const RANGE_OUTER = circleRing(CENTER, RULE.maxM ?? 6000);
export const RANGE_INNER = circleRing(CENTER, RULE.minM);
