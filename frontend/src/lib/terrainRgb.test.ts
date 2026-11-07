import { describe, expect, it } from 'vitest';
import { distanceM } from './geo';
import type { Part } from './siteGeometry';
import { areaSamples, decodeMapbox, elevationStats, insideParts, profileOf, profilePoints, sampleTile, slopePctTile, slopeZones, tileOf, tilesFor, toneOfPct } from './terrainRgb';

/** The builder's encoding (ops/terrain/build_terrain_3d.py encode): v = round((h + 10000) / 0.1). */
const encode = (h: number) => {
  const v = Math.round((h + 10000) / 0.1);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** A 256 px tile whose height is a plane: h = a + bx·x + by·y (pixel centres). */
function planeTile(a: number, bx: number, by: number) {
  const t = new Uint8ClampedArray(256 * 256 * 4);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const [r, g, b] = encode(a + bx * (x + 0.5) + by * (y + 0.5));
      t.set([r, g, b, 255], (y * 256 + x) * 4);
    }
  return t;
}

const square = (lat: number, lng: number, m: number): Part => {
  const dLat = m / 110900;
  const dLng = m / (111320 * Math.cos((lat * Math.PI) / 180));
  return [[{ lat, lng }, { lat, lng: lng + dLng }, { lat: lat + dLat, lng: lng + dLng }, { lat: lat + dLat, lng }]];
};

describe('Terrain-RGB elevations (display only)', () => {
  it('decodes the Mapbox encoding exactly as the builder writes it, to 0.1 m', () => {
    for (const h of [0, 0.1, -16.2, 312.4, 891.7, 2629.1]) expect(decodeMapbox(...(encode(h) as [number, number, number]))).toBeCloseTo(h, 6);
    expect(decodeMapbox(1, 134, 160)).toBeCloseTo(0, 6);
  });

  it('finds the zoom-12 tile and pixel of a point (Web Mercator)', () => {
    const t = tileOf({ lat: 0, lng: 0 });
    expect([t.x, t.y, t.px, t.py]).toEqual([2048, 2048, 0, 0]);
    const h = tileOf({ lat: 24.85, lng: 56.05 });
    expect(h.x).toBe(Math.floor(((56.05 + 180) / 360) * 4096));
    expect(h.px).toBeGreaterThanOrEqual(0);
    expect(h.px).toBeLessThan(256);
  });

  it('interpolates bilinearly between pixel centres and clamps at the tile edge', () => {
    const t = planeTile(500, 2, -1);
    expect(sampleTile(t, 10.5, 20.5)).toBeCloseTo(500 + 21 - 20.5, 1);
    expect(sampleTile(t, 10, 20)).toBeCloseTo(500 + 2 * 10 - 20, 1);
    // beyond the last pixel centre the edge value holds (the neighbour tile is not read)
    expect(sampleTile(t, 256, 0)).toBeCloseTo(500 + 2 * 255.5 - 0.5, 1);
  });

  it('samples an area on a grid inside every part, outside its holes, plus every vertex', () => {
    const a = square(24.8, 56.0, 600);
    const hole: Part = [a[0], square(24.8015, 56.0015, 200)[0]];
    const pts = areaSamples([hole]);
    expect(pts.length).toBeGreaterThan(100);
    expect(pts.filter((p) => !a[0].includes(p)).every((p) => insideParts(p, [hole]))).toBe(true);
    const plain = areaSamples([a]);
    expect(plain.length).toBeGreaterThan(pts.length);
    // a large area is thinned to the limit, never more
    expect(areaSamples([square(24.8, 56.0, 20000)], 400).length).toBeLessThanOrEqual(404);
    // a MultiPolygon: both parts are sampled
    const two = areaSamples([square(24.8, 56.0, 300), square(24.9, 56.1, 300)]);
    expect(two.some((p) => p.lat > 24.85)).toBe(true);
    expect(two.some((p) => p.lat < 24.85)).toBe(true);
  });

  it('reports the lowest, highest and the difference, ignoring missing heights', () => {
    expect(elevationStats([312, null, 892.4, 600])).toEqual({ min: 312, max: 892.4, range: 892.4 - 312, mean: (312 + 892.4 + 600) / 3, samples: 3 });
    expect(elevationStats([null])).toBeNull();
  });

  it('profiles a connector: ends, climb, descent and the steepest stretch over 100 m', () => {
    const a = { lat: 24.8, lng: 56.0 };
    const b = { lat: 24.8, lng: 56.05 };
    const pts = profilePoints(a, b);
    expect(pts[0].d).toBe(0);
    expect(pts.at(-1)!.d).toBeCloseTo(distanceM(a, b), 6);
    expect(pts.length).toBeLessThanOrEqual(161);
    // up 300 m over the first half, down 100 m over the second
    const half = pts.at(-1)!.d / 2;
    const hs = pts.map((p) => (p.d <= half ? 300 + (300 * p.d) / half : 600 - (100 * (p.d - half)) / half));
    const pr = profileOf(pts, hs)!;
    expect(pr.start).toBe(300);
    expect(pr.end).toBeCloseTo(500, 6);
    expect(pr.max).toBeGreaterThan(598); // the peak lies between two samples
    expect(pr.max).toBeLessThanOrEqual(600);
    expect(pr.climb).toBeGreaterThan(298);
    expect(pr.descent).toBeGreaterThan(98);
    expect(pr.maxSlopePct).toBeCloseTo((300 / half) * 100, 1);
  });

  it('groups points by the tile they need', () => {
    const m = tilesFor([{ lat: 24.8, lng: 56.0 }, { lat: 24.8001, lng: 56.0001 }, { lat: 25.3, lng: 55.3 }]);
    expect(m.size).toBe(2);
  });
});

