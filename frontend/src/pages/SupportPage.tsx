import { useEffect, useState } from 'react';
import { api, type HelpDoc, type HelpHit, type SupportCase, type SupportCaseRow, type SupportCategory, type SupportPriority } from '../api/client';
import { Markdown } from '../components/support/Markdown';
import { Heading, Icon } from '../components/ui';
import { useApp } from '../lib/app';
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL, clientInfo, lastView } from '../lib/support';
import './support.css';

const caseFromHash = () => /^#support\/([0-9a-f-]{36})$/.exec(location.hash)?.[1] ?? null;
const dateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ar-AE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai' }) : '—';

/**
 * «مركز الدعم», as in TNQL's support hub (owner, 11 Nov 2026; ADR-053, ADR-054): «كيف يمكننا مساعدتك؟» — search «دليل تمركز»
 * (verified documents, each answer citing its source), report a problem, or follow «بلاغاتي». Open to everyone signed in.
 */
export function SupportPage() {
  const [caseId, setCaseId] = useState<string | null>(caseFromHash);
  useEffect(() => {
    const on = () => setCaseId(caseFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return caseId ? <CaseView id={caseId} /> : <Hub />;
}

function Hub() {
  const app = useApp();
  const [mode, setMode] = useState<'search' | 'report'>('search');
  const [mine, setMine] = useState<SupportCaseRow[] | null>(null);
  const load = () => api.supportMine().then(setMine).catch(() => setMine([]));
  useEffect(() => {
    void load();
  }, [app.revision]);
  return (
    <div className="sp-page">
      <Heading en="SUPPORT" title="مركز الدعم" description="كيف يمكننا مساعدتك؟ ابحث في دليل تمركز، أو أبلغ عن مشكلة وتابعها." />
      <div className="sp-doors" role="tablist" aria-label="طرق المساعدة">
        <button role="tab" aria-selected={mode === 'search'} className={'sp-door' + (mode === 'search' ? ' on' : '')} onClick={() => setMode('search')}>
          <Icon name="search" />
          <b>ابحث في دليل تمركز</b>
          <small>شروح موثقة لما تستطيع فعله</small>
        </button>
        <button role="tab" aria-selected={mode === 'report'} className={'sp-door' + (mode === 'report' ? ' on' : '')} onClick={() => setMode('report')} data-testid="support-report-door">
          <Icon name="headset" />
          <b>أبلغ عن مشكلة</b>
          <small>يصل بلاغك لفريق الدعم</small>
        </button>
      </div>
      <div className="sp-grid">
        <section className="card sp-main">{mode === 'search' ? <HelpSearch onReport={() => setMode('report')} /> : <ReportForm onSent={() => (setMode('search'), void load())} />}</section>
        <section className="card sp-mine" data-testid="support-mine">
          <h3>بلاغاتي</h3>
          {mine == null ? (
            <div className="empty">جارٍ التحميل…</div>
          ) : mine.length === 0 ? (
            <div className="empty">لا بلاغات بعد.</div>
          ) : (
            <ul className="sp-list">
              {mine.map((c) => (
                <li key={c.id}>
                  <a href={'#support/' + c.id} className="sp-row">
                    <span className={'sp-status s-' + c.status}>{STATUS_LABEL[c.status]}</span>
                    <b>{c.title}</b>
                    <small className="latin">{c.number}</small>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** «دليل تمركز»: the server answers from verified documents the person may see; each hit names its source. */
export function HelpSearch({ onReport }: { onReport: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<HelpHit[] | null>(null);
  const [index, setIndex] = useState<HelpHit[]>([]);
  const [doc, setDoc] = useState<HelpDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.helpIndex().then(setIndex).catch(() => setIndex([]));
  }, []);
  const search = () => {
    if (!q.trim()) return setHits(null);
    setError(null);
    api.helpSearch(q.trim()).then(setHits).catch((e: Error) => setError(e.message));
  };
  const open = (resource: string) => api.helpDoc(resource).then(setDoc).catch((e: Error) => setError(e.message));
  if (doc) {
    return (
      <div className="sp-doc" data-testid="help-doc">
        <button className="button compact" onClick={() => setDoc(null)}>→ رجوع</button>
        <Markdown source={doc.body} />
        <p className="sp-cite">
          المصدر: <span className="latin">{doc.resource}</span> · موثّق {doc.verified}
          {doc.screen && (
            <>
              {' · '}
              <a href={'#' + doc.screen}>افتح الشاشة</a>
            </>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="sp-search">
      <form className="sp-searchbar" onSubmit={(e) => (e.preventDefault(), search())}>
        <input aria-label="سؤالك" placeholder="اكتب سؤالك، مثل: كيف أضيف مستخدماً؟" value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} autoFocus />
        <button className="button primary" type="submit">بحث</button>
      </form>
      {error && <div className="error-text" role="alert">{error}</div>}
      {hits != null &&
        (hits.length === 0 ? (
          <div className="sp-nohit">
            لم نجد شرحاً مطابقاً في الدليل. <button className="sp-link" onClick={onReport}>أبلغ عن مشكلة</button>
          </div>
        ) : (
          <ul className="sp-hits" data-testid="help-hits">
            {hits.map((h) => (
              <li key={h.resource}>
                <button className="sp-hit" onClick={() => void open(h.resource)}>
                  <b>{h.title}</b>
                  {h.snippet && <span>{h.snippet}</span>}
                  <small className="latin">{h.resource}</small>
                </button>
              </li>
            ))}
          </ul>
        ))}
      {hits == null && index.length > 0 && (
        <div className="sp-index">
          <h4>الشروح المتاحة لك</h4>
          <ul>
            {index.map((h) => (
              <li key={h.resource}>
                <button className="sp-link" onClick={() => void open(h.resource)}>{h.title}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ReportForm({ onSent }: { onSent: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<SupportCategory>('OTHER');
  const [priority, setPriority] = useState<SupportPriority>('NORMAL');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screen = lastView();
  const send = () => {
    setBusy(true);
    setError(null);
    api
      .supportOpen({ title: title.trim(), category, priority, body: body.trim(), screen, clientInfo: clientInfo() })
      .then((r) => (app.toast('أُرسل البلاغ ' + r.number + ' ✓'), onSent(), (location.hash = 'support/' + r.id)))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="sp-form" data-testid="support-form">
      <label className="field">
        <span>عنوان قصير للمشكلة</span>
        <input aria-label="عنوان المشكلة" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="مثال: لا تظهر الخريطة" />
      </label>
      <label className="field">
        <span>التصنيف</span>
        <select aria-label="التصنيف" value={category} onChange={(e) => setCategory(e.target.value as SupportCategory)}>
          {(Object.keys(CATEGORY_LABEL) as SupportCategory[]).map((c) => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
      </label>
      <fieldset className="sp-prio">
        <legend>الأولوية</legend>
        {(['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as SupportPriority[]).map((p) => (
          <label key={p} className={priority === p ? 'on' : ''}>
            <input type="radio" name="sp-prio" checked={priority === p} onChange={() => setPriority(p)} />
            <b>{PRIORITY_LABEL[p].name}</b>
            <small>{PRIORITY_LABEL[p].hint}</small>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>ماذا حدث، وماذا كنت تتوقع؟</span>
        <textarea aria-label="وصف المشكلة" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={6} />
      </label>
      <p className="sp-note">
        يُرفق مع البلاغ {screen ? <>اسم الشاشة (<span className="latin">{screen}</span>) و</> : ''}معلومات المتصفح فقط، لا محتوى طلباتك. لا تكتب كلمة مرورك.
      </p>
      {error && <div className="error-text" role="alert">{error}</div>}
      <button className="button primary" disabled={busy || title.trim().length < 3 || !body.trim()} onClick={send} data-testid="support-send">إرسال البلاغ</button>
    </div>
  );
}

function CaseView({ id }: { id: string }) {
  const app = useApp();
  const [c, setC] = useState<SupportCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.supportCase(id).then((x) => (setC(x), setError(null))).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, app.revision]);
  const run = (work: Promise<unknown>, done: string) => {
    setBusy(true);
    work
      .then(() => (app.toast(done), setReply(''), void load()))
      .catch((e: Error) => app.toast(e.message))
      .finally(() => setBusy(false));
  };
  if (error) return <div className="sp-page"><a href="#support" className="button compact">→ مركز الدعم</a><div className="error-text" role="alert">{error}</div></div>;
  if (!c) return <div className="empty">جارٍ التحميل…</div>;
  return (
    <div className="sp-page" data-testid="support-case">
      <a href="#support" className="button compact">→ مركز الدعم</a>
      <Heading en={c.number} title={c.title} description={CATEGORY_LABEL[c.category] + ' · الأولوية ' + PRIORITY_LABEL[c.priority].name + ' · فُتح ' + dateTime(c.createdAt)} />
      <p>
        <span className={'sp-status s-' + c.status}>{STATUS_LABEL[c.status]}</span>
        {c.assigneeName && <span className="muted"> · يتابعه {c.assigneeName}</span>}
      </p>
      <Thread messages={c.messages} />
      {c.status === 'RESOLVED' && (
        <div className="sp-confirm card">
          <b>هل حُلّت مشكلتك؟</b>
          <div className="flex">
            <button className="button primary" disabled={busy} onClick={() => run(api.supportConfirm(id, true), 'أُغلق البلاغ، شكراً لك')}>تم الحل، أغلق البلاغ</button>
            <button className="button" disabled={busy} onClick={() => run(api.supportConfirm(id, false, reply.trim() || undefined), 'أُعيد فتح البلاغ')}>لم تُحل، أعد فتحه</button>
          </div>
        </div>
      )}
      {c.status !== 'CLOSED' ? (
        <div className="sp-reply">
          <textarea aria-label="ردك" placeholder="اكتب ردك…" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={4000} rows={3} />
          <button className="button primary" disabled={busy || !reply.trim()} onClick={() => run(api.supportReply(id, reply.trim()), 'أُرسل ردك')}>إرسال</button>
        </div>
      ) : (
        <p className="muted">البلاغ مغلق. إذا عادت المشكلة افتح بلاغاً جديداً.</p>
      )}
    </div>
  );
}

export function Thread({ messages }: { messages: SupportCase['messages'] }) {
  return (
    <ol className="sp-thread">
      {messages.map((m) => (
        <li key={m.id} className={(m.fromSupport ? 'support' : 'user') + (m.internal ? ' internal' : '')}>
          <div className="sp-meta">
            <b>{m.fromSupport ? 'الدعم الفني · ' + m.author : m.author}</b>
            {m.internal && <span className="sp-internal">ملاحظة داخلية</span>}
            <small>{dateTime(m.createdAt)}</small>
          </div>
          <p>{m.body}</p>
        </li>
      ))}
    </ol>
  );
}

export { dateTime };
