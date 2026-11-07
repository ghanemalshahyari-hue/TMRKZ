import { describe, expect, it } from 'vitest';
import { emptyRoute, routeGraph, setApproves, setLast, withLevels } from './stationingRoute';

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
