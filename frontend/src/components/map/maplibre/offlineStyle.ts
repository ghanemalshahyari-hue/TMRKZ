import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';

/**
 * The offline MapLibre style of the Stationing V3 map (owner decision 5 of 4 Nov 2026; docs/audit/stationing-v3-production/
 * MAPLIBRE_LABELS.md). Everything comes from the application package: the basemap PMTiles (Protomaps schema, OSM),
 * an optional pre-rendered hillshade PMTiles, and the font file. There is no glyphs URL: the style declares the local
 * font in `font-faces`, and MapLibre draws every label glyph from it and shapes Arabic and orders mixed text itself
 * (no right-to-left plugin, nothing fetched from the internet).
 *
 * Two background modes share one style: "street" and "terrain" differ only in which basemap layers are visible, so a
 * mode switch never touches the overlays, the selection or the camera.
 */

export type BasemapMode = 'street' | 'terrain';
export type LabelLanguage = 'ar' | 'en';

/** A pre-rendered hillshade (PNG/WebP tiles, visual only) or an elevation tile set drawn with MapLibre's hillshade. */
export interface HillshadeSource {
  url: string;
  kind: 'raster' | 'raster-dem';
  encoding?: 'terrarium' | 'mapbox';
}

export interface OfflineStyleOptions {
  /** Absolute URL of the basemap PMTiles. */
  basemapUrl: string;
  /** Absolute URL of the label font file (Noto Sans Arabic covers Arabic, its presentation forms, Latin and digits). */
  fontUrl: string;
  hillshade?: HillshadeSource | null;
  mode?: BasemapMode;
  labels?: LabelLanguage;
}

/** The single font name of every label; it resolves only to the declared local file. */
export const LABEL_FONT = 'Noto Sans Arabic Regular';

/** Overlay layers are inserted below this empty layer: above every basemap layer, below the road and place labels. */
export const OVERLAY_ANCHOR = 'tmrkz-overlay-anchor';

/** Layer metadata key naming the mode a basemap layer belongs to ("street", "terrain" or "labels" for both). */
export const GROUP = 'tmrkz:group';

export const ROUTE_SHIELD = 'tmrkz-route-shield';

export const STREET_ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL) · Protomaps — أسماء الطرق من OpenStreetMap وليست أسماء رسمية';
/** The hillshade is a derived product, so it carries the licence's Article 6(b) notice word for word
 *  (map-packages/terrain-glo30-2026.11/LICENSE-NOTICE.txt); the DSM limitation is in MODE_NOTICE. */
export const TERRAIN_ATTRIBUTION =
  'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';

/** The notices the map shows beside the attribution, by mode. */
export const MODE_NOTICE: Record<BasemapMode, string> = {
  street: 'أسماء الطرق من OpenStreetMap وليست أسماء رسمية',
  terrain: 'طبيعة الأرض: Copernicus GLO-30 — نموذج سطح DSM وليس تضاريس رسمية (للعرض فقط)',
};

const C = {
  land: '#f3f1ec',
  landTerrain: '#ecebe6',
  park: '#dfe8d3',
  sand: '#efe6d2',
  urban: '#ebe7e1',
  water: '#b9d3e6',
  building: '#dedad3',
  casing: '#c9c3b8',
  highway: '#f2c879',
  major: '#ffffff',
  minor: '#ffffff',
  roadTerrain: '#8f8a80',
  text: '#3a3a3a',
  textRoute: '#1c3b57',
  halo: '#ffffff',
};

/** The label text of a feature in the chosen language, falling back to whatever name it has. */
export function labelField(lang: LabelLanguage): ExpressionSpecification {
  return lang === 'en'
    ? ['coalesce', ['get', 'name:en'], ['get', 'name'], ['get', 'name:ar']]
    : ['coalesce', ['get', 'name:ar'], ['get', 'name'], ['get', 'name:en']];
}

const group = (g: 'street' | 'terrain' | 'labels') => ({ [GROUP]: g });

/** River areas drawn fainter than other water: in the UAE they are tidal khors but also dry wadi beds. */
const riverFaint = (opacity: number): ExpressionSpecification => ['match', ['get', 'kind'], 'river', opacity * 0.45, opacity];

function roadWidth(kind: string, base: number): ExpressionSpecification {
  const k = { highway: 1, major_road: 0.75, minor_road: 0.45, path: 0.2 }[kind] ?? 0.3;
  return ['interpolate', ['exponential', 1.6], ['zoom'], 8, base * k * 0.4, 12, base * k * 1.6, 16, base * k * 7];
}

