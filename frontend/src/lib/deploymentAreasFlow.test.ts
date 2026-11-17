import { describe, expect, it } from 'vitest';
import { AREA_NAME, areaStepProblem, campTree, overReason, startStep, unitChoices, unitForest, verdictOf } from './deploymentAreasFlow';

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
