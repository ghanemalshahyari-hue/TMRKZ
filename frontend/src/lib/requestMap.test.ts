import { describe, expect, it } from 'vitest';
import type { RestationingChecks, RestationingRequest, SiteGeometry } from '../api/types';
import { pointInRing } from './footprint';
import { distanceM } from './geo';
import { LABELS, SITE_ROLES, centre, legText, requestFeatures } from './requestMap';
import { labelPoint, partArea, partsOf } from './siteGeometry';

const square = (lng: number, lat: number, d = 0.002): number[][] => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]];
/** Two parts 30 m apart (site 05's layout) and a four-part site whose third part is the largest. */
const two: SiteGeometry = { type: 'MultiPolygon', coordinates: [[square(55.3, 25.2)], [square(55.3023, 25.2)]] };
const four: SiteGeometry = {
  type: 'MultiPolygon',
  coordinates: [[square(55.4, 25.229, 0.001)], [square(55.402, 25.229, 0.0012)], [square(55.4, 25.231, 0.0018)], [square(55.4025, 25.2315, 0.0009)]],
};
/** A U: its centroid lies in the notch, outside the shape. */
const u: SiteGeometry = { type: 'Polygon', coordinates: [[[55.3, 25.2], [55.306, 25.2], [55.306, 25.206], [55.304, 25.206], [55.304, 25.202], [55.302, 25.202], [55.302, 25.206], [55.3, 25.206], [55.3, 25.2]]] };
const holed: SiteGeometry = { type: 'Polygon', coordinates: [square(55.3, 25.2, 0.006), square(55.302, 25.202, 0.002).reverse()] };

const insidePart = (g: SiteGeometry) => {
  const p = labelPoint(g);
  return partsOf(g).findIndex((part) => pointInRing(p, part[0]) && !part.slice(1).some((hole) => pointInRing(p, hole)));
};

const request = (current: SiteGeometry, proposed?: SiteGeometry, areas: { primary?: SiteGeometry; alternative?: SiteGeometry } = {}) =>
  ({
    currentSites: [{ unit: 'u', site: { id: 's', name: 'موقع تجريبي' }, geometry: current }],
    content: { site: proposed ? { geometry: proposed } : null, primary: areas.primary ?? null, alternative: areas.alternative ?? null },
  }) as unknown as RestationingRequest;

const leg = (k: 'primary' | 'alternative', min: number, max: number) => ({ leg: k, label: k, status: 'OK', distanceM: 1, baseMinM: min, baseMaxM: max, effectiveMinM: min, effectiveMaxM: max, exceptionMaxM: null, method: 'NEAREST_GEOMETRY', conflicts: [] });
const checks = { ok: true, problems: [], policyVersion: 1, legs: [leg('primary', 5000, 8000), leg('alternative', 3000, 5000)] } as unknown as RestationingChecks;

