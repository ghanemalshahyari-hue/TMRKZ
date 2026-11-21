import { useEffect, useMemo, useState } from 'react';
import { api, type AccessMine, type AccessScope, type OverviewItem, type ScopeMode } from '../api/client';
import { SCOPE_MODES, scopesFor } from '../lib/accessScopes';
import { identityCard, UNIT_NOT_CONFIGURED } from '../lib/identityCard';
import { hrState, unitTrail } from '../lib/hrState';
import { flatSource, withParents } from '../components/tree/tree';
import { UnitTree } from '../components/tree/UnitTree';
import { MyPermits } from '../components/access/AccessAdmin';
import { KeyValue, Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';

/** What each current role means, in plain words. */
export const ROLE_MEANING: Record<string, string> = {
  STATIONING_REQUESTER: 'مقدم الطلب: يقدّم طلبات التمركز لوحدته — إعادة التمركز ومناطق الانتشار واعتماد المواقع — ويتابعها.',
  CHAIN_APPROVER: 'يوافق على طلبات وحدته عندما تصل إليها وهي تصعد في المستويات.',
  UNIT_OPERATIONS_APPROVER: 'يعتمد طلبات الوحدات المعيّنة له بعد انتهاء المستويات، ويدير مرافقها وروابط وحداتها بالمواقع.',
  FINAL_APPROVER: 'يعطي الموافقة النهائية على الطلبات في نطاقه، ويقرر فيها ما يتجاوز المسموح وإلغاءها وعودتها المبكرة.',
  FYI_DISTRIBUTOR: 'يحدد الوحدات التي تعلم بالطلب بعد الاعتماد النهائي.',
  FYI_RECEIVER: 'يطّلع على الطلبات بعد اعتمادها النهائي، بدون قرار.',
  STATIONING_ACTIVATOR: 'يفعّل التمركز بعد اعتماده.',
  POSTURE_VIEWER: 'يتابع على الخريطة تمركز وحدته وما يتبعها ومناطق انتشارها، عرضاً فقط.',
  SITE_ADMINISTRATOR: 'يدير سجل المواقع وحدودها.',
};

const STATUS: Record<string, string> = { SUBMITTED: 'قيد المراجعة', APPROVED: 'فُعّلت', REJECTED: 'رُفض', RETURNED: 'أُعيد' };

/** The scope choices (ADR-045). The whole system is never offered here: it is not a default, and it cannot be asked for. */
export function ScopeChoice({ scope, setScope, units, sites, allowed, current }: { scope: AccessScope; setScope: (s: AccessScope) => void; units: { id: string; name: string; depth?: number }[]; sites: { id: string; name: string }[]; allowed?: ScopeMode[]; current?: string | null }) {
  const toggle = (id: string) => setScope({ ...scope, ids: scope.ids.includes(id) ? scope.ids.filter((x) => x !== id) : [...scope.ids, id] });
  // the one units tree of the application (owner, 16 Nov 2026)
  const tree = useMemo(() => flatSource(withParents(units)), [units]);
  // ADR-094: the tree begins at the person's main unit; their own unit is highlighted and brought into view
  const trail = useMemo(() => unitTrail(units, current ?? null), [units, current]);
  const ticked = useMemo(() => new Set(scope.ids), [scope.ids]);
  return (
    <fieldset className="access-scope" data-testid="access-scope">
      <legend>النطاق</legend>
      {SCOPE_MODES.filter(([m]) => !allowed || allowed.includes(m)).map(([m, label]) => (
        <label key={m} className="check-label" style={{ marginInlineEnd: 12 }}>
          <input type="radio" name="scope" data-scope={m} checked={scope.mode === m} disabled={m === 'SITES' && !sites.length} onChange={() => setScope({ mode: m, ids: [] })} /> {label}
        </label>
      ))}
      {scope.mode === 'UNITS' && (
        <UnitTree source={tree} label="الوحدات المطلوبة" searchLabel="بحث في الوحدات" checked={ticked} onCheck={(u) => toggle(u.id)}
          initialOpen={units.length <= 80 ? units.map((u) => u.id) : []} openSingleRoot selected={current ?? null} reveal={current ?? null} trail={trail}
          rowClass={(u) => (u.id === current ? 'ut-current' : undefined)} />
      )}
      {scope.mode === 'SITES' && sites.map((u) => (
        <label key={u.id} className="check-label" style={{ display: 'block' }}><input type="checkbox" checked={scope.ids.includes(u.id)} onChange={() => toggle(u.id)} /> {u.name}</label>
      ))}
    </fieldset>
  );
}

/**
 * Who signed in and where their asking stands (owner, 16 Nov 2026: LDAP first login, zero access), from the one employment
 * context (ADR-068): Oracle while it is in force, the directory before. A unit TMRKZ does not hold is shown as received.
 */
function IdentityCard({ who, overall }: { who: NonNullable<AccessMine['identity']>; overall?: AccessMine['overall'] }) {
  const { rows, notice } = identityCard(who);
  return (
    <div className="card padding" data-testid="access-identity" data-source={who.sourceCode} style={{ marginBottom: 12 }}>
      {overall && <p data-testid="access-overall" data-code={overall.code} style={{ margin: '0 0 8px', fontWeight: 700 }}>{overall.text}</p>}
      {notice && <p className="error-text" data-testid="access-unit-not-configured" style={{ margin: '0 0 8px' }}>{notice}</p>}
      <dl className="access-identity">
        {rows.map(([k, v]) => (
          <div key={k}><dt className="muted">{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </div>
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
  // ADR-094: the person asks HR for their own record now; HR not answering changes nothing
  const refreshHr = async () => {
    setBusy(true);
    try {
      const r = await api.myHrRefresh();
      app.toast(r.refreshed ? 'حُدّثت بياناتك من الموارد البشرية' : 'لم تُجب الموارد البشرية الآن؛ تبقى بياناتك كما هي');
      await app.refreshMe();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const [fyi, setFyi] = useState<OverviewItem[]>([]);
  const load = () => {
    // a person with no permission sees no request «للعلم» (owner, 16 Nov 2026); the server refuses it too
    if (!none) api.requestOverview('FYI').then(setFyi).catch(() => setFyi([]));
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

  // ADR-094: admitted from the directory before HR confirmed them; their HR record is matched on a later sign-in or lookup
  const pendingHr = app.me.hrMatch === 'PENDING';
  const open = mine?.requests.some((r) => r.status === 'SUBMITTED');
  const returned = mine?.requests.find((r) => r.status === 'RETURNED') ?? null;
  const offered = mine?.requestable.filter((r) => !mine.held.includes(r.code)) ?? [];
  // the scopes the chosen roles allow (set by the system administrator); a choice they no longer allow moves to their default
  const allowedScopes = useMemo(() => scopesFor(offered.filter((r) => roles.includes(r.code))), [offered, roles]);
  useEffect(() => {
    if (allowedScopes.start && !allowedScopes.modes.includes(scope.mode as ScopeMode)) setScope({ mode: allowedScopes.start, ids: [] });
  }, [allowedScopes, scope.mode]);
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
      {none && (
        <section className="card padding" data-testid="my-details" style={{ marginBottom: 12 }}>
          <h2>بياناتي</h2>
          <KeyValue k="الاسم" v={app.me.displayName} />
          <KeyValue k="اسم المستخدم" v={app.me.username} />
          <KeyValue k="الرقم" v={app.me.employeeNo ?? '—'} />
          <KeyValue k="الوحدة" v={mine?.unit ?? '—'} />
          <KeyValue k="سجل الموارد البشرية" v={hrState(app.me)} />
          {app.me.hrMatch === 'MATCHED' && (
            <div className="flex" style={{ gap: 10, marginTop: 8 }}>
              <button className="button" data-testid="hr-refresh-me" disabled={busy} onClick={refreshHr}>تحديث بياناتي من الموارد البشرية</button>
            </div>
          )}
        </section>
      )}
      {pendingHr && (
        <div className="note orange" data-testid="hr-match-pending" style={{ marginBottom: 12 }}>
          تحقق الدليل المؤسسي من هويتك ودخلت بلا صلاحيات؛ بياناتك بانتظار مطابقة الموارد البشرية وتُحدَّث عند توفرها. يمكنك طلب الصلاحية الآن.
        </div>
      )}
      <Heading title="طلب صلاحية" description={none ? 'تم التحقق من هويتك، ولا توجد لك صلاحيات بعد. اطلب ما يلزم عملك، وتُفعَّل بعد الموافقة.' : 'اطلب صلاحية إضافية يحتاجها عملك.'} />
      {mine?.identity && <IdentityCard who={mine.identity} overall={mine.overall} />}
      <MyPermits />
      {mine && !mine.available && <div className="empty" data-testid="access-unavailable">لم يُفعَّل بعد مسار طلب الصلاحيات؛ راجع مدير النظام.</div>}
      {mine?.available && (
        <div className="card padding">
          <p><b>وحدتك:</b> {mine.unit ?? (mine.identity?.unitConfigured === false ? UNIT_NOT_CONFIGURED + '؛ لا يُقدَّم طلب الصلاحية حتى تُهيأ.' : 'لا توجد لك وحدة في سجل الموارد البشرية؛ راجع مدير النظام.')}</p>
          {open ? (
            <p className="muted" data-testid="access-open">لديك طلب قيد المراجعة. يمكنك تقديم طلب جديد بعد القرار فيه.</p>
          ) : offered.length === 0 ? (
            <p className="muted">لديك كل الصلاحيات التي يمكن طلبها من هنا.</p>
          ) : (
            <>
              {returned && <p className="error-text" data-testid="access-returned">أُعيد طلبك {returned.number} للتعديل{returned.note ? ': ' + returned.note : ''}. عدّله وأرسله مرة أخرى.</p>}
              <h3 style={{ marginTop: 12 }}>الصلاحيات المتاحة للطلب</h3>
              {offered.map((r) => (
                <label key={r.code} className="check-label" style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0' }}>
                  <input type="checkbox" data-role={r.code} checked={roles.includes(r.code)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.code] : roles.filter((x) => x !== r.code))} />
                  <span><b>{r.name}</b><br /><small className="muted">{r.description || ROLE_MEANING[r.code]}</small></span>
                </label>
              ))}
              <label className="field" style={{ marginTop: 10 }}>
                <span>لماذا تحتاجها؟</span>
                <textarea aria-label="سبب الطلب" value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <ScopeChoice scope={scope} setScope={setScope} units={mine.scopeUnits ?? []} sites={mine.scopeSites ?? []} allowed={allowedScopes.modes} current={mine.identity?.unitId ?? null} />
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
