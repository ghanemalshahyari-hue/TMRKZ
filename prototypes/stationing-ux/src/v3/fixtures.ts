// The fictional V3 world. Units arrive as rows of an Oracle TEST extract in the shape of the read-only HR mapping
// (backend hr/HrMapping.java: external_unit_id, parent_external_unit_id, name, status, code, level) and are projected
// into the tree exactly as the mirror would, by parent links; nothing here names a level count. Sites are TMRKZ records
// (one from a fictional external site system) with ids of their own. Every name, place and value is fictional; the
// policy values are the owner's EXAMPLES (5–8 km, 3–5 km, +1 / +2 km) entered as a labelled demonstration version.
// Terrain classes are a generated illustrative dataset, not real ground data — never for production (owner brief §23).
// Site ↔ unit LINKS are a separate record from stationing (owner rule O-02): a link never becomes stationing.
import type { Ring } from '../../../../frontend/src/lib/footprint';
import type { LatLng } from '../../../../frontend/src/lib/geo';
import { circleRing } from './measure';
import { DAY, type Org, type Person, type PolicyValues, type Site, type Stationing, type World } from './domain';

export const NOW = Date.UTC(2026, 10, 3, 6, 0);

/** Oracle TEST extract (non-production). Columns as mapped by the approved HR mapping version. */
export const ORACLE_TEST_EXTRACT = [
  { external_unit_id: '600', parent_external_unit_id: null, level: 6, code: 'GS', name: 'الإدارة العامة للخدمات', status: 'A' },
  { external_unit_id: '700', parent_external_unit_id: '600', level: 7, code: 'SS', name: 'إدارة الخدمات المساندة', status: 'A' },
  { external_unit_id: '800', parent_external_unit_id: '700', level: 8, code: 'SS-TS', name: 'قسم الخدمات الفنية', status: 'A' },
  { external_unit_id: '900', parent_external_unit_id: '800', level: 9, code: 'SS-TS-MN', name: 'شعبة الصيانة', status: 'A' },
  { external_unit_id: '1000', parent_external_unit_id: '900', level: 10, code: 'SS-TS-MN-B', name: 'وحدة صيانة المباني', status: 'A' },
  { external_unit_id: '1001', parent_external_unit_id: '900', level: 10, code: 'SS-TS-MN-E', name: 'وحدة الصيانة الكهربائية', status: 'A' },
  { external_unit_id: '901', parent_external_unit_id: '800', level: 9, code: 'SS-TS-TR', name: 'شعبة النقل', status: 'A' },
  { external_unit_id: '902', parent_external_unit_id: '800', level: 9, code: 'SS-TS-WH', name: 'شعبة المستودعات', status: 'A' },
  { external_unit_id: '801', parent_external_unit_id: '700', level: 8, code: 'SS-GN', name: 'قسم الخدمات العامة', status: 'A' },
  { external_unit_id: '903', parent_external_unit_id: '801', level: 9, code: 'SS-GN-RC', name: 'شعبة الاستقبال', status: 'A' },
  { external_unit_id: '701', parent_external_unit_id: '600', level: 7, code: 'IT', name: 'إدارة تقنية المعلومات', status: 'A' },
  { external_unit_id: '802', parent_external_unit_id: '701', level: 8, code: 'IT-NW', name: 'قسم الشبكات', status: 'A' },
  { external_unit_id: '803', parent_external_unit_id: '701', level: 8, code: 'IT-SY', name: 'قسم الأنظمة', status: 'A' },
  { external_unit_id: '904', parent_external_unit_id: '803', level: 9, code: 'IT-SY-SP', name: 'شعبة الدعم الفني', status: 'A' },
  { external_unit_id: '702', parent_external_unit_id: '600', level: 7, code: 'HR', name: 'إدارة الموارد البشرية', status: 'A' },
  { external_unit_id: '804', parent_external_unit_id: '702', level: 8, code: 'HR-TR', name: 'قسم التدريب', status: 'A' },
];

export const ORACLE_SOURCE = 'Oracle HR — بيئة اختبار (غير إنتاجية)، عرض TNQL، قراءة فقط';

function project(rows: typeof ORACLE_TEST_EXTRACT): Org[] {
  const id = (x: string) => 'u' + x;
  return rows.filter((r) => r.status === 'A').map((r) => ({ id: id(r.external_unit_id), oracleId: r.external_unit_id, parentId: r.parent_external_unit_id ? id(r.parent_external_unit_id) : null, level: r.level, name: r.name, code: r.code }));
}

