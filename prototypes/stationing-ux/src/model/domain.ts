// The stationing domain model V2 (docs/STATIONING_DOMAIN_MODEL_V2_AR.md, 7th revision) as a pure, simulated state machine
// for the isolated prototype. Every rule the server would enforce is a guard here, so the screens can show which action
// is possible for which simulated person and why not. Nothing is persisted; no server is called.
// Owner correction of 3 Nov 2026: a re-stationing request has ONE proposed site (no primary/alternative relocation
// candidates), with an optional deployment package (primary and alternative deployment areas); its approval path is
// derived from the organisation hierarchy and a route policy.
import { areaM2, formatArea, kinks, ringsIntersect, pointInRing, centroid, type Ring } from '../../../../frontend/src/lib/footprint';
import { formatKm } from '../../../../frontend/src/lib/geo';
import { orgById } from '../data';
import { centreDistance, nearest } from './geometry';

export const DAY = 86_400_000;

export type Perm =
  | 'CREATE'
  | 'APPROVE_HIERARCHY'
  | 'REVIEW'
  | 'APPROVE'
  | 'MANAGE_STATIONING'
  | 'MANAGE_STATIONING_POLICY'
  | 'MANAGE_REQUEST_ROUTING'
  | 'ACTIVATE_STATIONING'
  | 'ACTIVATE_TEMPORARY_EXTENSION'
  | 'DECIDE_EARLY_RETURN'
  | 'DECIDE_PRE_ACTIVATION_CANCELLATION'
  | 'DECIDE_TEMPORARY_BEFORE_START_CANCELLATION'
  | 'APPROVE_AVAILABILITY_EXCEPTION';

/** A sign-in. `human` is the stable identity (linked accounts share it); `actingFor` is a delegation. */
export type Person = { id: string; name: string; title: string; account: string; human: string; actingFor?: string; perms: Perm[]; scope: string[] };

export type Site = { id: string; name: string; ring: Ring; lat: number; lng: number; registered: boolean };

export type Stationing = {
  id: string;
  org: string;
  kind: 'PERMANENT' | 'TEMPORARY';
  baseId?: string;
  siteId: string;
  /**
   * CANCELLED_BEFORE_START: activated, then cancelled before its start — it never became effective (A4).
   * WINDOW_EXPIRED_WITHOUT_START: its start was held by a pending start cancellation until its planned end passed — it
   * never became effective either (A6).
   */
  state: 'CURRENT' | 'ENDED' | 'SCHEDULED' | 'ACTIVE' | 'CANCELLED_BEFORE_START' | 'WINDOW_EXPIRED_WITHOUT_START';
  /** The effective start; for a temporary record it differs from `plannedStart` only when its start was held. */
  from: number;
  to?: number;
  /** The approved start (kept unchanged; a held start never backdates `from`). */
  plannedStart?: number;
  /** The start cancellation whose rejection after the planned start made this record effective at `from`. */
  startRef?: string;
  plannedEnd?: number;
  actualEnd?: number;
  endReason?: 'EXPIRED' | 'EARLY_RETURN' | 'SUPERSEDED_BY_EXTENSION' | 'SUPERSEDED_BY_PERMANENT_STATIONING' | 'REPLACED_BY_ACTIVATION';
  /** What ended it: the activation reference of the permanent relocation, or the decision. */
  endRef?: string;
  requestId?: string;
  extendsId?: string;
  /** covered_organization_scope: the units this stationing context covers, listed explicitly — never inferred (A2). */
  covered?: string[];
};

/** A deployment area of a stationing context (technical grouping `stationing_area`); shown as «منطقة الانتشار …». */
export type Area = {
  id: string;
  stationingId: string;
  org: string;
  role: 'PRIMARY_AREA' | 'ALTERNATIVE_AREA';
  status: 'ACTIVE' | 'RETIRED';
  ring: Ring;
  validFrom: number;
  validTo?: number;
  retiredAt?: number;
  provenance: { kind: 'IN_APP_REQUEST'; request: string } | { kind: 'EXTERNAL_DECISION'; authority: string; reference: string; date: number; registeredBy: string };
};
export type AreaRole = Area['role'];

// ---- published configuration: profiles, policies, route ----

export type Range = { min: number; max: number };
/**
 * NEAREST_GEOMETRY: the shortest distance between the actual geometries, 0 when they touch or overlap (owner correction
 * §6). CENTROID: centre to centre — published by profile version 1 and kept only for requests pinned to it.
 */
export type Measure = 'NEAREST_GEOMETRY' | 'CENTROID';
/** A published policy profile: the two deployment-area relations and the measurement method. Versions never change. */
export type GeoProfile = { version: number; name: string; reference: string; publishedAt: number; measure: Measure; siteToPrimaryArea: Range; primaryAreaToAlternativeArea: Range };

export type PolicyKey = 'stationing_areas_requirement' | 'max_restationing_footprint_area';
export type AreasRequirement = 'REQUIRED' | 'OPTIONAL';
/** One version of an administrative policy (append-only). The footprint limit is in square metres. */
export type PolicyVersion = { key: PolicyKey; version: number; value: AreasRequirement | number; previous?: AreasRequirement | number; effectiveFrom: number; changedBy: string; changedAt: number; reason: string };
/** What a submitted request keeps: pinned at its first submission, never changed by a later version. */
export type PinnedPolicy = { areas: { version: number; value: AreasRequirement }; maxArea: { version: number; value: number }; profile: number; route: number; pinnedAt: number };

export type Duration = 'PERMANENT' | 'TEMPORARY';
export type Fact = 'SCOPE' | 'CLASSIFICATION' | 'DURATION' | 'SITE' | 'AVAILABILITY';
/**
 * The route policy of re-stationing requests. Like the application's workflow assignees («ROLE|organisation» slots), a
 * stage is decided by whoever holds the role for its organisation; the hierarchy part adds one slot per organisational
 * level — never a fixed number of levels.
 */
export type RoutePolicy = {
  version: number;
  reference: string;
  /** One approval by the assigned approver of every organisation between the requester and the final scope. */
  hierarchy: { perm: Perm; dependsOn: Fact[] };
  /** Configured reviews after the hierarchy, by request type. */
  functional: { key: string; name: string; perm: Perm; dependsOn: Fact[]; types: Duration[] }[];
  /** The final approver's scope: the institution, or the requester's top-level directorate. */
  final: Record<Duration, 'ROOT' | 'TOP_LEVEL'>;
};

export type StageKind = 'HIERARCHY' | 'FUNCTIONAL' | 'ADDED' | 'FINAL';
export type Stage = {
  key: string;
  name: string;
  kind: StageKind;
  perm: Perm;
  /** HIERARCHY/ADDED: the organisation whose assigned approver decides; FINAL: the final scope. */
  org?: string;
  why: string;
  final?: boolean;
  dependsOn: Fact[];
  mark?: 'APPROVED' | 'CARRIED' | 'INVALIDATED';
  by?: string;
};

/** An authorised change of the system-derived routing (MANAGE_REQUEST_ROUTING), always audited. */
export type RouteChange = { at: number; by: string; op: 'ADD_APPROVER' | 'ADD_RECIPIENT' | 'REMOVE_RECIPIENT'; org: string; reason: string };

/** The ONE proposed re-stationing site, with its optional deployment package. */
export type Proposal = { name: string; ring: Ring; siteId: string | null; areas?: Partial<Record<AreaRole, Ring>> };

export type RelState =
  | 'DRAFT'
  | 'UNDER_REVIEW'
  | 'RETURNED_FOR_CHANGES'
  | 'REJECTED'
  | 'APPROVED_NOT_ACTIVATED'
  | 'CANCELLATION_PENDING'
  | 'CANCELLED_BEFORE_ACTIVATION'
  | 'ACTIVATED_PERMANENT'
  | 'TEMPORARY_SCHEDULED'
  | 'START_HELD_PENDING_CANCELLATION'
  | 'TEMPORARY_CANCELLED_BEFORE_START'
  | 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START'
  | 'ACTIVE_TEMPORARY'
  | 'TEMPORARY_ENDED'
  | 'CLOSED';

export type Request = {
  id: string;
  number: string;
  org: string;
  scope: { whole: boolean; units: string[] };
  duration: { type: Duration; start: number; end?: number };
  fromSiteId: string;
  proposal: Proposal;
  state: RelState;
  requester: string;
  finalApprover?: string;
  /** Frozen at submission from the derived route; an added approver is inserted before the final decision. */
  stages: Stage[];
  cursor: number;
  routeChanges: RouteChange[];
  /** What was submitted, to tell which facts a resubmission changed (D18). */
  submitted?: { scope: Request['scope']; duration: Request['duration']; proposal: Proposal };
  rejection?: { by: string; reason: string; at: number };
  cancellation?: { state: 'PENDING' | 'APPROVED' | 'REJECTED'; by: string; reason: string; decidedBy?: string; decision?: string };
  /** Active or scheduled temporary stationings in scope, shown to the final approver: they end at activation (D13). */
  supersedes?: string[];
  /** The permanent records of the scope at final approval; activation is refused if they changed. */
  approvedSnapshot?: string[];
  activation?: { by: string; at: number; ref: string };
  /** Policy versions in force when the draft was opened (a later change is shown to the requester). */
  createdUnder?: { areas: number; maxArea: number };
  policy?: PinnedPolicy;
};

