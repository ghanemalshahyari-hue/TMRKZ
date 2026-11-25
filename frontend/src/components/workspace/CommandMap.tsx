import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { Popup } from 'maplibre-gl';
import type { Site, StationingRecord } from '../../api/types';
import { BASEMAP_URL, HILLSHADE, OfflineMapLibre, addOverlayLayer } from '../map/maplibre';
import { LABEL_FONT, type BasemapMode } from '../map/maplibre/offlineStyle';
import { MAP_COLOURS } from './RequestMap';

export type Selection =
  | { kind: 'none' }
  | { kind: 'site'; siteId: string }
  | { kind: 'cluster'; clusterId: number; lat: number; lng: number; count: number };

export type CommandMapProps = {
  sites: Site[];
  current: StationingRecord[];
  /** Site IDs the person wants the map filtered to (an attention row's pick); empty = all visible. */
  highlight?: readonly string[];
  /** Site IDs that need action (overdue tickets, pending end): shown in amber. */
  warning?: readonly string[];
  /** Site IDs that have a request in review: drawn with a dotted ring on top of the marker (owner, 21 Nov 2026). */
  inReview?: readonly string[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  mode?: BasemapMode;
  onMap?: (m: MlMap | null) => void;
};

const ATTENTION = '#d97706';
const CLUSTER_FILL = '#4b6b47';
const CLUSTER_RING = '#f3ead1';
const CLUSTER_RING_WARN = '#d97706';
const CLUSTER_MAX_ZOOM = 12;
const REVIEW_RING = '#d97706';

/** A dashed ring used to mark a site with an in-review request (owner, 21 Nov 2026 — «الطلبات تحت الاعتماد كخطوط منقّطة»). */
function dottedRing(colour: string, size = 44, dashes = 14): { image: { width: number; height: number; data: Uint8Array }; options: { pixelRatio: number } } {
  const n = size;
  const data = new Uint8Array(n * n * 4);
  const r = n / 2 - 3;
  const halfW = 1.8;
  const parsed = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - n / 2;
      const dy = y - n / 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= r - halfW && d <= r + halfW) {
        const angle = Math.atan2(dy, dx) + Math.PI;
        const idx = Math.floor((angle / (2 * Math.PI)) * dashes);
        if (idx % 2 === 0) {
          const i = (y * n + x) * 4;
          data[i] = parsed[0];
          data[i + 1] = parsed[1];
          data[i + 2] = parsed[2];
          data[i + 3] = 230;
        }
      }
    }
  }
  return { image: { width: n, height: n, data }, options: { pixelRatio: 2 } };
}

/**
 * The home dashboard's command map (owner brief, 20 Nov 2026 §7–§15, §23–§26): MapLibre's own clustering, zoom-aware
 * labels, and a lightweight tooltip. Selection is held outside so the right panel and the attention panel react. Click
 * a cluster — right panel summarises it; click «تكبير وعرض المواقع» — the cluster expands with the owner's own
 * `fitBounds`. Click a site — right panel shows the site; no forced zoom. Nothing navigates on hover.
 */
