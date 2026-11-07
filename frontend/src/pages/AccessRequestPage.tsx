import { useEffect, useState } from 'react';
import { api, type AccessMine, type AccessScope, type OverviewItem } from '../api/client';
import { Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';

/** What each permission means, in plain words. */
export const ROLE_MEANING: Record<string, string> = {
  REQUESTER: 'يقدّم طلبات وحدته ويتابعها.',
  CHAIN_APPROVER: 'يوافق على طلبات وحدته عندما تصل إليها وهي تصعد في المستويات.',
  UNIT_OPERATIONS_APPROVER: 'يعتمد طلبات الوحدات المعيّنة له بعد انتهاء المستويات.',
  FYI_RECEIVER: 'يطّلع على الطلبات بعد اعتمادها النهائي، بدون قرار.',
  ORG_MANAGER: 'ينشئ طلبات وحدته ويراجعها ويصدّر تقاريرها.',
  FINAL_APPROVER: 'يعطي الموافقة النهائية على الطلبات في نطاقه.',
  LIMITED_VIEWER: 'يرى ملخصاً محدوداً فقط.',
  RESTATIONING_REQUESTER: 'يقدّم طلبات إعادة التمركز لوحدته.',
  STATIONING_ACTIVATOR: 'يفعّل التمركز بعد اعتماده.',
  STATIONING_LIFECYCLE_DECIDER: 'يقرر الإلغاء قبل التفعيل والإنهاء المبكر.',
  STATIONING_REGISTER_OFFICER: 'يصحّح سجل التمركز ويدير روابط المواقع.',
  POSTURE_VIEWER: 'يتابع على الخريطة تمركز وحدته وما يتبعها ومناطق انتشارها، عرضاً فقط.',
  STATIONING_REQUESTER: 'ينشئ طلبات التمركز الأولي ومناطق الانتشار وإعادة التمركز لوحدته.',
  DEPLOYMENT_REQUESTER: 'ينشئ طلبات مناطق الانتشار لوحدته.',
  SITE_REGISTRATION_REQUESTER: 'يطلب اعتماد موقع جديد.',
  SITE_ADMINISTRATOR: 'يدير سجل المواقع وحدودها.',
  SITE_LINK_MANAGER: 'يربط الوحدات بالمواقع؛ الربط ليس تمركزاً.',
  STATIONING_UNIT_APPROVER: 'يعتمد طلبات وحدته في مرحلتها من التسلسل الهرمي.',
  STATIONING_OPS_APPROVER: 'يعتمد عمليات الوحدة في طلبات نطاقه.',
  STATIONING_FINAL_APPROVER: 'يعطي الاعتماد النهائي لطلبات نطاقه.',
  FYI_DISTRIBUTOR: 'يحدد الوحدات التي تعلم بالطلب بعد الاعتماد النهائي.',
};

const STATUS: Record<string, string> = { SUBMITTED: 'قيد المراجعة', APPROVED: 'فُعّلت', REJECTED: 'رُفض', RETURNED: 'أُعيد' };

/** The scope choices (ADR-045). The whole system is never offered here: it is not a default, and it cannot be asked for. */
export function ScopeChoice({ scope, setScope, units, sites }: { scope: AccessScope; setScope: (s: AccessScope) => void; units: { id: string; name: string; depth?: number }[]; sites: { id: string; name: string }[] }) {
  const toggle = (id: string) => setScope({ ...scope, ids: scope.ids.includes(id) ? scope.ids.filter((x) => x !== id) : [...scope.ids, id] });
  return (
    <fieldset className="access-scope" data-testid="access-scope">
      <legend>النطاق</legend>
      {([['UNIT', 'وحدتي فقط'], ['UNIT_TREE', 'وحدتي والوحدات التابعة'], ['UNITS', 'وحدات محددة'], ['SITES', 'مواقع محددة']] as const).map(([m, label]) => (
        <label key={m} className="check-label" style={{ marginInlineEnd: 12 }}>
          <input type="radio" name="scope" data-scope={m} checked={scope.mode === m} disabled={m === 'SITES' && !sites.length} onChange={() => setScope({ mode: m, ids: [] })} /> {label}
        </label>
      ))}
      {scope.mode === 'UNITS' && units.map((u) => (
        <label key={u.id} className="check-label" style={{ display: 'block', paddingInlineStart: (u.depth ?? 0) * 12 }}><input type="checkbox" checked={scope.ids.includes(u.id)} onChange={() => toggle(u.id)} /> {u.name}</label>
      ))}
      {scope.mode === 'SITES' && sites.map((u) => (
        <label key={u.id} className="check-label" style={{ display: 'block' }}><input type="checkbox" checked={scope.ids.includes(u.id)} onChange={() => toggle(u.id)} /> {u.name}</label>
      ))}
    </fieldset>
  );
}

/**
 * Asking for permissions (ADR-044): the only page of a person who has none, and open to anyone asking for more. A request is not a
 * grant: a reviewer advises, and only the final approval gives anything.
 */
export function AccessRequestPage() {
  const app = useApp();
  const [mine, setMine] = useState<AccessMine | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<AccessScope>({ mode: 'UNIT', ids: [] });
  const [busy, setBusy] = useState(false);
  const none = app.me.permissions.length === 0;
  const [fyi, setFyi] = useState<OverviewItem[]>([]);
  const load = () => {
    api.requestOverview('FYI').then(setFyi).catch(() => setFyi([]));
    return api.accessMine().then(setMine).catch((e: Error) => app.toast(e.message));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  // granted since this page opened: the rest of the application opens
  useEffect(() => {
    if (none && mine && mine.held.length > 0) void app.refreshMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine?.held.length]);

  const open = mine?.requests.some((r) => r.status === 'SUBMITTED');
  const returned = mine?.requests.find((r) => r.status === 'RETURNED') ?? null;
  const offered = mine?.requestable.filter((r) => !mine.held.includes(r.code)) ?? [];
  const send = async () => {
    setBusy(true);
    try {
      if (returned) await api.resubmitAccessRequest(returned.id, { roles, reason, scope });
      else await api.submitAccessRequest({ roles, reason, scope });
      setRoles([]);
      setReason('');
      app.toast('أُرسل طلبك');
      await load();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section data-testid="access-request">
      <Heading title="طلب صلاحية" description={none ? 'دخلت البرنامج، ولا توجد لك صلاحيات بعد. اطلب ما يلزم عملك، وتُفعَّل بعد الموافقة.' : 'اطلب صلاحية إضافية يحتاجها عملك.'} />
      {mine && !mine.available && <div className="empty" data-testid="access-unavailable">لم يُفعَّل بعد مسار طلب الصلاحيات؛ راجع مدير النظام.</div>}
      {mine?.available && (
        <div className="card padding">
          <p><b>وحدتك:</b> {mine.unit ?? 'لا توجد لك وحدة في سجل الموارد البشرية؛ راجع مدير النظام.'}</p>
          {open ? (
            <p className="muted" data-testid="access-open">لديك طلب قيد المراجعة. يمكنك تقديم طلب جديد بعد القرار فيه.</p>
          ) : offered.length === 0 ? (
            <p className="muted">لديك كل الصلاحيات التي يمكن طلبها من هنا.</p>
          ) : (
            <>
              {returned && <p className="error-text" data-testid="access-returned">أُعيد طلبك {returned.number} للتعديل{returned.note ? ': ' + returned.note : ''}. عدّله وأرسله مرة أخرى.</p>}
              <h3 style={{ marginTop: 12 }}>الصلاحيات المطلوبة</h3>
              {offered.map((r) => (
                <label key={r.code} className="check-label" style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0' }}>
                  <input type="checkbox" data-role={r.code} checked={roles.includes(r.code)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.code] : roles.filter((x) => x !== r.code))} />
                  <span><b>{r.name}</b><br /><small className="muted">{ROLE_MEANING[r.code]}</small></span>
                </label>
              ))}
              <label className="field" style={{ marginTop: 10 }}>
                <span>لماذا تحتاجها؟</span>
                <textarea aria-label="سبب الطلب" value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <ScopeChoice scope={scope} setScope={setScope} units={mine.scopeUnits ?? []} sites={mine.scopeSites ?? []} />
              <button className="button primary" disabled={busy || !roles.length || reason.trim().length < 5 || !mine.unit || (['UNITS', 'SITES'].includes(scope.mode) && !scope.ids.length)} onClick={send}>{returned ? 'إعادة إرسال الطلب' : 'إرسال طلب الصلاحية'}</button>
            </>
          )}
        </div>
      )}
      {fyi.length > 0 && (
        <div className="card padding" style={{ marginBottom: 14 }} data-testid="fyi-list">
          <h3>طلبات للعلم</h3>
          <p className="micro muted">وصلتك للاطلاع فقط، ولا تمنحك صلاحية على غيرها.</p>
          <ul className="test-list">
            {fyi.map((i) => <li key={i.id}><a href={'#restationing/' + i.id}>{i.number}</a> · {i.requestingUnit?.name}</li>)}
          </ul>
        </div>
      )}
      {!!mine?.requests.length && (
        <div className="card padding" style={{ marginTop: 14 }}>
          <h3>طلباتي</h3>
          <ul className="test-list" data-testid="access-mine">
            {mine.requests.map((r) => (
              <li key={r.id}>
                <b data-testid="access-status">{r.statusLabel ?? STATUS[r.status] ?? r.status}</b> · {fullDate(r.submittedAt)} · {r.requested.map((x) => x.name).join('، ')}
                {r.waiting && <div className="micro muted">عند: {r.waiting}</div>}
                {r.status === 'APPROVED' && <div className="micro">فُعّل: {r.granted.map((x) => x.name).join('، ') || 'لا شيء جديد'}</div>}
                {r.status === 'REJECTED' && r.note && <div className="micro">السبب: {r.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
