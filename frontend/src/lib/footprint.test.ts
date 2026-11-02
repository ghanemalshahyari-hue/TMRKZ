import { describe, expect, it } from 'vitest';
import { areaM2, centroid, edgeLengths, kinks, mainRing, moveRigid, ringsIntersect, toPolygon, type Ring } from './footprint';
import { distanceM } from './geo';

// a 200 m × 120 m rectangle near Dubai (fictional), counter-clockwise
const rect: Ring = [
  { lat: 25.2, lng: 55.3 },
  { lat: 25.2, lng: 55.30198 },
  { lat: 25.20108, lng: 55.30198 },
  { lat: 25.20108, lng: 55.3 },
];

describe('footprint geometry', () => {
  it('measures a geodesic area close to the expected rectangle', () => {
    expect(areaM2(rect)).toBeGreaterThan(23_000);
    expect(areaM2(rect)).toBeLessThan(25_000);
  });

  it('moves a footprint rigidly: area and edge lengths unchanged, centroid on the target, even far north', () => {
    const far = moveRigid(rect, { lat: 25.3, lng: 55.45 });
    expect(Math.abs(areaM2(far) - areaM2(rect)) / areaM2(rect)).toBeLessThan(0.0005);
    edgeLengths(far).forEach((l, i) => expect(Math.abs(l - edgeLengths(rect)[i])).toBeLessThan(0.5));
    expect(distanceM(centroid(far), { lat: 25.3, lng: 55.45 })).toBeLessThan(0.5);
    // a naive latitude/longitude shift to 60°N would shrink the east–west edges; the rigid move does not
    const north = moveRigid(rect, { lat: 60, lng: 55.3 });
    expect(Math.abs(areaM2(north) - areaM2(rect)) / areaM2(rect)).toBeLessThan(0.002);
  });

  it('finds self-intersection and overlap', () => {
    expect(kinks(rect)).toBe(0);
    expect(kinks([rect[0], rect[2], rect[1], rect[3]])).toBeGreaterThan(0);
    expect(ringsIntersect(rect, moveRigid(rect, { lat: 25.2005, lng: 55.301 }))).toBe(true);
    expect(ringsIntersect(rect, moveRigid(rect, { lat: 25.21, lng: 55.32 }))).toBe(false);
  });

  it('reads the main ring of a registered boundary and writes a closed GeoJSON polygon', () => {
    const g = toPolygon(rect);
    expect((g.coordinates as number[][][])[0]).toHaveLength(5);
    expect(mainRing(g)).toHaveLength(4);
    expect(mainRing({ type: 'Point', coordinates: [55.3, 25.2] })).toBeNull();
  });
});
