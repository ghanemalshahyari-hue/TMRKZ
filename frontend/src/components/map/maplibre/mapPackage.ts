import type { HillshadeSource, Terrain3dSource } from './offlineStyle';

/**
 * Where the installed offline map package is served (ADR-036, ops/map-package/README.md): the web entry point serves
 * the active package under one root, and the files sit at fixed paths inside it. Versions and checksums live in the
 * package's own `manifest.json`, never in these paths, so a new package needs no new application build.
 */
export const MAP_DATA = '/map-data';
export const MAP_MANIFEST_URL = MAP_DATA + '/manifest.json';
export const BASEMAP_URL = MAP_DATA + '/basemap/uae.pmtiles';
/** Display only: the terrain classes of a deployment area come from the slope analysis loaded into PostGIS. */
export const HILLSHADE: HillshadeSource = { url: MAP_DATA + '/terrain/glo30/visualization/hillshade.pmtiles', kind: 'raster' };
/**
 * The 3D view's elevation tiles (package component `terrain-3d`, ADR-038): Terrain-RGB from the same GLO-30 source as
 * the slope analysis, display only. Older packages do not carry them; {@link installedTerrain3d} says whether this one does.
 */
export const TERRAIN_3D: Terrain3dSource = { url: MAP_DATA + '/terrain/glo30/visualization-3d/terrain-rgb.pmtiles', encoding: 'mapbox', tileSize: 256 };
/** The map's label font travels with the package; the page's own text keeps the application's copy (styles/fonts.css). */
export const MAP_FONT_URL = MAP_DATA + '/fonts/NotoSansArabic.ttf';

let manifest: Promise<{ packageId: string | null; terrain3d: boolean }> | null = null;

/** Which package is installed and whether it carries the 3D terrain; read once from its manifest (no package: neither). */
export function installedPackage(): Promise<{ packageId: string | null; terrain3d: boolean }> {
  manifest ??= fetch(MAP_MANIFEST_URL)
    .then((r) => (r.ok ? r.json() : null))
    .then((m: { packageId?: string; components?: { id: string }[] } | null) => ({
      packageId: m?.packageId ?? null,
      terrain3d: !!m?.components?.some((c) => c.id === 'terrain-3d'),
    }))
    .catch(() => ({ packageId: null, terrain3d: false }));
  return manifest;
}

/** The 3D elevation source when the installed package carries it, otherwise null. */
export const installedTerrain3d = () => installedPackage().then((p) => (p.terrain3d ? TERRAIN_3D : null));
