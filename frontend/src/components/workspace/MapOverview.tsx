import { useEffect, useMemo, useState } from 'react';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Site, StationingRecord } from '../../api/types';
import { BASEMAP_URL, HILLSHADE, OfflineMapLibre, addOverlayLayer } from '../map/maplibre';
import { LABEL_FONT, type BasemapMode } from '../map/maplibre/offlineStyle';
import { MAP_COLOURS } from './RequestMap';

/**
 * The home dashboard's small map (§21): the sites this person can see, those with a current stationing in the proposed
 * site colour, on the same offline map (local PMTiles, local font). Display only.
 */
export default function MapOverview({ sites, current, mode = 'street' }: { sites: Site[]; current: StationingRecord[]; mode?: BasemapMode }) {
  const [map, setMap] = useState<MlMap | null>(null);
  const data = useMemo<GeoJSON.FeatureCollection>(() => {
    const stationed = new Map(current.map((c) => [c.siteId, c]));
    return {
      type: 'FeatureCollection',
      features: sites
        .filter((s) => s.location && s.view !== 'CONTEXT')
        .map((s) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [s.location!.lng, s.location!.lat] },
          properties: { stationed: stationed.has(s.id), label: stationed.has(s.id) ? s.name : '' },
        })),
    };
  }, [sites, current]);
  useEffect(() => {
    if (!map) return;
    (map.getSource('ov') as GeoJSONSource | undefined)?.setData(data);
    const pts = data.features.map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]);
    if (pts.length > 1) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 40, maxZoom: 12, duration: 0 });
    }
  }, [map, data]);
  return (
    <OfflineMapLibre
      basemapUrl={BASEMAP_URL}
      hillshade={HILLSHADE}
      mode={mode}
      center={[54.4, 24.4]}
      zoom={7}
      className="tz-overview-map"
      onReady={(m) => {
        m.addSource('ov', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        addOverlayLayer(m, {
          id: 'ov-sites',
          type: 'circle',
          source: 'ov',
          paint: {
            'circle-radius': ['case', ['get', 'stationed'], 6, 4],
            'circle-color': ['case', ['get', 'stationed'], MAP_COLOURS.SITE, '#7d8b94'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
          },
        });
        addOverlayLayer(
          m,
          {
            id: 'ov-labels',
            type: 'symbol',
            source: 'ov',
            filter: ['get', 'stationed'],
            layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONT], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 30 },
            paint: { 'text-color': '#1d2733', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
          },
          'top',
        );
        setMap(m);
      }}
    />
  );
}
