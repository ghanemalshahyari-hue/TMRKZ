import { describe, expect, it } from 'vitest';
import { parseCoordinates } from './coords';

// P1-3 of the enterprise audit: «خط العرض 91» followed by a longitude saved the site on the equator (lat 0).
describe('parseCoordinates', () => {
  it('never turns an invalid latitude into 0 when the longitude is typed next', () => {
    const r = parseCoordinates('91', '55.27');
    expect(r.point).toBeNull();
    expect(r.error).toContain('خط العرض');
  });

  it('never fills a missing axis with 0', () => {
    expect(parseCoordinates('', '55.27').point).toBeNull();
    expect(parseCoordinates('25.2', '').point).toBeNull();
    expect(parseCoordinates('', '55.27').error).not.toBe('');
  });

  it('rejects out-of-range and non-numeric values', () => {
    expect(parseCoordinates('25.2', '181').error).toContain('خط الطول');
    expect(parseCoordinates('abc', '55').point).toBeNull();
    expect(parseCoordinates('-91', '55').point).toBeNull();
  });

  it('returns the point only when both values are valid', () => {
    expect(parseCoordinates('25.2', '55.27')).toEqual({ point: { lat: 25.2, lng: 55.27 }, error: '' });
    expect(parseCoordinates('-33.8688', '151.2093').point).toEqual({ lat: -33.8688, lng: 151.2093 });
    expect(parseCoordinates('0', '0').point).toEqual({ lat: 0, lng: 0 });
  });

  it('is silent while both fields are still empty', () => {
    expect(parseCoordinates('', '')).toEqual({ point: null, error: '' });
  });
});