function streetLayers(): LayerSpecification[] {
  const roads = (['minor_road', 'major_road', 'highway'] as const).flatMap((kind): LayerSpecification[] => [
    {
      id: `road-${kind}-casing`,
      type: 'line',
      source: 'basemap',
      'source-layer': 'roads',
      minzoom: kind === 'minor_road' ? 13 : 7,
      filter: ['==', ['get', 'kind'], kind],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.casing, 'line-width': roadWidth(kind, 1.35) },
      metadata: group('street'),
    },
    {
      id: `road-${kind}`,
      type: 'line',
      source: 'basemap',
      'source-layer': 'roads',
      minzoom: kind === 'minor_road' ? 13 : 7,
      filter: ['==', ['get', 'kind'], kind],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': kind === 'highway' ? C.highway : kind === 'major_road' ? C.major : C.minor, 'line-width': roadWidth(kind, 1) },
      metadata: group('street'),
    },
  ]);
  return [
    { id: 'land', type: 'background', paint: { 'background-color': C.land }, metadata: group('street') },
    {
      id: 'landcover',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'landcover',
      paint: { 'fill-color': ['match', ['get', 'kind'], ['barren', 'sand'], C.sand, ['grassland', 'forest', 'scrub', 'farmland'], C.park, C.land] },
      metadata: group('street'),
    },
    {
      id: 'landuse',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'landuse',
      minzoom: 10,
      paint: { 'fill-color': ['match', ['get', 'kind'], ['park', 'golf_course', 'garden', 'grass', 'cemetery'], C.park, ['beach', 'sand'], C.sand, C.urban], 'fill-opacity': 0.8 },
      metadata: group('street'),
    },
    // OSM maps tidal khors and (mostly dry) mountain wadi beds alike as river areas; the tiles carry no intermittent flag
    { id: 'water', type: 'fill', source: 'basemap', 'source-layer': 'water', paint: { 'fill-color': C.water, 'fill-opacity': riverFaint(1) }, metadata: group('street') },
    {
      id: 'buildings',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'buildings',
      minzoom: 14,
      paint: { 'fill-color': C.building, 'fill-opacity': 0.9 },
      metadata: group('street'),
    },
    ...roads,
  ];
}

function terrainLayers(h: HillshadeSource | null | undefined): LayerSpecification[] {
  const out: LayerSpecification[] = [{ id: 'terrain-land', type: 'background', paint: { 'background-color': C.landTerrain }, metadata: group('terrain') }];
  if (h?.kind === 'raster') {
    out.push({ id: 'terrain-hillshade', type: 'raster', source: 'hillshade', paint: { 'raster-opacity': 0.85 }, metadata: group('terrain') });
  } else if (h?.kind === 'raster-dem') {
    out.push({
      id: 'terrain-hillshade',
      type: 'hillshade',
      source: 'hillshade',
      paint: { 'hillshade-shadow-color': '#5f5a52', 'hillshade-highlight-color': '#ffffff', 'hillshade-exaggeration': 0.5 },
      metadata: group('terrain'),
    });
  }
  out.push(
    { id: 'terrain-water', type: 'fill', source: 'basemap', 'source-layer': 'water', paint: { 'fill-color': C.water, 'fill-opacity': riverFaint(0.75) }, metadata: group('terrain') },
    {
      id: 'terrain-roads',
      type: 'line',
      source: 'basemap',
      'source-layer': 'roads',
      minzoom: 7,
      filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road', 'minor_road']]],
      paint: {
        'line-color': C.roadTerrain,
        'line-opacity': 0.7,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 14, ['match', ['get', 'kind'], 'highway', 2.4, 'major_road', 1.6, 0.8]],
      },
      metadata: group('terrain'),
    },
  );
  return out;
}

function labelLayers(lang: LabelLanguage): LayerSpecification[] {
  const text = { 'text-font': [LABEL_FONT], 'text-field': labelField(lang) };
  return [
    {
      id: OVERLAY_ANCHOR,
      type: 'background',
      layout: { visibility: 'none' },
      paint: { 'background-opacity': 0 },
      metadata: group('labels'),
    },
    {
      id: 'label-road',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'roads',
      minzoom: 12,
      filter: ['all', ['has', 'kind'], ['any', ['has', 'name'], ['has', 'name:ar'], ['has', 'name:en']]],
      layout: {
        ...text,
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 15],
        'text-max-angle': 30,
        'text-padding': 4,
      },
      paint: { 'text-color': C.text, 'text-halo-color': C.halo, 'text-halo-width': 1.6 },
      metadata: group('labels'),
    },
    {
      id: 'label-route',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'roads',
      minzoom: 8,
      filter: ['all', ['has', 'ref'], ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]]],
      layout: {
        'text-font': [LABEL_FONT],
        'text-field': ['get', 'ref'],
        'symbol-placement': 'line',
        'symbol-spacing': 420,
        'text-rotation-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        'text-size': 11,
        'icon-image': ROUTE_SHIELD,
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [2, 4, 2, 4],
        'text-padding': 6,
      },
      paint: { 'text-color': C.textRoute },
      metadata: group('labels'),
    },
    {
      id: 'label-place',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'places',
      filter: ['in', ['get', 'kind'], ['literal', ['locality', 'neighbourhood', 'macrohood', 'region']]],
      layout: {
        ...text,
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 12, 14, 17],
        'text-max-width': 9,
        'text-padding': 6,
        'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 20],
      },
      paint: { 'text-color': '#222222', 'text-halo-color': C.halo, 'text-halo-width': 2 },
      metadata: group('labels'),
    },
  ];
}

