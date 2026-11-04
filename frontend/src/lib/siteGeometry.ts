import type { GeoMultiPolygon, GeoPolygon, SiteGeometry } from '../api/types';
import { areaM2, centroid, offsetsOf, pointInRing, rebuild, type Offsets, type Ring } from './footprint';
import type { LatLng } from './geo';

/**
 * The proposed re-stationing site as an editable geometry (owner decision of 4 Nov 2026): one Polygon, or one
 * MultiPolygon copied whole — every part, its shape, area and place relative to the others. The site moves as ONE rigid
 * object: every vertex keeps its geodesic offset from the anchor shared by all parts (the accepted footprint engine's
 * rule, ADR-025). Validation here is immediate feedback only; the server decides with PostGIS and the parity cases in
 * `siteGeometryCases.json` hold both to the same answers.
 */

/** A part of the site: its rings, outer ring first, each without the closing vertex. */
export type Part = Ring[];

const ringOf = (coords: number[][]): Ring => {
  const r = coords.map(([lng, lat]) => ({ lat, lng }));
  const f = r[0];
  const l = r[r.length - 1];
  return r.length > 1 && f.lat === l.lat && f.lng === l.lng ? r.slice(0, -1) : r;
};
const closed = (r: Ring): number[][] => [...r, r[0]].map((p) => [p.lng, p.lat]);

export function partsOf(g: SiteGeometry): Part[] {
  return g.type === 'Polygon' ? [g.coordinates.map(ringOf)] : g.coordinates.map((poly) => poly.map(ringOf));
}

/** The same type back from parts: a Polygon stays a Polygon, a MultiPolygon keeps every part in its order. */
export function toGeometry(type: SiteGeometry['type'], parts: Part[]): SiteGeometry {
  return type === 'Polygon'
    ? ({ type: 'Polygon', coordinates: parts[0].map(closed) } satisfies GeoPolygon)
    : ({ type: 'MultiPolygon', coordinates: parts.map((p) => p.map(closed)) } satisfies GeoMultiPolygon);
}

/**
 * The area of a ring as the server measures it (PostGIS geography, WGS84 spheroid): the spherical area of the accepted
 * engine scaled by the spheroid's local curvature M·N/a² = (1 − e²)/(1 − e² sin²φ)² at the ring's latitude — within a
 * few square metres of the server for sites of this size (siteGeometryCases.json holds PostGIS's own areas).
 */
const E2 = 0.00669437999014;
export function spheroidArea(r: Ring): number {
  const s = Math.sin((centroid(r).lat * Math.PI) / 180);
  const w = 1 - E2 * s * s;
  return (areaM2(r) * (1 - E2)) / (w * w);
}

/** Area of a part: its outer ring less its holes. */
export const partArea = (p: Part): number => Math.max(0, spheroidArea(p[0]) - p.slice(1).reduce((s, h) => s + spheroidArea(h), 0));
export const siteArea = (parts: Part[]): number => parts.reduce((s, p) => s + partArea(p), 0);

/** The anchor every part keeps its offsets from: the area-weighted centroid of the outer rings. */
export function anchorOf(parts: Part[]): LatLng {
  let w = 0;
  let lat = 0;
  let lng = 0;
  for (const p of parts) {
    const a = areaM2(p[0]) || 1e-9;
    const c = centroid(p[0]);
    w += a;
    lat += c.lat * a;
    lng += c.lng * a;
  }
  return w ? { lat: lat / w, lng: lng / w } : centroid(parts[0]?.[0] ?? []);
}

/** The geodesic offset of every vertex of every ring from the anchor: a rigid move rebuilds them around a new anchor. */
export type GroupOffsets = Offsets[][];
export const groupOffsets = (parts: Part[], anchor: LatLng): GroupOffsets => parts.map((p) => p.map((r) => offsetsOf(r, anchor)));
export const rebuildGroup = (offs: GroupOffsets, anchor: LatLng): Part[] => offs.map((p) => p.map((r) => rebuild(r, anchor)));

