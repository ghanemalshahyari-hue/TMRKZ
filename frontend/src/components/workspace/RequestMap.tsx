import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { RestationingChecks, RestationingRequest } from '../../api/types';
import { BASEMAP_URL, HILLSHADE, OfflineMapLibre, addOverlayLayer } from '../map/maplibre';
import { LABEL_FONT, type BasemapMode } from '../map/maplibre/offlineStyle';
import { centre, requestFeatures } from '../../lib/requestMap';
import { siteReferenceFeatures, sitesExtent } from '../../lib/sitesLayer';
import { SiteInfoCard } from './SiteInfoCard';
import { addSiteLayers, bindSiteClicks, setSiteData } from './siteLayers';
import { useRegisteredSites } from './useRegisteredSites';

/**
 * Map semantics of the operational workspace (owner brief «FULL APPLICATION UI REBUILD», §9): current site coral, the
 * proposed re-stationing site teal, the primary deployment area green hatch, the alternative cyan hatch, deployment
 * bands dashed teal, and the re-stationing move a neutral slate line (information only: no colour verdict).
 */
export const MAP_COLOURS = {
  CURRENT: '#2f6db0',
  SITE: '#0b9e86',
  PRIMARY: '#2f9a55',
  ALTERNATIVE: '#7b4fc0',
  BAND_PRIMARY: '#127f73',
  BAND_ALTERNATIVE: '#2a6fa8',
  MOVE: '#3c4c59',
  OCCUPIED: '#c0392b',
} as const;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A diagonal hatch (drawn here, no sprite file): 16 px tiles at device pixel ratio 2. */
function hatch(hex: string) {
  const n = 16;
  const data = new Uint8Array(n * n * 4);
  const [r, g, b] = rgb(hex);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const on = (x + y) % 8 < 2;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = on ? 150 : 28;
    }
  }
  return { image: { width: n, height: n, data }, options: { pixelRatio: 2 } };
}

/** The arrowhead of the move line, pointing north before rotation. */
function arrow(hex: string) {
  const n = 28;
  const data = new Uint8Array(n * n * 4);
  const [r, g, b] = rgb(hex);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const half = ((y + 1) / n) * (n / 2);
      const inside = y >= 3 && y <= n - 4 && Math.abs(x + 0.5 - n / 2) <= half * 0.85;
      const i = (y * n + x) * 4;
      if (!inside) continue;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 235;
    }
  }
  return { image: { width: n, height: n, data }, options: { pixelRatio: 2 } };
}

