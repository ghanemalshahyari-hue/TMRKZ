// Fictional data for the stationing domain prototype (model V2). Organisations and the five headquarters footprints come
// from the existing prototype's fictional data set; every other site, area, request and person here is invented, placed on
// the illustrative regional basemap. People are named by role only. The distance values are an EXAMPLE policy profile.
import type { Ring } from '../../../../frontend/src/lib/footprint';
import { centroid } from '../../../../frontend/src/lib/footprint';
import { ORGS, SITES } from '../data';
import { DAY, type Area, type Candidate, type Person, type Request, type Site, type Stage, type Stationing, type World } from './domain';

export const NOW = Date.UTC(2026, 10, 10, 6, 0);

/** Example policy profile — fictional values standing in for an approved profile (docs §4.4); never in application logic. */
export const PROFILE = {
  name: 'ملف سياسة وهمي للعرض',
  reference: 'مرجع وهمي 0/2026',
  currentToPrimary: { min: 5000, max: 8000 },
  primaryToAlternative: { min: 3000, max: 5000 },
};

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

const hq = (code: string, name?: string): Site => {
  const s = SITES.find((x) => x.code === code)!;
  return { id: 'site-' + code, name: name ?? s.name, ring: s.ring!, lat: s.lat, lng: s.lng, registered: true };
};
const site = (id: string, name: string, lat: number, lng: number, w: number, h: number, registered = true): Site => ({ id, name, ring: shape(lat, lng, w, h), lat, lng, registered });

export const PEOPLE: Person[] = [
  { id: 'p-req', name: 'مقدم الطلب', title: 'الحساب المحلي', account: 'req.local', human: 'H-REQ', perms: ['CREATE'], scope: ['o-root'] },
  { id: 'p-req-dir', name: 'مقدم الطلب', title: 'حساب الدليل — الإنسان نفسه', account: 'req.directory', human: 'H-REQ', perms: ['CREATE', 'ACTIVATE_STATIONING', 'DECIDE_EARLY_RETURN'], scope: ['o-root'] },
  { id: 'p-rev', name: 'مراجع المرافق', title: 'مراحل الدراسة', account: 'rev', human: 'H-REV', perms: ['REVIEW'], scope: ['o-root'] },
  { id: 'p-apr', name: 'صاحب الاعتماد النهائي', title: 'يملك أيضاً صلاحية التفعيل', account: 'apr', human: 'H-APR', perms: ['APPROVE', 'ACTIVATE_STATIONING', 'ACTIVATE_TEMPORARY_EXTENSION'], scope: ['o-root'] },
  { id: 'p-apr-del', name: 'مفوَّض عن صاحب الاعتماد', title: 'تفويض نشط', account: 'apr.delegate', human: 'H-DEL', actingFor: 'p-apr', perms: ['ACTIVATE_STATIONING'], scope: ['o-root'] },
  { id: 'p-act', name: 'مسؤول التفعيل', title: 'مستقل', account: 'act', human: 'H-ACT', perms: ['ACTIVATE_STATIONING', 'ACTIVATE_TEMPORARY_EXTENSION'], scope: ['o-root'] },
  {
    id: 'p-dec',
    name: 'صاحب القرارات المستقلة',
    title: 'الإلغاء والعودة المبكرة وتبديل المرشح',
    account: 'dec',
    human: 'H-DEC',
    perms: ['DECIDE_PRE_ACTIVATION_CANCELLATION', 'DECIDE_EARLY_RETURN', 'SWITCH_RELOCATION_CANDIDATE', 'DECIDE_TEMPORARY_BEFORE_START_CANCELLATION'],
    scope: ['o-root'],
  },
  { id: 'p-avl', name: 'مسؤول الإتاحة', title: 'اعتماد استثناءات التداخل', account: 'avl', human: 'H-AVL', perms: ['APPROVE_AVAILABILITY_EXCEPTION'], scope: ['o-root'] },
  { id: 'p-other', name: 'مستخدم جهة أخرى', title: 'قسم التدريب', account: 'other', human: 'H-OTH', perms: ['CREATE'], scope: ['o-hr-trn'] },
];

