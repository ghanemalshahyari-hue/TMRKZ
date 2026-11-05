import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { RestationingChecks, RestationingListItem, RestationingRequest } from '../api/types';
import { Icon } from '../components/ui';
import type { BasemapMode } from '../components/map/maplibre/offlineStyle';
import { ActionRail, type RailAction } from '../components/workspace/ActionRail';
import { ApprovalRouteStrip } from '../components/workspace/ApprovalRouteStrip';
import { DeploymentCheckCard } from '../components/workspace/DeploymentCheckCard';
import { MapFrame, MapLegend } from '../components/workspace/MapFrame';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { OrgContextPanel, type ContextTab } from '../components/workspace/OrgContextPanel';
import { RequestDrawer } from '../components/workspace/RequestDrawer';
import { RequestMap } from '../components/workspace/RequestMap';
import { SitesMap } from '../components/workspace/SitesMap';
import { RS_STATE, StatePill } from '../components/workspace/StatePill';
import { useRegisteredSites } from '../components/workspace/useRegisteredSites';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { formatArea } from '../lib/footprint';
import { restriction } from '../lib/navigation';
import { parseRestationingHash } from '../lib/restationingRoute';
import { partsOf, siteArea } from '../lib/siteGeometry';
import { HIERARCHY_CHANGED } from '../lib/stationingV3';
import { RestationingEditor } from './RestationingEditor';
import './restationing.css';

export { RS_STATE, StatePill, RequestMap };

/** The lifecycle actions (ADR-034) with the owner's wording. */
const ACTION_KIND: Record<string, string> = {
  PRE_ACTIVATION_CANCELLATION: 'إلغاء قبل التفعيل',
  BEFORE_START_CANCELLATION: 'إلغاء التمركز المؤقت قبل بدء نفاذه',
  EARLY_RETURN: 'عودة مبكرة',
};
const ACTION_STATE: Record<string, string> = {
  REQUESTED: 'بانتظار القرار',
  APPROVED: 'قُبل',
  REJECTED: 'رُفض',
  NO_LONGER_ACTIONABLE: 'لم يعد قابلاً للقرار',
  SUPERSEDED: 'تجاوزه انتهاء المؤقت',
};

/** The proposed site as an approver reads it: type, part count, area and, once submitted, the submission holding it. */
function proposedSite(r: RestationingRequest): string {
  const g = r.content.site?.geometry;
  if (!g) return '—';
  const parts = partsOf(g);
  const held = r.state !== 'DRAFT' && r.state !== 'RETURNED_FOR_CHANGES' ? r.revisions.at(-1)?.n : undefined;
  return [g.type === 'MultiPolygon' ? 'مضلع متعدد' : 'مضلع', parts.length === 1 ? 'جزء واحد' : `${parts.length} أجزاء`,
    formatArea(siteArea(parts)), ...(held ? [`الإرسال #${held}`] : [])].join(' · ');
}

const route = () => parseRestationingHash(location.hash);
const idFromHash = () => {
  const r = route();
  return r.kind === 'request' ? r.id : null;
};
/** #restationing/new?site=<siteId> or ?unit=<orgId>: a new request opened from a site (the Sites page) or a unit. */
const newFromHash = (): { id: null; unit: string | null; site: string | null } | null => {
  const r = route();
  return r.kind === 'new' ? { id: null, unit: r.unit, site: r.site } : null;
};

/**
 * «إعادة التمركز» as one operational workspace (owner brief «FULL APPLICATION UI REBUILD», §6–§18): the action panel
 * and the request drawer on the left, the request on the offline map in the centre with its approval strip, the
 * request's details, the organisation and the linked sites on the right. The new-request editor opens in the same
 * workspace. Every action and check is the server's; nothing here grants or decides anything.
 */
