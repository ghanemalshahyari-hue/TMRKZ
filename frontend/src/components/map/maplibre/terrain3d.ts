import type { LngLatLike, Map as MlMap } from 'maplibre-gl';
import { PMTiles } from 'pmtiles';
import type { LatLng } from '../../../lib/geo';
import { DEM_TILE, DEM_ZOOM, sampleTile, slopePctTile, tileOf, tilesFor } from '../../../lib/terrainRgb';
import { RELIEF_3D, SHADE_3D, TERRAIN_3D_SOURCE, type BasemapMode } from './offlineStyle';

/**
 * The 3D view of the offline map (owner brief «TRUE OFFLINE 3D TERRAIN», 6 Nov 2026; ADR-038): MapLibre's own terrain
 * from the package's Terrain-RGB tiles (`setTerrain`, exaggeration 1 — real heights), a tint and shade of the relief,
 * a dark sky at the horizon and a tilted camera. Every fill and line layer — sites, areas, occupied ground, connectors —
 * is then draped on the ground by MapLibre itself; markers and labels stand at the ground's height. The view changes
 * presentation only: no geometry, request content or history is touched, and leaving it restores the flat map.
 */
export type MapView = '2d' | '3d';

/** The tilt of the 3D view: hills and valleys read clearly while boundaries behind a ridge stay visible. */
export const PITCH_3D = 55;
/** Terrain height scale: 1 (owner brief §30 — no exaggeration; display only in any case). */
export const EXAGGERATION = 1;

const SKY = {
  'sky-color': '#0c1b2c',
  'sky-horizon-blend': 0.6,
  'horizon-color': '#35506b',
  'horizon-fog-blend': 0.45,
  'fog-color': '#c3cbd1',
  'fog-ground-blend': 0.75,
  'atmosphere-blend': 0,
};

/** The first layer the 3D tint and shade must stay below in each background mode (roads, water lines, labels above). */
const BELOW: Record<BasemapMode, string> = { street: 'road-minor_road-casing', terrain: 'terrain-water' };

/** Whether the map's style carries the 3D elevation source (the installed package has the `terrain-3d` component). */
export const has3d = (map: MlMap) => !!map.getSource(TERRAIN_3D_SOURCE);

/**
 * Turns the 3D view on or off. On: terrain from the elevation tiles, the tint and shade placed for the background mode,
 * the sky. Off: the flat map exactly as before (the 2D background's own layers untouched).
 */
export function setView3d(map: MlMap, view: MapView, mode: BasemapMode): void {
  if (!has3d(map)) return;
  if (view === '3d') {
    if (!map.getTerrain()) map.setTerrain({ source: TERRAIN_3D_SOURCE, exaggeration: EXAGGERATION });
    map.setSky(SKY);
    place3dLayers(map, mode, true);
  } else {
    if (map.getTerrain()) map.setTerrain(null);
    place3dLayers(map, mode, false);
  }
}

/**
 * The tint and the shade sit just below the background's roads (street) or water (terrain), so the relief shows through
 * every road, water body and label. In the terrain background the pre-rendered hillshade is faded out while 3D is on
 * (the live shade of the elevation tiles replaces it) and comes back unchanged in 2D.
 */
export function place3dLayers(map: MlMap, mode: BasemapMode, on: boolean): void {
  const before = map.getLayer(BELOW[mode]) ? BELOW[mode] : undefined;
  for (const id of [RELIEF_3D, SHADE_3D]) {
    if (!map.getLayer(id)) continue;
    if (on && before) map.moveLayer(id, before);
    map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  if (map.getLayer('terrain-hillshade')) map.setPaintProperty('terrain-hillshade', 'raster-opacity', on ? 0 : 0.85);
}

/**
 * Brings points into view: from above in 2D, tilted at {@link PITCH_3D} in 3D (a little further out, so the far side
 * of a tilted view keeps them). The bearing the person chose is kept.
 */
export function frame(map: MlMap, points: LatLng[], view: MapView, opts: { padding?: number | { top: number; right: number; bottom: number; left: number }; maxZoom?: number; duration?: number } = {}): void {
  if (!points.length) return;
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  // in 3D the cards stand up to about 170 px above their geometry: room for them at the top
  const padding = opts.padding ?? (view === '3d' ? { top: 175, right: 70, bottom: 160, left: 80 } : { top: 70, right: 70, bottom: 150, left: 80 });
  const cam = map.cameraForBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding, maxZoom: opts.maxZoom ?? 16 });
  if (!cam) return;
  const duration = opts.duration ?? 700;
  if (view !== '3d') return void map.easeTo({ center: cam.center, zoom: cam.zoom, pitch: 0, bearing: map.getBearing(), duration });
  const t = fit3d(map, points, cam.center as LngLatLike, cam.zoom ?? map.getZoom(), padding);
  map.easeTo({ ...t, pitch: PITCH_3D, bearing: map.getBearing(), duration });
}

/**
 * The tilted camera that keeps every point inside the padded view, whatever the map's shape (a tall portrait map as well
 * as a wide one): tried at the target pitch with the terrain's real heights — each try projects the points over the
 * terrain — re-centred on the points as they appear, and widened step by step until all fit. The person's camera is
 * restored before the eased move, so nothing is shown in between.
 */