export type ExtState = 'SUBMITTED' | 'EXTENSION_APPROVED_NOT_ACTIVATED' | 'EXTENSION_ACTIVATED' | 'LAPSED_NOT_ACTIVATED' | 'CANCELLATION_PENDING' | 'CANCELLED_BEFORE_ACTIVATION';
export type Extension = { id: string; number: string; parent: string; newEnd: number; state: ExtState; requester: string; finalApprover?: string; lapsedAt?: number; lapseReason?: string };
export type EarlyReturn = { id: string; request: string; state: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED'; by: string; reason: string; decidedBy?: string; originalEnd: number; actualEnd?: number };
/**
 * «إلغاء التمركز المؤقت قبل بدء النفاذ» (A4) — not an early return: nothing was ever effective. While it is pending at
 * the planned start, the start is held (`heldAt`); if the window closes first it is NO_LONGER_ACTIONABLE (A6).
 */
export type StartCancellation = {
  id: string;
  request: string;
  state: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'NO_LONGER_ACTIONABLE';
  by: string;
  reason: string;
  decidedBy?: string;
  decision?: string;
  decidedAt?: number;
  activationRef: string;
  plannedStart: number;
  plannedEnd: number;
  heldAt?: number;
  effectiveStart?: number;
  closedAt?: number;
  closeReason?: string;
};
/** An administrative reservation of a geographic area, checked for availability (D4, A2). */
export type Reservation = {
  id: string;
  number: string;
  org: string;
  name: string;
  ring: Ring;
  from: number;
  to: number;
  state: 'PROPOSED' | 'BLOCKED' | 'EXCEPTION_REQUESTED' | 'ACTIVE' | 'REJECTED';
  requester: string;
  exception?: { reason: string; policyRef: string; requestedBy: string; decidedBy?: string; decision?: string; approved?: boolean };
};

export type Event = { at: number; actor: string; type: string; ref: string; detail: string; data?: Record<string, string> };

export type World = {
  now: number;
  orgParent: Record<string, string | null>;
  people: Person[];
  sites: Site[];
  stationings: Stationing[];
  areas: Area[];
  requests: Request[];
  extensions: Extension[];
  earlyReturns: EarlyReturn[];
  startCancellations: StartCancellation[];
  reservations: Reservation[];
  /** Reminder offsets before the end of a temporary stationing, from the (fictional) published reminder policy (D11). */
  reminderOffsets: number[];
  profiles: GeoProfile[];
  policies: PolicyVersion[];
  route: RoutePolicy;
  events: Event[];
};

export type Action =
  | { t: 'SUBMIT'; req: string }
  | { t: 'APPROVE_STAGE'; req: string }
  | { t: 'REJECT'; req: string; reason: string }
  | { t: 'RETURN'; req: string; reason: string }
  | { t: 'RESUBMIT'; req: string; changed: Fact[]; reason: string }
  | { t: 'ROUTE_CHANGE'; req: string; op: RouteChange['op']; org: string; reason: string }
  | { t: 'ACTIVATE'; req: string; reason?: string }
  | { t: 'REQUEST_CANCEL'; req: string; reason: string }
  | { t: 'DECIDE_CANCEL'; req: string; approve: boolean; reason: string }
  | { t: 'REQUEST_EXTENSION'; req: string; newEnd: number }
  | { t: 'APPROVE_EXTENSION'; ext: string }
  | { t: 'ACTIVATE_EXTENSION'; ext: string; reason?: string }
  | { t: 'REQUEST_EARLY_RETURN'; req: string; reason: string }
  | { t: 'DECIDE_EARLY_RETURN'; er: string; approve: boolean; reason: string }
  | { t: 'REQUEST_START_CANCEL'; req: string; reason: string }
  | { t: 'DECIDE_START_CANCEL'; sc: string; approve: boolean; reason: string }
  | { t: 'CONFIRM_RESERVATION'; res: string }
  | { t: 'REQUEST_EXCEPTION'; res: string; reason: string; policyRef: string }
  | { t: 'DECIDE_EXCEPTION'; res: string; approve: boolean; reason: string }
  | { t: 'SET_POLICY'; key: PolicyKey; value: AreasRequirement | number; effectiveFrom: number; reason: string }
  /** The later, separate process for a stationing without deployment areas: an external decision (MANAGE_STATIONING, D5). */
  | { t: 'REGISTER_AREAS'; stationing: string; primary: Ring; alternative: Ring; authority: string; reference: string; reason: string }
  | { t: 'TICK'; to: number };

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });
const yes: Verdict = { ok: true };

export const orgName = (id: string | undefined) => (id ? (orgById.get(id)?.name ?? id) : '—');
export const AREA_LABEL: Record<AreaRole, string> = { PRIMARY_AREA: 'منطقة الانتشار الرئيسية', ALTERNATIVE_AREA: 'منطقة الانتشار البديلة' };

// ---- identity, scope, permissions ----

export const person = (w: World, id: string) => w.people.find((p) => p.id === id);

/** Every human an act by this sign-in is attributed to: its own, and the delegator's (invariant 8). */
export function humansOf(w: World, id: string | undefined): Set<string> {
  const out = new Set<string>();
  let p = id ? person(w, id) : undefined;
  for (let i = 0; p && i < 5; i++) {
    out.add(p.human);
    p = p.actingFor ? person(w, p.actingFor) : undefined;
  }
  return out;
}
export const sameHuman = (w: World, a: string | undefined, b: string | undefined) => {
  if (!a || !b) return false;
  const hb = humansOf(w, b);
  return [...humansOf(w, a)].some((h) => hb.has(h));
};

export function within(w: Pick<World, 'orgParent'>, org: string, root: string): boolean {
  for (let cur: string | null = org; cur; cur = w.orgParent[cur] ?? null) if (cur === root) return true;
  return false;
}
export function descendants(w: Pick<World, 'orgParent'>, org: string): string[] {
  const out: string[] = [];
  for (const [id, parent] of Object.entries(w.orgParent)) if (parent && within(w, id, org) && id !== org) out.push(id);
  return out;
}
export const holds = (w: World, actor: string, perm: Perm, org: string) => {
  const p = person(w, actor);
  return !!p && p.perms.includes(perm) && p.scope.some((root) => within(w, org, root));
};

export const unitsOf = (w: World, r: Request) => (r.scope.whole ? [r.org, ...descendants(w, r.org)] : r.scope.units);
export const permanentOf = (w: World, org: string) => w.stationings.find((s) => s.org === org && s.kind === 'PERMANENT' && s.state === 'CURRENT');
/** The temporary stationing in force (an active segment, also an extension's) or scheduled to start. */
export const temporaryOf = (w: World, org: string) =>
  w.stationings.find((s) => s.org === org && s.kind === 'TEMPORARY' && s.state === 'ACTIVE') ??
  w.stationings.find((s) => s.org === org && s.kind === 'TEMPORARY' && s.state === 'SCHEDULED' && !s.extendsId);
export const effectiveOf = (w: World, org: string) => w.stationings.find((s) => s.org === org && s.kind === 'TEMPORARY' && s.state === 'ACTIVE') ?? permanentOf(w, org);

// ---- availability: deployment areas block, except inside their explicitly covered scope (D4, A2) ----

/** covered_organization_scope of a stationing context: its explicit list, otherwise only its own organisation. */
export const coveredBy = (w: World, stationingId: string) => {
  const s = w.stationings.find((x) => x.id === stationingId);
  return s ? (s.covered ?? [s.org]) : [];
};

export type Clash = { kind: 'AREA' | 'RESERVATION'; id: string; label: string; owner: string; from: number; to?: number; exempt: boolean };
const overlaps = (a0: number, a1: number | undefined, b0: number, b1: number | undefined) => a0 < (b1 ?? Infinity) && b0 < (a1 ?? Infinity);
/**
 * Shared area. The centre test was added while the application's `ringsIntersect` missed rings with identical edges; it
 * no longer does (ADR-030), so the test is redundant and kept as recorded. The server's PostGIS check stays authoritative.
 */
const intersects = (a: Ring, b: Ring) => ringsIntersect(a, b) || pointInRing(centroid(a), b) || pointInRing(centroid(b), a);
const endOf = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/**
 * Every spatial AND time overlap of a footprint for an organisation and a period. `exempt` marks a deployment area whose
 * approved stationing scope covers the organisation: that area alone does not block it (A2). Exempt or not, the other
 * areas and reservations are still checked.
 */
export function clashes(w: World, org: string, ring: Ring, from: number, to: number | undefined, self?: string): Clash[] {
  const out: Clash[] = [];
  for (const a of w.areas) {
    if (a.status !== 'ACTIVE' || !overlaps(a.validFrom, a.validTo, from, to) || !intersects(a.ring, ring)) continue;
    out.push({ kind: 'AREA', id: a.id, label: AREA_LABEL[a.role] + ' لتمركز ' + orgName(a.org), owner: a.org, from: Math.max(a.validFrom, from), to: endOf(a.validTo, to), exempt: coveredBy(w, a.stationingId).includes(org) });
  }
  for (const r of w.reservations) {
    if (r.id === self || r.state !== 'ACTIVE' || !overlaps(r.from, r.to, from, to) || !intersects(r.ring, ring)) continue;
    out.push({ kind: 'RESERVATION', id: r.id, label: 'حجز ' + r.number + ' لـ' + orgName(r.org), owner: r.org, from: Math.max(r.from, from), to: endOf(r.to, to), exempt: false });
  }
  return out;
}
export const blocking = (c: Clash[]) => c.filter((x) => !x.exempt);

// ---- policies and profiles (versioned, append-only) ----

export const AREQ_LABEL: Record<AreasRequirement, string> = { REQUIRED: 'إلزامية', OPTIONAL: 'اختيارية' };
export const MEASURE_LABEL: Record<Measure, string> = { NEAREST_GEOMETRY: 'أقصر مسافة بين الشكلين (صفر عند التلامس أو التداخل)', CENTROID: 'من مركز إلى مركز' };
export const POLICY_LABEL: Record<PolicyKey, string> = { stationing_areas_requirement: 'اشتراط منطقتي الانتشار', max_restationing_footprint_area: 'الحد الأقصى لمساحة موقع إعادة التمركز' };
export const policyValue = (key: PolicyKey, v: AreasRequirement | number | undefined) =>
  v === undefined ? '—' : key === 'stationing_areas_requirement' ? AREQ_LABEL[v as AreasRequirement] : formatArea(v as number);

/** The version of `key` in force at `t`: the latest one whose effective time has come. */
export function policyAt(w: World, key: PolicyKey, t = w.now): PolicyVersion {
  let cur: PolicyVersion | undefined;
  for (const p of w.policies)
    if (p.key === key && p.effectiveFrom <= t && (!cur || p.effectiveFrom > cur.effectiveFrom || (p.effectiveFrom === cur.effectiveFrom && p.version > cur.version))) cur = p;
  return cur ?? w.policies.find((p) => p.key === key)!;
}
export const profileAt = (w: World, t = w.now) => w.profiles.filter((p) => p.publishedAt <= t).reduce((a, p) => (p.version > a.version ? p : a));
export const profileByVersion = (w: World, v: number) => w.profiles.find((p) => p.version === v)!;
export const profileRef = (p: GeoProfile) => p.reference + ' · الإصدار ' + p.version;

/** What a request is validated against: its pinned versions once submitted, otherwise the versions in force now. */
export function requirementOf(w: World, r: Request): PinnedPolicy {
  if (r.policy) return r.policy;
  const a = policyAt(w, 'stationing_areas_requirement');
  const m = policyAt(w, 'max_restationing_footprint_area');
  return { areas: { version: a.version, value: a.value as AreasRequirement }, maxArea: { version: m.version, value: m.value as number }, profile: profileAt(w).version, route: w.route.version, pinnedAt: w.now };
}

// ---- the proposed site: footprint limit and deployment package ----

export type Relation = { dist: number; centre: number; range: Range; ok: boolean; measure: Measure };
export type AreaCheck = {
  present: 'NONE' | 'PARTIAL' | 'COMPLETE';
  siteToPrimary?: Relation;
  primaryToAlternative?: Relation;
  shapeOk: Record<AreaRole, boolean>;
  conflicts: Record<AreaRole, string[]>;
  /** Every failed rule of what is present; an absent package is judged by the requirement, not here. */
  problems: string[];
};

const relation = (p: GeoProfile, a: Ring, b: Ring, range: Range): Relation => {
  const centre = centreDistance(a, b);
  const dist = p.measure === 'CENTROID' ? centre : nearest(a, b).dist;
  return { dist, centre, range, ok: dist >= range.min && dist <= range.max, measure: p.measure };
};
const rangeOf = (r: Range) => formatKm(r.min) + ' – ' + formatKm(r.max);

