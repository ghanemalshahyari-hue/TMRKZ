import { describe, expect, it } from 'vitest';
import { constrainToCoverage, coverageAt, coveragePolygon, type PackageExtent } from './packageCoverage';

// the installed package's header (uae.pmtiles, 28 Nov 2026)
const UAE: PackageExtent = { west: 51.1303709, south: 22.451649, east: 56.689453, north: 26.332807, minZoom: 0, maxZoom: 15 };
const limits = { minZoom: 6, maxZoom: 18 };
const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;

/** The screen's box in Mercator units for a camera, unturned and without padding. */
function screen(c: { lng: number; lat: number; zoom: number }, w: number, h: number) {
  const world = 512 * 2 ** c.zoom;
  return { x0: mercX(c.lng) - w / 2 / world, x1: mercX(c.lng) + w / 2 / world, y0: mercY(c.lat) - h / 2 / world, y1: mercY(c.lat) + h / 2 / world };
}
const onTiles = (c: { lng: number; lat: number; zoom: number }, w: number, h: number) => {
  const s = screen(c, w, h);
  const t = coverageAt(UAE, c.zoom);
  const e = 1e-9;
  return s.x0 >= t.x0 - e && s.x1 <= t.x1 + e && s.y0 >= t.y0 - e && s.y1 <= t.y1 + e;
};

describe('package coverage (no empty edge on the map)', () => {
  it('the tiles of a zoom are whole tiles around the extent, fewer as the zoom rises', () => {
    const z6 = coverageAt(UAE, 6);
    expect(z6.x0 * 360 - 180).toBeCloseTo(50.625, 6); // the z6 tile that holds Qatar's west
    expect(z6.x1 * 360 - 180).toBeCloseTo(61.875, 6); // … and the one reaching past Chabahar
    const z15 = coverageAt(UAE, 15);
    expect(z15.x0 * 360 - 180).toBeGreaterThan(51.11); // the whole z15 tile holding the extent's west edge (51.1194…)
    expect(z15.x1 * 360 - 180).toBeLessThan(56.7);
    expect(z15.x1 - z15.x0).toBeLessThan(z6.x1 - z6.x0);
    expect(coverageAt(UAE, 20)).toEqual(z15); // past the package's last zoom its tiles are enlarged
  });

  it('a wide home-page map zoomed out too far is brought in until every pixel has a tile', () => {
    const c = constrainToCoverage(UAE, { lng: 53.97, lat: 24.35 }, 6, { width: 1500, height: 690 }, limits);
    expect(c.zoom).toBeGreaterThan(6);
    expect(onTiles(c, 1500, 690)).toBe(true);
  });

  it('at every size and place the result lies on the tiles; a camera already on them is not changed', () => {
    for (const [w, h] of [[1500, 690], [690, 1500], [400, 300], [2560, 1400], [320, 900]]) {
      for (const [lng, lat] of [[45, 20], [54, 24], [60, 28], [51.2, 22.5], [56.6, 26.3]]) {
        for (const zoom of [6, 6.88, 7.5, 9, 12.3, 15, 17]) {
          const c = constrainToCoverage(UAE, { lng, lat }, zoom, { width: w, height: h }, limits);
          expect(onTiles(c, w, h), JSON.stringify({ w, h, lng, lat, zoom, c })).toBe(true);
          expect(c.zoom).toBeGreaterThanOrEqual(zoom - 1e-9);
          const again = constrainToCoverage(UAE, c, c.zoom, { width: w, height: h }, limits);
          expect(again.zoom).toBeCloseTo(c.zoom, 9);
          expect(again.lng).toBeCloseTo(c.lng, 9);
          expect(again.lat).toBeCloseTo(c.lat, 9);
        }
      }
    }
  });

  it('a view inside the country is left exactly as it is', () => {
    const c = constrainToCoverage(UAE, { lng: 55.27, lat: 25.2 }, 12, { width: 1200, height: 800 }, limits);
    expect(c).toEqual({ lng: expect.closeTo(55.27, 9), lat: expect.closeTo(25.2, 9), zoom: 12 });
  });

  it('keeps the map zoom limits, and a turned or padded screen is kept on the tiles as a whole', () => {
    expect(constrainToCoverage(UAE, { lng: 55, lat: 25 }, 30, { width: 800, height: 600 }, limits).zoom).toBe(18);
    expect(constrainToCoverage(UAE, { lng: 55, lat: 25 }, 2, { width: 0, height: 0 }, limits).zoom).toBe(6);
    const turned = constrainToCoverage(UAE, { lng: 51.3, lat: 22.6 }, 8, { width: 1200, height: 800, bearing: 45 }, limits);
    const diag = (1200 + 800) * Math.SQRT1_2; // the box around a screen turned by 45°
    expect(onTiles(turned, diag, diag)).toBe(true);
    const padded = constrainToCoverage(UAE, { lng: 51.3, lat: 25 }, 9, { width: 1000, height: 700, padding: { top: 0, bottom: 0, left: 400, right: 0 } }, limits);
    expect(onTiles(padded, 1000 + 400, 700)).toBe(true);
  });

  it('with the region tile under the map (zoom 3), a wide short box shows the whole country, unshifted (owner, 28 Nov 2026)', () => {
    // the owner's home map: about 2,100 × 540 pixels; the whole country fitted by MapLibre is near zoom 6.5 around 54° E
    const fitted = { lng: 53.97, lat: 24.35 };
    const onlyDetailed = constrainToCoverage(UAE, fitted, 6.5, { width: 2100, height: 540 }, limits);
    expect(onlyDetailed.zoom).toBeGreaterThan(6.5); // the detailed tiles alone force a closer, cropped view
    const withRegion = constrainToCoverage(UAE, fitted, 6.5, { width: 2100, height: 540 }, limits, 3);
    expect(withRegion.zoom).toBeCloseTo(6.5, 9);
    expect(withRegion.lng).toBeCloseTo(53.97, 9);
    expect(withRegion.lat).toBeCloseTo(24.35, 9);
    // and it still keeps the camera on the region tile (45–90° E, 0–41° N)
    const far = constrainToCoverage(UAE, { lng: 30, lat: 50 }, 7, { width: 1200, height: 800 }, limits, 3);
    const region = coverageAt(UAE, 3);
    expect(far.lng).toBeGreaterThan(region.x0 * 360 - 180);
    expect(far.lat).toBeLessThan(41);
  });

  it('gives the area the detailed tiles of a zoom cover, as the mask over the region tile', () => {
    const p = coveragePolygon(UAE, 6);
    const ring = p.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(Math.min(...ring.map((q) => q[0]))).toBeCloseTo(50.625, 6);
    expect(Math.max(...ring.map((q) => q[0]))).toBeCloseTo(61.875, 6);
    expect(Math.min(...ring.map((q) => q[1]))).toBeLessThan(UAE.south);
    expect(Math.max(...ring.map((q) => q[1]))).toBeGreaterThan(UAE.north);
  });
});
