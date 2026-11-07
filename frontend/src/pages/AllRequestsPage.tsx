import { useEffect, useState } from 'react';
import { api, type OverviewItem } from '../api/client';
import { Heading } from '../components/ui';
import { StatePill } from '../components/workspace/StatePill';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { PURPOSE_TITLE, isPurpose } from '../lib/requestPurpose';

const FILTERS: [string, string][] = [
  ['ALL', 'الكل'],
  ['ACCESS', 'طلبات الصلاحيات'],
  ['SITE', 'اعتماد المواقع'],
  ['INITIAL', 'التمركز الأولي'],
  ['DEPLOYMENT', 'مناطق الانتشار'],
  ['RESTATIONING', 'إعادة التمركز'],
  ['MY_TURN', 'بانتظار قراري'],
  ['UNIT_OPERATIONS', 'بانتظار عمليات الوحدة'],
  ['FINAL', 'بانتظار الاعتماد النهائي'],
  ['FYI', 'للعلم'],
];

/** «الطلبات»: every request this person may see, each with its type (ADR-045). The server filters and scopes; a person's own request and their decisions are told apart. */
export function AllRequestsPage() {
  const app = useApp();
  const [filter, setFilter] = useState('ALL');
  const [items, setItems] = useState<OverviewItem[] | null>(null);
  useEffect(() => {
    setItems(null);
    api.requestOverview(filter).then(setItems).catch((e: Error) => (setItems([]), app.toast(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, app.revision]);
  const open = (i: OverviewItem) => {
    location.hash = i.type === 'ACCESS' ? (i.mine ? '#requestAccess' : '#accessInbox') : '#restationing/' + i.id;
  };
  return (
    <section data-testid="all-requests">
      <Heading title="الطلبات" description="كل طلب بنوعه. لا يظهر إلا ما يقع ضمن صلاحيتك." actions={<a className="button primary" href="#newRequest">＋ طلب جديد</a>} />
      <div className="tz-filters" role="group" aria-label="تصفية الطلبات" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} data-filter={k} className={'tz-filter' + (filter === k ? ' active' : '')} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      {items == null && <div className="empty">جارٍ التحميل…</div>}
      {items?.length === 0 && <div className="empty">لا توجد طلبات هنا.</div>}
      {!!items?.length && (
        <div className="card padding">
          <table className="table" data-testid="overview-list">
            <thead><tr><th>الرقم</th><th>النوع</th><th>الوحدة</th><th>الحالة</th><th>المرحلة</th><th>آخر تحديث</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.type + i.id + (i.mine ? 'm' : 't')} data-type={i.type} data-my-turn={!!i.myTurn} className="clickable" onClick={() => open(i)}>
                  <td><b>{i.number}</b></td>
                  <td>{i.type === 'ACCESS' ? 'طلب صلاحية' : isPurpose(i.type) ? PURPOSE_TITLE[i.type] : i.type}</td>
                  <td>{i.requestingUnit?.name ?? '—'}{i.person ? ' · ' + i.person : ''}</td>
                  <td>{i.stateLabel ?? <StatePill state={i.state as never} />}</td>
                  <td>{i.currentStage ?? '—'}{i.myTurn ? ' — بانتظارك' : ''}{i.fyiPending ? ' — تحديد وحدات العلم بانتظارك' : ''}{i.activatable ? ' — التفعيل بانتظارك' : ''}</td>
                  <td>{i.updatedAt ? fullDate(i.updatedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