/**
 * A site's deployment package against a published profile: site → primary deployment area and primary → alternative
 * deployment area, measured by the profile's own method; shapes; availability (an area blocks once active, so a
 * proposed one is checked like one, D4). The site itself has no distance rule from the current stationing.
 */
export function checkAreaPair(w: World, profile: GeoProfile, org: string, site: Ring, areas: Partial<Record<AreaRole, Ring>> | undefined, from: number, to: number | undefined): AreaCheck {
  const p = areas?.PRIMARY_AREA;
  const a = areas?.ALTERNATIVE_AREA;
  const siteToPrimary = p ? relation(profile, site, p, profile.siteToPrimaryArea) : undefined;
  const primaryToAlternative = p && a ? relation(profile, p, a, profile.primaryAreaToAlternativeArea) : undefined;
  const shapeOk = { PRIMARY_AREA: !p || kinks(p) === 0, ALTERNATIVE_AREA: !a || kinks(a) === 0 };
  const conf = (r?: Ring) => (r ? blocking(clashes(w, org, r, from, to)).map((c) => c.label) : []);
  const conflicts = { PRIMARY_AREA: conf(p), ALTERNATIVE_AREA: conf(a) };
  const problems: string[] = [];
  if (siteToPrimary && !siteToPrimary.ok) problems.push(AREA_LABEL.PRIMARY_AREA + ' على بعد ' + formatKm(siteToPrimary.dist) + ' من الموقع المقترح، والمهيأ ' + rangeOf(siteToPrimary.range) + '.');
  if (primaryToAlternative && !primaryToAlternative.ok) problems.push(AREA_LABEL.ALTERNATIVE_AREA + ' على بعد ' + formatKm(primaryToAlternative.dist) + ' من منطقة الانتشار الرئيسية، والمهيأ ' + rangeOf(primaryToAlternative.range) + '.');
  if (!shapeOk.PRIMARY_AREA) problems.push(AREA_LABEL.PRIMARY_AREA + ' متقاطعة ذاتياً.');
  if (!shapeOk.ALTERNATIVE_AREA) problems.push(AREA_LABEL.ALTERNATIVE_AREA + ' متقاطعة ذاتياً.');
  if (conflicts.PRIMARY_AREA.length) problems.push('تعارض ' + AREA_LABEL.PRIMARY_AREA + ': ' + conflicts.PRIMARY_AREA.join('، ') + '.');
  if (conflicts.ALTERNATIVE_AREA.length) problems.push('تعارض ' + AREA_LABEL.ALTERNATIVE_AREA + ': ' + conflicts.ALTERNATIVE_AREA.join('، ') + '.');
  return { present: p && a ? 'COMPLETE' : p || a ? 'PARTIAL' : 'NONE', siteToPrimary, primaryToAlternative, shapeOk, conflicts, problems };
}

/** The request's package, for its organisation and period, against its pinned (or current) profile. */
export const proposalAreas = (w: World, r: Request) =>
  checkAreaPair(w, profileByVersion(w, requirementOf(w, r).profile), r.org, r.proposal.ring, r.proposal.areas, r.duration.start, r.duration.type === 'TEMPORARY' ? r.duration.end : undefined);

/** The proposed footprint's area against the administrator's maximum (never resized by the application). */
export function footprintCheck(w: World, r: Request) {
  const req = requirementOf(w, r);
  const area = areaM2(r.proposal.ring);
  return { area, max: req.maxArea.value, version: req.maxArea.version, ok: area <= req.maxArea.value };
}

/**
 * Why a request may not be submitted, or null: the footprint limit, the shape, and the deployment requirement —
 * REQUIRED: both deployment areas; OPTIONAL: none, or both; never one alone. Whatever is present must meet the profile.
 */
export function submitGap(w: World, r: Request): string | null {
  const fp = footprintCheck(w, r);
  if (!fp.ok) return 'مساحة الموقع المقترح ' + formatArea(fp.area) + ' تتجاوز الحد المهيأ ' + formatArea(fp.max) + ' (' + POLICY_LABEL.max_restationing_footprint_area + '، الإصدار ' + fp.version + ').';
  if (kinks(r.proposal.ring) > 0) return 'حدود الموقع المقترح متقاطعة ذاتياً.';
  const req = requirementOf(w, r);
  const c = proposalAreas(w, r);
  if (req.areas.value === 'REQUIRED' && c.present !== 'COMPLETE') return 'سياسة منطقتي الانتشار «إلزامية» (الإصدار ' + req.areas.version + '): لا يُرسل الطلب قبل رسم منطقة الانتشار الرئيسية ومنطقة الانتشار البديلة.';
  if (c.present === 'PARTIAL') return 'منطقتا الانتشار حزمة واحدة: لا تُقبل إحداهما وحدها — أكمل الناقصة أو احذف الموجودة.';
  return c.problems[0] ?? null;
}

/** The later process (D5) opens for a stationing in force or scheduled that has no active deployment areas. */
export function canRegisterAreas(w: World, actor: string, stationingId: string): Verdict {
  const s = w.stationings.find((x) => x.id === stationingId);
  if (!s || !['CURRENT', 'ACTIVE', 'SCHEDULED'].includes(s.state)) return no('لا تمركز نافذ أو مجدول.');
  if (w.areas.some((x) => x.stationingId === s.id && x.status === 'ACTIVE')) return no('للتمركز منطقتا انتشار نشطتان؛ تغييرهما إجراء مستقل، لا تسجيل جديد.');
  return holds(w, actor, 'MANAGE_STATIONING', s.org) ? yes : no('تسجيل منطقتي الانتشار يتطلب صلاحية MANAGE_STATIONING على نطاق الجهة.');
}

// ---- the approval path: derived from the hierarchy and the route policy (owner correction §11) ----

const rootOf = (w: Pick<World, 'orgParent'>, org: string) => {
  let cur = org;
  while (w.orgParent[cur]) cur = w.orgParent[cur]!;
  return cur;
};
/** The requester's top-level directorate (the ancestor just below the institution), or itself. */
const topLevelOf = (w: Pick<World, 'orgParent'>, org: string) => {
  let cur = org;
  while (w.orgParent[cur] && w.orgParent[w.orgParent[cur]!]) cur = w.orgParent[cur]!;
  return cur;
};
export const finalScopeOf = (w: Pick<World, 'orgParent' | 'route'>, org: string, type: Duration) => (w.route.final[type] === 'ROOT' ? rootOf(w, org) : topLevelOf(w, org));

/**
 * The approval path — never a fixed number of levels: one approval by the assigned approver of each organisation between
 * the requester and the final scope (nearest first), the reviews the route policy configures for the request type, any
 * approver added by an authorised routing change, then the final decision at the configured scope.
 */
export function deriveRoute(w: Pick<World, 'orgParent' | 'route'>, org: string, type: Duration, changes: RouteChange[] = []): Stage[] {
  const fin = finalScopeOf(w, org, type);
  const out: Stage[] = [];
  if (org !== fin)
    for (let cur = w.orgParent[org] ?? null; cur && cur !== fin; cur = w.orgParent[cur] ?? null)
      out.push({ key: 'h-' + cur, name: 'موافقة ' + orgName(cur), kind: 'HIERARCHY', perm: w.route.hierarchy.perm, org: cur, why: cur === w.orgParent[org] ? 'الجهة الأم لـ«' + orgName(org) + '»' : 'المستوى التالي في الهيكل', dependsOn: [...w.route.hierarchy.dependsOn] });
  for (const f of w.route.functional.filter((x) => x.types.includes(type)))
    out.push({ key: f.key, name: f.name, kind: 'FUNCTIONAL', perm: f.perm, why: 'مراجعة يهيئها مسار الطلب لنوع «' + (type === 'PERMANENT' ? 'دائم' : 'مؤقت') + '»', dependsOn: [...f.dependsOn] });
  for (const c of changes.filter((x) => x.op === 'ADD_APPROVER'))
    out.push({ key: 'a-' + c.org, name: 'موافقة ' + orgName(c.org), kind: 'ADDED', perm: w.route.hierarchy.perm, org: c.org, why: 'أُضيف بتغيير مسار مخوّل: ' + c.reason, dependsOn: [...w.route.hierarchy.dependsOn] });
  out.push({ key: 'final', name: 'القرار النهائي', kind: 'FINAL', perm: 'APPROVE', org: fin, final: true, why: 'نطاق الاعتماد النهائي لنوع «' + (type === 'PERMANENT' ? 'دائم' : 'مؤقت') + '»: «' + orgName(fin) + '»', dependsOn: ['SCOPE', 'CLASSIFICATION', 'DURATION', 'SITE', 'AVAILABILITY'] });
  return out;
}
/** The route a request follows: frozen at submission, derived live while it is a draft. */
export const routeOf = (w: World, r: Request) => (r.state === 'DRAFT' ? deriveRoute(w, r.org, r.duration.type, r.routeChanges) : r.stages);

export type Participant = { label: string; org?: string; role: 'REQUESTER' | 'AFFECTED' | 'APPROVER' | 'REVIEW' | 'FINAL' | 'ACTIVATION' | 'NOTIFY'; why: string; source: 'SYSTEM' | 'CHANGE' };
/**
 * The units and recipients the system determines from the hierarchy, the affected scope and the route policy — never
 * from map geography — plus authorised routing changes.
 */
export function participants(w: World, r: Request): Participant[] {
  const out: Participant[] = [{ label: orgName(r.org), org: r.org, role: 'REQUESTER', why: 'الجهة الطالبة', source: 'SYSTEM' }];
  for (const u of unitsOf(w, r).filter((x) => x !== r.org)) out.push({ label: orgName(u), org: u, role: 'AFFECTED', why: 'وحدة مشمولة بالطلب — إشعار', source: 'SYSTEM' });
  for (const s of routeOf(w, r))
    out.push(
      s.kind === 'FUNCTIONAL'
        ? { label: s.name, role: 'REVIEW', why: s.why, source: 'SYSTEM' }
        : { label: orgName(s.org), org: s.org, role: s.kind === 'FINAL' ? 'FINAL' : 'APPROVER', why: s.why, source: s.kind === 'ADDED' ? 'CHANGE' : 'SYSTEM' },
    );
  out.push({ label: 'صاحب صلاحية التفعيل في النطاق', role: 'ACTIVATION', why: 'تفعيل مستقل بعد الاعتماد (D1)', source: 'SYSTEM' });
  const removed = new Set(r.routeChanges.filter((c) => c.op === 'REMOVE_RECIPIENT').map((c) => c.org));
  for (const c of r.routeChanges.filter((x) => x.op === 'ADD_RECIPIENT' && !removed.has(x.org))) out.push({ label: orgName(c.org), org: c.org, role: 'NOTIFY', why: 'أُضيف بتغيير مسار مخوّل: ' + c.reason, source: 'CHANGE' });
  return out.filter((p) => !(p.role === 'AFFECTED' && p.org && removed.has(p.org)));
}

