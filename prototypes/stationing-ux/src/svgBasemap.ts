import L from '../../../frontend/src/lib/leaflet';

/**
 * The illustrative SVG basemap as vector tiles (owner report of 3 Nov 2026: "the map is lagging").
 *
 * A single L.imageOverlay of the 0.94 MB SVG is re-rasterised by the browser at its full on-screen size — tens of
 * millions of pixels at working zoom — on each zoom step, measured at up to 160–200 ms per frame. Here the SVG is parsed
 * once into its own layers (filled polygons by colour group, then the road classes as strokes), each polygon and road
 * segment with its bounding box; a 256-px tile draws only the shapes that touch it, with the SVG's colours, widths and
 * drawing order, so it stays crisp at every zoom and costs a few milliseconds. Georeferencing is that of
 * L.imageOverlay: the SVG's viewBox stretched linearly between the projected corner bounds.
 */
type Item = { d: string; x0: number; y0: number; x1: number; y1: number; path?: Path2D };
type Layer = { kind: 'fill' | 'stroke'; color: string; width: number; items: Item[] };
type Parsed = { bg: string; W: number; H: number; layers: Layer[] };

function item(d: string): Item {
  const n = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < n.length; i += 2) {
    const x = +n[i];
    const y = +n[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { d, x0, y0, x1, y1 };
}

/** The basemap SVG's own structure: <g fill> groups of polygons, then one stroked path per road class (M/L/Z only). */
function parse(text: string): Parsed {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(text);
  const layers: Layer[] = [];
  const re = /<g\s+fill="([^"]+)"[^>]*>([\s\S]*?)<\/g>|<path\s+d="([^"]*)"\s+fill="none"\s+stroke="([^"]+)"\s+stroke-width="([\d.]+)"[^>]*\/>/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) layers.push({ kind: 'fill', color: m[1], width: 0, items: [...m[2].matchAll(/ d="([^"]*)"/g)].map((x) => item(x[1])) });
    else layers.push({ kind: 'stroke', color: m[4], width: +m[5], items: m[3].split(/(?=M)/).filter(Boolean).map(item) });
  }
  return { bg: /<rect[^>]*fill="([^"]+)"/.exec(text)?.[1] ?? '#eeeade', W: vb ? +vb[1] : 1800, H: vb ? +vb[2] : 1916, layers };
}

export function svgBasemap(url: string, bounds: L.LatLngBoundsLiteral, attribution: string): L.GridLayer {
  const ready: Promise<Parsed | null> = fetch(url)
    .then((r) => r.text())
    .then(parse)
    .catch(() => null);
  const box = L.latLngBounds(bounds);
  const Layer = L.GridLayer.extend({
    createTile(this: L.GridLayer & { _map: L.Map }, coords: L.Coords, done: L.DoneCallback) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      tile.width = size.x * ratio;
      tile.height = size.y * ratio;
      const map = this._map;
      void ready.then((svg) =>
        // one tile per task, so a burst of new tiles never blocks a frame for long
        setTimeout(() => {
          if (svg) {
            const tl = map.project(box.getNorthWest(), coords.z);
            const br = map.project(box.getSouthEast(), coords.z);
            // the tile's rectangle in the SVG's own units, and the scale from SVG units to tile pixels
            const sx = ((coords.x * size.x - tl.x) / (br.x - tl.x)) * svg.W;
            const sy = ((coords.y * size.y - tl.y) / (br.y - tl.y)) * svg.H;
            const sw = (size.x / (br.x - tl.x)) * svg.W;
            const sh = (size.y / (br.y - tl.y)) * svg.H;
            const ctx = tile.getContext('2d')!;
            ctx.setTransform(tile.width / sw, 0, 0, tile.height / sh, (-sx * tile.width) / sw, (-sy * tile.height) / sh);
            ctx.fillStyle = svg.bg;
            ctx.fillRect(0, 0, svg.W, svg.H);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            for (const layer of svg.layers) {
              const pad = layer.width;
              const hit = layer.items.filter((it) => it.x1 + pad >= sx && it.x0 - pad <= sx + sw && it.y1 + pad >= sy && it.y0 - pad <= sy + sh);
              if (!hit.length) continue;
              if (layer.kind === 'fill') {
                ctx.fillStyle = layer.color;
                for (const it of hit) ctx.fill((it.path ??= new Path2D(it.d)), 'evenodd');
              } else {
                ctx.strokeStyle = layer.color;
                ctx.lineWidth = layer.width;
                ctx.stroke(new Path2D(hit.map((it) => it.d).join('')));
              }
            }
          }
          done(undefined, tile);
        }, 0),
      );
      return tile;
    },
  });
  const Tiled = Layer as unknown as new (o: L.GridLayerOptions) => L.GridLayer;
  return new Tiled({ bounds: box, attribution, keepBuffer: 3, updateWhenZooming: false, pane: 'tilePane' });
}
