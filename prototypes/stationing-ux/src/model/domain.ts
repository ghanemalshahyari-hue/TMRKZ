// The stationing domain model V2 (docs/STATIONING_DOMAIN_MODEL_V2_AR.md) as a pure, simulated state machine for the
// isolated prototype. Every rule the server would enforce is a guard here, so the screens can show which action is
// possible for which simulated person and why not. Nothing is persisted; no server is called.
import { centroid, pointInRing, ringsIntersect, type Ring } from '../../../../frontend/src/lib/footprint';
import { orgById } from '../data';

export const DAY = 86_400_000;

export type Perm =
  | 'CREATE'
  | 'REVIEW'
  | 'APPROVE'
  | 'MANAGE_STATIONING'
  | 'ACTIVATE_STATIONING'
  | 'ACTIVATE_TEMPORARY_EXTENSION'
  | 'DECIDE_EARLY_RETURN'
  | 'SWITCH_RELOCATION_CANDIDATE'
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
   * never became effective either (owner correction of 3 Nov 2026).
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

export type Fact = 'SCOPE' | 'CLASSIFICATION' | 'DURATION' | 'CANDIDATE' | 'AVAILABILITY';
export type Stage = { key: string; name: string; perm: Perm; final?: boolean; dependsOn: Fact[]; mark?: 'APPROVED' | 'CARRIED' | 'INVALIDATED'; by?: string; candidate?: CandRole };

export type CandRole = 'PRIMARY' | 'ALTERNATIVE';
export type CandStatus = 'PROPOSED' | 'STANDBY' | 'UNDER_REVIEW' | 'APPROVED' | 'NOT_ACCEPTED' | 'REJECTED_FINAL';
export type Candidate = { role: CandRole; name: string; ring: Ring; siteId: string | null; status: CandStatus; reason?: string };

export type RelState =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW_PRIMARY'
  | 'PRIMARY_NOT_ACCEPTED'
  | 'UNDER_REVIEW_ALTERNATIVE'
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
  duration: { type: 'PERMANENT' | 'TEMPORARY'; start: number; end?: number };
  fromSiteId: string;
  candidates: Record<CandRole, Candidate>;
  active: CandRole;
  state: RelState;
  requester: string;
  finalApprover?: string;
  stages: Stage[];
  cursor: number;
  cancellation?: { state: 'PENDING' | 'APPROVED' | 'REJECTED'; by: string; reason: string; decidedBy?: string; decision?: string };
  /** Active or scheduled temporary stationings in scope, shown to the final approver: they end at activation (D13). */
  supersedes?: string[];
  /** The permanent records of the scope at final approval; activation is refused if they changed. */
  approvedSnapshot?: string[];
  activation?: { by: string; at: number; ref: string };
};

export type ExtState = 'SUBMITTED' | 'EXTENSION_APPROVED_NOT_ACTIVATED' | 'EXTENSION_ACTIVATED' | 'LAPSED_NOT_ACTIVATED' | 'CANCELLATION_PENDING' | 'CANCELLED_BEFORE_ACTIVATION';
export type Extension = { id: string; number: string; parent: string; newEnd: number; state: ExtState; requester: string; finalApprover?: string; lapsedAt?: number; lapseReason?: string };
export type EarlyReturn = { id: string; request: string; state: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED'; by: string; reason: string; decidedBy?: string; originalEnd: number; actualEnd?: number };
/**
 * «إلغاء التمركز المؤقت قبل بدء النفاذ» (A4) — not an early return: nothing was ever effective. While it is pending at
 * the planned start, the start is held (`heldAt`); if the window closes first it is NO_LONGER_ACTIONABLE (owner
 * correction of 3 Nov 2026).
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
  /** When the start job held the start because this request was still pending. */
  heldAt?: number;
  /** The actual effective start after a rejection decided after the planned start. */
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
  events: Event[];
};

