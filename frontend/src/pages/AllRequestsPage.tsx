import { useEffect, useState } from 'react';
import { api, type OverviewItem } from '../api/client';
import { Heading, Icon } from '../components/ui';
import { StatePill } from '../components/workspace/StatePill';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { PURPOSE_TITLE, isPurpose } from '../lib/requestPurpose';
import { EXCEEDS_CHIP } from '../lib/workspace';
import { rememberReturn } from '../lib/returnContext';

const FILTERS: [string, string][] = [
  ['ALL', 'الكل'],
  ['ACCESS', 'طلبات الصلاحيات'],
  ['SITE', 'اعتماد المواقع'],
  ['DEPLOYMENT', 'مناطق الانتشار'],
  ['RESTATIONING', 'إعادة التمركز'],
  ['MY_TURN', 'بانتظار قراري'],
  ['UNIT_OPERATIONS', 'بانتظار عمليات الوحدة'],
  ['FINAL', 'بانتظار الاعتماد النهائي'],
  ['FYI', 'للعلم'],
];

/**
 * «الطلبات» master/detail (owner UX consolidation §10–§13, 20 Nov 2026): one workspace. The left column is the queue (tabs =
 * capabilities; a row-click only SELECTS the request); the right column shows the selected request's context with a single
 * «فتح في مساحة التمركز» action. The server filters and scopes; this page never navigates on an ordinary list click.
 */
export function AllRequestsPage() {
  const app = useApp();
  const [filter, setFilter] = useState('ALL');
  const [items, setItems] = useState<OverviewItem[] | null>(null);
  const [selected, setSelected] = useState<OverviewItem | null>(null);
  useEffect(() => {
    setItems(null);
    setSelected(null);
    api.requestOverview(filter).then(setItems).catch((e: Error) => (setItems([]), app.toast(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, app.revision]);
  const openInShell = (i: OverviewItem) => {
    rememberReturn('#allRequests');
    location.hash = i.type === 'ACCESS' ? (i.mine ? 'requestAccess' : 'accessInbox') : 'restationing/' + i.id;
  };
  return (
    <section data-testid="all-requests">
      <Heading title="الطلبات" description="اختيار طلب في القائمة يحدّث تفاصيله بجانبها، دون مغادرة الصفحة." />
      <div className="tz-filters" role="group" aria-label="تصفية الطلبات" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} data-filter={k} className={'tz-filter' + (filter === k ? ' active' : '')} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      {items == null && <div className="empty">جارٍ التحميل…</div>}
      {items?.length === 0 && <div className="empty">لا توجد طلبات هنا.</div>}
      {!!items?.length && (
        <div className="tz-requests-split">
          <div className="card padding tz-requests-list">
            <table className="table" data-testid="overview-list">
              <thead><tr><th>الرقم</th><th>النوع</th><th>الوحدة</th><th>الحالة</th><th>المرحلة</th><th>آخر تحديث</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr
                    key={i.type + i.id + (i.mine ? 'm' : 't')}
                    data-type={i.type}
                    data-my-turn={!!i.myTurn}
                    data-testid={selected && selected.id === i.id ? 'selected-request' : undefined}
                    className={'clickable' + (selected && selected.id === i.id ? ' is-selected' : '')}
                    onClick={() => setSelected(i)}
                  >
                    <td><b>{i.number}</b></td>
                    <td>{i.type === 'ACCESS' ? 'طلب صلاحية' : isPurpose(i.type) ? PURPOSE_TITLE[i.type] : i.type}</td>
                    <td>{i.requestingUnit?.name ?? '—'}{i.person ? ' · ' + i.person : ''}</td>
                    <td>{i.stateLabel ?? <StatePill state={i.state as never} />}</td>
                    <td>{i.currentStage ?? '—'}{i.myTurn ? ' — بانتظارك' : ''}{i.exceedsPolicy && <> <span className="pill orange" data-exceeds>{EXCEEDS_CHIP}</span></>}</td>
                    <td>{i.updatedAt ? fullDate(i.updatedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="card padding tz-requests-detail" data-testid="request-detail" aria-label="تفاصيل الطلب المختار">
            {!selected && <p className="muted">اختر طلباً من القائمة لعرض تفاصيله هنا.</p>}
            {selected && (
              <>
                <h3 style={{ marginTop: 0 }}>{selected.number}</h3>
                <dl className="access-identity">
                  <div><dt className="muted">النوع</dt><dd>{selected.type === 'ACCESS' ? 'طلب صلاحية' : isPurpose(selected.type) ? PURPOSE_TITLE[selected.type] : selected.type}</dd></div>
                  <div><dt className="muted">الوحدة</dt><dd>{selected.requestingUnit?.name ?? '—'}</dd></div>
                  {selected.person && <div><dt className="muted">الشخص</dt><dd>{selected.person}</dd></div>}
                  <div><dt className="muted">الحالة</dt><dd>{selected.stateLabel ?? selected.state}</dd></div>
                  {selected.currentStage && <div><dt className="muted">المرحلة</dt><dd>{selected.currentStage}</dd></div>}
                  {selected.updatedAt && <div><dt className="muted">آخر تحديث</dt><dd>{fullDate(selected.updatedAt)}</dd></div>}
                </dl>
                <div className="flex" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button type="button" className="button primary" data-testid="open-in-shell" onClick={() => openInShell(selected)}>
                    <Icon name="map" /> فتح في مساحة التمركز
                  </button>
                </div>
                {(selected.myTurn || selected.exceedsPolicy) && (
                  <p className="note orange" style={{ marginTop: 10 }}>
                    {selected.myTurn && 'بانتظار قرارك. '}
                    {selected.exceedsPolicy && EXCEEDS_CHIP + '. '}
                  </p>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
