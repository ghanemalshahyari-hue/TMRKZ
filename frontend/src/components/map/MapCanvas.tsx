import { useEffect, useRef, type ReactNode } from 'react';
import L from '../../lib/leaflet';
import { urls } from '../../api/client';
import type { MapFeature, MapPackage } from '../../api/types';
import { DEFAULT_LAYERS, featureStyle, MAP_COLORS, type LayerSettings, type MapMode } from '../../lib/mapState';

export type Viewport = { bbox: string; zoom: number; center: [number, number] };
export type FitTarget = { bounds: L.LatLngBoundsExpression; key: number; maxZoom?: number };

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Bounds of a feature: its registered boundary, else its marker. */
export function featureBounds(f: Pick<MapFeature, 'boundary' | 'lat' | 'lng'>): L.LatLngBounds | null {
  if (f.boundary) return L.geoJSON(f.boundary.geojson as never).getBounds();
  if (f.lat != null && f.lng != null) return L.latLngBounds([f.lat, f.lng], [f.lat, f.lng]);
  return null;
}

/**
 * Leaflet map of the administrative workspace. Draws only what the server returned: registered boundaries
 * (Polygon/MultiPolygon) and markers; a site without a boundary keeps a marker marked «حدود غير مسجلة». The view
 * changes only on the user's own pan/zoom or an explicit fit request, never because new data arrived.
 */
