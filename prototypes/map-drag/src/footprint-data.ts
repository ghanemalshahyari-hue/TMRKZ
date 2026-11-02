// Fictional scene for the polygon-footprint relocation prototype (civilian administrative GIS, isolated — not
// production). An existing site with a six-vertex footprint and its organisation's identity symbol, some occupied
// areas, and an allowed-distance rule. Coordinates are kept as GeoJSON [lng,lat] so Turf can measure them directly.
import { CENTER, destination, type LatLng } from './data';
export { CENTER, destination, type LatLng };

export type Ring = [number, number][]; // closed ring, GeoJSON [lng,lat]

const xy = (p: LatLng): [number, number] => [p.lng, p.lat];
function polygonAround(center: LatLng, radii: number[]): Ring {
  const n = radii.length;
  const ring: Ring = [];
  for (let i = 0; i < n; i++) ring.push(xy(destination(center, (i * 360) / n, radii[i])));
  ring.push(ring[0]); // close
  return ring;
}

export const SITE_CENTER: LatLng = destination(CENTER, 40, 900);

// the approved, registered site footprint (six vertices, irregular) — the authoritative geometry, never changed here
export const SITE_FOOTPRINT: Ring = polygonAround(SITE_CENTER, [430, 360, 470, 410, 350, 440]);

export const SITE = {
  name: 'مركز الخدمات الإدارية',
  org: 'إدارة المشاريع',
  sidc: '10031000160000000000', // informational identity frame (same approach as the main app)
};

// allowed distance for a proposed relocation, measured from the original footprint centroid
export const RULE = { minM: 800, maxM: 5000 };

// occupied areas (red). One is placed so a dragged footprint overlaps it, to exercise full-polygon overlap checks.
// `until`: the booking ends then (null = open-ended) — a proposal starting on/after it is not blocked.
// `shared`: an authorised shared site for this organisation — overlap is allowed but flagged.
// Occupant identities are never shown; the label is generic.
export type Zone = { id: string; ring: Ring; until: string | null; shared: boolean };
export const OCCUPIED_ZONES: Zone[] = [
  { id: 'z1', ring: polygonAround(destination(SITE_CENTER, 0, 2300), [360, 300, 380, 320]), until: null, shared: false },
  { id: 'z2', ring: polygonAround(destination(SITE_CENTER, 90, 2600), [340, 420, 360, 300]), until: '2027-03-01', shared: false },
  { id: 'z3', ring: polygonAround(destination(SITE_CENTER, 215, 2000), [380, 340, 400, 320, 360]), until: null, shared: true },
];

// drawing limits for the new-footprint mode
export const VERTEX_LIMITS = { min: 3, max: 12, defaultTarget: 4 };
