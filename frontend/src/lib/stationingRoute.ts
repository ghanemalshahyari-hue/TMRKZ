import type { FlowGraph, FlowNode, HierarchyLevel, RoutingLevelValue, StationingFact } from '../api/types';
import { autoLayout } from './flowGraph';

export type RouteStages = { unitOperations: boolean; finalByPermission: boolean; fyiBeforeActivation: boolean };
export type RouteValues = { routing: { startAt: 'SELF' | 'PARENT'; levels: RoutingLevelValue[] }; stages: RouteStages };

const ALL_FACTS: StationingFact[] = ['SCOPE', 'SITE', 'DURATION', 'DEPLOYMENT', 'AVAILABILITY', 'CLASSIFICATION'];

/** Nothing decided: every level Oracle sends, none approving. No level or person is assumed. */
export function emptyRoute(levels: HierarchyLevel[]): RouteValues {
  return {
    routing: { startAt: 'SELF', levels: levels.map((l) => ({ level: l.level, approves: false, label: 'اعتماد المستوى L' + l.level, finalStage: false, dependsOn: ALL_FACTS })) },
    stages: { unitOperations: false, finalByPermission: false, fyiBeforeActivation: false },
  };
}

/** A saved path with the levels Oracle sends today: a new level appears, not approving. */
export function withLevels(route: RouteValues, levels: HierarchyLevel[]): RouteValues {
  const known = new Map(route.routing.levels.map((l) => [l.level, l]));
  const blank = emptyRoute(levels).routing.levels;
  const merged = blank.map((b) => known.get(b.level) ?? b);
  for (const l of route.routing.levels) if (!merged.some((m) => m.level === l.level)) merged.push(l);
  return { ...route, routing: { ...route.routing, levels: merged.sort((a, b) => b.level - a.level) } };
}

export const setApproves = (r: RouteValues, level: number, approves: boolean): RouteValues => ({
  ...r,
  routing: { ...r.routing, levels: r.routing.levels.map((l) => (l.level === level ? { ...l, approves, finalStage: approves && l.finalStage } : l)) },
});

/** One level closes the hierarchy, and it must approve. */
export const setLast = (r: RouteValues, level: number): RouteValues => ({
  ...r,
  routing: { ...r.routing, levels: r.routing.levels.map((l) => (l.level === level ? { ...l, approves: true, finalStage: true } : { ...l, finalStage: false })) },
});

export const setLabel = (r: RouteValues, level: number, label: string): RouteValues => ({
  ...r,
  routing: { ...r.routing, levels: r.routing.levels.map((l) => (l.level === level ? { ...l, label } : l)) },
});

/** The path as the studio's chart, from the unit upward: what the server will build. It is drawn, not dragged. */
export function routeGraph(r: RouteValues): FlowGraph {
  const steps: FlowNode[] = [];
  const last = r.routing.levels.find((l) => l.finalStage);
  // units climb from the deepest level number to the top; levels past the last one are never reached
  const ordered = [...r.routing.levels].sort((a, b) => b.level - a.level);
  for (const l of ordered) {
    if (last && l.level < last.level) continue;
    if (l.approves) steps.push({ id: 'L' + l.level, type: 'approval', name: l.label, x: 0, y: 0, final: !r.stages.finalByPermission && l.finalStage });
  }
  if (r.stages.unitOperations && last) steps.push({ id: 'ops', type: 'approval', name: 'اعتماد عمليات الوحدة', x: 0, y: 0 });
  if (r.stages.finalByPermission && last) steps.push({ id: 'fin', type: 'approval', name: 'الاعتماد النهائي', x: 0, y: 0, final: true });
  if (r.stages.fyiBeforeActivation) steps.push({ id: 'fyi', type: 'notify', name: 'توزيع للعلم', x: 0, y: 0, recipients: [] } as FlowNode);
  const start: FlowNode = { id: 'start', type: 'start', name: 'بداية الطلب', x: 0, y: 0 };
  const end: FlowNode = { id: 'end', type: 'end_approved', name: 'التفعيل', x: 0, y: 0 };
  const nodes = [start, ...steps, end];
  const edges = nodes.slice(1).map((n, i) => {
    const from = nodes[i];
    return from.type === 'approval' ? { from: from.id, to: n.id, when: 'approved' as const } : { from: from.id, to: n.id };
  });
  return autoLayout({ nodes, edges });
}