export type Action =
  | { t: 'SUBMIT'; req: string }
  | { t: 'APPROVE_STAGE'; req: string }
  | { t: 'NOT_ACCEPT'; req: string; reason: string }
  | { t: 'FINAL_REJECT_CANDIDATE'; req: string; reason: string }
  | { t: 'SWITCH'; req: string; reason: string }
  | { t: 'REOPEN'; req: string; role: CandRole; reason: string }
  | { t: 'RETURN'; req: string; reason: string }
  | { t: 'RESUBMIT'; req: string; changed: Fact[]; reason: string }
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
  | { t: 'TICK'; to: number };

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });
const yes: Verdict = { ok: true };

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

export function within(w: World, org: string, root: string): boolean {
  for (let cur: string | null = org; cur; cur = w.orgParent[cur] ?? null) if (cur === root) return true;
  return false;
}
export function descendants(w: World, org: string): string[] {
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

// ---- availability: associated areas block, except inside their explicitly covered scope (D4, A2) ----

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
 * Every spatial AND time overlap of a footprint for an organisation and a period. `exempt` marks an associated area whose
 * approved stationing scope covers the organisation: that area alone does not block it (A2). Exempt or not, the other
 * areas and reservations are still checked.
 */
export function clashes(w: World, org: string, ring: Ring, from: number, to: number | undefined, self?: string): Clash[] {
  const out: Clash[] = [];
  for (const a of w.areas) {
    if (a.status !== 'ACTIVE' || !overlaps(a.validFrom, a.validTo, from, to) || !intersects(a.ring, ring)) continue;
    const label = (a.role === 'PRIMARY_AREA' ? 'المنطقة الرئيسية' : 'المنطقة البديلة') + ' المرتبطة بتمركز ' + (orgById.get(a.org)?.name ?? a.org);
    out.push({ kind: 'AREA', id: a.id, label, owner: a.org, from: Math.max(a.validFrom, from), to: endOf(a.validTo, to), exempt: coveredBy(w, a.stationingId).includes(org) });
  }
  for (const r of w.reservations) {
    if (r.id === self || r.state !== 'ACTIVE' || !overlaps(r.from, r.to, from, to) || !intersects(r.ring, ring)) continue;
    out.push({ kind: 'RESERVATION', id: r.id, label: 'حجز ' + r.number + ' لـ' + (orgById.get(r.org)?.name ?? r.org), owner: r.org, from: Math.max(r.from, from), to: endOf(r.to, to), exempt: false });
  }
  return out;
}
export const blocking = (c: Clash[]) => c.filter((x) => !x.exempt);

// ---- workflow: what each stage's decision depends on (D2, D18) ----

/** The impact of a change: the facts it touches, the restart stage, invalidated and carried decisions. */
export function impact(stages: Stage[], changed: Fact[]) {
  const affected = new Set<Fact>(changed);
  if (affected.has('CLASSIFICATION')) affected.add('DURATION');
  if (affected.has('SCOPE') || affected.has('DURATION') || affected.has('CANDIDATE')) affected.add('AVAILABILITY');
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

function applyImpact(r: Request, changed: Fact[]) {
  const im = impact(r.stages, changed);
  for (const s of r.stages) {
    if (im.invalidated.includes(s.key)) Object.assign(s, { mark: 'INVALIDATED', by: undefined, candidate: undefined });
    if (im.carried.includes(s.key)) s.mark = 'CARRIED';
  }
  r.cursor = nextOpen(r, im.restart);
  return im;
}
const nextOpen = (r: Request, from: number) => {
  let i = from;
  while (i < r.stages.length && (r.stages[i].mark === 'APPROVED' || r.stages[i].mark === 'CARRIED')) i++;
  return i;
};
const reviewState = (role: CandRole): RelState => (role === 'PRIMARY' ? 'UNDER_REVIEW_PRIMARY' : 'UNDER_REVIEW_ALTERNATIVE');

// ---- guards ----

export function check(w: World, actor: string, a: Action): Verdict {
  if (a.t === 'TICK') return a.to > w.now ? yes : no('الوقت لا يعود إلى الوراء.');
  const r = 'req' in a ? w.requests.find((x) => x.id === a.req) : undefined;
  switch (a.t) {
    case 'SUBMIT':
      if (!r || (r.state !== 'DRAFT' && r.state !== 'RETURNED_FOR_CHANGES')) return no('ليس مسودة.');
      return sameHuman(w, actor, r.requester) ? yes : no('يرسله مقدم الطلب.');
    case 'APPROVE_STAGE':
    case 'NOT_ACCEPT':
    case 'FINAL_REJECT_CANDIDATE':
    case 'RETURN': {
      if (!r || !['SUBMITTED', 'UNDER_REVIEW_PRIMARY', 'UNDER_REVIEW_ALTERNATIVE'].includes(r.state)) return no('الطلب ليس قيد المراجعة.');
      const st = r.stages[r.cursor];
      if (!st) return no('لا مرحلة مفتوحة.');
      if (!holds(w, actor, st.perm, r.org)) return no('لا تملك صفة مرحلة «' + st.name + '» على نطاق الطلب.');
      if (sameHuman(w, actor, r.requester)) return no('فصل المهام: لا يراجع مقدم الطلب طلبه.');
      if ((a.t === 'NOT_ACCEPT' || a.t === 'FINAL_REJECT_CANDIDATE') && !st.dependsOn.includes('CANDIDATE'))
        return no('مرحلة «' + st.name + '» لا تعتمد على الموقع؛ «لم يُقبل المرشح» يُقرر في مراحل الموقع.');
      return yes;
    }
    case 'SWITCH':
    case 'REOPEN': {
      if (!r) return no('لا طلب.');
      if (!holds(w, actor, 'SWITCH_RELOCATION_CANDIDATE', r.org)) return no('تبديل المرشح يتطلب صلاحية SWITCH_RELOCATION_CANDIDATE.');
      if (sameHuman(w, actor, r.requester)) return no('فصل المهام: مقدم الطلب يطلب التبديل ولا ينفذه.');
      if (a.t === 'SWITCH') {
        if (r.state !== 'PRIMARY_NOT_ACCEPTED') return no('التبديل إلى البديل بعد «لم يُقبل» الرئيسي.');
        const alt = r.candidates.ALTERNATIVE;
        if (!alt || alt.status === 'REJECTED_FINAL') return no('لا مرشح بديل صالح للمراجعة.');
        return yes;
      }
      const c = r.candidates[a.role];
      if (c.status === 'REJECTED_FINAL') return no('المرشح مرفوض نهائياً؛ يلزم طلب جديد أو إعادة نظر بالسياسة.');
      if (c.status !== 'NOT_ACCEPTED') return no('يُعاد فتح مرشح «لم يُقبل» فقط.');
      return ['PRIMARY_NOT_ACCEPTED', 'UNDER_REVIEW_ALTERNATIVE', 'UNDER_REVIEW_PRIMARY'].includes(r.state) ? yes : no('الطلب ليس في المراجعة.');
    }
    case 'RESUBMIT':
      if (!r || r.state !== 'RETURNED_FOR_CHANGES') return no('ليس معاداً.');
      if (!sameHuman(w, actor, r.requester)) return no('يعيد إرساله مقدم الطلب.');
      return a.changed.length && a.reason.trim().length < 5 ? no('اذكر سبب التغيير.') : yes;
    case 'ACTIVATE': {
      if (!r) return no('لا طلب.');
      if (r.state === 'CANCELLATION_PENDING') return no('محجوب: طلب إلغاء قبل التفعيل قيد القرار.');
      if (r.state !== 'APPROVED_NOT_ACTIVATED') return no('التفعيل لطلب «معتمد — لم يُفعَّل» فقط.');
      if (!holds(w, actor, 'ACTIVATE_STATIONING', r.org)) return no('التفعيل يتطلب صلاحية ACTIVATE_STATIONING على النطاق.');
      if (sameHuman(w, actor, r.requester)) return no('فصل المهام: مقدم الطلب لا يفعّل طلبه.');
      if (sameHuman(w, actor, r.finalApprover)) return no('فصل المهام: صاحب الاعتماد النهائي لا يفعّل ما اعتمده (بالإنسان، شاملاً التفويض والحسابات المرتبطة).');
      const c = r.candidates[r.active];
      if (c.status !== 'APPROVED') return no('لا مرشح معتمد.');
      if (!c.siteId) return no('الموقع المعتمد غير مسجل؛ يسجله مسؤول المرافق أولاً. التفعيل لا يُنشئ مواقع.');
      const units = unitsOf(w, r);
      if (r.approvedSnapshot && units.map((u) => permanentOf(w, u)?.id ?? '-').join() !== r.approvedSnapshot.join())
        return no('تغيّر التمركز الدائم في النطاق منذ الاعتماد.');
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
      r!.candidates.PRIMARY.status = 'UNDER_REVIEW';
      if (r!.candidates.ALTERNATIVE) r!.candidates.ALTERNATIVE.status = 'STANDBY';
      r!.cursor = 0;
      r!.state = r!.stages[0].dependsOn.includes('CANDIDATE') ? 'UNDER_REVIEW_PRIMARY' : 'SUBMITTED';
      log('REQUEST_SUBMITTED', r!.number, 'المرشح النشط: الرئيسي');
      break;
    }
    case 'APPROVE_STAGE': {
      const st = r!.stages[r!.cursor];
      Object.assign(st, { mark: 'APPROVED', by: actor, candidate: st.dependsOn.includes('CANDIDATE') ? r!.active : undefined });
      if (st.final) {
        r!.state = 'APPROVED_NOT_ACTIVATED';
        r!.finalApprover = actor;
        r!.candidates[r!.active].status = 'APPROVED';
        const units = unitsOf(w, r!);
        r!.approvedSnapshot = units.map((u) => permanentOf(w, u)?.id ?? '-');
        if (r!.duration.type === 'PERMANENT') r!.supersedes = units.map((u) => temporaryOf(w, u)?.id).filter(Boolean) as string[];
        log('REQUEST_APPROVED', r!.number, 'اعتماد نهائي للمرشح ' + roleName(r!.active) + (r!.supersedes?.length ? '؛ يُنهي التفعيل ' + r!.supersedes.length + ' تمركزاً مؤقتاً قائماً' : ''));
      } else {
        r!.cursor = nextOpen(r!, r!.cursor + 1);
        if (r!.stages[r!.cursor]?.dependsOn.includes('CANDIDATE') && r!.state === 'SUBMITTED') r!.state = reviewState(r!.active);
        log('STAGE_APPROVED', r!.number, st.name);
      }
      break;
    }
    case 'NOT_ACCEPT':
    case 'FINAL_REJECT_CANDIDATE': {
      const c = r!.candidates[r!.active];
      c.status = a.t === 'NOT_ACCEPT' ? 'NOT_ACCEPTED' : 'REJECTED_FINAL';
      c.reason = a.reason;
      const other = r!.candidates[r!.active === 'PRIMARY' ? 'ALTERNATIVE' : 'PRIMARY'];
      const otherOpen = other && (other.status === 'STANDBY' || other.status === 'NOT_ACCEPTED');
      if (r!.active === 'PRIMARY' && otherOpen) r!.state = 'PRIMARY_NOT_ACCEPTED';
      else if (r!.active === 'ALTERNATIVE' && other?.status === 'NOT_ACCEPTED') r!.state = 'PRIMARY_NOT_ACCEPTED';
      else {
        r!.state = 'REJECTED';
        for (const x of Object.values(r!.candidates)) if (x.status !== 'APPROVED') x.status = 'REJECTED_FINAL';
      }
      log(a.t === 'NOT_ACCEPT' ? 'RELOCATION_CANDIDATE_NOT_ACCEPTED' : 'RELOCATION_CANDIDATE_REJECTED_FINAL', r!.number, roleName(c.role) + ' — ' + a.reason);
      break;
    }
    case 'SWITCH':
    case 'REOPEN': {
      const to: CandRole = a.t === 'SWITCH' ? 'ALTERNATIVE' : a.role;
      const from = r!.active;
      const prevState = r!.state;
      if (from !== to && r!.candidates[from].status === 'UNDER_REVIEW') r!.candidates[from].status = 'STANDBY';
      r!.active = to;
      r!.candidates[to].status = 'UNDER_REVIEW';
      const im = applyImpact(r!, ['CANDIDATE']);
      r!.state = reviewState(to);
      if (a.t === 'REOPEN') log('REOPEN_CANDIDATE', r!.number, roleName(to) + ' — ' + a.reason);
      log('RELOCATION_ACTIVE_CANDIDATE_CHANGED', r!.number,
        roleName(from) + ' ← ' + roleName(to) + ' · الحالة السابقة ' + STATE_LABEL[prevState] + ' · السبب: ' + a.reason + ' · استئناف من «' + r!.stages[im.restart].name + '»' +
          (im.invalidated.length ? ' · أُبطل: ' + im.invalidated.length : '') + (im.carried.length ? ' · حُمل: ' + im.carried.length : ''));
      break;
    }
    case 'RETURN':
      r!.state = 'RETURNED_FOR_CHANGES';
      log('REQUEST_RETURNED', r!.number, a.reason + ' · المرشح النشط باقٍ: ' + roleName(r!.active));
      break;
    case 'RESUBMIT': {
      const im = applyImpact(r!, a.changed);
      r!.state = r!.stages[r!.cursor]?.dependsOn.includes('CANDIDATE') || r!.stages[r!.cursor]?.final ? reviewState(r!.active) : 'SUBMITTED';
      log('WORKFLOW_INVALIDATION', r!.number, 'تغيّر: ' + a.changed.join('، ') + ' · السبب: ' + a.reason + ' · استئناف من «' + r!.stages[im.restart].name + '» · أُبطل ' + im.invalidated.length + ' · حُمل ' + im.carried.length);
      break;
    }
    case 'ACTIVATE': {
      const c = r!.candidates[r!.active];
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
            Object.assign(p, { state: 'ENDED', to: w.now, endReason: 'REPLACED_BY_ACTIVATION' });
            retireAreas(w, p.id, actor);
          }
          w.stationings.push({ id: 'st-' + u + '-' + w.now, org: u, kind: 'PERMANENT', siteId: c.siteId!, state: 'CURRENT', from: w.now, requestId: r!.id });
        }
        r!.state = 'ACTIVATED_PERMANENT';
        log('STATIONING_ACTIVATED', r!.number, 'دائم · ' + units.length + ' وحدة' + (ended.length ? ' · أُنهي ذرياً تمركز مؤقت لـ' + ended.length + ' وحدة' : '') + (a.reason ? ' · السبب: ' + a.reason : ''), actor, {
          activationRef: r!.activation.ref,
        });
      } else {
        const started = w.now >= r!.duration.start;
        for (const u of units)
          w.stationings.push({
            id: 'st-t-' + u + '-' + w.now,
            org: u,
            kind: 'TEMPORARY',
            baseId: permanentOf(w, u)?.id,
            siteId: c.siteId!,
            state: started ? 'ACTIVE' : 'SCHEDULED',
            from: Math.max(w.now, r!.duration.start),
            plannedStart: r!.duration.start,
            plannedEnd: r!.duration.end,
            requestId: r!.id,
          });
        r!.state = started ? 'ACTIVE_TEMPORARY' : 'TEMPORARY_SCHEDULED';
        // A3: a temporary stationing never ends the permanent one, nor retires its associated areas
        log('STATIONING_ACTIVATED', r!.number, 'مؤقت · ' + units.length + ' وحدة · ' + (started ? 'ساري' : 'مجدول حتى بلوغ البداية') + ' · الدائم ومنطقتاه باقية' + (a.reason ? ' · السبب: ' + a.reason : ''), actor, {
          activationRef: r!.activation.ref,
        });
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
      log(a.approve ? 'RELOCATION_CANCELLED_BEFORE_ACTIVATION' : 'RELOCATION_CANCELLATION_REJECTED', r!.number,
        a.reason + ' · المرشح ' + roleName(r!.active) + ' · مرجع الاعتماد: قرار ' + (person(w, r!.finalApprover!)?.name ?? ''));
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
        for (const t of w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && s.state === 'ACTIVE'))
          endTemporary(w, t, 'EARLY_RETURN', actor, parent.number, e.id);
        e.actualEnd = w.now;
        parent.state = 'TEMPORARY_ENDED';
        lapse(w, parent.id, actor, 'عودة مبكرة قبل تفعيل التمديد');
      }
      log(a.approve ? 'STATIONING_TEMPORARY_EARLY_RETURN' : 'EARLY_RETURN_REJECTED', parent.number,
        a.reason + ' · النهاية المخططة ' + day(e.originalEnd) + (a.approve ? ' · الفعلية ' + day(w.now) : ''));
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
        for (const t of w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && s.state === 'SCHEDULED'))
          Object.assign(t, { state: 'CANCELLED_BEFORE_START', to: w.now, endRef: sc.id });
        parent.state = 'TEMPORARY_CANCELLED_BEFORE_START';
        lapse(w, parent.id, actor, 'أُلغي التمركز المؤقت قبل بدء النفاذ');
        log('TEMPORARY_CANCELLED_BEFORE_START', parent.number, a.reason + (held ? ' · كان البدء موقوفاً منذ ' + when(sc.heldAt!) : ''), actor, data);
      } else if (!held) {
        // rejected before the planned start: nothing changes, the start job starts it at the approved start
        log('TEMPORARY_START_CANCELLATION_REJECTED', parent.number, a.reason + ' · يبدأ في البداية المعتمدة ' + when(sc.plannedStart), actor, data);
      } else {
        // rejected after the planned start (owner correction): effective from this decision only — never backdated; the
        // approved end stays, or an activated extension's
        const seg = w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && s.state === 'SCHEDULED' && s.plannedStart! <= w.now && w.now < s.plannedEnd!);
        for (const t of seg) Object.assign(t, { state: 'ACTIVE', from: w.now, startRef: sc.id });
        sc.effectiveStart = w.now;
        parent.state = 'ACTIVE_TEMPORARY';
        const end = Math.max(...w.stationings.filter((s) => s.requestId === parent.id && s.kind === 'TEMPORARY' && (s.state === 'ACTIVE' || s.state === 'SCHEDULED')).map((s) => s.plannedEnd!));
        data.actualEffectiveStart = when(w.now);
        data.effectiveEnd = when(end);
        log('TEMPORARY_START_CANCELLATION_REJECTED', parent.number, a.reason, actor, data);
        log('STATIONING_TEMPORARY_STARTED', parent.number,
          'بدأ النفاذ من وقت القرار ' + when(w.now) + ' لا من البداية المعتمدة ' + when(sc.plannedStart) + ' (دون أثر رجعي) · النهاية ' + when(end), actor, {
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
      log(b.length ? 'RESERVATION_BLOCKED' : 'RESERVATION_CONFIRMED', res.number,
        b.length ? 'منع افتراضي: ' + b.map((c) => c.label).join('، ') : 'لا تعارض' + (cl.some((c) => c.exempt) ? ' · ضمن النطاق المغطى للمنطقة' : ''));
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
    case 'TICK':
      tick(w, a.to);
      break;
  }
  return w;
}

