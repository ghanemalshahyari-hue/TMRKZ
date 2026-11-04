import { useEffect, useRef, useState } from 'react';
import { Map as MlMap, type LayerSpecification, type LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './offlineMap.css';
import {
  MODE_NOTICE,
  OVERLAY_ANCHOR,
  ROUTE_SHIELD,
  buildOfflineStyle,
  routeShield,
  setBasemapMode,
  type BasemapMode,
  type HillshadeSource,
  type LabelLanguage,
} from './offlineStyle';
import { ensureOfflineMapSetup } from './setup';
import { drawGlyphsLeftToRight } from './glyphDirection';

/**
 * The offline MapLibre map prepared for the Stationing V3 page (not wired into any page yet). It owns the background
 * only: street or terrain mode, road and place labels, attribution and the source notice. The page adds its own
 * sources and layers through `onReady` with {@link addOverlayLayer}; a mode switch never removes them, never changes
 * feature state and never moves the camera.
 */
export function OfflineMapLibre({
  basemapUrl,
  fontUrl = '/fonts/NotoSansArabic.ttf',
  hillshade = null,
  mode,
  labels = 'ar',
  center,
  zoom,
  minZoom = 6,
  maxZoom = 18,
  maxBounds,
  preserveDrawingBuffer = false,
  onReady,
  className,
}: {
  basemapUrl: string;
  fontUrl?: string;
  hillshade?: HillshadeSource | null;
  mode: BasemapMode;
  labels?: LabelLanguage;
  center: [number, number];
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  maxBounds?: LngLatBoundsLike;
  /** Keeps the drawing buffer readable (pixel checks in tests); costs some speed. */
  preserveDrawingBuffer?: boolean;
  onReady?: (map: MlMap) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const initial = useRef({ mode, labels, center, zoom });

  useEffect(() => {
    if (!host.current) return;
    ensureOfflineMapSetup();
    const abs = (u: string) => new URL(u, document.baseURI).href;
    const map = new MlMap({
      container: host.current,
      style: buildOfflineStyle({
        basemapUrl: abs(basemapUrl),
        fontUrl: abs(fontUrl),
        hillshade: hillshade && { ...hillshade, url: abs(hillshade.url) },
        mode: initial.current.mode,
        labels: initial.current.labels,
      }),
      center: initial.current.center,
      zoom: initial.current.zoom,
      minZoom,
      maxZoom,
      maxBounds,
      attributionControl: { compact: false },
      canvasContextAttributes: { preserveDrawingBuffer },
    });
    drawGlyphsLeftToRight(map);
    mapRef.current = map;
    map.on('load', () => {
      const shield = routeShield();
      if (!map.hasImage(ROUTE_SHIELD)) map.addImage(ROUTE_SHIELD, shield.image, shield.options);
      setReady(true);
      onReady?.(map);
    });
    return () => {
      mapRef.current = null;
      setReady(false);
      map.remove();
    };
    // the style is built once; mode changes go through setBasemapMode below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemapUrl, fontUrl, hillshade?.url, hillshade?.kind]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && ready) setBasemapMode(map, mode);
  }, [mode, ready]);

  return (
    <div className={'ml-offline' + (className ? ' ' + className : '')} data-mode={mode}>
      <div ref={host} className="ml-offline-canvas" />
      <div className="ml-offline-notice" role="note" data-testid="map-source-notice">
        {mode === 'terrain' && !hillshade ? 'طبقة طبيعة الأرض غير مثبتة في هذه الحزمة' : MODE_NOTICE[mode]}
      </div>
    </div>
  );
}

/** Adds a page layer above the background and below the labels, or on top of everything. */
export function addOverlayLayer(map: MlMap, layer: LayerSpecification, position: 'below-labels' | 'top' = 'below-labels'): void {
  map.addLayer(layer, position === 'top' ? undefined : OVERLAY_ANCHOR);
}
