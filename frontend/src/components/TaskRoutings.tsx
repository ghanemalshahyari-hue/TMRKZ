import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { TaskCandidate, TaskRouting } from '../api/types';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';

const REASON: Record<string, string> = {
  SEPARATION_OF_DUTIES: 'لا يملك صفة المهمة أحد مستقل عن مقدم الطلب',
  HR_SYNC: 'تغير الانتماء الوظيفي بعد مزامنة الموارد البشرية',
};

/**
 * Open tasks waiting for an access manager (ADR-027): after a departure, or when nobody independent of the requester
 * holds the task. The manager chooses one person from the authorised list — never the requester, whom the server
 * excludes — with a reason, which is audited. A request the manager made never appears here.
 */
export function TaskRoutings() {
  const app = useApp();
  const [items, setItems] = useState<TaskRouting[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState<TaskCandidate[]>([]);
  const [chosen, setChosen] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    api
      .taskRoutings()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load, app.revision]);

  const search = async (id: string) => {
    try {
      setCandidates((await api.taskRoutingCandidates(id, q.trim())).items);
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const toggle = (id: string) => {
    setOpen(open === id ? null : id);
    setCandidates([]);
    setChosen('');
    if (open !== id) void search(id);
  };

  const assign = async (id: string) => {
    if (!chosen) return app.toast('اختر صاحب الصفة.');
    if (reason.trim().length < 5) return app.toast('اذكر سبب الإسناد (5 أحرف على الأقل).');
    try {
      await api.assignRoutedTask(id, chosen, reason.trim());
      app.toast('أُسندت المهمة وسُجل القرار في التدقيق');
      setOpen(null);
      setReason('');
      setChosen('');
      load();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  return (
    <section className="card padding" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h3>مهام بانتظار الإسناد</h3>
        <span className="pill">{items.length}</span>
      </div>
      <p className="micro muted" style={{ margin: '8px 0 12px' }}>
        لا يبت أحد في طلب قدمه. إن لم يملك صفة المهمة أحد غير مقدم الطلب، تنتظر المهمة هنا حتى تمنح الصفة لشخص مستقل وتسندها إليه.
      </p>
      {!items.length && <p className="micro muted">لا توجد مهام بانتظار الإسناد.</p>}
      {items.map((i) => (
        <div key={i.id} className="key-value" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
          <div className="flex spread" style={{ width: '100%' }}>
            <span>
              <b className="latin">{i.requestNumber}</b> · {i.taskName}
              <br />
              <small className="muted">
                {REASON[i.reason] ?? i.reason} · {i.organization ?? ''} · {fullTime(i.createdAt)}
              </small>
            </span>
            <button className="button compact" onClick={() => toggle(i.id)}>
              {open === i.id ? 'إغلاق' : 'إسناد'}
            </button>
          </div>
          {open === i.id && (
            <div style={{ width: '100%' }}>
              <div className="flex" style={{ gap: 8 }}>
                <input placeholder="ابحث في أصحاب الصفة" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search(i.id)} />
                <button className="button compact" onClick={() => search(i.id)}>
                  بحث
                </button>
              </div>
              {candidates.length ? (
                <select value={chosen} onChange={(e) => setChosen(e.target.value)} style={{ marginTop: 8, width: '100%' }} aria-label="صاحب الصفة">
                  <option value="">— اختر صاحب الصفة —</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                      {c.employeeNo ? ` · ${c.employeeNo}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="micro muted" style={{ marginTop: 8 }}>
                  لا يوجد صاحب صفة مستقل بعد؛ امنح دور المهمة لشخص مستقل من «المنح والنطاقات» ثم عد إلى هنا.
                </p>
              )}
              <label className="field" style={{ marginTop: 8 }}>
                <span>سبب الإسناد</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button className="button primary compact" onClick={() => assign(i.id)} disabled={!chosen}>
                إسناد المهمة
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
