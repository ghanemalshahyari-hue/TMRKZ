import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Map as MlMap } from 'maplibre-gl';
import { OfflineMapLibre, addOverlayLayer } from '../../../frontend/src/components/map/maplibre/OfflineMapLibre';
import { LABEL_FONT, labelField, type BasemapMode, type HillshadeSource, type LabelLanguage } from '../../../frontend/src/components/map/maplibre/offlineStyle';
import { runGlyphCheck } from './glyphs';
import { SAMPLES } from './samples';

/**
 * Harness pages. `?page=map` (default): the offline module with a test overlay (a fictional polygon with a selection
 * state and a column of test labels); `?page=glyphs`: the shaping and order check. Query: `hillshade=<url>&kind=raster`,
 * `labels=ar|en`, `center=lng,lat`, `zoom=n`, `mode=street|terrain`, `glyphfix=off` (glyph check without the
 * component's left-to-right glyph canvases).
 */
const q = new URLSearchParams(location.search);
// `dir=ltr` reproduces the page-direction effect on glyph rasterising (see MAPLIBRE_LABELS.md §2)
if (q.get('dir') === 'split') {
  document.documentElement.dir = 'ltr';
  document.body.dir = 'rtl';
} else if (q.get('dir')) document.documentElement.dir = q.get('dir')!;

declare global {
  interface Window {
    __ml?: { map: MlMap; setMode: (m: BasemapMode) => void; setLabels: (l: LabelLanguage) => void; labelPoints: [number, number][] };
    __glyphs?: Promise<unknown>;
  }
}

function overlay(map: MlMap) {
  const c = map.getCenter();
  const d = 0.004;
  map.addSource('test-area', {
    type: 'geojson',
    promoteId: 'id',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { id: 1 },
          geometry: { type: 'Polygon', coordinates: [[[c.lng - d, c.lat - d], [c.lng + d, c.lat - d], [c.lng + d, c.lat + d], [c.lng - d, c.lat + d], [c.lng - d, c.lat - d]]] },
        },
      ],
    },
  });
  addOverlayLayer(map, {
    id: 'test-area-fill',
    type: 'fill',
    source: 'test-area',
    paint: { 'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#2e7d32', '#1565c0'], 'fill-opacity': 0.35 },
  });
  addOverlayLayer(map, { id: 'test-area-line', type: 'line', source: 'test-area', paint: { 'line-color': '#1b5e20', 'line-width': 2 } });
  map.setFeatureState({ source: 'test-area', id: 1 }, { selected: true });
  const points = SAMPLES.map((_, i): [number, number] => [c.lng + 0.012, c.lat + 0.006 - i * 0.0011]);
  map.addSource('test-labels', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: points.map((coordinates, i) => ({
        type: 'Feature' as const,
        properties: { t: SAMPLES[i].text },
        geometry: { type: 'Point' as const, coordinates },
      })),
    },
  });
  addOverlayLayer(
    map,
    {
      id: 'test-labels',
      type: 'symbol',
      source: 'test-labels',
      layout: { 'text-field': ['get', 't'], 'text-font': [LABEL_FONT], 'text-size': 13, 'text-allow-overlap': true },
      paint: { 'text-color': '#7b1fa2', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    },
    'top',
  );
  return points;
}

function MapPage() {
  const [mode, setMode] = useState<BasemapMode>((q.get('mode') as BasemapMode) ?? 'street');
  const center = (q.get('center') ?? '55.2744,25.1972').split(',').map(Number) as [number, number];
  const hillshade: HillshadeSource | null = q.get('hillshade') ? { url: q.get('hillshade')!, kind: (q.get('kind') as 'raster') ?? 'raster' } : null;
  return (
    <div className="page" dir="rtl">
      <div className="bar">
        <button data-testid="mode-street" aria-pressed={mode === 'street'} onClick={() => setMode('street')}>الشوارع</button>
        <button data-testid="mode-terrain" aria-pressed={mode === 'terrain'} onClick={() => setMode('terrain')}>طبيعة الأرض</button>
        <span className="note">نموذج تجريبي لخريطة MapLibre دون اتصال — بيانات اختبار وهمية</span>
      </div>
      <div className="map">
        <OfflineMapLibre
          basemapUrl="/map-data/basemap/uae.pmtiles"
          hillshade={hillshade}
          mode={mode}
          labels={(q.get('labels') as LabelLanguage) ?? 'ar'}
          center={center}
          zoom={Number(q.get('zoom') ?? 14)}
          preserveDrawingBuffer
          onReady={(map) => {
            const labelPoints = overlay(map);
            window.__ml = {
              map,
              labelPoints,
              setMode,
              setLabels: (l) => map.setLayoutProperty('label-road', 'text-field', labelField(l)),
            };
          }}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root')!;
if (q.get('page') === 'glyphs') {
  window.__glyphs = runGlyphCheck(root, q.get('glyphfix') !== 'off');
} else {
  createRoot(root).render(
    <StrictMode>
      <MapPage />
    </StrictMode>,
  );
}

