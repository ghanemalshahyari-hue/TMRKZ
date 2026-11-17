import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, onUnauthorized } from './api/client';
import type { Me, OrgNode, Permission, RequestType, Settings, Site } from './api/types';
import { RequestWizard } from './components/RequestWizard';
import { TopNavigation } from './components/shell/TopNavigation';
import { NoAccess, ScreenBoundary } from './components/ui';
import { AppContext, NAV, flattenOrgs, type AppContextValue, type View, type WizardRequest } from './lib/app';
import { todayDubai } from './lib/dates';
import { clearMapContexts } from './lib/mapState';
import { moreNav, primaryNav, restriction } from './lib/navigation';
import { AccessInboxPage } from './pages/AccessInboxPage';
import { AccessRequestPage } from './pages/AccessRequestPage';
import { AllRequestsPage } from './pages/AllRequestsPage';
import { NewRequestPage } from './pages/NewRequestPage';
import { AuditPage } from './pages/AuditPage';
import { CalendarPage } from './pages/CalendarPage';
import { DocsPage } from './pages/DocsPage';
import { HomePage } from './pages/HomePage';
import { FormStudio } from './pages/FormStudio';
import { LoginPage } from './pages/LoginPage';
import { OrgPage } from './pages/OrgPage';
import { PermissionsPage } from './pages/PermissionsPage';
import { RequestsPage } from './pages/RequestsPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { SitesPage } from './pages/SitesPage';
import { WorkflowStudio } from './pages/WorkflowStudio';
import { clearDesktopUser, startDesktopNotifications } from './lib/desktopNotifications';
import { LAST_VIEW_KEY } from './lib/support';
import { setGrantFacts, setSupportSeat } from './lib/navigation';
import { setSiteSetupRule } from './lib/stationingHub';
import { SupportConsolePage } from './pages/SupportConsolePage';
import { SupportPage } from './pages/SupportPage';
import { FloatingAssist } from './components/assist/FloatingAssist';

// Stationing V3 (behind VITE_STATIONING_V3): loaded on demand, so the offline map code is a separate chunk
const StationingPolicyPage = lazy(() => import('./pages/StationingPolicyPage').then((m) => ({ default: m.StationingPolicyPage })));
const RestationingPage = lazy(() => import('./pages/RestationingPage').then((m) => ({ default: m.RestationingPage })));
const PosturePage = lazy(() => import('./pages/PosturePage').then((m) => ({ default: m.PosturePage })));
const SiteSetupPage = lazy(() => import('./pages/SiteSetupPage').then((m) => ({ default: m.SiteSetupPage })));

const POLL_MS = 30_000;

/**
 * The address names the view. An empty address opens the home dashboard; the retired «الخريطة والمرافق» route and any
 * unknown one open «المواقع» (#stationing), and the address shows the real route.
 */
function viewFromHash(): View {
  const next = location.hash.replace('#', '').split('/')[0];
  if (next === 'home' || !next) return 'home';
  if (NAV.some(([id]) => id === next)) return next as View;
  history.replaceState(null, '', '#stationing');
  return 'stationing';
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
    return onUnauthorized(() => setMe(null));
  }, []);

  // desktop notifications as in TNQL (ADR-050): for the signed-in person; at the sign-in page every toast closes
  useEffect(() => {
    if (checking) return;
    if (!me) return clearDesktopUser();
    return startDesktopNotifications(me.id);
  }, [checking, me?.id]);

  if (checking) return <div className="login-shell"><div className="empty">جارٍ التحقق من الجلسة…</div></div>;
  if (!me) return <LoginPage onLogin={setMe} />;
  return <Workspace me={me} setMe={setMe} />;
}