/** Who may decide a stage: the assigned approver of its organisation, a reviewer on the request's scope, or the final approver. */
export function canDecide(w: World, actor: string, r: Request, st: Stage): Verdict {
  const p = person(w, actor);
  if (!p) return no('—');
  if (st.kind === 'HIERARCHY' || st.kind === 'ADDED') {
    if (!(p.perms.includes(st.perm) && p.scope.includes(st.org!))) return no('مرحلة «' + st.name + '» يقررها المعتمد المُسند لـ«' + orgName(st.org) + '».');
  } else if (st.kind === 'FINAL') {
    if (!holds(w, actor, 'APPROVE', st.org!)) return no('القرار النهائي يتطلب صلاحية الاعتماد على نطاق «' + orgName(st.org) + '».');
  } else if (!holds(w, actor, st.perm, r.org)) return no('لا تملك صفة مرحلة «' + st.name + '» على نطاق الطلب.');
  return sameHuman(w, actor, r.requester) ? no('فصل المهام: لا يراجع مقدم الطلب طلبه.') : yes;
}

// ---- workflow: what each stage's decision depends on (D18) ----

/** The impact of a change: the facts it touches, the restart stage, invalidated and carried decisions. */
export function impact(stages: Stage[], changed: Fact[]) {
  const affected = new Set<Fact>(changed);
  if (affected.has('CLASSIFICATION')) affected.add('DURATION');
  if (affected.has('SCOPE') || affected.has('DURATION') || affected.has('SITE')) affected.add('AVAILABILITY');
  const restart = stages.findIndex((s) => s.final || s.dependsOn.some((f) => affected.has(f)));
  const invalidated: string[] = [];
  const carried: string[] = [];
  stages.forEach((s, i) => {
    if (i < restart || !s.mark || s.mark === 'INVALIDATED') return;
    if (s.final || s.dependsOn.some((f) => affected.has(f))) invalidated.push(s.key);
    else carried.push(s.key);
  });
  return { affected: [...affected], restart, invalidated, carried };
}

