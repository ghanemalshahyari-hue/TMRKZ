// Fictional, generated data for the stationing UX prototype only. No real organisation, site or location is described:
// names are generic administrative units and facilities, coordinates are placed on the illustrative regional basemap of
// the acceptance environment (map-packages/regional-basemap-2026.10). Symbols use the fictional test catalogue (APP-6 D).
import type { Ring } from '../../../frontend/src/lib/footprint';

export type Org = { id: string; name: string; parentId: string | null; sidc: string | null };
export type SiteStatus = 'FREE' | 'PARTIAL' | 'BUSY';
export type Site = {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  lat: number;
  lng: number;
  ring: Ring | null;
  status: SiteStatus;
  responsible: string;
  occupants: string[];
};

const SIDC = {
  C2: '10031000001100000000',
  ADMIN: '10031000001601000000',
  PERSONNEL: '10031000001624000000',
  FINANCE: '10031000001607000000',
  MAINT: '10031000001611000000',
  TRANSPORT: '10031000001636000000',
  SUSTAIN: '10031000001600000000',
};

export const ORGS: Org[] = [
  { id: 'o-root', name: 'المؤسسة', parentId: null, sidc: SIDC.C2 },
  { id: 'o-ga', name: 'الإدارة العامة', parentId: 'o-root', sidc: SIDC.ADMIN },
  { id: 'o-ga-adm', name: 'قسم الشؤون الإدارية', parentId: 'o-ga', sidc: SIDC.PERSONNEL },
  { id: 'o-ga-fin', name: 'قسم الشؤون المالية', parentId: 'o-ga', sidc: SIDC.FINANCE },
  { id: 'o-ss', name: 'الخدمات المشتركة', parentId: 'o-root', sidc: SIDC.SUSTAIN },
  { id: 'o-ss-gen', name: 'قسم الخدمات العامة', parentId: 'o-ss', sidc: null },
  { id: 'o-ss-tr', name: 'قسم النقل والحركة الإدارية', parentId: 'o-ss', sidc: SIDC.TRANSPORT },
  { id: 'o-ss-tr-fl', name: 'وحدة الأسطول الإداري', parentId: 'o-ss-tr', sidc: null },
  { id: 'o-ss-mt', name: 'قسم الصيانة الإدارية', parentId: 'o-ss', sidc: SIDC.MAINT },
  { id: 'o-ss-mt-n', name: 'فريق صيانة الشمال', parentId: 'o-ss-mt', sidc: null },
  { id: 'o-ss-mt-s', name: 'فريق صيانة الجنوب', parentId: 'o-ss-mt', sidc: null },
  { id: 'o-it', name: 'إدارة التقنية', parentId: 'o-root', sidc: SIDC.C2 },
  { id: 'o-it-net', name: 'قسم الشبكات', parentId: 'o-it', sidc: null },
  { id: 'o-it-sup', name: 'قسم الدعم الفني', parentId: 'o-it', sidc: SIDC.ADMIN },
  { id: 'o-pm', name: 'إدارة المشاريع', parentId: 'o-root', sidc: SIDC.SUSTAIN },
  { id: 'o-pm-bld', name: 'قسم مشاريع المباني', parentId: 'o-pm', sidc: null },
  { id: 'o-pm-bld-sv', name: 'وحدة الإشراف الهندسي', parentId: 'o-pm-bld', sidc: null },
  { id: 'o-pm-bld-sv-n', name: 'فريق مرافق الشمال', parentId: 'o-pm-bld-sv', sidc: SIDC.MAINT },
  { id: 'o-hr', name: 'إدارة الموارد البشرية', parentId: 'o-root', sidc: SIDC.PERSONNEL },
  { id: 'o-hr-rec', name: 'قسم التوظيف', parentId: 'o-hr', sidc: null },
  { id: 'o-hr-trn', name: 'قسم التدريب', parentId: 'o-hr', sidc: SIDC.PERSONNEL },
];

// deterministic pseudo-random footprints (mulberry32), so screenshots are reproducible
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(20261102);
const M_LAT = 1 / 111320;
const mLng = (lat: number) => 1 / (111320 * Math.cos((lat * Math.PI) / 180));

