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

// Stationing V3 (behind VITE_STATIONING_V3): loaded on demand, so the offline map code is a separate chunk
const StationingPolicyPage = lazy(() => import('./pages/StationingPolicyPage').then((m) => ({ default: m.StationingPolicyPage })));
const RestationingPage = lazy(() => import('./pages/RestationingPage').then((m) => ({ default: m.RestationingPage })));

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
  };
  const links = useMemo(() => primaryNav(can, me.summaryOnly), [can, me.summaryOnly]);
  const more = useMemo(() => moreNav(can, me.summaryOnly), [can, me.summaryOnly]);
  // the operational views fill the screen below the top bar; every other page keeps its own layout inside the shell
  const console = view === 'home' || view === 'restationing' || view === 'stationing';
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
      <div className={'tz-app' + (console ? ' is-console' : ' is-page')} data-view={view}>
        <a className="tz-skip" href="#main">تخطي إلى المحتوى</a>
        <TopNavigation me={me} view={view} links={links} more={more} onLogout={logout} navOpen={navOpen} setNavOpen={setNavOpen} />
        <button id="navShade" className="nav-shade" aria-label="إغلاق القائمة" onClick={() => setNavOpen(false)} hidden={!navOpen} />
        <main id="main" className="tz-main" tabIndex={-1}>
          <ScreenBoundary resetKey={view}>{restriction(view, can, me.summaryOnly) ? <NoAccess /> : pages[view]()}</ScreenBoundary>
        </main>
      </div>
      <RequestWizard request={wizard} update={wizardUpdate} onUpdateHandled={() => setWizardUpdate(null)} onClose={() => (setWizard(null), setWizardUpdate(null))} />
      <div id="toast" className="toast" role="status" hidden={!toastMsg}>
        {toastMsg}
      </div>
    </AppContext.Provider>
  );
}
