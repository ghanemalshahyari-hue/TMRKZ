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

/** The draw action the editor offers when nothing can be copied (owner wording, 4 Nov 2026). */
export const DRAW_NEW_BOUNDARY = 'رسم حدود جديدة';

type CurrentSite = { site: { id: string; name: string }; geometry: { type: string; coordinates: unknown } | null };

/**
 * What «نسخ حدود الموقع الحالي» copies from the chosen units' current sites (owner decision of 4 Nov 2026): a Polygon,
 * or a MultiPolygon WHOLE — every part, in its order, its shapes, areas and places relative to each other — which then
 * moves as one site. Nothing is reduced to one part, merged, hulled or converted. A Point has no footprint to copy and
 * nothing is synthesised around it: the requester draws a new one.
 */
export function copyableBoundary<T extends CurrentSite>(sites: T[]): { copy: T | null; message: string } {
  const boundary = sites.find((s) => s.geometry?.type === 'Polygon' || s.geometry?.type === 'MultiPolygon');
  if (boundary?.geometry?.type === 'MultiPolygon') {
    const n = (boundary.geometry.coordinates as unknown[]).length;
    return { copy: boundary, message: 'نُسخت حدود «' + boundary.site.name + '» كاملة (' + n + ' أجزاء) — اسحب أي جزء: كل أجزاء الموقع ستنتقل معاً' };
  }
  if (boundary) return { copy: boundary, message: 'نُسخت حدود «' + boundary.site.name + '» — اسحب الموقع لنقله بشكله' };
  const point = sites.find((s) => s.geometry?.type === 'Point');
  if (point) return { copy: null, message: '«' + point.site.name + '» مسجل نقطةً بلا حدود، فلا شيء يُنسخ — استخدم «' + DRAW_NEW_BOUNDARY + '»' };
  return { copy: null, message: 'لا حدود مسجلة للموقع الحالي لهذه الوحدات — استخدم «' + DRAW_NEW_BOUNDARY + '»' };
}
