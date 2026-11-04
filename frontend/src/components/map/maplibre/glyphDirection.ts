import type { Map as MlMap } from 'maplibre-gl';

/** The part of MapLibre's GlyphManager this fix touches (`Style.glyphManager.createRasterizer`, maplibre-gl 6.15.0). */
type Rasterizer = { ctx?: { direction: CanvasDirection } };
type GlyphManagerLike = { createRasterizer: (options: unknown, padding: number) => Rasterizer };

const fixed = new WeakSet<object>();

/**
 * Draws this map's label glyphs left to right, whatever the page direction (MAPLIBRE_LABELS.md, finding G-8a).
 *
 * MapLibre puts each label in visual order itself (built-in bidi; brackets and guillemets in right-to-left runs are
 * already mirrored, Unicode rule L4) and then rasterises every glyph alone on an offscreen canvas whose `direction` it
 * leaves at "inherit". Chromium resolves that from the document element, so on the application's `<html dir="rtl">` a
 * lone bracket is mirrored a second time: «شارع (١٩)» became «شارع )١٩(». A glyph already in visual order has no
 * direction of its own, so its canvas is set to left to right. This touches only this map's glyph canvases; the page
 * keeps its right-to-left direction (owner, 4 Nov 2026: no global direction change). A new style brings a new glyph
 * manager, which `styledata` catches before any glyph of that style is drawn.
 */
export function drawGlyphsLeftToRight(map: MlMap): void {
  const apply = () => {
    const gm = (map as unknown as { style?: { glyphManager?: GlyphManagerLike } }).style?.glyphManager;
    if (!gm || fixed.has(gm)) return;
    const create = gm.createRasterizer;
    gm.createRasterizer = (options, padding) => {
      const rasterizer = create(options, padding);
      if (rasterizer.ctx) rasterizer.ctx.direction = 'ltr';
      return rasterizer;
    };
    fixed.add(gm);
  };
  apply();
  map.on('styledata', apply);
}
