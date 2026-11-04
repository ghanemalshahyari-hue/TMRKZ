// Fictional data for the stationing domain prototype (model V2, 7th revision). Organisations and the five headquarters
// footprints come from the existing prototype's fictional data set; every other site, area, request and person here is
// invented, placed on the illustrative regional basemap. People are named by role only. The distance values, the
// footprint limit and the route are an EXAMPLE published configuration.
import type { Ring } from '../../../../frontend/src/lib/footprint';
import { centroid } from '../../../../frontend/src/lib/footprint';
import { ORGS, SITES } from '../data';
import { DAY, deriveRoute, type Area, type GeoProfile, type Person, type PolicyVersion, type Proposal, type Request, type RoutePolicy, type Site, type Stage, type Stationing, type World } from './domain';

export const NOW = Date.UTC(2026, 10, 10, 6, 0);

/**
 * Example published profiles — fictional values standing in for approved ones (docs §4.4); never in application logic.
 * Version 1 measured centre to centre and stays only for the requests pinned to it; version 2 measures the shortest
 * distance between the actual geometries (owner correction of 3 Nov 2026, §6).
 */
export const PROFILES: GeoProfile[] = [
  { version: 1, name: 'ملف سياسة وهمي للعرض', reference: 'مرجع وهمي 0/2026', publishedAt: NOW - 120 * DAY, measure: 'CENTROID', siteToPrimaryArea: { min: 5000, max: 8000 }, primaryAreaToAlternativeArea: { min: 3000, max: 5000 } },
  { version: 2, name: 'ملف سياسة وهمي للعرض', reference: 'مرجع وهمي 0/2026', publishedAt: NOW - DAY, measure: 'NEAREST_GEOMETRY', siteToPrimaryArea: { min: 5000, max: 8000 }, primaryAreaToAlternativeArea: { min: 3000, max: 5000 } },
];

/** Example route policy: the hierarchy above the requester, configured reviews by type, and the final scope by type. */
export const ROUTE: RoutePolicy = {
  version: 1,
  reference: 'مسار وهمي لطلبات إعادة التمركز 1/2026',
  hierarchy: { perm: 'APPROVE_HIERARCHY', dependsOn: ['SCOPE', 'CLASSIFICATION', 'DURATION', 'SITE'] },
  functional: [
    { key: 'site', name: 'دراسة الموقع والإتاحة', perm: 'REVIEW', dependsOn: ['SITE', 'AVAILABILITY'], types: ['PERMANENT', 'TEMPORARY'] },
    { key: 'scope', name: 'مراجعة النطاق الإداري', perm: 'REVIEW', dependsOn: ['SCOPE', 'DURATION'], types: ['PERMANENT'] },
  ],
  final: { PERMANENT: 'ROOT', TEMPORARY: 'TOP_LEVEL' },
};

/** The policies' first versions (set up before the rule update; the footprint limit in square metres). */
export const POLICIES: PolicyVersion[] = [
  { key: 'stationing_areas_requirement', version: 1, value: 'OPTIONAL', effectiveFrom: NOW - 90 * DAY, changedBy: 'p-sys', changedAt: NOW - 90 * DAY, reason: 'الإعداد الأولي للسياسة (وهمي)' },
  { key: 'max_restationing_footprint_area', version: 1, value: 60000, effectiveFrom: NOW - 90 * DAY, changedBy: 'p-sys', changedAt: NOW - 90 * DAY, reason: 'الإعداد الأولي للحد (وهمي)' },
];

const M_LAT = 1 / 111320;
const mLng = (lat: number) => 1 / (111320 * Math.cos((lat * Math.PI) / 180));
/** A simple irregular footprint of about w × h metres (deterministic). */
export function shape(lat: number, lng: number, w: number, h: number, n = 5): Ring {
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.4;
    const k = 0.82 + ((i * 37) % 17) / 60;
    out.push({ lat: lat + Math.sin(a) * (h / 2) * k * M_LAT, lng: lng + Math.cos(a) * (w / 2) * k * mLng(lat) });
  }
  return out;
}
/** A deployment-area polygon of the fixture data (hand-placed, checked against the example profile by a unit test). */
export const areaShape = (lat: number, lng: number, primary: boolean) => shape(lat, lng, primary ? 900 : 800, primary ? 700 : 620, 6);

