import { useEffect, useState } from 'react';
import { api, type Administrator } from '../api/client';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';

export function AdminLifecycle() {
  const app = useApp();
  const [admins, setAdmins] = useState<Administrator[]>([]);
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.listAdministrators().then(setAdmins).catch((e: Error) => app.toast(e.message));
  useEffect(() => { void load(); }, []);

  const add = async () => {
    if (!username.trim()) return;
    setBusy(true);
    try {
      await api.addAdministrator(username.trim());
      setUsername('');
      setAdding(false);
      await load();
      app.toast('أُضيف مدير النظام');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (personId: string, name: string) => {
    if (!confirm(`هل تريد إزالة صلاحية مدير النظام عن ${name}؟`)) return;
    setBusy(true);
    try {
      await api.removeAdministrator(personId);
      await load();
      app.toast('أُزيلت صلاحية مدير النظام');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card padding" data-testid="admin-lifecycle" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>مديرو النظام</h2>
        <button className="button small" onClick={() => setAdding(!adding)}>{adding ? 'إلغاء' : '＋ مدير جديد'}</button>
      </div>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>
        أشخاص لديهم صلاحية تهيئة النظام الكاملة. يُضاف المدير عبر حساب الدليل المؤسسي فقط — يجب أن يكون قد دخل مرة واحدة على الأقل.
      </p>

      {adding && (
        <div className="flex" style={{ gap: 8, marginBottom: 12 }}>
          <input
            dir="ltr"
            placeholder="اسم حساب الدليل (username)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            style={{ flex: 1 }}
            autoFocus
          />
          <button className="button primary" disabled={busy || !username.trim()} onClick={add}>
            بحث وإضافة
          </button>
        </div>
      )}

      {admins.length === 0 && <p className="micro muted">لا يوجد مديرو نظام حالياً.</p>}

      {admins.map((a) => (
        <div key={a.personId} className="key-value" style={{ alignItems: 'center' }}>
          <span>
            <b>{a.displayName}</b>
            <br />
            <small className="muted" dir="ltr">{a.username}</small>
            {a.employeeNumber && <small className="muted"> · {a.employeeNumber}</small>}
            {a.grantedAt && <small className="muted"> · منذ {fullTime(a.grantedAt)}</small>}
            {a.grantedBy && <small className="muted"> · بواسطة {a.grantedBy}</small>}
          </span>
          <button
            className="button small"
            disabled={busy || admins.length <= 1}
            title={admins.length <= 1 ? 'لا يمكن إزالة آخر مدير' : 'إزالة صلاحية مدير النظام'}
            onClick={() => remove(a.personId, a.displayName)}
          >
            إزالة
          </button>
        </div>
      ))}
    </section>
  );
}
