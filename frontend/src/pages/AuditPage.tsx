import { useEffect, useState } from 'react';
import { api, newIdempotencyKey, urls } from '../api/client';
import type { AuditEvent, Kpis, Page } from '../api/types';
import { Heading, Icon, Stat, download } from '../components/ui';
import { useApp } from '../lib/app';
import { addDays, dubaiISO, fullDate, fullTime, todayDubai } from '../lib/dates';

const PAGE_SIZE = 50;
const hours = (h: number) => (Number.isFinite(h) ? h.toFixed(1) : '—');

function Kpi({ kpis, from, to }: { kpis: Kpis | null; from: string; to: string }) {
  if (!kpis) return <div className="empty">جارٍ حساب المؤشرات…</div>;
  const d = kpis.definitions;
  return (
    <>
      <div className="stats">
        <Stat value={hours(kpis.reviewTime.avgHours)} label="متوسط زمن المراجعة (ساعة)" icon="clock" />
        <Stat value={hours(kpis.reviewTime.p95Hours)} label="زمن المراجعة P95 (ساعة)" icon="clock" />
        <Stat value={kpis.overdueReview.count} label="مهام مراجعة متأخرة" icon="bell" />
        <Stat value={kpis.overdueExecution.count} label="مهام تنفيذ متأخرة" icon="check" />
      </div>
      <div className="settings-grid" style={{ marginBottom: 18 }}>
        <section className="card padding">
          <h3>زمن المراجعة حسب المرحلة</h3>
          <p className="micro muted" style={{ margin: '8px 0' }}>
            {d.reviewTime ?? ''} · {fullDate(dubaiISO(from))} — {fullDate(dubaiISO(to))} · {kpis.reviewTime.count} قرار · الوسيط {hours(kpis.reviewTime.p50Hours)} ساعة
          </p>
          {kpis.reviewTime.byStage.map((s) => (
            <div className="key-value" key={s.stageName}>
              <span>{s.stageName}</span>
              <b>
                {hours(s.avgHours)} ساعة · {s.count}
              </b>
            </div>
          ))}
          {!kpis.reviewTime.byStage.length && <p className="micro muted">لا توجد قرارات في الفترة.</p>}
        </section>
        <section className="card padding">
          <h3>أسباب الإرجاع</h3>
          <p className="micro muted" style={{ margin: '8px 0' }}>{d.returnReasons ?? ''}</p>
          {kpis.returnReasons.map((r) => (
            <div className="key-value" key={r.code}>
              <span>{r.label}</span>
              <b>{r.count}</b>
            </div>
          ))}
          {!kpis.returnReasons.length && <p className="micro muted">لا توجد إرجاعات في الفترة.</p>}
        </section>
        <section className="card padding">
          <h3>الإشغال</h3>
          <p className="micro muted" style={{ margin: '8px 0' }}>{d.occupancy ?? ''}</p>
          {kpis.occupancy.map((o) => (
            <div className="key-value" key={o.resourceId}>
              <span>{o.resourceName}</span>
              <b>
                {Math.round(o.ratio * 100)}% · {Math.round(o.reservedHours)} / {Math.round(o.totalHours)} ساعة
              </b>
            </div>
          ))}
        </section>
        <section className="card padding">
          <h3>مهام التنفيذ المتأخرة</h3>
          <p className="micro muted" style={{ margin: '8px 0' }}>{d.overdueExecution ?? ''}</p>
          {kpis.overdueExecution.items.map((x) => (
            <div className="key-value" key={x.id}>
              <span>
                {x.name} <span className="latin tiny">{x.requestNumber}</span>
              </span>
              <b>{fullTime(x.dueAt)}</b>
            </div>
          ))}
          {!kpis.overdueExecution.items.length && <p className="micro muted">لا توجد مهام متأخرة.</p>}
          {d.overdueReview && <p className="micro muted" style={{ marginTop: 10 }}>{d.overdueReview}</p>}
        </section>
      </div>
    </>
  );
}

