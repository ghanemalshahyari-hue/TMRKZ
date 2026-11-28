import { describe, expect, it } from 'vitest';
import {
  AREA_NAME, RESTATION_STEPS, areaStepProblem, areaVerdict, campTree, flowStepProblem, isFlowPurpose, measuredFrom, overReason, requestIntoFlow, requestingUnitOf, restationingChoices, siteShapeKind, startStep, unitChoices, unitForest, verdictOf,
  largestTerrainAddM, reachOf, reachText, reachFor, STOPS_AT_REACH, BEYOND_MAX,
} from './deploymentAreasFlow';
import { destination, distanceM, withinM } from './geo';

const unit = (id: string, state: string, site = true) => ({ id, name: 'وحدة ' + id, state, site: site ? { id: 's' + id, name: 'موقع ' + id } : null });

describe('«طلب مناطق انتشار» (owner brief §4, phase 3)', () => {
  it('names the sub-area «الفرعية», never «البديلة»', () => {
    expect(AREA_NAME.alternative).toBe('منطقة الانتشار الفرعية');
    expect(Object.values(AREA_NAME).join(' ')).not.toContain('البديل');
  });

  it('offers only stationed units with no area request pending, saying why the others are not', () => {
    const c = unitChoices([unit('a', 'DEPLOYMENT_MISSING'), unit('b', 'DEPLOYMENT_COMPLETE'), unit('c', 'DEPLOYMENT_REQUEST_PENDING'), unit('d', 'NO_STATIONING', false)]);
    expect(c.map((x) => x.eligible)).toEqual([true, true, false, false]);
    expect(c[1].note).toContain('يعدّلهما');
    expect(c[3].note).toContain('تحديد مواقع التمركز المبدئية');
  });

  it('lists the units by camp, inside camps under their main camp, the units stationed nowhere apart', () => {
    const at = (id: string, state: string, site: string | null, depth = 1) => ({ id, name: 'وحدة ' + id, state, depth, site: site ? { id: site, name: 'موقع ' + site } : null });
    const sites = [
      { siteId: 'A', name: 'معسكر أ', code: 'S-1', parentId: null },
      { siteId: 'A1', name: 'داخل أ', code: 'S-2', parentId: 'A' },
      { siteId: 'B', name: 'معسكر ب', code: 'S-3', parentId: null },
      { siteId: 'C', name: 'معسكر ج', code: 'S-4', parentId: null },
    ];
    const { camps, unstationed } = campTree(unitChoices([at('u1', 'DEPLOYMENT_MISSING', 'A1', 3), at('u2', 'DEPLOYMENT_COMPLETE', 'B'), at('u3', 'DEPLOYMENT_MISSING', 'A1', 2), at('u4', 'NO_STATIONING', null), at('u5', 'NOT_AUTHORISED', 'C')]), sites);
    // A is shown for its inside camp A1, which holds two units ordered by depth; C (only a unit the person may not ask for) is not
    expect(camps.map((c) => c.site.name)).toEqual(['معسكر أ', 'معسكر ب']);
    expect(camps[0].units).toHaveLength(0);
    expect(camps[0].children.map((c) => c.site.name)).toEqual(['داخل أ']);
    expect(camps[0].children[0].units.map((u) => u.unit.id)).toEqual(['u3', 'u1']);
    expect(unstationed.map((u) => u.unit.id)).toEqual(['u4']);
  });

  it('lists units as their organisation\'s tree, each under its parent when that is listed', () => {
    const u = (id: string, parentId: string | null) => ({ id, name: 'وحدة ' + id, state: 'NO_STATIONING', parentId, site: null });
    const f = unitForest(unitChoices([u('a', null), u('b', 'a'), u('c', 'b'), u('d', 'x'), u('e', 'a')]));
    expect(f.map((n) => n.choice.unit.id)).toEqual(['a', 'd']);
    expect(f[0].children.map((n) => n.choice.unit.id)).toEqual(['b', 'e']);
    expect(f[0].children[0].children.map((n) => n.choice.unit.id)).toEqual(['c']);
  });

  it('starts by itself at the main area when one unit may have it; otherwise the unit is chosen first', () => {
    // owner, 25 Nov 2026: never chosen and never moved on by itself, even with one eligible unit
    expect(startStep(unitChoices([unit('a', 'DEPLOYMENT_MISSING'), unit('c', 'DEPLOYMENT_REQUEST_PENDING')]))).toEqual({ step: 1, unitId: null });
    expect(startStep(unitChoices([unit('a', 'DEPLOYMENT_MISSING'), unit('b', 'DEPLOYMENT_COMPLETE')]))).toEqual({ step: 1, unitId: null });
    expect(startStep(unitChoices([]))).toEqual({ step: 1, unitId: null });
  });

  it('goes forward in order: the unit, the main area, the sub-area', () => {
    expect(areaStepProblem({ unitId: null, primary: null, alternative: null }, 2)).toContain('اختر الوحدة');
    expect(areaStepProblem({ unitId: 'a', primary: null, alternative: null }, 3)).toContain('الرئيسية');
    expect(areaStepProblem({ unitId: 'a', primary: {}, alternative: null }, 4)).toContain('الفرعية');
    expect(areaStepProblem({ unitId: 'a', primary: {}, alternative: {} }, 4)).toBe('');
  });

  it('judges the area by the leg\'s own limits when the policy has them', () => {
    expect(areaVerdict(50_000, { minAreaM2: 1_000, maxAreaM2: 40_000 })?.tone).toBe('bad');
    expect(areaVerdict(500, { minAreaM2: 1_000, maxAreaM2: 40_000 })?.text).toContain('أصغر');
    expect(areaVerdict(20_000, { minAreaM2: 1_000, maxAreaM2: 40_000 })?.tone).toBe('ok');
    expect(areaVerdict(20_000, { minAreaM2: null, maxAreaM2: null })).toBeNull();
  });

  it('judges the distance by the policy range; beyond the base maximum the terrain may still allow it', () => {
    const leg = { minM: 5000, maxM: 8000, terrainApplies: true };
    expect(verdictOf(6200, leg)).toEqual({ text: '✓ ضمن المسموح', tone: 'ok' });
    expect(verdictOf(3000, leg)?.tone).toBe('bad');
    expect(verdictOf(9000, leg)?.tone).toBe('warn');
    expect(verdictOf(9000, { ...leg, terrainApplies: false })?.tone).toBe('bad');
    expect(overReason(9000, leg)).toContain('طبيعة الأرض');
    expect(overReason(6000, leg)).toBe('');
  });
});

