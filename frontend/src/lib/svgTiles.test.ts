import { describe, expect, it } from 'vitest';
import { itemsIn, parseSvgTiles, tileWindow } from './svgTiles';

// the installed package and the acceptance plan, read from the repository when it is there (the web image's build stage
// holds only frontend/, so these two cases run in the working copy and are skipped in the image build)
const files = import.meta.glob(['../../../map-packages/regional-basemap-2026.10/basemap.svg', '../../../tests/acceptance/fixtures/campus-plan/plan.svg'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const REGIONAL = files['../../../map-packages/regional-basemap-2026.10/basemap.svg'];
const PLAN = files['../../../tests/acceptance/fixtures/campus-plan/plan.svg'];
const svg = (body: string, root = 'viewBox="0 0 100 50" preserveAspectRatio="none"') => `<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`;
const GROUP = '<g fill="#a7cbd0" fill-rule="evenodd" stroke="none"><path d="M10,10L20,10L20,20Z"/></g>';

describe('basemap SVG as vector tiles', () => {
  it.skipIf(!REGIONAL)('reads the installed regional package in full, layer by layer in drawing order', () => {
    const text = REGIONAL;
    const t = parseSvgTiles(text)!;
    expect(t).not.toBeNull();
    expect([t.width, t.height, t.background]).toEqual([1800, 1916, '#eeeade']);
    expect(t.layers.map((l) => l.kind)).toEqual(['fill', 'fill', 'fill', 'fill', 'stroke', 'stroke', 'stroke', 'stroke', 'stroke']);
    // every path of the file is kept: the polygons of the four groups, and each road subpath (one M each)
    const strokes = [...text.matchAll(/<path d="([^"]*)" fill="none"/g)].map((m) => m[1]);
    const polygons = (text.match(/<path /g) ?? []).length - strokes.length;
    expect(t.layers.filter((l) => l.kind === 'fill').reduce((s, l) => s + l.items.length, 0)).toBe(polygons);
    expect(t.layers.filter((l) => l.kind === 'stroke').reduce((s, l) => s + l.items.length, 0)).toBe(strokes.join('').split('M').length - 1);
    expect(t.layers.flatMap((l) => l.items).map((i) => i.d).join('').length).toBe([...text.matchAll(/ d="([^"]*)"/g)].reduce((s, m) => s + m[1].length, 0));
    const stroke = t.layers[8];
    expect(stroke.kind === 'stroke' && [stroke.color, stroke.width, stroke.cap, stroke.join]).toEqual(['#e2bd82', 5, 'round', 'round']);
    // the boxes enclose exactly the file's coordinates (some roads reach past the viewBox; the tiles clip to it)
    const n = [...text.matchAll(/ d="([^"]*)"/g)].flatMap((x) => (x[1].match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g) ?? []).map(Number));
    const xs = n.filter((_, i) => i % 2 === 0);
    const ys = n.filter((_, i) => i % 2 === 1);
    const items = t.layers.flatMap((l) => l.items);
    const min = (v: number[]) => v.reduce((a, b) => Math.min(a, b));
    const max = (v: number[]) => v.reduce((a, b) => Math.max(a, b));
    expect([min(items.map((i) => i.x0)), min(items.map((i) => i.y0)), max(items.map((i) => i.x1)), max(items.map((i) => i.y1))]).toEqual([min(xs), min(ys), max(xs), max(ys)]);
  });

  it('accepts the plain structure with SVG defaults and exact bounding boxes', () => {
    const t = parseSvgTiles(
      '<?xml version="1.0"?>' +
        svg('<!-- extract --><rect width="100%" height="100%" fill="#eeeade"/>' + GROUP + '<g fill="#d3dfc5"><path d="M1 2L3 4L5 1Z M7,7L8,8L9,7Z"/></g><path d="M0,0L50,25M60,10L70,40" fill="none" stroke="#fffef8"/>'),
    )!;
    expect(t.background).toBe('#eeeade');
    expect(t.layers[0]).toMatchObject({ kind: 'fill', rule: 'evenodd', items: [{ x0: 10, y0: 10, x1: 20, y1: 20 }] });
    expect(t.layers[1]).toMatchObject({ kind: 'fill', rule: 'nonzero', items: [{ x0: 1, y0: 1, x1: 9, y1: 8 }] });
    expect(t.layers[2]).toMatchObject({ kind: 'stroke', width: 1, cap: 'butt', join: 'miter', items: [{ d: 'M0,0L50,25', x1: 50 }, { d: 'M60,10L70,40', x0: 60 }] });
    // compact number syntax: implied separators before a minus sign and a leading decimal point
    expect(parseSvgTiles(svg('<g fill="#000"><path d="M10-5L.5.25L-3,4Z"/></g>'))!.layers[0].items[0]).toMatchObject({ x0: -3, y0: -5, x1: 10, y1: 4 });
  });

  it.skipIf(!PLAN)('keeps the image overlay for the acceptance plan (text, lines, aspect-keeping viewBox)', () => {
    expect(parseSvgTiles(PLAN)).toBeNull();
  });

  it.each([
    ['no preserveAspectRatio="none"', svg(GROUP, 'viewBox="0 0 100 50"')],
    ['a viewBox not at the origin', svg(GROUP, 'viewBox="5 0 100 50" preserveAspectRatio="none"')],
    ['a transform', svg('<g fill="#000" transform="scale(2)"><path d="M1,1L2,2L1,2Z"/></g>')],
    ['a style attribute', svg('<g fill="#000" style="opacity:.5"><path d="M1,1L2,2L1,2Z"/></g>')],
    ['a relative command', svg('<g fill="#000"><path d="M1,1l2,2L1,2Z"/></g>')],
    ['a curve', svg('<g fill="#000"><path d="M1,1C2,2 3,3 4,4Z"/></g>')],
    ['horizontal/vertical shorthand', svg('<g fill="#000"><path d="M1,1H5V5Z"/></g>')],
    ['an odd coordinate count', svg('<g fill="#000"><path d="M1,1L2Z"/></g>')],
    ['a nested group', svg('<g fill="#000"><g fill="#111"><path d="M1,1L2,2L1,2Z"/></g></g>')],
    ['text', svg(GROUP + '<text x="1" y="1">موقع</text>')],
    ['an image', svg('<image href="a.png" width="10" height="10"/>')],
    ['a gradient fill', svg('<g fill="url(#a)"><path d="M1,1L2,2L1,2Z"/></g>')],
    ['a background rect after other shapes', svg(GROUP + '<rect width="100%" height="100%" fill="#fff"/>')],
    ['a partial background rect', svg('<rect width="50" height="50" fill="#fff"/>' + GROUP)],
    ['a stroke with opacity', svg('<path d="M0,0L1,1" fill="none" stroke="#000" stroke-opacity="0.5"/>')],
    ['a dashed stroke', svg('<path d="M0,0L1,1" fill="none" stroke="#000" stroke-dasharray="2"/>')],
    ['an unclosed document', svg(GROUP).replace('</svg>', '')],
    ['content after the document', svg(GROUP) + '<g/>'],
  ])('keeps the image overlay for %s', (_, text) => {
    expect(parseSvgTiles(text)).toBeNull();
  });

  it('places tiles exactly as the overlay stretches the file between the projected corners', () => {
    const nw = { x: 1000.5, y: 2000.25 };
    const se = { x: 5000.5, y: 6260.25 };
    const size = { x: 256, y: 256 };
    const box = { width: 1800, height: 1916 };
    for (const [u, v] of [
      [0, 0],
      [913.7, 1402.2],
      [1800, 1916],
    ]) {
      // the overlay: pixel = corner + u / width × projected width
      const X = nw.x + (u / box.width) * (se.x - nw.x);
      const Y = nw.y + (v / box.height) * (se.y - nw.y);
      const tile = { x: Math.floor(X / 256), y: Math.floor(Y / 256) };
      const r = tileWindow(tile, size, nw, se, box);
      expect(((u - r.x) / r.w) * 256).toBeCloseTo(X - tile.x * 256, 9);
      expect(((v - r.y) / r.h) * 256).toBeCloseTo(Y - tile.y * 256, 9);
    }
    // neighbouring tiles meet without gap or overlap
    const a = tileWindow({ x: 7, y: 9 }, size, nw, se, box);
    const b = tileWindow({ x: 8, y: 10 }, size, nw, se, box);
    expect(a.x + a.w).toBeCloseTo(b.x, 9);
    expect(a.y + a.h).toBeCloseTo(b.y, 9);
  });

  it('gives a tile only the shapes that can paint inside it, strokes with their width', () => {
    const t = parseSvgTiles(svg('<g fill="#000"><path d="M0,0L10,0L10,10Z"/><path d="M50,0L60,0L60,10Z"/></g><path d="M0,30L10,30M40,30L45,30" fill="none" stroke="#000" stroke-width="4"/>'))!;
    expect(itemsIn(t.layers[0], { x: 5, y: 5, w: 20, h: 20 }).map((i) => i.x0)).toEqual([0]);
    expect(itemsIn(t.layers[0], { x: 70, y: 0, w: 10, h: 10 })).toEqual([]);
    // the road ends at x = 10; its 4-unit stroke can reach a tile starting at x = 17, not one at x = 19
    expect(itemsIn(t.layers[1], { x: 17, y: 20, w: 10, h: 20 }).map((i) => i.d)).toEqual(['M0,30L10,30']);
    expect(itemsIn(t.layers[1], { x: 19, y: 20, w: 10, h: 20 })).toEqual([]);
  });
});