/** The facts a resubmission changed, from the difference with what was submitted. */
export function changedFacts(r: Request): Fact[] {
  const s = r.submitted;
  if (!s) return [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: Fact[] = [];
  if (!same(s.scope, r.scope)) out.push('SCOPE');
  if (s.duration.type !== r.duration.type) out.push('CLASSIFICATION');
  if (!same(s.duration, r.duration)) out.push('DURATION');
  if (!same(s.proposal, r.proposal)) out.push('SITE');
  return out;
}

const nextOpen = (r: Request, from: number) => {
  let i = from;
  while (i < r.stages.length && (r.stages[i].mark === 'APPROVED' || r.stages[i].mark === 'CARRIED')) i++;
  return i;
};
const reviewing = (r: Request | undefined) => r?.state === 'UNDER_REVIEW';
const snapshot = (r: Request): NonNullable<Request['submitted']> => structuredClone({ scope: r.scope, duration: r.duration, proposal: r.proposal });

// ---- guards ----

export function check(w: World, actor: string, a: Action): Verdict {
  if (a.t === 'TICK') return a.to > w.now ? yes : no('الوقت لا يعود إلى الوراء.');
  const r = 'req' in a ? w.requests.find((x) => x.id === a.req) : undefined;
  switch (a.t) {
    case 'SUBMIT': {
      if (!r || r.state !== 'DRAFT') return no('ليس مسودة.');
      if (!sameHuman(w, actor, r.requester)) return no('يرسله مقدم الطلب.');
      const gap = submitGap(w, r);
      return gap ? no(gap) : yes;
    }
    case 'APPROVE_STAGE':
    case 'REJECT':
    case 'RETURN': {
      if (!reviewing(r)) return no('الطلب ليس قيد المراجعة.');
      const st = r!.stages[r!.cursor];
      return st ? canDecide(w, actor, r!, st) : no('لا مرحلة مفتوحة.');
    }
    case 'RESUBMIT': {
      if (!r || r.state !== 'RETURNED_FOR_CHANGES') return no('ليس معاداً.');
      if (!sameHuman(w, actor, r.requester)) return no('يعيد إرساله مقدم الطلب.');
      // validated against the versions pinned at the first submission, not those in force today
      const gap = submitGap(w, r);
      if (gap) return no(gap);
      return a.changed.length && a.reason.trim().length < 5 ? no('اذكر سبب التغيير.') : yes;
    }
    case 'ROUTE_CHANGE': {
      if (!r || !['DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES'].includes(r.state)) return no('يُغيَّر المسار قبل القرار النهائي فقط.');
      if (!holds(w, actor, 'MANAGE_REQUEST_ROUTING', r.org)) return no('تغيير المسار أو المستلمين يتطلب صلاحية MANAGE_REQUEST_ROUTING.');
      if (sameHuman(w, actor, r.requester)) return no('فصل المهام: مقدم الطلب لا يغيّر مساره.');
      if (a.reason.trim().length < 5) return no('اذكر سبب التغيير.');
      if (!orgById.has(a.org)) return no('جهة غير معروفة.');
      const ps = participants(w, r);
      if (a.op === 'REMOVE_RECIPIENT') return ps.some((p) => p.org === a.org && (p.role === 'NOTIFY' || p.role === 'AFFECTED')) ? yes : no('يُحذف مستلم إشعار فقط؛ مراحل الاعتماد المشتقة لا تُحذف.');
      return ps.some((p) => p.org === a.org && p.role !== 'AFFECTED') ? no('الجهة مشاركة في المسار.') : yes;
    }
    case 'ACTIVATE': {
      if (!r) return no('لا طلب.');
      if (r.state === 'CANCELLATION_PENDING') return no('محجوب: طلب إلغاء قبل التفعيل قيد القرار.');
      if (r.state !== 'APPROVED_NOT_ACTIVATED') return no('التفعيل لطلب «معتمد — لم يُفعَّل» فقط.');
      if (!holds(w, actor, 'ACTIVATE_STATIONING', r.org)) return no('التفعيل يتطلب صلاحية ACTIVATE_STATIONING على النطاق.');
      if (sameHuman(w, actor, r.requester)) return no('فصل المهام: مقدم الطلب لا يفعّل طلبه.');
      if (sameHuman(w, actor, r.finalApprover)) return no('فصل المهام: صاحب الاعتماد النهائي لا يفعّل ما اعتمده (بالإنسان، شاملاً التفويض والحسابات المرتبطة).');
      if (!r.proposal.siteId) return no('الموقع المعتمد غير مسجل؛ يسجله مسؤول المرافق أولاً. التفعيل لا يُنشئ مواقع.');
      const ar = proposalAreas(w, r);
      if (ar.present === 'COMPLETE' && ar.problems.length) return no('إعادة التحقق عند التفعيل: ' + ar.problems[0]);
      const units = unitsOf(w, r);
      if (r.approvedSnapshot && units.map((u) => permanentOf(w, u)?.id ?? '-').join() !== r.approvedSnapshot.join()) return no('تغيّر التمركز الدائم في النطاق منذ الاعتماد.');
      if (r.duration.type === 'PERMANENT') {
        if (w.now < r.duration.start) return no('قبل البداية المعتمدة.');
        const temps = units.map((u) => temporaryOf(w, u)).filter(Boolean) as Stationing[];
        if (temps.some((t) => !(r.supersedes ?? []).includes(t.id))) return no('في النطاق تمركز مؤقت لم يُعرض في الاعتماد؛ ينتظر انتهاءه أو اعتماداً جديداً.');
      } else if (r.duration.end! <= w.now) return no('انتهت فترة المؤقت المعتمدة.');
      return yes;
    }
    case 'REQUEST_CANCEL':
      if (!r || r.state !== 'APPROVED_NOT_ACTIVATED') return no('الإلغاء قبل التفعيل لطلب معتمد لم يُفعَّل.');
      return sameHuman(w, actor, r.requester) ? yes : no('يطلبه مقدم الطلب.');
    case 'DECIDE_CANCEL':
      if (!r || r.state !== 'CANCELLATION_PENDING' || !r.cancellation) return no('لا طلب إلغاء معلق.');
      if (!holds(w, actor, 'DECIDE_PRE_ACTIVATION_CANCELLATION', r.org)) return no('قرار الإلغاء يتطلب صلاحية DECIDE_PRE_ACTIVATION_CANCELLATION.');
      return sameHuman(w, actor, r.cancellation.by) ? no('فصل المهام: طالب الإلغاء لا يقرر طلبه.') : yes;
    case 'REQUEST_EXTENSION':
      if (!r || (r.state !== 'ACTIVE_TEMPORARY' && r.state !== 'TEMPORARY_SCHEDULED')) return no('التمديد لمؤقت مفعَّل.');
      if (w.extensions.some((e) => e.parent === r.id && ['SUBMITTED', 'EXTENSION_APPROVED_NOT_ACTIVATED', 'CANCELLATION_PENDING'].includes(e.state))) return no('يوجد تمديد قيد المعالجة.');
      if (!(sameHuman(w, actor, r.requester) || holds(w, actor, 'CREATE', r.org))) return no('يطلبه مقدم الطلب أو صاحب صلاحية في النطاق.');
      return a.newEnd > (r.duration.end ?? 0) ? yes : no('النهاية الجديدة بعد الحالية.');
    case 'REQUEST_START_CANCEL':
      if (!r || r.state !== 'TEMPORARY_SCHEDULED') return no('الإلغاء قبل بدء النفاذ لتمركز مؤقت مُفعَّل لم يبدأ.');
      if (w.now >= r.duration.start) return no('بلغ وقت النفاذ؛ لا إلغاء قبل البدء.');
      if (w.startCancellations.some((x) => x.request === r.id && x.state === 'REQUESTED')) return no('يوجد طلب إلغاء قبل البدء معلق.');
      return sameHuman(w, actor, r.requester) || holds(w, actor, 'CREATE', r.org) ? yes : no('يطلبه مقدم الطلب أو صاحب صلاحية في النطاق.');
    case 'DECIDE_START_CANCEL': {
      const sc = w.startCancellations.find((x) => x.id === a.sc);
      const parent = sc && w.requests.find((x) => x.id === sc.request);
      if (!sc || !parent) return no('لا طلب إلغاء قبل البدء.');
      if (sc.state === 'NO_LONGER_ACTIONABLE') return no('لم يعد الطلب قابلاً للقرار: ' + (sc.closeReason ?? '') + '.');
      if (sc.state !== 'REQUESTED') return no('لا طلب إلغاء قبل البدء معلق.');
      if (parent.state !== 'TEMPORARY_SCHEDULED' && parent.state !== 'START_HELD_PENDING_CANCELLATION') return no('التمركز المؤقت ليس في انتظار البدء.');
      if (!holds(w, actor, 'DECIDE_TEMPORARY_BEFORE_START_CANCELLATION', parent.org)) return no('القرار يتطلب صلاحية DECIDE_TEMPORARY_BEFORE_START_CANCELLATION على النطاق.');
      return sameHuman(w, actor, sc.by) ? no('فصل المهام: طالب الإلغاء لا يقرر طلبه.') : yes;
    }
    case 'CONFIRM_RESERVATION': {
      const res = w.reservations.find((x) => x.id === a.res);
      if (!res || res.state !== 'PROPOSED') return no('الحجز ليس مقترحاً.');
      return sameHuman(w, actor, res.requester) ? yes : no('يؤكده مقدم الحجز.');
    }
    case 'REQUEST_EXCEPTION': {
      const res = w.reservations.find((x) => x.id === a.res);
      if (!res || res.state !== 'BLOCKED') return no('الاستثناء يُطلب لحجز ممنوع.');
      if (!sameHuman(w, actor, res.requester)) return no('يطلبه مقدم الحجز.');
      return a.policyRef.trim().length < 3 ? no('اذكر مرجع السياسة التي تجيز المشاركة أو الاستثناء.') : yes;
    }
    case 'DECIDE_EXCEPTION': {
      const res = w.reservations.find((x) => x.id === a.res);
      if (!res || res.state !== 'EXCEPTION_REQUESTED') return no('لا طلب استثناء معلق.');
      const owners = [...new Set(blocking(clashes(w, res.org, res.ring, res.from, res.to, res.id)).map((c) => c.owner))];
      if (!owners.every((o) => holds(w, actor, 'APPROVE_AVAILABILITY_EXCEPTION', o))) return no('اعتماد الاستثناء يتطلب صلاحية APPROVE_AVAILABILITY_EXCEPTION على نطاق المنطقة المتعارضة.');
      return sameHuman(w, actor, res.requester) || sameHuman(w, actor, res.exception?.requestedBy) ? no('فصل المهام: طالب الاستثناء لا يعتمده.') : yes;
    }
    case 'SET_POLICY': {
      if (!holds(w, actor, 'MANAGE_STATIONING_POLICY', 'o-root')) return no('تغيير سياسات التمركز لمسؤول النظام بصلاحية MANAGE_STATIONING_POLICY.');
      if (a.effectiveFrom < w.now) return no('لا أثر رجعي: يسري الإصدار من الآن أو بعده.');
      if (a.key === 'max_restationing_footprint_area' && !(typeof a.value === 'number' && a.value > 0)) return no('الحد مساحة موجبة بالمتر المربع.');
      if (policyAt(w, a.key, a.effectiveFrom).value === a.value) return no('القيمة نفسها نافذة في ذلك الوقت.');
      return a.reason.trim().length < 5 ? no('اذكر سبب التغيير.') : yes;
    }
    case 'REGISTER_AREAS': {
      const v = canRegisterAreas(w, actor, a.stationing);
      if (!v.ok) return v;
      if (a.primary.length < 3 || a.alternative.length < 3) return no('منطقتا الانتشار حزمة واحدة: ارسم الرئيسية والبديلة.');
      if (a.authority.trim().length < 3 || a.reference.trim().length < 3) return no('اذكر الجهة المصدرة ورقم القرار.');
      if (a.reason.trim().length < 5) return no('اذكر السبب.');
      const s = w.stationings.find((x) => x.id === a.stationing)!;
      const site = w.sites.find((x) => x.id === s.siteId)!;
      const c = checkAreaPair(w, profileAt(w), s.org, site.ring, { PRIMARY_AREA: a.primary, ALTERNATIVE_AREA: a.alternative }, Math.max(w.now, s.from), s.plannedEnd);
      return c.problems.length ? no(c.problems[0]) : yes;
    }
    case 'REQUEST_EARLY_RETURN':
      if (r?.state === 'TEMPORARY_SCHEDULED') return no('لم يبدأ النفاذ بعد: لا «عودة»؛ الإجراء هو «إلغاء التمركز المؤقت قبل بدء النفاذ».');
      if (r?.state === 'START_HELD_PENDING_CANCELLATION') return no('لم يبدأ النفاذ: البدء موقوف بانتظار قرار الإلغاء قبل البدء.');
      if (!r || r.state !== 'ACTIVE_TEMPORARY') return no('العودة المبكرة لمؤقت ساري.');
      if (w.earlyReturns.some((e) => e.request === r.id && e.state === 'REQUESTED')) return no('يوجد طلب عودة مبكرة معلق.');
      return sameHuman(w, actor, r.requester) || holds(w, actor, 'CREATE', r.org) ? yes : no('يطلبها مقدم الطلب أو صاحب صلاحية في النطاق.');
    case 'APPROVE_EXTENSION':
    case 'ACTIVATE_EXTENSION': {
      const e = w.extensions.find((x) => x.id === a.ext);
      const parent = e && w.requests.find((x) => x.id === e.parent);
      if (!e || !parent) return no('لا تمديد.');
      if (a.t === 'APPROVE_EXTENSION') {
        if (e.state !== 'SUBMITTED') return no('التمديد ليس قيد المراجعة.');
        if (!holds(w, actor, 'APPROVE', parent.org)) return no('اعتماد التمديد يتطلب صلاحية الاعتماد.');
        return sameHuman(w, actor, e.requester) ? no('فصل المهام: مقدم التمديد لا يعتمده.') : yes;
      }
      if (e.state === 'CANCELLATION_PENDING') return no('محجوب: طلب إلغاء التمديد قيد القرار.');
      if (e.state !== 'EXTENSION_APPROVED_NOT_ACTIVATED') return no('التفعيل لتمديد «معتمد — لم يُفعَّل».');
      if (!holds(w, actor, 'ACTIVATE_TEMPORARY_EXTENSION', parent.org)) return no('تفعيل التمديد يتطلب صلاحية ACTIVATE_TEMPORARY_EXTENSION.');
      if (sameHuman(w, actor, e.finalApprover)) return no('فصل المهام: من اعتمد التمديد لا يفعّله.');
      if (sameHuman(w, actor, e.requester)) return no('فصل المهام: مقدم التمديد لا يفعّله.');
      if (parent.state === 'START_HELD_PENDING_CANCELLATION') return no('محجوب: البدء موقوف بانتظار قرار الإلغاء قبل البدء.');
      if (parent.state !== 'ACTIVE_TEMPORARY' && parent.state !== 'TEMPORARY_SCHEDULED') return no('لا تمركز مؤقت قائم يُمدد.');
      if (w.startCancellations.some((x) => x.request === parent.id && x.state === 'REQUESTED')) return no('محجوب: طلب إلغاء قبل بدء النفاذ قيد القرار.');
      return yes;
    }
    case 'DECIDE_EARLY_RETURN': {
      const e = w.earlyReturns.find((x) => x.id === a.er);
      const parent = e && w.requests.find((x) => x.id === e.request);
      if (!e || !parent || e.state !== 'REQUESTED') return no('لا طلب عودة مبكرة معلق.');
      if (parent.state !== 'ACTIVE_TEMPORARY') return no('العودة المبكرة لمؤقت ساري.');
      if (!holds(w, actor, 'DECIDE_EARLY_RETURN', parent.org)) return no('قرار العودة المبكرة يتطلب صلاحية DECIDE_EARLY_RETURN على النطاق.');
      return sameHuman(w, actor, e.by) ? no('فصل المهام: طالب العودة لا يقررها.') : yes;
    }
  }
}

// ---- transitions ----

export function perform(world: World, actor: string, a: Action): World {
  const v = check(world, actor, a);
  if (!v.ok) throw new Error(v.reason);
  const w: World = structuredClone(world);
  const log = (type: string, ref: string, detail: string, by = actor, data?: Record<string, string>) => w.events.push({ at: w.now, actor: by, type, ref, detail, data });
  const r = 'req' in a ? w.requests.find((x) => x.id === a.req)! : undefined;

  switch (a.t) {
    case 'SUBMIT': {
      // the route is frozen and the policy versions pinned at the first submission
      r!.stages = deriveRoute(w, r!.org, r!.duration.type, r!.routeChanges);
      r!.cursor = 0;
      r!.state = 'UNDER_REVIEW';
      r!.policy = { ...requirementOf(w, r!), pinnedAt: w.now };
      r!.submitted = snapshot(r!);
      const p = r!.policy;
      log('REQUEST_SUBMITTED', r!.number, 'مسار من ' + r!.stages.length + ' مراحل مشتق من الهيكل ومسار الطلب · منطقتا الانتشار ' + AREQ_LABEL[p.areas.value] + ' (الإصدار ' + p.areas.version + '، مثبَّت)', actor, {
        route: r!.stages.map((s) => s.name).join(' ← '),
        areasRequirement: p.areas.value,
        areasPolicyVersion: String(p.areas.version),
        maxFootprintArea: formatArea(p.maxArea.value),
        maxAreaPolicyVersion: String(p.maxArea.version),
        profile: profileRef(profileByVersion(w, p.profile)) + ' · ' + MEASURE_LABEL[profileByVersion(w, p.profile).measure],
        pinnedAt: when(p.pinnedAt),
      });
      break;
    }
    case 'APPROVE_STAGE': {
      const st = r!.stages[r!.cursor];
      Object.assign(st, { mark: 'APPROVED', by: actor });
      if (st.final) {
        r!.state = 'APPROVED_NOT_ACTIVATED';
        r!.finalApprover = actor;
        const units = unitsOf(w, r!);
        r!.approvedSnapshot = units.map((u) => permanentOf(w, u)?.id ?? '-');
        if (r!.duration.type === 'PERMANENT') r!.supersedes = units.map((u) => temporaryOf(w, u)?.id).filter(Boolean) as string[];
        log('REQUEST_APPROVED', r!.number, 'اعتماد نهائي' + (r!.supersedes?.length ? '؛ يُنهي التفعيل ' + r!.supersedes.length + ' تمركزاً مؤقتاً قائماً' : ''));
      } else {
        r!.cursor = nextOpen(r!, r!.cursor + 1);
        log('STAGE_APPROVED', r!.number, st.name + (st.org ? ' · «' + orgName(st.org) + '»' : '') + ' · التالي: ' + (r!.stages[r!.cursor]?.name ?? '—'));
      }
      break;
    }
    case 'REJECT':
      r!.state = 'REJECTED';
      r!.rejection = { by: actor, reason: a.reason, at: w.now };
      log('REQUEST_REJECTED', r!.number, r!.stages[r!.cursor].name + ' — ' + a.reason);
      break;
    case 'RETURN':
      r!.state = 'RETURNED_FOR_CHANGES';
      log('REQUEST_RETURNED', r!.number, r!.stages[r!.cursor].name + ' — ' + a.reason);
      break;
    case 'RESUBMIT': {
      const im = impact(r!.stages, a.changed);
      for (const s of r!.stages) {
        if (im.invalidated.includes(s.key)) Object.assign(s, { mark: 'INVALIDATED', by: undefined });
        if (im.carried.includes(s.key)) s.mark = 'CARRIED';
      }
      r!.cursor = nextOpen(r!, im.restart);
      r!.state = 'UNDER_REVIEW';
      r!.submitted = snapshot(r!);
      log('WORKFLOW_INVALIDATION', r!.number, 'تغيّر: ' + (a.changed.map((f) => FACT_LABEL[f]).join('، ') || 'لا شيء') + ' · السبب: ' + a.reason + ' · استئناف من «' + r!.stages[im.restart].name + '» · أُبطل ' + im.invalidated.length + ' · حُمل ' + im.carried.length);
      break;
    }
    case 'ROUTE_CHANGE': {
      const c: RouteChange = { at: w.now, by: actor, op: a.op, org: a.org, reason: a.reason };
      r!.routeChanges.push(c);
      if (a.op === 'ADD_APPROVER' && r!.state !== 'DRAFT') {
        const fin = r!.stages.findIndex((s) => s.final);
        r!.stages.splice(fin, 0, deriveRoute(w, r!.org, r!.duration.type, [c]).find((s) => s.kind === 'ADDED')!);
        if (r!.cursor > fin) r!.cursor = fin;
      }
      log('REQUEST_ROUTING_CHANGED', r!.number, { ADD_APPROVER: 'إضافة معتمد', ADD_RECIPIENT: 'إضافة مستلم إشعار', REMOVE_RECIPIENT: 'حذف مستلم إشعار' }[a.op] + ': «' + orgName(a.org) + '» · السبب: ' + a.reason, actor, {
        operation: a.op,
        organisation: orgName(a.org),
        changedBy: actor,
        reason: a.reason,
      });
      break;
    }
    case 'ACTIVATE': {
      const units = unitsOf(w, r!);
      r!.activation = { by: actor, at: w.now, ref: 'ACT-' + r!.number };
      if (r!.duration.type === 'PERMANENT') {
        const ended: string[] = [];
        for (const u of units) {
          const t = temporaryOf(w, u);
          if (t) {
            endTemporary(w, t, 'SUPERSEDED_BY_PERMANENT_STATIONING', actor, r!.number, r!.activation.ref);
            ended.push(u);
          }
          const p = permanentOf(w, u);
          if (p) {
            Object.assign(p, { state: 'ENDED', to: w.now, endReason: 'REPLACED_BY_ACTIVATION', endRef: r!.activation.ref });
            retireAreas(w, p.id, actor);
          }
          w.stationings.push({ id: 'st-' + u + '-' + w.now, org: u, kind: 'PERMANENT', siteId: r!.proposal.siteId!, state: 'CURRENT', from: w.now, requestId: r!.id });
        }
        r!.state = 'ACTIVATED_PERMANENT';
        log('STATIONING_ACTIVATED', r!.number, 'دائم · ' + units.length + ' وحدة · صار الموقع الجديد التمركز الحالي، والسابق في التاريخ · لا عودة تلقائية' + (ended.length ? ' · أُنهي ذرياً تمركز مؤقت لـ' + ended.length + ' وحدة' : '') + (a.reason ? ' · السبب: ' + a.reason : ''), actor, {
          activationRef: r!.activation.ref,
        });
        attachAreas(w, r!, units, (u) => 'st-' + u + '-' + w.now, actor);
      } else {
        const started = w.now >= r!.duration.start;
        for (const u of units)
          w.stationings.push({
            id: 'st-t-' + u + '-' + w.now,
            org: u,
            kind: 'TEMPORARY',
            baseId: permanentOf(w, u)?.id,
            siteId: r!.proposal.siteId!,
            state: started ? 'ACTIVE' : 'SCHEDULED',
            from: Math.max(w.now, r!.duration.start),
            plannedStart: r!.duration.start,
            plannedEnd: r!.duration.end,
            requestId: r!.id,
          });
        r!.state = started ? 'ACTIVE_TEMPORARY' : 'TEMPORARY_SCHEDULED';
        // A3: a temporary stationing never ends the permanent one, nor retires its deployment areas
        log('STATIONING_ACTIVATED', r!.number, 'مؤقت · ' + units.length + ' وحدة · ' + (started ? 'ساري' : 'مجدول حتى بلوغ البداية') + ' · التمركز الأصلي ومنطقتاه محفوظة' + (a.reason ? ' · السبب: ' + a.reason : ''), actor, {
          activationRef: r!.activation.ref,
        });
        attachAreas(w, r!, units, (u) => 'st-t-' + u + '-' + w.now, actor);
      }
      break;
    }
    case 'REQUEST_CANCEL':
      r!.state = 'CANCELLATION_PENDING';
      r!.cancellation = { state: 'PENDING', by: actor, reason: a.reason };
      log('RELOCATION_CANCELLATION_REQUESTED', r!.number, a.reason + ' · التفعيل ممنوع حتى القرار');
      break;
    case 'DECIDE_CANCEL':
      r!.cancellation = { ...r!.cancellation!, state: a.approve ? 'APPROVED' : 'REJECTED', decidedBy: actor, decision: a.reason };
      r!.state = a.approve ? 'CANCELLED_BEFORE_ACTIVATION' : 'APPROVED_NOT_ACTIVATED';
      log(a.approve ? 'RELOCATION_CANCELLED_BEFORE_ACTIVATION' : 'RELOCATION_CANCELLATION_REJECTED', r!.number, a.reason + ' · مرجع الاعتماد: قرار ' + (person(w, r!.finalApprover!)?.name ?? ''));
      break;
    case 'REQUEST_EXTENSION': {
      const n = w.extensions.length + 1;
      w.extensions.push({ id: 'ext-' + n + '-' + w.now, number: r!.number + '-EXT' + n, parent: r!.id, newEnd: a.newEnd, state: 'SUBMITTED', requester: actor });
      log('EXTENSION_REQUESTED', r!.number, 'نهاية جديدة مطلوبة: ' + day(a.newEnd));
      break;
    }
    case 'APPROVE_EXTENSION': {
      const e = w.extensions.find((x) => x.id === a.ext)!;
      Object.assign(e, { state: 'EXTENSION_APPROVED_NOT_ACTIVATED', finalApprover: actor });
      log('EXTENSION_APPROVED', e.number, 'معتمد — النهاية الفعالة لم تتغير حتى التفعيل');
      break;
    }
    case 'ACTIVATE_EXTENSION': {
      const e = w.extensions.find((x) => x.id === a.ext)!;
      const parent = w.requests.find((x) => x.id === e.parent)!;
      for (const t of w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && (s.state === 'ACTIVE' || s.state === 'SCHEDULED')))
        w.stationings.push({ ...t, id: t.id + '-x', state: 'SCHEDULED', from: t.plannedEnd!, plannedStart: t.plannedEnd, plannedEnd: e.newEnd, extendsId: t.id });
      // the temporary record's own deployment areas follow its validity period
      for (const ar of w.areas.filter((x) => x.status === 'ACTIVE' && w.stationings.some((s) => s.id === x.stationingId && s.requestId === parent.id && s.kind === 'TEMPORARY'))) ar.validTo = e.newEnd;
      e.state = 'EXTENSION_ACTIVATED';
      log('EXTENSION_ACTIVATED', e.number, 'فترة صلاحية جديدة حتى ' + day(e.newEnd) + ' · تبدأ عند النهاية الأصلية · ليس نقلاً فعلياً جديداً' + (a.reason ? ' · السبب: ' + a.reason : ''));
      break;
    }
    case 'REQUEST_EARLY_RETURN': {
      const t = w.stationings.find((s) => s.requestId === r!.id && s.kind === 'TEMPORARY' && (s.state === 'ACTIVE' || s.state === 'SCHEDULED') && !s.extendsId)!;
      w.earlyReturns.push({ id: 'er-' + w.now, request: r!.id, state: 'REQUESTED', by: actor, reason: a.reason, originalEnd: t.plannedEnd! });
      log('EARLY_RETURN_REQUESTED', r!.number, a.reason);
      break;
    }
    case 'DECIDE_EARLY_RETURN': {
      const e = w.earlyReturns.find((x) => x.id === a.er)!;
      const parent = w.requests.find((x) => x.id === e.request)!;
      Object.assign(e, { state: a.approve ? 'APPROVED' : 'REJECTED', decidedBy: actor });
      if (a.approve) {
        for (const t of w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && s.state === 'ACTIVE')) endTemporary(w, t, 'EARLY_RETURN', actor, parent.number, e.id);
        e.actualEnd = w.now;
        parent.state = 'TEMPORARY_ENDED';
        lapse(w, parent.id, actor, 'عودة مبكرة قبل تفعيل التمديد');
      }
      log(a.approve ? 'STATIONING_TEMPORARY_EARLY_RETURN' : 'EARLY_RETURN_REJECTED', parent.number, a.reason + ' · النهاية المخططة ' + day(e.originalEnd) + (a.approve ? ' · الفعلية ' + day(w.now) : ''));
      break;
    }
    case 'REQUEST_START_CANCEL':
      w.startCancellations.push({
        id: 'sc-' + w.now + '-' + w.startCancellations.length,
        request: r!.id,
        state: 'REQUESTED',
        by: actor,
        reason: a.reason,
        activationRef: r!.activation?.ref ?? '—',
        plannedStart: r!.duration.start,
        plannedEnd: r!.duration.end!,
      });
      log('TEMPORARY_START_CANCELLATION_REQUESTED', r!.number, a.reason);
      break;
    case 'DECIDE_START_CANCEL': {
      const sc = w.startCancellations.find((x) => x.id === a.sc)!;
      const parent = w.requests.find((x) => x.id === sc.request)!;
      const held = parent.state === 'START_HELD_PENDING_CANCELLATION';
      Object.assign(sc, { state: a.approve ? 'APPROVED' : 'REJECTED', decidedBy: actor, decision: a.reason, decidedAt: w.now });
      const data: Record<string, string> = {
        requester: sc.by,
        decisionMaker: actor,
        activationRef: sc.activationRef,
        plannedStart: when(sc.plannedStart),
        plannedEnd: when(sc.plannedEnd),
        decidedAt: when(w.now),
        decisionReason: a.reason,
      };
      if (held) data.heldSince = when(sc.heldAt!);
      if (a.approve) {
        // never effective: every record of the request that has not started (also an activated extension's) is closed
        for (const t of w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && s.state === 'SCHEDULED')) {
          Object.assign(t, { state: 'CANCELLED_BEFORE_START', to: w.now, endRef: sc.id });
          retireAreas(w, t.id, actor, 'لم يصبح تمركزها نافذاً');
        }
        parent.state = 'TEMPORARY_CANCELLED_BEFORE_START';
        lapse(w, parent.id, actor, 'أُلغي التمركز المؤقت قبل بدء النفاذ');
        log('TEMPORARY_CANCELLED_BEFORE_START', parent.number, a.reason + (held ? ' · كان البدء موقوفاً منذ ' + when(sc.heldAt!) : ''), actor, data);
      } else if (!held) {
        // rejected before the planned start: nothing changes, the start job starts it at the approved start
        log('TEMPORARY_START_CANCELLATION_REJECTED', parent.number, a.reason + ' · يبدأ في البداية المعتمدة ' + when(sc.plannedStart), actor, data);
      } else {
        // rejected after the planned start (A6): effective from this decision only — never backdated; the approved end
        // stays, or an activated extension's
        const seg = w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && s.state === 'SCHEDULED' && s.plannedStart! <= w.now && w.now < s.plannedEnd!);
        for (const t of seg) Object.assign(t, { state: 'ACTIVE', from: w.now, startRef: sc.id });
        for (const ar of w.areas.filter((x) => x.status === 'ACTIVE' && seg.some((t) => t.id === x.stationingId))) ar.validFrom = w.now;
        sc.effectiveStart = w.now;
        parent.state = 'ACTIVE_TEMPORARY';
        const end = Math.max(...w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && (s.state === 'ACTIVE' || s.state === 'SCHEDULED')).map((s) => s.plannedEnd!));
        data.actualEffectiveStart = when(w.now);
        data.effectiveEnd = when(end);
        log('TEMPORARY_START_CANCELLATION_REJECTED', parent.number, a.reason, actor, data);
        log('STATIONING_TEMPORARY_STARTED', parent.number, 'بدأ النفاذ من وقت القرار ' + when(w.now) + ' لا من البداية المعتمدة ' + when(sc.plannedStart) + ' (دون أثر رجعي) · النهاية ' + when(end), actor, {
          plannedStart: when(sc.plannedStart),
          actualEffectiveStart: when(w.now),
          decidedAt: when(w.now),
          decisionReason: a.reason,
          effectiveEnd: when(end),
        });
      }
      break;
    }
    case 'CONFIRM_RESERVATION': {
      const res = w.reservations.find((x) => x.id === a.res)!;
      const cl = clashes(w, res.org, res.ring, res.from, res.to, res.id);
      const b = blocking(cl);
      res.state = b.length ? 'BLOCKED' : 'ACTIVE';
      log(b.length ? 'RESERVATION_BLOCKED' : 'RESERVATION_CONFIRMED', res.number, b.length ? 'منع افتراضي: ' + b.map((c) => c.label).join('، ') : 'لا تعارض' + (cl.some((c) => c.exempt) ? ' · ضمن النطاق المغطى للمنطقة' : ''));
      break;
    }
    case 'REQUEST_EXCEPTION': {
      const res = w.reservations.find((x) => x.id === a.res)!;
      res.state = 'EXCEPTION_REQUESTED';
      res.exception = { reason: a.reason, policyRef: a.policyRef, requestedBy: actor };
      log('AREA_EXCEPTION_REQUESTED', res.number, a.reason, actor, { policyRef: a.policyRef });
      break;
    }
    case 'DECIDE_EXCEPTION': {
      const res = w.reservations.find((x) => x.id === a.res)!;
      const b = blocking(clashes(w, res.org, res.ring, res.from, res.to, res.id));
      res.exception = { ...res.exception!, decidedBy: actor, decision: a.reason, approved: a.approve };
      res.state = a.approve ? 'ACTIVE' : 'REJECTED';
      log(a.approve ? 'AREA_EXCEPTION_APPROVED' : 'AREA_EXCEPTION_REJECTED', res.number, a.reason, actor, {
        conflicts: b.map((c) => c.label).join('، '),
        policyRef: res.exception.policyRef,
        requestedBy: res.exception.requestedBy,
        requestReason: res.exception.reason,
        decidedBy: actor,
      });
      break;
    }
    case 'SET_POLICY': {
      const prev = policyAt(w, a.key, a.effectiveFrom);
      const v: PolicyVersion = {
        key: a.key,
        version: Math.max(...w.policies.filter((p) => p.key === a.key).map((p) => p.version)) + 1,
        value: a.value,
        previous: prev.value,
        effectiveFrom: a.effectiveFrom,
        changedBy: actor,
        changedAt: w.now,
        reason: a.reason,
      };
      w.policies.push(v);
      log('STATIONING_POLICY_CHANGED', a.key, POLICY_LABEL[a.key] + ': ' + policyValue(a.key, prev.value) + ' ← ' + policyValue(a.key, a.value) + ' · الإصدار ' + v.version + ' · يسري من ' + when(a.effectiveFrom) + ' · الطلبات المرسلة تبقى على إصدارها', actor, {
        policy: a.key,
        version: String(v.version),
        previous: String(prev.value),
        value: String(a.value),
        effectiveFrom: when(a.effectiveFrom),
        changedBy: actor,
        changedAt: when(w.now),
        reason: a.reason,
      });
      break;
    }
    case 'REGISTER_AREAS': {
      const s = w.stationings.find((x) => x.id === a.stationing)!;
      for (const [role, ring] of [['PRIMARY_AREA', a.primary], ['ALTERNATIVE_AREA', a.alternative]] as const)
        w.areas.push({
          id: 'ar-' + s.id + '-' + w.now + (role === 'PRIMARY_AREA' ? '-p' : '-a'),
          stationingId: s.id,
          org: s.org,
          role,
          status: 'ACTIVE',
          ring: ring.map((p) => ({ ...p })),
          validFrom: Math.max(w.now, s.from),
          validTo: s.plannedEnd,
          provenance: { kind: 'EXTERNAL_DECISION', authority: a.authority, reference: a.reference, date: w.now, registeredBy: actor },
        });
      const p = profileAt(w);
      log('STATIONING_AREA_EXTERNAL_REGISTERED', 'ق-خارجي ' + a.reference, 'منطقتا الانتشار الرئيسية والبديلة لتمركز ' + orgName(s.org) + ' · بملف ' + profileRef(p) + ' · السبب: ' + a.reason, actor, {
        stationing: s.id,
        authority: a.authority,
        reference: a.reference,
        registeredBy: actor,
        profile: profileRef(p) + ' · ' + MEASURE_LABEL[p.measure],
      });
      break;
    }
    case 'TICK':
      tick(w, a.to);
      break;
  }
  return w;
}

