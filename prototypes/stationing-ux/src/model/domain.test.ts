import { describe, expect, it } from 'vitest';
import { DAY, check, effectiveOf, impact, perform, permanentOf, temporaryOf, type World } from './domain';
import { NOW, baseWorld, stagesTemplate } from './fixtures';
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

  it('A3: a temporary stationing, even of the whole organisation, keeps the permanent stationing and its associated areas', () => {
    let w = baseWorld();
    expect(temporaryOf(w, 'o-it')!.state).toBe('ACTIVE');
    expect(permanentOf(w, 'o-it')!.id).toBe('st-o-it');
    expect(w.areas.filter((a) => a.org === 'o-it').every((a) => a.status === 'ACTIVE')).toBe(true);
    w = perform(w, 'system', { t: 'TICK', to: NOW + 13 * DAY }); // the temporary one expires
    expect(w.areas.filter((a) => a.org === 'o-it').every((a) => a.status === 'ACTIVE')).toBe(true);
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

  it('D15/D2: switching needs SWITCH_RELOCATION_CANDIDATE; review resumes at the anchor; location-independent decisions are carried', () => {
    const w0 = baseWorld();
    expect(why(w0, 'p-req-dir', { t: 'SWITCH', req: 'r-ss-gen', reason: 'x' })).toMatch(/SWITCH_RELOCATION_CANDIDATE|مقدم الطلب/);
    const w = perform(w0, 'p-dec', { t: 'SWITCH', req: 'r-ss-gen', reason: 'البديل يجتاز التحقق' });
    const r = w.requests.find((x) => x.id === 'r-ss-gen')!;
    expect(r.state).toBe('UNDER_REVIEW_ALTERNATIVE');
    expect(r.stages[r.cursor].key).toBe('site');
    expect(r.stages.find((s) => s.key === 'org')!.mark).toBe('APPROVED');
    expect(r.stages.find((s) => s.key === 'scope')!.mark).toBe('CARRIED');
    expect(r.stages.find((s) => s.key === 'site')!.mark).toBe('INVALIDATED');
    expect(w.events.at(-1)!.type).toBe('RELOCATION_ACTIVE_CANDIDATE_CHANGED');
  });

  it('D15: a candidate that was not accepted can be reopened; a finally rejected one cannot', () => {
    let w = perform(baseWorld(), 'p-dec', { t: 'SWITCH', req: 'r-ss-gen', reason: 'تبديل' });
    expect(ok(w, 'p-dec', { t: 'REOPEN', req: 'r-ss-gen', role: 'PRIMARY', reason: 'زال التعارض' })).toBe(true);
    w.requests.find((x) => x.id === 'r-ss-gen')!.candidates.PRIMARY.status = 'REJECTED_FINAL';
    expect(why(w, 'p-dec', { t: 'REOPEN', req: 'r-ss-gen', role: 'PRIMARY', reason: 'x' })).toContain('مرفوض نهائياً');
  });

  it('D18: invalidation follows what changed', () => {
    const st = stagesTemplate().map((s) => ({ ...s, mark: 'APPROVED' as const }));
    expect(impact(st, ['SCOPE'])).toMatchObject({ restart: 0, invalidated: ['org', 'site', 'scope', 'final'] });
    expect(impact(st, ['DURATION'])).toMatchObject({ restart: 1, invalidated: ['site', 'scope', 'final'], carried: [] });
    expect(impact(st, ['CANDIDATE'])).toMatchObject({ restart: 1, invalidated: ['site', 'final'], carried: ['scope'] });
    expect(impact(st, ['CLASSIFICATION']).restart).toBe(0);
  });

  it('invariants 1–3: activation never touches facility responsibility, and never deletes history', () => {
    const w0 = baseWorld();
    const w = perform(w0, 'p-act', { t: 'ACTIVATE', req: 'r-ga-fin' });
    expect(w.sites).toEqual(w0.sites); // no facility record changed
    expect(w.stationings.find((s) => s.id === 'st-o-ga-fin')!.state).toBe('ENDED');
    expect(permanentOf(w, 'o-ga-fin')!.siteId).toBe('c-ga-fin-alt');
  });
});
