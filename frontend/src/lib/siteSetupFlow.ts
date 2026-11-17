import type { GeoPolygon, Grant, Permission, RestationingLeg, StationingPolicyValues } from '../api/types';

/**
 * «موقع جديد» for the setup administrator (ADR-067, owner's full acceptance specification of 16 Nov 2026): the site, its
 * initial stationing and each stationed unit's two deployment areas, saved as one act. Six steps for a person who holds
 * the setup rights everywhere; everyone else keeps the three steps of the site alone (ADR-048). These are its pure parts;
 * the page draws them and the server decides everything again on save.
 */
export type SetupStep = 1 | 2 | 3 | 4 | 5 | 6;

/** The three steps of the site alone (ADR-048). */
export const SITE_STEPS = ['البيانات', 'الرسم', 'الحفظ'] as const;
/** The six steps of the setup administrator. */
export const SETUP_STEPS = ['البيانات', 'الرسم', 'التمركز الابتدائي', 'منطقة الانتشار الرئيسية', 'منطقة الانتشار البديلة', 'مراجعة وحفظ'] as const;

/**
 * Whether the page offers the six steps: facilities and stationing corrections each through an ALL-scope grant — the
 * page's mirror of the server's gate (`SiteSetupService.admin`, confirmed there by OpenFGA). A wrong answer here only
 * changes what is shown: the server refuses anyone else.
 */
export function isSetupAdmin(grants: readonly Pick<Grant, 'permissions' | 'all'>[] | null | undefined): boolean {
  const everywhere = (p: Permission) => (grants ?? []).some((g) => !!g.all && g.permissions.includes(p));
  return everywhere('MANAGE_FACILITIES') && everywhere('CORRECT_STATIONING');
}

export const stepsFor = (admin: boolean): readonly string[] => (admin ? SETUP_STEPS : SITE_STEPS);
export const lastStep = (admin: boolean): SetupStep => (admin ? 6 : 3);

/** One unit stationed by the setup, in the order it was ticked, with its own areas. */
export type UnitPlan = { id: string; name: string; primary: GeoPolygon | null; alternative: GeoPolygon | null };

/** The policy in force's `deploymentRequirement`; null when no policy is in force. */
export type Requirement = 'REQUIRED' | 'OPTIONAL' | null;

/** «التالي»: with no unit chosen there is no area to place, so «التمركز الابتدائي» goes straight to the review. */
export function nextStep(from: SetupStep, admin: boolean, units: number): SetupStep {
  const last = lastStep(admin);
  if (admin && from === 3 && units === 0) return 6;
  return Math.min(from + 1, last) as SetupStep;
}

/** «السابق»: the way back the same way. */
export function prevStep(from: SetupStep, admin: boolean, units: number): SetupStep {
  if (admin && from === 6 && units === 0) return 3;
  return Math.max(from - 1, 1) as SetupStep;
}

export type SetupState = { units: UnitPlan[]; requirement: Requirement; policyInForce: boolean; drawing: boolean };

/**
 * Why «التالي» may not leave `from` for `to` yet ('' when it may), for steps 3–6 (the site's own steps are
 * `siteWizard.stepProblem`). Going back is never refused. Whether areas are required is the policy's, never the page's:
 * REQUIRED needs both for every unit; otherwise none or both («زوج كامل»), as the server's pair rule.
 */
export function setupProblem(s: SetupState, from: SetupStep, to: SetupStep): string {
  if (to <= from) return '';
  if (s.drawing && from >= 4) return 'أكمل رسم المنطقة أولاً: انقر على أول نقطة، أو «إنهاء الرسم».';
  if (to >= 4 && s.units.length > 0 && !s.policyInForce) return 'لا توجد سياسة تمركز نافذة؛ ينشرها مسؤول النظام قبل تهيئة التمركز ومناطق الانتشار.';
  if (to >= 5 && from <= 4 && s.requirement === 'REQUIRED') {
    const missing = s.units.find((u) => !u.primary);
    if (missing) return `ضع منطقة الانتشار الرئيسية لـ«${missing.name}»: تشترطها سياسة التمركز السارية.`;
  }
  if (to >= 6) {
    for (const u of s.units) {
      if (s.requirement === 'REQUIRED' && (!u.primary || !u.alternative)) return `ضع منطقتي الانتشار لـ«${u.name}»: تشترطهما سياسة التمركز السارية.`;
      if (!!u.primary !== !!u.alternative) return `«${u.name}»: الانتشار زوج كامل — الرئيسية والبديلة معاً، أو لا شيء.`;
    }
  }
  return '';
}

