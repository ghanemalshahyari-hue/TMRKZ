import type { HillshadeSource } from './offlineStyle';

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
/** The map's label font travels with the package; the page's own text keeps the application's copy (styles/fonts.css). */
export const MAP_FONT_URL = MAP_DATA + '/fonts/NotoSansArabic.ttf';
