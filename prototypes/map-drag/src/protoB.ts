// Prototype B — MapLibre GL JS (WebGL, one GPU canvas), same scene and same isolation architecture as A-opt.
// The N facilities, occupied zones and the allowed range are GPU layers (one draw call each, count-independent).
// The proposal is a draggable DOM Marker; only a thin line source + the marker's own text change during the drag.
// No committed-state update and no server call fire while the pointer moves. Soft boundary (no snap-back).
// Terra Draw is loaded lazily, only for the optional footprint polygon, so the core demo never depends on it.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Emit MapLibre's worker as a hashed asset and point the engine at it explicitly. The engine otherwise derives the
// worker URL from import.meta.url, which the Vite production build does not resolve (worker 404 → blank map). This
// keeps everything local — the worker file is served from our own origin, no CDN.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import { metrics, rafThrottle } from './metrics';
import { CURRENT, OCCUPIED, RANGE_INNER, RANGE_OUTER, RULE, distanceM, formatKm, pointInOccupied, type Facility, type LatLng } from './data';
import type { Commit, ProtoHandle } from './protoA';

const xy = (p: LatLng): [number, number] => [p.lng, p.lat];
const ring = (r: LatLng[]): [number, number][] => r.map(xy);

export function mountProtoB(el: HTMLElement, facilities: Facility[]): ProtoHandle {
  metrics.mode = 'opt';
  let commitCb: (c: Commit) => void = () => {};
  let terra: { stop: () => void } | null = null;

  const map = new maplibregl.Map({
    container: el,
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef2f3' } }] },
    center: xy(CURRENT.at),
    zoom: 12,
    attributionControl: false,
    // honour the air-gap: never let the engine fetch anything remote
    transformRequest: (url) => { if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url) && !/^(data|blob):/.test(url)) return { url: '' }; return { url }; },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

  const facFC = {
    type: 'FeatureCollection' as const,
    features: facilities.map((f) => ({ type: 'Feature' as const, properties: { busy: f.busy ? 1 : 0 }, geometry: { type: 'Point' as const, coordinates: xy(f.at) } })),
  };
  const occFC = {
    type: 'FeatureCollection' as const,
    features: OCCUPIED.map((z) => ({ type: 'Feature' as const, properties: { name: z.name }, geometry: { type: 'Polygon' as const, coordinates: [ring(z.ring)] } })),
  };
  const rangeFC = { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring(RANGE_OUTER), ring(RANGE_INNER)] } };
  const lineFC = () => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [xy(CURRENT.at), xy(proposal)] } });

  let proposal: LatLng = { lat: CURRENT.at.lat, lng: CURRENT.at.lng + 0.03 };

  const propEl = document.createElement('div');
  propEl.className = 'pB-prop';
  propEl.innerHTML = '<span class="pin green" data-pin>⌖</span><span class="chip" data-chip></span>';
  const marker = new maplibregl.Marker({ element: propEl, draggable: true, anchor: 'top-left' }).setLngLat(xy(proposal));
  const curEl = document.createElement('div');
  curEl.className = 'pB-cur';
  curEl.innerHTML = '<span class="pin blue">▣</span><span class="lbl">المقر الحالي</span>';

  map.on('load', () => {
    map.addSource('range', { type: 'geojson', data: rangeFC });
    map.addLayer({ id: 'range-fill', type: 'fill', source: 'range', paint: { 'fill-color': '#2bb36a', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'range-line', type: 'line', source: 'range', paint: { 'line-color': '#1f9d55', 'line-width': 2, 'line-dasharray': [3, 2] } });
    map.addSource('occ', { type: 'geojson', data: occFC });
    map.addLayer({ id: 'occ-fill', type: 'fill', source: 'occ', paint: { 'fill-color': '#e74c3c', 'fill-opacity': 0.35 } });
    map.addLayer({ id: 'occ-line', type: 'line', source: 'occ', paint: { 'line-color': '#c0392b', 'line-width': 2 } });
    map.addSource('fac', { type: 'geojson', data: facFC });
    map.addLayer({
      id: 'fac-dot', type: 'circle', source: 'fac',
      paint: { 'circle-radius': 4, 'circle-color': ['case', ['==', ['get', 'busy'], 1], '#e05a54', '#45b488'], 'circle-stroke-width': 1, 'circle-stroke-color': ['case', ['==', ['get', 'busy'], 1], '#b23b36', '#2f8f6f'] },
    });
    map.addSource('line', { type: 'geojson', data: lineFC() });
    map.addLayer({ id: 'line', type: 'line', source: 'line', paint: { 'line-color': '#16324f', 'line-width': 2.2, 'line-dasharray': [2, 2] } }, 'fac-dot');
    new maplibregl.Marker({ element: curEl, anchor: 'top-left' }).setLngLat(xy(CURRENT.at)).addTo(map);
    marker.addTo(map);
    paint(proposal);
    commit(proposal, false);
  });

  const pin = () => propEl.querySelector('[data-pin]') as HTMLElement;
  const chip = () => propEl.querySelector('[data-chip]') as HTMLElement;

  function paint(p: LatLng) {
    const d = distanceM(CURRENT.at, p);
    const inRange = d >= RULE.minM && (RULE.maxM == null || d <= RULE.maxM);
    const occ = pointInOccupied(p, OCCUPIED);
    const src = map.getSource('line') as maplibregl.GeoJSONSource | undefined;
    src?.setData(lineFC());
    pin().classList.toggle('bad', !inRange || !!occ);
    pin().classList.toggle('ok', inRange && !occ);
    chip().textContent = formatKm(d) + (occ ? ' · محجوز' : !inRange ? ' · خارج النطاق' : '');
    metrics.setLive({ distanceM: d, inRange, occupied: occ?.name ?? '', clamped: '' });
  }
  function commit(p: LatLng, validating: boolean) {
    const d = distanceM(CURRENT.at, p);
    const inRange = d >= RULE.minM && (RULE.maxM == null || d <= RULE.maxM);
    const occ = pointInOccupied(p, OCCUPIED);
    metrics.countHeavyUpdate();
    commitCb({ at: p, distanceM: d, inRange, occupied: occ?.name ?? null, validating });
  }

  const onMove = rafThrottle((p: LatLng) => { proposal = p; paint(p); });
  marker.on('dragstart', () => metrics.beginDrag());
  marker.on('drag', () => { const l = marker.getLngLat(); onMove({ lat: l.lat, lng: l.lng }); });
  marker.on('dragend', () => {
    const l = marker.getLngLat();
    proposal = { lat: l.lat, lng: l.lng };
    paint(proposal);
    commit(proposal, true);
    metrics.countServerValidation();
    window.setTimeout(() => commit(proposal, false), 160);
    metrics.endDrag();
  });

  return {
    destroy() { try { terra?.stop(); } catch { /* ignore */ } map.remove(); },
    onCommit(cb) { commitCb = cb; },
    // optional footprint editing via Terra Draw; isolated so a v6 adapter issue never breaks the core demo
    async startFootprint() {
      try {
        const td = await import('terra-draw');
        const ad = await import('terra-draw-maplibre-gl-adapter');
        const draw = new td.TerraDraw({
          adapter: new ad.TerraDrawMapLibreGLAdapter({ map, coordinatePrecision: 9 }),
          modes: [new td.TerraDrawRectangleMode(), new td.TerraDrawSelectMode({ flags: { rectangle: { feature: { draggable: true, coordinates: { draggable: true, resizable: 'center-fixed' } } } } })],
        });
        draw.start();
        draw.setMode('rectangle');
        draw.on('finish', () => draw.setMode('select'));
        terra = draw;
        return true;
      } catch (e) {
        console.warn('Terra Draw footprint unavailable on this MapLibre version:', e);
        return false;
      }
    },
  } as ProtoHandle & { startFootprint(): Promise<boolean> };
}
