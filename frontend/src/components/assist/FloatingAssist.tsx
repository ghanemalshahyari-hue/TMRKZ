import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api, type AssistantAnswer, type HelpDoc } from '../../api/client';
import { NAV, useApp } from '../../lib/app';
import { HelpSearch, ReportForm } from '../../pages/SupportPage';
import { Markdown } from '../support/Markdown';
import { Icon } from '../ui';
import './floatingAssist.css';

/** Where a floating button stands, as a fraction of the free space so a corner stays a corner on another screen (TNQL's rule). */
type Spot = { fx: number; fy: number };
const spotKey = (k: string) => 'tmrkz.pos.' + k;
function loadSpot(k: string): Spot | null {
  try {
    const v = JSON.parse(localStorage.getItem(spotKey(k)) ?? 'null');
    return v && typeof v.fx === 'number' && typeof v.fy === 'number' ? v : null;
  } catch {
    return null;
  }
}

/**
 * TNQL's movable floating button (movable-fab.js): dragged by the pointer, kept in this browser, and a drag never clicks.
 * Double-click the button's handle area to put it back in its corner.
 */
function useMovable(key: string) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [spot, setSpot] = useState<Spot | null>(() => loadSpot(key));
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const style = spot && typeof window !== 'undefined'
    ? { left: Math.round(spot.fx * Math.max(0, window.innerWidth - 56)) + 'px', top: Math.round(spot.fy * Math.max(0, window.innerHeight - 56)) + 'px', right: 'auto', bottom: 'auto' }
    : undefined;
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || !ref.current) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    d.moved = true;
    const r = ref.current.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.width / 2) / Math.max(1, window.innerWidth - r.width)));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.height / 2) / Math.max(1, window.innerHeight - r.height)));
    setSpot({ fx, fy });
  };
  const onPointerUp = () => {
    if (drag.current?.moved && spot) {
      try {
        localStorage.setItem(spotKey(key), JSON.stringify(spot));
      } catch {
        /* storage blocked: lasts for this page */
      }
    }
  };
  /** True when the pointer gesture was a drag: the click that follows is swallowed. */
  const wasDrag = () => {
    const moved = !!drag.current?.moved;
    drag.current = null;
    return moved;
  };
  const reset = () => {
    setSpot(null);
    try {
      localStorage.removeItem(spotKey(key));
    } catch {
      /* ignore */
    }
  };
  return { ref, style, handlers: { onPointerDown, onPointerMove, onPointerUp }, wasDrag, reset };
}

const viewName = (v: string) => (v === 'home' ? 'الرئيسية' : NAV.find(([id]) => id === v)?.[2] ?? v);

/**
 * The two floating buttons of every signed-in screen, as TNQL's: «الدعم» (a drawer: the guide, a quick report, the support
 * centre) and «المساعد الذكي» (a dock answering from the verified guides, through the site's own model when it is on; ADR-056).
 */
export function FloatingAssist({ view }: { view: string }) {
  const [open, setOpen] = useState<'support' | 'assistant' | null>(null);
  const support = useMovable('support');
  const assistant = useMovable('assistant');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <button
        ref={support.ref}
        className={'fa-fab fa-support' + (open === 'support' ? ' on' : '')}
        style={support.style}
        {...support.handlers}
        onClick={() => !support.wasDrag() && setOpen((o) => (o === 'support' ? null : 'support'))}
        onDoubleClick={support.reset}
        aria-label="الدعم"
        title="الدعم — اسحبه لتغيير مكانه"
        data-testid="fab-support"
      >
        <Icon name="headset" />
      </button>
      <button
        ref={assistant.ref}
        className={'fa-fab fa-assistant' + (open === 'assistant' ? ' on' : '')}
        style={assistant.style}
        {...assistant.handlers}
        onClick={() => !assistant.wasDrag() && setOpen((o) => (o === 'assistant' ? null : 'assistant'))}
        onDoubleClick={assistant.reset}
        aria-label="المساعد الذكي"
        title="المساعد الذكي — اسحبه لتغيير مكانه"
        data-testid="fab-assistant"
      >
        <Icon name="robot" />
      </button>
      {open === 'support' && <SupportDrawer onClose={() => setOpen(null)} />}
      {open === 'assistant' && <AssistantDock view={view} onClose={() => setOpen(null)} onReport={() => setOpen('support')} />}
    </>
  );
}

function SupportDrawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'guide' | 'report'>('guide');
  return (
    <aside className="fa-panel fa-drawer" role="dialog" aria-label="الدعم" data-testid="support-drawer">
      <header>
        <b>الدعم</b>
        <button className="icon-button" aria-label="إغلاق" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="fa-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'guide'} className={tab === 'guide' ? 'on' : ''} onClick={() => setTab('guide')}>دليل تمركز</button>
        <button role="tab" aria-selected={tab === 'report'} className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>أبلغ عن مشكلة</button>
      </div>
      <div className="fa-body">{tab === 'guide' ? <HelpSearch onReport={() => setTab('report')} /> : <ReportForm onSent={onClose} />}</div>
      <footer>
        <a href="#support" onClick={onClose}>مركز الدعم و«بلاغاتي» ←</a>
      </footer>
    </aside>
  );
}

type Turn = { q: string; a: AssistantAnswer | null; error?: string };

