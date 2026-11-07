import { Fragment, useEffect, useRef, useState } from 'react';
import { api, newIdempotencyKey, urls } from '../api/client';
import type { RequestDetail, RequestListItem, RequestStatus, RequestType } from '../api/types';
import { RequestDocument } from '../components/RequestDocument';
import { Dialog, DialogHead, Heading, Icon, StatusPill } from '../components/ui';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { STATUS } from '../lib/labels';
import { PAGE_SIZES, activeFilters, dayEnd, dayStart, loadListState, pageInfo, saveListState, sinceText, type ListState, type SortKey } from '../lib/requestsList';
import './requests.css';

const num = (n: number) => n.toLocaleString('en-US');
const TAB_ORDER: RequestStatus[] = ['SUBMITTED', 'RETURNED', 'APPROVED', 'DRAFT', 'REJECTED', 'CLOSED'];
const SHORT: Partial<Record<RequestStatus, string>> = { APPROVED: 'معتمد' };

/**
 * «الطلبات الإدارية»: built for many requests. The server pages, filters and sorts within the person's scope, and only
 * the rows on screen reach the browser. Status tabs say how many match the filters; the filters and the page are
 * remembered for the session, so coming back from a request returns to the same place.
 */
export function RequestsPage() {
  const app = useApp();
  const [state, setState] = useState<ListState>(loadListState);
  const [items, setItems] = useState<RequestListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Partial<Record<RequestStatus, number>>>({});
  const [types, setTypes] = useState<RequestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [retry, setRetry] = useState(0);
  const latest = useRef(0);

  /** A change of filter or tab goes back to the first page; only the pager moves between pages. */
  const change = (patch: Partial<ListState>) => setState((s) => ({ ...s, page: 0, ...patch }));

  useEffect(() => saveListState(state), [state]);
  useEffect(() => {
    api.requestTypes().then(setTypes).catch(() => undefined);
  }, []);
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      const ticket = ++latest.current;
      const filters = { q: state.q.trim() || undefined, type: state.type || undefined, from: dayStart(state.from), to: dayEnd(state.to), mine: state.mine || undefined };
      Promise.all([
        api.requests({ ...filters, status: state.status === 'all' ? undefined : state.status, page: state.page, size: state.size, sort: state.sort, dir: state.dir }),
        api.requestCounts(filters),
      ])
        .then(([p, c]) => {
          // an older answer never replaces a newer one
          if (ticket !== latest.current) return;
          // the list shrank under this page (a filter elsewhere, a request closed): show its last page
          if (!p.items.length && p.total > 0 && state.page > 0) {
            setState((s) => ({ ...s, page: Math.ceil(p.total / s.size) - 1 }));
            return;
          }
          setItems(p.items);
          setTotal(p.total);
          setCounts(c);
          setError(null);
          setLoading(false);
        })
        .catch((e: Error) => {
          if (ticket !== latest.current) return;
          setError(e.message);
          setLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [state, app.revision, retry]);

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
      const job = await api.createExport(state.status === 'all' ? undefined : state.status, newIdempotencyKey());
      window.location.href = urls.exportContent(job.id);
      app.toast('تم إنشاء ملف التصدير (' + job.rowCount + ' طلب ضمن نطاقك)');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const allCount = TAB_ORDER.reduce((a, k) => a + (counts[k] ?? 0), 0);
  const info = pageInfo(state.page, state.size, total);
  const filtered = activeFilters(state) > 0 || state.status !== 'all';
  const sortHead = (key: SortKey, label: string) => {
    const on = state.sort === key;
    return (
      <th aria-sort={on ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button onClick={() => change({ sort: key, dir: on && state.dir === 'desc' ? 'asc' : 'desc' })}>
          {label} <span aria-hidden>{on ? (state.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
        </button>
      </th>
    );
  };
  const canEdit = (r: RequestListItem) => r.createdByMe && ((r.status === 'DRAFT' && (app.can('CREATE') || app.can('EDIT'))) || (r.status === 'RETURNED' && app.can('EDIT')));

  return (
    <>
      <Heading
        title="الطلبات الإدارية"
        description="طلبات المرافق والخدمات الإدارية ضمن صلاحياتك. الطلب لا يحجز المرفق إلا بعد اعتماده."
        actions={
          <>
            <button className="button" onClick={exportCsv} disabled={!app.can('EXPORT') || exporting} title={app.can('EXPORT') ? 'يصدّر كل طلبات الحالة المختارة ضمن نطاقك، ولا يطبّق بقية الفلاتر' : 'لا تملك صلاحية التصدير'}>
              <Icon name="download" />
              تصدير
            </button>
            <button className="button primary" onClick={() => app.openWizard({ origin: 'LIST' })} disabled={!app.can('CREATE')} title={app.can('CREATE') ? undefined : 'لا تملك صلاحية إنشاء طلب'}>
              ＋ طلب جديد
            </button>
          </>
        }
      />
      <div className="card">
        <div className="rq-tabs" role="tablist" aria-label="حالة الطلب">
          <button role="tab" className="rq-tab" aria-selected={state.status === 'all'} onClick={() => change({ status: 'all' })}>
            الكل <b>{num(allCount)}</b>
          </button>
          {TAB_ORDER.map((k) => (
            <button key={k} role="tab" className="rq-tab" aria-selected={state.status === k} onClick={() => change({ status: k })} data-status={k}>
              {SHORT[k] ?? STATUS[k][0]} <b>{num(counts[k] ?? 0)}</b>
            </button>
          ))}
        </div>
        <div className="rq-filters">
          <label className="rq-search">
            بحث
            <input placeholder="رقم الطلب أو الموضوع أو النوع…" value={state.q} aria-label="بحث الطلبات" onChange={(e) => change({ q: e.target.value })} />
          </label>
          <label>
            النوع
            <select value={state.type} onChange={(e) => change({ type: e.target.value })}>
              <option value="">كل الأنواع</option>
              {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          </label>
          <label>
            الفترة من
            <input type="date" value={state.from} max={state.to || undefined} onChange={(e) => change({ from: e.target.value })} />
          </label>
          <label>
            إلى
            <input type="date" value={state.to} min={state.from || undefined} onChange={(e) => change({ to: e.target.value })} />
          </label>
          <label className="rq-mine">
            <input type="checkbox" checked={state.mine} onChange={(e) => change({ mine: e.target.checked })} /> طلباتي فقط
          </label>
          {activeFilters(state) > 0 && (
            <button className="button compact" onClick={() => change({ q: '', type: '', from: '', to: '', mine: false })}>مسح الفلاتر</button>
          )}
        </div>
        {error && (
          <div className="note red">
            تعذّر تحميل الطلبات: {error}{' '}
            <button className="link-button" onClick={() => setRetry((n) => n + 1)}>إعادة المحاولة</button>
          </div>
        )}
        <div className="rq-table-wrap" aria-busy={loading}>
          {items !== null && !items.length ? (
            <div className="rq-empty">
              {filtered ? 'لا توجد طلبات تطابق هذا الاختيار.' : 'لا توجد طلبات بعد.'}
              {filtered && (
                <div>
                  <button className="button compact" onClick={() => change({ status: 'all', q: '', type: '', from: '', to: '', mine: false })}>عرض كل الطلبات</button>
                </div>
              )}
            </div>
          ) : (
            <table className="rq-table">
              <thead>
                <tr>
                  {sortHead('number', 'رقم الطلب')}
                  <th>الموضوع والنوع</th>
                  <th>المرافق</th>
                  <th>الجهة</th>
                  {sortHead('period', 'الفترة')}
                  <th>الحالة</th>
                  {sortHead('updated', 'آخر تحديث')}
                  <th>الإجراء</th>
                </tr>
              </thead>
              <tbody>
                {items === null ? (
                  <tr><td colSpan={8} className="rq-empty">جارٍ التحميل…</td></tr>
                ) : (
                  items.map((r) => (
                    <tr key={r.id} onClick={() => show(r)}>
                      <td><button className="link-button latin" onClick={(e) => (e.stopPropagation(), show(r))}>{r.number}</button></td>
                      <td>
                        <span className="rq-subject" title={r.subject}>{r.subject}</span>
                        <span className="rq-sub">{r.type.name}</span>
                      </td>
                      <td title={r.resources.map((x) => x.name).join('، ')}>
                        {r.resources.length ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                            <span className="rq-clip">{r.resources[0].name}</span>
                            {r.resources.length > 1 && <span className="rq-more">+{r.resources.length - 1}</span>}
                          </span>
                        ) : '—'}
                      </td>
                      <td><span className="rq-clip">{r.view === 'SUMMARY' || !r.ownerOrg ? 'مقيد' : r.ownerOrg.name}</span></td>
                      <td>
                        {fullDate(r.period.start)}
                        <span className="rq-sub">{r.period.end ? fullDate(r.period.end) : 'دائم'}</span>
                      </td>
                      <td><StatusPill status={r.status} /></td>
                      <td title={fullDate(r.updatedAt)}>{sinceText(r.updatedAt)}</td>
                      <td>
                        {canEdit(r) ? (
                          <button className="button compact" onClick={(e) => (e.stopPropagation(), app.openWizard({ origin: 'LIST', requestId: r.id }))}>تعديل وإرسال</button>
                        ) : (
                          <button className="button compact" onClick={(e) => (e.stopPropagation(), show(r))}>تفاصيل</button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
        <div className="rq-pager">
          <span data-testid="requests-range">{total ? `${num(info.first)}–${num(info.last)} من ${num(total)} طلب` : '0 طلب'}</span>
          <nav aria-label="صفحات الطلبات">
            <button disabled={state.page === 0} aria-label="الصفحة السابقة" onClick={() => setState((s) => ({ ...s, page: s.page - 1 }))}>‹</button>
            {info.near.map((p, i) => (
              <Fragment key={p}>
                {i > 0 && p - info.near[i - 1] > 1 && <span>…</span>}
                <button aria-current={p === state.page ? 'page' : undefined} onClick={() => setState((s) => ({ ...s, page: p }))}>{num(p + 1)}</button>
              </Fragment>
            ))}
            <button disabled={state.page >= info.pages - 1} aria-label="الصفحة التالية" onClick={() => setState((s) => ({ ...s, page: s.page + 1 }))}>›</button>
          </nav>
          <label>
            في الصفحة
            <select value={state.size} onChange={(e) => change({ size: Number(e.target.value) })}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
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
