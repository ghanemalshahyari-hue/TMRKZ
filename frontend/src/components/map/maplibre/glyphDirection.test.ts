import { describe, expect, it } from 'vitest';
import type { Map as MlMap } from 'maplibre-gl';
import { drawGlyphsLeftToRight } from './glyphDirection';

/** A map stand-in with the two things the fix uses: `style.glyphManager.createRasterizer` and `on('styledata')`. */
function fakeMap() {
  const created: { ctx: { direction: CanvasDirection } }[] = [];
  const manager = () => ({
    createRasterizer: () => {
      const r = { ctx: { direction: 'inherit' as CanvasDirection } };
      created.push(r);
      return r;
    },
  });
  const listeners: (() => void)[] = [];
  const map = {
    style: { glyphManager: manager() },
    on: (event: string, fn: () => void) => {
      if (event === 'styledata') listeners.push(fn);
    },
  };
  return { map, created, manager, styledata: () => listeners.forEach((fn) => fn()) };
}

describe('drawGlyphsLeftToRight (finding G-8a)', () => {
  it('draws every glyph canvas of the map left to right', () => {
    const f = fakeMap();
    drawGlyphsLeftToRight(f.map as unknown as MlMap);
    f.map.style.glyphManager.createRasterizer();
    f.map.style.glyphManager.createRasterizer();
    expect(f.created.map((r) => r.ctx.direction)).toEqual(['ltr', 'ltr']);
  });

  it('wraps a glyph manager once, however often styledata fires', () => {
    const f = fakeMap();
    drawGlyphsLeftToRight(f.map as unknown as MlMap);
    const wrapped = f.map.style.glyphManager.createRasterizer;
    f.styledata();
    f.styledata();
    expect(f.map.style.glyphManager.createRasterizer).toBe(wrapped);
  });

  it('covers the glyph manager of a new style', () => {
    const f = fakeMap();
    drawGlyphsLeftToRight(f.map as unknown as MlMap);
    f.map.style = { glyphManager: f.manager() };
    f.styledata();
    f.map.style.glyphManager.createRasterizer();
    expect(f.created.at(-1)!.ctx.direction).toBe('ltr');
  });
});
