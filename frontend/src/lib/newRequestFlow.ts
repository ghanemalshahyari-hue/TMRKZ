import type { RestationingUnit, StationingRecord } from '../api/types';

/**
 * The map-first re-stationing request (owner correction of 5 Nov 2026): MAP FIRST → the current site → the units
 * stationed there → who moves → the type → the new site on the map → deployment → check and review. Staged: a step
 * opens only when every step before it is complete, and the person sees one step's question at a time.
 */
export const FLOW_STEPS = ['الموقع الحالي', 'الوحدات', 'نوع التمركز', 'الموقع الجديد', 'الانتشار', 'الفحص والمراجعة'] as const;
export type FlowStep = 1 | 2 | 3 | 4 | 5 | 6;

export type FlowInput = {
  /** The current site the person confirmed («بدء طلب إعادة تمركز من هذا الموقع»). */
  site: boolean;
  /** Units chosen to move (none is chosen by itself). */
  units: number;
  kind: 'PERMANENT' | 'TEMPORARY';
  start?: string | null;
  end?: string | null;
  /** The proposed re-stationing site exists (copied or drawn). */
  proposed: boolean;
  primary: boolean;
  alternative: boolean;
};

/** Which of the six steps are complete. Deployment counts as complete with both areas; review is never "complete". */
export function completed(i: FlowInput): boolean[] {
  const units = i.site && i.units > 0;
  const kind = units && (i.kind === 'PERMANENT' || (!!i.start && !!i.end));
  return [i.site, units, kind, kind && i.proposed, kind && i.proposed && i.primary && i.alternative, false];
}

/** A step may be opened when every step before it is complete (deployment may be left for review to report). */
export function canOpen(i: FlowInput, step: FlowStep): boolean {
  const done = completed(i);
  for (let k = 0; k < step - 1; k++) if (!done[k] && k !== 4) return false;
  return true;
}

/** The step a session starts at: the first one still open. */
export function firstOpen(i: FlowInput): FlowStep {
  const done = completed(i);
  const k = done.findIndex((d, idx) => !d && idx < 5);
  return (k < 0 ? 6 : k + 1) as FlowStep;
}

export type UnitHere = { orgId: string; orgName: string; kind: 'PERMANENT' | 'TEMPORARY'; since: string; requestable: boolean };

/**
 * The units stationed now at one site (the authoritative register, `/stationing/current`), each once, in the register's
 * order, marked when the person may request for it. Only these are offered — never the whole hierarchy.
 */
export function unitsAtSite(current: StationingRecord[], siteId: string | null, options: RestationingUnit[] = []): UnitHere[] {
  if (!siteId) return [];
  const mine = new Set(options.map((u) => u.id));
  const out: UnitHere[] = [];
  for (const c of current) {
    if (c.siteId !== siteId || out.some((u) => u.orgId === c.orgId)) continue;
    out.push({ orgId: c.orgId, orgName: c.orgName, kind: c.kind, since: c.validFrom, requestable: mine.has(c.orgId) });
  }
  return out;
}

/**
 * The unit the request comes from (the route starts there), derived — never the first question: the deepest unit
 * among the person's options whose branch holds every moving unit the person may request for, preferring a parent over
 * the unit itself (a unit moves, its parent asks). Null when none of the moving units is among the options.
 */
export function deriveRequesting(options: RestationingUnit[], moving: string[]): string | null {
  const byId = new Map(options.map((u) => [u.id, u]));
  const mine = moving.filter((id) => byId.has(id));
  if (mine.length === 0) return null;
  const chain = (id: string) => {
    const out: string[] = [];
    for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.push(cur.id);
    return out;
  };
  const chains = mine.map(chain);
  const common = chains[0].filter((id) => chains.every((c) => c.includes(id)));
  if (common.length === 0) return null;
  // the deepest common unit; when that is a moving unit itself, its parent asks if the person may request for it
  const deepest = common[0];
  if (mine.includes(deepest) && common.length > 1) return common[1];
  return deepest;
}