/** The request on the offline map: current sites, the proposed site, the deployment areas, their bands and the move. */
export function RequestMap({ request, checks, mode, onMap, fitMaxZoom = 15, hideSite = false, fit = true, fitKey = 0, referenceInteractive = true, pick = null, focus = null, fitSites = false, highlight = null, occupied = null }: {
  request: RestationingRequest;
  checks: RestationingChecks | null;
  mode: BasemapMode;
  onMap?: (m: MlMap) => void;
  fitMaxZoom?: number;
  hideSite?: boolean;
  fit?: boolean;
  /** Changing it frames every site and area of the request again («الحدود والمناطق»). */
  fitKey?: number;
  /** The deployment area being placed: its band shows before the area exists (requestFeatures). */
  /** False while the editor places the proposed site or an area: the registered sites then take no click. */
  referenceInteractive?: boolean;
  /**
   * The current-site step of a new request: a click on a site picks it (the editor shows its card with the explicit
   * «بدء طلب إعادة تمركز من هذا الموقع»; a click alone starts nothing), and the picked or chosen site is highlighted.
   */
  pick?: { selectedId: string | null; onPick: (siteId: string | null, here?: string[]) => void } | null;
  /** Bring one site into view (a search result, a site chosen elsewhere); a new key flies again. */
  focus?: { siteId: string; key: number } | null;
  /** With nothing of the request to frame yet, frame every registered site once. */
  fitSites?: boolean;
  /** A site kept highlighted (the request's current site) while clicks still open information cards. */
  highlight?: string | null;
  /** Occupied ground while the new site is placed: sites of units other than the moving ones, in red. */
  occupied?: GeoJSON.FeatureCollection | null;
}) {
  const [map, setMap] = useState<MlMap | null>(null);
  // the registered sites as a reference layer below the request (owner decision of 5 Nov 2026, item 4): information on
  // a click, never a change to the request
  const registered = useRegisteredSites();
  const [info, setInfo] = useState<string | null>(null);
  const highlighted = pick ? pick.selectedId : (info ?? highlight);
  const refData = useMemo(() => siteReferenceFeatures(registered.all, highlighted, registered.counts), [registered.all, highlighted, registered.counts]);
  const interactive = useRef(referenceInteractive);
  interactive.current = referenceInteractive;
  const onSite = useRef<(id: string | null, here?: string[]) => void>(setInfo);
  onSite.current = pick ? pick.onPick : setInfo;
  useEffect(() => {
    if (!referenceInteractive) setInfo(null);
  }, [referenceInteractive]);
  useEffect(() => {
    if (map) setSiteData(map, refData);
  }, [map, refData]);
  useEffect(() => {
    (map?.getSource('occ') as GeoJSONSource | undefined)?.setData(occupied ?? { type: 'FeatureCollection', features: [] });
  }, [map, occupied]);
  const wrap = useRef<HTMLDivElement>(null);
  const pickedSite = !pick && info ? registered.all.find((x) => x.siteId === info) : undefined;
  // the selected (or chosen) site stays in view: near or beyond an edge, the map glides to it, keeping the zoom
  useEffect(() => {
    if (!map || !highlighted) return;
    const f = refData.features.find((x) => x.properties.siteId === highlighted && x.geometry.type === 'Point');
    if (!f) return;
    const ll = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    const p = map.project(ll);
    const c = map.getCanvas();
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (p.x < w * 0.15 || p.x > w * 0.85 || p.y < h * 0.15 || p.y > h * 0.85) map.easeTo({ center: ll, duration: 500 });
  }, [map, highlighted]); // eslint-disable-line react-hooks/exhaustive-deps
  // fly to a site asked for (a search result); frame every site when the request has nothing to frame yet
  useEffect(() => {
    if (!map || !focus) return;
    const one = sitesExtent({ type: 'FeatureCollection', features: refData.features.filter((f) => f.properties.siteId === focus.siteId) });
    if (one) map.fitBounds([[one[0], one[1]], [one[2], one[3]]], { padding: 140, maxZoom: 15, duration: 600 });
  }, [map, focus?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const sitesFramed = useRef(false);
  useEffect(() => {
    if (!map || !fitSites || sitesFramed.current || !registered.loaded) return;
    const e = sitesExtent(refData);
    if (e) {
      sitesFramed.current = true;
      // every site fully on the map with its name, clear of the legend (bottom left) and the scale (bottom right)
      map.fitBounds([[e[0], e[1]], [e[2], e[3]]], { padding: { top: 70, right: 80, bottom: 130, left: 90 }, maxZoom: 13, duration: 0 });
    }
  }, [map, fitSites, registered.loaded, refData]);
  // the editor draws the shape it is editing itself (hideSite, or the deployment area left out of the request)
  const data = useMemo(() => requestFeatures(request, checks, hideSite), [request, checks, hideSite]);
  const initial = useMemo(() => {
    const c = request.content.site?.geometry ? centre(request.content.site.geometry) : { lng: 55.3, lat: 25.2 };
    return [c.lng, c.lat] as [number, number];
  }, [request.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!map) return;
    (map.getSource('rs') as GeoJSONSource | undefined)?.setData(data);
    const pts = data.features.flatMap((f) =>
      f.properties.role === 'BAND'
        ? []
        : f.geometry.type === 'Polygon'
          ? (f.geometry.coordinates[0] as [number, number][])
          : f.geometry.type === 'MultiPolygon'
            ? f.geometry.coordinates.flatMap((part) => part[0] as [number, number][])
            : [],
    );
    // the camera follows a newly opened request once (and on «الحدود والمناطق»); editing never moves it under the hand
    const key = request.id + '#' + fitKey;
    if (fit && pts.length && fitted.current !== key) {
      fitted.current = key;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60, maxZoom: fitMaxZoom, duration: fitKey ? 400 : 0 });
    }
  }, [map, data, fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const bands = data.features.filter((f) => f.properties.role === 'BAND').length;
  return (
    <div ref={wrap} className="tz-map-layer" data-bands={bands} data-ref-sites={new Set(refData.features.map((f) => f.properties.siteId)).size}>
    <OfflineMapLibre
      basemapUrl={BASEMAP_URL}
      hillshade={HILLSHADE}
      mode={mode}
      center={initial}
      zoom={12}
      className="tz-request-map"
      onReady={(m) => {
        // read by the headless acceptance script to place a click on a registered site (project coordinates to pixels)
        if (wrap.current) (wrap.current as HTMLDivElement & { tmrkzMap?: MlMap }).tmrkzMap = m;
        addSiteLayers(m);
        bindSiteClicks(m, () => interactive.current, (id, here) => onSite.current(id, here));
        m.addImage('tz-hatch-primary', hatch(MAP_COLOURS.PRIMARY).image, hatch(MAP_COLOURS.PRIMARY).options);
        m.addImage('tz-hatch-occupied', hatch(MAP_COLOURS.OCCUPIED).image, hatch(MAP_COLOURS.OCCUPIED).options);
        // occupied ground (other units' sites) above the registered sites, below the request's own shapes
        m.addSource('occ', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        addOverlayLayer(m, { id: 'occ-fill', type: 'fill', source: 'occ', filter: ['==', ['get', 'role'], 'OCC_SITE'], paint: { 'fill-pattern': 'tz-hatch-occupied' } });
        addOverlayLayer(m, { id: 'occ-line', type: 'line', source: 'occ', filter: ['==', ['get', 'role'], 'OCC_SITE'], paint: { 'line-color': MAP_COLOURS.OCCUPIED, 'line-width': 2.2 } });
        addOverlayLayer(m, { id: 'occ-marker', type: 'circle', source: 'occ', filter: ['==', ['get', 'role'], 'OCC_MARKER'], paint: { 'circle-radius': 8, 'circle-color': MAP_COLOURS.OCCUPIED, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
        addOverlayLayer(m, {
          id: 'occ-label',
          type: 'symbol',
          source: 'occ',
          layout: { 'text-field': ['get', 'name'], 'text-font': [LABEL_FONT], 'text-size': 11.5, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 30 },
          paint: { 'text-color': '#8e1f17', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
        });
        m.addImage('tz-hatch-alternative', hatch(MAP_COLOURS.ALTERNATIVE).image, hatch(MAP_COLOURS.ALTERNATIVE).options);
        m.addImage('tz-arrow', arrow(MAP_COLOURS.MOVE).image, arrow(MAP_COLOURS.MOVE).options);
        m.addSource('rs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        const role = (r: string) => ['==', ['get', 'role'], r] as ['==', ['get', string], string];
        // deployment bands (leg 1 around the stationing site, leg 2 around the primary area)
        addOverlayLayer(m, { id: 'rs-band', type: 'fill', source: 'rs', filter: role('BAND'), paint: { 'fill-color': ['match', ['get', 'leg'], 'primary', MAP_COLOURS.BAND_PRIMARY, MAP_COLOURS.BAND_ALTERNATIVE], 'fill-opacity': 0.06 } });
        addOverlayLayer(m, {
          id: 'rs-band-line',
          type: 'line',
          source: 'rs',
          filter: role('BAND'),
          paint: { 'line-color': ['match', ['get', 'leg'], 'primary', MAP_COLOURS.BAND_PRIMARY, MAP_COLOURS.BAND_ALTERNATIVE], 'line-width': 1.6, 'line-dasharray': [4, 3] },
        });
        addOverlayLayer(m, {
          id: 'rs-fill',
          type: 'fill',
          source: 'rs',
          filter: ['in', ['get', 'role'], ['literal', ['CURRENT', 'SITE']]],
          paint: { 'fill-color': ['match', ['get', 'role'], 'CURRENT', '#4a86c8', MAP_COLOURS.SITE], 'fill-opacity': ['match', ['get', 'role'], 'CURRENT', 0.22, 0.16] },
        });
        addOverlayLayer(m, {
          id: 'rs-hatch',
          type: 'fill',
          source: 'rs',
          filter: ['in', ['get', 'role'], ['literal', ['PRIMARY', 'ALTERNATIVE']]],
          paint: { 'fill-pattern': ['match', ['get', 'role'], 'PRIMARY', 'tz-hatch-primary', 'tz-hatch-alternative'] },
        });
        addOverlayLayer(m, {
          id: 'rs-line',
          type: 'line',
          source: 'rs',
          filter: ['in', ['get', 'role'], ['literal', ['CURRENT', 'SITE', 'PRIMARY', 'ALTERNATIVE']]],
          paint: {
            'line-color': ['match', ['get', 'role'], 'CURRENT', MAP_COLOURS.CURRENT, 'SITE', MAP_COLOURS.SITE, 'PRIMARY', MAP_COLOURS.PRIMARY, MAP_COLOURS.ALTERNATIVE],
            'line-width': ['match', ['get', 'role'], 'SITE', 3, 2.4],
          },
        });
        // the re-stationing move: neutral, information only
        addOverlayLayer(m, { id: 'rs-move', type: 'line', source: 'rs', filter: role('MOVE'), layout: { 'line-cap': 'round' }, paint: { 'line-color': MAP_COLOURS.MOVE, 'line-width': 2.6, 'line-dasharray': [2, 1.6] } });
        // a deployment leg, centre to centre: dashed in its area's colour (the label carries distance, range, verdict)
        addOverlayLayer(m, { id: 'rs-leg', type: 'line', source: 'rs', filter: role('LEG'), layout: { 'line-cap': 'round' }, paint: { 'line-color': ['match', ['get', 'leg'], 'primary', MAP_COLOURS.PRIMARY, MAP_COLOURS.ALTERNATIVE], 'line-width': 2.4, 'line-dasharray': [2.2, 1.6] } });
        addOverlayLayer(
          m,
          {
            id: 'rs-move-head',
            type: 'symbol',
            source: 'rs',
            filter: role('MOVE_HEAD'),
            layout: { 'icon-image': 'tz-arrow', 'icon-rotate': ['get', 'rotate'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
          },
          'top',
        );
        addOverlayLayer(
          m,
          {
            id: 'rs-label',
            type: 'symbol',
            source: 'rs',
            // only the label points carry a label: one per site or area, a MultiPolygon included (requestFeatures)
            filter: ['has', 'label'],
            // labels never overlap (owner, 4 Nov 2026): each may move around its point; when none fits at this zoom the
            // least important waits for a closer zoom (proposed site first, then the areas, the current site, the bands)
            layout: {
              'text-field': ['get', 'label'],
              'text-font': [LABEL_FONT],
              'text-size': ['match', ['get', 'role'], 'BAND_LABEL', 11.5, 'MOVE_LABEL', 12, 13],
              // one line: a mixed Arabic/Latin name («موقع RS-2026-0012») must not wrap inside its number
              'text-max-width': 40,
              'text-allow-overlap': false,
              'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
              'text-radial-offset': 0.9,
              'text-justify': 'auto',
              'text-padding': 4,
              'symbol-sort-key': ['match', ['get', 'role'], 'SITE', 0, 'PRIMARY', 1, 'ALTERNATIVE', 2, 'CURRENT', 3, 'MOVE_LABEL', 4, 5],
            },
            paint: {
              'text-color': ['match', ['get', 'role'], 'CURRENT', '#2f6db0', 'SITE', '#05634f', 'PRIMARY', '#1d6a39', 'ALTERNATIVE', '#5b3896', 'LEG_LABEL', ['match', ['get', 'tone'], 'ok', '#1d6a39', 'warn', '#9a6212', 'bad', '#a3322a', '#1d2733'], '#1d2733'],
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.8,
            },
          },
          'top',
        );
        setMap(m);
        onMap?.(m);
      }}
    />
    {pickedSite && <SiteInfoCard site={pickedSite} current={registered.current} sites={registered.all} onSelect={setInfo} onClose={() => setInfo(null)} />}
    </div>
  );
}
