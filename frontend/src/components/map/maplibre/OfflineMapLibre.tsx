import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  type Terrain3dSource,
} from './offlineStyle';
import { ensureOfflineMapSetup } from './setup';
import { MAP_FONT_URL } from './mapPackage';
import { drawGlyphsLeftToRight } from './glyphDirection';

/**
 * Owner, 21 Nov 2026: the map follows the app theme by default; the viewer may override and force it to stay light with
 * «خريطة فاتحة» on the map toolbar. The override is stored per-browser (no server round-trip) and survives reloads. The
 * value is either 'light' (force light) or null (follow the app theme).
 */
const MAP_THEME_KEY = 'tmrkz-map-theme';
type MapThemeOverride = 'light' | null;
const mapThemeListeners = new Set<() => void>();
export function readMapThemeOverride(): MapThemeOverride {
  try {
    return localStorage.getItem(MAP_THEME_KEY) === 'light' ? 'light' : null;
  } catch {
    return null;
  }
}
export function setMapThemeOverride(v: MapThemeOverride): void {
  try {
    if (v === 'light') localStorage.setItem(MAP_THEME_KEY, 'light');
    else localStorage.removeItem(MAP_THEME_KEY);
  } catch { /* storage refused */ }
  mapThemeListeners.forEach((l) => l());
}
export function useMapThemeOverride(): MapThemeOverride {
  return useSyncExternalStore(
    (l) => (mapThemeListeners.add(l), () => mapThemeListeners.delete(l)),
    () => readMapThemeOverride(),
    () => null,
  );
}

/**
 * The offline MapLibre map prepared for the Stationing V3 page (not wired into any page yet). It owns the background
 * only: street or terrain mode, road and place labels, attribution and the source notice. The page adds its own
 * sources and layers through `onReady` with {@link addOverlayLayer}; a mode switch never removes them, never changes
 * feature state and never moves the camera.
 */
export function OfflineMapLibre({
  basemapUrl,
  fontUrl = MAP_FONT_URL,
  hillshade = null,
  terrain3d = null,
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
  /** The 3D view's elevation tiles, when the installed package carries them (the 3D view is turned on by the page). */
  terrain3d?: Terrain3dSource | null;
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
  const mapThemeOverride = useMapThemeOverride();
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
        terrain3d: terrain3d && { ...terrain3d, url: abs(terrain3d.url) },
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
    // the canvas follows its container whenever the layout changes it (window, fullscreen, panels, breakpoints, cards), not
    // only on a window resize; one resize per frame, the view kept as it is (no refit)
    let resizeFrame = 0;
    const resizes = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        map.resize();
      });
    });
    resizes.observe(host.current);
    map.on('load', () => {
      const shield = routeShield();
      if (!map.hasImage(ROUTE_SHIELD)) map.addImage(ROUTE_SHIELD, shield.image, shield.options);
      setReady(true);
      onReady?.(map);
    });
    return () => {
      resizes.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      mapRef.current = null;
      setReady(false);
      map.remove();
    };
    // the style is built once; mode changes go through setBasemapMode below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemapUrl, fontUrl, hillshade?.url, hillshade?.kind, terrain3d?.url]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && ready) setBasemapMode(map, mode);
  }, [mode, ready]);

  return (
    <div className={'ml-offline' + (className ? ' ' + className : '')} data-mode={mode} data-map-theme={mapThemeOverride ?? undefined}>
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
