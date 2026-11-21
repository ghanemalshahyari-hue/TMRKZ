import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../lib/app';
import { Heading, KeyValue, Icon } from '../components/ui';
import { fullTime } from '../lib/dates';

type Summary = {
  scannedAt: string | null;
  open: number;
  healthy: number;
  waitingRequester: number;
  warning: number;
  stuck: number;
  outboxPending: number;
  outboxFailed: number;
  peopleWithoutLocalUnit: number;
};

type Health = 'HEALTHY' | 'WAITING_REQUESTER' | 'WARNING' | 'STUCK';

type Row = {
  id: string;
  number: string;
  state: string;
  kind: string;
  requestingUnit: string;
  updatedAt: string;
  health: Health;
  reasonCode: string | null;
  reasonText: string | null;
};

type Stage = {
  position: number;
  stageKey: string;
  label: string;
  permission: string;
  final: boolean;
  decided: boolean;
  mark: 'APPROVED' | 'CARRIED' | null;
  decidedAt: string | null;
};

type Outbox = {
  eventId: string;
  eventType: string;
  state: string;
  attempts: number;
  lastError: string | null;
  availableAt: string | null;
  createdAt: string | null;
};

type Repair = { code: string; label: string; endpoint: string; why: string };

type Diagnosis = {
  id: string;
  number: string;
  state: string;
  kind: string;
  requestingUnit: string | null;
  createdAt: string;
  updatedAt: string;
  lastDecidedAt: string | null;
  sinceLastHours: number;
  routeNo: number;
  stages: Stage[];
  health: Health;
  reason: { code: string; message: string };
  repairs: Repair[];
  outboxFailed: Outbox[];
  outboxPending: Outbox[];
};

const HEALTH_LABEL: Record<Health, [string, string]> = {
  HEALTHY: ['سليم', 'green'],
  WAITING_REQUESTER: ['بانتظار مقدم الطلب', ''],
  WARNING: ['تحذير', 'orange'],
  STUCK: ['متوقف', 'red'],
};

/**
 * «صحة الطلبات» (owner, 20 Nov 2026): the diagnostic workspace for the system administrator. Read-only diagnosis of
 * one request and repair hints that reuse existing endpoints the administrator may call under their current permissions.
 * The service decides nothing on the request's behalf: Separation of Duties stays.
 */
