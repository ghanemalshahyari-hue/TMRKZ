import type { Ring } from './footprint';
import { circle, destination, type LatLng } from './geo';

/**
 * Stationing Model V3 (docs/STATIONING_MODEL_V3_AR.md) — preparation for the real «مساحة التمركز» page.
 *
 * Inactive by default: the V3 flow stays hidden from normal users until its schema, permissions, Oracle test, offline
 * map assets, real-touch and owner acceptance have passed (build with VITE_STATIONING_V3=true only for internal tests).
 * Nothing here decides a rule: the server evaluates distances, terrain and occupancy; these helpers draw guidance.
 */
export const STATIONING_V3_ENABLED = import.meta.env.VITE_STATIONING_V3 === 'true';

/** The owner-approved wording shown when a request is paused by an Oracle hierarchy change (O-10, O-16). */
export const HIERARCHY_CHANGED = 'تغير الهيكل التنظيمي بعد تقديم الطلب';

/**
 * The guidance band of a deployment relation: the ALLOWED centre-to-centre distance (O-04) around the reference centre,
 * as an outer and an inner ring for a donut polygon. It is guidance only — never the deployment area itself.
 */
export function guidanceBand(centre: LatLng, effectiveMinM: number, effectiveMaxM: number, steps = 96): { outer: [number, number][]; inner: [number, number][] } {
  return { outer: circle(centre, effectiveMaxM, steps), inner: circle(centre, Math.max(1, effectiveMinM), steps) };
}

/** The simple initial deployment area placed by one click: real polygon geometry (a regular polygon), not a circle object. */
export function simpleArea(centre: LatLng, radiusM: number, steps = 32): Ring {
  return Array.from({ length: steps }, (_, i) => destination(centre, (i / steps) * 360, radiusM));
}
