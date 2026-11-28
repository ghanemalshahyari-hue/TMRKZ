import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LngLat, Map as MlMap, type GeoJSONSource, type LayerSpecification, type LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './offlineMap.css';
import {
  COVERAGE_SOURCE,
  OVERLAY_ANCHOR,
  WIDE_MAX_ZOOM,
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
import { constrainToCoverage, coveragePolygon, packageExtent, type PackageExtent } from './packageCoverage';

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
/** The whole country: the standard view every map page opens on, and where «الخريطة كاملة» returns (owner, 25 Nov 2026). */
export const COUNTRY_BOUNDS: [[number, number], [number, number]] = [[51.5, 22.6], [56.45, 26.1]];

/** Shows the whole country again, keeping the 2D/3D tilt; for the button and for pages. */
export function showWholeCountry(map: MlMap, duration = 600): void {
  map.fitBounds(COUNTRY_BOUNDS, { padding: 24, duration, pitch: map.getPitch(), bearing: 0 });
}

/** «الخريطة كاملة»: one button with the map's own controls, to look at one place, then the whole map, then another. */
class FullViewControl {
  private box: HTMLDivElement | null = null;

  constructor(private readonly show: () => void) {}

  onAdd(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group tz-fullview-ctrl';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tz-fullview-btn';
    b.title = 'عرض الدولة كاملة';
    b.setAttribute('aria-label', 'الخريطة كاملة — عرض الدولة كاملة');
    b.dataset.testid = 'map-full-view';
    b.textContent = 'الخريطة كاملة';
    b.addEventListener('click', this.show);
    box.appendChild(b);
    this.box = box;
    return box;
  }

  onRemove(): void {
    this.box?.remove();
    this.box = null;
  }
}

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
  fullView = false,
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
  /** A map page: opens on the whole country (not `center`/`zoom`) and carries the «الخريطة كاملة» button. */
  fullView?: boolean;
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
      ...(fullView ? { bounds: COUNTRY_BOUNDS, fitBoundsOptions: { padding: 24 } } : { center: initial.current.center, zoom: initial.current.zoom }),
      minZoom,
      maxZoom,
      maxBounds,
      attributionControl: { compact: false },
      canvasContextAttributes: { preserveDrawingBuffer },
      // the container is followed by the one observer below, which knows whether the whole-country view is to be kept
      trackResize: false,
    });
    drawGlyphsLeftToRight(map);
    // The camera that shows the whole country, while nothing else has moved it (owner, 28 Nov 2026): a page that opens on
    // the whole country keeps showing it when its box is laid out or resized after the first frame — before, a refresh fitted
    // the country to the box's first, smaller size and the grown box then showed the empty space around the package.
    const camera = () => {
      const c = map.getCenter();
      return [c.lng, c.lat, map.getZoom(), map.getBearing(), map.getPitch()];
    };
    let countryView: number[] | null = null;
    const atCountryView = () => countryView !== null && camera().every((v, i) => Math.abs(v - countryView![i]) < 1e-9);
    const showCountry = (duration: number) => {
      if (duration > 0) map.once('moveend', () => { countryView = camera(); });
      showWholeCountry(map, duration);
      if (duration === 0) countryView = camera();
    };
    if (fullView) {
      countryView = camera();
      map.addControl(new FullViewControl(() => showCountry(600)), 'bottom-right');
    }
    // No empty edge (owner, 28 Nov 2026; ADR-110): once the package's extent is read, the region tile is hidden over the area
    // the detailed tiles of the current zoom cover, and the camera stays on the region tile (packageCoverage.ts) — the whole
    // country fits a box of any shape. A page that sets its own `maxBounds` keeps MapLibre's constraint. The map's size is
    // read from the canvas's style, which MapLibre sets before it constrains on a resize, so the layout is never read while
    // the map moves.
    let removed = false;
    let extent: PackageExtent | null = null;
    let maskZoom = -1;
    const updateMask = () => {
      const source = extent && (map.getSource(COVERAGE_SOURCE) as GeoJSONSource | undefined);
      const z = Math.floor(map.getZoom());
      if (!source || !extent || z === maskZoom) return;
      maskZoom = z;
      source.setData({ type: 'Feature', properties: {}, geometry: coveragePolygon(extent, z) });
    };
    map.on('zoom', updateMask);
    map.on('load', updateMask);
    packageExtent(abs(basemapUrl)).then((found) => {
      if (removed || !found) return;
      extent = found;
      updateMask();
      if (maxBounds) return;
      const country = atCountryView();
      const canvas = map.getCanvas();
      map.setTransformConstrain((lngLat, zoom) => {
        const view = { width: parseFloat(canvas.style.width) || 0, height: parseFloat(canvas.style.height) || 0 };
        const r = constrainToCoverage(found, lngLat, zoom, { ...view, bearing: map.getBearing(), padding: map.getPadding() }, {
          minZoom: map.getMinZoom(),
          maxZoom: map.getMaxZoom(),
        }, WIDE_MAX_ZOOM);
        return { center: new LngLat(r.lng, r.lat), zoom: r.zoom };
      });
      if (country) showCountry(0);
    });
    mapRef.current = map;
    // the canvas follows its container whenever the layout changes it (window, fullscreen, panels, breakpoints, cards), not
    // only on a window resize; one resize per frame; a view someone has moved is kept as it is, the untouched whole-country
    // view is fitted again to the new size
    let resizeFrame = 0;
    const resizes = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const country = atCountryView();
        map.resize();
        if (country) showCountry(0);
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
      removed = true;
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
      {/* No label over the map (owner, 28 Nov 2026): the source notices live in the attribution line (offlineStyle.ts);
          only a missing terrain layer is still said on the map */}
      {mode === 'terrain' && !hillshade && (
        <div className="ml-offline-notice" role="note" data-testid="map-source-notice">طبقة طبيعة الأرض غير مثبتة في هذه الحزمة</div>
      )}
    </div>
  );
}

/** Adds a page layer above the background and below the labels, or on top of everything. */
export function addOverlayLayer(map: MlMap, layer: LayerSpecification, position: 'below-labels' | 'top' = 'below-labels'): void {
  map.addLayer(layer, position === 'top' ? undefined : OVERLAY_ANCHOR);
}
