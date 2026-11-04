import { addProtocol, setWorkerUrl, type AddProtocolAction } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';

let done = false;

/**
 * One-time page setup before the first map:
 * - the MapLibre worker is the packaged file: MapLibre 6 computes its URL at run time, which the build cannot follow,
 *   so the build emits it through this import;
 * - `pmtiles://` reads archives with HTTP range requests from the application's own origin, so a basemap or hillshade
 *   package needs no tile server.
 */
export function ensureOfflineMapSetup(): void {
  if (done) return;
  setWorkerUrl(new URL(workerUrl, document.baseURI).href);
  addProtocol('pmtiles', new Protocol().tile as unknown as AddProtocolAction);
  done = true;
}