/** The whole site moved rigidly so that its anchor lands on {@code to}: all parts together, nothing reshaped. */
export function translate(g: SiteGeometry, to: LatLng): SiteGeometry {
  const parts = partsOf(g);
  return toGeometry(g.type, rebuildGroup(groupOffsets(parts, anchorOf(parts)), to));
}

/** One existing vertex of one ring of one part moved; every other part, ring and vertex is the same object as before. */
export function moveVertex(parts: Part[], part: number, ring: number, index: number, p: LatLng): Part[] {
  return parts.map((pt, i) => (i !== part ? pt : pt.map((r, j) => (j !== ring ? r : r.map((v, k) => (k === index ? { ...p } : v))))));
}

// ---- validation -------------------------------------------------------------------------------------------------

type Seg = { a: LatLng; b: LatLng; i: number; minX: number; maxX: number; minY: number; maxY: number };
const orient = (p: LatLng, q: LatLng, r: LatLng) => (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng);
/** Tolerance of the collinear test in squared degrees (about a millimetre at these latitudes): coincidence, not a rule. */
const EPS = 1e-16;
const segsOf = (r: Ring): Seg[] =>
  r.map((a, i) => {
    const b = r[(i + 1) % r.length];
    return { a, b, i, minX: Math.min(a.lng, b.lng), maxX: Math.max(a.lng, b.lng), minY: Math.min(a.lat, b.lat), maxY: Math.max(a.lat, b.lat) };
  });
const crosses = (s: Seg, t: Seg) => {
  const d1 = orient(t.a, t.b, s.a);
  const d2 = orient(t.a, t.b, s.b);
  const d3 = orient(s.a, s.b, t.a);
  const d4 = orient(s.a, s.b, t.b);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
};
/** Two collinear segments sharing a stretch of positive length (a shared edge). */
const overlapsCollinear = (s: Seg, t: Seg) => {
  if (Math.abs(orient(s.a, s.b, t.a)) > EPS || Math.abs(orient(s.a, s.b, t.b)) > EPS) return false;
  const useX = s.maxX - s.minX >= s.maxY - s.minY;
  const [s0, s1] = useX ? [s.minX, s.maxX] : [s.minY, s.maxY];
  const [t0, t1] = useX ? [t.minX, t.maxX] : [t.minY, t.maxY];
  return Math.min(s1, t1) - Math.max(s0, t0) > 1e-9;
};
const boxes = (s: Seg, t: Seg) => s.minX <= t.maxX && t.minX <= s.maxX && s.minY <= t.maxY && t.minY <= s.maxY;

/**
 * Crossings between non-adjacent edges of one ring, or between the edges of two rings: a sweep over longitude so that a
 * dense boundary is not compared edge against every edge.
 */
function conflicts(a: Seg[], b: Seg[] | null, limit = 1): number {
  const all = b ? [...a.map((s) => ({ s, k: 0 })), ...b.map((s) => ({ s, k: 1 }))] : a.map((s) => ({ s, k: 0 }));
  all.sort((x, y) => x.s.minX - y.s.minX);
  const n = a.length;
  const active: { s: Seg; k: number }[] = [];
  let found = 0;
  for (const cur of all) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i].s.maxX < cur.s.minX) active.splice(i, 1);
    for (const o of active) {
      if (b ? o.k === cur.k : false) continue;
      if (!b) {
        const d = Math.abs(o.s.i - cur.s.i);
        if (d === 1 || d === n - 1) continue;
      }
      if (!boxes(o.s, cur.s)) continue;
      if (crosses(o.s, cur.s) || overlapsCollinear(o.s, cur.s)) {
        found++;
        if (found >= limit) return found;
      }
    }
    active.push(cur);
  }
  return found;
}

export type SiteValidation = {
  ok: boolean;
  problems: string[];
  areaM2: number;
  partAreas: number[];
};

const distinct = (r: Ring) => new Set(r.map((p) => p.lat.toFixed(9) + ',' + p.lng.toFixed(9))).size;

