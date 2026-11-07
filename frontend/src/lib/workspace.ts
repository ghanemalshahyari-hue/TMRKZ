import type { Ref, RestationingChecks, RestationingLeg, RestationingRequest, RestationingState, SiteGeometry } from '../api/types';
import { distanceM } from './geo';
import { centre } from './requestMap';

/**
 * What the Stationing operational workspace shows, derived only from what the server returned (owner brief «FULL
 * APPLICATION UI REBUILD», §10–§18). Pure functions, so the rules of the screen are tested without a browser:
 * - the approval strip is the request's own route (no level is assumed);
 * - distance rules exist only for deployment (leg 1: stationing site → primary area, leg 2: primary → alternative);
 * - the distance between the current site and the proposed re-stationing site is information, never a rule.
 */

export type StripStatus = 'done' | 'carried' | 'current' | 'upcoming' | 'rejected' | 'returned';
export type StripNode = {
  key: string;
  label: string;
  unit: string | null;
  person: string | null;
  at: string | null;
  status: StripStatus;
  note: string | null;
  final: boolean;
};

const ACTIVATED: RestationingState[] = ['ACTIVATED_PERMANENT', 'TEMPORARY_SCHEDULED', 'ACTIVE_TEMPORARY', 'TEMPORARY_RETURNED', 'EXTENSION_ACTIVATED', 'START_HELD_PENDING_CANCELLATION'];

/**
 * The approval strip: the requester, then every stage of the current route in order (or, before the first submission,
 * the route the server expects), then the independent activation. Statuses come from the stages' marks and the
 * request state only.
 */
export function routeStrip(r: RestationingRequest, checks: RestationingChecks | null): { nodes: StripNode[]; expected: boolean } {
  const submitted = r.revisions.length > 0 && r.state !== 'DRAFT';
  const requesterActs = r.state === 'DRAFT' || r.state === 'RETURNED_FOR_CHANGES';
  const nodes: StripNode[] = [
    {
      key: 'requester',
      label: 'مقدم الطلب',
      unit: r.requestingUnit.name || null,
      person: r.requester.name || null,
      at: r.revisions[0]?.submittedAt ?? null,
      status: requesterActs ? 'current' : submitted ? 'done' : 'upcoming',
      note: r.state === 'RETURNED_FOR_CHANGES' ? 'أُعيد إليه للتعديل' : r.state === 'DRAFT' ? 'مسودة لم تُرسل' : null,
      final: false,
    },
  ];
  const expected = r.route.length === 0;
  if (!expected) {
    let rejectedPlaced = false;
    for (const s of r.route) {
      let status: StripStatus = s.mark === 'APPROVED' ? 'done' : s.mark === 'CARRIED' ? 'carried' : s.current ? 'current' : 'upcoming';
      if (r.state === 'REJECTED' && !s.mark && !rejectedPlaced) {
        status = 'rejected';
        rejectedPlaced = true;
      } else if (r.state === 'RETURNED_FOR_CHANGES' && !s.mark && r.returned?.stageLabel === s.label) status = 'returned';
      nodes.push({
        key: s.key,
        label: s.label,
        unit: s.unit?.name ?? null,
        person: s.decidedBy?.name ?? null,
        at: s.decidedAt,
        status,
        note: s.kind === 'EXCEPTION' ? 'استثناء مسافة الانتشار' : s.kind === 'CROSS_BRANCH' ? 'جهة من فرع آخر' : s.mark === 'CARRIED' ? 'محمول من قرار سابق' : null,
        final: s.final,
      });
    }
  } else {
    for (const s of checks?.route ?? []) {
      nodes.push({ key: s.key, label: s.label, unit: s.unit?.name ?? null, person: null, at: null, status: 'upcoming', note: 'متوقع عند الإرسال', final: s.final });
    }
  }
  // a stage of this request only: FYI appears when the policy asked for it or it was done (ADR-045)
  if (r.fyi && (r.fyi.required || r.fyi.doneAt)) {
    nodes.push({
      key: 'fyi',
      label: 'توزيع للعلم',
      unit: null,
      person: r.fyi.doneBy,
      at: r.fyi.doneAt,
      status: r.fyi.doneAt ? 'done' : 'current',
      note: r.fyi.doneAt ? (r.fyi.units.join('، ') || 'لا وحدات') : 'ليس تصويتاً',
      final: false,
    });
  }
  nodes.push({
    key: 'activation',
    label: r.requestKind === 'EXTENSION' ? 'تفعيل التمديد' : 'التفعيل',
    unit: null,
    person: r.activation?.by.name ?? null,
    at: r.activation?.at ?? null,
    status: ACTIVATED.includes(r.state) || r.activation ? 'done' : r.state === 'APPROVED_NOT_ACTIVATED' && !r.fyi?.required ? 'current' : 'upcoming',
    note: 'إجراء مستقل',
    final: false,
  });
  return { nodes, expected };
}

const km = (m: number | null | undefined) => (m == null ? '—' : (m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 1 }));

