import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../lib/app';
import { DEFAULT_BOARD, LIMITS, NOTE_KIND, boardProblem, moveNote, newNote, visibleNotes, type NoteKind, type SignInBoard, type SignInNote } from '../lib/signInNotes';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * «إرشادات صفحة الدخول» in the settings (owner, 17 Nov 2026): the board the sign-in page shows beside the form, edited here —
 * its heading, each note (guidance or an important notice, optional dates, hidden or shown), its order, new notes and
 * removed ones — with the board as it will look. Saved on the server (audited); the sign-in page reads it (ADR-083).
 */
export function SignInNotesSettings() {
  const app = useApp();
  const [board, setBoard] = useState<SignInBoard>(DEFAULT_BOARD);
  const [open, setOpen] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // the saved board, or the page's own notes when none was saved
  useEffect(() => {
    api.signInBoard().then((r) => r.saved && r.board && setBoard(r.board), () => undefined);
  }, []);
  const save = () => {
    setBusy(true);
    setErr('');
    api.saveSignInBoard(board).then((b) => {
      setBoard(b);
      setSavePending(true);
      app.toast('حُفظت إرشادات صفحة الدخول');
    }, (e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const problem = boardProblem(board);
  const set = (b: Partial<SignInBoard>) => (setBoard({ ...board, ...b }), setSavePending(false));
  const setNote = (id: string, n: Partial<SignInNote>) => set({ notes: board.notes.map((x) => (x.id === id ? { ...x, ...n } : x)) });
  const add = (kind: NoteKind) => {
    const n = newNote(kind);
    set({ notes: [...board.notes, n] });
    setOpen(n.id);
  };
  const shown = visibleNotes(board.notes, today());

  return (
    <section className="card padding sg-settings" data-testid="signin-notes-settings" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>إرشادات صفحة الدخول</h2>
        <span className="pill">{board.notes.length} / {LIMITS.notes}</span>
      </div>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>تظهر بجانب نموذج الدخول قبل أن يدخل أحد: لا تكتب فيها معلومات شخصية أو حساسة.</p>
      <div className="sg-grid">
        <div className="sg-edit">
          <label className="field"><span>عنوان اللوحة</span><input aria-label="عنوان اللوحة" maxLength={LIMITS.heading} value={board.heading} onChange={(e) => set({ heading: e.target.value })} /></label>
          <label className="field"><span>السطر تحت العنوان</span><input aria-label="السطر تحت العنوان" maxLength={LIMITS.subheading} value={board.subheading} onChange={(e) => set({ subheading: e.target.value })} /></label>
          <ol className="sg-list" data-testid="signin-notes">
            {board.notes.map((n, i) => (
              <li key={n.id} className={'sg-item' + (n.hidden ? ' is-hidden' : '') + (n.kind === 'NOTICE' ? ' is-notice' : '')} data-note={n.id}>
                <div className="sg-row">
                  <button type="button" className="sg-open" aria-expanded={open === n.id} onClick={() => setOpen(open === n.id ? null : n.id)}>
                    <span className="sg-kind">{NOTE_KIND[n.kind]}</span>
                    <b>{n.title || 'إرشاد جديد'}</b>
                    {n.hidden && <small>مخفي</small>}
                    {(n.from || n.to) && <small>{n.from ?? '…'} ← {n.to ?? '…'}</small>}
                  </button>
                  <span className="sg-tools">
                    <button type="button" aria-label="أعلى" title="أعلى" disabled={i === 0} onClick={() => set({ notes: moveNote(board.notes, n.id, -1) })}>▲</button>
                    <button type="button" aria-label="أسفل" title="أسفل" disabled={i === board.notes.length - 1} onClick={() => set({ notes: moveNote(board.notes, n.id, 1) })}>▼</button>
                    <button type="button" aria-label={n.hidden ? 'إظهار' : 'إخفاء'} title={n.hidden ? 'إظهار' : 'إخفاء'} onClick={() => setNote(n.id, { hidden: !n.hidden })}>{n.hidden ? '◌' : '●'}</button>
                    <button type="button" className="sg-del" aria-label="حذف" title="حذف" data-testid={'delete-note-' + i} onClick={() => set({ notes: board.notes.filter((x) => x.id !== n.id) })}>✕</button>
                  </span>
                </div>
                {open === n.id && (
                  <div className="sg-form">
                    <div className="sg-kinds">
                      {(['GUIDE', 'NOTICE'] as const).map((k) => (
                        <button type="button" key={k} className={'button compact' + (n.kind === k ? ' primary' : '')} aria-pressed={n.kind === k} onClick={() => setNote(n.id, { kind: k })}>{NOTE_KIND[k]}</button>
                      ))}
                    </div>
                    <label className="field"><span>التصنيف الصغير فوق العنوان</span><input aria-label="التصنيف" maxLength={LIMITS.meta} value={n.meta} onChange={(e) => setNote(n.id, { meta: e.target.value })} /></label>
                    <label className="field"><span>العنوان</span><input aria-label="عنوان الإرشاد" maxLength={LIMITS.title} value={n.title} onChange={(e) => setNote(n.id, { title: e.target.value })} /></label>
                    <label className="field"><span>النص</span><textarea aria-label="نص الإرشاد" maxLength={LIMITS.text} rows={3} value={n.text} onChange={(e) => setNote(n.id, { text: e.target.value })} /></label>
                    <div className="sg-dates">
                      <label className="field"><span>يظهر من (اختياري)</span><input type="date" aria-label="يظهر من" value={n.from ?? ''} onChange={(e) => setNote(n.id, { from: e.target.value || null })} /></label>
                      <label className="field"><span>حتى (اختياري)</span><input type="date" aria-label="حتى" value={n.to ?? ''} onChange={(e) => setNote(n.id, { to: e.target.value || null })} /></label>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="sg-add">
            <button type="button" className="button" data-testid="add-note" disabled={board.notes.length >= LIMITS.notes} onClick={() => add('GUIDE')}>＋ إرشاد</button>
            <button type="button" className="button" data-testid="add-notice" disabled={board.notes.length >= LIMITS.notes} onClick={() => add('NOTICE')}>＋ تنبيه مهم</button>
          </div>
          <label className="field"><span>السطر الأخير</span><input aria-label="السطر الأخير" maxLength={LIMITS.subheading} value={board.footer} onChange={(e) => set({ footer: e.target.value })} /></label>
          {problem && <p className="sg-err" role="alert">{problem}</p>}
          <div className="sg-add">
            <button type="button" className="button primary" data-testid="save-notes" disabled={!!problem || busy} onClick={save}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            <button type="button" className="button" onClick={() => (setBoard(DEFAULT_BOARD), setOpen(null), setSavePending(false))}>استعادة الإرشادات الأصلية</button>
          </div>
          {savePending && <p className="micro muted" role="status" data-testid="notes-saved">✓ حُفظت، وتظهر في صفحة الدخول.</p>}
          {err && <p className="sg-err" role="alert">{err}</p>}
        </div>
        <aside className="sg-preview" aria-label="معاينة لوحة الدخول" data-testid="signin-preview">
          <small className="sg-preview-label">كما تظهر اليوم في صفحة الدخول</small>
          <header><strong>{board.heading}</strong><small>{board.subheading}</small></header>
          {shown.map((n) => (
            <article key={n.id} className={'sg-note' + (n.kind === 'NOTICE' ? ' is-notice' : '')}>
              {n.meta && <span>{n.meta}</span>}
              <b>{n.title}</b>
              <p>{n.text}</p>
            </article>
          ))}
          {shown.length === 0 && <p className="micro muted">لا إرشادات ظاهرة اليوم.</p>}
          <footer>{board.footer}</footer>
        </aside>
      </div>
    </section>
  );
}
