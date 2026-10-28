import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { api, urls } from '../api/client';
import type { MapFeature, MapPackage } from '../api/types';
import { ADMINISTRATIVE, AVAILABILITY, COLORS } from '../lib/labels';
import { Icon } from './ui';

export type MapMode = 'availability' | 'administrative';

const FALLBACK_BOUNDS: L.LatLngBoundsExpression = [
  [25.07, 55.19],
  [25.33, 55.46],
];
const DEFAULT_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

let packagesPromise: Promise<MapPackage[]> | null = null;
function loadPackages(): Promise<MapPackage[]> {
  if (!packagesPromise) packagesPromise = api.mapPackages().catch(() => []);
  return packagesPromise;
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function featureColor(f: MapFeature, mode: MapMode): { color: string; label: string } {
  return mode === 'availability' ? AVAILABILITY[f.availability] : ADMINISTRATIVE[f.administrative];
}

function Legend({ mode }: { mode: MapMode }) {
  const items =
    mode === 'availability'
      ? [
          [COLORS.free, 'متاح'],
          [COLORS.pending, 'طلب معلّق'],
          [COLORS.busy, 'محجوز'],
        ]
      : [
          [COLORS.free, 'حجز معتمد'],
          [COLORS.pending, 'طلب معلّق'],
          [COLORS.none, 'دون طلب'],
        ];
  return (
    <div className="map-legend">
      {items.map(([c, l]) => (
        <span key={l}>
          <i className="dot" style={{ color: c }} />
          {l}
        </span>
      ))}
    </div>
  );
}

/** Leaflet map with the prototype's toolbar, legend, caption, pins and polygons. */
export function MapView({
  features,
  selectedSiteId,
  onSelect,
  mode,
  onModeChange,
  className = '',
  coverageMessage,
}: {
  features: MapFeature[];
  selectedSiteId: string | null;
  onSelect: (siteId: string) => void;
  mode: MapMode;
  onModeChange: (m: MapMode) => void;
  className?: string;
  coverageMessage?: string | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const bounds = useRef<L.LayerGroup | null>(null);
  const [labels, setLabels] = useState(true);
  const [caption, setCaption] = useState('جارٍ تحميل الخلفية المحلية…');
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const featuresRef = useRef(features);
  featuresRef.current = features;

  const fit = () => {
    const map = mapRef.current;
    const list = featuresRef.current;
    if (map && list.length)
      map.fitBounds(
        list.map((s) => [s.lat, s.lng] as L.LatLngTuple),
        { paddingTopLeft: [45, 85], paddingBottomRight: [45, 85], maxZoom: list.length === 1 ? 13.5 : 13, animate: false },
      );
  };

  // create once
  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { zoomControl: false, attributionControl: true, minZoom: 10.5, maxZoom: 17, zoomSnap: 0.5 }).setView([25.207, 55.31], 12);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    map.createPane('baseImage');
    const pane = map.getPane('baseImage');
    if (pane) pane.style.zIndex = '150';
    markers.current = L.layerGroup().addTo(map);
    bounds.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    let cancelled = false;
    loadPackages().then((pkgs) => {
      if (cancelled) return;
      const pkg = pkgs.find((p) => p.format === 'SVG_OVERLAY');
      const url = pkg ? urls.mapContent(pkg) : '/map/basemap.svg';
      const b: L.LatLngBoundsExpression = pkg
        ? [
            [pkg.coverage.minLat, pkg.coverage.minLng],
            [pkg.coverage.maxLat, pkg.coverage.maxLng],
          ]
        : FALLBACK_BOUNDS;
      const overlay = L.imageOverlay(url, b, { pane: 'baseImage', interactive: false });
      overlay.once('load', () => {
        if (cancelled) return;
        map.attributionControl.addAttribution(pkg?.attributionHtml || DEFAULT_ATTRIBUTION);
        setCaption(
          pkg
            ? 'خلفية محلية: ' + pkg.name + ' · إصدار ' + pkg.version + ' · المرافق والحدود افتراضية'
            : 'خريطة جغرافية محلية · المرافق والحدود افتراضية',
        );
      });
      overlay.once('error', () => !cancelled && setCaption('تعذر تحميل الخلفية المحلية · علامات المرافق متاحة'));
      overlay.addTo(map);
    });
    requestAnimationFrame(() => {
      map.invalidateSize({ pan: false });
      fit();
    });
    return () => {
      cancelled = true;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // redraw markers & polygons (prototype drawMap)
  useEffect(() => {
    const m = markers.current;
    const b = bounds.current;
    if (!m || !b) return;
    m.clearLayers();
    b.clearLayers();
    features.forEach((s) => {
      const a = featureColor(s, mode);
      const selected = s.siteId === selectedSiteId;
      L.polygon(
        [
          [s.lat - 0.001, s.lng - 0.0013],
          [s.lat - 0.0008, s.lng + 0.0016],
          [s.lat + 0.0011, s.lng + 0.001],
          [s.lat + 0.001, s.lng - 0.0013],
        ],
        { color: a.color, weight: selected ? 2 : 1, fillColor: a.color, fillOpacity: 0.16 },
      )
        .addTo(b)
        .on('click', () => onSelectRef.current(s.siteId));
      const html =
        '<div class="pin-wrap ' +
        (selected ? 'selected' : '') +
        '" style="--pin:' +
        a.color +
        '"><span class="pin-head"><i>' +
        escapeHtml(s.code) +
        '</i></span>' +
        (labels ? '<span class="pin-label">' + escapeHtml(s.name) + '</span>' : '') +
        '</div>';
      L.marker([s.lat, s.lng], {
        title: s.name + ' — ' + a.label,
        zIndexOffset: selected ? 1000 : 0,
        icon: L.divIcon({ className: 'pin-icon', html, iconSize: [0, 0], iconAnchor: [0, 0] }),
      })
        .addTo(m)
        .on('click', () => onSelectRef.current(s.siteId));
    });
  }, [features, mode, selectedSiteId, labels]);

  // refit when the set of visible sites changes
  const featureKey = features.map((f) => f.siteId).join(',');
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureKey]);

  return (
    <section className={'card map-card ' + className}>
      <div ref={el} className="map" aria-label="خريطة المرافق" />
      <div className="map-toolbar">
        <div className="map-mode">
          <button className={mode === 'availability' ? 'active' : ''} onClick={() => onModeChange('availability')}>
            إتاحة المرافق
          </button>
          <button className={mode === 'administrative' ? 'active' : ''} onClick={() => onModeChange('administrative')}>
            حالة الطلبات
          </button>
        </div>
        <div className="map-tools">
          <button className="icon-button" onClick={() => mapRef.current?.zoomIn()} aria-label="تكبير الخريطة">
            ＋
          </button>
          <button className="icon-button" onClick={() => mapRef.current?.zoomOut()} aria-label="تصغير الخريطة">
            −
          </button>
          <button className="icon-button" onClick={fit} aria-label="عرض المرافق">
            <Icon name="pin" />
          </button>
          <button className="icon-button" onClick={() => setLabels((v) => !v)} aria-label="إظهار أسماء المرافق">
            <Icon name="layers" />
          </button>
        </div>
      </div>
      <Legend mode={mode} />
      <div className="map-caption">{coverageMessage || caption}</div>
    </section>
  );
}
