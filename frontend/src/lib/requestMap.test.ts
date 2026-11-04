import { describe, expect, it } from 'vitest';
import type { RestationingRequest, SiteGeometry } from '../api/types';
import { pointInRing } from './footprint';
import { requestFeatures } from './requestMap';
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

const request = (current: SiteGeometry, proposed?: SiteGeometry) =>
  ({
    currentSites: [{ unit: 'u', site: { id: 's', name: 'موقع تجريبي' }, geometry: current }],
    content: { site: proposed ? { geometry: proposed } : null, primary: null, alternative: null },
  }) as unknown as RestationingRequest;

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
    const labels = fc.features.filter((f) => f.properties.label);
    expect(labels.map((f) => [f.properties.role, f.geometry.type])).toEqual([
      ['CURRENT', 'Point'],
      ['SITE', 'Point'],
    ]);
    expect(labels[0].properties.label).toBe('موقع تجريبي (الحالي)');
    const shapes = fc.features.filter((f) => !f.properties.label);
    expect(shapes.map((f) => f.geometry)).toEqual([four, two]);
    expect(shapes.every((f) => f.properties.label === undefined)).toBe(true);
  });
});
