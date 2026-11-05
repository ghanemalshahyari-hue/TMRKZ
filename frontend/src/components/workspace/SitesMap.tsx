import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import type { StationingRecord } from '../../api/types';
import { BASEMAP_URL, HILLSHADE, OfflineMapLibre } from '../map/maplibre';
import type { BasemapMode } from '../map/maplibre/offlineStyle';
import { siteReferenceFeatures, sitesExtent, unitsPerSite, type RefSite } from '../../lib/sitesLayer';
import { SiteInfoCard } from './SiteInfoCard';
import { addSiteLayers, bindSiteClicks, setSiteData } from './siteLayers';

/**
 * The registered sites on the offline map (local PMTiles and font): boundaries where registered, markers otherwise,
 * named once. Two uses: the Sites page selects a site (`onSelect`, the details show beside the map), and the
 * re-stationing start view shows an information card on a click. Framed on every site at first; a selected site is
 * brought into view.
 */
export function SitesMap({ sites, current, mode, selectedId, onSelect }: {
  sites: RefSite[];
  current: StationingRecord[];
  mode: BasemapMode;
  selectedId?: string | null;
  /** When given the page owns the selection; otherwise a click opens the information card. */
  onSelect?: (siteId: string | null) => void;
}) {
  const [map, setMap] = useState<MlMap | null>(null);
  const [own, setOwn] = useState<string | null>(null);
  const selected = onSelect ? (selectedId ?? null) : own;
  const counts = useMemo(() => unitsPerSite(current), [current]);
  const data = useMemo(() => siteReferenceFeatures(sites, selected, counts), [sites, selected, counts]);
  const pick = useRef<(id: string | null) => void>(() => undefined);
  pick.current = onSelect ?? setOwn;
  const framed = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!map) return;
    setSiteData(map, data);
    const e = sitesExtent(data);
    if (e && !framed.current) {
      framed.current = true;
      map.fitBounds([[e[0], e[1]], [e[2], e[3]]], { padding: 50, maxZoom: 13, duration: 0 });
    }
  }, [map, data]);
  // a site chosen elsewhere (the list, an address) is brought into view
  useEffect(() => {
    if (!map || !onSelect || !selectedId) return;
    const one = sitesExtent({ type: 'FeatureCollection', features: data.features.filter((f) => f.properties.siteId === selectedId) });
    if (one) map.fitBounds([[one[0], one[1]], [one[2], one[3]]], { padding: 120, maxZoom: 15, duration: 500 });
  }, [map, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const card = !onSelect && own ? sites.find((s) => s.siteId === own) : undefined;
  return (
    <div ref={wrap} className="tz-map-layer" data-sites={new Set(data.features.map((f) => f.properties.siteId)).size}>
      <OfflineMapLibre
        basemapUrl={BASEMAP_URL}
        hillshade={HILLSHADE}
        mode={mode}
        center={[54.4, 24.4]}
        zoom={7}
        className="tz-sites-map"
        onReady={(m) => {
          // read by the headless acceptance script to place a click on a site (project coordinates to pixels)
          if (wrap.current) (wrap.current as HTMLDivElement & { tmrkzMap?: MlMap }).tmrkzMap = m;
          addSiteLayers(m);
          bindSiteClicks(m, () => true, (id) => pick.current(id));
          setMap(m);
        }}
      />
      {card && <SiteInfoCard site={card} current={current} onClose={() => setOwn(null)} />}
    </div>
  );
}