/**
 * At activation the approved site's deployment package, if it has one, becomes two area records of the new stationing
 * context — never an empty record. They belong to the requesting organisation's record when the whole organisation
 * moves, otherwise to the first listed unit's; that record's covered scope is the request's units, listed explicitly
 * (A2). A temporary record's areas run with its validity period and end with it (A3).
 */
function attachAreas(w: World, r: Request, units: string[], recordOf: (u: string) => string, actor: string) {
  const p = r.proposal.areas?.PRIMARY_AREA;
  const alt = r.proposal.areas?.ALTERNATIVE_AREA;
  const reqLabel = r.policy ? AREQ_LABEL[r.policy.areas.value] + ' (الإصدار ' + r.policy.areas.version + ')' : '—';
  if (!p || !alt) {
    w.events.push({ at: w.now, actor, type: 'STATIONING_WITHOUT_AREAS', ref: r.number, detail: 'سياسة الطلب ' + reqLabel + ': لا منطقتي انتشار في الطلب، فلم يُنشأ أي سجل فارغ. تُسجَّلان لاحقاً بإجراء مخوّل مستقل.' });
    return;
  }
  const s = w.stationings.find((x) => x.id === recordOf(r.scope.whole ? r.org : units[0]))!;
  s.covered = [...units];
  for (const [role, ring] of [['PRIMARY_AREA', p], ['ALTERNATIVE_AREA', alt]] as const)
    w.areas.push({
      id: 'ar-' + r.number + (role === 'PRIMARY_AREA' ? '-p' : '-a'),
      stationingId: s.id,
      org: s.org,
      role,
      status: 'ACTIVE',
      ring: ring.map((q) => ({ ...q })),
      validFrom: s.from,
      validTo: s.plannedEnd,
      provenance: { kind: 'IN_APP_REQUEST', request: r.number },
    });
  w.events.push({
    at: w.now,
    actor,
    type: 'STATIONING_AREAS_ATTACHED',
    ref: r.number,
    detail: 'منطقتا الانتشار الرئيسية والبديلة سُجِّلتا لتمركز ' + orgName(s.org) + (s.kind === 'TEMPORARY' ? ' المؤقت، وتنتهيان معه' : ' الجديد') + ' · النطاق المغطى ' + units.length + ' وحدة',
    data: { stationing: s.id, areasRequirement: reqLabel, profile: r.policy ? profileRef(profileByVersion(w, r.policy.profile)) : '—', coveredScope: units.join('، ') },
  });
}

