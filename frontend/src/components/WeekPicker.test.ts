import { describe, expect, it } from 'vitest';
import { monthCells } from './WeekPicker';

// the seven-day picker's month page (owner, 11 Nov 2026): Sunday first, every day once
describe('month page', () => {
  it('November 2026 starts on a Sunday and has 30 days', () => {
    const c = monthCells(2026, 10);
    expect(c[0]).toBe('2026-11-01');
    expect(c.filter(Boolean)).toHaveLength(30);
  });
  it('February 2028 (leap) has 29 days after two blanks', () => {
    const c = monthCells(2028, 1);
    expect(c.slice(0, 2)).toEqual([null, null]);
    expect(c[2]).toBe('2028-02-01');
    expect(c.filter(Boolean)).toHaveLength(29);
  });
});
