import type { GeoPolygon, RestationingChecks, RestationingLeg, RestationingRequest, SiteGeometry } from '../api/types';
import { bearing, destination, distanceM } from './geo';
import { anchorOf, labelPoint, partsOf } from './siteGeometry';

/**
 * What the request map draws (`RequestMap`): the current sites, the proposed re-stationing site, the deployment areas
 * and their distance connectors. Shapes and names are separate features: every shape carries only its role, and each named
 * site or area has ONE label point (`labelPoint`), so a MultiPolygon is named once however many parts it has
 * (owner gate «PRODUCTION MAP PACKAGING», §6). The geometries are drawn exactly as stored.
 *
 * Distance rules belong to deployment only (owner brief «FULL APPLICATION UI REBUILD», §2–§3, §10–§11):
 * - LEG: centre to centre, the proposed stationing site → PRIMARY area (leg 1) and the primary area → ALTERNATIVE area
 *   (leg 2), a connector labelled with the distance, the allowed range of the server's checks (terrain allowance
 *   included) and whether it is inside it. No range ring (owner decision, 5 Nov 2026: «connector + value + verdict»);
 * - MOVE: the current site → proposed site connection, a neutral line with its distance as information. It has no
 *   range or verdict, because re-stationing has no distance restriction.
 */
export type RequestMapProps = { role: string; label?: string; leg?: 'primary' | 'alternative'; rotate?: number; tone?: 'ok' | 'warn' | 'bad' | 'none' };
export type RequestMapFeature = GeoJSON.Feature<GeoJSON.Geometry, RequestMapProps>;

/** The roles of the named sites and areas (one label point each). */
export const SITE_ROLES = ['CURRENT', 'SITE', 'PRIMARY', 'ALTERNATIVE'] as const;

export const LABELS = {
  CURRENT: 'الموقع الحالي',
  SITE: 'موقع إعادة التمركز',
  PRIMARY: 'منطقة الانتشار الرئيسية',
  ALTERNATIVE: 'منطقة الانتشار البديلة',
} as const;

/** The centre a site or an area is measured from: the shared anchor of every part (a MultiPolygon included). */
export const centre = (g: SiteGeometry) => anchorOf(partsOf(g));

const kmText = (m: number) => (m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 1 }) + ' كم';

/**
 * A deployment leg's distance against its band (the server's last checks; the server decides on save): «6.4 كم ·
 * المسموح 5–8 كم» with the terrain allowance when it extends the maximum, and the verdict.
 */
export function legText(d: number, l: RestationingLeg | undefined): { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' } {
  if (!l) return { text: kmText(d), tone: 'none' };
  const range = `المسموح ${kmText(l.effectiveMinM).replace(' كم', '')}–${kmText(l.baseMaxM)}` + (l.effectiveMaxM !== l.baseMaxM ? ` (حتى ${kmText(l.effectiveMaxM)} مع طبيعة الأرض)` : '');
  const tone = d >= l.effectiveMinM && d <= l.effectiveMaxM ? 'ok' : l.exceptionMaxM != null && d >= l.effectiveMinM && d <= l.exceptionMaxM ? 'warn' : 'bad';
  return { text: `${kmText(d)} · ${range} · ${tone === 'ok' ? 'ضمن النطاق' : tone === 'warn' ? 'يحتاج استثناء' : 'خارج النطاق'}`, tone };
}

export function requestFeatures(r: RestationingRequest, checks: RestationingChecks | null, hideSite = false): GeoJSON.FeatureCollection<GeoJSON.Geometry, RequestMapProps> {
  const out: RequestMapFeature[] = [];
  const point = (lng: number, lat: number, props: RequestMapProps) => out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props });
  const named = (g: SiteGeometry, role: string, label: string) => {
    out.push({ type: 'Feature', geometry: g as GeoJSON.Polygon | GeoJSON.MultiPolygon, properties: { role } });
    const p = labelPoint(g);
    point(p.lng, p.lat, { role, label });
  };
  const current: SiteGeometry[] = [];
  for (const s of r.currentSites) {
    // a MultiPolygon current site is drawn with every part (owner, 4 Nov 2026); a Point has no footprint to draw
    if (s.geometry?.type === 'Polygon' || s.geometry?.type === 'MultiPolygon') {
      named(s.geometry as SiteGeometry, 'CURRENT', `${LABELS.CURRENT} · ${s.site.name}`);
      current.push(s.geometry as SiteGeometry);
    }
  }
  const c = r.content;
  // the proposed site as submitted: one Polygon or one MultiPolygon with every part
  if (c.site?.geometry && !hideSite) named(c.site.geometry, 'SITE', LABELS.SITE);
  if (c.primary) named(c.primary as GeoPolygon, 'PRIMARY', LABELS.PRIMARY);
  if (c.alternative) named(c.alternative as GeoPolygon, 'ALTERNATIVE', LABELS.ALTERNATIVE);
  // the re-stationing move, for information: current site → proposed site, its distance, an arrowhead; no rule
  if (c.site?.geometry) {
    const to = centre(c.site.geometry);
    for (const g of current) {
      const from = centre(g);
      const d = distanceM(from, to);
      if (d < 1) continue;
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }, properties: { role: 'MOVE' } });
      const mid = destination(from, bearing(from, to), d / 2);
      point(mid.lng, mid.lat, { role: 'MOVE_LABEL', label: `المسافة: ${kmText(d)}` });
      // the head stops short of the proposed site's centre, where its label sits
      const head = destination(from, bearing(from, to), d * 0.92);
      point(head.lng, head.lat, { role: 'MOVE_HEAD', rotate: bearing(from, to) });
    }
  }
  // deployment legs, centre to centre (O-04): a connector with its distance, allowed range and verdict — no ring
  const legLine = (from: SiteGeometry | null | undefined, to: SiteGeometry | null | undefined, leg: 'primary' | 'alternative') => {
    if (!from || !to) return;
    const [a, b] = [centre(from), centre(to)];
    const d = distanceM(a, b);
    if (d < 1) return;
    const t = legText(d, checks?.legs?.find((x) => x.leg === leg));
    out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] }, properties: { role: 'LEG', leg, tone: t.tone } });
    const mid = destination(a, bearing(a, b), d / 2);
    point(mid.lng, mid.lat, { role: 'LEG_LABEL', leg, tone: t.tone, label: t.text });
  };
  legLine(c.site?.geometry, c.primary as SiteGeometry | null, 'primary');
  legLine(c.primary as SiteGeometry | null, c.alternative as SiteGeometry | null, 'alternative');
  return { type: 'FeatureCollection', features: out };
}