/** An irregular footprint of roughly w × h metres around a point (4–6 vertices, never self-intersecting). */
function footprint(lat: number, lng: number, w: number, h: number): Ring {
  const n = 4 + Math.floor(R() * 3);
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3;
    const k = 0.78 + R() * 0.3;
    out.push({ lat: lat + Math.sin(a) * (h / 2) * k * M_LAT, lng: lng + Math.cos(a) * (w / 2) * k * mLng(lat) });
  }
  return out;
}

type Def = [code: string, name: string, lat: number, lng: number, size: number | null, status: SiteStatus, responsible: string, occupants?: string[], parent?: string];
const DEFS: Def[] = [
  // central district (dense): a main site with three sub-sites at almost the same point, shared buildings
  ['C-01', 'مجمع الخدمات المركزي', 25.2070, 55.3160, null, 'FREE', 'o-ss'],
  ['C-02', 'مبنى الاستقبال', 25.2072, 55.3163, 180, 'FREE', 'o-ss-gen', ['o-ss-tr'], 'C-01'],
  ['C-03', 'قاعة الاجتماعات الكبرى', 25.2067, 55.3168, 120, 'PARTIAL', 'o-ss', ['o-ga', 'o-it'], 'C-01'],
  ['C-04', 'مستودع اللوازم المركزي', 25.2062, 55.3155, 160, 'BUSY', 'o-ss-mt', [], 'C-01'],
  ['C-05', 'المبنى المشترك', 25.2015, 55.3105, 200, 'PARTIAL', 'o-ss', ['o-it', 'o-hr', 'o-ss-gen']],
  ['C-06', 'مركز التدريب الإداري', 25.1985, 55.3190, 220, 'BUSY', 'o-hr-trn', ['o-hr']],
  ['C-07', 'مواقف المركبات الإدارية', 25.2098, 55.3205, 260, 'FREE', 'o-ss-tr-fl'],
  ['C-08', 'مبنى الصيانة', 25.2105, 55.3122, 150, 'FREE', 'o-ss-mt', ['o-ss-mt-n']],
  ['C-09', 'مكتب الشؤون المالية', 25.2040, 55.3220, 110, 'FREE', 'o-ga-fin'],
  ['C-10', 'مبنى الإدارة الرئيسي', 25.2120, 55.3065, 240, 'PARTIAL', 'o-ga', ['o-ga-adm', 'o-ga-fin', 'o-root']],
  // business district
  ['B-01', 'مكتب التقنية', 25.1868, 55.2735, 140, 'FREE', 'o-it'],
  ['B-02', 'مركز البيانات', 25.1852, 55.2760, 190, 'BUSY', 'o-it-net'],
  ['B-03', 'مركز الدعم الفني', 25.1885, 55.2768, 120, 'FREE', 'o-it-sup', ['o-it']],
  ['B-04', 'مبنى المشاريع', 25.1830, 55.2712, 210, 'PARTIAL', 'o-pm', ['o-pm-bld']],
  ['B-05', 'مكتب الإشراف الهندسي', 25.1842, 55.2690, null, 'FREE', 'o-pm-bld-sv'],
  ['B-06', 'قاعة التدريب التقني', 25.1898, 55.2722, 100, 'FREE', 'o-it', ['o-hr-trn']],
  // north
  ['N-01', 'مستودع اللوازم الشمالي', 25.2735, 55.3330, 230, 'FREE', 'o-pm-bld-sv-n'],
  ['N-02', 'مبنى صيانة الشمال', 25.2768, 55.3392, 160, 'BUSY', 'o-ss-mt-n'],
  ['N-03', 'مكتب الحركة الشمالي', 25.2702, 55.3285, null, 'FREE', 'o-ss-tr'],
  ['N-04', 'مبنى الخدمات الشمالي', 25.2810, 55.3255, 180, 'PARTIAL', 'o-ss', ['o-ss-gen']],
  ['N-05', 'مرآب الأسطول الشمالي', 25.2790, 55.3440, 280, 'FREE', 'o-ss-tr-fl'],
  // east
  ['E-01', 'مبنى الموارد البشرية', 25.2150, 55.3820, 200, 'FREE', 'o-hr', ['o-hr-rec']],
  ['E-02', 'مركز التوظيف', 25.2122, 55.3865, 130, 'PARTIAL', 'o-hr-rec'],
  ['E-03', 'قاعة المقابلات', 25.2180, 55.3880, null, 'FREE', 'o-hr-rec'],
  ['E-04', 'مكتب الشؤون الإدارية الشرقي', 25.2085, 55.3790, 120, 'BUSY', 'o-ga-adm'],
  ['E-05', 'مبنى الخدمات الشرقي', 25.2210, 55.3760, 170, 'FREE', 'o-ss', ['o-ss-gen', 'o-ss-tr']],
  // south and west
  ['S-01', 'مبنى صيانة الجنوب', 25.1240, 55.2320, 180, 'FREE', 'o-ss-mt-s'],
  ['S-02', 'مستودع الجنوب', 25.1195, 55.2385, 260, 'PARTIAL', 'o-ss-mt-s', ['o-ss-mt']],
  ['S-03', 'مكتب الحركة الجنوبي', 25.1278, 55.2285, null, 'FREE', 'o-ss-tr'],
  ['S-04', 'مركز التدريب الميداني', 25.1150, 55.2290, 300, 'FREE', 'o-hr-trn'],
  ['W-01', 'مبنى الخدمات الغربية', 25.2190, 55.2540, 170, 'BUSY', 'o-ss-gen'],
  ['W-02', 'مكتب المشاريع الغربي', 25.2245, 55.2480, 140, 'FREE', 'o-pm-bld'],
  ['W-03', 'مبنى الأرشيف الإداري', 25.2310, 55.2605, 150, 'FREE', 'o-ga-adm'],
  // scattered
  ['X-01', 'مركز الاتصالات الإدارية', 25.2480, 55.3005, 120, 'FREE', 'o-it-net'],
  ['X-02', 'نقطة خدمة الموظفين', 25.1655, 55.3335, null, 'FREE', 'o-ss-gen'],
  ['X-03', 'مبنى الدعم اللوجستي', 25.1580, 55.2905, 200, 'PARTIAL', 'o-ss', ['o-ss-tr', 'o-ss-mt']],
  ['X-04', 'مكتب العقود', 25.2390, 55.3555, 110, 'FREE', 'o-ga-fin'],
  ['X-05', 'قاعة الفعاليات', 25.1745, 55.3080, 240, 'FREE', 'o-ga', ['o-hr', 'o-ss']],
];

