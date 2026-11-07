import { PURPOSE_TITLE, isPurpose } from '../../lib/requestPurpose';
import { useMemo, useState } from 'react';
import type { RestationingListItem, RestationingState } from '../../api/types';
import { fullDate } from '../../lib/dates';
import { Icon } from '../ui';
import { StatePill } from './StatePill';

const GROUPS: { key: string; label: string; states: RestationingState[] | null }[] = [
  { key: 'all', label: 'الكل', states: null },
  { key: 'review', label: 'قيد الاعتماد', states: ['UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED', 'CANCELLATION_PENDING', 'START_HELD_PENDING_CANCELLATION'] },
  { key: 'draft', label: 'مسودات', states: ['DRAFT'] },
  { key: 'active', label: 'مفعّلة', states: ['ACTIVATED_PERMANENT', 'ACTIVE_TEMPORARY', 'TEMPORARY_SCHEDULED', 'EXTENSION_ACTIVATED', 'APPROVED_NOT_ACTIVATED'] },
];

/**
 * The request list as a collapsible drawer (§16): number, state, requesting unit, permanent/temporary and the current
 * approval stage. Choosing a request updates the same workspace.
 */
export function RequestDrawer({ items, selected, onSelect, open, setOpen, canCreate, onCreate }: {
  items: RestationingListItem[] | null;
  selected: string | null;
  onSelect: (id: string) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const [group, setGroup] = useState('all');
  const shown = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group);
    return (items ?? []).filter((r) => !g?.states || g.states.includes(r.state));
  }, [items, group]);
  return (
    <section className={'tz-drawer' + (open ? ' open' : '')} aria-label="طلبات إعادة التمركز">
      <div className="tz-drawer-head">
        <button className="tz-drawer-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="file" />
          <span>الطلبات</span>
          <span className="tz-chip">{items?.length ?? '…'}</span>
          <Icon name="chevron" />
        </button>
        {canCreate && <a className="button primary compact tz-new" href="#newRequest" data-create={!!onCreate}>＋ طلب جديد</a>}
      </div>
      {open && (
        <>
          <div className="tz-filters" role="group" aria-label="تصفية الطلبات">
            {GROUPS.map((g) => (
              <button key={g.key} className={'tz-filter' + (group === g.key ? ' active' : '')} aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
                {g.label}
              </button>
            ))}
          </div>
          <div className="rs-list">
            {items == null && <div className="tz-muted tz-pad">جارٍ التحميل…</div>}
            {items?.length === 0 && <div className="tz-muted tz-pad">لا توجد طلبات ضمن نطاقك.</div>}
            {shown.map((r) => (
              <button key={r.id} className={'rs-item' + (r.id === selected ? ' active' : '')} aria-current={r.id === selected} onClick={() => onSelect(r.id)}>
                <span className="rs-item-head">
                  <b>{r.number}</b>
                  {r.purpose && r.purpose !== 'RESTATIONING' && isPurpose(r.purpose) && <small className="tz-code">{PURPOSE_TITLE[r.purpose]}</small>}
                  <StatePill state={r.state} />
                </span>
                <span>
                  {r.requestingUnit.name} · {r.kind === 'TEMPORARY' ? 'مؤقت' : r.kind === 'EXTENSION' ? 'تمديد' : 'دائم'} · {r.units} وحدة
                </span>
                {r.currentStage && (
                  <small>
                    المرحلة الحالية: {r.currentStage}
                    {r.currentStageUnit ? ' · ' + r.currentStageUnit : ''}
                  </small>
                )}
                <small>
                  {r.requester.name}
                  {r.mine ? ' (أنت)' : ''} · {fullDate(r.updatedAt)}
                </small>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
