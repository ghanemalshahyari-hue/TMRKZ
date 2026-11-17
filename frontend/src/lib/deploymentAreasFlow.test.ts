import { describe, expect, it } from 'vitest';
import {
  AREA_NAME, RESTATION_STEPS, areaStepProblem, areaVerdict, campTree, flowStepProblem, measuredFrom, overReason, requestingUnitOf, restationingChoices, siteShapeKind, startStep, unitChoices, unitForest, verdictOf,
} from './deploymentAreasFlow';

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
    expect(startStep(unitChoices([unit('a', 'DEPLOYMENT_MISSING'), unit('c', 'DEPLOYMENT_REQUEST_PENDING')]))).toEqual({ step: 2, unitId: 'a' });
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
