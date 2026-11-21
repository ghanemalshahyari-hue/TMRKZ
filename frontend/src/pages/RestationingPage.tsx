import { PURPOSE_TITLE, isCreatablePurpose, isPurpose, type Purpose } from '../lib/requestPurpose';
import { PartReviewPanel, ReturnedParts } from '../components/workspace/PartReviewPanel';
import { flatSource } from '../components/tree/tree';
import { UnitTree } from '../components/tree/UnitTree';
import { DeploymentAreasRequest } from './DeploymentAreasRequest';
import { StationingShell, type ShellMode } from '../components/workspace/StationingShell';
import { StationingPosture } from './StationingPosture';
import { popReturn } from '../lib/returnContext';
import { ApprovalStamps } from '../components/workspace/ApprovalStamps';
import type { RestationingUnit } from '../api/types';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { RS_STATE, StatePill } from '../components/workspace/StatePill';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { formatArea } from '../lib/footprint';
import { restriction } from '../lib/navigation';
import { parseRestationingHash } from '../lib/restationingRoute';
import { partsOf, siteArea } from '../lib/siteGeometry';
import { HIERARCHY_CHANGED } from '../lib/stationingV3';
import { decidesExcess, excessLines } from '../lib/workspace';
import { isFlowPurpose } from '../lib/deploymentAreasFlow';
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
/**
 * #restationing/new?site=<siteId> or ?unit=<orgId>: a new request opened from a site (the Sites page) or a unit. An address
 * naming initial stationing opens a re-stationing instead: that request is no longer made (ADR-078).
 */
