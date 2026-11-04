import { describe, expect, it } from 'vitest';
import { centroid } from '../../../../frontend/src/lib/footprint';
import { DAY, changedFacts, check, deriveRoute, effectiveOf, footprintCheck, impact, participants, perform, permanentOf, policyAt, proposalAreas, requirementOf, temporaryOf, type World } from './domain';
import { NOW, areaShape, baseWorld, shape } from './fixtures';
import { nearest } from './geometry';
import { SCENARIOS } from './scenarios';

const ok = (w: World, actor: string, a: Parameters<typeof check>[2]) => check(w, actor, a).ok;
const why = (w: World, actor: string, a: Parameters<typeof check>[2]) => {
  const v = check(w, actor, a);
  return v.ok ? '' : v.reason;
};

describe('stationing domain model V2 (simulated rules of docs/STATIONING_DOMAIN_MODEL_V2_AR.md)', () => {
  it('D1/invariant 8: the final approver, their delegate and the requester (any linked account) never activate', () => {
    const w = baseWorld();
    const a = { t: 'ACTIVATE', req: 'r-ga-fin' } as const;
    expect(why(w, 'p-apr', a)).toContain('صاحب الاعتماد النهائي');
    expect(why(w, 'p-apr-del', a)).toContain('صاحب الاعتماد النهائي');
    expect(why(w, 'p-req-dir', a)).toContain('مقدم الطلب');
    expect(ok(w, 'p-act', a)).toBe(true);
  });

  it('D16: a pending cancellation blocks activation in the transition itself; rejection makes it available again', () => {
    let w = perform(baseWorld(), 'p-req', { t: 'REQUEST_CANCEL', req: 'r-ga-fin', reason: 'تغيرت الحاجة' });
    expect(w.requests.find((r) => r.id === 'r-ga-fin')!.state).toBe('CANCELLATION_PENDING');
    expect(() => perform(w, 'p-act', { t: 'ACTIVATE', req: 'r-ga-fin' })).toThrow(/طلب إلغاء/);
    expect(why(w, 'p-req-dir', { t: 'DECIDE_CANCEL', req: 'r-ga-fin', approve: true, reason: 'x' })).toMatch(/صلاحية|طالب الإلغاء/);
    w = perform(w, 'p-dec', { t: 'DECIDE_CANCEL', req: 'r-ga-fin', approve: false, reason: 'الحاجة قائمة' });
    expect(w.requests.find((r) => r.id === 'r-ga-fin')!.state).toBe('APPROVED_NOT_ACTIVATED');
    expect(ok(w, 'p-act', { t: 'ACTIVATE', req: 'r-ga-fin' })).toBe(true);
  });

  it('D9: an approved cancellation makes activation impossible and leaves the stationing unchanged', () => {
    let w = perform(baseWorld(), 'p-req', { t: 'REQUEST_CANCEL', req: 'r-ga-fin', reason: 'تغيرت الحاجة' });
    w = perform(w, 'p-dec', { t: 'DECIDE_CANCEL', req: 'r-ga-fin', approve: true, reason: 'مقبول' });
    expect(w.requests.find((r) => r.id === 'r-ga-fin')!.state).toBe('CANCELLED_BEFORE_ACTIVATION');
    expect(ok(w, 'p-act', { t: 'ACTIVATE', req: 'r-ga-fin' })).toBe(false);
    expect(permanentOf(w, 'o-ga-fin')!.id).toBe('st-o-ga-fin');
  });

  it('D13: a permanent relocation over an active temporary one is one atomic transition; temporary history kept; extension lapses; areas retire', () => {
    const w0 = baseWorld();
    const w = perform(w0, 'p-act', { t: 'ACTIVATE', req: 'r-it-perm' });
    for (const u of ['o-it', 'o-it-net', 'o-it-sup']) {
      expect(temporaryOf(w, u)).toBeUndefined();
      expect(permanentOf(w, u)!.siteId).toBe('c-it-perm');
      expect(w.stationings.find((s) => s.id === 'tmp-' + u)!.endReason).toBe('SUPERSEDED_BY_PERMANENT_STATIONING');
      expect(w.stationings.find((s) => s.id === 'st-' + u)!.endReason).toBe('REPLACED_BY_ACTIVATION');
    }
    const ext = w.extensions.find((e) => e.id === 'ext-it')!;
    expect(ext.state).toBe('LAPSED_NOT_ACTIVATED');
    expect(ext.lapsedAt).toBe(NOW);
    expect(ext.newEnd).toBe(NOW + 42 * DAY); // the intended period stays in history
    expect(w.requests.find((r) => r.id === 'r-it-temp')!.state).toBe('TEMPORARY_ENDED');
    expect(w.areas.filter((a) => a.org === 'o-it').every((a) => a.status === 'RETIRED' && a.retiredAt === NOW)).toBe(true);
    expect(w.stationings.length).toBe(w0.stationings.length + 3); // nothing deleted
  });

  it('A1: the supersession of a temporary stationing records every required fact, and is not an early return', () => {
    const w = perform(baseWorld(), 'p-act', { t: 'ACTIVATE', req: 'r-it-perm' });
    const e = w.events.find((x) => x.type === 'STATIONING_TEMPORARY_SUPERSEDED')!;
    expect(e.data).toMatchObject({
      temporaryStationing: 'tmp-o-it',
      permanentRequest: 'MV-2026-0409',
      reason: 'SUPERSEDED_BY_PERMANENT_STATIONING',
      actor: 'p-act',
      activationRef: 'ACT-MV-2026-0409',
    });
    expect(e.data!.plannedEnd).toBeTruthy();
    expect(e.data!.actualEnd).toBeTruthy();
    expect(w.events.some((x) => x.type === 'STATIONING_TEMPORARY_EARLY_RETURN')).toBe(false);
  });

  it('A5: a lapsed extension can never be activated', () => {
    const w = perform(baseWorld(), 'system', { t: 'TICK', to: NOW + 13 * DAY });
    expect(w.extensions[0].state).toBe('LAPSED_NOT_ACTIVATED');
    expect(w.extensions[0].lapseReason).toContain('قبل تفعيل التمديد');
    expect(ok(w, 'p-act', { t: 'ACTIVATE_EXTENSION', ext: 'ext-it' })).toBe(false);
  });

  it('A3: a temporary stationing, even of the whole organisation, keeps the permanent stationing and its deployment areas', () => {
    let w = baseWorld();
    expect(temporaryOf(w, 'o-it')!.state).toBe('ACTIVE');
    expect(permanentOf(w, 'o-it')!.id).toBe('st-o-it');
    expect(w.areas.filter((a) => a.stationingId === 'st-o-it').every((a) => a.status === 'ACTIVE')).toBe(true);
    w = perform(w, 'system', { t: 'TICK', to: NOW + 13 * DAY }); // the temporary one expires
    expect(w.areas.filter((a) => a.stationingId === 'st-o-it').every((a) => a.status === 'ACTIVE')).toBe(true);
  });

  it('A4: an activated temporary stationing cancelled before its start never becomes effective; not an early return', () => {
    let w = baseWorld();
    expect(why(w, 'p-req', { t: 'REQUEST_EARLY_RETURN', req: 'r-hr-rec', reason: 'x' })).toContain('قبل بدء النفاذ');
    w = perform(w, 'p-req', { t: 'REQUEST_START_CANCEL', req: 'r-hr-rec', reason: 'تأجل المشروع' });
    const sc = w.startCancellations[0].id;
    expect(why(w, 'p-req-dir', { t: 'DECIDE_START_CANCEL', sc, approve: true, reason: 'x' })).toMatch(/DECIDE_TEMPORARY_BEFORE_START_CANCELLATION|طالب الإلغاء/);
    expect(why(w, 'p-act', { t: 'DECIDE_START_CANCEL', sc, approve: true, reason: 'x' })).toContain('DECIDE_TEMPORARY_BEFORE_START_CANCELLATION');
    w = perform(w, 'p-dec', { t: 'DECIDE_START_CANCEL', sc, approve: true, reason: 'مقبول' });
    expect(w.requests.find((r) => r.id === 'r-hr-rec')!.state).toBe('TEMPORARY_CANCELLED_BEFORE_START');
    const ev = w.events.find((e) => e.type === 'TEMPORARY_CANCELLED_BEFORE_START')!;
    expect(ev.data).toMatchObject({ requester: 'p-req', decisionMaker: 'p-dec', activationRef: 'ACT-MV-2026-0407' });
    w = perform(w, 'system', { t: 'TICK', to: NOW + 10 * DAY }); // past the planned start
    expect(w.stationings.find((s) => s.id === 'tmp-o-hr-rec')!.state).toBe('CANCELLED_BEFORE_START'); // kept, never started
    expect(effectiveOf(w, 'o-hr-rec')!.kind).toBe('PERMANENT');
  });

  // owner correction of 3 Nov 2026: a start cancellation still pending at the planned start holds the start
  const startCancel = (w: World) => {
    const v = perform(w, 'p-req', { t: 'REQUEST_START_CANCEL', req: 'r-hr-rec', reason: 'تأجل المشروع' });
    return { w: v, sc: v.startCancellations.at(-1)!.id };
  };
  const req = (w: World) => w.requests.find((r) => r.id === 'r-hr-rec')!;
  const tmp = (w: World) => w.stationings.find((s) => s.id === 'tmp-o-hr-rec')!;
  const started = (w: World) => w.events.filter((e) => e.type === 'STATIONING_TEMPORARY_STARTED' && e.ref === 'MV-2026-0407');

  it('start held: a pending start cancellation at the planned start keeps the temporary from becoming effective, tick after tick', () => {
    let w = perform(baseWorld(), 'p-req', { t: 'REQUEST_EXTENSION', req: 'r-hr-rec', newEnd: NOW + 95 * DAY });
    const ext = w.extensions.at(-1)!.id;
    w = perform(w, 'p-apr', { t: 'APPROVE_EXTENSION', ext });
    ({ w } = startCancel(w));
    expect(why(w, 'p-act', { t: 'ACTIVATE_EXTENSION', ext })).toContain('طلب إلغاء قبل بدء النفاذ');
    w = perform(w, 'system', { t: 'TICK', to: NOW + 5 * DAY });
    expect(req(w).state).toBe('START_HELD_PENDING_CANCELLATION');
    expect(tmp(w).state).toBe('SCHEDULED');
    expect(w.startCancellations.at(-1)!.heldAt).toBe(NOW + 5 * DAY);
    expect(w.events.find((e) => e.type === 'STATIONING_START_HELD')).toMatchObject({ actor: 'system', ref: 'MV-2026-0407', at: NOW + 5 * DAY });
    for (const d of [6, 20, 64]) {
      w = perform(w, 'system', { t: 'TICK', to: NOW + d * DAY });
      expect(req(w).state).toBe('START_HELD_PENDING_CANCELLATION');
      expect(effectiveOf(w, 'o-hr-rec')!.kind).toBe('PERMANENT');
    }
    expect(started(w)).toHaveLength(0);
    expect(why(w, 'p-req', { t: 'REQUEST_EARLY_RETURN', req: 'r-hr-rec', reason: 'x' })).toContain('البدء موقوف');
    expect(why(w, 'p-act', { t: 'ACTIVATE_EXTENSION', ext })).toContain('البدء موقوف');
  });

  it('start held, cancellation approved: CANCELLED_BEFORE_START, never effective, the hold recorded', () => {
    let { w, sc } = startCancel(baseWorld());
    w = perform(w, 'system', { t: 'TICK', to: NOW + 6 * DAY });
    w = perform(w, 'p-dec', { t: 'DECIDE_START_CANCEL', sc, approve: true, reason: 'تأكد التأجيل' });
    expect(req(w).state).toBe('TEMPORARY_CANCELLED_BEFORE_START');
    expect(tmp(w).state).toBe('CANCELLED_BEFORE_START');
    expect(w.events.find((e) => e.type === 'TEMPORARY_CANCELLED_BEFORE_START')!.data).toMatchObject({ decisionMaker: 'p-dec', decisionReason: 'تأكد التأجيل' });
    expect(w.events.find((e) => e.type === 'TEMPORARY_CANCELLED_BEFORE_START')!.data!.heldSince).toBeTruthy();
    w = perform(w, 'system', { t: 'TICK', to: NOW + 30 * DAY });
    expect(tmp(w).state).toBe('CANCELLED_BEFORE_START');
    expect(effectiveOf(w, 'o-hr-rec')!.kind).toBe('PERMANENT');
    expect(started(w)).toHaveLength(0);
  });

  it('cancellation rejected before the planned start: back to waiting, it starts at the original approved start', () => {
    let { w, sc } = startCancel(baseWorld());
    w = perform(w, 'p-dec', { t: 'DECIDE_START_CANCEL', sc, approve: false, reason: 'الحاجة قائمة' });
    expect(req(w).state).toBe('TEMPORARY_SCHEDULED');
    w = perform(w, 'system', { t: 'TICK', to: NOW + 5 * DAY });
    expect(req(w).state).toBe('ACTIVE_TEMPORARY');
    expect(tmp(w)).toMatchObject({ state: 'ACTIVE', from: NOW + 5 * DAY, plannedStart: NOW + 5 * DAY });
    expect(tmp(w).startRef).toBeUndefined();
    expect(w.events.some((e) => e.type === 'STATIONING_START_HELD')).toBe(false);
  });

  it('cancellation rejected after the planned start: effective from the decision time only, end unchanged, all times recorded', () => {
    let { w, sc } = startCancel(baseWorld());
    const decided = NOW + 7 * DAY + 3 * 3_600_000;
    w = perform(w, 'system', { t: 'TICK', to: decided });
    w = perform(w, 'p-dec', { t: 'DECIDE_START_CANCEL', sc, approve: false, reason: 'زال سبب التأجيل' });
    expect(req(w).state).toBe('ACTIVE_TEMPORARY');
    expect(tmp(w)).toMatchObject({ state: 'ACTIVE', from: decided, plannedStart: NOW + 5 * DAY, plannedEnd: NOW + 65 * DAY, startRef: sc }); // not backdated
    expect(w.startCancellations.find((x) => x.id === sc)).toMatchObject({ state: 'REJECTED', heldAt: NOW + 5 * DAY, effectiveStart: decided, decidedAt: decided, decision: 'زال سبب التأجيل' });
    const ev = started(w).at(-1)!;
    expect(ev.actor).toBe('p-dec');
    expect(Object.keys(ev.data!)).toEqual(expect.arrayContaining(['plannedStart', 'actualEffectiveStart', 'decidedAt', 'decisionReason', 'effectiveEnd']));
    expect(ev.data!.plannedStart).not.toBe(ev.data!.actualEffectiveStart);
    expect(effectiveOf(w, 'o-hr-rec')!.kind).toBe('TEMPORARY');
    w = perform(w, 'system', { t: 'TICK', to: NOW + 66 * DAY });
    expect(tmp(w)).toMatchObject({ state: 'ENDED', actualEnd: NOW + 65 * DAY, endReason: 'EXPIRED' });
  });

  it('cancellation rejected after the planned start, with an activated extension: effective to the extended end', () => {
    let w = perform(baseWorld(), 'p-req', { t: 'REQUEST_EXTENSION', req: 'r-hr-rec', newEnd: NOW + 95 * DAY });
    const ext = w.extensions.at(-1)!.id;
    w = perform(w, 'p-apr', { t: 'APPROVE_EXTENSION', ext });
    w = perform(w, 'p-act', { t: 'ACTIVATE_EXTENSION', ext });
    let sc: string;
    ({ w, sc } = startCancel(w));
    w = perform(w, 'system', { t: 'TICK', to: NOW + 8 * DAY });
    expect(req(w).state).toBe('START_HELD_PENDING_CANCELLATION');
    w = perform(w, 'p-dec', { t: 'DECIDE_START_CANCEL', sc, approve: false, reason: 'زال سبب التأجيل' });
    expect(tmp(w).from).toBe(NOW + 8 * DAY);
    w = perform(w, 'system', { t: 'TICK', to: NOW + 66 * DAY });
    const eff = effectiveOf(w, 'o-hr-rec')!;
    expect(eff.kind).toBe('TEMPORARY');
    expect(eff.plannedEnd).toBe(NOW + 95 * DAY);
  });

  it('planned end passes while the cancellation is pending: WINDOW_EXPIRED_WITHOUT_START, the cancellation no longer actionable, both kept', () => {
    let w = perform(baseWorld(), 'p-req', { t: 'REQUEST_EXTENSION', req: 'r-hr-rec', newEnd: NOW + 95 * DAY });
    const ext = w.extensions.at(-1)!.id;
    w = perform(w, 'p-apr', { t: 'APPROVE_EXTENSION', ext });
    let sc: string;
    ({ w, sc } = startCancel(w));
    const n = w.stationings.length;
    w = perform(w, 'system', { t: 'TICK', to: NOW + 66 * DAY }); // one jump over the start and the end
    expect(tmp(w)).toMatchObject({ state: 'WINDOW_EXPIRED_WITHOUT_START', to: NOW + 65 * DAY });
    expect(req(w).state).toBe('TEMPORARY_WINDOW_EXPIRED_WITHOUT_START');
    expect(w.startCancellations.find((x) => x.id === sc)).toMatchObject({ state: 'NO_LONGER_ACTIONABLE', closedAt: NOW + 65 * DAY, closeReason: 'انقضت نافذة النفاذ دون بدء', reason: 'تأجل المشروع' });
    expect(why(w, 'p-dec', { t: 'DECIDE_START_CANCEL', sc, approve: true, reason: 'x' })).toContain('لم يعد الطلب قابلاً للقرار');
    expect(w.extensions.find((e) => e.id === ext)!.state).toBe('LAPSED_NOT_ACTIVATED');
    const types = w.events.filter((e) => e.ref === 'MV-2026-0407').map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['STATIONING_START_HELD', 'STATIONING_TEMPORARY_WINDOW_EXPIRED_WITHOUT_START', 'TEMPORARY_START_CANCELLATION_NO_LONGER_ACTIONABLE']));
    expect(started(w)).toHaveLength(0);
    expect(w.stationings.length).toBe(n); // nothing deleted
    expect(effectiveOf(w, 'o-hr-rec')!.kind).toBe('PERMANENT');
  });

  it('scenarios 23–25 open in the held, held-until-the-end and pending-before-start states', () => {
    const open = (n: number) => (SCENARIOS.find((s) => s.n === n)!.setup ?? []).reduce((w, [who, a]) => perform(w, who, a), baseWorld());
    expect(req(open(23)).state).toBe('START_HELD_PENDING_CANCELLATION');
    const w24 = open(24);
    expect(req(w24).state).toBe('START_HELD_PENDING_CANCELLATION');
    expect(req(perform(w24, 'system', { t: 'TICK', to: w24.now + 7 * DAY })).state).toBe('TEMPORARY_WINDOW_EXPIRED_WITHOUT_START');
    const w25 = open(25);
    expect(req(w25).state).toBe('TEMPORARY_SCHEDULED');
    expect(w25.startCancellations.at(-1)!.state).toBe('REQUESTED');
  });

  it('A2: an associated area does not block a unit in its explicit covered scope; it does block one outside it', () => {
    let w = baseWorld();
    w = perform(w, 'p-req', { t: 'CONFIRM_RESERVATION', res: 'rs-covered' });
    expect(w.reservations.find((r) => r.id === 'rs-covered')!.state).toBe('ACTIVE');
    w = perform(w, 'p-req', { t: 'CONFIRM_RESERVATION', res: 'rs-uncovered' }); // a grandchild, not listed in the scope
    expect(w.reservations.find((r) => r.id === 'rs-uncovered')!.state).toBe('BLOCKED');
  });

  it('D4/A2: a conflicting reservation is blocked by default; an exception needs a policy reference and an independent approver; the exemption never bypasses a third party', () => {
    let w = perform(baseWorld(), 'p-other', { t: 'CONFIRM_RESERVATION', res: 'rs-outside' });
    expect(w.reservations.find((r) => r.id === 'rs-outside')!.state).toBe('BLOCKED');
    expect(why(w, 'p-other', { t: 'REQUEST_EXCEPTION', res: 'rs-outside', reason: 'تدريب مشترك', policyRef: '' })).toContain('مرجع السياسة');
    w = perform(w, 'p-other', { t: 'REQUEST_EXCEPTION', res: 'rs-outside', reason: 'تدريب مشترك مع الجهة المالكة', policyRef: 'سياسة وهمية م-12' });
    expect(why(w, 'p-req', { t: 'DECIDE_EXCEPTION', res: 'rs-outside', approve: true, reason: 'x' })).toContain('APPROVE_AVAILABILITY_EXCEPTION');
    w = perform(w, 'p-avl', { t: 'DECIDE_EXCEPTION', res: 'rs-outside', approve: true, reason: 'مشاركة محددة المدة' });
    expect(w.reservations.find((r) => r.id === 'rs-outside')!.state).toBe('ACTIVE');
    expect(w.events.at(-1)).toMatchObject({ type: 'AREA_EXCEPTION_APPROVED', data: { policyRef: 'سياسة وهمية م-12', decidedBy: 'p-avl', requestedBy: 'p-other' } });
    // a covered unit's reservation over the now-active third-party reservation is still blocked
    const covered = w.reservations.find((r) => r.id === 'rs-covered')!;
    covered.ring = w.reservations.find((r) => r.id === 'rs-outside')!.ring;
    w = perform(w, 'p-req', { t: 'CONFIRM_RESERVATION', res: 'rs-covered' });
    expect(w.reservations.find((r) => r.id === 'rs-covered')!.state).toBe('BLOCKED');
  });

  it('D13: a temporary stationing not shown at approval blocks the permanent activation', () => {
    const w = baseWorld();
    w.requests.find((r) => r.id === 'r-it-perm')!.supersedes = [];
    expect(why(w, 'p-act', { t: 'ACTIVATE', req: 'r-it-perm' })).toContain('تمركز مؤقت');
  });

  it('D10: an approved extension changes nothing until an independent activation; its approver cannot activate it', () => {
    let w = baseWorld();
    expect(why(w, 'p-apr', { t: 'ACTIVATE_EXTENSION', ext: 'ext-it' })).toContain('اعتمد التمديد');
    w = perform(w, 'p-act', { t: 'ACTIVATE_EXTENSION', ext: 'ext-it' });
    expect(temporaryOf(w, 'o-it')!.plannedEnd).toBe(NOW + 12 * DAY); // approved dates unchanged
    w = perform(w, 'system', { t: 'TICK', to: NOW + 13 * DAY });
    const eff = effectiveOf(w, 'o-it')!;
    expect(eff.kind).toBe('TEMPORARY');
    expect(eff.plannedEnd).toBe(NOW + 42 * DAY);
    expect(w.stationings.find((s) => s.id === 'tmp-o-it')!.endReason).toBe('SUPERSEDED_BY_EXTENSION');
  });

  it('D7/D11: expiry is a system transition back to the preserved permanent stationing; a failed reminder changes nothing', () => {
    const w = perform(baseWorld(), 'system', { t: 'TICK', to: NOW + 30 * DAY });
    const reminders = w.events.filter((e) => e.type === 'STATIONING_EXPIRY_REMINDER_SENT' && e.ref === 'MV-2026-0412');
    expect(reminders.length).toBeGreaterThan(0);
    expect(reminders.some((e) => e.detail.includes('تعذّر التسليم'))).toBe(true);
    expect(w.requests.find((r) => r.id === 'r-ss-mt')!.state).toBe('TEMPORARY_ENDED');
    expect(effectiveOf(w, 'o-ss-mt-n')!.id).toBe('st-o-ss-mt-n');
    expect(w.stationings.find((s) => s.id === 'tmp-o-ss-mt-n')!.endReason).toBe('EXPIRED');
  });

  it('D7: a temporary stationing activated before its start becomes effective only at the start', () => {
    let w = baseWorld();
    expect(effectiveOf(w, 'o-hr-rec')!.kind).toBe('PERMANENT');
    w = perform(w, 'system', { t: 'TICK', to: NOW + 5 * DAY });
    expect(effectiveOf(w, 'o-hr-rec')!.kind).toBe('TEMPORARY');
    expect(w.requests.find((r) => r.id === 'r-hr-rec')!.state).toBe('ACTIVE_TEMPORARY');
  });

  it('D12: the early-return requester (any linked account) cannot decide it; an independent decision records both ends', () => {
    const w0 = baseWorld();
    expect(why(w0, 'p-req-dir', { t: 'DECIDE_EARLY_RETURN', er: 'er-ga-adm', approve: true, reason: 'x' })).toContain('طالب العودة');
    expect(why(w0, 'p-act', { t: 'DECIDE_EARLY_RETURN', er: 'er-ga-adm', approve: true, reason: 'x' })).toContain('DECIDE_EARLY_RETURN');
    const w = perform(w0, 'p-dec', { t: 'DECIDE_EARLY_RETURN', er: 'er-ga-adm', approve: true, reason: 'مقبول' });
    const er = w.earlyReturns[0];
    expect(er.originalEnd).toBe(NOW + 50 * DAY);
    expect(er.actualEnd).toBe(NOW);
    expect(effectiveOf(w, 'o-ga-adm')!.kind).toBe('PERMANENT');
  });

  it('D18: a resubmission invalidates only the decisions whose facts changed', () => {
    const st = deriveRoute(baseWorld(), 'o-ss-gen', 'PERMANENT').map((s) => ({ ...s, mark: 'APPROVED' as const }));
    expect(st.map((s) => s.key)).toEqual(['h-o-ss', 'site', 'scope', 'final']);
    expect(impact(st, ['SITE'])).toMatchObject({ restart: 0, invalidated: ['h-o-ss', 'site', 'final'], carried: ['scope'] });
    expect(impact(st, ['DURATION'])).toMatchObject({ restart: 0, invalidated: ['h-o-ss', 'site', 'scope', 'final'], carried: [] });
    // returned at the final decision, resubmitted with a new site: review resumes at the hierarchy, the scope review is carried
    let w = perform(baseWorld(), 'p-apr', { t: 'RETURN', req: 'r-ss-gen', reason: 'يلزم موقع آخر' });
    w = structuredClone(w);
    const r = w.requests.find((x) => x.id === 'r-ss-gen')!;
    r.proposal.ring = r.proposal.ring.map((p) => ({ lat: p.lat + 0.01, lng: p.lng }));
    expect(changedFacts(r)).toEqual(['SITE']);
    w = perform(w, 'p-req', { t: 'RESUBMIT', req: 'r-ss-gen', changed: changedFacts(r), reason: 'موقع جديد بلا تعارض' });
    const r2 = w.requests.find((x) => x.id === 'r-ss-gen')!;
    expect(r2.cursor).toBe(0);
    expect(r2.stages.map((s) => s.mark)).toEqual(['INVALIDATED', 'INVALIDATED', 'CARRIED', undefined]); // the final decision had not been taken
  });

  it('invariants 1–3: activation never touches facility responsibility, and never deletes history', () => {
    const w0 = baseWorld();
    const w = perform(w0, 'p-act', { t: 'ACTIVATE', req: 'r-ga-fin' });
    expect(w.sites).toEqual(w0.sites); // no facility record changed
    expect(w.stationings.find((s) => s.id === 'st-o-ga-fin')!.state).toBe('ENDED');
    expect(permanentOf(w, 'o-ga-fin')!.siteId).toBe('c-ga-fin');
  });
});

