import { describe, expect, it } from 'vitest';
import { clusterPoints, labelBox, placeLabels } from './layout';

describe('prototype map layout', () => {
  it('clusters close markers and keeps distant ones apart', () => {
    const c = clusterPoints(
      [
        { id: 'a', x: 100, y: 100 },
        { id: 'b', x: 110, y: 104 },
        { id: 'c', x: 300, y: 300 },
      ],
      40,
    );
    expect(c).toHaveLength(2);
    expect(c.find((x) => x.ids.includes('a'))!.ids.sort()).toEqual(['a', 'b']);
    expect(c.find((x) => x.ids.includes('c'))!.ids).toEqual(['c']);
  });

  it('places the higher-priority label first and moves or drops colliding ones', () => {
    const view = { x: 0, y: 0, w: 1000, h: 1000 };
    const placed = placeLabels(
      [
        { id: 'low', x: 200, y: 200, w: 80, h: 20, priority: 1 },
        { id: 'high', x: 205, y: 200, w: 80, h: 20, priority: 5 },
      ],
      [],
      view,
    );
    expect(placed.get('high')).toBe('below');
    expect(placed.get('low')).toBe('above');
    // a label never overlaps a marker obstacle
    const blocked = placeLabels([{ id: 'x', x: 50, y: 50, w: 60, h: 20, priority: 1 }], [labelBox(50, 50, 60, 20, 'below'), labelBox(50, 50, 60, 20, 'above'), labelBox(50, 50, 60, 20, 'side-start'), labelBox(50, 50, 60, 20, 'side-end')], view);
    expect(blocked.has('x')).toBe(false);
  });
});