function fit3d(map: MlMap, points: LatLng[], center: LngLatLike, zoom: number, pad: number | { top: number; right: number; bottom: number; left: number }) {
  const p = typeof pad === 'number' ? { top: pad, right: pad, bottom: pad, left: pad } : pad;
  const c = map.getCanvas();
  const [w, h] = [c.clientWidth, c.clientHeight];
  const box = { left: p.left, right: w - p.right, top: p.top, bottom: h - p.bottom };
  const before = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  const c0 = map.getCenter();
  let at = { lng: (center as { lng?: number }).lng ?? c0.lng, lat: (center as { lat?: number }).lat ?? c0.lat };
  let z = zoom;
  const b = (before.bearing * Math.PI) / 180;
  const tilt = Math.cos((PITCH_3D * Math.PI) / 180);
  for (let i = 0; i < 24; i++) {
    map.jumpTo({ center: [at.lng, at.lat], zoom: z, pitch: PITCH_3D, bearing: before.bearing });
    // `project` reads the terrain heights of the elevation tiles (not the last drawn frame), so each try is exact
    const s = points.map((q) => map.project([q.lng, q.lat]));
    const [x0, x1] = [Math.min(...s.map((v) => v.x)), Math.max(...s.map((v) => v.x))];
    const [y0, y1] = [Math.min(...s.map((v) => v.y)), Math.max(...s.map((v) => v.y))];
    // centre the points' screen extent in the padded box (a tilted view compresses the far side): the screen offset as
    // ground metres around the centre, turned by the bearing (an estimate; the next try measures again)
    const dx = (x0 + x1) / 2 - (box.left + box.right) / 2;
    const dy = (y0 + y1) / 2 - (box.top + box.bottom) / 2;
    const fits = x1 - x0 <= box.right - box.left && y1 - y0 <= box.bottom - box.top;
    if (fits && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) break;
    const mpp = (40075016.686 * Math.cos((at.lat * Math.PI) / 180)) / (512 * 2 ** z);
    const up = (-dy * mpp) / tilt;
    const right = dx * mpp;
    const north = up * Math.cos(b) - right * Math.sin(b);
    const east = up * Math.sin(b) + right * Math.cos(b);
    at = { lat: at.lat + north / 110_900, lng: at.lng + east / (111_320 * Math.cos((at.lat * Math.PI) / 180)) };
    if (!fits) z -= 0.15;
  }
  map.jumpTo(before);
  return { center: [at.lng, at.lat] as LngLatLike, zoom: z };
}

/**
 * Elevations at points, read from the same Terrain-RGB tiles the 3D view draws (finest zoom, bilinear) — independent
 * of the camera, the tiles loaded on screen and the exaggeration. DISPLAY ONLY: no rule reads them. Decoded tiles are
 * kept (a few dozen); a point outside the product reads null.
 */
export class DemSampler {
  private readonly archive: PMTiles;
  private readonly tiles = new Map<string, Promise<Uint8ClampedArray | null>>();
  private readonly slopes = new Map<string, Float32Array | null>();

  constructor(url: string) {
    this.archive = new PMTiles(new URL(url, document.baseURI).href);
  }

  private tile(x: number, y: number): Promise<Uint8ClampedArray | null> {
    const key = `${DEM_ZOOM}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = this.archive
        .getZxy(DEM_ZOOM, x, y)
        .then(async (r) => {
          if (!r?.data) return null;
          const bmp = await createImageBitmap(new Blob([r.data], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          const c = new OffscreenCanvas(DEM_TILE, DEM_TILE);
          const g = c.getContext('2d', { willReadFrequently: true })!;
          g.drawImage(bmp, 0, 0);
          bmp.close();
          return g.getImageData(0, 0, DEM_TILE, DEM_TILE).data;
        })
        .catch(() => null);
      this.tiles.set(key, t);
      if (this.tiles.size > 64) this.tiles.delete(this.tiles.keys().next().value!);
    }
    return t;
  }

  async heights(points: LatLng[]): Promise<(number | null)[]> {
    const need = tilesFor(points);
    const data = new Map<string, Uint8ClampedArray | null>();
    await Promise.all([...need].map(async ([k, t]) => data.set(k, await this.tile(t.x, t.y))));
    return points.map((p) => {
      const t = tileOf(p);
      const d = data.get(`${DEM_ZOOM}/${t.x}/${t.y}`);
      return d ? Math.round(sampleTile(d, t.px, t.py) * 10) / 10 : null;
    });
  }

  /** The tiles missing for {@link slopeAt} over these points' extent (none: {@link slopeAt} answers at once). */
  private missingSlopes(points: LatLng[]): { x: number; y: number }[] {
    if (!points.length) return [];
    const a = tileOf({ lat: Math.max(...points.map((p) => p.lat)), lng: Math.min(...points.map((p) => p.lng)) });
    const b = tileOf({ lat: Math.min(...points.map((p) => p.lat)), lng: Math.max(...points.map((p) => p.lng)) });
    const out: { x: number; y: number }[] = [];
    for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) if (!this.slopes.has(`${x}/${y}`)) out.push({ x, y });
    return out;
  }

  slopesReady = (points: LatLng[]) => this.missingSlopes(points).length === 0;

  /** Reads and keeps the slope of the tiles under these points. */
  async loadSlopes(points: LatLng[]): Promise<void> {
    await Promise.all(
      this.missingSlopes(points).map(async ({ x, y }) => {
        const d = await this.tile(x, y);
        this.slopes.set(`${x}/${y}`, d ? slopePctTile(d, DEM_ZOOM, y) : null);
        if (this.slopes.size > 64) this.slopes.delete(this.slopes.keys().next().value!);
      }),
    );
  }

  /** Slope percent of a whole elevation pixel at the finest zoom (world pixel numbers); NaN when absent or not loaded. */
  slopeAt = (px: number, py: number): number => {
    const t = this.slopes.get(`${Math.floor(px / DEM_TILE)}/${Math.floor(py / DEM_TILE)}`);
    if (!t) return NaN;
    const x = px - Math.floor(px / DEM_TILE) * DEM_TILE;
    const y = py - Math.floor(py / DEM_TILE) * DEM_TILE;
    return t[y * DEM_TILE + x];
  };
}