describe('one label per logical site (map packaging gate, §6)', () => {
  it('puts the label inside the largest part of a MultiPolygon, never in the gap between parts', () => {
    expect(insidePart(two)).toBe(0); // equal areas: the first part
    const largest = partsOf(four).reduce((b, p, i, all) => (partArea(p) > partArea(all[b]) ? i : b), 0);
    expect(largest).toBe(2);
    expect(insidePart(four)).toBe(2);
  });

  it('keeps the label inside a concave shape and out of a hole', () => {
    expect(insidePart(u)).toBe(0);
    expect(insidePart(holed)).toBe(0);
  });

  it('is deterministic: the same geometry gives the same point', () => {
    expect(labelPoint(four)).toEqual(labelPoint(JSON.parse(JSON.stringify(four)) as SiteGeometry));
  });

  it('gives a MultiPolygon site ONE label feature and leaves its geometry exactly as stored', () => {
    const fc = requestFeatures(request(four, two), null);
    const labels = fc.features.filter((f) => f.properties.label && (SITE_ROLES as readonly string[]).includes(f.properties.role));
    expect(labels.map((f) => [f.properties.role, f.geometry.type])).toEqual([
      ['CURRENT', 'Point'],
      ['SITE', 'Point'],
    ]);
    expect(labels[0].properties.label).toBe(`${LABELS.CURRENT} · موقع تجريبي`);
    expect(labels[1].properties.label).toBe(LABELS.SITE);
    const shapes = fc.features.filter((f) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
    expect(shapes.map((f) => f.geometry)).toEqual([four, two]);
    expect(shapes.every((f) => f.properties.label === undefined)).toBe(true);
  });
});

describe('re-stationing has no distance rule; deployment legs are connectors, never rings (owner, 5 Nov 2026)', () => {
  const far: SiteGeometry = { type: 'Polygon', coordinates: [square(55.9, 25.6)] }; // ~60 km from `two`
  const primary: SiteGeometry = { type: 'Polygon', coordinates: [square(55.95, 25.6)] };
  const alternative: SiteGeometry = { type: 'Polygon', coordinates: [square(55.98, 25.62)] };
  const ring = (fc: ReturnType<typeof requestFeatures>) => fc.features.some((f) => f.properties.role === 'BAND' || f.properties.role === 'BAND_LABEL');

  it('draws the current → proposed move as a neutral line with its distance as information, never a range', () => {
    const plain = requestFeatures(request(two, far), null);
    expect(plain.features.filter((f) => f.properties.role === 'MOVE')).toHaveLength(1);
    expect(plain.features.find((f) => f.properties.role === 'MOVE_LABEL')!.properties.label!).toMatch(/^المسافة: .+ كم$/);
    // with the deployment checks loaded nothing changes on the move, and there is no ring anywhere
    const fc = requestFeatures(request(two, far), checks);
    expect(ring(fc) || fc.features.some((f) => f.properties.role.startsWith('LEG'))).toBe(false);
    for (const f of fc.features.filter((x) => x.properties.role.startsWith('MOVE'))) expect(f.properties.leg).toBeUndefined();
  });

  it('measures leg 1 from the proposed stationing site and leg 2 from the primary area, with range and verdict', () => {
    const fc = requestFeatures(request(two, far, { primary, alternative }), checks);
    expect(ring(fc)).toBe(false);
    const legs = fc.features.filter((f) => f.properties.role === 'LEG');
    expect(legs.map((l) => l.properties.leg)).toEqual(['primary', 'alternative']);
    const ends = (l: (typeof legs)[number]) => (l.geometry as GeoJSON.LineString).coordinates.map(([lng, lat]) => ({ lng, lat }));
    expect(distanceM(ends(legs[0])[0], centre(far))).toBeLessThan(1);
    expect(distanceM(ends(legs[0])[1], centre(primary))).toBeLessThan(1);
    expect(distanceM(ends(legs[1])[0], centre(primary))).toBeLessThan(1);
    expect(distanceM(ends(legs[1])[1], centre(alternative))).toBeLessThan(1);
    const d1 = distanceM(centre(far), centre(primary));
    const labels = fc.features.filter((f) => f.properties.role === 'LEG_LABEL');
    expect(labels[0].properties.label).toBe(legText(d1, checks.legs![0]).text);
    expect(labels[0].properties.label).toMatch(/^.+ كم · المسموح 5–8 كم · (ضمن النطاق|خارج النطاق)$/);
    expect(labels[1].properties.label).toMatch(/المسموح 3–5 كم/);
    expect(labels.map((l) => l.properties.label).join(' ')).not.toContain('إعادة التمركز');
  });

  it('gives the verdict from the band: inside, with an exception, outside; the terrain allowance extends the maximum', () => {
    const l = { ...checks.legs![0], baseMinM: 5000, baseMaxM: 8000, effectiveMinM: 5000, effectiveMaxM: 9000, exceptionMaxM: 10_000 };
    expect(legText(6400, l)).toEqual({ text: '6.4 كم · المسموح 5–8 كم (حتى 9 كم مع طبيعة الأرض) · ضمن النطاق', tone: 'ok' });
    expect(legText(9500, l).tone).toBe('warn');
    expect(legText(4000, l).tone).toBe('bad');
    expect(legText(12_000, l).tone).toBe('bad');
    expect(legText(6400, undefined)).toEqual({ text: '6.4 كم', tone: 'none' });
  });

  it('shows no leg until its area exists', () => {
    expect(requestFeatures(request(two, far), checks).features.some((f) => f.properties.role === 'LEG')).toBe(false);
    const primaryOnly = requestFeatures(request(two, far, { primary }), checks);
    expect(primaryOnly.features.filter((f) => f.properties.role === 'LEG').map((f) => f.properties.leg)).toEqual(['primary']);
  });
});