const M_LAT = 1 / 111320;
const mLng = (lat: number) => 1 / (111320 * Math.cos((lat * Math.PI) / 180));
/** A simple irregular footprint of about w × h metres. */
function box(lat: number, lng: number, w: number, h: number, skew = 0.12): Ring {
  const dx = (w / 2) * mLng(lat);
  const dy = (h / 2) * M_LAT;
  return [
    { lat: lat - dy, lng: lng - dx },
    { lat: lat - dy * (1 - skew), lng: lng + dx },
    { lat: lat + dy, lng: lng + dx * (1 - skew) },
    { lat: lat + dy * (1 - skew), lng: lng - dx },
  ];
}

// [id, name, lat, lng, w, h, source]
const SITE_DEFS: [string, string, number, number, number, number, Site['source']?][] = [
  ['SITE-0101', 'الموقع A — مجمع الخدمات الفنية', 25.207, 55.316, 380, 300],
  ['SITE-0102', 'الموقع B — مبنى الصيانة الغربي', 25.1868, 55.2735, 260, 200],
  ['SITE-0103', 'الموقع C — ورشة المباني الشرقية', 25.215, 55.382, 220, 180],
  ['SITE-0104', 'الموقع D — مستودع الشمال', 25.2735, 55.333, 300, 240, { system: 'نظام إدارة المرافق (افتراضي)', externalId: 'FMS-117', readOnlyGeometry: true }],
  ['SITE-0105', 'الموقع E — مبنى الخدمات العامة', 25.158, 55.2905, 240, 200],
  ['SITE-0106', 'الموقع F — مركز الأنظمة', 25.239, 55.3555, 200, 180],
  ['SITE-0107', 'الموقع G — مكتب الدعم الفني', 25.231, 55.2605, 160, 140],
  ['SITE-0108', 'الموقع H — مبنى الموارد البشرية', 25.2015, 55.3105, 260, 220],
  ['SITE-0109', 'الموقع I — مركز التدريب', 25.214, 55.3235, 300, 260],
  // no stationing: J is only LINKED to a unit (does not occupy, O-15); K has an approved RESERVATION (occupies)
  ['SITE-0110', 'الموقع J — قاعة متعددة الاستخدام', 25.2335, 55.2985, 200, 160],
  ['SITE-0111', 'الموقع K — ساحة محجوزة', 25.2245, 55.2855, 220, 180],
];

// where each unit is stationed (permanent, current) — physically independent of the tree (§5)
const STATIONED: [string, string][] = [
  ['u600', 'SITE-0106'],
  ['u700', 'SITE-0105'],
  ['u800', 'SITE-0101'],
  ['u900', 'SITE-0102'],
  ['u1000', 'SITE-0103'],
  ['u1001', 'SITE-0101'],
  ['u901', 'SITE-0101'],
  ['u902', 'SITE-0104'],
  ['u801', 'SITE-0105'],
  ['u903', 'SITE-0105'],
  ['u701', 'SITE-0106'],
  ['u802', 'SITE-0101'],
  ['u803', 'SITE-0106'],
  ['u904', 'SITE-0107'],
  ['u702', 'SITE-0108'],
  ['u804', 'SITE-0109'],
];

const RESPONSIBLE: [string, string][] = [
  ['SITE-0101', 'u800'],
  ['SITE-0102', 'u900'],
  ['SITE-0103', 'u900'],
  ['SITE-0104', 'u902'],
  ['SITE-0105', 'u700'],
  ['SITE-0106', 'u701'],
  ['SITE-0107', 'u803'],
  ['SITE-0108', 'u702'],
  ['SITE-0109', 'u804'],
];

// site ↔ unit associations that are NOT stationing (a unit using a site, or assigned to it, without being stationed)
const LINKS: [string, string, string][] = [
  ['u902', 'SITE-0101', 'مخزن فرعي تستخدمه الشعبة في الموقع A (توضيحي)'],
  ['u803', 'SITE-0107', 'إشراف على مكتب الدعم الفني (توضيحي)'],
  ['u700', 'SITE-0101', 'ارتباط إداري بالمجمع (توضيحي)'],
  ['u903', 'SITE-0110', 'تستخدم الشعبة القاعة أحياناً — ارتباط فقط (توضيحي)'],
];

const ring = (pts: [number, number][]): Ring => pts.map(([lat, lng]) => ({ lat, lng }));

