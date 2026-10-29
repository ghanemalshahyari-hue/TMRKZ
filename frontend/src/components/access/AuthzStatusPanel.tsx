import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { AuthzStatus } from '../../api/types';
import { useApp } from '../../lib/app';
import { fullTime } from '../../lib/dates';

/** State of the decision service (OpenFGA) and of the grant synchronisation, with a rebuild for global managers. */
export function AuthzStatusPanel({ global }: { global: boolean }) {
  const app = useApp();
  const [status, setStatus] = useState<AuthzStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .authzStatus()
      .then((s) => (setStatus(s), setError(null)))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [app.revision]);

  const rebuild = async () => {
    if (!confirm('تُبنى بيانات الصلاحيات من قاعدة البيانات في مخزن جديد ثم يُنتقل إليه. تستمر القرارات على المخزن الحالي حتى الانتقال. متابعة؟')) return;
    setBusy(true);
    try {
      const s = await api.authzRebuild();
      setStatus(s);
      app.toast('أعيد البناء: ' + (s.rebuiltTuples ?? 0) + ' علاقة في ' + Math.round((s.rebuildMs ?? 0) / 100) / 10 + ' ث');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="card padding error-text">{error}</div>;
  if (!status) return <div className="card padding empty">جارٍ التحميل…</div>;
  const ok = status.configured && status.reachable && !status.lastError;
  return (
    <section className="card padding">
      <div className="column-heading flex spread" style={{ padding: 0 }}>
        <h3>خدمة قرارات الصلاحيات (OpenFGA)</h3>
        <span className={'pill ' + (ok ? 'green' : 'red')}>
          <i className="dot" />
          {!status.configured ? 'غير مهيأة — تُرفض الإجراءات الحساسة' : !status.reachable ? 'غير متاحة — تُرفض الإجراءات الحساسة' : ok ? 'تعمل' : 'تعمل مع خطأ مزامنة'}
        </span>
      </div>
      <dl className="status-list">
        <dt>المخزن</dt>
        <dd className="latin">{status.storeId ?? '—'}</dd>
        <dt>نموذج القرار المثبت</dt>
        <dd className="latin">{status.modelId ?? '—'}</dd>
        <dt>تغييرات مطبقة / آخر تغيير</dt>
        <dd>
          {status.appliedSeq} / {status.latestSeq} {status.pendingChanges > 0 && <span className="pill orange">{status.pendingChanges} قيد التطبيق</span>}
        </dd>
        <dt>العلاقات المنشورة</dt>
        <dd>{status.tuples}</dd>
        <dt>آخر مزامنة ناجحة</dt>
        <dd>
          {status.lastSuccessAt ? fullTime(status.lastSuccessAt) : '—'}
          {status.lastDurationMs != null && ' · ' + status.lastDurationMs + ' ملّي ث'}
        </dd>
        <dt>آخر خطأ</dt>
        <dd className={status.lastError ? 'bad' : 'muted'}>
          {status.lastError ? status.lastError + (status.lastErrorAt ? ' (' + fullTime(status.lastErrorAt) + ')' : '') : 'لا يوجد'}
        </dd>
      </dl>
      <p className="micro muted">
        المنح في قاعدة بيانات الأعمال هي المرجع. كل تغيير يُسجل في نفس المعاملة ويُطبق على خدمة القرار خلال ثوانٍ؛ قبل أي إجراء حساس
        تُطبق تغييرات صاحبه أولاً، وإن تعذر ذلك أو تعطلت الخدمة يُرفض الإجراء برسالة واضحة دون مسار بديل يسمح تلقائياً.
      </p>
      {global && (
        <button className="button" disabled={busy || !status.configured} onClick={rebuild}>
          إعادة بناء بيانات الصلاحيات
        </button>
      )}
    </section>
  );
}
