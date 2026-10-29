import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { IdentityIssue, Person } from '../api/types';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';

const REASON: Record<IdentityIssue['reason'], string> = {
  NO_KEY: 'لا يحمل الحساب مفتاح الربط',
  NO_MATCH: 'لا يوجد سجل مطابق في الموارد البشرية',
  AMBIGUOUS: 'المفتاح يطابق أكثر من سجل',
  INACTIVE: 'السجل غير نشط',
  STALE_SOURCE: 'بيانات الموارد البشرية غير محدثة',
  ALREADY_LINKED: 'السجل مرتبط بحساب آخر',
};

/**
 * Sign-ins that could not be linked automatically. An access manager links one to an active person (chosen by search,
 * never by name similarity) or dismisses it — always with a reason, which is audited.
 */
export function IdentityIssues() {
  const app = useApp();
  const [items, setItems] = useState<IdentityIssue[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    api
      .identityIssues()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load, app.revision]);

  const search = async () => {
    if (q.trim().length < 2) return;
    try {
      setPeople((await api.people(q.trim())).items.filter((p) => p.status === 'ACTIVE'));
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const resolve = async (id: string, link: boolean) => {
    if (reason.trim().length < 5) return app.toast('اذكر سبب القرار (5 أحرف على الأقل).');
    if (link && !chosen) return app.toast('اختر الشخص المراد ربطه.');
    try {
      await api.resolveIdentityIssue(id, link ? chosen : null, reason.trim());
      app.toast(link ? 'رُبط الحساب وسُجل القرار في التدقيق' : 'أُغلق الطلب دون ربط');
      setOpen(null);
      setReason('');
      setChosen('');
      setPeople([]);
      load();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  return (
    <section className="card padding" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h3>حسابات بانتظار الربط</h3>
        <span className="pill">{items.length}</span>
      </div>
      <p className="micro muted" style={{ margin: '8px 0 12px' }}>
        دخول مؤسسي ناجح لم يُربط آلياً بسجل الموارد البشرية. لا يُربط حساب بتشابه الاسم؛ اختر السجل الصحيح أو أغلق الطلب مع ذكر السبب.
      </p>
      {!items.length && <p className="micro muted">لا توجد حسابات بانتظار الربط.</p>}
      {items.map((i) => (
        <div key={i.id} className="key-value" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
          <div className="flex spread" style={{ width: '100%' }}>
            <span>
              <b>{i.displayName ?? 'حساب دون اسم'}</b>
              <br />
              <small className="muted">
                {REASON[i.reason]} · {i.attempts} محاولة · آخرها {fullTime(i.lastSeenAt)}
                {i.claimedKey ? <> · <span className="latin">{i.claimedKey}</span></> : null}
              </small>
            </span>
            <button className="button compact" onClick={() => setOpen(open === i.id ? null : i.id)}>
              {open === i.id ? 'إغلاق' : 'معالجة'}
            </button>
          </div>
          {open === i.id && (
            <div style={{ width: '100%' }}>
              <div className="flex" style={{ gap: 8 }}>
                <input placeholder="ابحث بالاسم أو الرقم الوظيفي" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
                <button className="button compact" onClick={search}>
                  بحث
                </button>
              </div>
              {people.length > 0 && (
                <select value={chosen} onChange={(e) => setChosen(e.target.value)} style={{ marginTop: 8, width: '100%' }} aria-label="الشخص">
                  <option value="">— اختر الشخص —</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} · {p.employeeNo}
                    </option>
                  ))}
                </select>
              )}
              <label className="field" style={{ marginTop: 8 }}>
                <span>سبب القرار</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="flex" style={{ gap: 8 }}>
                <button className="button primary compact" onClick={() => resolve(i.id, true)} disabled={!chosen}>
                  ربط بالشخص المختار
                </button>
                <button className="button compact" onClick={() => resolve(i.id, false)}>
                  إغلاق دون ربط
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