function endTemporary(w: World, t: Stationing, reason: NonNullable<Stationing['endReason']>, actor: string, ref: string, endRef?: string) {
  const plannedEnd = t.plannedEnd!;
  Object.assign(t, { state: 'ENDED', to: w.now, actualEnd: w.now, endReason: reason, endRef: endRef ?? ref });
  // a successor of an extension never starts once its predecessor ended otherwise
  for (const s of w.stationings.filter((x) => x.extendsId === t.id && x.state === 'SCHEDULED')) Object.assign(s, { state: 'ENDED', to: w.now, actualEnd: w.now, endReason: reason, endRef: endRef ?? ref });
  // only the temporary record's own areas; the permanent stationing's areas continue (A3)
  retireAreas(w, t.id, actor);
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
      data: {
        temporaryStationing: t.id,
        permanentRequest: ref,
        actualEnd: day(w.now),
        plannedEnd: day(plannedEnd),
        reason: 'SUPERSEDED_BY_PERMANENT_STATIONING',
        actor,
        activationRef: endRef ?? '—',
      },
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

function retireAreas(w: World, stationingId: string, actor: string) {
  for (const a of w.areas.filter((x) => x.stationingId === stationingId && x.status === 'ACTIVE')) {
    a.status = 'RETIRED';
    a.retiredAt = w.now;
    w.events.push({ at: w.now, actor, type: 'STATIONING_AREA_RETIRED_WITH_STATIONING', ref: a.id, detail: (a.role === 'PRIMARY_AREA' ? 'المنطقة الرئيسية' : 'المنطقة البديلة') + ' تبقى في التاريخ مع تمركزها' });
  }
}

/** System transitions up to `to`: reminders (advisory), starts, expiry; a failed reminder never changes an end (D11). */
function tick(w: World, to: number) {
  const from = w.now;
  w.now = to;
  const sys = (type: string, ref: string, detail: string) => w.events.push({ at: to, actor: 'system', type, ref, detail });
  const once = new Set<string>(); // one notice per request, not per unit
  for (const t of w.stationings.filter((s) => s.kind === 'TEMPORARY' && s.state === 'ACTIVE' && s.plannedEnd)) {
    const req = w.requests.find((x) => x.id === t.requestId);
    for (const off of w.reminderOffsets) {
      const at = t.plannedEnd! - off;
      const key = (req?.id ?? t.id) + ':' + off + ':' + t.plannedEnd;
      if (at > from && at <= to && !once.has(key) && once.add(key))
        sys('STATIONING_EXPIRY_REMINDER_SENT', req?.number ?? t.id, 'قبل ' + Math.round(off / DAY) + ' يوم من النهاية · الجهة، ومقدم الطلب، ومن يملك التمديد أو العودة' + (off <= 2 * DAY ? ' · تعذّر التسليم لمستلم واحد (محاكاة)؛ لا أثر على الانتهاء' : ''));
    }
  }
  // The start job only starts SCHEDULED records of a request still waiting for its start: one cancelled before its
  // start (A4) can never become effective. With a start cancellation still pending it does not start at all: the start
  // is held until the decision (owner correction of 3 Nov 2026; the server's start job checks the same condition).
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
    for (const s of segs) if (s.plannedEnd! <= to) Object.assign(s, { state: 'WINDOW_EXPIRED_WITHOUT_START', to: s.plannedEnd });
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
      retireAreas(w, t.id, 'system');
      if (req && !w.stationings.some((s) => s.requestId === req.id && s.kind === 'TEMPORARY' && s.state !== 'ENDED')) {
        req.state = 'TEMPORARY_ENDED';
        sys('STATIONING_TEMPORARY_EXPIRED', req.number, 'انتقال نظام عند النهاية المعتمدة · عاد النطاق إلى تمركزه الدائم المحفوظ · السجل مُغلق لا محذوف');
        lapse(w, req.id, 'system', 'بلغ المؤقت نهايته قبل تفعيل التمديد');
      }
    }
  }
}