const newFromHash = (): { id: null; unit: string | null; site: string | null; purpose: Purpose | null } | null => {
  const r = route();
  return r.kind === 'new' ? { id: null, unit: r.unit, site: r.site, purpose: isCreatablePurpose(r.purpose) ? r.purpose : null } : null;
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
  const [editing, setEditing] = useState<{ id: string | null; unit?: string | null; site?: string | null; purpose?: Purpose | null } | null>(newFromHash);
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
      // a link, a notification or the back button naming a request opens it in the read-only workspace, leaving any editor
      if (id) {
        setSelected(id);
        setEditing(null);
      }
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

  // «طلب إعادة التمركز ومناطق الانتشار» and «طلب اعتماد موقع»: initial stationing is set up in «تهيئة المواقع» (ADR-078)
  const canCreate = (['CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION'] as const).some((p) => app.can(p));
  const canAccess = !restriction('permissions', app.can, app.summaryOnly) || !restriction('audit', app.can, app.summaryOnly);
  // one action is lit at a time, the view in front: the approval route over the linked sites over the request list (owner, 11 Nov 2026)
  const current = historyOpen ? 'route' : !editing && tab === 'sites' ? 'links' : drawerOpen ? 'map' : null;
  const actions: RailAction[] = [
    {
      key: 'links',
      label: 'ربط الوحدات بالمواقع',
      hint: 'التمركز الحالي وارتباطات المواقع',
      icon: 'link',
      active: current === 'links',
      onClick: () => (setEditing(null), setHistoryOpen(false), setTab('sites')),
    },
    {
      key: 'map',
      label: 'إعادة التمركز عبر الخريطة',
      hint: 'الطلبات، وطلب جديد',
      icon: 'map',
      active: current === 'map',
      onClick: () => {
        setHistoryOpen(false);
        if (current === 'map') return setDrawerOpen(false);
        setDrawerOpen(true);
        if (tab === 'sites') setTab('request');
      },
    },
    {
      key: 'bounds',
      label: 'الحدود والمناطق',
      hint: 'الموقع ومنطقتا الانتشار على الخريطة',
      icon: 'boundary',
      onClick: () => (editing ? document.getElementById('rs-step-4')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : setFitKey((k) => k + 1)),
    },
    { key: 'route', label: 'مسار الاعتماد', hint: 'المراحل والسجل الكامل', icon: 'route', active: current === 'route', onClick: () => setHistoryOpen((o) => !o) },
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

  // the one map-first editor (owner brief §4–§5; release closure, 20 Nov 2026): a new «طلب مناطق انتشار» or «طلب إعادة تمركز»,
  // one opened from a site (the site preselected), and every saved draft or returned request of those two purposes.
  // Only a legacy purpose (a site registration, an initial stationing made before ADR-078) still opens the old editor.
  const closeEditor = (id?: string | null) => {
    setEditing(null);
    if (id) {
      select(id);
      popReturn(); // the stored referrer is discarded when we stay on a saved request
    } else if (route().kind === 'new') {
      // Owner UX §9: cancelling a new request returns to the origin (Sites, Units, Requests), not generic restationing.
      const back = popReturn('');
      if (back) {
        location.hash = back.startsWith('#') ? back.slice(1) : back;
        return;
      }
      history.replaceState(null, '', '#restationing');
    }
    reload();
  };
  if (editing && !editing.id && (editing.purpose === 'DEPLOYMENT_AREAS' || editing.purpose === 'RESTATIONING')) {
    const mode: ShellMode = editing.purpose === 'DEPLOYMENT_AREAS' ? 'deployment' : 'restationing';
    return (
      <StationingShell mode={mode} onExit={() => closeEditor()}>
        <DeploymentAreasRequest
          key={editing.purpose + ':' + (editing.unit ?? '') + ':' + (editing.site ?? '')}
          purpose={editing.purpose}
          preselectUnit={editing.unit ?? null}
          preselectSite={editing.site ?? null}
          onClose={() => closeEditor()}
        />
      </StationingShell>
    );
  }
  if (editing && editing.id) {
    return (
      <StationingShell mode="view-or-edit" onExit={() => closeEditor()}>
        <OpenSavedRequest key={editing.id} id={editing.id} historyOpen={historyOpen} setHistoryOpen={setHistoryOpen} onClose={closeEditor} />
      </StationingShell>
    );
  }
  if (editing) {
    return (
      // Owner UX §9 (20 Nov 2026): the shell banner states «طلب اعتماد موقع قديم», never «إعادة تمركز».
      <StationingShell mode="legacy" onExit={() => (setEditing(null), history.replaceState(null, '', '#restationing'), reload())}>
        <RestationingEditor
          key={editing.id ?? 'new:' + (editing.purpose ?? '') + ':' + (editing.unit ?? '') + ':' + (editing.site ?? '')}
          requestId={editing.id}
          purpose={editing.purpose ?? null}
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
      </StationingShell>
    );
  }
  if (!selected) {
    // Owner, 20 Nov 2026 (reset): «مساحة التمركز» is the read-only operational posture, not a request workspace. The
    // StartWorkspace with its drawer, request rail and «طلب جديد» link is retired; request creation and management live in
    // «＋ إنشاء» and «الطلبات». The old rail is still computed above (no cost) so entering a saved request keeps the shell
    // and its exit button behaviour unchanged.
    return <StationingShell mode={null} onExit={null}><StationingPosture /></StationingShell>;
  }
  return (
    <StationingShell mode={null} onExit={null}>
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
    </StationingShell>
  );
}


/**
 * A saved request opened for editing (a draft, or one returned for changes): read once to know its purpose, then the map-first
 * editor for a re-stationing or a deployment-areas request — as saved, nothing changed by opening — and the old editor only
 * for a legacy purpose (a site registration, an initial stationing made before ADR-078). Reading it writes nothing.
 */
function OpenSavedRequest({ id, historyOpen, setHistoryOpen, onClose }: { id: string; historyOpen: boolean; setHistoryOpen: (o: boolean) => void; onClose: (id?: string | null) => void }) {
  const [purpose, setPurpose] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    api.restationingRequest(id).then((r) => setPurpose(r.purpose ?? 'RESTATIONING'), (e: Error) => setFailed(e.message));
  }, [id]);
  if (failed) return <section className="tz-mapframe tz-empty" data-testid="open-failed"><p>{failed}</p><button type="button" className="button" onClick={() => onClose()}>رجوع</button></section>;
  if (purpose === undefined) return <section className="tz-mapframe tz-empty"><p>جارٍ فتح الطلب…</p></section>;
  if (isFlowPurpose(purpose)) {
    return <DeploymentAreasRequest purpose={purpose} requestId={id} onClose={() => onClose(id)} />;
  }
  return <RestationingEditor requestId={id} purpose={isPurpose(purpose) ? purpose : null} preselectUnit={null} preselectSite={null} historyOpen={historyOpen} setHistoryOpen={setHistoryOpen} onClose={(x) => onClose(x)} />;
}

