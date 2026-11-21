import type { PostureUnit, PosturePending } from '../api/client';
import { completenessOf, matchesFilter, timingOf, type PostureFilter } from './operationalPostureStatus';

/**
 * Operational site hub (owner, 21 Nov 2026 «REDESIGN OPERATIONAL POSTURE AROUND SITE HUBS»).
 *
 * The strategic overview aggregates by physical SITE, not by unit (brief §1/§5/§36). Each hub carries the counts
 * the map and the right rail both need: how many units live at the site, how many are complete, how many are
 * incomplete, how many are temporary or expiring soon, and how many pending proposals touch the site. The business
 * data — PostureUnit, PosturePending — is untouched; this is a pure projection.
 *
 * `filteredCount` is the number of units at the site that match the active filter. It is what the map hub shows on
 * top of the circle so «WHICH units?» stays legible: e.g. under «مناطق انتشار غير مكتملة», the hub's label counts
 * the incomplete units at this site, not the total population.
 *
 * `hasOutsideReach` reflects the server-side fact that `otherUnitsAtSite` may count stationed units beyond the
 * operator's VIEW_OPERATIONAL_POSTURE reach (ADR-045). Identities are not surfaced — only an aggregate indicator
 * (brief §38).
 */
export type SiteHub = {
  siteId: string;
  siteName: string;
  centroid: [number, number] | null;
  unitIds: string[];
  unitsTotal: number;
  filteredCount: number;
  completeCount: number;
  incompleteCount: number;
  temporaryCount: number;
  expiringCount: number;
  pendingCount: number;
  /** Number of units at this site that have NO site geometry recorded — never applicable here since hubs are drawn from units that DO have a site; included for future use. */
  noGeometryCount: number;
  /** `true` when the site hosts stationed units the operator may not read (server's `otherUnitsAtSite > 0`). */
  hasOutsideReach: boolean;
};

type Geom = { type?: string; coordinates?: unknown } | null | undefined;

/** Rough centroid of a GeoJSON polygon/multipolygon/point — enough to anchor a hub on the map. */
function centreOf(g: Geom): [number, number] | null {
  if (!g || !g.type) return null;
  if (g.type === 'Point') return g.coordinates as [number, number];
  const ring =
    g.type === 'Polygon' ? (g.coordinates as [number, number][][])[0]
    : g.type === 'MultiPolygon' ? ((g.coordinates as [number, number][][][])[0] ?? [])[0]
    : null;
  if (!ring?.length) return null;
  let lng = 0, lat = 0;
  for (const [x, y] of ring) { lng += x; lat += y; }
  return [lng / ring.length, lat / ring.length];
}

/**
 * Build one hub per physical site. A unit without a `site` is not represented here (owner §12: «بلا تمركز» is a
 * separate list, not a geographic marker). Pending counts are rolled up per site by the unit the proposal scopes to.
 */
export function operationalSiteHubs(
  units: readonly PostureUnit[],
  pending: readonly PosturePending[],
  filter: PostureFilter = 'ALL',
  now = Date.now(),
): SiteHub[] {
  const hubs = new Map<string, SiteHub>();
  for (const u of units) {
    if (!u.site) continue;
    let hub = hubs.get(u.site.id);
    if (!hub) {
      hub = {
        siteId: u.site.id,
        siteName: u.site.name,
        centroid: centreOf(u.site.geometry as Geom),
        unitIds: [],
        unitsTotal: 0,
        filteredCount: 0,
        completeCount: 0,
        incompleteCount: 0,
        temporaryCount: 0,
        expiringCount: 0,
        pendingCount: 0,
        noGeometryCount: 0,
        hasOutsideReach: false,
      };
      hubs.set(u.site.id, hub);
    }
    hub.unitIds.push(u.id);
    hub.unitsTotal += 1;
    const c = completenessOf(u);
    if (c === 'COMPLETE') hub.completeCount += 1;
    else if (c === 'INCOMPLETE_DEPLOYMENT') hub.incompleteCount += 1;
    const t = timingOf(u, now);
    if (t === 'TEMPORARY' || t === 'TEMPORARY_EXPIRING') hub.temporaryCount += 1;
    if (t === 'TEMPORARY_EXPIRING') hub.expiringCount += 1;
    if (u.request) hub.pendingCount += 1;
    if ((u.otherUnitsAtSite ?? 0) > 0) hub.hasOutsideReach = true;
    if (matchesFilter(u, filter, now)) hub.filteredCount += 1;
  }
  // Pending projection: each row is scoped to a unit. The `unit.request` summary already contributes to
  // `pendingCount`, so do NOT double-count proposals the operator may also read via `pending[]`.
  // Nothing else is needed here — the hub's pendingCount is finalised above.
  void pending;
  return [...hubs.values()].sort((a, b) => a.siteName.localeCompare(b.siteName, 'ar'));
}

/**
 * Narrow hubs by filter — a hub appears in the map/rail when at least one of its units matches, OR the filter is
 * «REQUESTS» and the hub has a pending count (brief §13: filtering aggregates by site, not by unit).
 */
export function hubsForFilter(hubs: readonly SiteHub[], filter: PostureFilter): SiteHub[] {
  if (filter === 'ALL') return hubs.filter((h) => h.unitsTotal > 0);
  if (filter === 'REQUESTS') return hubs.filter((h) => h.pendingCount > 0);
  return hubs.filter((h) => h.filteredCount > 0);
}

/**
 * «Attention» summary — what should the hub communicate at a glance. Separate from completeness so a single bad
 * unit does not repaint 30 good ones (brief §30/§33).
 */
export type HubAttention = 'OK' | 'INCOMPLETE' | 'TEMPORARY' | 'EXPIRING' | 'PENDING' | 'MIXED';
export function hubAttention(h: SiteHub): HubAttention {
  if (h.expiringCount > 0) return 'EXPIRING';
  if (h.incompleteCount > 0 && h.pendingCount > 0) return 'MIXED';
  if (h.incompleteCount > 0) return 'INCOMPLETE';
  if (h.pendingCount > 0) return 'PENDING';
  if (h.temporaryCount > 0) return 'TEMPORARY';
  return 'OK';
}
