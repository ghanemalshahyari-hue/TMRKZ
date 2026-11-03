import L from '../../lib/leaflet';
import { itemsIn, parseSvgTiles, tileWindow, type Rect, type SvgTiles } from '../../lib/svgTiles';

/** Parsed packages by content URL (a package version never changes its file); null when the file is not tile-drawable. */
const cache = new Map<string, Promise<SvgTiles | null>>();

/** The SVG_OVERLAY package file as drawing layers, read once per page; null when it cannot be read or drawn as tiles. */
export function loadSvgTiles(url: string): Promise<SvgTiles | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return parseSvgTiles(await r.text());
      })
      .catch(() => {
        // a failed read is retried the next time the package is shown
        cache.delete(url);
        return null;
      });
    cache.set(url, p);
    while (cache.size > 4) cache.delete(cache.keys().next().value as string);
  }
  return p;
}

function draw(ctx: CanvasRenderingContext2D, svg: SvgTiles, r: Rect, w: number, h: number) {
  ctx.setTransform(w / r.w, 0, 0, h / r.h, (-r.x * w) / r.w, (-r.y * h) / r.h);
  // the SVG viewport clips what reaches past the viewBox (some roads end beyond its edge): nothing outside the coverage
  ctx.beginPath();
  ctx.rect(0, 0, svg.width, svg.height);
  ctx.clip();
  if (svg.background) {
    ctx.fillStyle = svg.background;
    ctx.fillRect(0, 0, svg.width, svg.height);
  }
  for (const layer of svg.layers) {
    const hit = itemsIn(layer, r);
    if (!hit.length) continue;
    if (layer.kind === 'fill') {
      ctx.fillStyle = layer.color;
      for (const it of hit) ctx.fill((it.path ??= new Path2D(it.d)), layer.rule);
    } else {
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      ctx.lineCap = layer.cap;
      ctx.lineJoin = layer.join;
      ctx.stroke(new Path2D(hit.map((it) => it.d).join('')));
    }
  }
}

/**
 * The parsed package as a Leaflet grid layer over its coverage bounds: canvas tiles in the given pane, each drawn in its
 * own task so a burst of new tiles after a zoom never holds a frame for long. Same georeferencing as L.imageOverlay.
 */
export function svgTileLayer(svg: SvgTiles, bounds: L.LatLngBounds, options: { pane: string; opacity: number }): L.GridLayer {
  const Tiles = L.GridLayer.extend({
    createTile(this: L.GridLayer & { _map: L.Map | null }, coords: L.Coords, done: L.DoneCallback) {
      const size = this.getTileSize();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const tile = document.createElement('canvas');
      tile.width = size.x * ratio;
      tile.height = size.y * ratio;
      tile.setAttribute('aria-hidden', 'true');
      window.setTimeout(() => {
        const map = this._map;
        if (map) {
          const nw = map.project(bounds.getNorthWest(), coords.z);
          const se = map.project(bounds.getSouthEast(), coords.z);
          draw(tile.getContext('2d')!, svg, tileWindow(coords, size, nw, se, svg), tile.width, tile.height);
        }
        done(undefined, tile);
      }, 0);
      return tile;
    },
  }) as unknown as new (o: L.GridLayerOptions) => L.GridLayer;
  return new Tiles({ bounds, pane: options.pane, opacity: options.opacity, keepBuffer: 3, updateWhenZooming: false, className: 'map-basemap-tiles' });
}
