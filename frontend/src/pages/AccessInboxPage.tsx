import { useEffect, useState } from 'react';
import { api, type AccessInboxItem, type AccessScope } from '../api/client';
import { Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { ROLE_MEANING, ScopeChoice } from './AccessRequestPage';

const SCOPE_WORD: Record<string, string> = { UNIT: 'وحدتي فقط', UNIT_TREE: 'وحدتي والوحدات التابعة', UNITS: 'وحدات محددة', SITES: 'مواقع محددة', ALL: 'النظام بالكامل' };

function Item({ item, onDone }: { item: AccessInboxItem; onDone: () => void }) {
  const app = useApp();
  const [roles, setRoles] = useState<string[]>((item.recommended ?? item.requested).map((r) => r.code));
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<AccessScope>(item.proposedScope ?? item.scope ?? { mode: 'UNIT', ids: [] });
  const [advice, setAdvice] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [busy, setBusy] = useState(false);
  const act = async (decision: 'APPROVE' | 'REJECT' | 'RETURN') => {
    setBusy(true);
    try {
      await api.decideAccessRequest(item.requestId, { taskId: item.taskId, decision, roles, note: note || undefined, scope, recommendReject: !item.final && advice === 'REJECT' });
      app.toast(decision === 'REJECT' ? 'رُفض الطلب' : decision === 'RETURN' ? 'أُعيد الطلب للتعديل' : item.final ? 'فُعّلت الصلاحيات' : 'أُرسلت التوصية');
      onDone();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="card padding" data-testid="access-item" data-final={item.final} style={{ marginBottom: 14 }}>
      <div className="flex spread">
        <h3>{item.person} <span className="latin tiny muted">{item.employeeNo}</span></h3>
        <span className="pill">{item.stage}</span>
      </div>
      <p className="micro muted">{item.unit} · {fullDate(item.submittedAt)} · {item.number}</p>
      {item.movedTo && <p className="error-text">نُقل إلى «{item.movedTo}» بعد تقديم الطلب؛ يُرفض ليقدّم طلباً جديداً لوحدته الجديدة.</p>}
      <p><b>السبب:</b> {item.reason}</p>
      <p className="micro"><b>طلب:</b> {item.requested.map((r) => r.name).join('، ')}</p>
      <p className="micro" data-testid="access-scope-asked"><b>النطاق المطلوب:</b> {item.scope ? SCOPE_WORD[item.scope.mode] : 'النطاق الافتراضي للدور'}{item.scopeNames?.length ? ' — ' + item.scopeNames.join('، ') : ''}</p>
      {item.final && <p className="micro" data-testid="access-person"><b>الشخص الآن:</b> {item.personActive ? 'نشط في الموارد البشرية' : 'غير نشط'} · {item.movedTo ? 'نُقل' : 'في وحدته نفسها'}</p>}
      {item.final && (
        <p className="micro" data-testid="access-advice">
          <b>توصية المراجع:</b> {item.recommended ? item.recommended.map((r) => r.name).join('، ') + ' — ' + item.reviewedBy : 'تم التجاوز تلقائياً: لا يوجد مراجع مؤهل لهذه الوحدة'}
        </p>
      )}
      {item.final && item.recommendReject && <p className="error-text" data-testid="access-advice-reject">موصى بالرفض{item.reviewNote ? ': ' + item.reviewNote : ''}</p>}
      {!item.final && (
        <fieldset data-testid="access-advice-choice">
          <legend>توصيتك</legend>
          <label className="check-label" style={{ marginInlineEnd: 12 }}><input type="radio" name={'adv' + item.taskId} checked={advice === 'APPROVE'} onChange={() => setAdvice('APPROVE')} /> موافقة</label>
          <label className="check-label"><input type="radio" name={'adv' + item.taskId} data-advice="REJECT" checked={advice === 'REJECT'} onChange={() => setAdvice('REJECT')} /> رفض</label>
        </fieldset>
      )}
      <h4>{item.final ? 'ما يُفعَّل' : 'ما توصي به'}</h4>
      {item.offered.map((r) => (
        <label key={r.code} className="check-label" style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }}>
          <input type="checkbox" data-role={r.code} checked={roles.includes(r.code)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.code] : roles.filter((x) => x !== r.code))} />
          <span><b>{r.name}</b> <small className="muted">{ROLE_MEANING[r.code]}</small></span>
        </label>
      ))}
      {item.extras.length > 0 && (
        <div data-testid="access-extras">
          <h4>صلاحيات إضافية</h4>
          <p className="micro muted">لا تظهر لمقدم الطلب. تضيفها أنت إذا احتاجها عمله.</p>
          {item.extras.map((r) => (
            <label key={r.code} className="check-label" style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }}>
              <input type="checkbox" data-role={r.code} checked={roles.includes(r.code)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.code] : roles.filter((x) => x !== r.code))} />
              <span><b>{r.name}</b> <small className="muted">{ROLE_MEANING[r.code]}</small></span>
            </label>
          ))}
        </div>
      )}
      <ScopeChoice scope={scope} setScope={setScope} units={item.scopeUnits ?? []} sites={item.scopeSites ?? []} />
      <label className="field">
        <span>ملاحظة (مطلوبة عند الرفض أو الإرجاع)</span>
        <textarea aria-label="ملاحظة" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="flex" style={{ gap: 8 }}>
        <button className="button primary" disabled={busy || (!roles.length && advice === 'APPROVE') || (!item.final && advice === 'REJECT' && note.trim().length < 5)} onClick={() => act('APPROVE')}>{item.final ? 'اعتماد وتفعيل' : 'إرسال التوصية'}</button>
        <button className="button" disabled={busy || note.trim().length < 5} onClick={() => act('RETURN')}>إرجاع للتعديل</button>
        <button className="button danger" disabled={busy || note.trim().length < 5} onClick={() => act('REJECT')}>رفض</button>
      </div>
    </article>
  );
}

/** The permission requests waiting for this person (ADR-044): a reviewer advises, the final approver grants. */
export function AccessInboxPage() {
  const app = useApp();
  const [items, setItems] = useState<AccessInboxItem[] | null>(null);
  const load = () => api.accessInbox().then(setItems).catch((e: Error) => (setItems([]), app.toast(e.message)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  return (
    <section data-testid="access-inbox">
      <Heading title="طلبات الصلاحية" description="الطلبات التي تنتظر قرارك. لا يمنح المراجع شيئاً؛ الاعتماد النهائي وحده يفعّل الصلاحية." />
      {items && !items.length && <div className="empty">لا توجد طلبات تنتظرك.</div>}
      {items?.map((i) => <Item key={i.taskId} item={i} onDone={load} />)}
    </section>
  );
}
