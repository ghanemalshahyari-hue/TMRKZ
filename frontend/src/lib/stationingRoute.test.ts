import { describe, expect, it } from 'vitest';
import { emptyRoute, ladder, makeFinal, patchLevel, previewRoute, routeGraph, setApproves, setLast, switchApproves, withLevels, withoutDuplicates } from './stationingRoute';

const LEVELS = [{ level: 7, units: 1, examples: [] }, { level: 8, units: 1, examples: [] }, { level: 9, units: 1, examples: [] }];

describe('the path of a stationing request on the studio', () => {
  it('assumes no level and no stage', () => {
    const r = emptyRoute(LEVELS);
    expect(r.routing.levels.every((l) => !l.approves && !l.finalStage)).toBe(true);
    expect(routeGraph(r).nodes.map((n) => n.id)).toEqual(['start', 'end']);
  });

  it('draws what approves, from the unit up to the last level, then the stages', () => {
    let r = emptyRoute(LEVELS);
    r = setApproves(r, 9, true);
    r = setLast(r, 8);
    r = { ...r, stages: { unitOperations: true, finalByPermission: true, fyiBeforeActivation: true } };
    expect(routeGraph(r).nodes.map((n) => n.id)).toEqual(['start', 'L9', 'L8', 'ops', 'fin', 'fyi', 'end']);
    expect(routeGraph(r).nodes.find((n) => n.id === 'fin')?.final).toBe(true);
    expect(routeGraph(r).nodes.find((n) => n.id === 'L8')?.final).toBe(false);
  });

  it('never reaches a level above the last one', () => {
    let r = setLast(emptyRoute(LEVELS), 8);
    r = setApproves(r, 7, true);
    expect(routeGraph(r).nodes.map((n) => n.id)).not.toContain('L7');
  });

  it('one level is the last, and it approves', () => {
    let r = setLast(emptyRoute(LEVELS), 8);
    r = setLast(r, 9);
    expect(r.routing.levels.filter((l) => l.finalStage).map((l) => l.level)).toEqual([9]);
    expect(r.routing.levels.find((l) => l.level === 9)?.approves).toBe(true);
    expect(setApproves(r, 9, false).routing.levels.find((l) => l.level === 9)?.finalStage).toBe(false);
  });

  it('keeps a saved path when Oracle adds a level', () => {
    const saved = setLast(emptyRoute(LEVELS.slice(1)), 8);
    const merged = withLevels(saved, LEVELS);
    expect(merged.routing.levels.map((l) => l.level)).toEqual([9, 8, 7]);
    expect(merged.routing.levels.find((l) => l.level === 8)?.finalStage).toBe(true);
    expect(merged.routing.levels.find((l) => l.level === 7)?.approves).toBe(false);
  });
});

describe('the ladder of levels on «سياسة التمركز»', () => {
  const R = (levels: { level: number; approves?: boolean; finalStage?: boolean; label?: string }[], startAt: 'SELF' | 'PARENT' = 'SELF') => ({
    startAt,
    levels: levels.map((l) => ({ approves: false, finalStage: false, label: '', dependsOn: [], ...l })),
  });

  it('lists every hierarchy level deepest first, with a level the hierarchy no longer has', () => {
    const rows = ladder(R([{ level: 12 }, { level: 8 }]), LEVELS);
    expect(rows.map((r) => r.level)).toEqual([12, 9, 8, 7]);
    expect(rows[0].info).toBeNull();
    expect(rows[1].cfg).toBeNull();
  });

  it('counts a repeated level by its first entry, and an edit drops the repeat', () => {
    const r = R([{ level: 8, label: 'أول' }, { level: 7 }, { level: 8, label: 'ثانٍ' }]);
    expect(ladder(r, LEVELS).find((x) => x.level === 8)).toMatchObject({ duplicates: 1, cfg: { label: 'أول' } });
    const next = patchLevel(r, 8, { approves: true });
    expect(next.levels.filter((l) => l.level === 8)).toEqual([expect.objectContaining({ label: 'أول', approves: true })]);
    expect(withoutDuplicates(r).levels.map((l) => l.label)).toEqual(['أول', '']);
  });

  it('names a level that starts approving, and a level that stops is no longer the last', () => {
    let r = switchApproves(R([]), 9, true);
    expect(r.levels).toEqual([expect.objectContaining({ level: 9, approves: true, label: 'اعتماد المستوى L9' })]);
    r = makeFinal(r, 9);
    r = switchApproves(r, 9, false);
    expect(r.levels[0]).toMatchObject({ approves: false, finalStage: false, label: 'اعتماد المستوى L9' });
  });

  it('keeps one last level, and it approves', () => {
    let r = makeFinal(R([{ level: 8, approves: true, label: 'اعتماد الإدارة' }]), 8);
    r = makeFinal(r, 7);
    expect(r.levels.filter((l) => l.finalStage).map((l) => l.level)).toEqual([7]);
    expect(r.levels.find((l) => l.level === 8)).toMatchObject({ approves: true, label: 'اعتماد الإدارة', finalStage: false });
  });

  it('previews what the server builds: from the unit or its parent, up to the last level', () => {
    const r = R([{ level: 9, approves: true }, { level: 8 }, { level: 7, approves: true, finalStage: true }]);
    const all = [7, 8, 9, 10];
    expect(previewRoute(r, all, 10).stages.map((s) => s.level)).toEqual([9, 7]);
    expect(previewRoute(r, all, 9)).toMatchObject({ stopped: true });
    expect(previewRoute({ ...r, startAt: 'PARENT' }, all, 9).stages.map((s) => s.level)).toEqual([7]);
    expect(previewRoute(r, [5, 6], 6)).toEqual({ stages: [], stopped: false });
  });
});