/**
 * The client's immediate view of the server's site rules: at least three distinct vertices per ring, no ring without
 * area, no self-crossing, holes inside their part, parts that neither overlap nor share an edge (touching at one point is
 * allowed, as in PostGIS), and the configured maximum footprint. Nothing is repaired.
 */
export function validateSite(parts: Part[], maxAreaM2?: number | null): SiteValidation {
  const problems: string[] = [];
  const many = parts.length > 1;
  const name = (i: number) => (many ? ' (الجزء ' + (i + 1) + ')' : '');
  const segs = parts.map((p) => p.map(segsOf));
  parts.forEach((p, i) => {
    p.forEach((r, j) => {
      if (distinct(r) < 3) problems.push('حلقة بأقل من ثلاثة رؤوس مختلفة' + name(i));
      else if (areaM2(r) < 1) problems.push('حلقة بلا مساحة' + name(i));
      else if (conflicts(segs[i][j], null)) problems.push('حدود متقاطعة ذاتياً' + name(i));
      if (j > 0 && (conflicts(segs[i][0], segs[i][j]) || !r.every((v) => pointInRing(v, p[0])))) problems.push('فجوة تخرج عن حدودها' + name(i));
    });
  });
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const touch = conflicts(segs[i][0], segs[j][0]) > 0;
      // without crossing or shared edges two parts are apart (touching at most at points) or one holds the other
      const inside = !touch && (pointInRing(centroid(parts[j][0]), parts[i][0]) || pointInRing(centroid(parts[i][0]), parts[j][0]));
      if (touch || inside) problems.push('أجزاء الموقع تتداخل أو تشترك في حد (الجزءان ' + (i + 1) + ' و' + (j + 1) + ')');
    }
  }
  const partAreas = parts.map(partArea);
  const area = partAreas.reduce((s, a) => s + a, 0);
  if (maxAreaM2 != null && area > maxAreaM2) problems.push('المساحة تتجاوز الحد الأقصى المعتمد');
  return { ok: problems.length === 0, problems, areaM2: area, partAreas };
}

/**
 * While one vertex is dragged only the two edges that touch it change: they are tested against the other edges of the
 * site, so the live state stays immediate on a dense boundary (the full rules run when the vertex is let go).
 */
export function vertexConflicts(parts: Part[], part: number, ring: number, index: number): boolean {
  const r = parts[part][ring];
  const n = r.length;
  const moved = [segsOf(r)[(index - 1 + n) % n], segsOf(r)[index]];
  for (let i = 0; i < parts.length; i++) {
    for (let j = 0; j < parts[i].length; j++) {
      const others = segsOf(parts[i][j]);
      for (const m of moved) {
        for (const o of others) {
          if (i === part && j === ring) {
            const d = Math.abs(o.i - m.i);
            if (d <= 1 || d === n - 1) continue;
          }
          if (boxes(m, o) && (crosses(m, o) || overlapsCollinear(m, o))) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Undo, redo and reset of the site geometry, as the accepted footprint engine does them: a change pushes the state it
 * replaces; undo and redo swap through two stacks; reset returns to where editing began (the copy, the drawn shape or the
 * saved draft) and is itself undoable. At most 100 steps are kept.
 */
export class SiteHistory<T> {
  private start: T;
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  constructor(start: T) {
    this.start = start;
  }

  /** A new editing session from {@code start}: the stacks are emptied. */
  begin(start: T) {
    this.start = start;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Record {@code current} before it is replaced by a change. */
  push(current: T) {
    this.undoStack.push(current);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: T): T | null {
    const s = this.undoStack.pop();
    if (s === undefined) return null;
    this.redoStack.push(current);
    return s;
  }

  redo(current: T): T | null {
    const s = this.redoStack.pop();
    if (s === undefined) return null;
    this.undoStack.push(current);
    return s;
  }

  reset(current: T): T {
    this.push(current);
    return this.start;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }
}