export function AuditPage() {
  const app = useApp();
  const [page, setPage] = useState(0);
  const [events, setEvents] = useState<Page<AuditEvent> | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [from, setFrom] = useState(() => addDays(todayDubai(), -30));
  const [to, setTo] = useState(() => addDays(todayDubai(), 31));
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api.auditEvents(page, PAGE_SIZE).then(setEvents).catch((e: Error) => app.toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, app.revision]);

  useEffect(() => {
    setKpis(null);
    api
      .kpis(dubaiISO(from), dubaiISO(to))
      .then(setKpis)
      .catch(() => setKpis(null));
  }, [from, to, app.revision]);

  const exportRequests = async () => {
    setExporting(true);
    try {
      const job = await api.createExport(undefined, newIdempotencyKey());
      window.location.href = urls.exportContent(job.id);
      app.toast('تم إنشاء ملف التصدير (' + job.rowCount + ' طلب ضمن نطاقك)');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const pages = events ? Math.max(1, Math.ceil(events.total / PAGE_SIZE)) : 1;

  return (
    <>
      <Heading
        en="AUDIT / ADMINISTRATIVE RECORD"
        title="سجل الإجراءات"
        description="تغييرات الطلبات والموافقات والإعدادات كما سجلها الخادم، مع مؤشرات الأداء الإداري."
        actions={
          <>
            <button className="button" disabled={!app.can('EXPORT') || exporting} onClick={exportRequests}>
              <Icon name="download" />
              تصدير الطلبات
            </button>
            <button className="button" disabled={!events} onClick={() => events && download('mover-audit-page-' + (page + 1) + '.json', JSON.stringify(events.items, null, 2))}>
              <Icon name="download" />
              تصدير الصفحة
            </button>
          </>
        }
      />
      <div className="card filterbar">
        <label>
          من
          <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label>
          إلى
          <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        <span className="grow" />
        <span className="micro muted">المؤشرات محسوبة ضمن نطاق صلاحياتك فقط</span>
      </div>
      <Kpi kpis={kpis} from={from} to={to} />
      <section className="card">
        <div className="column-heading flex spread">
          <h3>سجل التدقيق</h3>
          <span className="micro muted">{events ? events.total + ' حدث' : ''}</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>الوقت</th>
                <th>الإجراء</th>
                <th>الفاعل والصفة</th>
                <th>السجل</th>
                <th>التفصيل</th>
              </tr>
            </thead>
            <tbody>
              {(events?.items ?? []).map((a) => (
                <tr key={a.id}>
                  <td>{fullTime(a.at)}</td>
                  <td>{a.actionLabel || a.action}</td>
                  <td>
                    {a.actor ? (
                      <>
                        {a.actor.name}
                        <br />
                        <span className="micro muted">
                          {a.actor.role}
                          {a.actor.org ? ' · ' + a.actor.org : ''}
                        </span>
                      </>
                    ) : (
                      'النظام'
                    )}
                  </td>
                  <td>
                    {a.entityLabel || a.entityType}
                    <br />
                    <span className="latin tiny muted">{a.entityType}</span>
                  </td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 400 }}>
                    {a.detail}
                    {a.reason ? ' — ' + a.reason : ''}
                  </td>
                </tr>
              ))}
              {events && !events.items.length && (
                <tr>
                  <td colSpan={5} className="empty">
                    لا توجد أحداث
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="legend-note flex spread">
          <span>السجل للقراءة فقط؛ لا توجد واجهة لتعديل الأحداث أو حذفها.</span>
          <span className="flex" style={{ gap: 8 }}>
            <button className="button compact" disabled={page === 0} onClick={() => setPage(page - 1)}>
              السابق
            </button>
            <span className="micro muted">
              {page + 1} / {pages}
            </span>
            <button className="button compact" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
              التالي
            </button>
          </span>
        </div>
      </section>
    </>
  );
}
