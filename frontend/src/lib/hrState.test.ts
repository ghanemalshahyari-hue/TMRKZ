import { describe, expect, it } from 'vitest';
import { hrState, unitTrail } from './hrState';

describe('hrState', () => {
  it('names the pending, matched, stale and absent states', () => {
    expect(hrState({ hrMatch: 'PENDING' })).toBe('بانتظار تحديث HR');
    expect(hrState({ hrMatch: 'NONE' })).toBe('—');
    expect(hrState({ hrMatch: 'MATCHED', hrStale: false, hrFetchedAt: null })).toBe('مطابق');
    expect(hrState({ hrMatch: 'MATCHED', hrStale: true, hrFetchedAt: null })).toContain('بيانات قديمة');
    expect(hrState({ hrMatch: 'MATCHED', hrStale: false, hrFetchedAt: '2026-11-20T08:00:00Z' })).toContain('آخر تحديث');
  });
});

describe('unitTrail', () => {
  const units = [
    { id: 'main', depth: 0 },
    { id: 'a', depth: 1 },
    { id: 'a1', depth: 2 },
    { id: 'b', depth: 1 },
    { id: 'b1', depth: 2 },
  ];
  it('walks from the root to the unit itself', () => {
    expect(unitTrail(units, 'b1')).toEqual(['main', 'b', 'b1']);
    expect(unitTrail(units, 'a1')).toEqual(['main', 'a', 'a1']);
    expect(unitTrail(units, 'main')).toEqual(['main']);
  });
  it('is empty without a unit or for one outside the list', () => {
    expect(unitTrail(units, null)).toEqual([]);
    expect(unitTrail(units, 'zz')).toEqual([]);
  });
});
