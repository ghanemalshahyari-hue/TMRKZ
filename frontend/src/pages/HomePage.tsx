import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { homeEmpty } from '../lib/homeEmpty';
import { api, type AccessInboxItem, type HomeCard, type OverviewItem } from '../api/client';
import type { Notification, Permission, RequestHealthSummary, RestationingListItem, RestationingState, Site, StationingRecord, TaskItem } from '../api/types';
import { BrandMark } from '../components/shell/TopNavigation';
import { Icon } from '../components/ui';
import { StatePill } from '../components/workspace/StatePill';
import { useApp } from '../lib/app';
import { restriction } from '../lib/navigation';
import { STATIONING_V3_ENABLED } from '../lib/stationingV3';
import type { Selection } from '../components/workspace/CommandMap';

// The offline map is loaded on demand.
const CommandMap = lazy(() => import('../components/workspace/CommandMap'));

const REVIEW: RestationingState[] = ['UNDER_REVIEW', 'CANCELLATION_PENDING', 'START_HELD_PENDING_CANCELLATION'];
const RETURNED: RestationingState[] = ['RETURNED_FOR_CHANGES'];
const DAY = 86_400_000;

function Stat({ icon, value, label, tone = '', href, testid }: { icon: string; value: ReactNode; label: string; tone?: string; href?: string; testid?: string }) {
  const body = (
    <>
      <span className={'tz-stat-icon ' + tone}><Icon name={icon} /></span>
      <span className="tz-stat-text"><b>{value}</b><span>{label}</span></span>
    </>
  );
  return href ? <a className="tz-stat" data-testid={testid} href={href}>{body}</a> : <div className="tz-stat" data-testid={testid}>{body}</div>;
}

const ar = (n: number | null | undefined) => (n == null ? '…' : n.toLocaleString('ar-AE'));

/** The person's role for the dashboard: what the shell knows about them decides which panels load and which numbers show. */
function useRoleData(can: (p: Permission) => boolean) {
  const isConfig = can('CONFIGURE');
  const isFinal = can('FINAL_APPROVE_STATIONING') || can('APPROVE') || can('APPROVE_HIERARCHY');
  const isReviewer = can('REVIEW');
  const isAccess = can('MANAGE_ACCESS');
  const isRequester = can('CREATE_RESTATIONING') || can('REQUEST_SITE_REGISTRATION') || can('CREATE');
  const isAudit = can('AUDIT');
  const isViewer = can('VIEW') || can('VIEW_SUMMARY') || can('VIEW_OPERATIONAL_POSTURE');
  const isOperations = can('DECIDE_UNIT_OPERATIONS') || can('ACTIVATE_STATIONING');
  const isSiteOps = can('MANAGE_FACILITIES') || can('MANAGE_SITE_LINKS') || can('CORRECT_STATIONING');
  const isNoAccess = !isConfig && !isFinal && !isReviewer && !isAccess && !isRequester && !isAudit && !isViewer && !isOperations && !isSiteOps;
  const title = isConfig ? 'مدير النظام'
    : isFinal ? 'صاحب الاعتماد النهائي'
    : isOperations ? 'معتمد عمليات الوحدة'
    : isAccess ? 'مدير الصلاحيات'
    : isReviewer ? 'مراجع الطلبات'
    : isSiteOps ? 'مدير المواقع'
    : isAudit ? 'مدقق السجلات'
    : isRequester ? 'مقدم طلب'
    : isViewer ? 'مطّلع'
    : 'مستخدم';
  return { isConfig, isFinal, isReviewer, isAccess, isRequester, isAudit, isViewer, isOperations, isSiteOps, isNoAccess, title };
}

