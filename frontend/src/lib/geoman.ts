import type L from 'leaflet';
import Lg from './leaflet';

let geoman: Promise<unknown> | null = null;

/** Leaflet-Geoman Free and its styles, loaded once on demand from the local build. */
export function loadGeoman() {
  if (!geoman) geoman = Promise.all([import('@geoman-io/leaflet-geoman-free'), import('@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css')]);
  return geoman;
}

/** Loads Geoman and attaches it to a map created before it was loaded (its init hook did not run for that map). */
export async function ensureGeoman(map: L.Map): Promise<void> {
  await loadGeoman();
  const m = map as unknown as { pm?: unknown };
  if (!m.pm) m.pm = new (Lg as unknown as { PM: { Map: new (x: L.Map) => unknown } }).PM.Map(map);
}