const hq = (code: string, name?: string): Site => {
  const s = SITES.find((x) => x.code === code)!;
  return { id: 'site-' + code, name: name ?? s.name, ring: s.ring!, lat: s.lat, lng: s.lng, registered: true };
};
const site = (id: string, name: string, lat: number, lng: number, w: number, h: number, registered = true): Site => ({ id, name, ring: shape(lat, lng, w, h), lat, lng, registered });

export const PEOPLE: Person[] = [
  { id: 'p-req', name: 'مقدم الطلب', title: 'الحساب المحلي', account: 'req.local', human: 'H-REQ', perms: ['CREATE'], scope: ['o-root'] },
  { id: 'p-req-dir', name: 'مقدم الطلب', title: 'حساب الدليل — الإنسان نفسه', account: 'req.directory', human: 'H-REQ', perms: ['CREATE', 'ACTIVATE_STATIONING', 'DECIDE_EARLY_RETURN'], scope: ['o-root'] },
  { id: 'p-req-sv', name: 'مقدم طلب', title: 'وحدة الإشراف الهندسي (جهة فرعية)', account: 'req.sv', human: 'H-REQ-SV', perms: ['CREATE'], scope: ['o-pm-bld-sv'] },
  { id: 'p-req-mt', name: 'مقدم طلب', title: 'فريق صيانة الجنوب (جهة فرعية)', account: 'req.mt', human: 'H-REQ-MT', perms: ['CREATE'], scope: ['o-ss-mt-s'] },
  // the assigned approver of each organisation (the hierarchy's «ROLE|organisation» slots)
  { id: 'p-h-sv', name: 'معتمد الجهة', title: 'وحدة الإشراف الهندسي', account: 'head.sv', human: 'H-H-SV', perms: ['APPROVE_HIERARCHY'], scope: ['o-pm-bld-sv'] },
  { id: 'p-h-bld', name: 'معتمد الجهة', title: 'قسم مشاريع المباني', account: 'head.bld', human: 'H-H-BLD', perms: ['APPROVE_HIERARCHY'], scope: ['o-pm-bld'] },
  { id: 'p-h-pm', name: 'معتمد الجهة', title: 'إدارة المشاريع', account: 'head.pm', human: 'H-H-PM', perms: ['APPROVE_HIERARCHY'], scope: ['o-pm'] },
  { id: 'p-h-mt', name: 'معتمد الجهة', title: 'قسم الصيانة الإدارية', account: 'head.mt', human: 'H-H-MT', perms: ['APPROVE_HIERARCHY'], scope: ['o-ss-mt'] },
  { id: 'p-h-ss', name: 'معتمد الجهة', title: 'الخدمات المشتركة — يعتمد المؤقت نهائياً في نطاقها', account: 'head.ss', human: 'H-H-SS', perms: ['APPROVE_HIERARCHY', 'APPROVE'], scope: ['o-ss'] },
  { id: 'p-h-ga', name: 'معتمد الجهة', title: 'الإدارة العامة', account: 'head.ga', human: 'H-H-GA', perms: ['APPROVE_HIERARCHY'], scope: ['o-ga'] },
  { id: 'p-h-hr', name: 'معتمد الجهة', title: 'إدارة الموارد البشرية', account: 'head.hr', human: 'H-H-HR', perms: ['APPROVE_HIERARCHY'], scope: ['o-hr'] },
  { id: 'p-rev', name: 'مراجع المرافق', title: 'المراجعات المهيأة', account: 'rev', human: 'H-REV', perms: ['REVIEW'], scope: ['o-root'] },
  { id: 'p-apr', name: 'صاحب الاعتماد النهائي', title: 'يملك أيضاً صلاحية التفعيل', account: 'apr', human: 'H-APR', perms: ['APPROVE', 'ACTIVATE_STATIONING', 'ACTIVATE_TEMPORARY_EXTENSION'], scope: ['o-root'] },
  { id: 'p-apr-del', name: 'مفوَّض عن صاحب الاعتماد', title: 'تفويض نشط', account: 'apr.delegate', human: 'H-DEL', actingFor: 'p-apr', perms: ['ACTIVATE_STATIONING'], scope: ['o-root'] },
  { id: 'p-act', name: 'مسؤول التفعيل', title: 'مستقل', account: 'act', human: 'H-ACT', perms: ['ACTIVATE_STATIONING', 'ACTIVATE_TEMPORARY_EXTENSION'], scope: ['o-root'] },
  {
    id: 'p-dec',
    name: 'صاحب القرارات المستقلة',
    title: 'الإلغاء والعودة المبكرة',
    account: 'dec',
    human: 'H-DEC',
    perms: ['DECIDE_PRE_ACTIVATION_CANCELLATION', 'DECIDE_EARLY_RETURN', 'DECIDE_TEMPORARY_BEFORE_START_CANCELLATION'],
    scope: ['o-root'],
  },
  { id: 'p-avl', name: 'مسؤول الإتاحة', title: 'اعتماد استثناءات التداخل', account: 'avl', human: 'H-AVL', perms: ['APPROVE_AVAILABILITY_EXCEPTION'], scope: ['o-root'] },
  { id: 'p-other', name: 'مستخدم جهة أخرى', title: 'قسم التدريب', account: 'other', human: 'H-OTH', perms: ['CREATE'], scope: ['o-hr-trn'] },
  { id: 'p-sys', name: 'مسؤول النظام', title: 'سياسات التمركز الإدارية', account: 'sysadmin', human: 'H-SYS', perms: ['MANAGE_STATIONING_POLICY'], scope: ['o-root'] },
  { id: 'p-stn', name: 'مسؤول سجلات التمركز', title: 'تسجيل قرارات مناطق الانتشار', account: 'stationing', human: 'H-STN', perms: ['MANAGE_STATIONING'], scope: ['o-root'] },
  { id: 'p-wf', name: 'مسؤول مسارات الطلبات', title: 'تعديل المسار والمستلمين', account: 'workflow', human: 'H-WF', perms: ['MANAGE_REQUEST_ROUTING'], scope: ['o-root'] },
];

