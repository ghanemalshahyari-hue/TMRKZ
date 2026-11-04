import { describe, expect, it } from 'vitest';
import { areaM2, centroid } from './footprint';
import { distanceM } from './geo';
import { DRAW_NEW_BOUNDARY, HIERARCHY_CHANGED, STATIONING_V3_ENABLED, copyableBoundary, guidanceBand, simpleArea } from './stationingV3';

describe('Stationing V3 preparation', () => {
  it('is inactive unless explicitly enabled at build time', () => {
    expect(STATIONING_V3_ENABLED).toBe(false);
  });

  it('keeps the owner-approved wording', () => {
    expect(HIERARCHY_CHANGED).toBe('تغير الهيكل التنظيمي بعد تقديم الطلب');
  });

  it('draws the guidance band at the effective minimum and maximum around the centre', () => {
    const c = { lat: 25.229, lng: 55.292 };
    const { outer, inner } = guidanceBand(c, 5000, 10000);
    for (const [lat, lng] of outer) expect(Math.abs(distanceM(c, { lat, lng }) - 10000)).toBeLessThan(1);
    for (const [lat, lng] of inner) expect(Math.abs(distanceM(c, { lat, lng }) - 5000)).toBeLessThan(1);
  });

  it('places a simple area as real polygon geometry centred on the click', () => {
    const c = { lat: 25.262, lng: 55.336 };
    const ring = simpleArea(c, 600);
    expect(ring).toHaveLength(32);
    expect(distanceM(centroid(ring), c)).toBeLessThan(1);
    expect(Math.abs(areaM2(ring) - Math.PI * 600 * 600) / (Math.PI * 600 * 600)).toBeLessThan(0.01);
  });

  it('copies only a Polygon; a MultiPolygon and a Point fall back to drawing, saying why, never reduced or synthesised', () => {
    const at = (type: string, name: string) => ({ site: { id: name, name }, geometry: { type, coordinates: [] } });
    const multi = at('MultiPolygon', 'الموقع 05');
    const point = at('Point', 'الموقع 06');
    const poly = at('Polygon', 'الموقع 02');
    expect(copyableBoundary([multi, poly]).copy).toBe(poly);
    const m = copyableBoundary([multi]);
    expect(m.copy).toBeNull();
    expect(m.message).toContain('متعددة الأجزاء');
    expect(m.message).toContain(DRAW_NEW_BOUNDARY);
    const p = copyableBoundary([point]);
    expect(p.copy).toBeNull();
    expect(p.message).toContain('نقطةً بلا حدود');
    expect(copyableBoundary([]).message).toContain('لا حدود مسجلة');
    expect(DRAW_NEW_BOUNDARY).toBe('رسم حدود جديدة');
  });
});
