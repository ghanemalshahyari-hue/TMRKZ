import { describe, expect, it } from 'vitest';
import { scopesFor } from './accessScopes';

describe('scopes a request may ask with (owner, 16 Nov 2026)', () => {
  it('allows all four when no role limits them, starting from the unit', () => {
    expect(scopesFor([{ code: 'REQUESTER', name: 'مقدم الطلب' }])).toEqual({ modes: ['UNIT', 'UNIT_TREE', 'UNITS', 'SITES'], start: 'UNIT' });
  });
  it('intersects the chosen roles and starts from the default when it is still allowed', () => {
    const r = scopesFor([
      { code: 'A', name: 'أ', scopeModes: ['UNIT', 'UNIT_TREE', 'UNITS'], defaultScope: 'UNIT_TREE' },
      { code: 'B', name: 'ب', scopeModes: ['UNIT_TREE', 'UNITS'] },
    ]);
    expect(r).toEqual({ modes: ['UNIT_TREE', 'UNITS'], start: 'UNIT_TREE' });
  });
  it('falls back to the first allowed when the default is no longer allowed, and to none when nothing is common', () => {
    expect(scopesFor([{ code: 'A', name: 'أ', scopeModes: ['UNIT', 'SITES'], defaultScope: 'UNIT' }, { code: 'B', name: 'ب', scopeModes: ['SITES'] }]))
      .toEqual({ modes: ['SITES'], start: 'SITES' });
    expect(scopesFor([{ code: 'A', name: 'أ', scopeModes: ['UNIT'] }, { code: 'B', name: 'ب', scopeModes: ['SITES'] }])).toEqual({ modes: [], start: null });
  });
});