/** The dashboard's three questions (owner brief, 20 Nov 2026): what needs me, where is it, what may I do about it. */
export function HomePage() {
  const app = useApp();
  const role = useRoleData(app.can);
  const canRs = STATIONING_V3_ENABLED && !restriction('restationing', app.can, app.summaryOnly);
  const canSites = !restriction('stationing', app.can, app.summaryOnly);
  const canUnits = !restriction('org', app.can, app.summaryOnly);
  const canMap = STATIONING_V3_ENABLED && (role.isViewer || role.isAudit || role.isOperations || role.isSiteOps || role.isConfig);

  const [requests, setRequests] = useState<RestationingListItem[] | null>(null);
  const [current, setCurrent] = useState<StationingRecord[] | null>(null);
  const [notes, setNotes] = useState<Notification[] | null>(null);
  const [cards, setCards] = useState<HomeCard[]>([]);
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [inbox, setInbox] = useState<AccessInboxItem[] | null>(null);
  const [mine, setMine] = useState<OverviewItem[] | null>(null);
  const [healthSummary, setHealthSummary] = useState<RequestHealthSummary | null>(null); // eslint-disable-line @typescript-eslint/no-unused-vars

  useEffect(() => { api.homeCards().then(setCards).catch(() => setCards([])); }, [app.revision]);
  useEffect(() => {
    if (role.isConfig) api.requestHealthSummary().then(setHealthSummary).catch(() => setHealthSummary(null));
    else setHealthSummary(null);
  }, [app.revision, role.isConfig]);
  useEffect(() => {
    if (canRs) api.restationingRequests().then(setRequests).catch(() => setRequests([]));
    else setRequests([]);
    if (canMap) api.stationingCurrent().then(setCurrent).catch(() => setCurrent([]));
    else setCurrent([]);
    api.notifications().then(setNotes).catch(() => setNotes([]));
    if (role.isReviewer || role.isFinal || role.isOperations) api.tasks().then(setTasks).catch(() => setTasks([]));
    else setTasks([]);
    if (role.isAccess) api.accessInbox().then(setInbox).catch(() => setInbox([]));
    else setInbox([]);
    if (role.isRequester && !role.isConfig) api.requestOverview('MY_TURN').then(setMine).catch(() => setMine([]));
    else setMine([]);
  }, [app.revision, canRs, canMap, role.isReviewer, role.isFinal, role.isAccess, role.isRequester, role.isConfig, role.isOperations]);

  // Live counts
  const countOf = (states: RestationingState[]) => requests?.filter((r) => states.includes(r.state)).length ?? 0;
  const temporary = useMemo(() => current?.filter((c) => c.kind === 'TEMPORARY') ?? [], [current]);
  const nearReturnStations = useMemo(
    () => temporary.filter((c) => c.plannedEnd && new Date(c.plannedEnd).getTime() - Date.now() < 30 * DAY),
    [temporary],
  );
  const stationedUnits = useMemo(() => new Set(current?.map((c) => c.orgId) ?? []), [current]);
  const overdueTasks = useMemo(() => tasks?.filter((t) => t.overdue).length ?? 0, [tasks]);
  const finalWaiting = useMemo(() => tasks?.filter((t) => t.final).length ?? 0, [tasks]);
  const accessWaiting = inbox?.length ?? 0;
  const myReturned = useMemo(() => mine?.filter((r) => r.state === 'RETURNED' || r.state === 'RETURNED_FOR_CHANGES').length ?? 0, [mine]);
  const oldReview = useMemo(
    () => (requests ?? []).filter((r) => REVIEW.includes(r.state) && Date.now() - new Date(r.updatedAt).getTime() > DAY).length,
    [requests],
  );

  // Ground-truth sets of site IDs: the sites a piece of work points to on the map (for highlight and warning).
  const oldReviewSites = useMemo<Set<string>>(() => new Set(), [requests]);
  // Owner, 21 Nov 2026: the «ملخص الحالة» rows become filter buttons on the map.
  //  - permanent/temporary: site IDs come straight from the live stationing records;
  //  - طلبات قيد الاعتماد: the list item carries no siteId, so we take the requesting unit's current site. Those sites are
  //    then styled with a dotted ring on the map so an in-review request reads at a glance (CommandMap `inReview` prop).
  const permanentSiteIds = useMemo(() => [...new Set((current ?? []).filter((c) => c.kind !== 'TEMPORARY').map((c) => c.siteId))], [current]);
  const temporarySiteIds = useMemo(() => [...new Set(temporary.map((c) => c.siteId))], [temporary]);
  const reviewSiteIds = useMemo(() => {
    const siteByUnit = new Map<string, string>();
    for (const c of current ?? []) siteByUnit.set(c.orgId, c.siteId);
    const ids = new Set<string>();
    for (const r of requests ?? []) if (REVIEW.includes(r.state)) {
      const siteId = siteByUnit.get(r.requestingUnit.id);
      if (siteId) ids.add(siteId);
    }
    return [...ids];
  }, [requests, current]);
  const needsAttentionSites = useMemo(
    () => new Set<string>([...nearReturnStations.map((c) => c.siteId), ...oldReviewSites]),
    [nearReturnStations, oldReviewSites],
  );
  const siteById = useMemo(() => new Map(app.sites.map((s) => [s.id, s])), [app.sites]);

  // Selection: nothing, a site, a cluster, or a request from the attention list.
  type DashSelection = Selection | { kind: 'request'; requestId: string };
  const [selection, setSelection] = useState<DashSelection>({ kind: 'none' });
  const [highlight, setHighlight] = useState<readonly string[]>([]);
  const mapRef = useRef<MlMap | null>(null);

  const onSelect = (s: Selection) => {
    setSelection(s);
    setHighlight([]);
  };
  const pickRequest = (r: RestationingListItem) => {
    setSelection({ kind: 'request', requestId: r.id });
    // the list item does not carry the current and proposed site ids; a full read happens on «فتح الطلب»
    setHighlight([]);
  };
  const pickAttention = (ids: string[]) => {
    setSelection({ kind: 'none' });
    setHighlight(ids);
  };
  const expandCluster = async () => {
    if (selection.kind !== 'cluster' || !mapRef.current) return;
    const map = mapRef.current;
    const src = map.getSource('cmd') as GeoJSONSource | undefined;
    if (!src) return;
    try {
      const zoom = await src.getClusterExpansionZoom(selection.clusterId);
      map.easeTo({ center: [selection.lng, selection.lat], zoom: zoom + 0.5, duration: 600 });
      const leaves = await src.getClusterLeaves(selection.clusterId, Math.min(selection.count, 200), 0);
      const ids = leaves.map((f) => f.properties?.id as string).filter(Boolean);
      setHighlight(ids);
    } catch { /* cluster already expanded */ }
  };
  const clearHighlight = () => { setHighlight([]); setSelection({ kind: 'none' }); };
  // Owner, 21 Nov 2026: «عرض الموقع» zooms to the selected site on the dashboard map and keeps it selected instead of
  // navigating away to the Sites page. If the map isn't ready yet, the selection stays — opening the map later lands on it.
  const showSiteOnMap = (siteId: string) => {
    setSelection({ kind: 'site', siteId });
    setHighlight([]);
    const s = siteById.get(siteId);
    const loc = s?.location;
    const m = mapRef.current;
    if (m && loc) m.easeTo({ center: [loc.lng, loc.lat], zoom: Math.max(m.getZoom(), 14), duration: 600 });
  };

  // Empty installation: identity + guidance only (ADR-094).
  const empty = homeEmpty({ orgs: app.orgs.length, sites: app.sites.length, stationed: current, requests, cards: cards.length });
  if (empty) {
    return (
      <div className="tz-home tz-home-empty" data-testid="home-empty">
        <DashHeader app={app} role={role.title} />
        <section className="tz-dash-empty" aria-label="لا بيانات بعد">
          <p>لا بيانات في النظام بعد: لا وحدات ولا مواقع ولا تمركز.</p>
          {app.can('CONFIGURE') && <p className="muted">تبدأ من «إعدادات النظام ← مصدر الموارد البشرية»، ثم «تهيئة المواقع» و«إعادة التمركز».</p>}
        </section>
      </div>
    );
  }
  if (role.isNoAccess) {
    return (
      <div className="tz-home tz-home-empty" data-testid="home-zero-access">
        <DashHeader app={app} role="لا توجد لديك صلاحيات بعد" />
        <section className="tz-dash-card" style={{ padding: 24, textAlign: 'center' }}>
          <p>لم تُمنح صلاحيات لحسابك بعد.</p>
          <p className="muted">اطلب ما يلزمك من صفحة «طلب صلاحية».</p>
          <a className="button primary" href="#requestAccess">فتح «طلب صلاحية»</a>
        </section>
      </div>
    );
  }

  // The KPI strip: first the role's own urgent counts, then the shared operational state, then inventory last (owner §29).
  const stats: ReactNode[] = [];
  if (role.isConfig) {
    stats.push(<Stat key="review" testid="stat-review" icon="shield" tone={countOf(REVIEW) > 0 ? 'amber' : ''} value={ar(countOf(REVIEW))} label="طلبات قيد الاعتماد" href="#restationing" />);
    stats.push(<Stat key="returned" testid="stat-returned" icon="reset" value={ar(countOf(RETURNED))} label="طلبات معادة للتعديل" href="#restationing" />);
  } else if (role.isFinal || role.isOperations) {
    stats.push(<Stat key="awaiting" testid="stat-awaiting-signature" icon="shield" tone={finalWaiting > 0 ? 'amber' : ''} value={ar(finalWaiting)} label="بانتظار قراري النهائي" href="#review" />);
    stats.push(<Stat key="overdue" testid="stat-overdue" icon="clock" tone={overdueTasks > 0 ? 'red' : ''} value={ar(overdueTasks)} label="مهام فائتة الموعد" href="#review" />);
  } else if (role.isReviewer) {
    stats.push(<Stat key="tasks" testid="stat-tasks" icon="shield" tone={(tasks?.length ?? 0) > 0 ? 'amber' : ''} value={ar(tasks?.length ?? null)} label="مهام المراجعة" href="#review" />);
    stats.push(<Stat key="overdue" testid="stat-overdue" icon="clock" tone={overdueTasks > 0 ? 'red' : ''} value={ar(overdueTasks)} label="فائتة الموعد" href="#review" />);
  } else if (role.isAccess) {
    stats.push(<Stat key="access" testid="stat-access" icon="shield" tone={accessWaiting > 0 ? 'amber' : ''} value={ar(accessWaiting)} label="طلبات صلاحية بانتظار قرارك" href="#accessInbox" />);
    stats.push(<Stat key="returned" testid="stat-returned" icon="reset" value={ar(countOf(RETURNED))} label="طلبات معادة للتعديل" href="#restationing" />);
  } else if (role.isRequester) {
    stats.push(<Stat key="my-turn" testid="stat-my-turn" icon="file" tone={(mine?.length ?? 0) > 0 ? 'amber' : ''} value={ar(mine?.length ?? null)} label="طلباتي بانتظار قراري" href="#allRequests" />);
    stats.push(<Stat key="my-returned" testid="stat-my-returned" icon="reset" value={ar(myReturned)} label="طلبات معادة إليك" href="#allRequests" />);
  }
  if (canMap) {
    stats.push(<Stat key="temporary" testid="stat-temporary" icon="clock" tone={temporary.length > 0 ? 'green' : ''} value={ar(temporary.length)} label="التمركز المؤقت النشط" />);
    stats.push(<Stat key="stationed" testid="stat-stationed" icon="layers" value={ar(stationedUnits.size)} label="الوحدات المتمركزة حالياً" />);
  }
  if (canSites) stats.push(<Stat key="sites" testid="stat-sites" icon="building" value={ar(app.sites.length)} label="المواقع" href="#stationing" />);
  if (canUnits) stats.push(<Stat key="units" testid="stat-units" icon="units" value={ar(app.orgs.length)} label="الوحدات" href="#org" />);

  // Attention rows: each one lives as a clickable chip that filters the map and updates the right panel.
  const attention: { count: number; label: string; ids?: string[]; href?: string }[] = [];
  if ((role.isFinal || role.isOperations) && finalWaiting > 0) attention.push({ count: finalWaiting, label: 'طلبات تنتظر قرارك النهائي', href: '#review' });
  if (role.isReviewer && overdueTasks > 0) attention.push({ count: overdueTasks, label: 'مهام مراجعة فائتة الموعد', href: '#review' });
  if (role.isAccess && accessWaiting > 0) attention.push({ count: accessWaiting, label: 'طلبات صلاحية بانتظار قرارك', href: '#accessInbox' });
  if (role.isRequester && myReturned > 0) attention.push({ count: myReturned, label: 'طلبات أُعيدت إليك للتعديل', href: '#allRequests' });
  if ((role.isFinal || role.isOperations || role.isReviewer || role.isConfig) && oldReview > 0)
    attention.push({ count: oldReview, label: 'طلبات قيد الاعتماد منذ أكثر من 24 ساعة', ids: [...oldReviewSites] });
  if ((role.isOperations || role.isConfig) && nearReturnStations.length > 0)
    attention.push({ count: nearReturnStations.length, label: 'مواقع بتمركز مؤقت يقترب موعد انتهائها', ids: nearReturnStations.map((c) => c.siteId) });

  const recent = (requests ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const alerts = (notes ?? []).slice(0, 3);

  return (
    <div className="tz-dash tz-dash-v2" data-testid="home-dashboard" data-role={role.title}>
      <DashHeader app={app} role={role.title} />

      <section className="tz-dash-stats" aria-label="مؤشرات رئيسية">{stats}</section>

      <div className="tz-dash-grid tz-dash-grid-wide">
        {/* ---- LEFT: what needs attention, then latest requests, then latest alerts ------------ */}
        <aside className="tz-dash-side tz-dash-attention" aria-label="ما يحتاج انتباهك">
          <div className="tz-dash-card tz-attn" data-testid="attention-panel">
            <header><Icon name="alert" /> ما يحتاج انتباهك الآن</header>
            <ul>
              {attention.length === 0 && <li className="muted">لا يوجد ما يحتاج انتباهك.</li>}
              {attention.map((a, i) => {
                const active = a.ids && a.ids.length > 0 && a.ids.every((x) => highlight.includes(x)) && a.ids.length === highlight.length;
                const common = <><em className="tz-attn-badge">{ar(a.count)}</em> <span>{a.label}</span></>;
                if (a.ids && a.ids.length > 0)
                  return (
                    <li key={i}>
                      <button type="button" className={'tz-attn-row' + (active ? ' is-active' : '')} onClick={() => pickAttention(a.ids ?? [])} data-testid="attention-row">{common}</button>
                    </li>
                  );
                return <li key={i}>{a.href ? <a className="tz-attn-row" href={a.href}>{common}</a> : <span className="tz-attn-row">{common}</span>}</li>;
              })}
              {highlight.length > 0 && <li><button type="button" className="tz-attn-clear" onClick={clearHighlight}>إلغاء التصفية</button></li>}
            </ul>
          </div>

          {role.isConfig && healthSummary && (
            <div className="tz-dash-card" data-testid="system-health-widget">
              <header className="tz-dash-card-head">
                <h3>صحة النظام</h3>
                <a className="tz-link" href="#requestHealth">فتح ←</a>
              </header>
              <ul className="tz-attn-list">
                {healthSummary.stuck > 0 && <li><em className="tz-attn-badge" style={{ background: '#9a2a22' }}>{ar(healthSummary.stuck)}</em> <a className="tz-attn-row" href="#requestHealth">طلبات متوقفة بشكل غير طبيعي</a></li>}
                {healthSummary.warning > 0 && <li><em className="tz-attn-badge">{ar(healthSummary.warning)}</em> <a className="tz-attn-row" href="#requestHealth">طلبات تحتاج انتباه</a></li>}
                {healthSummary.outboxFailed > 0 && <li><em className="tz-attn-badge" style={{ background: '#9a2a22' }}>{ar(healthSummary.outboxFailed)}</em> <a className="tz-attn-row" href="#requestHealth">حدث تمركز فشل تسليمه</a></li>}
                {healthSummary.peopleWithoutLocalUnit > 0 && <li><em className="tz-attn-badge">{ar(healthSummary.peopleWithoutLocalUnit)}</em> <span className="tz-attn-row">أشخاص بلا وحدة محلية</span></li>}
                {healthSummary.stuck === 0 && healthSummary.warning === 0 && healthSummary.outboxFailed === 0 && healthSummary.peopleWithoutLocalUnit === 0 && (
                  <li className="muted">كل الطلبات المفتوحة سليمة.</li>
                )}
              </ul>
            </div>
          )}

          {(canRs || role.isRequester || role.isReviewer || role.isFinal) && (
            <div className="tz-dash-card">
              <header className="tz-dash-card-head"><h3>آخر طلبات إعادة التمركز</h3>{canRs && <a className="tz-link" href="#restationing">عرض الكل ←</a>}</header>
              <ul className="tz-reqs">
                {recent.length === 0 && <li className="muted">لا طلبات ضمن نطاقك.</li>}
                {recent.map((r) => (
                  <li key={r.id}>
                    <button type="button" data-testid="recent-request" className={'tz-req-row' + (selection.kind === 'request' && selection.requestId === r.id ? ' is-active' : '')} onClick={() => pickRequest(r)}>
                      <div className="tz-req-head"><StatePill state={r.state} /><small className="muted">{timeAgo(r.updatedAt)}</small></div>
                      <b>{r.number}</b>
                      <small className="muted">{r.requestingUnit.name}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="tz-dash-card">
            <header className="tz-dash-card-head"><h3>أحدث التنبيهات</h3><a className="tz-link" href="#audit">سجل التدقيق ←</a></header>
            <ul className="tz-alerts">
              {alerts.length === 0 && <li className="muted">لا تنبيهات جديدة.</li>}
              {alerts.map((n) => (
                <li key={n.id}><Icon name="bell" /><div><b>{n.title}</b><small className="muted">{timeAgo(n.createdAt)}</small></div></li>
              ))}
            </ul>
          </div>
        </aside>

        {/* ---- MAP centre (owner §7 — dominant area) -------------------------------------------------- */}
        <section className="tz-dash-centre" aria-label="الخريطة">
          <div className="tz-dash-maptool">
            <button className="tz-mapbtn" title="طبقات" aria-label="طبقات"><Icon name="layers" /></button>
            <button className="tz-mapbtn" title="الفلاتر" aria-label="الفلاتر"><Icon name="filter" /></button>
            <select className="tz-mapselect" aria-label="عرض حسب" defaultValue="sites">
              <option value="sites">عرض حسب: المواقع</option>
              <option value="units">عرض حسب: التمركز</option>
              <option value="state">عرض حسب: حالة الطلب</option>
            </select>
            {highlight.length > 0 && (
              <span className="tz-dash-filtertag">يُعرض {ar(highlight.length)} موقعاً مرتبطاً <button type="button" onClick={clearHighlight}>مسح</button></span>
            )}
          </div>
          <div className="tz-dash-mapbox">
            {canMap ? (
              <Suspense fallback={<p className="muted" style={{ padding: 16 }}>جارٍ تحميل الخريطة…</p>}>
                <CommandMap
                  sites={app.sites}
                  current={current ?? []}
                  highlight={highlight}
                  warning={[...needsAttentionSites]}
                  inReview={reviewSiteIds}
                  selection={selection.kind === 'request' ? { kind: 'none' } : selection}
                  onSelect={onSelect}
                  onMap={(m) => { mapRef.current = m; }}
                />
              </Suspense>
            ) : (
              <p className="muted" style={{ padding: 16 }}>لا تملك عرض الخريطة.</p>
            )}
          </div>
          <footer className="tz-dash-legend">
            <b>مفتاح الخريطة</b>
            <span><i className="tz-swatch" style={{ background: 'var(--home-accent)' }} /> موقع</span>
            <span><i className="tz-swatch tz-swatch-cluster" /> تجمع مواقع (عدد)</span>
            <span><i className="tz-swatch" style={{ background: '#d97706' }} /> يحتاج انتباه</span>
            <span><i className="tz-swatch tz-swatch-selected" /> الموقع المحدد</span>
          </footer>
        </section>

        {/* ---- RIGHT: contextual — summary, site, cluster or request --------------------------------- */}
        <aside className="tz-dash-side tz-dash-details" aria-label="تفاصيل" data-selection={selection.kind}>
          <ContextualPanel
            selection={selection}
            siteById={siteById}
            requests={requests ?? []}
            current={current ?? []}
            stationedUnits={stationedUnits.size}
            review={countOf(REVIEW)}
            temporary={temporary.length}
            sitesCount={app.sites.length}
            needsAttentionSites={needsAttentionSites}
            role={role}
            finalWaiting={finalWaiting}
            overdueTasks={overdueTasks}
            accessWaiting={accessWaiting}
            myOpen={mine?.length ?? 0}
            onExpandCluster={expandCluster}
            onClear={clearHighlight}
            onFilter={pickAttention}
            activeHighlight={highlight}
            permanentSiteIds={permanentSiteIds}
            temporarySiteIds={temporarySiteIds}
            reviewSiteIds={reviewSiteIds}
            onShowOnMap={showSiteOnMap}
          />
        </aside>
      </div>
    </div>
  );
}

function DashHeader({ app, role }: { app: ReturnType<typeof useApp>; role: string }) {
  return (
    <header className="tz-dash-hero" aria-label="منصة تمركز">
      <div className="tz-dash-hero-bg" aria-hidden />
      <div className="tz-dash-hero-title">
        <BrandMark size={44} />
        <div>
          <h1>منصة إدارة التمركز والمواقع والاعتمادات</h1>
          <p>{app.me.displayName} · <b data-testid="dashboard-role">{role}</b>{app.me.primaryOrg ? ' · ' + app.me.primaryOrg.name : ''}</p>
        </div>
      </div>
    </header>
  );
}

type DashSel = Selection | { kind: 'request'; requestId: string };

/** The right panel that answers «what is it» and «what may I do about it» (owner §17–§21). */
function ContextualPanel({ selection, siteById, requests, current, stationedUnits, review, temporary, sitesCount, needsAttentionSites, role, finalWaiting, overdueTasks, accessWaiting, myOpen, onExpandCluster, onClear, onFilter, activeHighlight, permanentSiteIds, temporarySiteIds, reviewSiteIds, onShowOnMap }: {
  selection: DashSel;
  siteById: Map<string, Site>;
  requests: RestationingListItem[];
  current: StationingRecord[];
  stationedUnits: number;
  review: number;
  temporary: number;
  sitesCount: number;
  needsAttentionSites: Set<string>;
  role: ReturnType<typeof useRoleData>;
  finalWaiting: number;
  overdueTasks: number;
  accessWaiting: number;
  myOpen: number;
  onExpandCluster: () => void;
  onClear: () => void;
  onFilter: (ids: string[]) => void;
  activeHighlight: readonly string[];
  permanentSiteIds: string[];
  temporarySiteIds: string[];
  reviewSiteIds: string[];
  onShowOnMap: (siteId: string) => void;
}) {
  const filterActive = (ids: string[]) => ids.length > 0 && ids.length === activeHighlight.length && ids.every((x) => activeHighlight.includes(x));
  if (selection.kind === 'site') {
    const s = siteById.get(selection.siteId);
    if (!s) return null;
    const stations = current.filter((c) => c.siteId === s.id);
    const temp = stations.filter((c) => c.kind === 'TEMPORARY');
    const permanent = stations.length - temp.length;
    const siteRequests: RestationingListItem[] = [];
    return (
      <>
        <h3 className="tz-dash-side-head"><Icon name="pin" /> تفاصيل الموقع <button className="tz-link" type="button" onClick={onClear}>✕</button></h3>
        <div className="tz-dash-card tz-site" data-testid="site-detail">
          <div className="tz-site-cover" aria-hidden><Icon name="building" /></div>
          <div className="tz-site-head">
            <b>{s.name}</b>
            <small className="muted">{s.responsibleOrg?.name ?? '—'}{s.code ? ' · ' + s.code : ''}</small>
            <span className={'pill ' + (stations.length > 0 ? 'green' : '')}>{stations.length > 0 ? 'متمركز حالياً' : 'بدون تمركز'}</span>
          </div>
          <div className="tz-site-chips">
            <span><b>1</b><small>عدد المواقع</small></span>
            <span><b>{ar(stations.length)}</b><small>الوحدات المتمركزة</small></span>
            <span><b>{ar(siteRequests.filter((r) => REVIEW.includes(r.state)).length)}</b><small>طلبات قيد الاعتماد</small></span>
          </div>
          <section><h4>ملخص الحالة</h4>
            <ul className="tz-site-rows">
              <li><span>وحدات بتمركز دائم</span><span className="pill">{ar(permanent)}</span></li>
              <li><span>وحدات بتمركز مؤقت</span><span className="pill">{ar(temp.length)}</span></li>
              <li><span>طلبات إعادة تمركز نشطة</span><span className="pill">{siteRequests.filter((r) => REVIEW.includes(r.state)).length > 0 ? ar(siteRequests.filter((r) => REVIEW.includes(r.state)).length) : 'لا توجد'}</span></li>
            </ul>
          </section>
          <section><h4>إجراءات سريعة</h4>
            <div className="tz-site-actions">
              <button type="button" className="button primary" data-testid="site-show-on-map" onClick={() => onShowOnMap(s.id)}>عرض الموقع على الخريطة</button>
              <a className="button" href={'#stationing?site=' + s.id}>فتح صفحة الموقع</a>
              {role.isRequester && <a className="button" href={'#restationing/new?site=' + s.id + '&purpose=RESTATIONING'}>إنشاء طلب إعادة تمركز</a>}
            </div>
          </section>
        </div>
      </>
    );
  }
  if (selection.kind === 'cluster') {
    // Everything inside this cluster: a count summary, then «تكبير وعرض المواقع».
    return (
      <>
        <h3 className="tz-dash-side-head"><Icon name="layers" /> ملخص التجمع <button className="tz-link" type="button" onClick={onClear}>✕</button></h3>
        <div className="tz-dash-card tz-site" data-testid="cluster-detail">
          <div className="tz-site-head">
            <b>مجموعة مواقع</b>
            <small className="muted">المواقع مجمَّعة على مستوى التكبير الحالي</small>
          </div>
          <div className="tz-site-chips">
            <span><b>{ar(selection.count)}</b><small>موقعاً</small></span>
          </div>
          <section><h4>إجراءات سريعة</h4>
            <div className="tz-site-actions">
              <button type="button" className="button primary" onClick={onExpandCluster} data-testid="cluster-expand">تكبير وعرض المواقع</button>
            </div>
          </section>
          <p className="muted" style={{ fontSize: 12 }}>التكبير يوزع المواقع إلى علامات فردية؛ لا تُعرض كل الأسماء إلا على مستوى قريب.</p>
        </div>
      </>
    );
  }
  if (selection.kind === 'request') {
    const r = requests.find((x) => x.id === selection.requestId);
    if (!r) return null;
    return (
      <>
        <h3 className="tz-dash-side-head"><Icon name="file" /> تفاصيل الطلب <button className="tz-link" type="button" onClick={onClear}>✕</button></h3>
        <div className="tz-dash-card tz-site" data-testid="request-detail">
          <div className="tz-site-head">
            <b>{r.number}</b>
            <small className="muted">{r.requestingUnit.name}</small>
            <StatePill state={r.state} />
          </div>
          <section><h4>المسار</h4>
            <ul className="tz-site-rows">
              <li><span>الوحدة الطالبة</span><span>{r.requestingUnit.name}</span></li>
              <li><span>النوع</span><span>{r.kind === 'TEMPORARY' ? 'مؤقت' : r.kind === 'EXTENSION' ? 'تمديد' : 'دائم'}</span></li>
              {r.currentStage && <li><span>المرحلة</span><span>{r.currentStage}</span></li>}
            </ul>
          </section>
          <section><h4>إجراءات سريعة</h4>
            <div className="tz-site-actions">
              <a className="button primary" href={'#restationing/' + r.id}>فتح الطلب</a>
            </div>
          </section>
        </div>
      </>
    );
  }
  // No selection — a summary of the current situation (owner §21).
  return (
    <>
      <h3 className="tz-dash-side-head"><Icon name="target" /> ملخص الوضع الحالي</h3>
      <div className="tz-dash-card tz-site">
        <div className="tz-site-chips">
          <span><b>{ar(sitesCount)}</b><small>المواقع</small></span>
          <span><b>{ar(stationedUnits)}</b><small>وحدات متمركزة</small></span>
          <span><b>{ar(needsAttentionSites.size)}</b><small>تحتاج انتباه</small></span>
        </div>
        <section><h4>ملخص الحالة</h4>
          <ul className="tz-site-rows">
            <li>
              <button type="button" className={'tz-summary-row' + (filterActive(permanentSiteIds) ? ' is-active' : '')} data-testid="summary-permanent" onClick={() => onFilter(permanentSiteIds)} disabled={permanentSiteIds.length === 0} title="تصفية الخريطة على مواقع التمركز الدائم">
                <span>وحدات بتمركز دائم</span><span className="pill">{ar(Math.max(stationedUnits - temporary, 0))}</span>
              </button>
            </li>
            <li>
              <button type="button" className={'tz-summary-row' + (filterActive(temporarySiteIds) ? ' is-active' : '')} data-testid="summary-temporary" onClick={() => onFilter(temporarySiteIds)} disabled={temporarySiteIds.length === 0} title="تصفية الخريطة على مواقع التمركز المؤقت">
                <span>وحدات بتمركز مؤقت</span><span className="pill">{ar(temporary)}</span>
              </button>
            </li>
            <li>
              {review > 0 && reviewSiteIds.length > 0 ? (
                <button type="button" className={'tz-summary-row' + (filterActive(reviewSiteIds) ? ' is-active' : '')} data-testid="summary-review" onClick={() => onFilter(reviewSiteIds)} title="تصفية الخريطة على مواقع الطلبات قيد الاعتماد (علامتها خط منقّط)">
                  <span><i className="tz-dotted-dot" aria-hidden="true" /> طلبات قيد الاعتماد</span><span className="pill">{ar(review)}</span>
                </button>
              ) : review > 0 ? (
                <a className="tz-summary-row" data-testid="summary-review" href="#allRequests" title="فتح الطلبات قيد الاعتماد">
                  <span>طلبات قيد الاعتماد</span><span className="pill">{ar(review)}</span>
                </a>
              ) : (
                <span className="tz-summary-row is-plain"><span>طلبات قيد الاعتماد</span><span className="pill">لا توجد</span></span>
              )}
            </li>
            {!role.isConfig && (role.isFinal || role.isOperations) && <li><span className="tz-summary-row is-plain"><span>بانتظار قرارك</span><span className="pill">{ar(finalWaiting)}</span></span></li>}
            {!role.isConfig && role.isReviewer && <li><span className="tz-summary-row is-plain"><span>مهام فائتة</span><span className="pill">{ar(overdueTasks)}</span></span></li>}
            {!role.isConfig && role.isAccess && <li><span className="tz-summary-row is-plain"><span>طلبات صلاحية</span><span className="pill">{ar(accessWaiting)}</span></span></li>}
            {!role.isConfig && role.isRequester && <li><span className="tz-summary-row is-plain"><span>طلباتي بانتظار قراري</span><span className="pill">{ar(myOpen)}</span></span></li>}
            {activeHighlight.length > 0 && <li><button type="button" className="tz-summary-clear" onClick={onClear}>إلغاء التصفية على الخريطة</button></li>}
          </ul>
        </section>
        <section><h4>إجراءات سريعة</h4>
          <div className="tz-site-actions">
            {(role.isFinal || role.isReviewer || role.isOperations) && <a className="button primary" href="#review">فتح صندوق المراجعة</a>}
            {role.isAccess && <a className="button primary" href="#accessInbox">طلبات الصلاحية</a>}
            {role.isRequester && <a className="button" href="#newRequest">تقديم طلب جديد</a>}
            {role.isConfig && <a className="button" href="#settings">الإعدادات</a>}
            <a className="button" href="#stationing">عرض المواقع</a>
          </div>
        </section>
      </div>
    </>
  );
}

function timeAgo(when: string): string {
  const t = Date.now() - new Date(when).getTime();
  if (t < 60_000) return 'الآن';
  if (t < 60 * 60_000) return `منذ ${Math.floor(t / 60_000)} دقيقة`;
  if (t < DAY) return `منذ ${Math.floor(t / 3_600_000)} ساعة`;
  const d = Math.floor(t / DAY);
  return d < 2 ? 'منذ يوم' : `منذ ${d} أيام`;
}

export default HomePage;
