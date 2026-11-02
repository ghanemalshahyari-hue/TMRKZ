// Fictional administrative organisations for the symbol-first interaction prototype. Each organisation has its OWN
// identity symbol (milsymbol) at its registered facility. Nothing here is real. Occupied zones, the allowed range and
// the geo math are reused from data.ts so this prototype stays consistent with the drag prototypes.
import { CENTER, OCCUPIED, RULE, destination, distanceM, pointInOccupied, formatKm, type LatLng } from './data';
export { OCCUPIED, RULE, CENTER, destination, distanceM, pointInOccupied, formatKm, type LatLng };

export type Org = {
  id: string;
  name: string;      // Arabic name (shown beside the symbol, never inside it)
  kind: string;      // إدارة / قسم / وحدة — organisational level, informational
  sidc: string;      // identity symbol code (APP6-D, friendly land unit)
  at: LatLng;        // registered facility location
  facility: string;  // facility name (the physical place — distinct from the organisation)
  facilityId: string;// facilities shared by several organisations share this id
  canPropose: boolean;
};

// one facility (f4 «مركز الخدمات») is shared by two organisations, to exercise the shared-facility picker.
// Neutral friendly-unit frames differentiated by echelon amplifier (إدارة = higher, قسم, وحدة) — no military entity
// icon. Identity is carried by the Arabic name label and the frame, matching the app's informational-symbol approach.
export const ORGS: Org[] = [
  { id: 'o1', name: 'إدارة المشاريع', kind: 'إدارة', sidc: '10031000160000000000', facility: 'مجمع الإدارة الرئيسي', facilityId: 'f1', at: destination(CENTER, 20, 1300), canPropose: true },
  { id: 'o2', name: 'قسم مشاريع المباني', kind: 'قسم', sidc: '10031000150000000000', facility: 'مبنى المشاريع', facilityId: 'f2', at: destination(CENTER, 310, 2700), canPropose: true },
  { id: 'o3', name: 'وحدة الصيانة الإدارية', kind: 'وحدة', sidc: '10031000140000000000', facility: 'ورشة الصيانة', facilityId: 'f3', at: destination(CENTER, 130, 3500), canPropose: true },
  { id: 'o4', name: 'الخدمات المشتركة', kind: 'إدارة', sidc: '10031000160000000000', facility: 'مركز الخدمات', facilityId: 'f4', at: destination(CENTER, 215, 2100), canPropose: true },
  { id: 'o5', name: 'قسم النقل والحركة', kind: 'قسم', sidc: '10031000150000000000', facility: 'مركز الخدمات', facilityId: 'f4', at: destination(CENTER, 215, 2100), canPropose: true },
  { id: 'o6', name: 'إدارة التقنية', kind: 'إدارة', sidc: '10031000160000000000', facility: 'مبنى التقنية', facilityId: 'f6', at: destination(CENTER, 80, 4300), canPropose: false },
];

export type Facility = { id: string; at: LatLng; name: string; orgs: Org[] };
export const FACILITIES: Facility[] = Object.values(
  ORGS.reduce<Record<string, Facility>>((acc, o) => {
    (acc[o.facilityId] ??= { id: o.facilityId, at: o.at, name: o.facility, orgs: [] }).orgs.push(o);
    return acc;
  }, {}),
);

export function inRange(from: LatLng, p: LatLng): boolean {
  const d = distanceM(from, p);
  return d >= RULE.minM && (RULE.maxM == null || d <= RULE.maxM);
}