/** A temporary record and the records it extends: its deployment areas hang on the first of them. */
function chainOf(w: World, t: Stationing) {
  const ids = [t.id];
  for (let s: Stationing | undefined = t; s?.extendsId; ) {
    ids.push(s.extendsId);
    s = w.stationings.find((x) => x.id === s!.extendsId);
  }
  return ids;
}

function endTemporary(w: World, t: Stationing, reason: NonNullable<Stationing['endReason']>, actor: string, ref: string, endRef?: string) {
  const plannedEnd = t.plannedEnd!;
  Object.assign(t, { state: 'ENDED', to: w.now, actualEnd: w.now, endReason: reason, endRef: endRef ?? ref });
  // a successor of an extension never starts once its predecessor ended otherwise
  for (const s of w.stationings.filter((x) => x.extendsId === t.id && x.state === 'SCHEDULED')) Object.assign(s, { state: 'ENDED', to: w.now, actualEnd: w.now, endReason: reason, endRef: endRef ?? ref });
  // only the temporary record's own areas; the original stationing's areas continue (A3)
  for (const id of chainOf(w, t)) retireAreas(w, id, actor);
  if (reason === 'SUPERSEDED_BY_PERMANENT_STATIONING') {
    const req = w.requests.find((x) => x.id === t.requestId);
    if (req && !w.stationings.some((s) => s.requestId === req.id && s.kind === 'TEMPORARY' && (s.state === 'ACTIVE' || s.state === 'SCHEDULED'))) req.state = 'TEMPORARY_ENDED';
    if (req) lapse(w, req.id, actor, 'حلّ تمركز دائم محل المؤقت قبل تفعيل التمديد');
    // A1: superseded by the approved permanent stationing — not an early return
    w.events.push({
      at: w.now,
      actor,
      type: 'STATIONING_TEMPORARY_SUPERSEDED',
      ref: req?.number ?? t.id,
      detail: 'انتهى ذرياً بتفعيل الدائم ' + ref + ' · النهاية المخططة ' + day(plannedEnd) + ' · الفعلية ' + day(w.now),
      data: { temporaryStationing: t.id, permanentRequest: ref, actualEnd: day(w.now), plannedEnd: day(plannedEnd), reason: 'SUPERSEDED_BY_PERMANENT_STATIONING', actor, activationRef: endRef ?? '—' },
    });
  }
}

/**
 * Pending follow-ups of a temporary stationing that ended or never started: extensions lapse (A5), early returns are
 * moot, and a pending start cancellation is no longer actionable (kept, with the reason).
 */