export type DeploymentRow = {
  leg: 'primary' | 'alternative';
  title: string;
  from: string;
  distance: string;
  range: string;
  verdict: string;
  tone: 'ok' | 'warn' | 'bad' | 'none';
  terrain: string | null;
  effectiveMax: string;
  exception: boolean;
  conflicts: string[];
};

const VERDICT: Record<RestationingLeg['status'], [string, DeploymentRow['tone']]> = {
  NOT_PLACED: ['غير موضوعة', 'none'],
  OK: ['ضمن النطاق', 'ok'],
  NEEDS_EXCEPTION: ['تحتاج استثناء مسافة الانتشار', 'warn'],
  OUT_OF_RANGE: ['خارج نطاق مسافة الانتشار', 'bad'],  // completed with the range below
  TERRAIN_TIE_UNRESOLVED: ['تعادل فئات أرض دون أولوية', 'bad'],
};

/**
 * The deployment check card (§18): one row per leg, exactly as the server measured it under the locked policy —
 * «6.3 كم — ضمن 5–8 كم», the terrain class and allowance, the effective maximum, an exception when one is needed.
 * There is no row, range or verdict for the re-stationing move itself.
 */
export function deploymentRows(checks: RestationingChecks | null): DeploymentRow[] {
  return (checks?.legs ?? []).map((l) => {
    const [verdict, tone] = VERDICT[l.status];
    return {
      leg: l.leg,
      title: l.leg === 'primary' ? 'منطقة الانتشار الرئيسية' : 'منطقة الانتشار البديلة',
      from: l.leg === 'primary' ? 'من مركز موقع التمركز' : 'من مركز منطقة الانتشار الرئيسية',
      distance: l.distanceM == null ? '—' : `${km(l.distanceM)} كم`,
      range: `${km(l.baseMinM)}–${km(l.baseMaxM)} كم`,
      verdict:
        l.status === 'OK'
          ? `ضمن ${km(l.baseMinM)}–${km(l.baseMaxM)} كم` + (l.effectiveMaxM !== l.baseMaxM ? ` (حتى ${km(l.effectiveMaxM)} كم مع الأرض)` : '')
          : l.status === 'OUT_OF_RANGE'
            ? `خارج ${km(l.effectiveMinM)}–${km(l.effectiveMaxM)} كم`
            : verdict,
      tone,
      terrain: l.terrain ? `${l.terrain.controllingLabel} +${km(l.terrain.allowanceM)} كم` : null,
      effectiveMax: `${km(l.effectiveMaxM)} كم`,
      exception: l.status === 'NEEDS_EXCEPTION',
      conflicts: l.conflicts,
    };
  });
}

/** The move from each current site to the proposed re-stationing site: a distance for information, nothing else. */
export type MovementInfo = { from: string; km: string };
export function movementInfo(r: RestationingRequest): MovementInfo[] {
  const to = r.content.site?.geometry;
  if (!to) return [];
  const b = centre(to);
  return r.currentSites
    .filter((s) => s.geometry?.type === 'Polygon' || s.geometry?.type === 'MultiPolygon')
    .map((s) => ({ from: s.site.name, km: km(distanceM(centre(s.geometry as SiteGeometry), b)) + ' كم' }));
}

// ---- organisation tree (right context panel) ------------------------------------------------------------------------

export type TreeUnit = { id: string; name: string; code?: string; parentId: string | null };
export type TreeRow = { id: string; name: string; code?: string; depth: number; hasChildren: boolean; open: boolean; highlight: 'requesting' | 'moving' | null };

/**
 * The visible rows of the organisation tree exactly as the server returned it (its order, its parents; no level is
 * assumed). The branch down to the requesting unit opens by default; `toggled` flips any other unit.
 */
export function treeRows(units: TreeUnit[], opts: { requesting?: string | null; moving?: string[]; toggled?: Set<string> } = {}): TreeRow[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const kids = new Map<string | null, TreeUnit[]>();
  for (const u of units) {
    const p = u.parentId && byId.has(u.parentId) ? u.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), u]);
  }
  const path = new Set<string>();
  for (let id = opts.requesting ?? null; id && byId.has(id); id = byId.get(id)!.parentId) path.add(id);
  const moving = new Set(opts.moving ?? []);
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const u of kids.get(parent) ?? []) {
      const hasChildren = (kids.get(u.id)?.length ?? 0) > 0;
      const byDefault = depth === 0 || (path.has(u.id) && u.id !== opts.requesting);
      const open = hasChildren && (opts.toggled?.has(u.id) ? !byDefault : byDefault);
      out.push({ id: u.id, name: u.name, code: u.code, depth, hasChildren, open, highlight: u.id === opts.requesting ? 'requesting' : moving.has(u.id) ? 'moving' : null });
      if (open) walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The ancestry path of a unit in the tree, root first (for the context panel's heading). */
export function pathOf(units: TreeUnit[], id: string | null | undefined): Ref[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const out: Ref[] = [];
  for (let cur = id ?? null; cur && byId.has(cur); cur = byId.get(cur)!.parentId) out.unshift({ id: cur, name: byId.get(cur)!.name });
  return out;
}