/** «تحديد وحدات العلم»: after final approval, a holder chooses the units informed. Not a vote, and no lasting right (ADR-045). */
function FyiDistribution({ r, busy, act }: { r: RestationingRequest; busy: boolean; act: (what: () => Promise<RestationingRequest>, done: string) => void }) {
  const [options, setOptions] = useState<RestationingUnit[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [note, setNote] = useState('');
  // the one units tree of the application (owner, 16 Nov 2026)
  const tree = useMemo(() => flatSource(options ?? []), [options]);
  const ticked = useMemo(() => new Set(chosen), [chosen]);
  return (
    <section className="tz-card" data-testid="fyi-distribution">
      <h4>توزيع للعلم</h4>
      {options == null ? (
        <button className="button primary" onClick={() => api.fyiOptions(r.id).then(setOptions)}>تحديد وحدات العلم</button>
      ) : (
        <>
          <p className="micro tz-muted">ليس تصويتاً: يطّلع أفراد هذه الوحدات على هذا الطلب وحده، ولا تُمنح لهم أي صلاحية دائمة.</p>
          <div style={{ ['--ut-max-height' as string]: '220px' }}>
            <UnitTree source={tree} label="وحدات العلم" searchLabel="بحث عن وحدة علم" search="بحث عن وحدة…" checked={ticked} checkData="fyi-unit"
              onCheck={(o) => setChosen(chosen.includes(o.id) ? chosen.filter((x) => x !== o.id) : [...chosen, o.id])}
              initialOpen={(options ?? []).length <= 80 ? (options ?? []).map((o) => o.id) : []} openSingleRoot />
          </div>
          <label className="field"><span>ملاحظة (اختياري)</span><input aria-label="ملاحظة العلم" value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button className="button primary" data-testid="fyi-send" disabled={busy} onClick={() => act(() => api.distributeFyi(r.id, chosen, note), chosen.length ? 'أُرسل للعلم' : 'سُجل: لا وحدات للعلم')}>{chosen.length ? 'إرسال للعلم' : 'تأكيد: بلا وحدات'}</button>
        </>
      )}
    </section>
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
  const title = isPurpose(r.purpose) && r.purpose !== 'RESTATIONING' ? `${PURPOSE_TITLE[r.purpose]} — ${r.requestingUnit.name}` : `${r.requestKind === 'EXTENSION' ? 'تمديد' : c.kind === 'TEMPORARY' ? 'إعادة تمركز مؤقتة' : 'إعادة تمركز دائمة'} — ${r.requestingUnit.name}`;
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
  const excess = excessLines(r);
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
        {excess.length > 0 && (
          // flagged on every stage; no stage of its own: the final approver decides it with the request (ADR-078)
          <div className="rs-banner orange" data-testid="exceeds-policy">
            <b>يتجاوز المسموح</b> — يقرره المعتمد النهائي مع الطلب: اعتماده يقبل التجاوز، وله الإرجاع للتعديل أو الرفض.
            <ul>
              {excess.map((e) => (
                <li key={e.leg} data-exceeds-leg={e.leg}>
                  {e.label}: <b>{e.text}</b> ({e.detail}){e.reason ? ' — السبب: ' + e.reason : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        {r.returned && r.state === 'RETURNED_FOR_CHANGES' && (
          <div className="rs-banner orange">
            <b>أعاده {r.returned.byName}</b> ({r.returned.stageLabel}): {r.returned.reason}
            {/* «الاعتماد الجزئي» (ADR-090): what is approved stays so unless it is changed; what needs changes */}
            {!!r.parts?.some((p) => p.last) && <ReturnedParts parts={r.parts} />}
          </div>
        )}
        <dl className="rs-facts">
          <div>
            <dt>{isPurpose(r.purpose) && r.purpose !== 'RESTATIONING' ? 'الوحدات' : 'الوحدات المنتقلة'}</dt>
            <dd>{r.units.map((u) => u.name).join('، ') || '—'}</dd>
          </div>
          <div>
            <dt>الموقع الحالي</dt>
            <dd>{r.currentSites.map((s) => s.site.name).join('، ') || '—'}</dd>
          </div>
          <div>
            <dt>{r.purpose === 'INITIAL_STATIONING' || r.purpose === 'SITE_REGISTRATION' ? 'الموقع المطلوب' : r.purpose === 'DEPLOYMENT_AREAS' ? 'ما يتغير' : 'موقع إعادة التمركز'}</dt>
            <dd data-testid="proposed-site">{r.purpose === 'INITIAL_STATIONING' ? r.targetSite?.name ?? '—' : r.purpose === 'SITE_REGISTRATION' ? `${c.siteInfo?.name ?? '—'} (${c.siteInfo?.code ?? ''})` : r.purpose === 'DEPLOYMENT_AREAS' ? 'منطقتا الانتشار فقط' : proposedSite(r)}</dd>
          </div>
          <div>
            <dt>{c.kind === 'TEMPORARY' ? 'المدة' : 'النفاذ'}</dt>
            <dd>{c.kind === 'TEMPORARY' ? `${fullDate(c.start ?? '')} ← ${fullDate(c.end ?? '')}` : 'فور الاعتماد النهائي'}</dd>
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
              <dt>النفاذ</dt>
              <dd>
                {fullDate(r.activation.at)} · {r.activation.site.name}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {/* «ختم عمليات الوحدة» and «ختم الاعتماد النهائي», as TNQL's (ADR-055) */}
      <ApprovalStamps
        requestId={r.id}
        state={r.state}
        title={isPurpose(r.purpose) ? PURPOSE_TITLE[r.purpose] : PURPOSE_TITLE.RESTATIONING}
        facts={[
          ['الوحدات', r.units.map((u) => u.name).join('، ') || '—'],
          ['الموقع الحالي', r.currentSites.map((x) => x.site.name).join('، ') || '—'],
          ['الموقع المطلوب', r.purpose === 'INITIAL_STATIONING' ? r.targetSite?.name ?? '—' : r.purpose === 'SITE_REGISTRATION' ? c.siteInfo?.name ?? '—' : r.purpose === 'DEPLOYMENT_AREAS' ? 'منطقتا الانتشار فقط' : proposedSite(r)],
          [c.kind === 'TEMPORARY' ? 'المدة' : 'النفاذ', c.kind === 'TEMPORARY' ? `${fullDate(c.start ?? '')} ← ${fullDate(c.end ?? '')}` : 'فور الاعتماد النهائي'],
          ['مقدم الطلب', r.requester.name],
          ['السبب', c.reason],
        ]}
      />

      {(r.can.edit || r.can.submit || r.can.decide || !hasLifecycle(r)) && (
      <section className="tz-card rs-actions" aria-label="الإجراءات">
        {r.can.edit && (
          <button className="button" onClick={onEdit} disabled={busy}>
            <Icon name="file" /> تعديل الطلب
          </button>
        )}
        {(r.can.submit || r.can.decide) && (
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
        {r.can.decide && decidesExcess(r) && (
          <p className="micro" data-testid="final-decides-excess">قرارك يشمل ما يتجاوز المسموح أعلاه: الاعتماد يقبله، والإرجاع أو الرفض يردّه.</p>
        )}
        {r.can.decide && !!r.parts?.length && (
          <PartReviewPanel key={r.id + ':' + r.routeNo + ':' + r.route.findIndex((x) => x.current)} parts={r.parts} busy={busy}
            onDecide={(parts, notes) => act(() => api.decideRestationing(r.id, 'PARTS', reason, parts, notes), Object.values(parts).includes('CHANGES') ? 'أُعيد الطلب لتعديل الأجزاء المطلوبة' : 'اعتُمدت الأجزاء')} />
        )}
        {r.can.decide && (
          <>
            <button className="button primary" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'APPROVE', reason), 'اعتُمدت المرحلة')}>
              {r.can.decideAs ?? 'اعتماد'}
            </button>
            <button className="button" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'RETURN', reason), 'أُعيد الطلب للتعديل')}>
              إرجاع للتعديل
            </button>
            <button className="button danger" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'REJECT', reason), 'رُفض الطلب')}>
              رفض
            </button>
          </>
        )}
        {/* ADR-095: activation is part of final approval — no separate activate button in the UI. */}
        {!r.can.edit && !r.can.submit && !r.can.decide && !hasLifecycle(r) && (
          <span className="tz-muted">لا إجراء لك على هذا الطلب في حالته الحالية — الخادم يقرر من يرى ويقرر.</span>
        )}
      </section>
      )}

      {r.can.fyi && !r.fyi?.doneAt && <FyiDistribution r={r} busy={busy} act={act} />}
      {r.readOnlyFyi && (
        <section className="tz-card rs-banner" data-testid="fyi-read-only">
          <b>للعلم:</b> وصلك هذا الطلب للاطلاع فقط. لا يمنحك صلاحية على غيره.
        </section>
      )}
      {r.fyi?.doneAt && (
        <section className="tz-card" data-testid="fyi-done">
          <h4>توزيع للعلم</h4>
          <p className="micro">{r.fyi.units.length ? r.fyi.units.join('، ') : 'لا وحدات'} · {r.fyi.doneBy} · {fullDate(r.fyi.doneAt)}</p>
          {r.can.fyi && r.fyi.active?.map((u) => (
            <button key={u.id} className="button compact" data-end-fyi={u.id} disabled={busy} onClick={() => { const why = window.prompt('سبب إنهاء الاطلاع'); if (why && why.trim().length >= 5) act(() => api.endFyi(r.id, u.id, why), 'أُنهي الاطلاع'); }}>إنهاء اطلاع {u.name}</button>
          ))}
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
 * The lifecycle of a request (ADR-034, ADR-078): whoever holds the request's right for the requesting unit asks for a
 * cancellation, a cancellation before the start, an early return or an extension; the unit's final approver (nearest scope)
 * decides a pending action, never the one who asked; an approved extension is activated with «تفعيل التمركز». The history of
 * actions and extensions follows. Every button follows the server's `can`; the server refuses anything else.
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
          <div className="micro" data-testid="action-decider">يقرره المعتمد النهائي للوحدة الطالبة، ولا يقرره من طلبه.</div>
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
// Owner 20 Nov 2026 reset: the former StartWorkspace (request drawer idle state) is retired; the operational posture sits
// in the idle branch of RestationingPage. The function body was removed in this change; the file StationingPosture.tsx is
// the one source of truth for the idle «مساحة التمركز» surface.

/** The legend of a map that shows only the registered sites. */
