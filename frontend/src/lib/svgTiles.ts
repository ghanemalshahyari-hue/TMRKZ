/**
 * Vector tiles from an installed SVG_OVERLAY basemap package (owner approval of 3 Nov 2026: the map lagged while zooming).
 *
 * Leaflet's image overlay stretches the package's SVG between its coverage corners as one image; at the zoom of site and
 * polygon editing that image is tens of thousands of pixels wide and the browser rasterises it again after every zoom
 * step. Here the file is read once into its own drawing layers, each shape with its bounding box, and a 256-px tile draws
 * only the shapes that touch it — the SVG's colours, widths, fill rules and order, under the same linear mapping between
 * the projected corners that the overlay uses.
 *
 * Only the plain structure of the regional package is accepted: one background <rect> filling the view, <g fill> groups
 * of <path d>, and stroked <path fill="none">, with absolute M/L/Z path data and preserveAspectRatio="none". Anything else
 * (text, lines, curves, relative commands, transforms, styles, images, nested groups, an aspect-keeping viewBox …) gives
 * null and the caller keeps the image overlay, so no package is drawn differently from before. Pure: no DOM, no Leaflet.
 */
export type Item = { d: string; x0: number; y0: number; x1: number; y1: number; path?: Path2D };
export type Layer =
  | { kind: 'fill'; color: string; rule: 'evenodd' | 'nonzero'; items: Item[] }
  | { kind: 'stroke'; color: string; width: number; cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' | 'bevel'; items: Item[] };
export type SvgTiles = { width: number; height: number; background: string | null; layers: Layer[] };
export type Rect = { x: number; y: number; w: number; h: number };

const NUMBER = /-?(?:\d+(?:\.\d*)?|\.\d+)/g;
const COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/;
const NOT_A_COLOR = new Set(['none', 'currentcolor', 'inherit', 'initial', 'unset']);

const attrs = (s: string): Map<string, string> | null => {
  const out = new Map<string, string>();
  const rest = s.replace(/\s+([\w:-]+)="([^"]*)"/g, (_, k: string, v: string) => (out.set(k, v), ''));
  return rest.trim() ? null : out;
};
const only = (a: Map<string, string>, allowed: string[]) => [...a.keys()].every((k) => allowed.includes(k));
const color = (v: string | undefined) => (v && COLOR.test(v) && !NOT_A_COLOR.has(v.toLowerCase()) ? v : null);

/** Absolute M/L/Z data with whole coordinate pairs, as one item with its bounding box; null otherwise. */
function item(d: string): Item | null {
  if (!/^\s*M[MLZ\d\s.,-]*$/.test(d)) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const seg of d.match(/[MLZ][^MLZ]*/g) ?? []) {
    const n = (seg.slice(1).match(NUMBER) ?? []).map(Number);
    if (seg[0] === 'Z' ? n.length !== 0 : n.length === 0 || n.length % 2 !== 0) return null;
    for (let i = 0; i < n.length; i += 2) {
      if (n[i] < x0) x0 = n[i];
      if (n[i] > x1) x1 = n[i];
      if (n[i + 1] < y0) y0 = n[i + 1];
      if (n[i + 1] > y1) y1 = n[i + 1];
    }
  }
  return x0 <= x1 ? { d, x0, y0, x1, y1 } : null;
}

