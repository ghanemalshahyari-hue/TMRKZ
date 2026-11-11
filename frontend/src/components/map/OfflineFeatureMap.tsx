import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { MapFeature } from '../../api/types';
import { featureStyle, type MapMode } from '../../lib/mapState';
import { BASEMAP_URL, HILLSHADE, OfflineMapLibre, addOverlayLayer } from './maplibre';
import './offlineFeatureMap.css';

/**
 * A fixed set of sites (a calendar day, a request under review) on the installed offline map (local PMTiles, local font;
 * ADR-036), coloured as the Leaflet map colours them (availability or request state), the selected one outlined, a click
 * choosing a site. It replaces the Leaflet canvas wherever that canvas would need an uploaded raster background that the
 * installation does not have (owner, 11 Nov 2026: the map of «الإشغال عبر الزمن» stayed empty).
 */
export function OfflineFeatureMap({
  features,
  selectedSiteId,
  onSelect,
  mode,
  className,
  label,
  children,
}: {
  features: MapFeature[];
  selectedSiteId: string | null;
  onSelect: (id: string) => void;
  mode: MapMode;
  className?: string;
  label?: string;
  children?: ReactNode;
}) {
  const [map, setMap] = useState<MlMap | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const data = useMemo<GeoJSON.FeatureCollection>(() => {
    const out: GeoJSON.Feature[] = [];
    for (const f of features) {
      const st = featureStyle(f, mode, false);
      const props = { siteId: f.siteId, name: f.name, color: st.color, selected: f.siteId === selectedSiteId };
      if (f.boundary) out.push({ type: 'Feature', geometry: f.boundary.geojson as unknown as GeoJSON.Geometry, properties: props });
      else if (f.lat != null && f.lng != null) out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: props });
    }
    return { type: 'FeatureCollection', features: out };
  }, [features, mode, selectedSiteId]);
  const frameKey = features.map((f) => f.siteId + ':' + (f.boundary?.version ?? '')).join(',');

  useEffect(() => {
    (map?.getSource('fm') as GeoJSONSource | undefined)?.setData(data);
  }, [map, data]);
  useEffect(() => {
    if (!map) return;
    const xs: number[] = [];
    const ys: number[] = [];
    const walk = (c: unknown): void => {
      if (Array.isArray(c) && typeof c[0] === 'number') {
        xs.push(c[0] as number);
        ys.push(c[1] as number);
      } else if (Array.isArray(c)) c.forEach(walk);
    };
    data.features.forEach((f) => walk((f.geometry as { coordinates: unknown }).coordinates));
    if (!xs.length) return;
    const pad = 0.004;
    map.fitBounds([[Math.min(...xs) - pad, Math.min(...ys) - pad], [Math.max(...xs) + pad, Math.max(...ys) + pad]], { padding: 40, maxZoom: 16, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, frameKey]);

  return (
    <div className={'offline-feature-map ' + (className ?? '')} role="region" aria-label={label ?? 'الخريطة'}>
      <OfflineMapLibre
        basemapUrl={BASEMAP_URL}
        hillshade={HILLSHADE}
        mode="street"
        center={[54.4, 24.4]}
        zoom={7}
        className="ofm-gl"
        onReady={(m) => {
          m.addSource('fm', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          addOverlayLayer(m, { id: 'fm-fill', type: 'fill', source: 'fm', filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.32 } });
          addOverlayLayer(m, {
            id: 'fm-line',
            type: 'line',
            source: 'fm',
            filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
            paint: { 'line-color': ['case', ['get', 'selected'], '#0d5d4e', ['get', 'color']], 'line-width': ['case', ['get', 'selected'], 3.5, 2] },
          });
          addOverlayLayer(m, {
            id: 'fm-point',
            type: 'circle',
            source: 'fm',
            filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
            paint: { 'circle-radius': ['case', ['get', 'selected'], 8, 6], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
          });
          for (const id of ['fm-fill', 'fm-point']) {
            m.on('click', id, (e) => {
              const siteId = e.features?.[0]?.properties?.siteId;
              if (siteId) select.current(String(siteId));
            });
            m.on('mouseenter', id, () => (m.getCanvas().style.cursor = 'pointer'));
            m.on('mouseleave', id, () => (m.getCanvas().style.cursor = ''));
          }
          setMap(m);
        }}
      />
      {children}
    </div>
  );
}
