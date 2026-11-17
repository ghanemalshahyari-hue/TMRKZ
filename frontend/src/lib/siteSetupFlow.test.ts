import { describe, expect, it } from 'vitest';
import type { GeoPolygon, Permission } from '../api/types';
import { SETUP_STEPS, SITE_STEPS, isSetupAdmin, lastStep, nextStep, policyLeg, prevStep, setupBody, setupProblem, stepsFor, toggleUnit, unitBlock, unitLines, withArea, withResponsible, type UnitPlan } from './siteSetupFlow';

const sq: GeoPolygon = { type: 'Polygon', coordinates: [[[54, 24], [54.01, 24], [54.01, 24.01], [54, 24.01], [54, 24]]] };
const grant = (permissions: Permission[], all: boolean) => ({ permissions, all });
const unit = (id: string, primary: GeoPolygon | null = null, alternative: GeoPolygon | null = null): UnitPlan => ({ id, name: 'وحدة ' + id, primary, alternative });

describe('who sees the six steps (ADR-067)', () => {
  it('facilities and corrections, each over everything; the server confirms on save', () => {
    expect(isSetupAdmin([grant(['VIEW', 'MANAGE_FACILITIES', 'MANAGE_SITE_LINKS', 'CORRECT_STATIONING'], true)])).toBe(true);
    expect(isSetupAdmin([grant(['MANAGE_FACILITIES'], true), grant(['CORRECT_STATIONING'], true)])).toBe(true);
    expect(isSetupAdmin([grant(['MANAGE_FACILITIES'], true)])).toBe(false);
    expect(isSetupAdmin([grant(['MANAGE_FACILITIES', 'CORRECT_STATIONING'], false)])).toBe(false);
    expect(isSetupAdmin([grant(['MANAGE_FACILITIES'], true), grant(['CORRECT_STATIONING'], false)])).toBe(false);
    // a requester has no setup (initial stationing is set up here only, ADR-078); «معتمد عمليات الوحدة» manages facilities and
    // site links within its grant, never corrections: it keeps the three steps of the site alone
    expect(isSetupAdmin([grant(['VIEW', 'CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION'], false)])).toBe(false);
    expect(isSetupAdmin([grant(['VIEW', 'REVIEW', 'DECIDE_UNIT_OPERATIONS', 'MANAGE_FACILITIES', 'MANAGE_SITE_LINKS'], false)])).toBe(false);
    expect(isSetupAdmin([grant(['CONFIGURE', 'MANAGE_ACCESS', 'MANAGE_FACILITIES', 'CREATE_RESTATIONING', 'MANAGE_SITE_LINKS', 'CORRECT_STATIONING', 'REPLAY_STATIONING_EVENTS'], true)])).toBe(true);
    expect(isSetupAdmin(null)).toBe(false);
  });
  it('the administrator has six steps with the owner\'s labels; everyone else keeps the three steps of the site alone', () => {
    expect(stepsFor(true)).toEqual(['البيانات', 'الرسم', 'التمركز الابتدائي', 'منطقة الانتشار الرئيسية', 'منطقة الانتشار الفرعية', 'مراجعة وحفظ']);
    expect(stepsFor(false)).toEqual(['البيانات', 'الرسم', 'الحفظ']);
    expect(SETUP_STEPS).toHaveLength(6);
    expect(SITE_STEPS).toHaveLength(3);
    expect(lastStep(true)).toBe(6);
    expect(lastStep(false)).toBe(3);
  });
});

describe('step order', () => {
  it('goes through every step when units are chosen', () => {
    expect([1, 2, 3, 4, 5].map((s) => nextStep(s as 1, true, 2))).toEqual([2, 3, 4, 5, 6]);
    expect([6, 5, 4, 3, 2].map((s) => prevStep(s as 6, true, 2))).toEqual([5, 4, 3, 2, 1]);
  });
  it('with no unit there is no area to place: from «التمركز الابتدائي» straight to the review, and back', () => {
    expect(nextStep(3, true, 0)).toBe(6);
    expect(prevStep(6, true, 0)).toBe(3);
  });
  it('the three steps never go past «الحفظ»', () => {
    expect(nextStep(2, false, 0)).toBe(3);
    expect(nextStep(3, false, 5)).toBe(3);
    expect(prevStep(1, false, 0)).toBe(1);
  });
});

describe('«التالي» follows the policy in force, never the page', () => {
  const base = { units: [unit('a')], requirement: 'REQUIRED' as const, policyInForce: true, drawing: false };
  it('no unit is stationed before a policy is in force', () => {
    expect(setupProblem({ ...base, policyInForce: false, requirement: null }, 3, 4)).toMatch('لا توجد سياسة تمركز نافذة');
    expect(setupProblem({ ...base, units: [], policyInForce: false, requirement: null }, 3, 6)).toBe('');
  });
  it('REQUIRED: both areas for every unit', () => {
    expect(setupProblem(base, 4, 5)).toMatch('ضع منطقة الانتشار الرئيسية لـ«وحدة a»');
    expect(setupProblem({ ...base, units: [unit('a', sq)] }, 4, 5)).toBe('');
    expect(setupProblem({ ...base, units: [unit('a', sq)] }, 5, 6)).toMatch('ضع منطقتي الانتشار لـ«وحدة a»');
    expect(setupProblem({ ...base, units: [unit('a', sq, sq), unit('b', sq)] }, 5, 6)).toMatch('«وحدة b»');
    expect(setupProblem({ ...base, units: [unit('a', sq, sq)] }, 5, 6)).toBe('');
  });
  it('OPTIONAL: none or both, never one alone', () => {
    const opt = { ...base, requirement: 'OPTIONAL' as const };
    expect(setupProblem(opt, 4, 5)).toBe('');
    expect(setupProblem(opt, 5, 6)).toBe('');
    expect(setupProblem({ ...opt, units: [unit('a', sq)] }, 5, 6)).toMatch('زوج كامل');
    expect(setupProblem({ ...opt, units: [unit('a', sq, sq)] }, 5, 6)).toBe('');
  });
  it('an area being drawn is finished first; going back is never refused', () => {
    expect(setupProblem({ ...base, units: [unit('a', sq)], drawing: true }, 4, 5)).toMatch('أكمل رسم المنطقة');
    expect(setupProblem({ ...base, policyInForce: false }, 6, 3)).toBe('');
    expect(setupProblem(base, 5, 4)).toBe('');
  });
});