function AssistantDock({ view, onClose, onReport }: { view: string; onClose: () => void; onReport: () => void }) {
  const app = useApp();
  const [status, setStatus] = useState<{ enabled: boolean; model: string | null; reachable: boolean } | null>(null);
  const [tab, setTab] = useState<'ask' | 'screen'>('ask');
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<HelpDoc | null>(null);
  const [screenDocs, setScreenDocs] = useState<{ resource: string; title: string }[] | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    api.assistantStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    if (tab !== 'screen') return;
    api.helpIndex().then((all) => setScreenDocs(all.filter((d) => d.screen === view))).catch(() => setScreenDocs([]));
  }, [tab, view]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);
  const ask = useCallback(() => {
    const question = q.trim();
    if (!question || busy) return;
    setQ('');
    setBusy(true);
    setTurns((t) => [...t, { q: question, a: null }]);
    api
      .assistantAsk(question, view)
      .then((a) => setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a } : x))))
      .catch((e: Error) => setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: e.message } : x))))
      .finally(() => setBusy(false));
  }, [q, busy, view]);
  const open = (resource: string) => api.helpDoc(resource).then(setDoc).catch((e: Error) => app.toast(e.message));
  const badge = !status ? '…' : !status.enabled ? 'الدليل فقط' : status.reachable ? status.model ?? 'متصل' : 'النموذج غير متاح';
  return (
    <aside className="fa-panel fa-dock" role="dialog" aria-label="المساعد الذكي" data-testid="assistant-dock">
      <header>
        <b><Icon name="robot" /> المساعد الذكي</b>
        <span className={'fa-badge' + (status?.enabled && status.reachable ? ' ok' : '')} title="حالة النموذج">{badge}</span>
        <button className="icon-button" aria-label="إغلاق" onClick={onClose}><Icon name="close" /></button>
      </header>
      <small className="fa-screen">الشاشة: {viewName(view)}</small>
      <div className="fa-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'ask'} className={tab === 'ask' ? 'on' : ''} onClick={() => (setTab('ask'), setDoc(null))}>اسأل</button>
        <button role="tab" aria-selected={tab === 'screen'} className={tab === 'screen' ? 'on' : ''} onClick={() => (setTab('screen'), setDoc(null))}>شرح الشاشة</button>
      </div>
      {doc ? (
        <div className="fa-body">
          <button className="button compact" onClick={() => setDoc(null)}>→ رجوع</button>
          <Markdown source={doc.body} />
          <p className="sp-cite">المصدر: <span className="latin">{doc.resource}</span></p>
        </div>
      ) : tab === 'screen' ? (
        <div className="fa-body">
          {screenDocs == null ? (
            <div className="empty">جارٍ التحميل…</div>
          ) : screenDocs.length === 0 ? (
            <p className="muted">لا شرح لهذه الشاشة في الدليل بعد. اسأل سؤالك في «اسأل».</p>
          ) : (
            <ul className="sp-hits">
              {screenDocs.map((d) => (
                <li key={d.resource}><button className="sp-hit" onClick={() => void open(d.resource)}><b>{d.title}</b><small className="latin">{d.resource}</small></button></li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="fa-body fa-turns" ref={list} data-testid="assistant-turns">
            {turns.length === 0 && (
              <div className="fa-chips">
                {['كيف أضيف مستخدماً إلى وحدة؟', 'لماذا يُرفض دخولي؟', 'كيف أفعّل إشعارات سطح المكتب؟'].map((s) => (
                  <button key={s} className="chip" onClick={() => setQ(s)}>{s}</button>
                ))}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className="fa-turn">
                <p className="fa-q">{t.q}</p>
                {t.error ? (
                  <p className="error-text">{t.error}</p>
                ) : !t.a ? (
                  <p className="fa-a muted">جارٍ البحث في الدليل…</p>
                ) : (
                  <div className="fa-a">
                    {t.a.answer ? (
                      // the model writes Markdown: rendered as React elements, never as HTML
                      <div className="fa-text"><Markdown source={t.a.answer} /></div>
                    ) : t.a.sources.length ? (
                      <p className="fa-text">وجدت هذا في دليل تمركز:</p>
                    ) : (
                      <p className="fa-text">لم أجد إجابة موثقة في دليل تمركز.</p>
                    )}
                    {t.a.sources.length > 0 && (
                      <ul className="fa-sources">
                        {t.a.sources.map((s) => (
                          <li key={s.resource}>
                            <button className="sp-link" onClick={() => void open(s.resource)}>{s.title}</button>
                            {!t.a!.answer && s.snippet && <span> — {s.snippet}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {t.a.degraded && t.a.degraded !== 'OFF' && <small className="muted">النموذج غير متاح الآن؛ هذه نتائج الدليل.</small>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <form className="fa-ask" onSubmit={(e) => (e.preventDefault(), ask())}>
            <input aria-label="سؤالك للمساعد" placeholder="اكتب سؤالك…" value={q} maxLength={500} onChange={(e) => setQ(e.target.value)} autoFocus />
            <button className="button primary" type="submit" disabled={busy || !q.trim()}>إرسال</button>
          </form>
        </>
      )}
      <footer>
        <button className="sp-link" onClick={onReport}>لم تُحل؟ افتح بلاغاً للدعم</button>
      </footer>
    </aside>
  );
}
