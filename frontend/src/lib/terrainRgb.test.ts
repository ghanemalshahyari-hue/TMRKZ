import { describe, expect, it } from 'vitest';
import { distanceM } from './geo';
import type { Part } from './siteGeometry';
import { areaSamples, decodeMapbox, elevationStats, insideParts, profileOf, profilePoints, sampleTile, slopeTileImage, tileOf, tilesFor } from './terrainRgb';

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

describe('slope classes of an elevation tile (display only)', () => {
  const bands = [
    { code: 'FLAT', label: 'مستوٍ', fromPct: 0, toPct: 2 },
    { code: 'UNDULATING', label: 'متموّج', fromPct: 2, toPct: 10 },
    { code: 'ROLLING', label: 'متدرجة', fromPct: 10, toPct: 15 },
    { code: 'HILLY', label: 'تلال', fromPct: 15, toPct: 30 },
    { code: 'MOUNTAINOUS', label: 'جبلي', fromPct: 30, toPct: null },
  ];
  // zoom 12, a tile row at about 24.8° N: one pixel is about 34.7 m
  const z = 12;
  const y = tileOf({ lat: 24.8, lng: 56 }).y;
  const cell = (40075016.686 * Math.cos((24.8 * Math.PI) / 180)) / (256 * 4096);
  const colourAt = (img: Uint8ClampedArray, x: number, yy: number) => Array.from(img.slice((yy * 256 + x) * 4, (yy * 256 + x) * 4 + 4));

  it('colours each pixel by the policy class of its slope: green flat … red mountainous', async () => {
    const { bandColours } = await import('./terrainRgb');
    const c = bandColours(5);
    expect(colourAt(slopeTileImage(planeTile(300, 0, 0), z, y, bands), 128, 128)).toEqual([...c[0], 150]);
    // 5 % east-west → UNDULATING; 20 % → HILLY; 60 % → MOUNTAINOUS
    expect(colourAt(slopeTileImage(planeTile(300, 0.05 * cell, 0), z, y, bands), 128, 128)).toEqual([...c[1], 150]);
    expect(colourAt(slopeTileImage(planeTile(300, 0.2 * cell, 0), z, y, bands), 128, 128)).toEqual([...c[3], 150]);
    expect(colourAt(slopeTileImage(planeTile(300, 0, 0.6 * cell), z, y, bands), 128, 128)).toEqual([...c[4], 150]);
  });

  it('has no seam: a pixel on the tile edge gets the same class as the interior', () => {
    const img = slopeTileImage(planeTile(300, 0.2 * cell, 0.05 * cell), z, y, bands);
    expect(colourAt(img, 0, 0)).toEqual(colourAt(img, 128, 128));
    expect(colourAt(img, 255, 128)).toEqual(colourAt(img, 128, 128));
    expect(colourAt(img, 128, 255)).toEqual(colourAt(img, 128, 128));
  });

  it('leaves sea level clear and spreads any number of classes over the ramp', async () => {
    const { bandColours, SLOPE_RAMP } = await import('./terrainRgb');
    expect(colourAt(slopeTileImage(planeTile(0, 0, 0), z, y, bands), 10, 10)).toEqual([0, 0, 0, 0]);
    expect(bandColours(3)).toEqual([SLOPE_RAMP[0], SLOPE_RAMP[2], SLOPE_RAMP[4]]);
    expect(bandColours(5)).toEqual(SLOPE_RAMP);
  });
});
