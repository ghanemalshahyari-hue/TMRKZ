import { useEffect, useState } from 'react';
import { api, type SupportCase, type SupportCaseRow, type SupportPriority, type SupportSeat } from '../api/client';
import { PersonPicker } from '../components/access/pickers';
import { Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { CATEGORY_LABEL, EVENT_LABEL, PRIORITY_LABEL, STATUS_LABEL_STAFF, overdue } from '../lib/support';
import { Thread, dateTime } from './SupportPage';
import './support.css';

const caseFromHash = () => /^#supportConsole\/([0-9a-f-]{36})$/.exec(location.hash)?.[1] ?? null;
const FILTERS: [string, string][] = [
  ['open', 'المفتوحة'],
  ['mine', 'المسندة إليّ'],
  ['unassigned', 'غير المسندة'],
  ['resolved', 'المحلولة'],
];

/**
 * «لوحة الدعم», as in TNQL's support console (owner, 11 Nov 2026; ADR-053): the queue by priority and response time, one case
 * at a time with its actions, and «مقاعد الدعم». The server checks the seat on every call.
 */
export function SupportConsolePage() {
  const app = useApp();
  const seat = app.me.supportSeat ?? null;
  const managesSeats = seat === 'SUPERVISOR' || app.can('CONFIGURE');
  const [tab, setTab] = useState<'queue' | 'seats'>(seat ? 'queue' : 'seats');
  return (
    <div className="sp-page">
      <Heading en="SUPPORT CONSOLE" title="لوحة الدعم" description={seat ? (seat === 'SUPERVISOR' ? 'مشرف دعم' : 'موظف دعم') + ': بلاغات المستخدمين حسب الأولوية وموعد الاستجابة.' : 'لا تملك مقعد دعم؛ تستطيع تعيين مقاعد الدعم فقط.'} />
      <div className="tabs" role="tablist" aria-label="أقسام لوحة الدعم">
        {seat && <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>البلاغات</button>}
        {managesSeats && <button role="tab" aria-selected={tab === 'seats'} className={tab === 'seats' ? 'active' : ''} onClick={() => setTab('seats')}>مقاعد الدعم</button>}
      </div>
      {tab === 'queue' && seat ? <Queue supervisor={seat === 'SUPERVISOR' || app.can('CONFIGURE')} /> : managesSeats ? <Seats /> : null}
    </div>
  );
}

function Queue({ supervisor }: { supervisor: boolean }) {
  const app = useApp();
  const [filter, setFilter] = useState('open');
  const [rows, setRows] = useState<SupportCaseRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(caseFromHash);
  const load = () => {
    api.supportQueue(filter).then(setRows).catch(() => setRows([]));
    api.supportCounts().then(setCounts).catch(() => setCounts({}));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, app.revision]);
  useEffect(() => {
    const on = () => setSelected(caseFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="sc-grid">
      <section className="card sc-queue" data-testid="support-queue">
        <div className="sc-counts">
          <span>مفتوحة <b>{(counts.OPEN ?? 0) + (counts.IN_PROGRESS ?? 0)}</b></span>
          <span>بانتظار المستخدم <b>{counts.WAITING_USER ?? 0}</b></span>
          <span className={counts.OVERDUE ? 'late' : ''}>متأخرة <b>{counts.OVERDUE ?? 0}</b></span>
        </div>
        <div className="sc-filters" role="group" aria-label="تصفية البلاغات">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={'chip' + (filter === k ? ' on' : '')} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        {rows == null ? (
          <div className="empty">جارٍ التحميل…</div>
        ) : rows.length === 0 ? (
          <div className="empty">لا بلاغات هنا.</div>
        ) : (
          <ul className="sp-list">
            {rows.map((r) => (
              <li key={r.id}>
                <a href={'#supportConsole/' + r.id} className={'sp-row' + (selected === r.id ? ' on' : '') + (overdue(r) ? ' late' : '')}>
                  <span className={'sp-prio-dot p-' + r.priority} title={PRIORITY_LABEL[r.priority].name} />
                  <b>{r.title}</b>
                  <small>
                    <span className="latin">{r.number}</span> · {r.requesterName} · {STATUS_LABEL_STAFF[r.status]}
                    {r.assigneeName ? ' · ' + r.assigneeName : ' · غير مسند'}
                  </small>
                  <small className={overdue(r) ? 'late' : 'muted'}>الاستجابة قبل {dateTime(r.responseDue)}</small>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card sc-detail">{selected ? <CaseDesk id={selected} supervisor={supervisor} onChanged={load} /> : <div className="empty">اختر بلاغاً من القائمة.</div>}</section>
    </div>
  );
}

function CaseDesk({ id, supervisor, onChanged }: { id: string; supervisor: boolean; onChanged: () => void }) {
  const app = useApp();
  const [c, setC] = useState<SupportCase | null>(null);
  const [seats, setSeats] = useState<SupportSeat[]>([]);
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => api.supportCase(id).then(setC).catch((e: Error) => app.toast(e.message));
  useEffect(() => {
    void load();
    if (supervisor) api.supportSeats().then(setSeats).catch(() => setSeats([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, app.revision]);
  const act = (body: Parameters<typeof api.supportAct>[1], done: string) => {
    setBusy(true);
    api
      .supportAct(id, body)
      .then(() => (app.toast(done), setText(''), setInternal(false), void load(), onChanged()))
      .catch((e: Error) => app.toast(e.message))
      .finally(() => setBusy(false));
  };
  if (!c) return <div className="empty">جارٍ التحميل…</div>;
  const mine = c.assigneeId === app.me.id;
  const closed = c.status === 'CLOSED';
  return (
    <div className="sc-desk" data-testid="support-desk">
      <h3>
        <span className="latin">{c.number}</span> — {c.title}
      </h3>
      <dl className="sc-facts">
        <div><dt>صاحب البلاغ</dt><dd>{c.requesterName} <span className="latin muted">{c.requesterNo}</span></dd></div>
        <div><dt>التصنيف</dt><dd>{CATEGORY_LABEL[c.category]}</dd></div>
        <div><dt>الحالة</dt><dd><span className={'sp-status s-' + c.status}>{STATUS_LABEL_STAFF[c.status]}</span></dd></div>
        <div><dt>الشاشة</dt><dd className="latin">{c.screen ?? '—'}</dd></div>
        <div><dt>المتصفح</dt><dd className="latin">{c.clientInfo ? Object.values(c.clientInfo).filter(Boolean).join(' · ') : '—'}</dd></div>
        <div><dt>موعد الاستجابة</dt><dd className={overdue(c) ? 'late' : ''}>{dateTime(c.responseDue)}{c.firstResponseAt ? ' · رُد ' + dateTime(c.firstResponseAt) : ''}</dd></div>
      </dl>
      {!closed && (
        <div className="sc-actions">
          {!mine && <button className="button compact primary" disabled={busy} onClick={() => act({ action: 'CLAIM' }, 'استلمت البلاغ')}>استلام</button>}
          {supervisor && (
            <select aria-label="إسناد إلى" value="" disabled={busy} onChange={(e) => e.target.value && act({ action: 'ASSIGN', assigneeId: e.target.value }, 'أُسند البلاغ')}>
              <option value="">إسناد إلى…</option>
              {seats.map((s) => (
                <option key={s.personId} value={s.personId}>{s.displayName}</option>
              ))}
            </select>
          )}
          <select aria-label="الأولوية" value={c.priority} disabled={busy} onChange={(e) => act({ action: 'PRIORITY', priority: e.target.value as SupportPriority }, 'غُيّرت الأولوية')}>
            {(['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as SupportPriority[]).map((p) => (
              <option key={p} value={p}>الأولوية: {PRIORITY_LABEL[p].name}</option>
            ))}
          </select>
          <button className="button compact" disabled={busy} onClick={() => act({ action: 'CLOSE' }, 'أُغلق البلاغ')}>إغلاق</button>
        </div>
      )}
      <Thread messages={c.messages} />
      <div className="sp-reply">
        <textarea aria-label="الرد" placeholder={closed ? 'ملاحظة داخلية…' : 'اكتب الرد أو الحل…'} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} rows={3} />
        <label className="sc-internal">
          <input type="checkbox" checked={internal || closed} disabled={closed} onChange={(e) => setInternal(e.target.checked)} /> ملاحظة داخلية (لا يراها المستخدم)
        </label>
        <div className="flex">
          <button className="button primary" disabled={busy || !text.trim()} onClick={() => act({ action: 'REPLY', body: text.trim(), internal: internal || closed }, internal || closed ? 'حُفظت الملاحظة' : 'أُرسل الرد')}>
            {internal || closed ? 'حفظ الملاحظة' : 'إرسال الرد'}
          </button>
          {!closed && c.status !== 'RESOLVED' && (
            <button className="button" disabled={busy || text.trim().length < 3 || internal} onClick={() => act({ action: 'RESOLVE', body: text.trim() }, 'سُجّل الحل')} title="اكتب للمستخدم ما الذي حل المشكلة">
              حل البلاغ
            </button>
          )}
        </div>
      </div>
      {c.events && c.events.length > 0 && (
        <details className="sc-events">
          <summary>سجل البلاغ</summary>
          <ul>
            {c.events.map((e, i) => (
              <li key={i}>
                {EVENT_LABEL[e.kind] ?? e.kind} · {e.actor ?? '—'} · <small>{dateTime(e.at)}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Seats() {
  const app = useApp();
  const [seats, setSeats] = useState<SupportSeat[] | null>(null);
  const [person, setPerson] = useState('');
  const [role, setRole] = useState<'AGENT' | 'SUPERVISOR'>('AGENT');
  const load = () => api.supportSeats().then(setSeats).catch((e: Error) => (app.toast(e.message), setSeats([])));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  const grant = () =>
    api
      .supportGrantSeat(person, role)
      .then(() => (app.toast('عُيّن المقعد'), setPerson(''), void load()))
      .catch((e: Error) => app.toast(e.message));
  const end = (s: SupportSeat) => {
    const reason = window.prompt('سبب إنهاء مقعد ' + s.displayName + '؟');
    if (!reason?.trim()) return;
    api
      .supportEndSeat(s.id, reason.trim())
      .then(() => (app.toast('انتهى المقعد'), void load()))
      .catch((e: Error) => app.toast(e.message));
  };
  return (
    <section className="card sp-seats" data-testid="support-seats">
      <h3>مقاعد الدعم</h3>
      <p className="muted micro">موظف الدعم يستلم البلاغات ويرد عليها ويحلها؛ مشرف الدعم يسندها أيضاً ويعيّن موظفي الدعم. مقعد المشرف يعيّنه مدير التهيئة.</p>
      {seats == null ? (
        <div className="empty">جارٍ التحميل…</div>
      ) : seats.length === 0 ? (
        <div className="empty">لا مقاعد بعد.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>الشخص</th><th>المقعد</th><th>بلاغات مفتوحة</th><th /></tr>
          </thead>
          <tbody>
            {seats.map((s) => (
              <tr key={s.id}>
                <td>{s.displayName} <span className="latin muted">{s.employeeNo}</span></td>
                <td>{s.role === 'SUPERVISOR' ? 'مشرف دعم' : 'موظف دعم'}</td>
                <td>{s.openCases}</td>
                <td><button className="button compact" onClick={() => end(s)}>إنهاء</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="sp-addseat">
        <label className="field">
          <span>الشخص</span>
          <PersonPicker value={person} onChange={(id) => setPerson(id)} />
        </label>
        <label className="field">
          <span>المقعد</span>
          <select aria-label="نوع المقعد" value={role} onChange={(e) => setRole(e.target.value as 'AGENT' | 'SUPERVISOR')}>
            <option value="AGENT">موظف دعم</option>
            {app.can('CONFIGURE') && <option value="SUPERVISOR">مشرف دعم</option>}
          </select>
        </label>
        <button className="button primary" disabled={!person} onClick={grant}>تعيين المقعد</button>
      </div>
    </section>
  );
}