/** The complete offline style; `mode` only sets the initial visibility of the two background groups. */
export function buildOfflineStyle(o: OfflineStyleOptions): StyleSpecification {
  const mode = o.mode ?? 'street';
  const sources: StyleSpecification['sources'] = {
    basemap: { type: 'vector', url: 'pmtiles://' + o.basemapUrl, attribution: STREET_ATTRIBUTION },
  };
  if (o.hillshade?.kind === 'raster') {
    sources.hillshade = { type: 'raster', url: 'pmtiles://' + o.hillshade.url, tileSize: 256, attribution: TERRAIN_ATTRIBUTION };
  } else if (o.hillshade?.kind === 'raster-dem') {
    sources.hillshade = { type: 'raster-dem', url: 'pmtiles://' + o.hillshade.url, tileSize: 256, encoding: o.hillshade.encoding ?? 'terrarium', attribution: TERRAIN_ATTRIBUTION };
  }
  const layers = [...streetLayers(), ...terrainLayers(o.hillshade), ...labelLayers(o.labels ?? 'ar')].map((l) => withVisibility(l, mode));
  return {
    version: 8,
    name: 'TMRKZ offline (Stationing V3)',
    'font-faces': { [LABEL_FONT]: [{ url: o.fontUrl }] },
    sources,
    layers,
  };
}

/** Whether a basemap layer is shown in a mode; overlays (no group) are never touched. */
export function shownIn(layer: Pick<LayerSpecification, 'id' | 'metadata'>, mode: BasemapMode): boolean | null {
  if (layer.id === OVERLAY_ANCHOR) return false;
  const g = (layer.metadata as Record<string, unknown> | undefined)?.[GROUP];
  if (g === 'labels') return true;
  if (g === 'street' || g === 'terrain') return g === mode;
  return null;
}

function withVisibility(layer: LayerSpecification, mode: BasemapMode): LayerSpecification {
  const shown = shownIn(layer, mode);
  if (shown === null) return layer;
  return { ...layer, layout: { ...(layer.layout ?? {}), visibility: shown ? 'visible' : 'none' } } as LayerSpecification;
}

/** The minimal map surface a mode switch needs (a MapLibre map satisfies it). */
export interface ModeTarget {
  getStyle(): { layers: Pick<LayerSpecification, 'id' | 'metadata'>[] };
  setLayoutProperty(layer: string, name: 'visibility', value: 'visible' | 'none'): unknown;
}

/** Shows one background mode: only grouped basemap layers change visibility. */
export function setBasemapMode(map: ModeTarget, mode: BasemapMode): void {
  for (const layer of map.getStyle().layers) {
    const shown = shownIn(layer, mode);
    if (shown !== null) map.setLayoutProperty(layer.id, 'visibility', shown ? 'visible' : 'none');
  }
}

/**
 * The route-number shield as a stretchable image (drawn here, no sprite file): a rounded rectangle with a border, at
 * device pixel ratio 2, whose middle stretches to fit the number.
 */
export function routeShield(): {
  image: { width: number; height: number; data: Uint8Array };
  options: { pixelRatio: number; stretchX: [number, number][]; stretchY: [number, number][]; content: [number, number, number, number] };
} {
  const w = 40;
  const h = 32;
  const r = 8;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.min(Math.max(x + 0.5, r), w - r);
      const cy = Math.min(Math.max(y + 0.5, r), h - r);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const i = (y * w + x) * 4;
      if (d > r) continue;
      const border = d > r - 3 || x < 3 || y < 3 || x >= w - 3 || y >= h - 3;
      const [cr, cg, cb] = border ? [0x1c, 0x3b, 0x57] : [0xff, 0xff, 0xff];
      data[i] = cr;
      data[i + 1] = cg;
      data[i + 2] = cb;
      data[i + 3] = 255;
    }
  }
  return { image: { width: w, height: h, data }, options: { pixelRatio: 2, stretchX: [[r, w - r]], stretchY: [[r, h - r]], content: [6, 5, w - 6, h - 5] } };
}
