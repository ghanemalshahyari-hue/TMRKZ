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
 * What «نسخ حدود الموقع الحالي» can copy from the chosen units' current sites. Only a Polygon is copied today. A
 * MultiPolygon is copied whole and moved as one group in the owner's target behaviour, which is not built yet, so it is
 * never reduced to one part, merged or hulled: the editor falls back to drawing and says so. A Point has no footprint
 * to copy and nothing is synthesised around it.
 */
export function copyableBoundary<T extends CurrentSite>(sites: T[]): { copy: T | null; message: string } {
  const polygon = sites.find((s) => s.geometry?.type === 'Polygon');
  if (polygon) return { copy: polygon, message: 'نُسخت حدود «' + polygon.site.name + '» — انقر على الخريطة حيث تريد نقلها' };
  const multi = sites.find((s) => s.geometry?.type === 'MultiPolygon');
  if (multi) {
    return { copy: null, message: 'حدود «' + multi.site.name + '» متعددة الأجزاء؛ نسخها مجموعةً واحدة لم يُنفَّذ بعد — استخدم «' + DRAW_NEW_BOUNDARY + '»' };
  }
  const point = sites.find((s) => s.geometry?.type === 'Point');
  if (point) return { copy: null, message: '«' + point.site.name + '» مسجل نقطةً بلا حدود، فلا شيء يُنسخ — استخدم «' + DRAW_NEW_BOUNDARY + '»' };
  return { copy: null, message: 'لا حدود مسجلة للموقع الحالي لهذه الوحدات — استخدم «' + DRAW_NEW_BOUNDARY + '»' };
}