/** The deployment package drawn by the requester of MV-2026-0402 (inside the example profile's ranges, see the tests). */
const AREAS_0402 = { PRIMARY_AREA: [25.108, 55.385], ALTERNATIVE_AREA: [25.095, 55.43] } as const;
/** The temporary stationing of MV-2026-0408 has its own deployment package; it ends with that stationing. */
const AREAS_0408 = { PRIMARY_AREA: [25.105, 55.262], ALTERNATIVE_AREA: [25.085, 55.305] } as const;

export function baseWorld(): World {
  const sites: Site[] = [
    hq('C-05', 'المبنى المشترك'),
    hq('C-10'),
    hq('B-01'),
    hq('E-01'),
    hq('B-04'),
    hq('E-04'),
    hq('E-02'),
    hq('C-06'),
    // temporary sites in use (registered)
    site('t-ss-tr', 'موقع العمل المؤقت للحركة', 25.248, 55.333, 260, 200),
    site('t-ss-mt', 'موقع الصيانة المؤقت', 25.265, 55.299, 220, 180),
    site('t-it', 'موقع التقنية المؤقت', 25.151, 55.229, 240, 190),
    site('t-ga-adm', 'مكتب الشؤون الإدارية المؤقت', 25.236, 55.3545, 160, 140),
    site('t-hr-rec', 'مركز التوظيف المؤقت', 25.2505, 55.4095, 170, 150),
    // approved proposals registered by the facilities administrator before activation
    site('c-ga-fin', 'مكتب المالية الجديد', 25.156, 55.36, 180, 150),
    site('c-it-perm', 'مجمع التقنية الدائم المقترح', 25.233, 55.264, 260, 210),
  ];
  const S = (id: string) => sites.find((s) => s.id === id)!;
  const perm = (org: string, siteId: string, since: number): Stationing => ({ id: 'st-' + org, org, kind: 'PERMANENT', siteId, state: 'CURRENT', from: since });
  const stationings: Stationing[] = [
    ...['o-ss', 'o-ss-gen', 'o-ss-tr', 'o-ss-tr-fl', 'o-ss-mt', 'o-ss-mt-n', 'o-ss-mt-s'].map((o) => perm(o, 'site-C-05', NOW - 900 * DAY)),
    ...['o-ga', 'o-ga-fin'].map((o) => perm(o, 'site-C-10', NOW - 700 * DAY)),
    perm('o-ga-adm', 'site-E-04', NOW - 500 * DAY),
    ...['o-it', 'o-it-net', 'o-it-sup'].map((o) => perm(o, 'site-B-01', NOW - 800 * DAY)),
    perm('o-hr', 'site-E-01', NOW - 600 * DAY),
    perm('o-hr-rec', 'site-E-02', NOW - 600 * DAY),
    perm('o-hr-trn', 'site-C-06', NOW - 600 * DAY),
    ...['o-pm', 'o-pm-bld', 'o-pm-bld-sv', 'o-pm-bld-sv-n'].map((o) => perm(o, 'site-B-04', NOW - 650 * DAY)),
    perm('o-root', 'site-C-10', NOW - 1000 * DAY),
  ];
  // covered_organization_scope (A2): the shared-services stationing context covers these units, listed explicitly;
  // their own sub-units (e.g. the maintenance teams) are NOT covered just because they are descendants
  stationings.find((s) => s.id === 'st-o-ss')!.covered = ['o-ss', 'o-ss-gen', 'o-ss-mt'];
  const temp = (org: string, siteId: string, req: string, start: number, end: number, state: Stationing['state'] = 'ACTIVE'): Stationing => ({
    id: 'tmp-' + org,
    org,
    kind: 'TEMPORARY',
    baseId: 'st-' + org,
    siteId,
    state,
    from: start,
    plannedStart: start,
    plannedEnd: end,
    requestId: req,
  });
  stationings.push(
    temp('o-ss-tr', 't-ss-tr', 'r-ss-tr', NOW - 15 * DAY, NOW + 45 * DAY),
    temp('o-ss-tr-fl', 't-ss-tr', 'r-ss-tr', NOW - 15 * DAY, NOW + 45 * DAY),
    temp('o-ss-mt-n', 't-ss-mt', 'r-ss-mt', NOW - 4 * DAY, NOW + 26 * DAY),
    temp('o-it', 't-it', 'r-it-temp', NOW - 20 * DAY, NOW + 12 * DAY),
    temp('o-it-net', 't-it', 'r-it-temp', NOW - 20 * DAY, NOW + 12 * DAY),
    temp('o-it-sup', 't-it', 'r-it-temp', NOW - 20 * DAY, NOW + 12 * DAY),
    temp('o-ga-adm', 't-ga-adm', 'r-ga-adm', NOW - 10 * DAY, NOW + 50 * DAY),
    temp('o-hr-rec', 't-hr-rec', 'r-hr-rec', NOW + 5 * DAY, NOW + 65 * DAY, 'SCHEDULED'),
  );
  stationings.find((s) => s.id === 'tmp-o-it')!.covered = ['o-it', 'o-it-net', 'o-it-sup'];

  const areas: Area[] = [
    {
      id: 'ar-ss-p',
      stationingId: 'st-o-ss',
      org: 'o-ss',
      role: 'PRIMARY_AREA',
      status: 'ACTIVE',
      ring: shape(25.2165, 55.2925, 950, 720, 6),
      validFrom: NOW - 200 * DAY,
      provenance: { kind: 'IN_APP_REQUEST', request: 'MV-2026-0301' },
    },
    {
      id: 'ar-ss-a',
      stationingId: 'st-o-ss',
      org: 'o-ss',
      role: 'ALTERNATIVE_AREA',
      status: 'ACTIVE',
      ring: shape(25.1838, 55.3318, 820, 640, 6),
      validFrom: NOW - 120 * DAY,
      validTo: NOW + 240 * DAY,
      provenance: { kind: 'EXTERNAL_DECISION', authority: 'جهة اعتماد وهمية', reference: 'ق-وهمي/117', date: NOW - 120 * DAY, registeredBy: 'p-req-dir' },
    },
    { id: 'ar-it-p', stationingId: 'st-o-it', org: 'o-it', role: 'PRIMARY_AREA', status: 'ACTIVE', ring: shape(25.172, 55.2605, 800, 640, 6), validFrom: NOW - 300 * DAY, provenance: { kind: 'IN_APP_REQUEST', request: 'MV-2026-0288' } },
    { id: 'ar-it-a', stationingId: 'st-o-it', org: 'o-it', role: 'ALTERNATIVE_AREA', status: 'ACTIVE', ring: shape(25.198, 55.2505, 700, 560, 6), validFrom: NOW - 300 * DAY, provenance: { kind: 'IN_APP_REQUEST', request: 'MV-2026-0289' } },
    // the temporary stationing's own package (scenario 37: it ends with the temporary stationing, never moves to the original)
    { id: 'ar-0408-p', stationingId: 'tmp-o-it', org: 'o-it', role: 'PRIMARY_AREA', status: 'ACTIVE', ring: areaShape(AREAS_0408.PRIMARY_AREA[0], AREAS_0408.PRIMARY_AREA[1], true), validFrom: NOW - 20 * DAY, validTo: NOW + 12 * DAY, provenance: { kind: 'IN_APP_REQUEST', request: 'MV-2026-0408' } },
    { id: 'ar-0408-a', stationingId: 'tmp-o-it', org: 'o-it', role: 'ALTERNATIVE_AREA', status: 'ACTIVE', ring: areaShape(AREAS_0408.ALTERNATIVE_AREA[0], AREAS_0408.ALTERNATIVE_AREA[1], false), validFrom: NOW - 20 * DAY, validTo: NOW + 12 * DAY, provenance: { kind: 'IN_APP_REQUEST', request: 'MV-2026-0408' } },
  ];

  const orgParent = Object.fromEntries(ORGS.map((o) => [o.id, o.parentId]));
  const routeCtx = { orgParent, route: ROUTE };
  const proposal = (name: string, lat: number, lng: number, siteId: string | null = null, w = 230, h = 180): Proposal => ({ name, ring: siteId ? S(siteId).ring : shape(lat, lng, w, h), siteId });
  /** The derived route with its first `n` stages decided, by the people who hold each slot in this fictional world. */
  const decided = (org: string, type: 'PERMANENT' | 'TEMPORARY', n: number): Stage[] =>
    deriveRoute(routeCtx, org, type).map((s, i) =>
      i < n ? { ...s, mark: 'APPROVED' as const, by: s.kind === 'HIERARCHY' ? PEOPLE.find((p) => p.perms.includes('APPROVE_HIERARCHY') && p.scope.includes(s.org!))!.id : s.kind === 'FINAL' ? 'p-apr' : 'p-rev' } : s,
    );
  const req = (p: Partial<Request> & Pick<Request, 'id' | 'number' | 'org' | 'proposal' | 'state'>): Request => {
    const duration = p.duration ?? { type: 'PERMANENT' as const, start: NOW };
    const done = p.state === 'DRAFT' ? 0 : p.state === 'UNDER_REVIEW' ? 1 : 99;
    return {
      scope: { whole: true, units: [] },
      duration,
      fromSiteId: stationings.find((s) => s.org === p.org && s.kind === 'PERMANENT')!.siteId,
      requester: 'p-req',
      stages: p.state === 'DRAFT' ? [] : decided(p.org, duration.type, done),
      cursor: p.state === 'UNDER_REVIEW' ? 1 : 0,
      routeChanges: [],
      // submitted before the rule update under version 1 of both policies and of the profile
      ...(p.state === 'DRAFT'
        ? { createdUnder: { areas: 1, maxArea: 1 } }
        : { policy: { areas: { version: 1, value: 'OPTIONAL' as const }, maxArea: { version: 1, value: 60000 }, profile: 1, route: 1, pinnedAt: NOW - 40 * DAY } }),
      ...p,
    };
  };
  const pair = (x: { PRIMARY_AREA: readonly [number, number]; ALTERNATIVE_AREA: readonly [number, number] }) => ({
    PRIMARY_AREA: areaShape(x.PRIMARY_AREA[0], x.PRIMARY_AREA[1], true),
    ALTERNATIVE_AREA: areaShape(x.ALTERNATIVE_AREA[0], x.ALTERNATIVE_AREA[1], false),
  });

  const requests: Request[] = [
    // drafts opened in the request editor
    req({ id: 'r-pm-bld', number: 'MV-2026-0401', org: 'o-pm-bld', state: 'DRAFT', duration: { type: 'PERMANENT', start: NOW + 30 * DAY }, proposal: proposal('مبنى المشاريع الجنوبي المقترح', 25.13, 55.2605) }),
    req({
      id: 'r-hr-trn',
      number: 'MV-2026-0402',
      org: 'o-hr-trn',
      state: 'DRAFT',
      duration: { type: 'TEMPORARY', start: NOW + 10 * DAY, end: NOW + 100 * DAY },
      proposal: { ...proposal('قاعة التدريب المؤقتة المقترحة', 25.15, 55.34), areas: pair(AREAS_0402) },
    }),
    req({
      id: 'r-ss-mt-s',
      number: 'MV-2026-0403',
      org: 'o-ss-mt',
      state: 'DRAFT',
      scope: { whole: false, units: ['o-ss-mt-s'] },
      duration: { type: 'TEMPORARY', start: NOW + 7 * DAY, end: NOW + 67 * DAY },
      proposal: proposal('موقع صيانة الجنوب المؤقت المقترح', 25.15, 55.29),
    }),
    // child organisations' own drafts (scenarios 26, 27, 36): the route follows their hierarchy
    req({ id: 'r-pm-sv-n', number: 'MV-2026-0413', org: 'o-pm-bld-sv-n', requester: 'p-req-sv', state: 'DRAFT', duration: { type: 'PERMANENT', start: NOW + 45 * DAY }, proposal: proposal('مقر فريق مرافق الشمال المقترح', 25.236, 55.275) }),
    req({ id: 'r-mt-s-t', number: 'MV-2026-0414', org: 'o-ss-mt-s', requester: 'p-req-mt', state: 'DRAFT', duration: { type: 'TEMPORARY', start: NOW + 14 * DAY, end: NOW + 74 * DAY }, proposal: proposal('موقع عمل مؤقت لفريق الجنوب', 25.125, 55.25) }),
    // under review (scenario 6)
    req({ id: 'r-ga', number: 'MV-2026-0404', org: 'o-ga', state: 'UNDER_REVIEW', proposal: proposal('مجمع الإدارة العامة المقترح', 25.2605, 55.29) }),
    // at the final decision, every earlier stage approved (scenario 7: returned, then resubmitted with a new site)
    req({ id: 'r-ss-gen', number: 'MV-2026-0405', org: 'o-ss-gen', state: 'UNDER_REVIEW', stages: decided('o-ss-gen', 'PERMANENT', 3), cursor: 3, proposal: proposal('مبنى الخدمات العامة المقترح', 25.244, 55.35) }),
    // approved, not activated (scenarios 8, 15, 16, 39–41)
    req({ id: 'r-ga-fin', number: 'MV-2026-0406', org: 'o-ga-fin', state: 'APPROVED_NOT_ACTIVATED', finalApprover: 'p-apr', approvedSnapshot: ['st-o-ga-fin'], supersedes: [], proposal: proposal('مكتب المالية الجديد', 0, 0, 'c-ga-fin') }),
    // temporary activated, not started (scenario 9)
    req({
      id: 'r-hr-rec',
      number: 'MV-2026-0407',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0407' },
      org: 'o-hr-rec',
      state: 'TEMPORARY_SCHEDULED',
      duration: { type: 'TEMPORARY', start: NOW + 5 * DAY, end: NOW + 65 * DAY },
      finalApprover: 'p-apr',
      proposal: proposal('مركز التوظيف المؤقت', 0, 0, 't-hr-rec'),
    }),
    // temporary active, with an approved extension not activated (scenarios 10, 11, 37, 38)
    req({
      id: 'r-it-temp',
      number: 'MV-2026-0408',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0408' },
      org: 'o-it',
      state: 'ACTIVE_TEMPORARY',
      duration: { type: 'TEMPORARY', start: NOW - 20 * DAY, end: NOW + 12 * DAY },
      finalApprover: 'p-apr',
      proposal: { ...proposal('موقع التقنية المؤقت', 0, 0, 't-it'), areas: pair(AREAS_0408) },
    }),
    // permanent relocation approved while the temporary one is active (scenarios 13, 14)
    req({
      id: 'r-it-perm',
      number: 'MV-2026-0409',
      org: 'o-it',
      state: 'APPROVED_NOT_ACTIVATED',
      finalApprover: 'p-apr',
      approvedSnapshot: ['st-o-it', 'st-o-it-net', 'st-o-it-sup'],
      supersedes: ['tmp-o-it', 'tmp-o-it-net', 'tmp-o-it-sup'],
      proposal: proposal('مجمع التقنية الدائم المقترح', 0, 0, 'c-it-perm'),
    }),
    // temporary active with an early-return request (scenario 12)
    req({
      id: 'r-ga-adm',
      number: 'MV-2026-0410',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0410' },
      org: 'o-ga-adm',
      state: 'ACTIVE_TEMPORARY',
      duration: { type: 'TEMPORARY', start: NOW - 10 * DAY, end: NOW + 50 * DAY },
      finalApprover: 'p-apr',
      proposal: proposal('مكتب الشؤون الإدارية المؤقت', 0, 0, 't-ga-adm'),
    }),
    // partial temporary relocations of a parent's units (scenario 18)
    req({
      id: 'r-ss-tr',
      number: 'MV-2026-0411',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0411' },
      org: 'o-ss',
      state: 'ACTIVE_TEMPORARY',
      scope: { whole: false, units: ['o-ss-tr', 'o-ss-tr-fl'] },
      duration: { type: 'TEMPORARY', start: NOW - 15 * DAY, end: NOW + 45 * DAY },
      finalApprover: 'p-apr',
      proposal: proposal('موقع العمل المؤقت للحركة', 0, 0, 't-ss-tr'),
    }),
    req({
      id: 'r-ss-mt',
      number: 'MV-2026-0412',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0412' },
      org: 'o-ss',
      state: 'ACTIVE_TEMPORARY',
      scope: { whole: false, units: ['o-ss-mt-n'] },
      duration: { type: 'TEMPORARY', start: NOW - 4 * DAY, end: NOW + 26 * DAY },
      finalApprover: 'p-apr',
      proposal: proposal('موقع الصيانة المؤقت', 0, 0, 't-ss-mt'),
    }),
  ];
  for (const r of requests) if (r.state !== 'DRAFT') r.submitted = structuredClone({ scope: r.scope, duration: r.duration, proposal: r.proposal });

  const events: World['events'] = [];
  for (const r of requests) {
    if (r.state === 'DRAFT') continue;
    events.push({ at: NOW - 40 * DAY, actor: r.requester, type: 'REQUEST_SUBMITTED', ref: r.number, detail: 'مسار من ' + r.stages.length + ' مراحل مشتق من الهيكل ومسار الطلب' });
    for (const s of r.stages.filter((x) => x.mark === 'APPROVED')) events.push({ at: NOW - 30 * DAY, actor: s.by!, type: s.final ? 'REQUEST_APPROVED' : 'STAGE_APPROVED', ref: r.number, detail: s.name });
  }

  return {
    now: NOW,
    orgParent,
    people: PEOPLE,
    sites,
    stationings,
    areas,
    requests,
    extensions: [{ id: 'ext-it', number: 'MV-2026-0408-EXT1', parent: 'r-it-temp', newEnd: NOW + 42 * DAY, state: 'EXTENSION_APPROVED_NOT_ACTIVATED', requester: 'p-req', finalApprover: 'p-apr' }],
    earlyReturns: [{ id: 'er-ga-adm', request: 'r-ga-adm', state: 'REQUESTED', by: 'p-req', reason: 'انتهت أعمال التجهيز في المقر الدائم مبكراً', originalEnd: NOW + 50 * DAY }],
    startCancellations: [],
    // administrative reservations inside / across the shared-services primary deployment area (scenarios 20–22)
    reservations: [
      { id: 'rs-covered', number: 'RS-2026-0501', org: 'o-ss-gen', name: 'قاعة خدمات مؤقتة', ring: shape(25.2174, 55.2912, 170, 120), from: NOW + 3 * DAY, to: NOW + 20 * DAY, state: 'PROPOSED', requester: 'p-req' },
      { id: 'rs-uncovered', number: 'RS-2026-0502', org: 'o-ss-mt-s', name: 'ورشة صيانة مؤقتة', ring: shape(25.2152, 55.2938, 170, 120), from: NOW + 3 * DAY, to: NOW + 20 * DAY, state: 'PROPOSED', requester: 'p-req' },
      { id: 'rs-outside', number: 'RS-2026-0503', org: 'o-hr-trn', name: 'ساحة تدريب مؤقتة', ring: shape(25.2161, 55.2962, 220, 150), from: NOW + 5 * DAY, to: NOW + 30 * DAY, state: 'PROPOSED', requester: 'p-other' },
    ],
    reminderOffsets: [14 * DAY, 2 * DAY],
    profiles: PROFILES,
    policies: POLICIES,
    route: ROUTE,
    events,
  };
}

export const siteCenter = (s: Site) => centroid(s.ring);
