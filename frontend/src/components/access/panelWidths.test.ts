import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDTHS, MIN_MAIN, DIVIDERS, resize, widthAt } from './panelWidths';

describe('the access workspace panel widths', () => {
  it('keeps a panel inside its limits', () => {
    expect(resize(DEFAULT_WIDTHS, 'tree', 50, 1800).tree).toBe(220);
    expect(resize(DEFAULT_WIDTHS, 'tree', 2000, 3000).tree).toBe(760);
    expect(resize(DEFAULT_WIDTHS, 'file', 400, 1800)).toEqual({ tree: 330, file: 400 });
  });

  it('never squeezes the middle panel below its minimum', () => {
    const w = resize(DEFAULT_WIDTHS, 'tree', 700, 1200);
    expect(w.tree).toBe(1200 - DIVIDERS - MIN_MAIN - DEFAULT_WIDTHS.file);
  });

  it('reads the pointer from the panel’s own edge, right to left', () => {
    const box = { left: 100, right: 1900 };
    expect(widthAt('tree', 1500, box, true)).toBe(400 - DIVIDERS / 4);
    expect(widthAt('file', 450, box, true)).toBe(350 - DIVIDERS / 4);
    expect(widthAt('tree', 500, box, false)).toBe(400 - DIVIDERS / 4);
  });
});
