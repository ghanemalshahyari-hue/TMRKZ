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

/** The first step to open: straight to the main area when exactly one unit may have the request (it starts by itself). */
export function startStep(choices: readonly UnitChoice<UnitLike>[]): { step: AreaStep; unitId: string | null } {
  const ok = choices.filter((c) => c.eligible);
  return ok.length === 1 ? { step: 2, unitId: ok[0].unit.id } : { step: 1, unitId: null };
}

export type AreaState = { unitId: string | null; primary: unknown | null; alternative: unknown | null };

/** What stops moving to a step («التالي» or a click on the strip); empty when nothing does. */
export function areaStepProblem(s: AreaState, to: AreaStep): string {
  if (to >= 2 && !s.unitId) return 'اختر الوحدة أولاً: يبدأ الطلب من موقعها الحالي.';
  if (to >= 3 && !s.primary) return 'ضع منطقة الانتشار الرئيسية أولاً: منها تُقاس الفرعية.';
  if (to >= 4 && !s.alternative) return 'ضع منطقة الانتشار الفرعية أولاً.';
  return '';
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
