import type { GeoPolygon } from '../api/types';
import { destination, type LatLng } from './geo';

/**
 * The initial footprint of a deployment area placed by one map click («تحديد المنطقة على الخريطة», owner decision of
 * 5 Nov 2026). It is a policy value (`deploymentAreaDefault` of the Stationing policy in force), never a rule of the
 * editor: a click only puts a starting shape there, which the requester then drags and edits.
 */
export type AreaDefault = { shape: 'SQUARE' | 'CIRCLE'; areaM2: number };

export type AreaDefaultSource = 'POLICY' | 'NONE';

/**
 * The value a click uses, and where it comes from. Only the policy in force gives it — an acceptance environment
 * publishes its own labelled test value as a policy version — and there is no fallback anywhere (owner, 5 Nov 2026):
 * NONE means click placement is not offered, drawing still is.
 */
export function resolveAreaDefault(policy: AreaDefault | null | undefined): { value: AreaDefault | null; source: AreaDefaultSource } {
  if (policy && policy.areaM2 > 0 && (policy.shape === 'SQUARE' || policy.shape === 'CIRCLE')) return { value: policy, source: 'POLICY' };
  return { value: null, source: 'NONE' };
}

/** How the value reads on the page: «مربع 90,000 م² (300 م × 300 م)» / «دائرة 90,000 م²». */
export function describeAreaDefault(d: AreaDefault): string {
  const area = Math.round(d.areaM2).toLocaleString('ar-AE') + ' م²';
  if (d.shape === 'CIRCLE') return 'دائرة ' + area;
  const side = Math.round(Math.sqrt(d.areaM2)).toLocaleString('ar-AE');
  return `مربع ${area} (${side} م × ${side} م)`;
}

/**
 * The starting area centred on the clicked point: a north-aligned square of that area, or a regular 16-sided polygon of
 * that area for a «circle» (so its vertices can be edited like any boundary). Geodesic, like the editor's moves.
 */
export function initialArea(c: LatLng, d: AreaDefault): GeoPolygon {
  const n = d.shape === 'CIRCLE' ? 16 : 4;
  // circumradius of a regular n-gon of area A: A = n/2 · R² · sin(2π/n)
  const r = Math.sqrt((2 * d.areaM2) / (n * Math.sin((2 * Math.PI) / n)));
  const first = d.shape === 'CIRCLE' ? 0 : 45;
  const ring = Array.from({ length: n }, (_, i) => destination(c, first + (360 * i) / n, r)).map((p) => [p.lng, p.lat]);
  return { type: 'Polygon', coordinates: [[...ring, ring[0]]] };
}