export function MapCanvas({
  features,
  stale = false,
  selectedSiteId,
  onSelect,
  mode,
  background,
  layers = DEFAULT_LAYERS,
  initialView,
  initialExtent,
  onViewport,
  fitTarget,
  onMap,
  hiddenSiteId,
  className = '',
  label = 'خريطة المرافق',
  children,
}: {
  features: MapFeature[];
  stale?: boolean;
  selectedSiteId: string | null;
  onSelect: (siteId: string) => void;
  mode: MapMode;
  background: MapPackage | null;
  layers?: LayerSettings;
  initialView?: { center: [number, number]; zoom: number } | null;
  initialExtent?: [number, number, number, number] | null;
  onViewport?: (v: Viewport) => void;
  fitTarget?: FitTarget | null;
  onMap?: (map: L.Map | null) => void;
  hiddenSiteId?: string | null;
  className?: string;
  label?: string;
  children?: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const siteLayer = useRef<L.LayerGroup | null>(null);
  const zoneLayer = useRef<L.LayerGroup | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const bgLayer = useRef<L.ImageOverlay | null>(null);
  const bgAttribution = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onViewportRef = useRef(onViewport);
  onViewportRef.current = onViewport;

  // create once; the first view is the saved one, else the extent of what the actor may see — never a fixed city
  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { zoomControl: false, attributionControl: true, minZoom: 2, maxZoom: 20, zoomSnap: 0.5, keyboard: true });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    for (const [name, z] of [['background', 150], ['sites', 410], ['zones', 420]] as const) {
      map.createPane(name);
      const pane = map.getPane(name);
      if (pane) pane.style.zIndex = String(z);
    }
    siteLayer.current = L.layerGroup().addTo(map);
    zoneLayer.current = L.layerGroup().addTo(map);
    markerLayer.current = L.layerGroup().addTo(map);
    if (initialView) map.setView(initialView.center, initialView.zoom);
    else if (initialExtent) map.fitBounds([[initialExtent[1], initialExtent[0]], [initialExtent[3], initialExtent[2]]], { padding: [40, 40], maxZoom: 16 });
    else map.setView([20, 30], 3);
    mapRef.current = map;
    onMap?.(map);
    let timer: number | undefined;
    const emit = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const b = map.getBounds();
        const c = map.getCenter();
        // current view for acceptance tests and diagnostics (no data, only the view)
        el.current?.setAttribute('data-view', map.getZoom() + ',' + c.lat.toFixed(6) + ',' + c.lng.toFixed(6));
        const clamp = (v: number, a: number, z: number) => Math.max(a, Math.min(z, v));
        onViewportRef.current?.({
          bbox: [clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -90, 90), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -90, 90)]
            .map((v) => v.toFixed(6))
            .join(','),
          zoom: map.getZoom(),
          center: [c.lat, c.lng],
        });
      }, 300);
    };
    map.on('moveend', emit);
    const ro = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    ro.observe(el.current);
    requestAnimationFrame(() => {
      map.invalidateSize({ pan: false });
      emit();
    });
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
      onMap?.(null);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // background: only an installed package; nothing is drawn in place of a missing one
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    bgLayer.current?.remove();
    bgLayer.current = null;
    if (bgAttribution.current) map.attributionControl.removeAttribution(bgAttribution.current);
    bgAttribution.current = null;
    if (!background) return;
    const b: L.LatLngBoundsExpression = [
      [background.coverage.minLat, background.coverage.minLng],
      [background.coverage.maxLat, background.coverage.maxLng],
    ];
    const overlay = L.imageOverlay(urls.mapContent(background), b, { pane: 'background', interactive: false, opacity: layers.backgroundOpacity, alt: background.name });
    overlay.addTo(map);
    bgLayer.current = overlay;
    bgAttribution.current = background.attributionHtml || background.source;
    map.attributionControl.addAttribution(bgAttribution.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [background?.id]);

  useEffect(() => {
    bgLayer.current?.setOpacity(layers.backgroundOpacity);
  }, [layers.backgroundOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getPane('sites')!.style.zIndex = layers.zonesOnTop ? '410' : '420';
    map.getPane('zones')!.style.zIndex = layers.zonesOnTop ? '420' : '410';
  }, [layers.zonesOnTop]);

  // explicit fit requests only (selection, «ملاءمة الاختيار»)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitTarget) return;
    const b = L.latLngBounds(fitTarget.bounds as L.LatLngBoundsLiteral);
    if (!b.isValid()) return;
    const single = b.getNorthEast().equals(b.getSouthWest());
    if (single) map.setView(b.getCenter(), Math.max(map.getZoom(), fitTarget.maxZoom ?? 16));
    else map.fitBounds(b, { padding: [50, 50], maxZoom: fitTarget.maxZoom ?? 18 });
  }, [fitTarget?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // layers from the server response
  useEffect(() => {
    const sites = siteLayer.current;
    const zones = zoneLayer.current;
    const markers = markerLayer.current;
    if (!sites || !zones || !markers) return;
    sites.clearLayers();
    zones.clearLayers();
    markers.clearLayers();
    for (const f of features) {
      if (f.siteId === hiddenSiteId) continue;
      const st = featureStyle(f, mode, stale);
      const color = layers.colours ? st.color : MAP_COLORS.neutral;
      const selected = f.siteId === selectedSiteId;
      const isZone = !!f.parentId;
      const setting = isZone ? layers.zones : layers.sites;
      const stateText = st.symbol + ' ' + st.label;
      if (f.boundary && setting.visible) {
        const shape = L.geoJSON(f.boundary.geojson as never, {
          pane: isZone ? 'zones' : 'sites',
          style: {
            color: selected ? '#0d5d4e' : color,
            weight: selected ? 3.5 : 2,
            fillColor: color,
            fillOpacity: setting.opacity,
            opacity: 0.95,
            dashArray: stale ? '4 4' : undefined,
          },
        } as L.GeoJSONOptions);
        shape.eachLayer((l) => {
          (l as L.Path).on('click', () => onSelectRef.current(f.siteId));
          (l as L.Path).bindTooltip(f.name + ' — ' + stateText + (isZone ? ' · منطقة فرعية' : ''), { sticky: true, direction: 'top' });
          const p = (l as L.Path).getElement?.();
          p?.setAttribute('data-site', f.siteId);
        });
        shape.addTo(isZone ? zones : sites);
        shape.eachLayer((l) => (l as L.Path).getElement?.()?.setAttribute('data-site', f.siteId));
      }
      if (!layers.markers && f.boundary) continue;
      let at: L.LatLng | null = f.lat != null && f.lng != null ? L.latLng(f.lat, f.lng) : null;
      // a site with a boundary but no stored marker gets its label at the drawn shape (display only, never stored)
      if (!at && f.boundary) at = L.geoJSON(f.boundary.geojson as never).getBounds().getCenter();
      if (!at) continue;
      const noBoundary = f.boundaryStatus === 'NOT_REGISTERED';
      const badge = layers.requests && f.requestsVisible && (f.pendingCount ?? 0) > 0 ? '<span class="pin-badge" title="طلبات قيد المراجعة">⏳' + f.pendingCount + '</span>' : '';
      const html =
        '<div class="pin-wrap ' + (selected ? 'selected ' : '') + (noBoundary ? 'no-boundary' : '') + '" style="--pin:' + color + '" data-site="' + escapeHtml(f.siteId) + '">' +
        '<span class="pin-head"><i>' + escapeHtml(st.symbol) + '</i></span>' + badge +
        (layers.labels ? '<span class="pin-label">' + escapeHtml(f.name) + (noBoundary ? ' · <em>حدود غير مسجلة</em>' : '') + '</span>' : '') +
        '</div>';
      L.marker(at, {
        title: f.name + ' — ' + stateText + (noBoundary ? ' — حدود الموقع غير مسجلة' : ''),
        alt: f.name,
        keyboard: true,
        zIndexOffset: selected ? 1000 : 0,
        icon: L.divIcon({ className: 'pin-icon', html, iconSize: [0, 0], iconAnchor: [0, 0] }),
      })
        .addTo(markers)
        .on('click', () => onSelectRef.current(f.siteId))
        .on('keypress', (e: L.LeafletKeyboardEvent) => e.originalEvent.key === 'Enter' && onSelectRef.current(f.siteId));
    }
  }, [features, mode, stale, selectedSiteId, layers, hiddenSiteId]);

  return (
    <section className={'card map-card ' + className}>
      <div ref={el} className="map" role="application" aria-label={label} />
      {children}
    </section>
  );
}
