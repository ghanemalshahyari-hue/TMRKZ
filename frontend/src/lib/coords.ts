export type LatLngValue = { lat: number; lng: number };

const round = (v: number) => Math.round(v * 1e7) / 1e7;

/**
 * Typed coordinates → a point only when BOTH values are present, numeric and in range. A missing or invalid axis is
 * never replaced by 0 (enterprise audit P1-3: «خط العرض 91» followed by a longitude used to save the site on the
 * equator). Both fields empty is not an error yet.
 */
export function parseCoordinates(latText: string, lngText: string): { point: LatLngValue | null; error: string } {
  const lt = latText.trim();
  const gt = lngText.trim();
  if (lt === '' && gt === '') return { point: null, error: '' };
  const lat = Number(lt);
  const lng = Number(gt);
  if (lt === '' || !Number.isFinite(lat)) return { point: null, error: 'أدخل خط العرض (رقم بين −90 و90).' };
  if (Math.abs(lat) > 90) return { point: null, error: 'خط العرض بين −90 و90.' };
  if (gt === '' || !Number.isFinite(lng)) return { point: null, error: 'أدخل خط الطول (رقم بين −180 و180).' };
  if (Math.abs(lng) > 180) return { point: null, error: 'خط الطول بين −180 و180.' };
  return { point: { lat: round(lat), lng: round(lng) }, error: '' };
}