describe('«طلب إعادة تمركز», the simplified flow (owner brief §5, phase 4)', () => {
  const hub = (id: string, parentId: string | null, state = 'DEPLOYMENT_COMPLETE', allowed = true) => ({
    id, name: 'وحدة ' + id, parentId, state, site: state === 'NO_STATIONING' ? null : { id: 's' + id, name: 'موقع ' + id },
    actions: [{ action: 'RESTATIONING', allowed, reason: allowed ? null : 'سبب الخادم' }],
  });

  it('progresses units → new site → main → sub → review', () => {
    expect(RESTATION_STEPS.slice(1, 4)).toEqual(['الموقع الجديد', 'الرئيسية', 'الفرعية']);
    expect(measuredFrom('RESTATIONING', 'primary')).toBe('من مركز الموقع الجديد');
    expect(measuredFrom('DEPLOYMENT_AREAS', 'primary')).toBe('من مركز الموقع الحالي');
  });

  it('offers stationed units the hub allows, with the server\'s reason for the others', () => {
    const c = restationingChoices([hub('a', null), hub('b', null, 'NO_STATIONING'), hub('c', null, 'DEPLOYMENT_MISSING', false), hub('d', null, 'NOT_AUTHORISED')]);
    expect(c.map((x) => x.eligible)).toEqual([true, false, false, false]);
    expect(c[2].note).toBe('سبب الخادم');
  });

  it('asks from the nearest unit every moving unit is under', () => {
    const units = [hub('top', null), hub('x', 'top'), hub('y', 'top'), hub('x1', 'x'), hub('other', null)];
    expect(requestingUnitOf(['x1'], units)?.id).toBe('x1');
    expect(requestingUnitOf(['x', 'x1'], units)?.id).toBe('x');
    expect(requestingUnitOf(['x1', 'y'], units)?.id).toBe('top');
    expect(requestingUnitOf(['x', 'other'], units)).toBeNull();
    expect(requestingUnitOf([], units)).toBeNull();
  });

  it('stops each step until the one before it is done', () => {
    const s = { units: 1, requester: true, site: null, primary: null, alternative: null };
    expect(flowStepProblem('RESTATIONING', { ...s, units: 0 }, 2)).toContain('الوحدات');
    expect(flowStepProblem('RESTATIONING', { ...s, requester: false }, 2)).toContain('فرع واحد');
    expect(flowStepProblem('RESTATIONING', s, 2)).toBe('');
    expect(flowStepProblem('RESTATIONING', s, 3)).toContain('موقع التمركز الجديد');
    expect(flowStepProblem('RESTATIONING', { ...s, site: {} }, 4)).toContain('الرئيسية');
    expect(flowStepProblem('RESTATIONING', { ...s, site: {}, primary: {} }, 5)).toContain('الفرعية');
    expect(flowStepProblem('RESTATIONING', { ...s, site: {}, primary: {}, alternative: {} }, 5)).toBe('');
    expect(flowStepProblem('DEPLOYMENT_AREAS', { ...s, units: 0 }, 2)).toContain('اختر الوحدة');
  });

  it('records a kept copy of the current site as COPY, a changed one as EDITED, a new shape as DRAWN', () => {
    expect(siteShapeKind(100_000, 100_200)).toBe('COPY');
    expect(siteShapeKind(100_000, 140_000)).toBe('EDITED');
    expect(siteShapeKind(null, 140_000)).toBe('DRAWN');
  });
});