/** The package's SVG as drawing layers, or null when it is not in the plain structure described above. */
export function parseSvgTiles(text: string): SvgTiles | null {
  const tag = /\s*(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<(\/?)([a-zA-Z]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>)/y;
  let svg: { width: number; height: number } | null = null;
  let background: string | null = null;
  const layers: Layer[] = [];
  let group: (Layer & { kind: 'fill' }) | null = null;
  let closed = false;
  let at = 0;
  while (at < text.length) {
    tag.lastIndex = at;
    const m = tag.exec(text);
    if (!m) return text.slice(at).trim() ? null : finish();
    at = tag.lastIndex;
    if (!m[2]) continue; // declaration or comment
    const [, end, name, raw, self] = m;
    const a = attrs(raw);
    if (!a || closed) return null;
    if (!svg) {
      if (name !== 'svg' || end || self || !only(a, ['xmlns', 'version', 'width', 'height', 'viewBox', 'preserveAspectRatio'])) return null;
      const vb = /^0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/.exec(a.get('viewBox') ?? '');
      if (!vb || a.get('preserveAspectRatio') !== 'none') return null;
      svg = { width: +vb[1], height: +vb[2] };
      continue;
    }
    if (group) {
      if (name === 'g' && end) {
        layers.push(group);
        group = null;
        continue;
      }
      if (name !== 'path' || end || !self || !only(a, ['d'])) return null;
      const it = item(a.get('d') ?? '');
      if (!it) return null;
      group.items.push(it);
      continue;
    }
    if (name === 'svg' && end) {
      closed = true;
      continue;
    }
    if (end) return null;
    if (name === 'rect') {
      // the background: the first drawn element, filling the whole view
      const fill = color(a.get('fill'));
      if (!self || layers.length || background || !fill || !only(a, ['width', 'height', 'fill', 'x', 'y'])) return null;
      if (a.get('width') !== '100%' || a.get('height') !== '100%' || (a.get('x') ?? '0') !== '0' || (a.get('y') ?? '0') !== '0') return null;
      background = fill;
      continue;
    }
    if (name === 'g') {
      const fill = color(a.get('fill'));
      const rule = a.get('fill-rule') ?? 'nonzero';
      if (self || !fill || (rule !== 'evenodd' && rule !== 'nonzero') || (a.get('stroke') ?? 'none') !== 'none' || !only(a, ['fill', 'fill-rule', 'stroke'])) return null;
      group = { kind: 'fill', color: fill, rule, items: [] };
      continue;
    }
    if (name === 'path') {
      const stroke = color(a.get('stroke'));
      const width = Number(a.get('stroke-width') ?? '1');
      const cap = a.get('stroke-linecap') ?? 'butt';
      const join = a.get('stroke-linejoin') ?? 'miter';
      if (!self || a.get('fill') !== 'none' || !stroke || !(width > 0) || !only(a, ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'])) return null;
      if ((cap !== 'butt' && cap !== 'round' && cap !== 'square') || (join !== 'miter' && join !== 'round' && join !== 'bevel')) return null;
      // one item per subpath, so a tile strokes only the road segments that reach it
      const items = (a.get('d') ?? '').split(/(?=M)/).filter((s) => s.trim()).map(item);
      if (!items.length || items.some((x) => !x)) return null;
      layers.push({ kind: 'stroke', color: stroke, width, cap, join, items: items as Item[] });
      continue;
    }
    return null;
  }
  return finish();

  function finish(): SvgTiles | null {
    return svg && closed && !group ? { ...svg, background, layers } : null;
  }
}

/**
 * The rectangle of SVG user units under a tile, given the projected pixel positions of the coverage's north-west and
 * south-east corners at the tile's zoom: the viewBox is stretched linearly between them, as the image overlay does.
 */
export function tileWindow(tile: { x: number; y: number }, size: { x: number; y: number }, nw: { x: number; y: number }, se: { x: number; y: number }, svg: { width: number; height: number }): Rect {
  const kx = svg.width / (se.x - nw.x);
  const ky = svg.height / (se.y - nw.y);
  return { x: (tile.x * size.x - nw.x) * kx, y: (tile.y * size.y - nw.y) * ky, w: size.x * kx, h: size.y * ky };
}

/** The layer's shapes that can paint inside the rectangle (a stroke reaches up to twice its width past its path). */
export function itemsIn(layer: Layer, r: Rect): Item[] {
  const pad = layer.kind === 'stroke' ? layer.width * 2 : 0;
  return layer.items.filter((it) => it.x1 + pad >= r.x && it.x0 - pad <= r.x + r.w && it.y1 + pad >= r.y && it.y0 - pad <= r.y + r.h);
}
