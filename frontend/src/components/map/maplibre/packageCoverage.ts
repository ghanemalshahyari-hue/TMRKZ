import { PMTiles } from 'pmtiles';

/**
 * No empty edge on any map (owner, 28 Nov 2026): the installed package holds the tiles that touch its extent (the PMTiles
 * header's bounds), whole, at every zoom it carries — so a low zoom shows more of the region than a high one, and past
 * those tiles there is nothing but the background. The map draws the package's low-zoom region tile under the detailed
 * one (offlineStyle.ts, WIDE_SOURCE), and the camera is kept where every pixel has a tile: on the tiles of `maxTileZoom`
 * (the region tile) — the view is moved, and its zoom raised only if it is wider than them. {@link coveragePolygon} gives
 * the area the detailed tiles of a zoom cover, where the region tile is hidden.
 */
export type PackageExtent = { west: number; south: number; east: number; north: number; minZoom: number; maxZoom: number };

/** MapLibre's world tile size; the basemap is a vector source with the default 512-pixel tiles, so its tile zoom is ⌊zoom⌋. */
const TILE = 512;

const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
const lngOf = (x: number) => x * 360 - 180;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** The Web-Mercator box (0…1, y downwards) of the package's tiles at one tile zoom: every tile touching its extent. */
export function coverageAt(e: PackageExtent, tileZoom: number): { x0: number; x1: number; y0: number; y1: number } {
  const z = Math.min(Math.max(Math.floor(tileZoom), e.minZoom), e.maxZoom);
  const n = 2 ** z;
  // a bound lying exactly on a tile edge does not reach into the next tile
  const tile = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v * n)));
  return {
    x0: tile(mercX(e.west)) / n,
    x1: (tile(mercX(e.east) - 1e-12) + 1) / n,
    y0: tile(mercY(e.north)) / n,
    y1: (tile(mercY(e.south) - 1e-12) + 1) / n,
  };
}

export type ViewSize = {
  width: number;
  height: number;
  /** degrees; a turned map needs the box around the turned screen */
  bearing?: number;
  /** the camera's padding moves its centre off the middle of the screen */
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
};

/**
 * The nearest camera whose whole screen lies on the package's tiles: the zoom is raised only when the screen is wider or
 * taller than the tiles of that zoom (each raise may reach a zoom whose tiles cover less, so it repeats until it holds),
 * then the centre is moved inwards just enough. Within `minZoom`…`maxZoom`, like MapLibre's own constraint.
 */
export function constrainToCoverage(
  e: PackageExtent,
  center: { lng: number; lat: number },
  zoom: number,
  view: ViewSize,
  limits: { minZoom: number; maxZoom: number },
  maxTileZoom = Number.POSITIVE_INFINITY,
): { lng: number; lat: number; zoom: number } {
  const tilesOf = (z: number) => coverageAt(e, Math.min(Math.floor(z), maxTileZoom));
  let z = Math.min(Math.max(zoom, limits.minZoom), limits.maxZoom);
  if (!(view.width > 0 && view.height > 0)) return { lng: center.lng, lat: center.lat, zoom: z };
  const p = view.padding ?? {};
  const hx = (view.width + Math.abs((p.left ?? 0) - (p.right ?? 0))) / 2;
  const hy = (view.height + Math.abs((p.top ?? 0) - (p.bottom ?? 0))) / 2;
  const r = ((view.bearing ?? 0) * Math.PI) / 180;
  const ex = hx * Math.abs(Math.cos(r)) + hy * Math.abs(Math.sin(r));
  const ey = hx * Math.abs(Math.sin(r)) + hy * Math.abs(Math.cos(r));
  for (let i = 0; i < 32; i++) {
    const c = tilesOf(z);
    const need = Math.log2(Math.max((2 * ex) / (c.x1 - c.x0), (2 * ey) / (c.y1 - c.y0)) / TILE);
    if (z >= need - 1e-9) break;
    z = Math.min(need, limits.maxZoom);
    if (z === limits.maxZoom) break;
  }
  const c = tilesOf(z);
  const world = TILE * 2 ** z;
  const inside = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
  const x = inside(mercX(center.lng), c.x0 + ex / world, c.x1 - ex / world);
  const y = inside(mercY(center.lat), c.y0 + ey / world, c.y1 - ey / world);
  return { lng: lngOf(x), lat: latOf(y), zoom: z };
}

/** The area the detailed tiles of a zoom cover, as a GeoJSON polygon (lng/lat). */
export function coveragePolygon(e: PackageExtent, tileZoom: number): GeoJSON.Polygon {
  const c = coverageAt(e, tileZoom);
  const w = lngOf(c.x0), east = lngOf(c.x1), n = latOf(c.y0), s = latOf(c.y1);
  return { type: 'Polygon', coordinates: [[[w, s], [east, s], [east, n], [w, n], [w, s]]] };
}

const extents = new Map<string, Promise<PackageExtent | null>>();

/** The installed basemap's extent from its PMTiles header (one small range request per address); null when unreadable. */
export function packageExtent(url: string): Promise<PackageExtent | null> {
  let found = extents.get(url);
  if (!found) {
    found = new PMTiles(url)
      .getHeader()
      .then((h) =>
        [h.minLon, h.minLat, h.maxLon, h.maxLat].every(Number.isFinite) && h.maxLon > h.minLon && h.maxLat > h.minLat
          ? { west: h.minLon, south: h.minLat, east: h.maxLon, north: h.maxLat, minZoom: h.minZoom, maxZoom: h.maxZoom }
          : null,
      )
      .catch(() => null);
    extents.set(url, found);
  }
  return found;
}