export function RestationingPage() {
  const app = useApp();
  const [items, setItems] = useState<RestationingListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(idFromHash);
  const [editing, setEditing] = useState<{ id: string | null; unit?: string | null; site?: string | null } | null>(newFromHash);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // open beside the map on a desktop; on a tablet or phone it slides over the map only when asked for
  const [drawerOpen, setDrawerOpen] = useState(() => window.innerWidth > 1180);
  const [tab, setTab] = useState<ContextTab>('request');
  const [unitId, setUnitId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api
      .restationingRequests()
      .then((l) => {
        setItems(l);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [tick, app.revision]);

  // the address carries the open request: a link, the search or the back button opens it here
  useEffect(() => {
    const onHash = () => {
      const id = idFromHash();
      if (id) setSelected(id);
      const fresh = newFromHash();
      if (fresh) setEditing(fresh);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const select = (id: string) => {
    setSelected(id);
    setEditing(null);
    setTab('request');
    setUnitId(null);
    history.replaceState(null, '', '#restationing/' + id);
  };

  const canCreate = app.can('CREATE_RESTATIONING');
  const canAccess = !restriction('permissions', app.can, app.summaryOnly) || !restriction('audit', app.can, app.summaryOnly);
  const actions: RailAction[] = [
    { key: 'links', label: 'ربط الوحدات بالمواقع', hint: 'التمركز الحالي وارتباطات المواقع', icon: 'link', active: !editing && tab === 'sites', onClick: () => (setEditing(null), setTab('sites')) },
    { key: 'map', label: 'إعادة التمركز عبر الخريطة', hint: 'الطلبات، وطلب جديد', icon: 'map', active: drawerOpen, onClick: () => setDrawerOpen((o) => !o) },
    {
      key: 'bounds',
      label: 'الحدود والمناطق',
      hint: 'الموقع ومنطقتا الانتشار على الخريطة',
      icon: 'boundary',
      onClick: () => (editing ? document.getElementById('rs-step-4')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : setFitKey((k) => k + 1)),
    },
    { key: 'route', label: 'مسار الاعتماد', hint: 'المراحل والسجل الكامل', icon: 'route', active: historyOpen, onClick: () => setHistoryOpen((o) => !o) },
    ...(canAccess
      ? [{ key: 'access', label: 'الصلاحيات والتدقيق', hint: 'حسب صلاحياتك', icon: 'shield', onClick: () => (location.hash = app.can('MANAGE_ACCESS') ? 'permissions' : 'audit') }]
      : []),
  ];
  const rail = (
    <ActionRail actions={actions}>
      <RequestDrawer items={items} selected={editing ? null : selected} onSelect={select} open={drawerOpen} setOpen={setDrawerOpen} canCreate={canCreate} onCreate={() => setEditing({ id: null })} />
      {error && <div className="rs-error">{error}</div>}
    </ActionRail>
  );

  if (editing) {
    return (
      // the editor brings its own step panel on the left: the request list steps aside until it closes
      <RestationingEditor
        key={editing.id ?? 'new:' + (editing.unit ?? '') + ':' + (editing.site ?? '')}
        requestId={editing.id}
        preselectUnit={editing.unit ?? null}
        preselectSite={editing.site ?? null}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
        onClose={(id) => {
          setEditing(null);
          if (id) select(id);
          else if (route().kind === 'new') history.replaceState(null, '', '#restationing');
          reload();
        }}
      />
    );
  }
  if (!selected) {
    return <StartWorkspace rail={rail} tab={tab} setTab={setTab} unitId={unitId} setUnitId={setUnitId} />;
  }
  return (
    <RequestWorkspace
      key={selected}
      id={selected}
      rail={rail}
      tab={tab}
      setTab={setTab}
      unitId={unitId}
      setUnitId={(u) => (setUnitId(u), setTab('sites'))}
      historyOpen={historyOpen}
      setHistoryOpen={setHistoryOpen}
      fitKey={fitKey}
      onChanged={reload}
      onEdit={() => setEditing({ id: selected })}
      onOpen={(x) => {
        select(x);
        reload();
      }}
    />
  );
}

function RequestWorkspace({ id, rail, tab, setTab, unitId, setUnitId, historyOpen, setHistoryOpen, fitKey, onChanged, onEdit, onOpen }: {
  id: string;
  rail: ReactNode;
  tab: ContextTab;
  setTab: (t: ContextTab) => void;
  unitId: string | null;
  setUnitId: (id: string) => void;
  historyOpen: boolean;
  setHistoryOpen: (o: boolean) => void;
  fitKey: number;
  onChanged: () => void;
  onEdit: () => void;
  onOpen: (id: string) => void;
}) {
  const app = useApp();
  const [r, setR] = useState<RestationingRequest | null>(null);
  const [checks, setChecks] = useState<RestationingChecks | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<BasemapMode>('street');
  const [refit, setRefit] = useState(0);

  useEffect(() => {
    setR(null);
    setChecks(null);
    setReason('');
    api.restationingRequest(id).then(setR).catch((e: Error) => app.toast(e.message));
    api.restationingChecks(id).then(setChecks).catch(() => setChecks(null));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: () => Promise<RestationingRequest>, done: string) => {
    setBusy(true);
    try {
      const next = await what();
      setR(next);
      setReason('');
      api.restationingChecks(id).then(setChecks).catch(() => undefined);
      app.toast(done);
      onChanged();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!r) {
    return (
      <OperationalWorkspace
        rail={rail}
        context={<aside className="tz-context"><div className="tz-context-body"><div className="tz-card tz-muted">جارٍ التحميل…</div></div></aside>}
        centre={<section className="tz-mapframe tz-empty"><p>جارٍ تحميل الطلب…</p></section>}
      />
    );
  }
  const c = r.content;
  const title = `${r.requestKind === 'EXTENSION' ? 'تمديد' : c.kind === 'TEMPORARY' ? 'إعادة تمركز مؤقتة' : 'إعادة تمركز دائمة'} — ${r.requestingUnit.name}`;
  return (
    <OperationalWorkspace
      sheetKey={r.id}
      rail={rail}
      context={
        <OrgContextPanel
          request={r}
          tab={tab}
          setTab={setTab}
          unitId={unitId}
          setUnitId={setUnitId}
          requestContent={<RequestPanel r={r} checks={checks} busy={busy} act={act} reason={reason} setReason={setReason} onEdit={onEdit} onOpen={onOpen} />}
        />
      }
      centre={
        <MapFrame
          title={
            <>
              <b className="tz-reqno">{r.number}</b>
              <span className="tz-reqtitle">{title}</span>
            </>
          }
          badge={<StatePill state={r.state} />}
          mode={mode}
          setMode={setMode}
          onFit={() => setRefit((k) => k + 1)}
          legend={<MapLegend />}
          strip={<ApprovalRouteStrip request={r} checks={checks} open={historyOpen} setOpen={setHistoryOpen} />}
        >
          <RequestMap request={r} checks={checks} mode={mode} fitKey={fitKey + refit} />
        </MapFrame>
      }
    />
  );
}

/** The request's details in the context panel: summary and facts, the server's actions, the checks and the lifecycle. */
function RequestPanel({ r, checks, busy, act, reason, setReason, onEdit, onOpen }: {
  r: RestationingRequest;
  checks: RestationingChecks | null;
  busy: boolean;
  act: (what: () => Promise<RestationingRequest>, done: string) => void;
  reason: string;
  setReason: (s: string) => void;
  onEdit: () => void;
  onOpen: (id: string) => void;
}) {
  const c = r.content;
  const resubmit = r.state === 'RETURNED_FOR_CHANGES' || r.state === 'PAUSED_HIERARCHY_CHANGED';
  return (
    <>
      {/* the number, kind and state are the map header's; the panel starts with the request's reason */}
      <section className="tz-card rs-summary">
        <p className="tz-reason">{c.reason}</p>
        {r.state === 'PAUSED_HIERARCHY_CHANGED' && (
          <div className="rs-banner red">
            <b>موقوف — تغيّر الهيكل:</b> {HIERARCHY_CHANGED}. المسار السابق محفوظ بقراراته، وبعد التأكيد يُعاد بناء المسار من الوحدة نفسها وتُعاد كل المراحل.
          </div>
        )}
        {r.returned && r.state === 'RETURNED_FOR_CHANGES' && (
          <div className="rs-banner orange">
            <b>أعاده {r.returned.byName}</b> ({r.returned.stageLabel}): {r.returned.reason}
          </div>
        )}
        <dl className="rs-facts">
          <div>
            <dt>الوحدات المنتقلة</dt>
            <dd>{r.units.map((u) => u.name).join('، ') || '—'}</dd>
          </div>
          <div>
            <dt>الموقع الحالي</dt>
            <dd>{r.currentSites.map((s) => s.site.name).join('، ') || '—'}</dd>
          </div>
          <div>
            <dt>موقع إعادة التمركز</dt>
            <dd data-testid="proposed-site">{proposedSite(r)}</dd>
          </div>
          <div>
            <dt>{c.kind === 'TEMPORARY' ? 'المدة' : 'النفاذ'}</dt>
            <dd>{c.kind === 'TEMPORARY' ? `${fullDate(c.start ?? '')} ← ${fullDate(c.end ?? '')}` : 'عند التفعيل المستقل'}</dd>
          </div>
          <div>
            <dt>نسخة السياسة</dt>
            <dd>{r.policyVersion ?? (checks?.policyVersion != null ? `${checks.policyVersion} (النافذة؛ تُقفل عند الإرسال)` : '—')}</dd>
          </div>
          <div>
            <dt>مقدم الطلب</dt>
            <dd>{r.requester.name}</dd>
          </div>
          {r.activation && (
            <div>
              <dt>التفعيل</dt>
              <dd>
                {r.activation.by.name} · {fullDate(r.activation.at)} · {r.activation.site.name}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {(r.can.edit || r.can.submit || r.can.decide || r.can.activate || !hasLifecycle(r)) && (
      <section className="tz-card rs-actions" aria-label="الإجراءات">
        {r.can.edit && (
          <button className="button" onClick={onEdit} disabled={busy}>
            <Icon name="file" /> تعديل الطلب
          </button>
        )}
        {(r.can.submit || r.can.decide || r.can.activate) && (
          <textarea
            className="rs-reason"
            placeholder={r.can.decide ? 'سبب القرار (مطلوب للإرجاع والرفض)' : resubmit ? 'ما الذي عدّلته أو أكّدته (مطلوب)' : 'ملاحظة (اختيارية)'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
        {r.can.submit && (
          <button className="button primary" disabled={busy} onClick={() => act(() => api.submitRestationing(r.id, reason), resubmit ? 'أُعيد الإرسال' : 'أُرسل الطلب')}>
            {r.state === 'PAUSED_HIERARCHY_CHANGED' ? 'تأكيد وإعادة بناء المسار' : resubmit ? 'إعادة الإرسال' : 'إرسال للاعتماد'}
          </button>
        )}
        {r.can.decide && (
          <>
            <button className="button primary" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'APPROVE', reason), 'اعتُمدت المرحلة')}>
              اعتماد المرحلة
            </button>
            <button className="button" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'RETURN', reason), 'أُعيد الطلب للتعديل')}>
              إرجاع للتعديل
            </button>
            <button className="button danger" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'REJECT', reason), 'رُفض الطلب')}>
              رفض
            </button>
          </>
        )}
        {r.can.activate && (
          <button className="button primary" disabled={busy} onClick={() => act(() => api.activateRestationing(r.id, reason), r.requestKind === 'EXTENSION' ? 'فُعّل التمديد' : 'فُعّل الطلب')}>
            {r.requestKind === 'EXTENSION' ? 'تفعيل التمديد (إجراء مستقل)' : 'تفعيل (إجراء مستقل)'}
          </button>
        )}
        {!r.can.edit && !r.can.submit && !r.can.decide && !r.can.activate && !hasLifecycle(r) && (
          <span className="tz-muted">لا إجراء لك على هذا الطلب في حالته الحالية — الخادم يقرر من يرى ويقرر.</span>
        )}
      </section>
      )}

      <DeploymentCheckCard request={r} checks={checks} />
      <Lifecycle r={r} busy={busy} act={act} onOpen={onOpen} />
    </>
  );
}

const hasLifecycle = (r: RestationingRequest) =>
  !!(r.can.askCancellation || r.can.askStartCancellation || r.can.askEarlyReturn || r.can.askExtension || r.can.decideAction);

/**
 * The lifecycle of a request (ADR-034): ask for a cancellation, a cancellation before the start, an early return or an
 * extension; decide a pending action (another human with its own right); and the history of actions and extensions.
 * Every button follows the server's `can`; the server refuses anything else.
 */
function Lifecycle({ r, busy, act, onOpen }: { r: RestationingRequest; busy: boolean; act: (what: () => Promise<RestationingRequest>, done: string) => void; onOpen: (id: string) => void }) {
  const [why, setWhy] = useState('');
  const [end, setEnd] = useState('');
  const pending = r.actions?.find((a) => a.state === 'REQUESTED');
  const asks = r.can.askCancellation || r.can.askStartCancellation || r.can.askEarlyReturn || r.can.askExtension;
  if (!asks && !pending && !(r.actions?.length || r.extensions?.length || r.parent)) return null;
  return (
    <section className="tz-card rs-lifecycle">
      <h3>دورة حياة الطلب</h3>
      {r.parent && (
        <p>
          تمديد للتمركز المؤقت{' '}
          <button className="link" onClick={() => onOpen(r.parent!.id)}>
            {r.parent.number}
          </button>
        </p>
      )}
      {r.effectiveEnd && r.requestKind === 'TEMPORARY' && <p className="muted">النهاية الفعالة: {fullDate(r.effectiveEnd)}</p>}
      {pending && (
        <div className="rs-banner orange">
          <b>{ACTION_KIND[pending.kind]}</b> — طلبه {pending.requestedBy} · {fullDate(pending.requestedAt)} · السبب: {pending.reason}
          {pending.heldAt && <div>أُوقف البدء في {fullDate(pending.heldAt)}: التمركز الدائم هو المعتمد حتى القرار.</div>}
        </div>
      )}
      {(asks || r.can.decideAction) && (
        <textarea className="rs-reason" placeholder="السبب (مطلوب للطلب وللرفض)" value={why} onChange={(e) => setWhy(e.target.value)} />
      )}
      <div className="rs-tools">
        {r.can.decideAction && (
          <>
            <button className="button primary" disabled={busy} onClick={() => act(() => api.decideRestationingAction(r.id, r.can.decideAction!, 'APPROVE', why), 'قُبل الإجراء')}>
              قبول {pending ? ACTION_KIND[pending.kind] : ''}
            </button>
            <button className="button danger" disabled={busy} onClick={() => act(() => api.decideRestationingAction(r.id, r.can.decideAction!, 'REJECT', why), 'رُفض الإجراء')}>
              رفض
            </button>
          </>
        )}
        {r.can.askCancellation && (
          <button className="button" disabled={busy} onClick={() => act(() => api.askRestationingCancellation(r.id, why), 'طُلب الإلغاء قبل التفعيل')}>
            طلب إلغاء قبل التفعيل
          </button>
        )}
        {r.can.askStartCancellation && (
          <button className="button" disabled={busy} onClick={() => act(() => api.askStartCancellation(r.id, why), 'طُلب إلغاء التمركز المؤقت قبل بدئه')}>
            طلب إلغاء قبل بدء النفاذ
          </button>
        )}
        {r.can.askEarlyReturn && (
          <button className="button" disabled={busy} onClick={() => act(() => api.askEarlyReturn(r.id, why), 'طُلبت العودة المبكرة')}>
            طلب عودة مبكرة
          </button>
        )}
        {r.can.askExtension && (
          <>
            <label>
              نهاية التمديد <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
            <button
              className="button"
              disabled={busy || !end}
              onClick={() =>
                act(async () => {
                  const ext = await api.createRestationingExtension(r.id, new Date(end).toISOString(), why);
                  onOpen(ext.id);
                  return ext;
                }, 'أُعدّت مسودة التمديد — أرسلها للاعتماد')
              }
            >
              طلب تمديد
            </button>
          </>
        )}
      </div>
      {!!r.actions?.length && (
        <details open={!!pending}>
          <summary>الإجراءات ({r.actions.length})</summary>
          <ul className="rs-revisions">
            {r.actions.map((a) => (
              <li key={a.id}>
                <b>{ACTION_KIND[a.kind]}</b> · {ACTION_STATE[a.state]} — طلبه {a.requestedBy} ({fullDate(a.requestedAt)}): {a.reason}
                {a.decidedBy && <> · قرره {a.decidedBy} ({fullDate(a.decidedAt ?? '')}){a.decisionReason ? ': ' + a.decisionReason : ''}</>}
                {a.closeReason && <> · {a.closeReason}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!r.extensions?.length && (
        <details>
          <summary>التمديدات ({r.extensions.length})</summary>
          <ul className="rs-revisions">
            {r.extensions.map((e) => (
              <li key={e.id}>
                <button className="link" onClick={() => onOpen(e.id)}>
                  {e.number}
                </button>{' '}
                · حتى {fullDate(e.end)} · <StatePill state={e.state} />
                {e.lapseReason && <> · {e.lapseReason}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * The workspace before a request is open: the sites on the offline map (those with a current stationing coloured), the
 * organisation on the right, and the request list with «طلب إعادة تمركز» on the left. No request opens by itself.
 */
function StartWorkspace({ rail, tab, setTab, unitId, setUnitId }: { rail: ReactNode; tab: ContextTab; setTab: (t: ContextTab) => void; unitId: string | null; setUnitId: (id: string | null) => void }) {
  const [mode, setMode] = useState<BasemapMode>('street');
  const registered = useRegisteredSites();
  return (
    <OperationalWorkspace
      rail={rail}
      context={<OrgContextPanel request={null} tab={tab === 'request' ? 'units' : tab} setTab={setTab} requestContent={null} unitId={unitId} setUnitId={setUnitId} />}
      centre={
        <MapFrame title={<span className="tz-reqtitle">المواقع المسجلة (للمرجع)</span>} mode={mode} setMode={setMode} legend={<SitesLegend />}>
          <SitesMap sites={registered.all} current={registered.current} mode={mode} />
          <div className="tz-map-hint" role="note">
            <Icon name="map" /> اختر طلباً من القائمة، أو ابدأ «طلب إعادة تمركز» جديداً.
          </div>
        </MapFrame>
      }
    />
  );
}

/** The legend of a map that shows only the registered sites. */
function SitesLegend() {
  return (
    <div className="tz-legend rs-legend">
      <ul>
        <li><i className="sw ref" /> موقع مسجّل (حدود)</li>
        <li><i className="sw ref-marker" /> موقع مسجّل (علامة)</li>
      </ul>
    </div>
  );
}
