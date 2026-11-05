import type { GeoJsonGeometry, SiteGeometry, StationingRecord } from '../api/types';
import { pointInRing, ringsIntersect, type Ring } from './footprint';
import { partsOf } from './siteGeometry';
import type { RefSite } from './sitesLayer';

/**
 * OCCUPIED GROUND while the new site is placed (owner correction of 5 Nov 2026, item 4): the sites where units OTHER than
 * the moving ones are stationed now (the register this person may read). A site where only moving units are stationed
 * is not occupied for this request. Immediate feedback only, on a drop — the server's occupancy check still decides.
 */
export type OccupiedSite = { siteId: string; name: string; units: string[]; geometry: GeoJsonGeometry | null; lat: number | null; lng: number | null };

export function occupiedSites(current: StationingRecord[], sites: RefSite[], moving: string[]): OccupiedSite[] {
  const stay = new Set(moving);
  const bySite = new Map<string, StationingRecord[]>();
  for (const c of current) bySite.set(c.siteId, [...(bySite.get(c.siteId) ?? []), c]);
  const out: OccupiedSite[] = [];
  for (const [siteId, recs] of bySite) {
    const others = recs.filter((r) => !stay.has(r.orgId));
    if (others.length === 0) continue;
    const ref = sites.find((s) => s.siteId === siteId);
    const g = recs.find((r) => r.siteGeometry)?.siteGeometry ?? ref?.geometry ?? null;
    const pt = g?.type === 'Point' ? (g.coordinates as number[]) : null;
    out.push({
      siteId,
      name: ref?.name ?? recs[0].siteName,
      units: [...new Set(others.map((r) => r.orgName))],
      geometry: g && g.type !== 'Point' ? g : null,
      lat: pt ? pt[1] : (ref?.lat ?? null),
      lng: pt ? pt[0] : (ref?.lng ?? null),
    });
  }
  return out;
}

const rings = (g: GeoJsonGeometry | SiteGeometry): Ring[] =>
  g.type === 'Polygon' || g.type === 'MultiPolygon' ? partsOf(g as SiteGeometry).map((p) => p[0]) : [];

/** The occupied sites the proposed geometry overlaps: a boundary sharing area, or a marker inside the proposed site. */
export function overlapsOccupied(proposed: SiteGeometry | null, occupied: OccupiedSite[]): OccupiedSite[] {
  if (!proposed) return [];
  const mine = rings(proposed);
  return occupied.filter((o) =>
    o.geometry
      ? rings(o.geometry).some((r) => mine.some((m) => ringsIntersect(m, r)))
      : o.lat != null && o.lng != null && mine.some((m) => pointInRing({ lat: o.lat!, lng: o.lng! }, m)),
  );
}

/** The occupied sites as map features: a boundary (red hatch and outline) or a red marker, each with its name. */
export function occupiedFeatures(occupied: OccupiedSite[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: occupied.flatMap((o): GeoJSON.Feature[] =>
      o.geometry
        ? [{ type: 'Feature', geometry: o.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon, properties: { role: 'OCC_SITE', name: 'أرض مشغولة: ' + o.name } }]
        : o.lat != null && o.lng != null
          ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lng, o.lat] }, properties: { role: 'OCC_MARKER', name: 'أرض مشغولة: ' + o.name } }]
          : [],
    ),
  };
}
