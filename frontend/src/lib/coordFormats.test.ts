// coordFormats.ts against PROJ (UTM) and the `mgrs` package (MGRS): the golden vectors MOVER generated
// (tests/navmap_js/gen_coords_golden.py there). Never against itself. Ported from MOVER tests/navmap_js/coords.test.mjs (ADR-048).
import { describe, expect, it } from 'vitest';
import G from './coordFormats.golden.json';
import { INPUT_FORMATS, bandIsNorth, fmtDms, fmtUtm, formatIn, fromMgrs, fromUtm, latBand, parseCoordinate, parseInFormat, toMgrs, toUtm, utmZone, type Parsed } from './coordFormats';

type Fwd = { lat: number; lon: number; zone: number; band: string; easting: number; northing: number; mgrs: string };
type Inv = { lat: number; lon: number; zone: number; north: boolean; easting: number; northing: number };
const forward = (G as { forward: Fwd[] }).forward;
const inverse = (G as { inverse: Inv[] }).inverse;

describe('UTM and MGRS against PROJ and the mgrs package', () => {
  it('UTM forward to a millimetre', () => {
    for (const g of forward) {
      const u = toUtm(g.lat, g.lon)!;
      expect(u.zone, `zone ${g.lat},${g.lon}`).toBe(g.zone);
      expect(u.band).toBe(g.band);
      expect(Math.abs(u.easting - g.easting)).toBeLessThan(1e-3);
      expect(Math.abs(u.northing - g.northing)).toBeLessThan(1e-3);
    }
  });
  it('UTM inverse to 1e-8 degrees', () => {
    for (const g of inverse) {
      const p = fromUtm(g.zone, g.north, g.easting, g.northing);
      expect(Math.abs(p.lat - g.lat)).toBeLessThan(1e-8);
      expect(Math.abs(p.lon - g.lon)).toBeLessThan(1e-8);
    }
  });
  it('MGRS forward equals the mgrs package, reverse is the south-west corner of the cell', () => {
    for (const g of forward) {
      expect(toMgrs(g.lat, g.lon)!.replace(/\s+/g, '')).toBe(g.mgrs);
      const p = fromMgrs(g.mgrs)!;
      const dLat = (g.lat - p.lat) * 110574;
      const dLon = (g.lon - p.lon) * 111320 * Math.cos((g.lat * Math.PI) / 180);
      expect(Math.hypot(dLat, dLon)).toBeLessThan(2);
    }
  });
  it('the UAE: Abu Dhabi is 40R BN 34124 07001', () => {
    expect(latBand(24.4539)).toBe('R');
    expect(utmZone(24.4539, 54.3773)).toBe(40);
    expect(toMgrs(24.4539, 54.3773)).toBe('40R BN 34124 07001');
    expect(fmtUtm(toUtm(24.4539, 54.3773))).toBe('40R 234125 2707001');
  });
  it('no UTM outside 80°S–84°N, malformed MGRS refused', () => {
    expect(toUtm(85, 10)).toBeNull();
    for (const bad of ['', '40R', '40RBN123', '61RBN1234', '40IBN1234', '40RBI1234', 'hello']) expect(fromMgrs(bad), bad).toBeNull();
  });
});

const near = (r: Parsed, lat: number, lon: number, kind: string, tol = 1e-4) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) return;
  expect(r.kind).toBe(kind);
  expect(Math.abs(r.lat - lat) < tol && Math.abs(r.lon - lon) < tol, `${r.lat},${r.lon}`).toBe(true);
};

describe('what a person types', () => {
  it('decimal degrees in the common spellings, Arabic digits and comma included', () => {
    for (const s of ['24.4539, 54.3773', '24.4539 54.3773', '24.4539N 54.3773E', 'N24.4539 E54.3773', '24.4539° N, 54.3773° E', '٢٤٫٤٥٣٩، ٥٤٫٣٧٧٣']) near(parseCoordinate(s), 24.4539, 54.3773, 'latlon');
  });
  it('degrees-minutes-seconds and degrees-decimal-minutes', () => {
    near(parseCoordinate(`24°27'14.04"N 54°22'38.28"E`), 24.4539, 54.3773, 'latlon', 1e-5);
    near(parseCoordinate(`24°27.234'N 54°22.638'E`), 24.4539, 54.3773, 'latlon', 1e-5);
  });
  it('UTM and MGRS', () => {
    near(parseCoordinate('40R 234125 2707001'), 24.4539, 54.3773, 'utm', 2e-5);
    near(parseCoordinate('40RBN3412407001'), 24.4539, 54.3773, 'mgrs', 2e-5);
    near(parseCoordinate('40R BN 34124 07001'), 24.4539, 54.3773, 'mgrs', 2e-5);
  });
  it('refusals say why, in Arabic, and never invent a position', () => {
    for (const bad of ['', 'hello', '91, 10', '10, 181', '24.4N 54.3N', '1,2,3', '99R 234125 2707001', '40R 234125', '24 27, 54 22', '40S 234125 2707001']) {
      const r = parseCoordinate(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(/[؀-ۿ]/.test(r.error)).toBe(true);
    }
  });
  it('a chosen format reads its own unmarked numbers and refuses another format by name', () => {
    near(parseInFormat('24 27 14.04 N, 54 22 38.28 E', 'dms'), 24.4539, 54.3773, 'latlon', 1e-5);
    near(parseInFormat('24 27.234, 54 22.638', 'ddm'), 24.4539, 54.3773, 'latlon', 1e-5);
    const r = parseInFormat('40R 234125 2707001', 'mgrs');
    expect(r.ok).toBe(false);
  });
  it('fmtDms carries 59.99… seconds instead of printing 60', () => {
    expect(fmtDms(24.4539, 'N', 'S')).toBe('24°27′14.04″ N');
    expect(fmtDms(24.99999999, 'N', 'S')).toBe('25°00′00.00″ N');
    expect(bandIsNorth('R') && !bandIsNorth('J')).toBe(true);
  });
});

describe('formatIn: every format is read back by its own reader (the conversion the points table uses)', () => {
  const tol: Record<string, number> = { '': 1e-6, dd: 1e-6, ddm: 1e-5, dms: 1e-5, utm: 1e-5, mgrs: 2e-5 };
  for (const f of INPUT_FORMATS) {
    it(f.label, () => {
      for (const [lat, lon] of [[24.4539, 54.3773], [25.08, 56.17], [22.9, 51.6]]) {
        const r = parseInFormat(formatIn(f.key, lat, lon), f.key);
        expect(r.ok, formatIn(f.key, lat, lon)).toBe(true);
        if (r.ok) expect(Math.abs(r.lat - lat) < tol[f.key] && Math.abs(r.lon - lon) < tol[f.key]).toBe(true);
      }
    });
  }
});