export default function CommandMap({ sites, current, highlight, warning, inReview, selection, onSelect, mode = 'street', onMap }: CommandMapProps) {
  const [map, setMap] = useState<MlMap | null>(null);
  const highlightSet = useMemo(() => new Set(highlight ?? []), [highlight]);
  const warnSet = useMemo(() => new Set(warning ?? []), [warning]);
  const reviewSet = useMemo(() => new Set(inReview ?? []), [inReview]);
  const tooltip = useRef<Popup | null>(null);

  const data = useMemo<GeoJSON.FeatureCollection>(() => {
    const stationed = new Map(current.map((c) => [c.siteId, c]));
    const show = highlightSet.size === 0 ? sites : sites.filter((s) => highlightSet.has(s.id));
    return {
      type: 'FeatureCollection',
      features: show
        .filter((s) => s.location && s.view !== 'CONTEXT' && s.status !== 'RETIRED')
        .map((s) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [s.location!.lng, s.location!.lat] },
          properties: {
            id: s.id,
            name: s.name,
            stationed: stationed.has(s.id) ? 1 : 0,
            warning: warnSet.has(s.id) ? 1 : 0,
            review: reviewSet.has(s.id) ? 1 : 0,
            priority: warnSet.has(s.id) ? 2 : stationed.has(s.id) ? 1 : 0,
          },
        })),
    };
  }, [sites, current, highlightSet, warnSet, reviewSet]);

  // Keep the source and layers in sync whenever the data changes (filter, warning, or stationing updates).
  useEffect(() => {
    if (!map) return;
    const src = map.getSource('cmd') as GeoJSONSource | undefined;
    if (src) src.setData(data);
  }, [map, data]);

  // Fit to the highlighted points ONLY when the person explicitly asked for a filter (an attention row or a cluster expand).
  // Selecting a site, or opening the map for the first time, never moves the camera (owner, 20 Nov 2026: a click on the map must zoom IN, not OUT).
  useEffect(() => {
    if (!map) return;
    if (!highlight || highlight.length === 0) return; // no filter: do not touch the camera
    const pts = data.features.map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]);
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.easeTo({ center: pts[0], zoom: Math.max(map.getZoom(), 12), duration: 500 });
      return;
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 48, maxZoom: 14, duration: 500 });
  }, [map, data, highlight]);

  // Reflect the current selection on the layers (the one «selected-label» layer).
  useEffect(() => {
    if (!map) return;
    const selId = selection.kind === 'site' ? selection.siteId : '';
    if (map.getLayer('cmd-selected')) map.setFilter('cmd-selected', ['==', ['get', 'id'], selId]);
    if (map.getLayer('cmd-selected-label')) map.setFilter('cmd-selected-label', ['==', ['get', 'id'], selId]);
  }, [map, selection]);

  useEffect(() => {
    if (!map) return undefined;
    // the one site a click lands on: let the hit decide (a cluster wins over an ordinary point, as it covers it)
    const onClick = async (e: MapMouseEvent) => {
      const clusterHit = map.queryRenderedFeatures(e.point, { layers: ['cmd-cluster'] })[0];
      if (clusterHit) {
        const id = clusterHit.properties?.cluster_id as number;
        const c = (clusterHit.geometry as GeoJSON.Point).coordinates;
        const count = (clusterHit.properties?.point_count as number) ?? 0;
        onSelect({ kind: 'cluster', clusterId: id, lat: c[1], lng: c[0], count });
        return;
      }
      const pointHit = map.queryRenderedFeatures(e.point, { layers: ['cmd-sites', 'cmd-sites-warn'] })[0];
      if (pointHit && pointHit.properties) {
        onSelect({ kind: 'site', siteId: String(pointHit.properties.id) });
        // the owner: selecting a site zooms IN toward it, never out. A gentle ease, never a camera jump.
        const c = (pointHit.geometry as GeoJSON.Point).coordinates as [number, number];
        map.easeTo({ center: c, zoom: Math.max(map.getZoom(), 11), duration: 500 });
      }
    };
    const onMove = (e: MapMouseEvent) => {
      const hit = map.queryRenderedFeatures(e.point, { layers: ['cmd-sites', 'cmd-sites-warn'] })[0];
      map.getCanvas().style.cursor = hit ? 'pointer' : '';
      if (hit && hit.properties) {
        const c = (hit.geometry as GeoJSON.Point).coordinates as [number, number];
        if (!tooltip.current) tooltip.current = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'tz-map-tt' });
        tooltip.current
          .setLngLat(c)
          .setHTML(
            `<b>${escapeHtml(String(hit.properties.name ?? ''))}</b>` +
              (hit.properties.stationed ? '<br><small>متمركز حالياً</small>' : '') +
              (hit.properties.warning ? '<br><small style="color:#d97706">يحتاج انتباه</small>' : ''),
          )
          .addTo(map);
      } else tooltip.current?.remove();
    };
    const onLeave = () => { tooltip.current?.remove(); map.getCanvas().style.cursor = ''; };
    map.on('click', onClick);
    map.on('mousemove', onMove);
    const canvas = map.getCanvasContainer();
    canvas.addEventListener('mouseleave', onLeave);
    return () => { map.off('click', onClick); map.off('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); };
  }, [map, onSelect]);

  return (
    <OfflineMapLibre
      basemapUrl={BASEMAP_URL}
      hillshade={HILLSHADE}
      mode={mode}
      center={[54.4, 24.4]}
      zoom={7}
      fullView
      className="tz-overview-map"
      onReady={(m) => {
        m.addSource('cmd', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: CLUSTER_MAX_ZOOM,
          clusterProperties: { warnings: ['+', ['get', 'warning']] },
        });
        // Clusters — one circle whose ring turns amber when any site inside needs attention.
        addOverlayLayer(m, {
          id: 'cmd-cluster',
          type: 'circle',
          source: 'cmd',
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 20, 10, 24, 50, 30, 200, 36],
            'circle-color': CLUSTER_FILL,
            'circle-opacity': 0.92,
            'circle-stroke-width': 3,
            'circle-stroke-color': ['case', ['>', ['coalesce', ['get', 'warnings'], 0], 0], CLUSTER_RING_WARN, CLUSTER_RING],
          },
        });
        addOverlayLayer(m, {
          id: 'cmd-cluster-count',
          type: 'symbol',
          source: 'cmd',
          filter: ['has', 'point_count'],
          layout: { 'text-field': '{point_count_abbreviated}', 'text-font': [LABEL_FONT], 'text-size': 13, 'text-allow-overlap': true },
          paint: { 'text-color': '#ffffff' },
        }, 'top');
        // Unclustered points — split in two so the warning colour wins over the ordinary site colour.
        addOverlayLayer(m, {
          id: 'cmd-sites',
          type: 'circle',
          source: 'cmd',
          filter: ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'warning'], 1]],
          paint: {
            'circle-radius': ['case', ['==', ['get', 'stationed'], 1], 7, 5],
            'circle-color': ['case', ['==', ['get', 'stationed'], 1], MAP_COLOURS.SITE, '#7d8b94'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
          },
        });
        addOverlayLayer(m, {
          id: 'cmd-sites-warn',
          type: 'circle',
          source: 'cmd',
          filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'warning'], 1]],
          paint: {
            'circle-radius': 8,
            'circle-color': ATTENTION,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
        // Owner, 21 Nov 2026: a dotted ring around every site with a request under review, so «طلبات قيد الاعتماد» reads
        // at a glance on the map. The underlying marker stays visible; the ring is drawn as an icon (MapLibre circles
        // have no stroke-dasharray). Clustering hides the ring until the cluster is expanded, which is the correct behaviour.
        if (!m.hasImage('cmd-review-ring')) {
          const ring = dottedRing(REVIEW_RING);
          m.addImage('cmd-review-ring', ring.image, ring.options);
        }
        addOverlayLayer(m, {
          id: 'cmd-review-ring',
          type: 'symbol',
          source: 'cmd',
          filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'review'], 1]],
          layout: {
            'icon-image': 'cmd-review-ring',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-anchor': 'center',
          },
        }, 'top');
        // Priority labels: a warning or a stationed site, visible only from a middle zoom level and never overlapping.
        addOverlayLayer(m, {
          id: 'cmd-labels',
          type: 'symbol',
          source: 'cmd',
          minzoom: 8,
          filter: ['all', ['!', ['has', 'point_count']], ['>=', ['get', 'priority'], 1]],
          layout: {
            'text-field': ['get', 'name'],
            'text-font': [LABEL_FONT],
            'text-size': 11,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
            'text-max-width': 30,
            'text-padding': 4,
            'text-optional': true,
          },
          paint: { 'text-color': '#1d2733', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
        }, 'top');
        // Selected site — the marker is highlighted and the label is always visible, whatever the zoom level.
        addOverlayLayer(m, {
          id: 'cmd-selected',
          type: 'circle',
          source: 'cmd',
          filter: ['==', ['get', 'id'], ''],
          paint: {
            'circle-radius': 10,
            'circle-color': '#8b5a2b',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3,
          },
        }, 'top');
        addOverlayLayer(m, {
          id: 'cmd-selected-label',
          type: 'symbol',
          source: 'cmd',
          filter: ['==', ['get', 'id'], ''],
          layout: {
            'text-field': ['get', 'name'],
            'text-font': [LABEL_FONT],
            'text-size': 12.5,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': '#5e3a18', 'text-halo-color': '#fffcf6', 'text-halo-width': 2 },
        }, 'top');
        setMap(m);
        onMap?.(m);
      }}
    />
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** For a parent to issue a cluster expansion: the caller holds the ref via a MutableRef. */