export function RequestHealthPage() {
  const app = useApp();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [q, setQ] = useState('');
  const [healthFilter, setHealthFilter] = useState<'' | Health>('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picked, setPicked] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.requestHealthSummary().then(setSummary).catch((e: Error) => app.toast(e.message));
    api.requestHealthSearch({ q, health: healthFilter || undefined }).then(setRows).catch(() => setRows([]));
  };
  useEffect(load, [app.revision, healthFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  const diagnose = async (identifier: string) => {
    setBusy(true);
    try { setPicked(await api.requestHealthDiagnose(identifier)); }
    catch (e) { app.toast((e as Error).message); setPicked(null); }
    finally { setBusy(false); }
  };

  const chips = useMemo(() => summary ? [
    { l: 'سليم', v: summary.healthy, tone: 'green' },
    { l: 'بانتظار المقدم', v: summary.waitingRequester, tone: '' },
    { l: 'تحذير', v: summary.warning, tone: 'orange' },
    { l: 'متوقف', v: summary.stuck, tone: 'red' },
    { l: 'إخراج قيد الانتظار', v: summary.outboxPending, tone: '' },
    { l: 'إخراج فاشل', v: summary.outboxFailed, tone: summary.outboxFailed ? 'red' : '' },
    { l: 'أشخاص بلا وحدة محلية', v: summary.peopleWithoutLocalUnit, tone: summary.peopleWithoutLocalUnit ? 'orange' : '' },
  ] : [], [summary]);

  return (
    <section data-testid="request-health">
      <Heading
        en="SYSTEM / REQUEST HEALTH"
        title="صحة الطلبات"
        description="تشخيص قراءة فقط للطلبات المفتوحة: متى يكون الطلب سليماً وينتظر قراراً، ومتى يحتاج تدخلاً، ولماذا — دون أن يقرر النظام نيابةً عن أحد."
        actions={<span className="pill">{summary?.scannedAt ? 'آخر فحص ' + fullTime(summary.scannedAt) : 'لم يبدأ الفحص بعد'}</span>}
      />
      <section className="card padding">
        <h2>ملخص الصحة</h2>
        <div className="tz-site-chips" style={{ marginTop: 10 }}>
          {chips.map((c) => (
            <span key={c.l} className={'rh-chip ' + c.tone}><b>{c.v.toLocaleString('ar-AE')}</b><small>{c.l}</small></span>
          ))}
        </div>
      </section>

      <section className="card padding" style={{ marginTop: 14 }}>
        <div className="flex spread">
          <h2>بحث</h2>
          <div className="flex" style={{ gap: 8 }}>
            <input aria-label="بحث برقم الطلب أو الوحدة" value={q} onChange={(e) => setQ(e.target.value)} placeholder="رقم الطلب / الوحدة" style={{ width: 240 }} />
            <select value={healthFilter} onChange={(e) => setHealthFilter(e.target.value as '' | Health)} aria-label="الحالة الصحية">
              <option value="">كل الحالات</option>
              <option value="STUCK">متوقف</option>
              <option value="WARNING">تحذير</option>
              <option value="WAITING_REQUESTER">بانتظار المقدم</option>
              <option value="HEALTHY">سليم</option>
            </select>
            <button type="button" className="button" onClick={load}>تحديث</button>
          </div>
        </div>
        <table className="data-table" style={{ marginTop: 10 }}>
          <thead><tr><th>الرقم</th><th>الوحدة</th><th>الحالة</th><th>الصحة</th><th>سبب الحالة</th><th>آخر تحديث</th><th></th></tr></thead>
          <tbody>
            {rows?.length === 0 && <tr><td colSpan={7} className="muted">لا نتائج</td></tr>}
            {rows?.map((r) => (
              <tr key={r.id} data-testid="rh-row" data-health={r.health}>
                <td><b>{r.number}</b></td>
                <td>{r.requestingUnit}</td>
                <td>{r.state}</td>
                <td><span className={'pill ' + HEALTH_LABEL[r.health][1]}>{HEALTH_LABEL[r.health][0]}</span></td>
                <td className="micro">{r.reasonText}</td>
                <td className="micro">{fullTime(r.updatedAt)}</td>
                <td><button type="button" className="button small" disabled={busy} onClick={() => diagnose(r.number)}>تشخيص</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {picked && (
        <section className="card padding" style={{ marginTop: 14 }} data-testid="rh-diagnosis">
          <div className="flex spread">
            <h2>{picked.number} — {HEALTH_LABEL[picked.health][0]}</h2>
            <button type="button" className="button compact" onClick={() => setPicked(null)}>إغلاق</button>
          </div>
          <KeyValue k="الوحدة الطالبة" v={picked.requestingUnit ?? '—'} />
          <KeyValue k="النوع" v={picked.kind === 'TEMPORARY' ? 'مؤقت' : 'دائم'} />
          <KeyValue k="الحالة" v={picked.state} />
          <KeyValue k="منذ آخر قرار" v={picked.sinceLastHours + ' ساعة'} />
          <KeyValue k="آخر تحديث" v={fullTime(picked.updatedAt)} />
          <div className={'note ' + (picked.health === 'STUCK' ? 'red' : picked.health === 'WARNING' ? 'orange' : '')} style={{ marginTop: 8 }}>
            <b>{picked.reason.code}:</b> {picked.reason.message}
          </div>

          <h3 style={{ marginTop: 14 }}>مراحل المسار</h3>
          <ol className="rh-stages">
            {picked.stages.map((s) => (
              <li key={s.position} data-decided={s.decided}>
                <span className="rh-stage-icon">{s.decided ? <Icon name="check" /> : <Icon name="clock" />}</span>
                <span className="rh-stage-text">
                  <b>{s.position}. {s.label}</b>
                  <small className="muted">{s.permission}{s.decided && s.decidedAt ? ' · قرر في ' + fullTime(s.decidedAt) : ''}</small>
                </span>
              </li>
            ))}
          </ol>

          {picked.repairs.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>إصلاحات مقترحة</h3>
              <ul className="rh-repairs">
                {picked.repairs.map((r) => (
                  <li key={r.code}>
                    <div><b>{r.label}</b><small className="muted"> — {r.why}</small></div>
                    <code className="latin tiny">{r.endpoint}</code>
                  </li>
                ))}
              </ul>
              <p className="micro muted">
                يُنفَّذ الإصلاح من واجهته الأصلية (مثل «مركز الصلاحيات» أو واجهة «إخراج التمركز»)، ولا يُغيّر النظام هنا شيئاً على محتوى الطلب.
              </p>
            </>
          )}

          {picked.outboxFailed.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>أحداث فاشلة</h3>
              <ul className="rh-outbox">
                {picked.outboxFailed.map((e) => (
                  <li key={e.eventId}><b>{e.eventType}</b><small className="muted"> · محاولات {e.attempts} · {e.lastError}</small></li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </section>
  );
}

export default RequestHealthPage;