// ---- labels ----

export const roleName = (r: CandRole) => (r === 'PRIMARY' ? 'الرئيسي' : 'البديل');
export const day = (t: number) => new Date(t).toLocaleDateString('ar-AE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });
/** Date and time, where a start, a decision and an effective start must be told apart. */
export const when = (t: number) =>
  new Date(t).toLocaleString('ar-AE', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai' });

export const STATE_LABEL: Record<RelState, string> = {
  DRAFT: 'مسودة',
  SUBMITTED: 'مُرسل',
  UNDER_REVIEW_PRIMARY: 'مراجعة المرشح الرئيسي',
  PRIMARY_NOT_ACCEPTED: 'الرئيسي لم يُقبل',
  UNDER_REVIEW_ALTERNATIVE: 'مراجعة المرشح البديل',
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
export const CAND_LABEL: Record<CandStatus, string> = {
  PROPOSED: 'مقترح',
  STANDBY: 'احتياطي',
  UNDER_REVIEW: 'قيد المراجعة',
  APPROVED: 'معتمد',
  NOT_ACCEPTED: 'لم يُقبل (غير نهائي)',
  REJECTED_FINAL: 'مرفوض نهائياً',
};
export const FACT_LABEL: Record<Fact, string> = { SCOPE: 'النطاق', CLASSIFICATION: 'دائم/مؤقت', DURATION: 'المدة', CANDIDATE: 'الموقع', AVAILABILITY: 'الإتاحة' };
