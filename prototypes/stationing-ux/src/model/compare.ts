// The current stationing beside the ONE proposed re-stationing site and its deployment package (one source for the cards,
// the request editor and the map). The proposed site has no distance rule from the current stationing — its distance is
// shown for information only; the configured relations belong to the deployment areas (owner correction of 3 Nov 2026).
import { areaM2, formatArea, kinks, ringsIntersect, type Ring } from '../../../../frontend/src/lib/footprint';
import { formatKm } from '../../../../frontend/src/lib/geo';
import { SITES } from '../data';
import { blocking, clashes, footprintCheck, orgName, permanentOf, proposalAreas, type AreaCheck, type Range, type Request, type World } from './domain';
import { centreDistance, nearest } from './geometry';

export { orgName };
export const siteOf = (w: World, id: string | undefined) => w.sites.find((s) => s.id === id);
export const mainSiteOf = (w: World, org: string) => siteOf(w, permanentOf(w, org)?.siteId);

/**
 * Availability conflicts of a proposed footprint over a period: deployment areas and active reservations that overlap in
 * space AND time, except an area whose covered scope includes the organisation (D4, A2); and occupied sites.
 */
export function conflicts(w: World, org: string, ring: Ring, from: number, to: number | undefined): string[] {
  const out = blocking(clashes(w, org, ring, from, to)).map((c) => c.label);
  for (const s of SITES) if (s.status === 'BUSY' && s.ring && ringsIntersect(s.ring, ring)) out.push('موقع محجوز: ' + s.name);
  return out;
}

export type Comparison = {
  current: { name: string; ring: Ring; area: string };
  proposed: {
    name: string;
    ring: Ring;
    /** Shortest distance from the current site, and centre to centre — both for information only. */
    fromCurrent: number;
    fromCurrentCentre: number;
    area: number;
    max: number;
    maxVersion: number;
    areaOk: boolean;
    shapeOk: boolean;
    conflicts: string[];
  };
  areas: AreaCheck;
};

export function comparison(w: World, r: Request): Comparison {
  const cur = mainSiteOf(w, r.org) ?? siteOf(w, r.fromSiteId)!;
  const fp = footprintCheck(w, r);
  return {
    current: { name: cur.name, ring: cur.ring, area: formatArea(areaM2(cur.ring)) },
    proposed: {
      name: r.proposal.name,
      ring: r.proposal.ring,
      fromCurrent: nearest(cur.ring, r.proposal.ring).dist,
      fromCurrentCentre: centreDistance(cur.ring, r.proposal.ring),
      area: fp.area,
      max: fp.max,
      maxVersion: fp.version,
      areaOk: fp.ok,
      shapeOk: kinks(r.proposal.ring) === 0,
      conflicts: conflicts(w, r.org, r.proposal.ring, r.duration.start, r.duration.end),
    },
    areas: proposalAreas(w, r),
  };
}

export const rangeText = (r: Range) => formatKm(r.min) + ' – ' + formatKm(r.max);
export { formatKm, formatArea };