const byCode = new Map<string, string>();
export const SITES: Site[] = DEFS.map(([code, name, lat, lng, size, status, responsible, occupants, parent]) => {
  const id = 's-' + code.toLowerCase();
  byCode.set(code, id);
  return {
    id,
    code,
    name,
    parentId: parent ? 's-' + parent.toLowerCase() : null,
    lat,
    lng,
    ring: size ? footprint(lat, lng, size, size * (0.6 + R() * 0.5)) : null,
    status,
    responsible,
    occupants: occupants ?? [],
  };
});

/** The configured distance rule of the fictional environment: the proposal's centre 1–6 km from the current site. */
export const RANGE = { min: 1000, max: 6000 };

/** Illustrative regional basemap of the acceptance environment (an SVG overlay with corner bounds, see its manifest). */
export const BASEMAP_BOUNDS: [[number, number], [number, number]] = [
  [25.07, 55.19],
  [25.33, 55.46],
];

export const orgById = new Map(ORGS.map((o) => [o.id, o]));
export const siteById = new Map(SITES.map((s) => [s.id, s]));
export const childrenOf = (id: string | null) => ORGS.filter((o) => o.parentId === id);
export function descendantsOf(id: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => childrenOf(p).forEach((c) => (out.push(c.id), walk(c.id)));
  walk(id);
  return out;
}
export function pathOf(id: string): Org[] {
  const out: Org[] = [];
  let cur = orgById.get(id)?.parentId ?? null;
  while (cur) {
    const o = orgById.get(cur);
    if (!o) break;
    out.unshift(o);
    cur = o.parentId;
  }
  return out;
}
/** Every organisation at a site: the responsible one first, then those using it. */
export const orgsAt = (s: Site) => [s.responsible, ...s.occupants.filter((o) => o !== s.responsible)];
export const sitesOf = (orgIds: string[]) => SITES.filter((s) => orgsAt(s).some((o) => orgIds.includes(o)));
export const STATUS_LABEL: Record<SiteStatus, string> = { FREE: 'متاح', PARTIAL: 'إشغال جزئي', BUSY: 'غير متاح' };
export const STATUS_GLYPH: Record<SiteStatus, string> = { FREE: '✓', PARTIAL: '◐', BUSY: '✕' };
