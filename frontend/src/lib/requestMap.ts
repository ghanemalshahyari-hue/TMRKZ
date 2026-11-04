import type { GeoPolygon, RestationingChecks, RestationingRequest, SiteGeometry } from '../api/types';
import { circle } from './geo';
import { anchorOf, labelPoint, partsOf } from './siteGeometry';

/**
 * What the request map draws (RestationingPage `RequestMap`): the current sites, the proposed site, the deployment areas
 * and their guidance bands. Shapes and names are separate features: every shape carries only its role, and each named
 * site or area has ONE label point (`labelPoint`), so a MultiPolygon is named once however many parts it has
 * (owner gate «PRODUCTION MAP PACKAGING», §6). The geometries are drawn exactly as stored.
 */
export type RequestMapProps = { role: string; label?: string };
export type RequestMapFeature = GeoJSON.Feature<GeoJSON.Geometry, RequestMapProps>;

/** The centre a site or an area is measured from: the shared anchor of every part (a MultiPolygon included). */
export const centre = (g: SiteGeometry) => anchorOf(partsOf(g));

export function requestFeatures(r: RestationingRequest, checks: RestationingChecks | null, hideSite = false): GeoJSON.FeatureCollection<GeoJSON.Geometry, RequestMapProps> {
  const out: RequestMapFeature[] = [];
  const named = (g: SiteGeometry, role: string, label: string) => {
    out.push({ type: 'Feature', geometry: g as GeoJSON.Polygon | GeoJSON.MultiPolygon, properties: { role } });
    const p = labelPoint(g);
    out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { role, label } });
  };
  for (const s of r.currentSites) {
    // a MultiPolygon current site is drawn with every part (owner, 4 Nov 2026); a Point has no footprint to draw
    if (s.geometry?.type === 'Polygon' || s.geometry?.type === 'MultiPolygon') named(s.geometry as SiteGeometry, 'CURRENT', s.site.name + ' (الحالي)');
  }
  const c = r.content;
  // the proposed site as submitted: one Polygon or one MultiPolygon with every part
  if (c.site?.geometry && !hideSite) named(c.site.geometry, 'SITE', 'الموقع المقترح');
  if (c.primary) named(c.primary as GeoPolygon, 'PRIMARY', 'منطقة الانتشار الرئيسية');
  if (c.alternative) named(c.alternative as GeoPolygon, 'ALTERNATIVE', 'منطقة الانتشار البديلة');
  // guidance bands: the allowed centre-to-centre distance around the reference centre — guidance only (O-04)
  const band = (from: SiteGeometry | null | undefined, leg: 'primary' | 'alternative') => {
    const l = checks?.legs?.find((x) => x.leg === leg);
    if (!from || !l) return;
    const ctr = centre(from);
    const outer = circle(ctr, l.effectiveMaxM).map(([lat, lng]) => [lng, lat]);
    const inner = circle(ctr, Math.max(1, l.effectiveMinM)).map(([lat, lng]) => [lng, lat]).reverse();
    out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [outer, inner] }, properties: { role: 'BAND' } });
  };
  band(c.site?.geometry, 'primary');
  band(c.primary, 'alternative');
  return { type: 'FeatureCollection', features: out };
}