function Workspace({ me, setMe }: { me: Me; setMe: (m: Me | null) => void }) {
  const [view, setView] = useState<View>(viewFromHash);
  const [revision, setRevision] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [wizard, setWizard] = useState<WizardRequest | null>(null);
  const [wizardUpdate, setWizardUpdate] = useState<(WizardRequest & { key: number }) | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [mapDate, setMapDate] = useState(() => todayDubai());
  const [sites, setSites] = useState<Site[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const [orgTree, setOrgTree] = useState<OrgNode[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [counts, setCounts] = useState({ tasks: 0, submitted: 0 });
  const [navOpen, setNavOpen] = useState(false);
  const [requestSlot, setRequestSlot] = useState<HTMLElement | null>(null);

  const can = useCallback((p: Permission) => me.permissions.includes(p), [me]);
  const toast = useCallback((message: string) => {
    setToastMsg(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 4500);
  }, []);
  const bump = useCallback(() => setRevision((r) => r + 1), []);
  const refreshMe = useCallback(async () => {
    setMe(await api.me());
    bump();
  }, [setMe, bump]);
  const navigate = useCallback((v: View) => {
    location.hash = v;
  }, []);

  useEffect(() => {
    const onHash = () => {
      setView(viewFromHash());
      setNavOpen(false);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle('nav-open', navOpen);
  }, [navOpen]);

  // «مركز الدعم» (ADR-053): a report names the screen the person came from; the console opens for a support seat
  useEffect(() => {
    if (view === 'support' || view === 'supportConsole') return;
    try {
      sessionStorage.setItem(LAST_VIEW_KEY, view);
    } catch {
      /* private window */
    }
  }, [view]);
  setSupportSeat(me.supportSeat);
  setSiteSetupRule(me.siteSetup);
  setGrantFacts(me.grants);

  // reference data shared by screens; reloaded after mutations and identity changes
  // each list is asked for only with a right its endpoint accepts (a user holding one single action asks for none)
  useEffect(() => {
    const any = (...p: Permission[]) => p.some((x) => me.permissions.includes(x));
    if (any('VIEW', 'VIEW_SUMMARY', 'MANAGE_FACILITIES')) api.sites().then(setSites).catch(() => setSites([]));
    else setSites([]);
    if (any('VIEW', 'VIEW_SUMMARY', 'CREATE', 'CONFIGURE')) api.requestTypes().then(setRequestTypes).catch(() => setRequestTypes([]));
    else setRequestTypes([]);
    if (any('VIEW', 'VIEW_SUMMARY', 'MANAGE_ACCESS', 'MANAGE_FACILITIES', 'CONFIGURE')) api.orgTree().then(setOrgTree).catch(() => setOrgTree([]));
    else setOrgTree([]);
    api
      .policy()
      .then((p) => setSettings(p.settings))
      .catch(() => setSettings(null));
  }, [revision, me.id]);

  // short polling for counts; every call is scoped server-side, so revoked access stops updates immediately
  useEffect(() => {
    let live = true;
    const load = () => {
      Promise.all([
        can('REVIEW') ? api.tasks().then((t) => t.length).catch(() => 0) : Promise.resolve(0),
        me.summaryOnly ? Promise.resolve(0) : api.requests({ status: 'SUBMITTED', size: 1 }).then((p) => p.total).catch(() => 0),
      ]).then(([tasks, submitted]) => live && setCounts({ tasks, submitted }));
    };
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [revision, me, can]);

  const orgs = useMemo(() => flattenOrgs(orgTree), [orgTree]);

  const ctx: AppContextValue = {
    me,
    refreshMe,
    can,
    summaryOnly: me.summaryOnly,
    toast,
    openWizard: (w) => {
      if (!can('CREATE')) return toast('لا تملك صلاحية إنشاء الطلبات');
      // A new map selection while a map draft is open is shown to the user as a change before it is applied.
      if (wizard && wizard.layout === 'drawer' && w.prefill && !w.requestId && !wizard.requestId) {
        setWizardUpdate({ ...w, key: Date.now() });
        return;
      }
      setWizardUpdate(null);
      setWizard(w);
    },
    revision,
    bump,
    selectedSiteId,
    setSelectedSiteId,
    selectedRequestId,
    setSelectedRequestId,
    mapDate,
    setMapDate,
    sites,
    requestTypes,
    orgs,
    settings,
    counts,
    navigate,
    requestSlot,
    setRequestSlot,
    wizardActive: !!wizard && wizard.layout === 'drawer',
  };

  const pages: Record<View, () => ReactNode> = {
    home: () => <HomePage />,
    stationing: () => <SitesPage />,
    stationingPolicy: () => (
      <Suspense fallback={<div className="empty">جارٍ التحميل…</div>}>
        <StationingPolicyPage />
      </Suspense>
    ),
    restationing: () => (
      <Suspense fallback={<div className="empty">جارٍ تحميل الخريطة…</div>}>
        <RestationingPage />
      </Suspense>
    ),
    newRequest: () => <NewRequestPage />,
    allRequests: () => <AllRequestsPage />,
    posture: () => (
      <Suspense fallback={<div className="empty">جارٍ تحميل الخريطة…</div>}>
        <PosturePage />
      </Suspense>
    ),
    siteSetup: () => (
      <Suspense fallback={<div className="empty">جارٍ تحميل الخريطة…</div>}>
        <SiteSetupPage />
      </Suspense>
    ),
    requests: () => <RequestsPage />,
    review: () => <ReviewPage />,
    calendar: () => <CalendarPage />,
    org: () => <OrgPage />,
    workflow: () => <WorkflowStudio />,
    forms: () => <FormStudio />,
    permissions: () => <PermissionsPage />,
    settings: () => <SettingsPage />,
    audit: () => <AuditPage />,
    docs: () => <DocsPage />,
    requestAccess: () => <AccessRequestPage />,
    accessInbox: () => <AccessInboxPage />,
    support: () => <SupportPage />,
    supportConsole: () => <SupportConsolePage />,
  };
  // signing in is not a permission: a person with none has only the page to ask (ADR-044)
  const noAccess = me.permissions.length === 0;
  // «مركز الدعم» stays open to someone with no permission yet: they are the ones who most need help. Nothing else — not even a
  // request sent to them «للعلم» (owner, 16 Nov 2026: «request page and support only»); the server refuses the rest
  const shownView: View = noAccess && view !== 'support' ? 'requestAccess' : view;
  const links = useMemo(
    () => (noAccess ? [{ view: 'requestAccess' as View, label: 'طلب صلاحية', icon: 'shield' }, { view: 'support' as View, label: 'مركز الدعم', icon: 'help' }] : primaryNav(can, me.summaryOnly)),
    [can, me.summaryOnly, noAccess],
  );
  const more = useMemo(() => (noAccess ? [] : moreNav(can, me.summaryOnly)), [can, me.summaryOnly, noAccess]);
  // the operational views fill the screen below the top bar; every other page keeps its own layout inside the shell
  const console = shownView === 'home' || shownView === 'restationing' || shownView === 'stationing' || shownView === 'posture' || shownView === 'siteSetup';
  const logout = async () => {
    let target = '/';
    try {
      target = (await api.logout()).redirect || '/';
    } finally {
      clearMapContexts();
      setMe(null);
      window.location.assign(target);
    }
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className={'tz-app' + (console ? ' is-console' : ' is-page')} data-view={shownView}>
        <a className="tz-skip" href="#main">تخطي إلى المحتوى</a>
        <TopNavigation me={me} view={shownView} links={links} more={more} onLogout={logout} navOpen={navOpen} setNavOpen={setNavOpen} />
        <button id="navShade" className="nav-shade" aria-label="إغلاق القائمة" onClick={() => setNavOpen(false)} hidden={!navOpen} />
        <main id="main" className="tz-main" tabIndex={-1}>
          <ScreenBoundary resetKey={shownView}>{restriction(shownView, can, me.summaryOnly) ? <NoAccess /> : pages[shownView]()}</ScreenBoundary>
        </main>
      </div>
      {/* TNQL's floating «الدعم» and «المساعد الذكي» on every signed-in screen (ADR-056) */}
      <FloatingAssist view={shownView} />
      <RequestWizard request={wizard} update={wizardUpdate} onUpdateHandled={() => setWizardUpdate(null)} onClose={() => (setWizard(null), setWizardUpdate(null))} />
      <div id="toast" className="toast" role="status" hidden={!toastMsg}>
        {toastMsg}
      </div>
    </AppContext.Provider>
  );
}
