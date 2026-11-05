import { edgeLengths, type Ring } from './footprint';
import type { LatLng } from './geo';
import { partArea, validateSite } from './siteGeometry';

/**
 * Drawing a new boundary on the map, vertex by vertex (owner correction of 5 Nov 2026; the retired page's draw mode,
 * ADR-025): each click adds a vertex; the shape closes on the first vertex, a double-click, Enter or «إنهاء الرسم» once
 * it has three; Backspace or «تراجع» removes the last vertex; Esc cancels. The live readout gives the side lengths, the
 * area and whether the closed shape is valid (no self-crossing). Pure state; the map editor draws it.
 */
export type DrawState = { vertices: LatLng[] };
export type DrawReadout = { count: number; sides: number[]; areaM2: number; ok: boolean; problems: string[]; canFinish: boolean };

export const startDraw = (): DrawState => ({ vertices: [] });

/** A click: a new vertex, or — on the first vertex once there are three — the request to finish. */
export function clickVertex(s: DrawState, p: LatLng, onFirst: boolean): { state: DrawState; finish: boolean } {
  if (onFirst && s.vertices.length >= 3) return { state: s, finish: true };
  const last = s.vertices.at(-1);
  // a second click on the same point (the two clicks of a double-click) adds nothing
  if (last && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lng - p.lng) < 1e-9) return { state: s, finish: false };
  return { state: { vertices: [...s.vertices, { ...p }] }, finish: false };
}

export const removeLast = (s: DrawState): DrawState => ({ vertices: s.vertices.slice(0, -1) });

/** The readout of the shape so far, closed back to its first vertex (sides: one per edge, the closing edge last). */
export function readout(s: DrawState, maxAreaM2?: number | null): DrawReadout {
  const ring: Ring = s.vertices;
  const count = ring.length;
  if (count < 3) return { count, sides: count === 2 ? [edgeLengths(ring)[0]] : [], areaM2: 0, ok: false, problems: [], canFinish: false };
  const v = validateSite([[ring]], maxAreaM2);
  return { count, sides: edgeLengths(ring), areaM2: partArea([ring]), ok: v.ok, problems: v.problems, canFinish: v.ok };
}

/** The finished ring, or null when it cannot close (fewer than three vertices, or crossing itself). */
export function finishDraw(s: DrawState, maxAreaM2?: number | null): Ring | null {
  const r = readout(s, maxAreaM2);
  // the maximum area is the server's rule and stays a warning; only a shape that is not a polygon cannot finish
  return r.count >= 3 && !r.problems.some((p) => !p.includes('المساحة')) ? s.vertices.map((v) => ({ ...v })) : null;
}

/** «123 م» / «1.24 كم»: the length written beside each side. */
export const sideLabel = (m: number) => (m < 1000 ? `${Math.round(m).toLocaleString('ar-AE')} م` : `${(m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 2 })} كم`);
