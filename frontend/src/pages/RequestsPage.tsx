import { useEffect, useState } from 'react';
import { api, newIdempotencyKey, urls } from '../api/client';
import type { RequestDetail, RequestListItem, RequestStatus } from '../api/types';
import { RequestDocument } from '../components/RequestDocument';
import { Dialog, DialogHead, Heading, Icon, StatusPill } from '../components/ui';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { STATUS } from '../lib/labels';

export function RequestsPage() {
  const app = useApp();
  const [items, setItems] = useState<RequestListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | RequestStatus>('all');
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .requests({ q: query || undefined, status: status === 'all' ? undefined : status, size: 200 })
        .then((p) => {
          setItems(p.items);
          setTotal(p.total);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [query, status, app.revision]);

  const show = async (r: RequestListItem) => {
    if (app.can('REVIEW') && r.status !== 'DRAFT') {
      app.setSelectedRequestId(r.id);
      app.navigate('review');
      return;
    }
    try {
      setDetail(await api.request(r.id));
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const exportCsv = async () => {
    if (!app.can('EXPORT')) return app.toast('لا تملك صلاحية التصدير');
    setExporting(true);
    try {
      const job = await api.createExport(status === 'all' ? undefined : status, newIdempotencyKey());
      window.location.href = urls.exportContent(job.id);
      app.toast('تم إنشاء ملف التصدير (' + job.rowCount + ' طلب ضمن نطاقك)');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Heading
        en="REQUESTS / ADMINISTRATIVE SERVICES"
        title="الطلبات"
        description="كل طلب يحتفظ بنسخة النموذج والتدفق اللذين بدأ بهما."
        actions={
          <>
            <button className="button" onClick={exportCsv} disabled={!app.can('EXPORT') || exporting}>
              <Icon name="download" />
              تصدير
            </button>
            <button className="button primary" onClick={() => app.openWizard({ origin: 'LIST' })} disabled={!app.can('CREATE')}>
              ＋ طلب جديد
            </button>
          </>
        }
      />
      <div className="card">
        <div className="filterbar" style={{ margin: 0, borderBottom: '1px solid var(--line)' }}>
          <div className="search-inline">
            <input placeholder="رقم الطلب أو الجهة…" value={query} aria-label="بحث الطلبات" onChange={(e) => setQuery(e.target.value)} />
          </div>
          <label>
            الحالة
            <select value={status} onChange={(e) => setStatus(e.target.value as 'all' | RequestStatus)}>
              <option value="all">كل الحالات</option>
              {(Object.keys(STATUS) as RequestStatus[]).map((k) => (
                <option key={k} value={k}>
                  {STATUS[k][0]}
                </option>
              ))}
            </select>
          </label>
          <span className="micro muted">{total} طلب في العرض</span>
        </div>
        {error && <div className="note red">{error}</div>}
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>رقم الطلب</th>
                <th>النوع</th>
                <th>المرافق</th>
                <th>الجهة</th>
                <th>الفترة</th>
                <th>الحالة</th>
                <th>الإجراء</th>
              </tr>
            </thead>
            <tbody>
              {items === null ? (
                <tr>
                  <td colSpan={7} className="empty">
                    جارٍ التحميل…
                  </td>
                </tr>
              ) : !items.length ? (
                <tr>
                  <td colSpan={7} className="empty">
                    لا توجد طلبات مطابقة
                  </td>
                </tr>
              ) : (
                items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button className="link-button latin" onClick={() => show(r)}>
                        {r.number}
                      </button>
                    </td>
                    <td>{r.type.name}</td>
                    <td>{r.resources.map((x) => x.name).join('، ')}</td>
                    <td>{r.view === 'SUMMARY' || !r.ownerOrg ? 'مقيد' : r.ownerOrg.name}</td>
                    <td>
                      {fullDate(r.period.start)}
                      <br />
                      <span className="muted micro">{r.period.end ? fullDate(r.period.end) : 'دائم'}</span>
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td>
                      {r.createdByMe && ((r.status === 'DRAFT' && (app.can('CREATE') || app.can('EDIT'))) || (r.status === 'RETURNED' && app.can('EDIT'))) ? (
                        <button className="button compact" onClick={() => app.openWizard({ origin: 'LIST', requestId: r.id })}>
                          تعديل وإرسال
                        </button>
                      ) : (
                        <button className="button compact" onClick={() => show(r)}>
                          تفاصيل
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="legend-note">
          <strong>ملاحظة:</strong> السجلات محفوظة في قاعدة بيانات الخادم، وتُعرض ضمن نطاق صلاحياتك فقط. الطلب المعلّق لا يحجز المرفق قبل الاعتماد.
        </div>
      </div>
      <Dialog open={!!detail} onClose={() => setDetail(null)} className="detail-dialog">
        {detail && (
          <>
            <DialogHead title="تفاصيل الطلب" onClose={() => setDetail(null)} />
            <div className="dialog-content">
              <RequestDocument request={detail} actions={detail.status === 'APPROVED' || detail.actions.canEditDraft} onChanged={(r) => r && setDetail(r)} />
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
