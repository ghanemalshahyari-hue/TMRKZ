import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_LIST, activeFilters, dayEnd, dayStart, loadListState, pageInfo, saveListState, sinceText } from './requestsList';

describe('the requests list', () => {
  it('says which rows are on screen, with many requests', () => {
    expect(pageInfo(0, 25, 12430)).toMatchObject({ pages: 498, first: 1, last: 25, near: [0, 1, 497] });
    expect(pageInfo(100, 25, 12430)).toMatchObject({ first: 2501, last: 2525, near: [0, 99, 100, 101, 497] });
    expect(pageInfo(497, 25, 12430)).toMatchObject({ first: 12426, last: 12430, near: [0, 496, 497] });
    expect(pageInfo(0, 25, 0)).toMatchObject({ pages: 1, first: 0, last: 0, near: [0] });
  });

  it('a day chosen is a whole day in Dubai', () => {
    expect(dayStart('2026-11-06')).toBe('2026-11-05T20:00:00.000Z');
    expect(dayEnd('2026-11-06')).toBe('2026-11-06T19:59:59.000Z');
    expect(dayStart('')).toBeUndefined();
  });

  it('counts the filters in use, not the status tab or the order', () => {
    expect(activeFilters(INITIAL_LIST)).toBe(0);
    expect(activeFilters({ ...INITIAL_LIST, status: 'DRAFT', sort: 'number' })).toBe(0);
    expect(activeFilters({ ...INITIAL_LIST, q: ' a ', mine: true, from: '2026-01-01' })).toBe(3);
    expect(activeFilters({ ...INITIAL_LIST, q: '   ' })).toBe(0);
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    expect(sinceText('2026-11-03T12:00:00Z', now)).toContain('3');
    expect(sinceText('2026-11-06T09:00:00Z', now)).toContain('3');
    expect(sinceText('2025-11-06T12:00:00Z', now)).toMatch(/سنة|العام/);
  });
});

describe('remembering the list', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  });

  it('returns to the same place, and starts clean with nothing stored or a broken value', () => {
    expect(loadListState()).toEqual(INITIAL_LIST);
    saveListState({ ...INITIAL_LIST, page: 7, status: 'SUBMITTED' });
    expect(loadListState()).toMatchObject({ page: 7, status: 'SUBMITTED', size: 25 });
    store.set('tmrkz.requests.list', '{broken');
    expect(loadListState()).toEqual(INITIAL_LIST);
  });

  it('keeps working when storage is refused', () => {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadListState()).toEqual(INITIAL_LIST);
    expect(() => saveListState(INITIAL_LIST)).not.toThrow();
  });
});