describe('slope inside a shape (display only)', () => {
  const limits = { greenBelowPct: 10, redFromPct: 30 };
  // zoom 12, a tile row at about 24.8° N: one pixel is about 34.7 m
  const z = 12;
  const y = tileOf({ lat: 24.8, lng: 56 }).y;
  const cell = (40075016.686 * Math.cos((24.8 * Math.PI) / 180)) / (256 * 4096);
  const at = (t: Float32Array, x: number, yy: number) => t[yy * 256 + x];
  const site = (lat: number, lng: number, m = 600): Part => [[
    { lat: lat - m / 2 / 110900, lng: lng - m / 2 / 101000 },
    { lat: lat - m / 2 / 110900, lng: lng + m / 2 / 101000 },
    { lat: lat + m / 2 / 110900, lng: lng + m / 2 / 101000 },
    { lat: lat + m / 2 / 110900, lng: lng - m / 2 / 101000 },
  ]];
  const allRects = (fc: GeoJSON.FeatureCollection) => fc.features.flatMap((f) => (f.geometry as GeoJSON.MultiPolygon).coordinates);

  it('reads the slope percent of a plane, without a seam at the tile edge, and leaves sea level empty', () => {
    const t = slopePctTile(planeTile(300, 0.2 * cell, 0.05 * cell), z, y);
    expect(at(t, 128, 128)).toBeCloseTo(Math.hypot(20, 5), 0);
    expect(at(t, 0, 0)).toBeCloseTo(at(t, 128, 128), 0);
    expect(at(t, 255, 128)).toBeCloseTo(at(t, 128, 128), 0);
    expect(at(t, 128, 255)).toBeCloseTo(at(t, 128, 128), 0);
    expect(Number.isNaN(at(slopePctTile(planeTile(0, 0, 0), z, y), 10, 10))).toBe(true);
  });

  it('colours by the administrator\'s limits: a limit belongs to the steeper colour, and the limits can be changed', () => {
    expect([0, 9.99, 10, 29.99, 30, 200].map((p) => toneOfPct(p, limits))).toEqual(['ok', 'ok', 'care', 'care', 'risk', 'risk']);
    expect([4, 6, 20].map((p) => toneOfPct(p, { greenBelowPct: 5, redFromPct: 15 }))).toEqual(['ok', 'care', 'risk']);
    expect([9, 12].map((p) => toneOfPct(p, { greenBelowPct: 10, redFromPct: 10 }))).toEqual(['ok', 'risk']);
    expect(slopeZones([site(24.8, 56)], () => 20, { greenBelowPct: 25, redFromPct: 40 }).tone).toBe('ok');
  });

  it('colours a whole shape by its slope: green on the plain, orange on a hillside, red on a mountain', () => {
    const shape = [site(24.8, 56)];
    for (const [pct, tone] of [[1, 'ok'], [5, 'ok'], [20, 'care'], [45, 'risk']] as const) {
      const z1 = slopeZones(shape, () => pct, limits);
      expect(z1.tone).toBe(tone);
      expect(z1.shares[tone]).toBeCloseTo(100, 5);
      expect(z1.zones.features.map((f) => f.properties!.tone)).toEqual([tone]);
    }
  });

  it('splits the shape where the slope changes, and the colour with the most ground governs', () => {
    const mid = tileOf({ lat: 24.8, lng: 56 });
    const edge = mid.x * 256 + mid.px + 15; // about 500 m east of the centre of a shape 2 km wide: the west is steep
    const shape = [site(24.8, 56, 2000)];
    const z1 = slopeZones(shape, (px) => (px < edge ? 45 : 1), limits);
    expect(z1.shares.ok).toBeGreaterThan(5);
    expect(z1.shares.risk).toBeGreaterThan(z1.shares.ok);
    // the slope is interpolated between elevation pixels, so a sharp step passes through orange in a narrow strip
    expect(z1.shares.care).toBeLessThan(2);
    expect(z1.shares.ok + z1.shares.care + z1.shares.risk).toBeCloseTo(100, 5);
    expect(z1.tone).toBe('risk');
    expect(z1.zones.features.map((f) => f.properties!.tone).sort()).toEqual(['care', 'ok', 'risk']);
  });

  it('stays exactly inside the shape: outside a triangle nothing is coloured, and a hole stays empty', () => {
    const tri: Part = [[{ lat: 24.79, lng: 55.99 }, { lat: 24.79, lng: 56.01 }, { lat: 24.81, lng: 56 }]];
    const rects = allRects(slopeZones([tri], () => 45, limits).zones);
    expect(rects.length).toBeGreaterThan(20);
    for (const [ring] of rects) {
      const [lngs, lats] = [ring.map((c) => c[0]), ring.map((c) => c[1])];
      const c = { lng: (Math.min(...lngs) + Math.max(...lngs)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 };
      expect(insideParts(c, [tri])).toBe(true);
    }
    const outer = site(24.8, 56, 2000)[0];
    const hole = site(24.8, 56, 800)[0];
    const holed = allRects(slopeZones([[outer, hole]], () => 45, limits).zones);
    for (const [ring] of holed) {
      const [lngs, lats] = [ring.map((c) => c[0]), ring.map((c) => c[1])];
      expect(insideParts({ lng: (Math.min(...lngs) + Math.max(...lngs)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 }, [[hole]])).toBe(false);
    }
  });

  it('colours every part of a MultiPolygon, and says nothing with no shape or no data', () => {
    const two = slopeZones([site(24.8, 56), site(24.82, 56.02)], () => 1, limits);
    const lats = allRects(two.zones).map(([r]) => r[0][1]);
    expect(Math.min(...lats)).toBeLessThan(24.81);
    expect(Math.max(...lats)).toBeGreaterThan(24.81);
    expect(slopeZones([], () => 1, limits).tone).toBeNull();
    const empty = slopeZones([site(24.8, 56)], () => NaN, limits);
    expect(empty.tone).toBeNull();
    expect(empty.zones.features).toEqual([]);
  });

  it('is cheap enough for every frame of a drag, even with 1,500 vertices', () => {
    const ring = Array.from({ length: 1500 }, (_, i) => {
      const a = (i / 1500) * 2 * Math.PI;
      return { lat: 24.8 + 0.01 * Math.sin(a), lng: 56 + 0.01 * Math.cos(a) };
    });
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) slopeZones([[ring]], (px, py) => ((px + py) % 40) * 1.2, limits);
    expect((performance.now() - t0) / 5).toBeLessThan(40);
  });
});