describe('a saved request in the map-first editor (release closure, 20 Nov 2026)', () => {
  const site = { type: 'Polygon', coordinates: [] };
  const base = { purpose: 'RESTATIONING', content: { kind: 'PERMANENT' as const, scope: ['u1', 'u2'], site: { geometry: site, copiedFrom: 's1', shape: 'COPY' }, primary: { p: 1 }, alternative: { a: 1 }, reason: 'why' } };

  it('a temporary move needs both dates, in order, before leaving the units step', () => {
    const s = { units: 1, requester: true, site: null, primary: null, alternative: null };
    expect(flowStepProblem('RESTATIONING', { ...s, kind: 'TEMPORARY' }, 2)).toContain('تاريخ بداية');
    expect(flowStepProblem('RESTATIONING', { ...s, kind: 'TEMPORARY', start: '2026-12-01', end: '2026-11-01' }, 2)).toContain('بعد تاريخ بدايته');
    expect(flowStepProblem('RESTATIONING', { ...s, kind: 'TEMPORARY', start: '2026-11-01', end: '2026-12-01' }, 2)).toBe('');
    expect(flowStepProblem('RESTATIONING', { ...s, kind: 'PERMANENT' }, 2)).toBe('');
  });

  it('loads a complete draft at its review step with everything the old editor saved, changing nothing', () => {
    const f = requestIntoFlow(base);
    expect(f.purpose).toBe('RESTATIONING');
    expect(f.picked).toEqual(['u1', 'u2']);
    expect(f.site).toBe(site);
    expect(f.copiedFrom).toBe('s1');
    expect(f.primary).toEqual({ p: 1 });
    expect(f.alternative).toEqual({ a: 1 });
    expect(f.reason).toBe('why');
    expect(f.kind).toBe('PERMANENT');
    expect(f.legacy).toEqual([]);
    expect(f.step).toBe(5);
  });

  it('opens an incomplete draft at its first open step, a temporary one with its dates', () => {
    expect(requestIntoFlow({ ...base, content: { ...base.content, primary: null, alternative: null } }).step).toBe(3);
    expect(requestIntoFlow({ ...base, content: { ...base.content, site: null } }).step).toBe(2);
    expect(requestIntoFlow({ ...base, content: { ...base.content, scope: [] } }).step).toBe(1);
    const t = requestIntoFlow({ ...base, content: { ...base.content, kind: 'TEMPORARY', start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' } });
    expect(t.kind).toBe('TEMPORARY');
    expect(t.start).toBe('2026-11-01T00:00:00Z');
    expect(t.step).toBe(5);
    expect(requestIntoFlow({ ...base, content: { ...base.content, kind: 'TEMPORARY' } }).step).toBe(1);
  });

  it('names the content it has no control for (occupants, exceptions, a site registration) instead of dropping it', () => {
    const f = requestIntoFlow({ ...base, content: { ...base.content, occupants: { x: 'EXCLUDED', y: 'INCLUDED' }, exceptions: { primary: 'far' }, existingSite: 's9', siteInfo: { name: 'n' } } });
    expect(f.legacy).toEqual(['قرارات 2 شاغلين للموقع', 'مبرر استثناء مسافة', 'موقع مسجل محدد', 'بيانات تسجيل موقع']);
    expect(requestIntoFlow({ ...base, content: { ...base.content, exceptions: { primary: '  ' } } }).legacy).toEqual([]);
  });

  it('a deployment-areas draft opens as that request; only the two purposes open here', () => {
    const f = requestIntoFlow({ purpose: 'DEPLOYMENT_AREAS', content: { kind: 'PERMANENT', scope: ['u1'], site: null, primary: { p: 1 }, alternative: null, reason: '' } });
    expect(f.purpose).toBe('DEPLOYMENT_AREAS');
    expect(f.step).toBe(3);
    expect(isFlowPurpose('RESTATIONING')).toBe(true);
    expect(isFlowPurpose('DEPLOYMENT_AREAS')).toBe(true);
    expect(isFlowPurpose('SITE_REGISTRATION')).toBe(false);
    expect(isFlowPurpose(undefined)).toBe(false);
  });
});

describe('the farthest an area may be (owner, 25 Nov 2026)', () => {
  const allowances = { FLAT: 0, UNDULATING: 500, ROLLING: 1000, HILLY: 1500, MOUNTAINOUS: 2000 };
  const policy = { terrainAllowancesM: allowances, exception: { allowed: false, maxExtraM: 0 } };
  const primary = { minM: 5000, maxM: 8000, terrainApplies: true };

  it('is the base maximum with the most any ground can add before the place is known', () => {
    expect(largestTerrainAddM(primary, policy)).toBe(2000);
    expect(reachOf(primary, policy)).toEqual({ baseMaxM: 8000, terrainM: 2000, exceptionM: 0, maxM: 10000, assessed: false });
    expect(reachText(reachOf(primary, policy))).toContain('حتى');
  });

  it("is the server's effective maximum for the ground under a placed area, never less than the base", () => {
    expect(reachOf(primary, policy, 9000)).toEqual({ baseMaxM: 8000, terrainM: 1000, exceptionM: 0, maxM: 9000, assessed: true });
    expect(reachOf(primary, policy, 8000).maxM).toBe(8000);
    expect(reachText(reachOf(primary, policy, 9000))).not.toContain('حتى');
  });

  it("adds nothing when the terrain does not apply, a leg's own extra when it has one, and the exception margin when allowed", () => {
    expect(reachOf({ ...primary, terrainApplies: false }, policy).maxM).toBe(8000);
    expect(largestTerrainAddM({ ...primary, terrainExtra: { kind: 'PERCENT', value: 25 } }, policy)).toBe(2000);
    expect(largestTerrainAddM({ ...primary, terrainExtra: { kind: 'ABSOLUTE', value: 700 } }, policy)).toBe(700);
    expect(reachOf(primary, { ...policy, exception: { allowed: true, maxExtraM: 1000 } }).maxM).toBe(11000);
  });

  it('brings a point beyond the limit back on its own bearing, just inside it, and leaves a nearer point alone', () => {
    const o = { lat: 24.4, lng: 54.4 };
    const far = destination(o, 60, 22_200);
    const back = withinM(o, far, 7000);
    expect(distanceM(o, back)).toBeLessThan(7000);
    expect(distanceM(o, back)).toBeGreaterThan(6900);
    expect(distanceM(far, back)).toBeCloseTo(22_200 - distanceM(o, back), -1);
    const near = destination(o, 60, 4000);
    expect(withinM(o, near, 7000)).toBe(near);
  });
});

describe('a main area may go past its maximum with a warning; a sub-area may not (owner, 28 Nov 2026)', () => {
  const allowances = { FLAT: 0, UNDULATING: 500, ROLLING: 1000, HILLY: 1500, MOUNTAINOUS: 2000 };
  const withException = { terrainAllowancesM: allowances, exception: { allowed: true, maxExtraM: 1000 } };
  const leg = { minM: 5000, maxM: 8000, terrainApplies: true };

  it('stops only the sub-area at its farthest distance', () => {
    expect(STOPS_AT_REACH).toEqual({ primary: false, alternative: true });
    expect(BEYOND_MAX.tone).toBe('warn');
    expect(BEYOND_MAX.text).toContain('المعتمد النهائي');
  });

  it("the sub-area's limit keeps the exception margin; the main area's maximum leaves it out (the final approver decides past it)", () => {
    expect(reachFor('alternative', leg, withException)).toEqual(reachOf(leg, withException));
    expect(reachFor('alternative', leg, withException).maxM).toBe(11000);
    expect(reachFor('primary', leg, withException)).toEqual({ baseMaxM: 8000, terrainM: 2000, exceptionM: 0, maxM: 10000, assessed: false });
    // once the ground under it is assessed, the server's effective maximum there
    expect(reachFor('primary', leg, withException, 9000).maxM).toBe(9000);
    expect(reachText(reachFor('primary', leg, withException, 9000))).not.toContain('استثناء');
  });
});