/** Fictional terrain-class zones (the "approved local terrain dataset" of §27 does not exist yet: open decision O-11). */
export const TERRAIN_ZONES = [
  { id: 'tz-1', code: 'ROLLING', ring: ring([[25.236, 55.36], [25.252, 55.392], [25.292, 55.404], [25.302, 55.372], [25.28, 55.35], [25.25, 55.348]]) },
  { id: 'tz-2', code: 'RUGGED', ring: ring([[25.106, 55.262], [25.112, 55.312], [25.142, 55.33], [25.152, 55.302], [25.138, 55.262]]) },
  // a square RUGGED zone whose western edge (lng 55.245) splits a placement exactly in half: the tie of O-05b
  { id: 'tz-4', code: 'RUGGED', ring: ring([[25.18, 55.245], [25.18, 55.265], [25.21, 55.265], [25.21, 55.245]]) },
  { id: 'tz-3', code: 'ROLLING', ring: ring([[25.152, 55.36], [25.162, 55.405], [25.19, 55.41], [25.198, 55.378], [25.18, 55.352]]) },
];

/** Hills of the generated illustrative elevation field (metres), consistent with the class zones above. */
export const HILLS: { c: LatLng; h: number; r: number }[] = [
  { c: { lat: 25.268, lng: 55.378 }, h: 55, r: 2600 },
  { c: { lat: 25.252, lng: 55.37 }, h: 35, r: 1500 },
  { c: { lat: 25.285, lng: 55.392 }, h: 40, r: 1700 },
  { c: { lat: 25.126, lng: 55.29 }, h: 110, r: 1900 },
  { c: { lat: 25.138, lng: 55.31 }, h: 85, r: 1300 },
  { c: { lat: 25.118, lng: 55.272 }, h: 70, r: 1200 },
  { c: { lat: 25.175, lng: 55.385 }, h: 40, r: 1900 },
];

export const PEOPLE: Person[] = [
  { id: 'p-req', name: 'سالم الكعبي', title: 'مقدم طلب — قسم الخدمات الفنية', human: 'h-salem', perms: ['CREATE_RESTATIONING'], scope: ['u800'] },
  { id: 'p-req9', name: 'هدى المزروعي', title: 'مقدمة طلب — شعبة الصيانة', human: 'h-huda', perms: ['CREATE_RESTATIONING'], scope: ['u900'] },
  { id: 'p-a9', name: 'خالد النعيمي', title: 'معتمد شعبة الصيانة', human: 'h-khaled', perms: ['APPROVE'], scope: ['u900'] },
  { id: 'p-a8', name: 'مريم الشامسي', title: 'معتمدة قسم الخدمات الفنية', human: 'h-maryam', perms: ['APPROVE'], scope: ['u800'] },
  // a second, independent human in the same approver seat: needed when the policy requires independent approvals (O-03b)
  { id: 'p-a8b', name: 'حمد الرميثي', title: 'معتمد بديل — قسم الخدمات الفنية', human: 'h-hamad', perms: ['APPROVE'], scope: ['u800'] },
  { id: 'p-a7', name: 'راشد الظاهري', title: 'معتمد إدارة الخدمات المساندة', human: 'h-rashed', perms: ['APPROVE'], scope: ['u700'] },
  { id: 'p-a6', name: 'عائشة الحمادي', title: 'المعتمدة النهائية — الإدارة العامة', human: 'h-aisha', perms: ['APPROVE'], scope: ['u600'] },
  { id: 'p-ait', name: 'يوسف البلوشي', title: 'معتمد قسم الشبكات', human: 'h-yousef', perms: ['APPROVE'], scope: ['u802'] },
  { id: 'p-a7it', name: 'سارة الكتبي', title: 'معتمدة إدارة تقنية المعلومات', human: 'h-sara', perms: ['APPROVE'], scope: ['u701'] },
  { id: 'p-exc', name: 'نورة السويدي', title: 'معتمدة استثناءات المسافة', human: 'h-noura', perms: ['APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION'], scope: ['u600'] },
  {
    id: 'p-act',
    name: 'فهد المنصوري',
    title: 'مسؤول التفعيل والقرارات المرتبطة',
    human: 'h-fahad',
    perms: ['ACTIVATE_STATIONING', 'ACTIVATE_TEMPORARY_EXTENSION', 'DECIDE_EARLY_RETURN', 'DECIDE_TEMPORARY_BEFORE_START_CANCELLATION'],
    scope: ['u600'],
  },
  { id: 'p-admin', name: 'ليلى العامري', title: 'مسؤولة النظام', human: 'h-laila', perms: ['ADMIN_POLICY', 'MANAGE_SITE_LINKS', 'CORRECT_STATIONING', 'MANAGE_FACILITY_RESPONSIBILITY'], scope: ['u600'] },
  // a second account of the requester's own human identity: separation of duties refuses it (stable person, §42)
  { id: 'p-req-alt', name: 'سالم الكعبي (حساب ثانٍ)', title: 'معتمد بديل — إدارة الخدمات المساندة', human: 'h-salem', perms: ['APPROVE'], scope: ['u700'] },
];

