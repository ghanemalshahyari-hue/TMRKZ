// The owner's remaining question (final brief §27, §48): the SAME stationing site and deployment area measured by
// A. centre → centre and B. nearest edge → nearest edge, against the same 5–8 km example band. Fictional geometry.
import { centroid, type Ring } from '../../../../frontend/src/lib/footprint';
import { destination, distanceM } from '../../../../frontend/src/lib/geo';
import { circleRing, nearestPair } from './measure';

const M_LAT = 1 / 111320;
const site0 = { lat: 25.205, lng: 55.3 };
const mLng = 1 / (111320 * Math.cos((site0.lat * Math.PI) / 180));
/** A 900 × 600 m stationing site and a deployment area of 1.3 km radius, 8.3 km apart centre to centre. */
export const COMPARE_SITE: Ring = [
  { lat: site0.lat - 300 * M_LAT, lng: site0.lng - 450 * mLng },
  { lat: site0.lat - 300 * M_LAT, lng: site0.lng + 450 * mLng },
  { lat: site0.lat + 300 * M_LAT, lng: site0.lng + 450 * mLng },
  { lat: site0.lat + 300 * M_LAT, lng: site0.lng - 450 * mLng },
];
export const COMPARE_AREA: Ring = circleRing(destination(site0, 62, 8300), 1300, 40);
export const COMPARE_BAND = { min: 5000, max: 8000 };

export function comparison() {
  const a = distanceM(centroid(COMPARE_SITE), centroid(COMPARE_AREA));
  const near = nearestPair(COMPARE_SITE, COMPARE_AREA);
  const inBand = (d: number) => d >= COMPARE_BAND.min && d <= COMPARE_BAND.max;
  return { a, b: near.d, near, aOk: inBand(a), bOk: inBand(near.d) };
}