describe('the units and their areas', () => {
  it('only a unit stationed nowhere is offered, with where the others are', () => {
    const current = [{ orgId: 'a', siteName: 'المعسكر' }];
    expect(unitBlock('a', current)).toBe('متمركزة في «المعسكر»');
    expect(unitBlock('b', current)).toBe('');
  });
  it('ticking adds a unit without areas and unticking removes it with its areas', () => {
    const one = toggleUnit([], { id: 'a', name: 'وحدة a' });
    expect(one).toEqual([unit('a')]);
    const two = toggleUnit(withArea(one, 'a', 'primary', sq), { id: 'b', name: 'وحدة b' });
    expect(two.map((u) => u.id)).toEqual(['a', 'b']);
    expect(toggleUnit(two, { id: 'a', name: 'وحدة a' })).toEqual([unit('b')]);
  });
  it('an area belongs to one unit: placing one never touches another unit or the other area', () => {
    const plan = withArea(withArea([unit('a'), unit('b')], 'a', 'primary', sq), 'b', 'alternative', sq);
    expect(plan[0]).toEqual(unit('a', sq));
    expect(plan[1]).toEqual(unit('b', null, sq));
    expect(withArea(plan, 'a', 'primary', null)[0]).toEqual(unit('a'));
  });
});

describe('«مراجعة وحفظ»', () => {
  it('one line per unit saying which areas are placed', () => {
    expect(unitLines([unit('a', sq, sq), unit('b', sq), unit('c')])).toEqual([
      ['وحدة a', 'الرئيسية ✓ · الفرعية ✓'],
      ['وحدة b', 'الرئيسية ✓ · الفرعية —'],
      ['وحدة c', 'بلا مناطق انتشار'],
    ]);
  });
  it('one body: the site and its boundary as «/sites/with-boundary» takes them, then each unit with its own two areas', () => {
    const site = { code: '', name: 'المجمع' };
    const boundary = { geometry: sq, crs: 'EPSG:4326' };
    expect(setupBody(site, boundary, [unit('a', sq, sq), unit('b')], '  تهيئة أولى  ')).toEqual({
      site,
      boundary,
      units: [{ organizationId: 'a', primary: sq, alternative: sq }, { organizationId: 'b', primary: null, alternative: null }],
      reason: 'تهيئة أولى',
    });
    expect(setupBody(site, null, [], 'سبب التهيئة').boundary).toBeNull();
  });
});

describe('the leg on the page before the server checks it', () => {
  const values = { primary: { minM: 5000, maxM: 8000, terrainApplies: false }, alternative: { minM: 3000, maxM: 5000, terrainApplies: true }, exception: { allowed: true, maxExtraM: 1000 } };
  it('a leg without terrain reads its range from the policy in force', () => {
    expect(policyLeg('primary', 6000, values)?.status).toBe('OK');
    expect(policyLeg('primary', 8500, values)?.status).toBe('NEEDS_EXCEPTION');
    expect(policyLeg('primary', 12000, values)?.status).toBe('OUT_OF_RANGE');
    expect(policyLeg('primary', 4000, values)?.status).toBe('OUT_OF_RANGE');
    expect(policyLeg('primary', null, values)?.status).toBe('NOT_PLACED');
    expect(policyLeg('primary', 6000, { ...values, exception: { allowed: false, maxExtraM: 0 } })?.exceptionMaxM).toBeNull();
  });
  it('nothing is guessed for a leg with terrain, or without a policy', () => {
    expect(policyLeg('alternative', 4000, values)).toBeUndefined();
    expect(policyLeg('primary', 6000, null)).toBeUndefined();
  });
});

// the responsible unit is the stationed unit (owner, 17 Nov 2026, ADR-076)
describe('responsible unit stationed by the setup', () => {
  const police = { id: 'P', name: 'الشرطة' };
  it('heads the plan, keeps an earlier entry with its areas, and other units stay', () => {
    expect(withResponsible([], police, null, '').map((u) => u.id)).toEqual(['P']);
    const planned = [{ id: 'X', name: 'أخرى', primary: null, alternative: null }, { id: 'P', name: 'الشرطة', primary: sq, alternative: null }];
    const out = withResponsible(planned, police, 'P', '');
    expect(out.map((u) => u.id)).toEqual(['P', 'X']);
    expect(out[0].primary).toBe(sq);
  });
  it('a change of responsible unit replaces the one added before; none responsible leaves the others', () => {
    const plan = withResponsible([{ id: 'X', name: 'أخرى', primary: null, alternative: null }], police, null, '');
    expect(withResponsible(plan, { id: 'Q', name: 'وحدة' }, 'P', '').map((u) => u.id)).toEqual(['Q', 'X']);
    expect(withResponsible(plan, null, 'P', '').map((u) => u.id)).toEqual(['X']);
  });
  it('a responsible unit stationed elsewhere is not stationed here', () => {
    const plan = withResponsible([], police, null, '');
    expect(withResponsible(plan, police, 'P', 'متمركزة في «موقع آخر»')).toEqual([]);
  });
});
