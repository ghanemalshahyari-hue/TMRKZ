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

// ---- «مسار الاعتماد» on «سياسة التمركز»: the ladder of levels (owner redesign, 16 Nov 2026) -----------------------------

export type RoutingValue = RouteValues['routing'];
export const defaultLevelLabel = (level: number) => 'اعتماد المستوى L' + level;

export type LadderRow = { level: number; cfg: RoutingLevelValue | null; duplicates: number; info: HierarchyLevel | null };

/**
 * Every level the hierarchy has, and any configured level it no longer has, deepest first: the order a request climbs.
 * A level configured twice counts by its first entry, as on the server (RouteDerivation.derive).
 */
export function ladder(routing: RoutingValue, levels: HierarchyLevel[]): LadderRow[] {
  const numbers = new Set([...levels.map((l) => l.level), ...routing.levels.map((l) => l.level)]);
  return [...numbers]
    .sort((a, b) => b - a)
    .map((level) => {
      const all = routing.levels.filter((l) => l.level === level);
      return { level, cfg: all[0] ?? null, duplicates: Math.max(0, all.length - 1), info: levels.find((l) => l.level === level) ?? null };
    });
}

/** Changes one level: its first entry is patched, later entries of the same level dropped, a missing level added. */
export function patchLevel(routing: RoutingValue, level: number, patch: Partial<RoutingLevelValue>): RoutingValue {
  let seen = false;
  const out: RoutingLevelValue[] = [];
  for (const l of routing.levels) {
    if (l.level !== level) out.push(l);
    else if (!seen) {
      seen = true;
      out.push({ ...l, ...patch, level });
    }
  }
  if (!seen) out.push({ level, approves: false, label: '', finalStage: false, dependsOn: [], ...patch });
  return { ...routing, levels: out };
}

/** A level that starts approving gets the standing name «اعتماد المستوى Lx» if it has none; one that stops is no longer the last. */
export function switchApproves(routing: RoutingValue, level: number, approves: boolean): RoutingValue {
  const cur = routing.levels.find((l) => l.level === level);
  const label = approves && !cur?.label?.trim() ? defaultLevelLabel(level) : (cur?.label ?? '');
  return patchLevel(routing, level, { approves, label, finalStage: approves && !!cur?.finalStage });
}

/** One level closes the hierarchy, and it approves. */
export function makeFinal(routing: RoutingValue, level: number): RoutingValue {
  const cur = routing.levels.find((l) => l.level === level);
  const cleared = { ...routing, levels: routing.levels.map((l) => ({ ...l, finalStage: false })) };
  return patchLevel(cleared, level, { approves: true, finalStage: true, label: cur?.label?.trim() ? cur.label : defaultLevelLabel(level) });
}

/** Keeps the first entry of each level, the one the server reads. */
export function withoutDuplicates(routing: RoutingValue): RoutingValue {
  const seen = new Set<number>();
  return { ...routing, levels: routing.levels.filter((l) => !seen.has(l.level) && !!seen.add(l.level)) };
}

/**
 * The hierarchy stages the server builds for a request from a unit at level `from` whose ancestors sit on the levels above
 * it (RouteDerivation.derive): from the unit itself or its parent, every approving level, up to and including the last one.
 */
export function previewRoute(routing: RoutingValue, levels: number[], from: number): { stages: RoutingLevelValue[]; stopped: boolean } {
  const walk = levels.filter((l) => (routing.startAt === 'PARENT' ? l < from : l <= from)).sort((a, b) => b - a);
  const stages: RoutingLevelValue[] = [];
  for (const level of walk) {
    const cfg = routing.levels.find((l) => l.level === level);
    if (cfg?.approves) stages.push(cfg);
    if (cfg?.finalStage) return { stages, stopped: true };
  }
  return { stages, stopped: false };
}