export const BASE_POLICY: PolicyValues = {
  maxFootprintAreaM2: 200_000,
  deployment: 'REQUIRED',
  primary: { minM: 5000, maxM: 8000, method: 'CENTROID_TO_CENTROID', terrain: true },
  alternative: { minM: 3000, maxM: 5000, method: 'CENTROID_TO_CENTROID', terrain: true },
  terrainClasses: [
    { code: 'FLAT', label: 'أرض مستوية', allowanceM: 0 },
    { code: 'ROLLING', label: 'أرض متموجة', allowanceM: 1000 },
    { code: 'RUGGED', label: 'أرض وعرة', allowanceM: 2000 },
  ],
  terrainResolution: 'LARGEST_AREA',
  // demonstration order only (highest first): deliberately not "largest allowance first", so a tie shows the rule
  terrainPriority: ['ROLLING', 'FLAT', 'RUGGED'],
  terrainAppliesTo: 'MAX_ONLY',
  exception: { allowed: true, maxExtraM: 1000 },
  crossBranch: { allowed: false, authorities: ['OTHER_UNIT'], independent: false },
  routing: {
    startAt: 'SELF',
    afterHierarchyChange: 'RESTART_ALL',
    levels: [
      { level: 10, approve: false, label: 'معتمد الوحدة', dependsOn: ['SCOPE'] },
      { level: 9, approve: true, label: 'معتمد الشعبة', dependsOn: ['SCOPE', 'CLASSIFICATION', 'DURATION'] },
      { level: 8, approve: true, label: 'معتمد القسم', dependsOn: ['SCOPE', 'CLASSIFICATION', 'DURATION'] },
      { level: 7, approve: true, label: 'معتمد وسيط — الإدارة', dependsOn: ['SCOPE', 'SITE', 'DEPLOYMENT', 'AVAILABILITY'] },
      { level: 6, approve: true, label: 'المعتمد النهائي', final: true, dependsOn: [] },
    ],
  },
};

export function baseWorld(): World {
  const sites: Site[] = SITE_DEFS.map(([id, name, lat, lng, w, h, source]) => ({ id, name, ring: box(lat, lng, w, h), source: source ?? { system: 'TMRKZ' }, state: 'REGISTERED' }));
  const stationings: Stationing[] = STATIONED.map(([org, site], i) => ({ id: 'st-' + i, org, site, kind: 'PERMANENT', state: 'CURRENT', from: NOW - 400 * DAY }));
  return {
    now: NOW,
    orgs: project(ORACLE_TEST_EXTRACT),
    sites,
    stationings,
    responsibilities: RESPONSIBLE.map(([site, org], i) => ({ id: 'rs-' + i, site, org, from: NOW - 400 * DAY, reason: 'تسجيل أولي' })),
    areas: [],
    zones: [{ id: 'z-1', name: 'منطقة أعمال إنشائية محجوزة', ring: circleRing({ lat: 25.2215, lng: 55.333 }, 650, 20) }],
    links: LINKS.map(([org, site, reason], i) => ({ id: 'ln-' + i, org, site, from: NOW - 200 * DAY, source: 'TMRKZ', reason })),
    terrain: { name: 'تصنيف أرض توضيحي مولّد', provenance: 'بيانات وهمية للنموذج فقط — لا تصلح للإنتاج (O-11)', defaultCode: 'FLAT', zones: TERRAIN_ZONES },
    people: PEOPLE,
    policies: [{ version: 1, effectiveFrom: NOW - 30 * DAY, author: 'p-admin', reason: 'نسخة عرض توضيحية بقيم أمثلة المالك (غير معتمدة للإنتاج)', reference: 'POL-STN-DEMO-1', values: structuredClone(BASE_POLICY) }],
    requests: [],
    events: [],
    occupancies: [{ id: 'oc-1', site: 'SITE-0111', org: 'u804', kind: 'RESERVATION', from: NOW - 5 * DAY, to: NOW + 60 * DAY, reference: 'RSV-2026-0042 (توضيحي)' }],
    outbox: [],
    oracle: { extractAt: NOW - 3_600_000, rows: ORACLE_TEST_EXTRACT.length, source: ORACLE_SOURCE },
  };
}