export const stagesTemplate = (): Stage[] => [
  { key: 'org', name: 'موافقة الجهة', perm: 'REVIEW', dependsOn: ['SCOPE', 'CLASSIFICATION'] },
  { key: 'site', name: 'دراسة الموقع والإتاحة', perm: 'REVIEW', dependsOn: ['CANDIDATE', 'AVAILABILITY'] },
  { key: 'scope', name: 'مراجعة النطاق الإداري', perm: 'REVIEW', dependsOn: ['SCOPE', 'DURATION'] },
  { key: 'final', name: 'القرار النهائي', perm: 'APPROVE', final: true, dependsOn: ['SCOPE', 'CLASSIFICATION', 'DURATION', 'CANDIDATE', 'AVAILABILITY'] },
];
/** The anchor of the alternative review (D2): the first stage whose decision depends on the candidate. */
export const ANCHOR = 'site';

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
    // approved candidates registered by the facilities administrator before activation
    site('c-ga-fin-alt', 'مكتب المالية المقترح البديل', 25.156, 55.36, 180, 150),
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
  ];

  const cand = (role: Candidate['role'], name: string, lat: number, lng: number, status: Candidate['status'], siteId: string | null = null, w = 230, h = 180): Candidate => ({
    role,
    name,
    ring: siteId ? S(siteId).ring : shape(lat, lng, w, h),
    siteId,
    status,
  });
  const marks = (...m: (Stage['mark'] | undefined)[]) =>
    stagesTemplate().map((s, i) => (m[i] ? { ...s, mark: m[i], by: s.final ? 'p-apr' : 'p-rev', candidate: s.dependsOn.includes('CANDIDATE') ? ('PRIMARY' as const) : undefined } : s));
  const req = (p: Partial<Request> & Pick<Request, 'id' | 'number' | 'org' | 'candidates' | 'state'>): Request => ({
    scope: { whole: true, units: [] },
    duration: { type: 'PERMANENT', start: NOW },
    fromSiteId: stationings.find((s) => s.org === p.org && s.kind === 'PERMANENT')!.siteId,
    active: 'PRIMARY',
    requester: 'p-req',
    stages: stagesTemplate(),
    cursor: 0,
    ...p,
  });

  const requests: Request[] = [
    // drafts opened in the request editor (scenarios 3–5)
    req({
      id: 'r-pm-bld',
      number: 'MV-2026-0401',
      org: 'o-pm-bld',
      state: 'DRAFT',
      duration: { type: 'PERMANENT', start: NOW + 30 * DAY },
      candidates: { PRIMARY: cand('PRIMARY', 'مبنى المشاريع الجنوبي المقترح', 25.13, 55.2605, 'PROPOSED'), ALTERNATIVE: cand('ALTERNATIVE', 'مكتب المشاريع البديل المقترح', 25.112, 55.2355, 'PROPOSED') },
    }),
    req({
      id: 'r-hr-trn',
      number: 'MV-2026-0402',
      org: 'o-hr-trn',
      state: 'DRAFT',
      duration: { type: 'TEMPORARY', start: NOW + 10 * DAY, end: NOW + 100 * DAY },
      candidates: { PRIMARY: cand('PRIMARY', 'قاعة التدريب المؤقتة المقترحة', 25.15, 55.34, 'PROPOSED'), ALTERNATIVE: cand('ALTERNATIVE', 'مركز التدريب البديل المقترح', 25.131, 55.3655, 'PROPOSED') },
    }),
    req({
      id: 'r-ss-mt-s',
      number: 'MV-2026-0403',
      org: 'o-ss-mt',
      state: 'DRAFT',
      scope: { whole: false, units: ['o-ss-mt-s'] },
      duration: { type: 'TEMPORARY', start: NOW + 7 * DAY, end: NOW + 67 * DAY },
      candidates: { PRIMARY: cand('PRIMARY', 'موقع صيانة الجنوب المؤقت المقترح', 25.15, 55.29, 'PROPOSED'), ALTERNATIVE: cand('ALTERNATIVE', 'موقع صيانة بديل مقترح', 25.126, 55.2655, 'PROPOSED') },
    }),
    // under review (scenario 6)
    req({
      id: 'r-ga',
      number: 'MV-2026-0404',
      org: 'o-ga',
      state: 'UNDER_REVIEW_PRIMARY',
      cursor: 1,
      stages: marks('APPROVED'),
      candidates: { PRIMARY: cand('PRIMARY', 'مجمع الإدارة العامة المقترح', 25.2605, 55.29, 'UNDER_REVIEW'), ALTERNATIVE: cand('ALTERNATIVE', 'مبنى إداري بديل مقترح', 25.2848, 55.3148, 'STANDBY') },
    }),
    // primary not accepted at the final decision (scenario 7)
    req({
      id: 'r-ss-gen',
      number: 'MV-2026-0405',
      org: 'o-ss-gen',
      state: 'PRIMARY_NOT_ACCEPTED',
      cursor: 3,
      stages: marks('APPROVED', 'APPROVED', 'APPROVED'),
      candidates: {
        PRIMARY: { ...cand('PRIMARY', 'مبنى الخدمات العامة المقترح', 25.244, 55.35, 'NOT_ACCEPTED'), reason: 'تعارض مع أعمال صيانة مقررة في الموقع خلال الفترة' },
        ALTERNATIVE: cand('ALTERNATIVE', 'مبنى خدمات بديل مقترح', 25.26, 55.382, 'STANDBY'),
      },
    }),
    // approved, not activated: the alternative was approved after the primary was not accepted (scenarios 8, 15, 16)
    req({
      id: 'r-ga-fin',
      number: 'MV-2026-0406',
      org: 'o-ga-fin',
      state: 'APPROVED_NOT_ACTIVATED',
      active: 'ALTERNATIVE',
      cursor: 3,
      finalApprover: 'p-apr',
      approvedSnapshot: ['st-o-ga-fin'],
      supersedes: [],
      stages: stagesTemplate().map((s) => ({ ...s, mark: s.key === 'scope' ? ('CARRIED' as const) : ('APPROVED' as const), by: s.final ? 'p-apr' : 'p-rev', candidate: s.dependsOn.includes('CANDIDATE') ? ('ALTERNATIVE' as const) : undefined })),
      candidates: {
        PRIMARY: { ...cand('PRIMARY', 'مكتب المالية المقترح', 25.17, 55.33, 'NOT_ACCEPTED'), reason: 'الموقع لا يستوعب أرشيف القسم' },
        ALTERNATIVE: cand('ALTERNATIVE', 'مكتب المالية المقترح البديل', 0, 0, 'APPROVED', 'c-ga-fin-alt'),
      },
    }),
    // temporary activated, not started (scenario 9)
    req({
      id: 'r-hr-rec',
      number: 'MV-2026-0407',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0407' },
      org: 'o-hr-rec',
      state: 'TEMPORARY_SCHEDULED',
      duration: { type: 'TEMPORARY', start: NOW + 5 * DAY, end: NOW + 65 * DAY },
      cursor: 3,
      finalApprover: 'p-apr',
      stages: marks('APPROVED', 'APPROVED', 'APPROVED', 'APPROVED'),
      candidates: { PRIMARY: cand('PRIMARY', 'مركز التوظيف المؤقت', 0, 0, 'APPROVED', 't-hr-rec'), ALTERNATIVE: cand('ALTERNATIVE', 'قاعة توظيف بديلة', 25.268, 55.442, 'STANDBY') },
    }),
    // temporary active, with an approved extension not activated (scenarios 10, 11)
    req({
      id: 'r-it-temp',
      number: 'MV-2026-0408',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0408' },
      org: 'o-it',
      state: 'ACTIVE_TEMPORARY',
      duration: { type: 'TEMPORARY', start: NOW - 20 * DAY, end: NOW + 12 * DAY },
      cursor: 3,
      finalApprover: 'p-apr',
      stages: marks('APPROVED', 'APPROVED', 'APPROVED', 'APPROVED'),
      candidates: { PRIMARY: cand('PRIMARY', 'موقع التقنية المؤقت', 0, 0, 'APPROVED', 't-it'), ALTERNATIVE: cand('ALTERNATIVE', 'موقع تقنية بديل', 25.13, 55.205, 'STANDBY') },
    }),
    // permanent relocation approved while the temporary one is active (scenarios 13, 14)
    req({
      id: 'r-it-perm',
      number: 'MV-2026-0409',
      org: 'o-it',
      state: 'APPROVED_NOT_ACTIVATED',
      cursor: 3,
      finalApprover: 'p-apr',
      approvedSnapshot: ['st-o-it', 'st-o-it-net', 'st-o-it-sup'],
      supersedes: ['tmp-o-it', 'tmp-o-it-net', 'tmp-o-it-sup'],
      stages: marks('APPROVED', 'APPROVED', 'APPROVED', 'APPROVED'),
      candidates: { PRIMARY: cand('PRIMARY', 'مجمع التقنية الدائم المقترح', 0, 0, 'APPROVED', 'c-it-perm'), ALTERNATIVE: cand('ALTERNATIVE', 'مجمع تقنية بديل', 25.262, 55.236, 'STANDBY') },
    }),
    // temporary active with an early-return request (scenario 12)
    req({
      id: 'r-ga-adm',
      number: 'MV-2026-0410',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0410' },
      org: 'o-ga-adm',
      state: 'ACTIVE_TEMPORARY',
      duration: { type: 'TEMPORARY', start: NOW - 10 * DAY, end: NOW + 50 * DAY },
      cursor: 3,
      finalApprover: 'p-apr',
      stages: marks('APPROVED', 'APPROVED', 'APPROVED', 'APPROVED'),
      candidates: { PRIMARY: cand('PRIMARY', 'مكتب الشؤون الإدارية المؤقت', 0, 0, 'APPROVED', 't-ga-adm'), ALTERNATIVE: cand('ALTERNATIVE', 'مكتب إداري بديل', 25.25, 55.33, 'STANDBY') },
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
      cursor: 3,
      finalApprover: 'p-apr',
      stages: marks('APPROVED', 'APPROVED', 'APPROVED', 'APPROVED'),
      candidates: { PRIMARY: cand('PRIMARY', 'موقع العمل المؤقت للحركة', 0, 0, 'APPROVED', 't-ss-tr'), ALTERNATIVE: cand('ALTERNATIVE', 'موقع حركة بديل', 25.27, 55.36, 'STANDBY') },
    }),
    req({
      id: 'r-ss-mt',
      number: 'MV-2026-0412',
      activation: { by: 'p-act', at: NOW - 21 * DAY, ref: 'ACT-MV-2026-0412' },
      org: 'o-ss',
      state: 'ACTIVE_TEMPORARY',
      scope: { whole: false, units: ['o-ss-mt-n'] },
      duration: { type: 'TEMPORARY', start: NOW - 4 * DAY, end: NOW + 26 * DAY },
      cursor: 3,
      finalApprover: 'p-apr',
      stages: marks('APPROVED', 'APPROVED', 'APPROVED', 'APPROVED'),
      candidates: { PRIMARY: cand('PRIMARY', 'موقع الصيانة المؤقت', 0, 0, 'APPROVED', 't-ss-mt'), ALTERNATIVE: cand('ALTERNATIVE', 'موقع صيانة بديل', 25.29, 55.31, 'STANDBY') },
    }),
  ];

  const events: World['events'] = [];
  for (const r of requests) {
    if (r.state === 'DRAFT') continue;
    events.push({ at: NOW - 40 * DAY, actor: r.requester, type: 'REQUEST_SUBMITTED', ref: r.number, detail: 'المرشح النشط: الرئيسي' });
    for (const s of r.stages.filter((x) => x.mark === 'APPROVED')) events.push({ at: NOW - 30 * DAY, actor: s.by!, type: s.final ? 'REQUEST_APPROVED' : 'STAGE_APPROVED', ref: r.number, detail: s.name });
  }
  events.push({ at: NOW - 33 * DAY, actor: 'p-rev', type: 'RELOCATION_CANDIDATE_NOT_ACCEPTED', ref: 'MV-2026-0406', detail: 'الرئيسي — الموقع لا يستوعب أرشيف القسم' });
  events.push({ at: NOW - 32 * DAY, actor: 'p-dec', type: 'RELOCATION_ACTIVE_CANDIDATE_CHANGED', ref: 'MV-2026-0406', detail: 'الرئيسي ← البديل · السبب: البديل يجتاز التحقق · استئناف من «دراسة الموقع والإتاحة» · حُمل: 1' });

  return {
    now: NOW,
    orgParent: Object.fromEntries(ORGS.map((o) => [o.id, o.parentId])),
    people: PEOPLE,
    sites,
    stationings,
    areas,
    requests,
    extensions: [{ id: 'ext-it', number: 'MV-2026-0408-EXT1', parent: 'r-it-temp', newEnd: NOW + 42 * DAY, state: 'EXTENSION_APPROVED_NOT_ACTIVATED', requester: 'p-req', finalApprover: 'p-apr' }],
    earlyReturns: [{ id: 'er-ga-adm', request: 'r-ga-adm', state: 'REQUESTED', by: 'p-req', reason: 'انتهت أعمال التجهيز في المقر الدائم مبكراً', originalEnd: NOW + 50 * DAY }],
    startCancellations: [],
    // administrative reservations inside / across the shared-services primary area (scenarios 20–22)
    reservations: [
      { id: 'rs-covered', number: 'RS-2026-0501', org: 'o-ss-gen', name: 'قاعة خدمات مؤقتة', ring: shape(25.2174, 55.2912, 170, 120), from: NOW + 3 * DAY, to: NOW + 20 * DAY, state: 'PROPOSED', requester: 'p-req' },
      { id: 'rs-uncovered', number: 'RS-2026-0502', org: 'o-ss-mt-s', name: 'ورشة صيانة مؤقتة', ring: shape(25.2152, 55.2938, 170, 120), from: NOW + 3 * DAY, to: NOW + 20 * DAY, state: 'PROPOSED', requester: 'p-req' },
      { id: 'rs-outside', number: 'RS-2026-0503', org: 'o-hr-trn', name: 'ساحة تدريب مؤقتة', ring: shape(25.2161, 55.2962, 220, 150), from: NOW + 5 * DAY, to: NOW + 30 * DAY, state: 'PROPOSED', requester: 'p-other' },
    ],
    reminderOffsets: [14 * DAY, 2 * DAY],
    events,
  };
}

export const siteCenter = (s: Site) => centroid(s.ring);
