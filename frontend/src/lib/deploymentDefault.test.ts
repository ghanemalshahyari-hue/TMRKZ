import { describe, expect, it } from 'vitest';
import { describeAreaDefault, initialArea, resolveAreaDefault } from './deploymentDefault';
import { distanceM } from './geo';
import { anchorOf, partArea, partsOf } from './siteGeometry';

describe('the initial deployment area of a click comes from the policy, never from the editor (owner, 5 Nov 2026)', () => {
  it('uses only the policy value: without one there is no size at all (no fallback, no invented default)', () => {
    expect(resolveAreaDefault({ shape: 'CIRCLE', areaM2: 50_000 })).toEqual({ value: { shape: 'CIRCLE', areaM2: 50_000 }, source: 'POLICY' });
    expect(resolveAreaDefault(null)).toEqual({ value: null, source: 'NONE' });
    expect(resolveAreaDefault(undefined)).toEqual({ value: null, source: 'NONE' });
    // an unusable policy value is not «configured»
    expect(resolveAreaDefault({ shape: 'SQUARE', areaM2: 0 }).source).toBe('NONE');
  });

  it('puts a shape of exactly that area with its centre on the clicked point', () => {
    const c = { lat: 25.2, lng: 55.3 };
    for (const d of [{ shape: 'SQUARE' as const, areaM2: 90_000 }, { shape: 'CIRCLE' as const, areaM2: 250_000 }]) {
      const g = initialArea(c, d);
      expect(g.type).toBe('Polygon');
      expect(g.coordinates[0]).toHaveLength(d.shape === 'SQUARE' ? 5 : 17);
      expect(Math.abs(partArea(partsOf(g)[0]) - d.areaM2) / d.areaM2).toBeLessThan(0.005);
      expect(distanceM(anchorOf(partsOf(g)), c)).toBeLessThan(1);
    }
    expect(describeAreaDefault({ shape: 'SQUARE', areaM2: 90_000 })).toMatch(/300/);
  });
});
