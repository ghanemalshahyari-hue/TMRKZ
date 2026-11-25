/**
 * «طلب مناطق انتشار» (owner brief «إعادة تنظيم التمركز والمواقع ومناطق الانتشار» §4, phase 3): a request for one unit that
 * already has an approved stationing. It starts from that unit's current site (never another starting point), places the
 * main deployment area, then the sub-area, and is reviewed and sent; the unit's site does not change. Distances follow the
 * stationing policy in force: the main area is measured from the current site's centre, the sub-area from the main area's
 * (the server measures again, with the terrain, when the request is checked).
 */
import { formatArea } from './footprint';

export const AREA_STEPS = ['الموقع', 'الرئيسية', 'الفرعية', 'مراجعة وإرسال'] as const;
export type AreaStep = 1 | 2 | 3 | 4;
export type AreaRole = 'primary' | 'alternative';

/** The interface's names (the brief: «الفرعية», never «البديلة»; ALTERNATIVE stays the internal name). */
export const AREA_NAME: Record<AreaRole, string> = { primary: 'منطقة الانتشار الرئيسية', alternative: 'منطقة الانتشار الفرعية' };
/** Where each area is measured from, in words. */
export const MEASURED_FROM: Record<AreaRole, string> = { primary: 'من مركز الموقع الحالي', alternative: 'من مركز منطقة الانتشار الرئيسية' };

type UnitLike = { id: string; name: string; state: string; site: { id: string; name: string } | null };
export type UnitChoice<U extends UnitLike> = { unit: U; eligible: boolean; note: string };

/** Whether each of the person's units may have this request now, and why (the hub's own state; the server decides again). */
export function unitChoices<U extends UnitLike>(units: readonly U[]): UnitChoice<U>[] {
  return units.map((unit) => {
    if (!unit.site || unit.state === 'NO_STATIONING') return { unit, eligible: false, note: 'لا تمركز معتمد لها: يُسجَّل تمركزها المبدئي في «تحديد مواقع التمركز المبدئية».' };
    if (unit.state === 'DEPLOYMENT_REQUEST_PENDING') return { unit, eligible: false, note: 'لها طلب مناطق انتشار جارٍ.' };
    if (unit.state === 'NOT_AUTHORISED') return { unit, eligible: false, note: 'لا تملك تقديم طلباتها.' };
    if (unit.state === 'DEPLOYMENT_COMPLETE') return { unit, eligible: true, note: 'لها منطقتا انتشار: يعدّلهما هذا الطلب.' };
    return { unit, eligible: true, note: 'متمركزة بلا مناطق انتشار.' };
  });
}

/** A registered site as the list knows it (the request hub's site plus its place in the site tree). */
export type SiteRef = { siteId: string; name: string; code?: string | null; parentId: string | null };
export type CampNode<U extends UnitLike> = { site: SiteRef; units: UnitChoice<U>[]; children: CampNode<U>[] };

/**
 * The person's units by camp (owner, 17 Nov 2026: "based on the camp name … in hierarchy view"): each camp where one of them
 * is stationed, under its main camp when that is a camp too (the main camp shown even without units of its own, so the
 * chain stays whole), its units ordered by the organisation's depth. Units the person may not ask for are left out; units
 * stationed nowhere are returned apart, to be folded away.
 */
export function campTree<U extends UnitLike & { depth?: number }>(choices: readonly UnitChoice<U>[], sites: readonly SiteRef[]): { camps: CampNode<U>[]; unstationed: UnitChoice<U>[] } {
  const known = new Map(sites.map((s) => [s.siteId, s]));
  const bySite = new Map<string, UnitChoice<U>[]>();
  const unstationed: UnitChoice<U>[] = [];
  for (const c of choices) {
    if (c.unit.state === 'NOT_AUTHORISED') continue;
    if (!c.unit.site) {
      unstationed.push(c);
      continue;
    }
    const id = c.unit.site.id;
    if (!known.has(id)) known.set(id, { siteId: id, name: c.unit.site.name, code: null, parentId: null });
    bySite.set(id, [...(bySite.get(id) ?? []), c]);
  }
  // the camps with units, and every camp above them
  const shown = new Set<string>();
  for (const id of bySite.keys()) {
    let at: string | null = id;
    while (at && known.has(at) && !shown.has(at)) {
      shown.add(at);
      at = known.get(at)!.parentId;
    }
  }
  const nodes = new Map<string, CampNode<U>>();
  for (const id of shown) {
    const units = [...(bySite.get(id) ?? [])].sort((a, b) => (a.unit.depth ?? 0) - (b.unit.depth ?? 0) || a.unit.name.localeCompare(b.unit.name, 'ar'));
    nodes.set(id, { site: known.get(id)!, units, children: [] });
  }
  const camps: CampNode<U>[] = [];
  for (const n of nodes.values()) {
    const parent = n.site.parentId ? nodes.get(n.site.parentId) : undefined;
    (parent ? parent.children : camps).push(n);
  }
  const byName = (a: CampNode<U>, b: CampNode<U>) => a.site.name.localeCompare(b.site.name, 'ar');
  const sortAll = (l: CampNode<U>[]) => (l.sort(byName), l.forEach((n) => sortAll(n.children)));
  sortAll(camps);
  return { camps, unstationed };
}

