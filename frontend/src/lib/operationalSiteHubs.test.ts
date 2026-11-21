import { describe, expect, it } from 'vitest';
import type { PostureUnit } from '../api/client';
import { EXPIRING_DAYS } from './operationalPostureStatus';
import { hubAttention, hubsForFilter, operationalSiteHubs } from './operationalSiteHubs';

/**
 * Site-hub adapter tests (owner, 21 Nov 2026 «REDESIGN OPERATIONAL POSTURE AROUND SITE HUBS»): the strategic
 * overview aggregates by physical SITE, not by unit — this is the backbone the map and the right rail both read.
 * Mirrors brief §1/§5/§13/§30/§33/§36 — one hub per site, filtered counts, attention never explodes complete
 * populations into incomplete ones.
 */

const g = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } as const;

const site = (id: string, name: string) => ({ id, name, geometry: g as PostureUnit['site'] extends infer S ? S extends { geometry: infer G } ? G : never : never });

const unit = (over: Partial<PostureUnit>): PostureUnit => ({
  id: 'u', code: 'U', name: 'الوحدة', parentId: null, depth: 0, state: 'STATIONED',
  kind: 'PERMANENT', plannedEnd: null, primary: null, alternative: null,
  site: null, otherUnitsAtSite: 0, request: null,
  ...over,
});

describe('operationalSiteHubs — aggregate posture by physical site', () => {
  const siteA = site('A', 'معسكر الاتحاد');
  const siteB = site('B', 'موقع وادي الشرق');
  const complete1 = unit({ id: 'u1', site: siteA, primary: g, alternative: g });
  const complete2 = unit({ id: 'u2', site: siteA, primary: g, alternative: g });
  const incomplete1 = unit({ id: 'u3', site: siteA, primary: g, alternative: null });
  const incomplete2 = unit({ id: 'u4', site: siteA, primary: null, alternative: null });
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const temp = unit({ id: 'u5', site: siteB, primary: g, alternative: g, kind: 'TEMPORARY', plannedEnd: soon });
  const withRequest = unit({ id: 'u6', site: siteB, primary: g, alternative: g, request: { purpose: 'DEPLOYMENT_AREAS', state: 'UNDER_REVIEW' } });
  const noStation = unit({ id: 'u7' });
  const units = [complete1, complete2, incomplete1, incomplete2, temp, withRequest, noStation];

  it('HUB-01: one hub per physical site; units without a site are never a hub (owner §12)', () => {
    const hubs = operationalSiteHubs(units, []);
    expect(hubs).toHaveLength(2);
    expect(hubs.map((h) => h.siteId).sort()).toEqual(['A', 'B']);
  });

  it('HUB-02: counts roll up per site — total, complete, incomplete, temporary, expiring, pending', () => {
    const [a, b] = operationalSiteHubs(units, []);
    expect(a).toMatchObject({ siteId: 'A', unitsTotal: 4, completeCount: 2, incompleteCount: 2, temporaryCount: 0 });
    expect(b).toMatchObject({ siteId: 'B', unitsTotal: 2, completeCount: 2, incompleteCount: 0, temporaryCount: 1, expiringCount: 1, pendingCount: 1 });
  });

  it(`HUB-03: expiring uses the shared ${EXPIRING_DAYS}-day threshold from operationalPostureStatus`, () => {
    const far = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const farTemp = unit({ id: 'x', site: siteB, primary: g, alternative: g, kind: 'TEMPORARY', plannedEnd: far });
    const [, b] = operationalSiteHubs([complete1, farTemp], []);
    expect(b.temporaryCount).toBe(1);
    expect(b.expiringCount).toBe(0);
  });

  it('HUB-04: pending is counted from the unit\'s own `.request` summary (visible to every POSTURE_VIEWER); no identity leaks', () => {
    // The pending array may carry the SAME request this operator can read — the function must not double-count.
    const h = operationalSiteHubs([withRequest], [{
      requestId: 'r1', requestNumber: 'RS-1', purpose: 'DEPLOYMENT_AREAS', state: 'UNDER_REVIEW', currentStage: null,
      unitId: 'u6', unitCode: 'U6', unitName: 'وحدة', currentSiteId: 'B',
      proposedSite: null, proposedPrimary: null, proposedSub: null,
    }]);
    expect(h[0].pendingCount).toBe(1);
  });

  it('HUB-05: `hasOutsideReach` goes true when the site hosts units beyond the operator\'s VIEW_OPERATIONAL_POSTURE reach', () => {
    const scoped = unit({ id: 'z', site: siteA, primary: g, alternative: g, otherUnitsAtSite: 2 });
    const [a] = operationalSiteHubs([scoped], []);
    expect(a.hasOutsideReach).toBe(true);
  });

  it('HUB-06: `filteredCount` is the count of units matching the ACTIVE filter — so the hub label stays legible', () => {
    const all = operationalSiteHubs(units, [], 'ALL');
    expect(all.find((h) => h.siteId === 'A')?.filteredCount).toBe(4);
    const inc = operationalSiteHubs(units, [], 'INCOMPLETE');
    expect(inc.find((h) => h.siteId === 'A')?.filteredCount).toBe(2);
    expect(inc.find((h) => h.siteId === 'B')?.filteredCount).toBe(0);
  });

  it('HUB-07: `hubsForFilter` narrows the map population to sites the filter still names', () => {
    const all = operationalSiteHubs(units, [], 'INCOMPLETE');
    expect(hubsForFilter(all, 'INCOMPLETE').map((h) => h.siteId)).toEqual(['A']);
    const req = operationalSiteHubs(units, [], 'REQUESTS');
    expect(hubsForFilter(req, 'REQUESTS').map((h) => h.siteId)).toEqual(['B']);
  });

  it('HUB-08: attention never promotes a mostly-complete site to a single colour — a separate category per issue (owner §30/§33)', () => {
    const okHub = operationalSiteHubs([complete1, complete2], [])[0];
    expect(hubAttention(okHub)).toBe('OK');
    const [a, b] = operationalSiteHubs(units, []);
    expect(hubAttention(a)).toBe('INCOMPLETE');
    expect(hubAttention(b)).toBe('EXPIRING');
  });
});
