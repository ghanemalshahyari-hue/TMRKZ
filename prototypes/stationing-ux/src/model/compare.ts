// Comparison of the current stationing, the primary and the alternative proposal (one source for the cards, the request
// editor and the map). Distances are checked against the EXAMPLE policy profile only; the primary is measured from the
// current main site, the alternative from the primary — never from the old site (docs §4.4).
import { areaM2, centroid, formatArea, kinks, ringsIntersect, type Ring } from '../../../../frontend/src/lib/footprint';
import { distanceM, formatKm } from '../../../../frontend/src/lib/geo';
import { SITES, orgById } from '../data';
import { blocking, clashes, permanentOf, type Request, type World } from './domain';
import { PROFILE } from './fixtures';

export const orgName = (id: string) => orgById.get(id)?.name ?? id;
export const siteOf = (w: World, id: string | undefined) => w.sites.find((s) => s.id === id);
export const mainSiteOf = (w: World, org: string) => siteOf(w, permanentOf(w, org)?.siteId);

/**
 * Availability conflicts of a proposed footprint over a period: associated areas and active reservations that overlap in
 * space AND time, except an area whose covered scope includes the organisation (D4, A2); and occupied sites.
 */
export function conflicts(w: World, org: string, ring: Ring, from: number, to: number | undefined): string[] {
  const out = blocking(clashes(w, org, ring, from, to)).map((c) => c.label);
  for (const s of SITES) if (s.status === 'BUSY' && s.ring && ringsIntersect(s.ring, ring)) out.push('موقع محجوز: ' + s.name);
  return out;
}

export type Row = {
  key: 'CURRENT' | 'PRIMARY' | 'ALTERNATIVE';
  title: string;
  name: string;
  ring: Ring;
  dist?: number;
  from?: string;
  range?: { min: number; max: number };
  inRange?: boolean;
  area: string;
  shapeOk: boolean;
  conflicts: string[];
};

export function comparison(w: World, r: Request): Row[] {
  const cur = mainSiteOf(w, r.org) ?? siteOf(w, r.fromSiteId)!;
  const p = r.candidates.PRIMARY;
  const a = r.candidates.ALTERNATIVE;
  const cP = centroid(p.ring);
  const dP = distanceM(centroid(cur.ring), cP);
  const rows: Row[] = [
    { key: 'CURRENT', title: 'التمركز الحالي', name: cur.name, ring: cur.ring, area: formatArea(areaM2(cur.ring)), shapeOk: true, conflicts: [] },
    {
      key: 'PRIMARY',
      title: 'الموقع الرئيسي المقترح',
      name: p.name,
      ring: p.ring,
      dist: dP,
      from: 'من المقر الرئيسي الحالي',
      range: PROFILE.currentToPrimary,
      inRange: dP >= PROFILE.currentToPrimary.min && dP <= PROFILE.currentToPrimary.max,
      area: formatArea(areaM2(p.ring)),
      shapeOk: kinks(p.ring) === 0,
      conflicts: conflicts(w, r.org, p.ring, r.duration.start, r.duration.end),
    },
  ];
  if (a) {
    const dA = distanceM(cP, centroid(a.ring));
    rows.push({
      key: 'ALTERNATIVE',
      title: 'الموقع البديل المقترح',
      name: a.name,
      ring: a.ring,
      dist: dA,
      from: 'من الموقع الرئيسي المقترح',
      range: PROFILE.primaryToAlternative,
      inRange: dA >= PROFILE.primaryToAlternative.min && dA <= PROFILE.primaryToAlternative.max,
      area: formatArea(areaM2(a.ring)),
      shapeOk: kinks(a.ring) === 0,
      conflicts: conflicts(w, r.org, a.ring, r.duration.start, r.duration.end),
    });
  }
  return rows;
}

export const rangeText = (r: { min: number; max: number }) => formatKm(r.min) + ' – ' + formatKm(r.max);
export { formatKm };