export type UnitNode<U extends UnitLike> = { choice: UnitChoice<U>; children: UnitNode<U>[] };

/** Units as their organisation's tree: each under its parent when the parent is listed too, in the order given. */
export function unitForest<U extends UnitLike & { parentId?: string | null }>(choices: readonly UnitChoice<U>[]): UnitNode<U>[] {
  const nodes = new Map(choices.map((c) => [c.unit.id, { choice: c, children: [] as UnitNode<U>[] }]));
  const roots: UnitNode<U>[] = [];
  for (const c of choices) {
    const n = nodes.get(c.unit.id)!;
    const p = c.unit.parentId ? nodes.get(c.unit.parentId) : undefined;
    if (p && p !== n) p.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/**
 * The first step to open: always the first, with nothing chosen (owner, 25 Nov 2026: the page must not choose the location and
 * move to the next step by itself — even when only one unit may have the request, the person chooses it and presses «التالي»).
 */
export function startStep(_choices: readonly UnitChoice<UnitLike>[]): { step: AreaStep; unitId: string | null } {
  return { step: 1, unitId: null };
}

export type AreaState = { unitId: string | null; primary: unknown | null; alternative: unknown | null };

/** What stops moving to a step («التالي» or a click on the strip); empty when nothing does. */
export function areaStepProblem(s: AreaState, to: AreaStep): string {
  if (to >= 2 && !s.unitId) return 'اختر الوحدة أولاً: يبدأ الطلب من موقعها الحالي.';
  if (to >= 3 && !s.primary) return 'ضع منطقة الانتشار الرئيسية أولاً: منها تُقاس الفرعية.';
  if (to >= 4 && !s.alternative) return 'ضع منطقة الانتشار الفرعية أولاً.';
  return '';
}

// ---- «طلب إعادة تمركز», the simplified map-first flow (owner brief §5, phase 4) -----------------------------------------

/** The re-stationing's progress: the units, then the new site, the main and sub-areas, the review (brief §5). */
export const RESTATION_STEPS = ['الوحدات', 'الموقع الجديد', 'الرئيسية', 'الفرعية', 'مراجعة وإرسال'] as const;
export type FlowPurpose = 'DEPLOYMENT_AREAS' | 'RESTATIONING';
export type FlowStage = 'pick' | 'site' | 'primary' | 'alternative' | 'review';
/** Each request's stages in order (the step strip's numbers are their positions, from 1). */
export const FLOW_STAGES: Record<FlowPurpose, readonly FlowStage[]> = {
  DEPLOYMENT_AREAS: ['pick', 'primary', 'alternative', 'review'],
  RESTATIONING: ['pick', 'site', 'primary', 'alternative', 'review'],
};
export const FLOW_STEPS: Record<FlowPurpose, readonly string[]> = { DEPLOYMENT_AREAS: AREA_STEPS, RESTATIONING: RESTATION_STEPS };

/** Where each area is measured from: the main area from the new site in a re-stationing, from the current site otherwise. */
export const measuredFrom = (purpose: FlowPurpose, r: AreaRole) => (purpose === 'RESTATIONING' && r === 'primary' ? 'من مركز الموقع الجديد' : MEASURED_FROM[r]);

type HubLike = UnitLike & { parentId?: string | null; actions?: readonly { action: string; allowed: boolean; reason: string | null }[] };

/** Which of the person's units may move in a re-stationing (the hub's «RESTATIONING» action; the server decides again). */
export function restationingChoices<U extends HubLike>(units: readonly U[]): UnitChoice<U>[] {
  return units.map((unit) => {
    if (unit.state === 'NOT_AUTHORISED') return { unit, eligible: false, note: 'لا تملك تقديم طلباتها.' };
    if (!unit.site || unit.state === 'NO_STATIONING') return { unit, eligible: false, note: 'لا تمركز معتمد لها: يُسجَّل تمركزها المبدئي في «تحديد مواقع التمركز المبدئية».' };
    const a = unit.actions?.find((x) => x.action === 'RESTATIONING');
    if (a && !a.allowed) return { unit, eligible: false, note: a.reason ?? 'لا يُطلب لها الآن.' };
    return { unit, eligible: true, note: 'متمركزة في «' + unit.site.name + '».' };
  });
}

/**
 * The unit that asks for the move (the server's rule: every moving unit is in its branch): the nearest unit, among the
 * chosen ones and those above them in the person's list, that every chosen unit is under — null when there is none.
 */
export function requestingUnitOf<U extends HubLike>(picked: readonly string[], units: readonly U[]): U | null {
  if (picked.length === 0) return null;
  const byId = new Map(units.map((u) => [u.id, u]));
  const chain = (id: string) => {
    const out: string[] = [];
    for (let at: string | null | undefined = id; at && byId.has(at) && !out.includes(at); at = byId.get(at)!.parentId) out.push(at);
    return out;
  };
  const others = picked.map(chain);
  for (const a of others[0]) {
    if (others.every((c) => c.includes(a)) && byId.get(a)!.state !== 'NOT_AUTHORISED') return byId.get(a)!;
  }
  return null;
}

export type FlowKind = 'PERMANENT' | 'TEMPORARY';
export type FlowState = {
  units: number;
  requester: boolean;
  site: unknown | null;
  primary: unknown | null;
  alternative: unknown | null;
  /** A temporary move (the same lifecycle as before: start, planned end, return, extension) needs both dates. */
  kind?: FlowKind;
  start?: string | null;
  end?: string | null;
};

/** What stops moving to step `to` of this request («التالي» or a click on the strip); empty when nothing does. */
export function flowStepProblem(purpose: FlowPurpose, s: FlowState, to: number): string {
  const stages = FLOW_STAGES[purpose];
  const reaches = (x: FlowStage) => to > stages.indexOf(x) + 1;
  if (purpose === 'DEPLOYMENT_AREAS') return areaStepProblem({ unitId: s.units > 0 ? 'x' : null, primary: s.primary, alternative: s.alternative }, to as AreaStep);
  if (reaches('pick') && s.units === 0) return 'اختر الوحدة أو الوحدات التي تنتقل أولاً.';
  if (reaches('pick') && !s.requester) return 'اختر وحدات من فرع واحد: تقدّم الطلب الوحدة التي تضمها كلها.';
  if (reaches('pick') && s.kind === 'TEMPORARY' && (!s.start || !s.end)) return 'حدد تاريخ بداية التمركز المؤقت وتاريخ نهايته.';
  if (reaches('pick') && s.kind === 'TEMPORARY' && s.start && s.end && s.end <= s.start) return 'تاريخ نهاية التمركز المؤقت بعد تاريخ بدايته.';
  if (reaches('site') && !s.site) return 'حدد موقع التمركز الجديد أولاً: منه تُقاس الرئيسية.';
  if (reaches('primary') && !s.primary) return 'ضع منطقة الانتشار الرئيسية أولاً: منها تُقاس الفرعية.';
  if (reaches('alternative') && !s.alternative) return 'ضع منطقة الانتشار الفرعية أولاً.';
  return '';
}

// ---- an existing request in the map-first editor (release closure, 20 Nov 2026) ------------------------------------------

/** The part of a saved request the map-first editor reads; the rest of its content is carried unchanged. */
export type SavedRequestLike = {
  purpose?: string | null;
  content: {
    kind: FlowKind;
    start?: string | null;
    end?: string | null;
    scope: string[];
    site?: { geometry: unknown; copiedFrom?: string | null; shape?: string | null } | null;
    primary: unknown | null;
    alternative: unknown | null;
    reason: string;
    occupants?: Record<string, unknown>;
    exceptions?: Record<string, unknown>;
    existingSite?: string | null;
    siteInfo?: unknown | null;
  };
};

export type LoadedFlow = {
  purpose: FlowPurpose;
  picked: string[];
  kind: FlowKind;
  start: string | null;
  end: string | null;
  site: unknown | null;
  copiedFrom: string | null;
  primary: unknown | null;
  alternative: unknown | null;
  reason: string;
  /** Fields the old editor wrote that this screen has no control for: named to the person, saved back unchanged. */
  legacy: string[];
  /** The first step still to be completed (the review when everything is there). */
  step: number;
};

/** Whether a saved request opens in the map-first editor: a re-stationing or a deployment-areas request. */
export function isFlowPurpose(purpose: string | null | undefined): purpose is FlowPurpose {
  return purpose === 'RESTATIONING' || purpose === 'DEPLOYMENT_AREAS';
}

/**
 * A saved draft or returned request as the map-first editor takes it: its units, kind and dates, new site, areas and reason —
 * nothing is changed by opening it. Content the old editor kept (occupants, exceptions, a site registration) is listed so
 * the screen can say it is carried unchanged, never dropped.
 */
export function requestIntoFlow(r: SavedRequestLike): LoadedFlow {
  const purpose: FlowPurpose = r.purpose === 'DEPLOYMENT_AREAS' ? 'DEPLOYMENT_AREAS' : 'RESTATIONING';
  const c = r.content;
  const legacy: string[] = [];
  const occupants = Object.keys(c.occupants ?? {}).length;
  const exceptions = Object.entries(c.exceptions ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()).length;
  if (occupants) legacy.push(occupants === 1 ? 'قرار شاغل واحد للموقع' : `قرارات ${occupants} شاغلين للموقع`);
  if (exceptions) legacy.push(exceptions === 1 ? 'مبرر استثناء مسافة' : `${exceptions} مبررات استثناء مسافة`);
  if (c.existingSite) legacy.push('موقع مسجل محدد');
  if (c.siteInfo) legacy.push('بيانات تسجيل موقع');
  const picked = [...(c.scope ?? [])];
  const kind: FlowKind = c.kind === 'TEMPORARY' ? 'TEMPORARY' : 'PERMANENT';
  const state: FlowState = { units: picked.length, requester: picked.length > 0, site: c.site?.geometry ?? null, primary: c.primary, alternative: c.alternative, kind, start: c.start ?? null, end: c.end ?? null };
  const last = FLOW_STAGES[purpose].length;
  let step = last;
  for (let to = 2; to <= last; to++) {
    if (flowStepProblem(purpose, state, to)) {
      step = to - 1;
      break;
    }
  }
  return { purpose, picked, kind, start: c.start ?? null, end: c.end ?? null, site: c.site?.geometry ?? null, copiedFrom: c.site?.copiedFrom ?? null, primary: c.primary, alternative: c.alternative, reason: c.reason ?? '', legacy, step };
}

/** How the new site was made, as the server records it: a copy of the current site kept as is, edited, or drawn. */
export function siteShapeKind(copiedFromArea: number | null, areaM2: number): 'COPY' | 'EDITED' | 'DRAWN' {
  if (copiedFromArea == null) return 'DRAWN';
  return Math.abs(areaM2 - copiedFromArea) <= copiedFromArea * 0.005 ? 'COPY' : 'EDITED';
}

/** «6.2 كم» */
export const kmChip = (m: number) => (m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 1 }) + ' كم';
export const areaChip = (m2: number) => formatArea(m2);

export type Verdict = { text: string; tone: 'ok' | 'bad' | 'warn' };

/**
 * The distance against the policy's range for this area. Beyond the base maximum the terrain may still allow it (the
 * server adds the allowance of the controlling slope class when it checks), so that case is a warning, not a refusal.
 */
export function verdictOf(distanceM: number, leg: { minM: number; maxM: number; terrainApplies?: boolean } | null): Verdict | null {
  if (!leg) return null;
  if (distanceM < leg.minM) return { text: '✗ أقرب من المسموح', tone: 'bad' };
  if (distanceM <= leg.maxM) return { text: '✓ ضمن المسموح', tone: 'ok' };
  return leg.terrainApplies ? { text: '! أبعد من الحد الأساسي', tone: 'warn' } : { text: '✗ أبعد من المسموح', tone: 'bad' };
}

/** The area against the policy's limits of this leg (ADR-088); null when it has none. The server refuses outside them. */
export function areaVerdict(areaM2: number, leg: { minAreaM2?: number | null; maxAreaM2?: number | null } | null): Verdict | null {
  if (!leg || (leg.minAreaM2 == null && leg.maxAreaM2 == null)) return null;
  if (leg.maxAreaM2 != null && areaM2 > leg.maxAreaM2) return { text: '✗ أكبر من المساحة المسموحة', tone: 'bad' };
  if (leg.minAreaM2 != null && areaM2 < leg.minAreaM2) return { text: '✗ أصغر من المساحة المسموحة', tone: 'bad' };
  return { text: '✓ المساحة ضمن المسموح', tone: 'ok' };
}

/** «المسموح 5–8 كم» */
export const rangeText = (leg: { minM: number; maxM: number }) =>
  `المسموح ${(leg.minM / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 1 })}–${kmChip(leg.maxM)}`;

/** Why a distance is beyond the range, in words (the ⓘ details); empty within it. */
export function overReason(distanceM: number, leg: { minM: number; maxM: number; terrainApplies?: boolean } | null): string {
  if (!leg) return '';
  if (distanceM < leg.minM) return `أقرب بـ${kmChip(leg.minM - distanceM)} من الحد الأدنى.`;
  if (distanceM > leg.maxM) return `أبعد بـ${kmChip(distanceM - leg.maxM)} من الحد الأقصى الأساسي` + (leg.terrainApplies ? '؛ قد تسمح به طبيعة الأرض عند الفحص.' : '.');
  return '';
}

/** A leg's distance rules as the policy holds them (StationingPolicy.Leg). */
export type ReachLeg = { minM: number; maxM: number; terrainApplies?: boolean; terrainExtra?: { kind: 'ABSOLUTE' | 'PERCENT'; value: number } | null };
/** The parts of the policy the farthest distance depends on. */
export type ReachPolicy = { terrainAllowancesM?: Record<string, number> | null; exception?: { allowed: boolean; maxExtraM: number } | null };
export type Reach = { baseMaxM: number; terrainM: number; exceptionM: number; maxM: number; assessed: boolean };

/**
 * The most any ground can add to a leg's maximum, as the server adds it (StationingPolicy.terrainAddM): the leg's own
 * extra (an amount, or a percentage of its maximum), else the largest allowance of a slope class; nothing when the
 * terrain does not apply to this leg.
 */
export function largestTerrainAddM(leg: ReachLeg, policy: ReachPolicy): number {
  if (!leg.terrainApplies) return 0;
  if (leg.terrainExtra) return leg.terrainExtra.kind === 'PERCENT' ? (leg.maxM * leg.terrainExtra.value) / 100 : leg.terrainExtra.value;
  return Math.max(0, ...Object.values(policy.terrainAllowancesM ?? {}));
}

/**
 * The farthest an area of this leg can be from where it is measured (owner, 25 Nov 2026): the base maximum, what the
 * ground adds — the place's own allowance once the server has assessed it ({@code assessedMaxM}, the server's effective
 * maximum there), else the most any ground can add — and the exception margin when the policy gives one (ADR-078). The
 * map never places, moves or draws an area beyond it; the server checks again on every save.
 */
export function reachOf(leg: ReachLeg, policy: ReachPolicy, assessedMaxM?: number | null): Reach {
  const exceptionM = policy.exception?.allowed ? Math.max(0, policy.exception.maxExtraM) : 0;
  const assessed = assessedMaxM != null && Number.isFinite(assessedMaxM);
  const terrainM = assessed ? Math.max(0, assessedMaxM - leg.maxM) : largestTerrainAddM(leg, policy);
  return { baseMaxM: leg.maxM, terrainM, exceptionM, maxM: leg.maxM + terrainM + exceptionM, assessed };
}

/** «الحد الأقصى 9 كم (8 كم + 1 كم لطبيعة الأرض)» — what the pointer and the panel say at the limit. */
export function reachText(r: Reach): string {
  const parts = [kmChip(r.baseMaxM)];
  if (r.terrainM > 0) parts.push((r.assessed ? '' : 'حتى ') + kmChip(r.terrainM) + ' لطبيعة الأرض');
  if (r.exceptionM > 0) parts.push(kmChip(r.exceptionM) + ' استثناء');
  return 'الحد الأقصى ' + kmChip(r.maxM) + (parts.length > 1 ? ' (' + parts.join(' + ') + ')' : '');
}
