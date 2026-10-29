import { useEffect, useState } from 'react';
import type L from 'leaflet';
import { api } from '../../api/client';
import type { MapFeature, MapPackage } from '../../api/types';
import type { MapMode } from '../../lib/mapState';
import { MapCanvas, featureBounds, type FitTarget } from './MapCanvas';
import { Legend } from './MapPanels';

/**
 * A map of a fixed set of sites (a request's sites, a calendar day). It frames that set when the set changes, uses the
 * first installed road background, and draws registered boundaries only.
 */
export function StaticMap({
  features,
  selectedSiteId,
  onSelect,
  className,
  modeToggle = true,
  caption,
  label,
}: {
  features: MapFeature[];
  selectedSiteId: string | null;
  onSelect: (id: string) => void;
  className?: string;
  modeToggle?: boolean;
  caption?: string;
  label?: string;
}) {
  const [mode, setMode] = useState<MapMode>('availability');
  const [background, setBackground] = useState<MapPackage | null>(null);
  const [fit, setFit] = useState<FitTarget | null>(null);
  useEffect(() => {
    let live = true;
    api
      .mapContext()
      .then((c) => live && setBackground(c.backgrounds.find((b) => b.kind === 'ROADS') ?? c.backgrounds[0] ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const key = features.map((f) => f.siteId + ':' + (f.boundary?.version ?? '')).join(',');
  useEffect(() => {
    const all = features.map((f) => featureBounds(f)).filter(Boolean) as L.LatLngBounds[];
    if (!all.length) return;
    const b = all.reduce((acc, x) => acc.extend(x), all[0].pad(0));
    setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <MapCanvas className={className} features={features} selectedSiteId={selectedSiteId} onSelect={onSelect} mode={mode} background={background} fitTarget={fit} label={label}>
      {modeToggle && (
        <div className="map-toolbar">
          <div className="map-mode" role="radiogroup" aria-label="وضع الألوان">
            <button role="radio" aria-checked={mode === 'availability'} className={mode === 'availability' ? 'active' : ''} onClick={() => setMode('availability')}>
              الإتاحة
            </button>
            <button role="radio" aria-checked={mode === 'requests'} className={mode === 'requests' ? 'active' : ''} onClick={() => setMode('requests')}>
              حالة الطلبات
            </button>
          </div>
        </div>
      )}
      <Legend mode={mode} stale={false} />
      {caption && <div className="map-caption">{caption}</div>}
    </MapCanvas>
  );
}