function lapse(w: World, reqId: string, actor: string, why: string, at = w.now) {
  for (const e of w.extensions.filter((x) => x.parent === reqId && (x.state === 'EXTENSION_APPROVED_NOT_ACTIVATED' || x.state === 'SUBMITTED'))) {
    Object.assign(e, { state: 'LAPSED_NOT_ACTIVATED', lapsedAt: at, lapseReason: why });
    w.events.push({ at: w.now, actor, type: 'EXTENSION_LAPSED_NOT_ACTIVATED', ref: e.number, detail: why + ' · الفترة المقصودة حتى ' + day(e.newEnd) + ' · لا يُفعَّل بعد الآن' });
  }
  for (const e of w.earlyReturns.filter((x) => x.request === reqId && x.state === 'REQUESTED')) e.state = 'SUPERSEDED';
  const req = w.requests.find((x) => x.id === reqId);
  for (const sc of w.startCancellations.filter((x) => x.request === reqId && x.state === 'REQUESTED')) {
    Object.assign(sc, { state: 'NO_LONGER_ACTIONABLE', closedAt: at, closeReason: why });
    w.events.push({ at: w.now, actor, type: 'TEMPORARY_START_CANCELLATION_NO_LONGER_ACTIONABLE', ref: req?.number ?? reqId, detail: why + ' · طلب الإلغاء محفوظ بسببه ولم يعد قابلاً للقرار' });
  }
}

function retireAreas(w: World, stationingId: string, actor: string, why = 'تبقى في التاريخ مع تمركزها', at = w.now) {
  for (const a of w.areas.filter((x) => x.stationingId === stationingId && x.status === 'ACTIVE')) {
    a.status = 'RETIRED';
    a.retiredAt = at;
    w.events.push({ at, actor, type: 'STATIONING_AREA_RETIRED_WITH_STATIONING', ref: a.id, detail: AREA_LABEL[a.role] + ' ' + why });
  }
}

/** System transitions up to `to`: policy versions taking effect, reminders (advisory), starts, expiry (D11). */
function tick(w: World, to: number) {
  const from = w.now;
  w.now = to;
  const sys = (type: string, ref: string, detail: string) => w.events.push({ at: to, actor: 'system', type, ref, detail });
  const once = new Set<string>(); // one notice per request, not per unit
  for (const p of w.policies.filter((x) => x.effectiveFrom > from && x.effectiveFrom <= to))
    w.events.push({ at: p.effectiveFrom, actor: 'system', type: 'STATIONING_POLICY_EFFECTIVE', ref: p.key, detail: 'سرى الإصدار ' + p.version + ' (' + policyValue(p.key, p.value) + ') على المسودات والطلبات الجديدة؛ المرسلة تبقى على إصدارها' });
  for (const t of w.stationings.filter((s) => s.kind === 'TEMPORARY' && s.state === 'ACTIVE' && s.plannedEnd)) {
    const req = w.requests.find((x) => x.id === t.requestId);
    for (const off of w.reminderOffsets) {
      const at = t.plannedEnd! - off;
      const key = (req?.id ?? t.id) + ':' + off + ':' + t.plannedEnd;
      if (at > from && at <= to && !once.has(key) && once.add(key))
        sys('STATIONING_EXPIRY_REMINDER_SENT', req?.number ?? t.id, 'قبل ' + Math.round(off / DAY) + ' يوم من النهاية · الجهة، ومقدم الطلب، ومن يملك التمديد أو العودة' + (off <= 2 * DAY ? ' · تعذّر التسليم لمستلم واحد (محاكاة)؛ لا أثر على الانتهاء' : ''));
    }
  }
  // The start job only starts SCHEDULED records of a request still waiting for its start (A4); with a start cancellation
  // pending it does not start at all: the start is held until the decision (A6).
  for (const t of w.stationings.filter((s) => s.kind === 'TEMPORARY' && s.state === 'SCHEDULED' && !s.extendsId && s.plannedStart! <= to)) {
    const req = w.requests.find((x) => x.id === t.requestId);
    if (!req || req.state !== 'TEMPORARY_SCHEDULED') continue;
    const pending = w.startCancellations.filter((x) => x.request === req.id && x.state === 'REQUESTED');
    if (pending.length) {
      req.state = 'START_HELD_PENDING_CANCELLATION';
      for (const sc of pending) sc.heldAt = t.plannedStart;
      w.events.push({
        at: t.plannedStart!,
        actor: 'system',
        type: 'STATIONING_START_HELD',
        ref: req.number,
        detail: 'بلغ البداية المعتمدة وطلب الإلغاء قبل البدء ما زال قيد القرار: لم يبدأ النفاذ، والدائم هو المعتمد',
        data: { plannedStart: when(t.plannedStart!), plannedEnd: when(t.plannedEnd!), startCancellation: pending.map((x) => x.id).join('، ') },
      });
      continue;
    }
    t.state = 'ACTIVE';
    if (!once.has('start:' + req.id) && once.add('start:' + req.id)) sys('STATIONING_TEMPORARY_STARTED', req.number, 'بلغ البداية المعتمدة ' + day(t.plannedStart!));
  }
  for (const req of w.requests.filter((x) => x.state === 'TEMPORARY_SCHEDULED' && w.stationings.some((s) => s.requestId === x.id && s.state === 'ACTIVE'))) req.state = 'ACTIVE_TEMPORARY';
  // A held start never starts by itself. When the planned end (an activated extension's, if any) passes first, the records
  // close as never effective and the pending cancellation is no longer actionable; both stay in history.
  for (const req of w.requests.filter((x) => x.state === 'START_HELD_PENDING_CANCELLATION')) {
    const segs = w.stationings.filter((s) => s.requestId === req.id && s.kind === 'TEMPORARY' && s.state === 'SCHEDULED');
    for (const s of segs)
      if (s.plannedEnd! <= to) {
        Object.assign(s, { state: 'WINDOW_EXPIRED_WITHOUT_START', to: s.plannedEnd });
        retireAreas(w, s.id, 'system', 'لم يصبح تمركزها نافذاً', s.plannedEnd);
      }
    if (segs.some((s) => s.plannedEnd! > to)) continue;
    const end = Math.max(...segs.map((s) => s.plannedEnd!));
    req.state = 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START';
    const sc = w.startCancellations.filter((x) => x.request === req.id && x.state === 'REQUESTED');
    w.events.push({
      at: end,
      actor: 'system',
      type: 'STATIONING_TEMPORARY_WINDOW_EXPIRED_WITHOUT_START',
      ref: req.number,
      detail: 'انقضت نافذة النفاذ والبدء موقوف بانتظار قرار الإلغاء: لم يصبح المؤقت نافذاً قط · السجلان محفوظان',
      data: { plannedStart: when(req.duration.start), plannedEnd: when(end), heldSince: when(sc[0]?.heldAt ?? req.duration.start), startCancellation: sc.map((x) => x.id).join('، ') },
    });
    lapse(w, req.id, 'system', 'انقضت نافذة النفاذ دون بدء', end);
  }
  for (const t of w.stationings.filter((s) => s.kind === 'TEMPORARY' && s.state === 'ACTIVE' && s.plannedEnd! <= to)) {
    const next = w.stationings.find((s) => s.extendsId === t.id && s.state === 'SCHEDULED');
    const req = w.requests.find((x) => x.id === t.requestId);
    Object.assign(t, { state: 'ENDED', to: t.plannedEnd, actualEnd: t.plannedEnd, endReason: next ? 'SUPERSEDED_BY_EXTENSION' : 'EXPIRED' });
    if (next) {
      next.state = 'ACTIVE';
      const key = 'ext:' + (req?.id ?? t.id);
      if (req && !once.has(key) && once.add(key)) sys('STATIONING_TEMPORARY_EXTENDED', req.number, 'بدأت فترة التمديد حتى ' + day(next.plannedEnd!));
    } else {
      // the temporary record's own deployment areas end with it; they never become the original stationing's
      for (const id of chainOf(w, t)) retireAreas(w, id, 'system', 'انتهت مع التمركز المؤقت ولا تنتقل إلى التمركز الأصلي', t.plannedEnd);
      if (req && !w.stationings.some((s) => s.requestId === req.id && s.kind === 'TEMPORARY' && s.state !== 'ENDED')) {
        req.state = 'TEMPORARY_ENDED';
        sys('STATIONING_TEMPORARY_EXPIRED', req.number, 'انتقال نظام عند النهاية المعتمدة · عاد النطاق إلى تمركزه الأصلي المحفوظ · السجل مُغلق لا محذوف');
        lapse(w, req.id, 'system', 'بلغ المؤقت نهايته قبل تفعيل التمديد');
      }
    }
  }
}

// ---- labels ----

export const day = (t: number) => new Date(t).toLocaleDateString('ar-AE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });
/** Date and time, where a start, a decision and an effective start must be told apart. */
export const when = (t: number) =>
  new Date(t).toLocaleString('ar-AE', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai' });

export const STATE_LABEL: Record<RelState, string> = {
  DRAFT: 'مسودة',
  UNDER_REVIEW: 'قيد الاعتماد',
  RETURNED_FOR_CHANGES: 'معاد للتعديل',
  REJECTED: 'مرفوض',
  APPROVED_NOT_ACTIVATED: 'معتمد — لم يُفعَّل',
  CANCELLATION_PENDING: 'طلب إلغاء قيد القرار',
  CANCELLED_BEFORE_ACTIVATION: 'ملغى قبل التفعيل',
  ACTIVATED_PERMANENT: 'مُفعَّل — دائم',
  TEMPORARY_SCHEDULED: 'مؤقت مُفعَّل — لم يبدأ',
  START_HELD_PENDING_CANCELLATION: 'البدء موقوف بانتظار قرار الإلغاء',
  TEMPORARY_CANCELLED_BEFORE_START: 'مؤقت أُلغي قبل بدء النفاذ',
  TEMPORARY_WINDOW_EXPIRED_WITHOUT_START: 'انقضت النافذة دون بدء — لم يصبح نافذاً',
  ACTIVE_TEMPORARY: 'مؤقت ساري',
  TEMPORARY_ENDED: 'انتهى المؤقت',
  CLOSED: 'مغلق',
};
export const EXT_LABEL: Record<ExtState, string> = {
  SUBMITTED: 'قيد المراجعة',
  EXTENSION_APPROVED_NOT_ACTIVATED: 'تمديد معتمد — لم يُفعَّل',
  EXTENSION_ACTIVATED: 'تمديد مُفعَّل',
  LAPSED_NOT_ACTIVATED: 'سقط دون تفعيل',
  CANCELLATION_PENDING: 'طلب إلغاء قيد القرار',
  CANCELLED_BEFORE_ACTIVATION: 'ملغى قبل التفعيل',
};
export const FACT_LABEL: Record<Fact, string> = { SCOPE: 'النطاق', CLASSIFICATION: 'دائم/مؤقت', DURATION: 'المدة', SITE: 'الموقع ومنطقتا الانتشار', AVAILABILITY: 'الإتاحة' };