// owner correction of 3 Nov 2026
describe('one proposed site, the hierarchical route, the policies and the deployment package', () => {
  const setRequired = (w: World, at = NOW) => perform(w, 'p-sys', { t: 'SET_POLICY', key: 'stationing_areas_requirement', value: 'REQUIRED', effectiveFrom: at, reason: 'منطقتا الانتشار شرط للإرسال' });
  const req = (w: World, id: string) => w.requests.find((r) => r.id === id)!;
  const approveAll = (w0: World, id: string, deciders: string[]) => deciders.reduce((w, who) => perform(w, who, { t: 'APPROVE_STAGE', req: id }), w0);
  /** Takes MV-2026-0402 (temporary, a complete package) to final approval and registers its proposed site. */
  const approve0402 = (w0: World) => {
    let w = approveAll(perform(w0, 'p-req', { t: 'SUBMIT', req: 'r-hr-trn' }), 'r-hr-trn', ['p-rev', 'p-apr']);
    w = structuredClone(w);
    const p = req(w, 'r-hr-trn').proposal;
    w.sites.push({ id: 'c-hr-trn', name: p.name, ring: p.ring, lat: 0, lng: 0, registered: true });
    p.siteId = 'c-hr-trn';
    return w;
  };

  it('a request carries exactly one proposed site; nothing in the model offers a second one', () => {
    for (const r of baseWorld().requests) {
      expect(r.proposal.ring.length).toBeGreaterThanOrEqual(3);
      expect(Object.keys(r)).not.toContain('candidates');
      expect(Object.keys(r)).not.toContain('active');
    }
  });

  it('the route is derived from the hierarchy and the request type — never a fixed number of levels', () => {
    const w = baseWorld();
    const keys = (org: string, t: 'PERMANENT' | 'TEMPORARY') => deriveRoute(w, org, t).map((s) => s.key);
    expect(keys('o-pm-bld-sv-n', 'PERMANENT')).toEqual(['h-o-pm-bld-sv', 'h-o-pm-bld', 'h-o-pm', 'site', 'scope', 'final']);
    expect(keys('o-pm-bld', 'PERMANENT')).toEqual(['h-o-pm', 'site', 'scope', 'final']);
    expect(keys('o-ga', 'PERMANENT')).toEqual(['site', 'scope', 'final']);
    expect(keys('o-ss-mt-s', 'TEMPORARY')).toEqual(['h-o-ss-mt', 'site', 'final']);
    expect(deriveRoute(w, 'o-pm-bld-sv-n', 'PERMANENT').at(-1)!.org).toBe('o-root');
    expect(deriveRoute(w, 'o-ss-mt-s', 'TEMPORARY').at(-1)!.org).toBe('o-ss');
  });

  it('each hierarchy stage is decided only by its organisation\'s assigned approver, in order; the requester never decides', () => {
    let w = perform(baseWorld(), 'p-req-sv', { t: 'SUBMIT', req: 'r-pm-sv-n' });
    const a = { t: 'APPROVE_STAGE', req: 'r-pm-sv-n' } as const;
    expect(why(w, 'p-h-bld', a)).toContain('المعتمد المُسند');
    expect(why(w, 'p-apr', a)).toContain('المعتمد المُسند');
    expect(why(w, 'p-req-sv', a)).toBeTruthy();
    w = approveAll(w, 'r-pm-sv-n', ['p-h-sv', 'p-h-bld', 'p-h-pm']);
    expect(req(w, 'r-pm-sv-n').stages[req(w, 'r-pm-sv-n').cursor].key).toBe('site');
    expect(why(w, 'p-apr', a)).toContain('مرحلة');
    w = approveAll(w, 'r-pm-sv-n', ['p-rev', 'p-rev', 'p-apr']);
    expect(req(w, 'r-pm-sv-n').state).toBe('APPROVED_NOT_ACTIVATED');
    expect(req(w, 'r-pm-sv-n').stages.map((s) => s.by)).toEqual(['p-h-sv', 'p-h-bld', 'p-h-pm', 'p-rev', 'p-rev', 'p-apr']);
  });

  it('participants come from the hierarchy, the scope and the route; only MANAGE_REQUEST_ROUTING changes them, audited', () => {
    let w = perform(baseWorld(), 'p-req', { t: 'SUBMIT', req: 'r-pm-bld' });
    const ps = participants(w, req(w, 'r-pm-bld'));
    expect(ps.filter((p) => p.role === 'APPROVER').map((p) => p.org)).toEqual(['o-pm']);
    expect(ps.find((p) => p.role === 'FINAL')!.org).toBe('o-root');
    expect(ps.filter((p) => p.role === 'AFFECTED').map((p) => p.org)).toEqual(['o-pm-bld-sv', 'o-pm-bld-sv-n']);
    const add = { t: 'ROUTE_CHANGE', req: 'r-pm-bld', op: 'ADD_APPROVER', org: 'o-ga', reason: 'موافقة الإدارة العامة على المبنى المشترك' } as const;
    expect(why(w, 'p-req', add)).toContain('MANAGE_REQUEST_ROUTING');
    expect(why(w, 'p-wf', { ...add, reason: '' })).toContain('سبب');
    expect(why(w, 'p-wf', { ...add, op: 'REMOVE_RECIPIENT', org: 'o-pm' })).toContain('مستلم إشعار فقط');
    w = perform(w, 'p-wf', add);
    expect(req(w, 'r-pm-bld').stages.map((s) => s.key)).toEqual(['h-o-pm', 'site', 'scope', 'a-o-ga', 'final']);
    expect(w.events.at(-1)).toMatchObject({ type: 'REQUEST_ROUTING_CHANGED', actor: 'p-wf' });
    w = perform(w, 'p-wf', { t: 'ROUTE_CHANGE', req: 'r-pm-bld', op: 'REMOVE_RECIPIENT', org: 'o-pm-bld-sv-n', reason: 'الفريق لا يتأثر بالنقل' });
    expect(participants(w, req(w, 'r-pm-bld')).some((p) => p.org === 'o-pm-bld-sv-n')).toBe(false);
  });

  it('policies: only the system administrator, a reason, no backdating, a real change; every fact recorded; append-only', () => {
    const w0 = baseWorld();
    const a = { t: 'SET_POLICY', key: 'stationing_areas_requirement', value: 'REQUIRED', effectiveFrom: NOW, reason: 'منطقتا الانتشار شرط للإرسال' } as const;
    expect(why(w0, 'p-stn', a)).toContain('MANAGE_STATIONING_POLICY');
    expect(why(w0, 'p-sys', { ...a, reason: '' })).toContain('سبب التغيير');
    expect(why(w0, 'p-sys', { ...a, effectiveFrom: NOW - DAY })).toContain('أثر رجعي');
    expect(why(w0, 'p-sys', { ...a, value: 'OPTIONAL' })).toContain('القيمة نفسها');
    expect(why(w0, 'p-sys', { ...a, key: 'max_restationing_footprint_area', value: -5 })).toContain('موجبة');
    const w = perform(w0, 'p-sys', a);
    expect(w.policies.at(-1)).toMatchObject({ key: a.key, version: 2, value: 'REQUIRED', previous: 'OPTIONAL', effectiveFrom: NOW, changedBy: 'p-sys', changedAt: NOW, reason: a.reason });
    expect(w.policies.slice(0, 2)).toEqual(w0.policies);
    expect(w.events.at(-1)!.data).toMatchObject({ policy: a.key, version: '2', previous: 'OPTIONAL', value: 'REQUIRED', changedBy: 'p-sys', reason: a.reason });
    // a future version applies only from its time
    let f = setRequired(baseWorld(), NOW + 3 * DAY);
    expect(policyAt(f, 'stationing_areas_requirement').value).toBe('OPTIONAL');
    f = perform(f, 'system', { t: 'TICK', to: NOW + 3 * DAY });
    expect(policyAt(f, 'stationing_areas_requirement').version).toBe(2);
    expect(f.events.some((x) => x.type === 'STATIONING_POLICY_EFFECTIVE')).toBe(true);
  });

  it('REQUIRED: site + primary + alternative deployment area; OPTIONAL: none, or both — never one alone', () => {
    const base = baseWorld();
    expect(ok(base, 'p-req', { t: 'SUBMIT', req: 'r-pm-bld' })).toBe(true); // optional, site only
    expect(ok(base, 'p-req', { t: 'SUBMIT', req: 'r-hr-trn' })).toBe(true); // optional, complete package
    const reqd = setRequired(baseWorld());
    expect(why(reqd, 'p-req', { t: 'SUBMIT', req: 'r-pm-bld' })).toMatch(/إلزامية.*الإصدار 2/);
    expect(ok(reqd, 'p-req', { t: 'SUBMIT', req: 'r-hr-trn' })).toBe(true);
    for (const missing of ['ALTERNATIVE_AREA', 'PRIMARY_AREA'] as const) {
      const w = structuredClone(base);
      delete req(w, 'r-hr-trn').proposal.areas![missing];
      expect(why(w, 'p-req', { t: 'SUBMIT', req: 'r-hr-trn' })).toContain('حزمة واحدة');
    }
  });

  it('distances use the shortest distance between the actual geometries (0 when they touch); centre to centre is information', () => {
    const w = baseWorld();
    const c = proposalAreas(w, req(w, 'r-hr-trn'));
    expect(c.present).toBe('COMPLETE');
    expect(c.siteToPrimary!.measure).toBe('NEAREST_GEOMETRY');
    expect(c.siteToPrimary!.dist).toBeLessThan(c.siteToPrimary!.centre - 300);
    expect(c.siteToPrimary!.ok && c.primaryToAlternative!.ok).toBe(true);
    expect(c.problems).toEqual([]);
    const ring = req(w, 'r-hr-trn').proposal.areas!.PRIMARY_AREA!;
    expect(nearest(ring, ring.map((p) => ({ lat: p.lat + 0.0005, lng: p.lng }))).dist).toBe(0); // overlap
    const touch = [ring[0], { lat: ring[0].lat + 0.01, lng: ring[0].lng }, { lat: ring[0].lat, lng: ring[0].lng - 0.01 }];
    expect(nearest(ring, touch).dist).toBeLessThan(0.01); // a shared vertex
    expect(nearest(centroid(ring), ring).dist).toBe(0); // a point inside
  });

  it('a request pinned to a centre-to-centre profile keeps that method; drafts use the published shortest-distance profile', () => {
    const w = structuredClone(baseWorld());
    const r = req(w, 'r-ga'); // submitted under profile version 1
    r.proposal.areas = structuredClone(req(w, 'r-hr-trn').proposal.areas);
    expect(proposalAreas(w, r).siteToPrimary!.measure).toBe('CENTROID');
    expect(proposalAreas(w, req(w, 'r-hr-trn')).siteToPrimary!.measure).toBe('NEAREST_GEOMETRY');
  });

  it('the proposed footprint above the administrator\'s maximum blocks submission, with the area, the limit and the version; never resized', () => {
    let w = perform(baseWorld(), 'p-sys', { t: 'SET_POLICY', key: 'max_restationing_footprint_area', value: 15000, effectiveFrom: NOW, reason: 'حد مساحة أصغر' });
    const before = structuredClone(req(w, 'r-pm-bld').proposal.ring);
    const fp = footprintCheck(w, req(w, 'r-pm-bld'));
    expect(fp.ok).toBe(false);
    expect(fp.area).toBeGreaterThan(15000);
    expect(why(w, 'p-req', { t: 'SUBMIT', req: 'r-pm-bld' })).toMatch(/تتجاوز الحد المهيأ .*الإصدار 2/);
    expect(req(w, 'r-pm-bld').proposal.ring).toEqual(before);
    w = structuredClone(w);
    req(w, 'r-pm-bld').proposal.ring = shape(25.13, 55.2605, 120, 100);
    expect(ok(w, 'p-req', { t: 'SUBMIT', req: 'r-pm-bld' })).toBe(true);
  });

  it('the proposed site has no distance rule from the current stationing', () => {
    const w = structuredClone(setRequired(baseWorld()));
    const r = req(w, 'r-hr-trn');
    const cur = w.sites.find((s) => s.id === 'site-C-06')!.ring;
    const shift = (ring: typeof cur, dLat: number, dLng: number) => ring.map((p) => ({ lat: p.lat + dLat, lng: p.lng + dLng }));
    const [c0, c1] = [centroid(r.proposal.ring), centroid(cur)];
    const [dLat, dLng] = [c1.lat + 0.0027 - c0.lat, c1.lng - c0.lng]; // about 300 m from the current site
    r.proposal = { ...r.proposal, ring: shift(r.proposal.ring, dLat, dLng), areas: { PRIMARY_AREA: shift(r.proposal.areas!.PRIMARY_AREA!, dLat, dLng), ALTERNATIVE_AREA: shift(r.proposal.areas!.ALTERNATIVE_AREA!, dLat, dLng) } };
    expect(why(w, 'p-req', { t: 'SUBMIT', req: 'r-hr-trn' })).toBe('');
  });

  it('the policy versions are pinned at the first submission: a later version never changes an already-submitted request', () => {
    let w = perform(setRequired(baseWorld()), 'p-req', { t: 'SUBMIT', req: 'r-hr-trn' });
    expect(req(w, 'r-hr-trn').policy).toMatchObject({ areas: { version: 2, value: 'REQUIRED' }, maxArea: { version: 1 }, profile: 2, pinnedAt: NOW });
    w = perform(w, 'p-sys', { t: 'SET_POLICY', key: 'stationing_areas_requirement', value: 'OPTIONAL', effectiveFrom: NOW, reason: 'تخفيف الشرط' });
    expect(requirementOf(w, req(w, 'r-hr-trn')).areas).toMatchObject({ version: 2, value: 'REQUIRED' });
    w = perform(w, 'p-rev', { t: 'RETURN', req: 'r-hr-trn', reason: 'تعديل' });
    w = structuredClone(w);
    req(w, 'r-hr-trn').proposal.areas = undefined;
    expect(why(w, 'p-req', { t: 'RESUBMIT', req: 'r-hr-trn', changed: ['SITE'], reason: 'حذف المنطقتين' })).toContain('الإصدار 2');
    expect(requirementOf(w, req(w, 'r-pm-bld')).areas).toMatchObject({ version: 3, value: 'OPTIONAL' });
  });

  it('permanent activation: the new site becomes current, the previous one stays in history, no automatic return; moving again needs a new request', () => {
    let w = perform(baseWorld(), 'p-act', { t: 'ACTIVATE', req: 'r-ga-fin' });
    expect(permanentOf(w, 'o-ga-fin')!.siteId).toBe('c-ga-fin');
    expect(w.stationings.find((s) => s.id === 'st-o-ga-fin')).toMatchObject({ state: 'ENDED', endReason: 'REPLACED_BY_ACTIVATION' });
    w = perform(w, 'system', { t: 'TICK', to: NOW + 400 * DAY });
    expect(permanentOf(w, 'o-ga-fin')!.siteId).toBe('c-ga-fin');
    for (const t of ['SUBMIT', 'ACTIVATE', 'REQUEST_CANCEL'] as const) expect(ok(w, 'p-req', { t, req: 'r-ga-fin' } as Parameters<typeof check>[2])).toBe(false);
    expect(req(w, 'r-ga-fin').state).toBe('ACTIVATED_PERMANENT');
  });

  it('activation without deployment areas creates no empty record; they come later by an authorised registration', () => {
    const w0 = perform(baseWorld(), 'p-act', { t: 'ACTIVATE', req: 'r-ga-fin' });
    const st = permanentOf(w0, 'o-ga-fin')!;
    expect(w0.areas.filter((a) => a.stationingId === st.id)).toEqual([]);
    expect(w0.events.some((e) => e.type === 'STATIONING_WITHOUT_AREAS' && e.ref === 'MV-2026-0406')).toBe(true);
    const a = { t: 'REGISTER_AREAS', stationing: st.id, primary: areaShape(25.205, 55.41, true), alternative: areaShape(25.245, 55.42, false), authority: 'جهة اعتماد وهمية', reference: 'ق-وهمي/204', reason: 'قرار منطقتي الانتشار بعد نفاذ التمركز' } as const;
    expect(why(w0, 'p-req', a)).toContain('MANAGE_STATIONING');
    expect(why(w0, 'p-stn', { ...a, alternative: [] })).toContain('حزمة واحدة');
    expect(why(w0, 'p-stn', { ...a, alternative: areaShape(25.205, 55.43, false) })).toContain('منطقة الانتشار البديلة على بعد');
    const w = perform(w0, 'p-stn', a);
    const areas = w.areas.filter((x) => x.stationingId === st.id);
    expect(areas.map((x) => x.role).sort()).toEqual(['ALTERNATIVE_AREA', 'PRIMARY_AREA']);
    expect(areas.every((x) => x.status === 'ACTIVE' && x.provenance.kind === 'EXTERNAL_DECISION' && x.provenance.registeredBy === 'p-stn')).toBe(true);
    expect(why(w, 'p-stn', a)).toContain('نشطتان');
  });

  it('a temporary stationing\'s own deployment areas end with it and never become the original stationing\'s', () => {
    let w = perform(approve0402(setRequired(baseWorld())), 'p-act', { t: 'ACTIVATE', req: 'r-hr-trn' });
    const t = w.stationings.find((s) => s.requestId === 'r-hr-trn' && s.org === 'o-hr-trn')!;
    const areas = w.areas.filter((a) => a.stationingId === t.id);
    expect(areas.length).toBe(2);
    expect(areas.every((a) => a.validFrom === NOW + 10 * DAY && a.validTo === NOW + 100 * DAY && a.provenance.kind === 'IN_APP_REQUEST')).toBe(true);
    w = perform(w, 'system', { t: 'TICK', to: NOW + 101 * DAY });
    expect(effectiveOf(w, 'o-hr-trn')!.id).toBe('st-o-hr-trn'); // back to the preserved original
    expect(w.areas.filter((a) => a.stationingId === t.id).every((a) => a.status === 'RETIRED')).toBe(true);
    expect(w.areas.some((a) => a.stationingId === 'st-o-hr-trn')).toBe(false);
    // the fixture temporary of MV-2026-0408 too: its package retires at expiry, the original's stays
    const e = perform(baseWorld(), 'system', { t: 'TICK', to: NOW + 13 * DAY });
    expect(e.areas.filter((a) => a.stationingId === 'tmp-o-it').every((a) => a.status === 'RETIRED')).toBe(true);
    expect(e.areas.filter((a) => a.stationingId === 'st-o-it').every((a) => a.status === 'ACTIVE')).toBe(true);
  });

  it('an activated extension carries the temporary stationing and its deployment areas to the new end', () => {
    let w = perform(baseWorld(), 'p-act', { t: 'ACTIVATE_EXTENSION', ext: 'ext-it' });
    expect(w.areas.filter((a) => a.stationingId === 'tmp-o-it').every((a) => a.validTo === NOW + 42 * DAY)).toBe(true);
    w = perform(w, 'system', { t: 'TICK', to: NOW + 13 * DAY });
    expect(temporaryOf(w, 'o-it')!.extendsId).toBe('tmp-o-it');
    expect(w.areas.filter((a) => a.stationingId === 'tmp-o-it').every((a) => a.status === 'ACTIVE')).toBe(true);
    w = perform(w, 'system', { t: 'TICK', to: NOW + 43 * DAY });
    expect(effectiveOf(w, 'o-it')!.kind).toBe('PERMANENT');
    expect(w.areas.filter((a) => a.stationingId === 'tmp-o-it').every((a) => a.status === 'RETIRED')).toBe(true);
  });

  it('a temporary stationing cancelled before its start retires its deployment areas: they never became effective', () => {
    let w = perform(approve0402(setRequired(baseWorld())), 'p-act', { t: 'ACTIVATE', req: 'r-hr-trn' });
    w = perform(w, 'p-req', { t: 'REQUEST_START_CANCEL', req: 'r-hr-trn', reason: 'تأجل التدريب' });
    w = perform(w, 'p-dec', { t: 'DECIDE_START_CANCEL', sc: w.startCancellations.at(-1)!.id, approve: true, reason: 'مقبول' });
    const t = w.stationings.find((s) => s.requestId === 'r-hr-trn' && s.org === 'o-hr-trn')!;
    expect(t.state).toBe('CANCELLED_BEFORE_START');
    expect(w.areas.filter((a) => a.stationingId === t.id).every((a) => a.status === 'RETIRED')).toBe(true);
  });

  it('every scenario 26–41 loads through guarded actions', () => {
    for (const sc of SCENARIOS.filter((s) => s.n >= 26)) {
      let w = baseWorld();
      for (const [who, a] of sc.setup ?? []) w = perform(w, who, a);
      sc.draft?.(w);
      expect(w).toBeTruthy();
    }
  });
});