/** A unit is offered only while it is stationed nowhere: why it is not ('' when it is), from the register as this person reads it. */
export function unitBlock(id: string, current: readonly { orgId: string; siteName: string }[]): string {
  const r = current.find((c) => c.orgId === id);
  return r ? `متمركزة في «${r.siteName}»` : '';
}

/** Ticking a unit in «التمركز الابتدائي»: added at the end with no area yet, or removed with its areas. */
export function toggleUnit(units: UnitPlan[], u: { id: string; name: string }): UnitPlan[] {
  return units.some((x) => x.id === u.id) ? units.filter((x) => x.id !== u.id) : [...units, { id: u.id, name: u.name, primary: null, alternative: null }];
}

/**
 * The responsible unit is the stationed unit (owner, 17 Nov 2026, ADR-076): in the setup it heads the plan and stays there
 * while it is responsible; a unit that was responsible before and was added that way leaves with its areas. A responsible unit
 * stationed elsewhere (`blocked`) is not added — the page says why.
 */
export function withResponsible(units: UnitPlan[], responsible: { id: string; name: string } | null, previous: string | null, blocked: string): UnitPlan[] {
  const out = previous && previous !== responsible?.id ? units.filter((u) => u.id !== previous) : units;
  if (!responsible) return out;
  if (blocked) return out.filter((u) => u.id !== responsible.id);
  const have = out.find((u) => u.id === responsible.id);
  return [have ?? { id: responsible.id, name: responsible.name, primary: null, alternative: null }, ...out.filter((u) => u.id !== responsible.id)];
}

/** One unit's area placed, moved or removed; the other unit's areas, and its own other area, stay as they are. */
export function withArea(units: UnitPlan[], id: string, role: 'primary' | 'alternative', g: GeoPolygon | null): UnitPlan[] {
  return units.map((u) => (u.id === id ? { ...u, [role]: g } : u));
}

/**
 * A leg read from the policy in force alone, for the page while the server's terrain analysis of the area is not there:
 * only for a leg the policy applies no terrain to (its base range is then its effective range). For a leg with terrain
 * nothing is guessed (undefined: the distance is shown without a verdict). The server's check decides either way.
 */
export function policyLeg(kind: 'primary' | 'alternative', distance: number | null, values: Pick<StationingPolicyValues, 'primary' | 'alternative' | 'exception'> | null | undefined): RestationingLeg | undefined {
  const r = values?.[kind];
  if (!values || !r || r.terrainApplies) return undefined;
  const exceptionMaxM = values.exception?.allowed ? r.maxM + values.exception.maxExtraM : null;
  const status: RestationingLeg['status'] =
    distance == null ? 'NOT_PLACED'
      : distance >= r.minM && distance <= r.maxM ? 'OK'
        : exceptionMaxM != null && distance > r.maxM && distance <= exceptionMaxM ? 'NEEDS_EXCEPTION'
          : 'OUT_OF_RANGE';
  return {
    leg: kind,
    label: kind === 'primary' ? 'منطقة الانتشار الرئيسية' : 'منطقة الانتشار البديلة',
    status,
    distanceM: distance,
    baseMinM: r.minM,
    baseMaxM: r.maxM,
    effectiveMinM: r.minM,
    effectiveMaxM: r.maxM,
    exceptionMaxM,
    method: 'CENTROID_TO_CENTROID',
    conflicts: [],
  };
}

/** «مراجعة وحفظ»: one line per unit — its name, and which of its areas are placed. */
export function unitLines(units: readonly UnitPlan[]): [string, string][] {
  return units.map((u) => [u.name, u.primary && u.alternative ? 'الرئيسية ✓ · البديلة ✓' : u.primary ? 'الرئيسية ✓ · البديلة —' : 'بلا مناطق انتشار']);
}

/** The body of the one save (`POST /site-setup`): the site and its boundary as «/sites/with-boundary» takes them, then the units. */
export function setupBody<S, B>(site: S, boundary: B | null, units: readonly UnitPlan[], reason: string) {
  return {
    site,
    boundary,
    units: units.map((u) => ({ organizationId: u.id, primary: u.primary, alternative: u.alternative })),
    reason: reason.trim(),
  };
}
