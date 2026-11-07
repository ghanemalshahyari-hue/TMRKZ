import type { GeoJsonGeometry, MapFeature, Ref, SiteGeometry, StationingRecord } from '../api/types';
import { labelPoint } from './siteGeometry';

/**
 * The registered sites as a REFERENCE layer (owner decisions of 5 Nov 2026): every site the server lets this person see,
 * drawn with its registered boundary or, without one, its marker — ONE map object per physical site, however many units
 * are stationed there (a small count in its label, the names in its card). Reference only: the features carry identity
 * and display state, nothing that ranks, recommends or validates a site; the order is the server's; nothing is selected
 * unless the person selects it.
 */
export type RefSite = {
  siteId: string;
  code: string;
  name: string;
  kind: string;
  geometry: GeoJsonGeometry | null;
  lat: number | null;
  lng: number | null;
  responsibleOrg?: Ref;
  /** The site it is registered under (a main site's sub-site), as the register holds it. */
  parentId: string | null;
  /** false when the server gives no geometry or marker for it (known only from a stationing record): listed, not drawn. */
  onMap: boolean;
};

export type SiteRefProps = { role: 'REF_SITE' | 'REF_MARKER' | 'REF_LABEL'; siteId: string; name: string; label: string; sub: string; selected: boolean; related: boolean };
export type SiteRefFeature = GeoJSON.Feature<GeoJSON.Geometry, SiteRefProps>;

const shape = (g: GeoJsonGeometry | null | undefined) => !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon');

/**
 * The sites to show: those of the site register (`/map/features`, the server's order), then the sites known only from a
 * current stationing this person may read. Such a site is drawn as soon as its record carries a geometry or a location
 * (`siteGeometry` / `siteLocation`); until then it is listed as «موقع غير معروض على الخريطة».
 */
export function registeredSites(features: MapFeature[], current: StationingRecord[] = []): RefSite[] {
  const out: RefSite[] = features
    .filter((f) => f.view !== 'CONTEXT')
    .map((f) => ({
      siteId: f.siteId, code: f.code, name: f.name, kind: f.kind, geometry: f.boundary?.geojson ?? null, lat: f.lat, lng: f.lng,
      responsibleOrg: f.responsibleOrg, parentId: f.parentId ?? null, onMap: shape(f.boundary?.geojson) || (f.lat != null && f.lng != null),
    }));
  const seen = new Set(out.map((s) => s.siteId));
  for (const c of current) {
    if (seen.has(c.siteId)) continue;
    seen.add(c.siteId);
    const g = c.siteGeometry ?? null;
    // a marker-only site may come as a Point geometry or as a location
    const pt = g?.type === 'Point' ? (g.coordinates as number[]) : null;
    const loc = c.siteLocation ?? (pt ? { lng: pt[0], lat: pt[1] } : null);
    out.push({ siteId: c.siteId, code: c.siteCode, name: c.siteName, kind: '', geometry: g, lat: loc?.lat ?? null, lng: loc?.lng ?? null, parentId: null, onMap: shape(g) || !!loc });
  }
  return out;
}

/** «وحدة واحدة», «وحدتان», «3 وحدات»: the small count beside a site's name. */
export const unitCount = (n: number) => (n === 1 ? 'وحدة واحدة' : n === 2 ? 'وحدتان' : `${n} وحدات`);

/**
 * {@code currentIds}: the sites a request draws itself as its current site. Each stays ONE object on the map: the request
 * draws its boundary, and this layer its symbol and its one name, saying «الموقع الحالي».
 */
export function siteReferenceFeatures(sites: RefSite[], selectedId: string | null = null, units: Map<string, number> = new Map(), currentIds: ReadonlySet<string> = new Set()): GeoJSON.FeatureCollection<GeoJSON.Geometry, SiteRefProps> {
  const out: SiteRefFeature[] = [];
  // the selected site's family (the site it belongs to and its sub-sites) is marked on the map with it
  const family = selectedId ? familyOf(sites, selectedId) : null;
  const related = new Set([family?.parent?.siteId, ...[...(family?.children ?? []), ...(family?.siblings ?? [])].map((c) => c.siteId)].filter(Boolean));
  for (const s of sites) {
    if (!s.onMap) continue;
    const n = units.get(s.siteId) ?? 0;
    const isCurrent = currentIds.has(s.siteId);
    const sub = [isCurrent ? 'الموقع الحالي' : '', n ? unitCount(n) : ''].filter(Boolean).join(' · ');
    const props = { siteId: s.siteId, name: s.name, label: n ? `${s.name} · ${unitCount(n)}` : s.name, sub, selected: s.siteId === selectedId, related: related.has(s.siteId) };
    if (shape(s.geometry)) {
      const g = s.geometry as unknown as SiteGeometry;
      if (!isCurrent) out.push({ type: 'Feature', geometry: g as GeoJSON.Polygon | GeoJSON.MultiPolygon, properties: { role: 'REF_SITE', ...props } });
      const p = labelPoint(g);
      out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { role: 'REF_LABEL', ...props } });
    } else if (s.lat != null && s.lng != null) {
      out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { role: 'REF_MARKER', ...props } });
    }
  }
  return { type: 'FeatureCollection', features: out };
}

/** Units stationed now per site (each unit once), for the count beside a site's name. */
export function unitsPerSite(current: StationingRecord[]): Map<string, number> {
  const m = new Map<string, Set<string>>();
  for (const c of current) m.set(c.siteId, (m.get(c.siteId) ?? new Set()).add(c.orgId));
  return new Map([...m].map(([k, v]) => [k, v.size]));
}

/** The [west, south, east, north] extent of the sites drawn, or null when there is none. */
export function sitesExtent(fc: GeoJSON.FeatureCollection): [number, number, number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const add = ([x, y]: number[]) => {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === 'Point') add(g.coordinates);
    else if (g.type === 'Polygon') g.coordinates[0].forEach(add);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => p[0].forEach(add));
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export type SiteFamilyView = { parent: RefSite | null; children: RefSite[]; siblings: RefSite[] };

/**
 * A site's family in the register, as the retired «مساحة التمركز» showed it: the site it is registered under, its
 * sub-sites, and the other sites registered under the same main site — by name, among the sites this person may see
 * (a main site the person may not see is never named; its other sub-sites still show together). Reference only.
 */
export function familyOf(sites: RefSite[], siteId: string): SiteFamilyView {
  const site = sites.find((s) => s.siteId === siteId);
  const byName = (a: RefSite, b: RefSite) => a.name.localeCompare(b.name, 'ar');
  return {
    parent: site?.parentId ? sites.find((s) => s.siteId === site.parentId) ?? null : null,
    children: sites.filter((s) => s.parentId === siteId).sort(byName),
    siblings: site?.parentId ? sites.filter((s) => s.parentId === site.parentId && s.siteId !== siteId).sort(byName) : [],
  };
}

