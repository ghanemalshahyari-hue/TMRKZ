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

  // ringsIntersect: "share any area" (owner approval of 3 Nov 2026: identical and coincident geometry must not be missed;
  // touching keeps the documented rule). Shapes in metres east/north of a fictional point near Dubai.
  const m = (x: number, y: number) => ({ lat: 25.2 + y / 111195, lng: 55.3 + x / (111195 * Math.cos((25.2 * Math.PI) / 180)) });
  const sq = (x: number, y: number, w: number, h = w): Ring => [m(x, y), m(x + w, y), m(x + w, y + h), m(x, y + h)];
  const A = sq(0, 0, 100);
  // a U open to the north: arms 0–30 and 70–100, notch 30–70 above y = 40
  const U: Ring = [m(0, 0), m(100, 0), m(100, 100), m(70, 100), m(70, 40), m(30, 40), m(30, 100), m(0, 100)];
  it.each<[string, Ring, Ring, boolean]>([
    ['1 clearly disjoint', A, sq(300, 0, 100), false],
    ['2 crossing (corner over corner)', A, sq(50, 50, 100), true],
    ['2 crossing (a plus sign: no vertex inside the other)', sq(-100, -10, 200, 20), sq(-10, -100, 20, 200), true],
    ['3 contained', sq(-100, -100, 300), sq(20, 20, 40), true],
    ['3 contained, sharing two edges and a corner', A, sq(0, 0, 40), true],
    ['4 identical', A, A.map((p) => ({ ...p })), true],
    ['4 identical, other start vertex', A, [A[2], A[3], A[0], A[1]], true],
    ['4 identical, opposite orientation', A, [...A].reverse(), true],
    ['4 identical, extra collinear vertex', A, [A[0], m(50, 0), A[1], A[2], A[3]], true],
    ['4 identical concave ring', U, [...U], true],
    ['5 partly coincident edges, same side', A, sq(50, 0, 100), true],
    ['5 partly coincident edges, opposite sides', A, sq(100, 50, 100), false],
    ['6 vertex-only touch (corner to corner)', A, sq(100, 100, 100), false],
    ['6 vertex-only touch (apex on an edge)', A, [m(50, 100), m(100, 200), m(0, 200)], false],
    ['7 boundary-only touch (full shared edge)', A, sq(100, 0, 100), false],
    ['7 boundary-only touch, extra vertex on the shared edge', A, [m(100, 0), m(200, 0), m(200, 100), m(100, 100), m(100, 50)], false],
    ['7 boundary-only touch inside a concave notch', U, sq(30, 40, 40, 60), false],
    ['8 near but not touching (0.5 m)', A, sq(100.5, 0, 100), false],
    ['8 near but not touching (5 cm, diagonal)', A, sq(100.05, 100.05, 100), false],
    ['true overlap of 1 cm is not missed', A, sq(99.99, 0, 100), true],
    ['overlap with one arm of a concave ring', U, sq(20, 50, 40), true],
    ['inside the notch, touching nothing', U, sq(40, 60, 20), false],
    ['degenerate: two vertices', A, [m(10, 10), m(20, 20)], false],
    ['degenerate: all vertices on one line', A, [m(10, 10), m(20, 20), m(30, 30)], false],
  ])('ringsIntersect: %s', (_, a, b, shared) => {
    expect(ringsIntersect(a, b)).toBe(shared);
    expect(ringsIntersect(b, a)).toBe(shared);
  });

  it('reads the main ring of a registered boundary and writes a closed GeoJSON polygon', () => {
    const g = toPolygon(rect);
    expect((g.coordinates as number[][][])[0]).toHaveLength(5);
    expect(mainRing(g)).toHaveLength(4);
    expect(mainRing({ type: 'Point', coordinates: [55.3, 25.2] })).toBeNull();
  });
});
