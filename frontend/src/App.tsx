import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, onUnauthorized } from './api/client';
import type {Me, Notification, OrgNode, Permission, RequestType, Settings, Site } from './api/types';
import { RequestWizard } from './components/RequestWizard';
import { Icon, NoAccess } from './components/ui';
import { AppContext, NAV, flattenOrgs, type AppContextValue, type View, type WizardRequest } from './lib/app';
import { fullTime, todayDubai } from './lib/dates';
import { AuditPage } from './pages/AuditPage';
import { CalendarPage } from './pages/CalendarPage';
import { DocsPage } from './pages/DocsPage';
import { FormStudio } from './pages/FormStudio';
import { LoginPage } from './pages/LoginPage';
import { MapPage } from './pages/MapPage';
import { OrgPage } from './pages/OrgPage';
import { PermissionsPage } from './pages/PermissionsPage';
import { RequestsPage } from './pages/RequestsPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { WorkflowStudio } from './pages/WorkflowStudio';

const POLL_MS = 30_000;

function viewFromHash(): View {
  const next = location.hash.replace('#', '').split('/')[0] || 'map';
  return (NAV.some(([id]) => id === next) ? next : 'map') as View;
}

/** Server-enforced permissions decide what each screen shows; this mirrors them for navigation only. */
function restriction(view: View, can: (p: Permission) => boolean, summaryOnly: boolean): boolean {
  if (view === 'docs') return false;
  if (['workflow', 'forms', 'settings'].includes(view)) return !can('CONFIGURE');
  if (view === 'permissions') return !can('MANAGE_ACCESS');
  if (view === 'org') return !(can('VIEW') || can('MANAGE_ACCESS') || can('MANAGE_FACILITIES') || can('CONFIGURE'));
  if (['map', 'calendar'].includes(view)) return !(can('VIEW') || can('VIEW_SUMMARY') || can('MANAGE_FACILITIES'));
  if (summaryOnly) return true;
  if (view === 'review') return !can('REVIEW');
  if (view === 'audit') return !can('AUDIT');
  return !(can('VIEW') || can('CREATE'));
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
  if (!me) return <LoginPage />;
  return <Workspace me={me} setMe={setMe} />;
}

function Workspace({ me, setMe }: { me: Me; setMe: (m: Me | null) => void }) {
  const [view, setView] = useState<View>(viewFromHash);
  const [revision, setRevision] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [wizard, setWizard] = useState<WizardRequest | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [mapDate, setMapDate] = useState(() => todayDubai());
  const [sites, setSites] = useState<Site[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const [orgTree, setOrgTree] = useState<OrgNode[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [counts, setCounts] = useState({ tasks: 0, submitted: 0 });
  const [navOpen, setNavOpen] = useState(false);

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
  useEffect(() => {
    api.sites().then(setSites).catch(() => setSites([]));
    api.requestTypes().then(setRequestTypes).catch(() => setRequestTypes([]));
    api.orgTree().then(setOrgTree).catch(() => setOrgTree([]));
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
  };

  const pages: Record<View, () => ReactNode> = {
    map: () => <MapPage />,
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
  const title = NAV.find(([id]) => id === view)?.[2] ?? 'مساحة العمل';

  return (
    <AppContext.Provider value={ctx}>
      <div className="demo-ribbon">
        <span>
          <i /> TMRKZ · تشغيل داخل شبكة معزولة
        </span>
        <a href="#docs">التوثيق والتشغيل ↖</a>
        <a href="/docs/handoff/START_HERE.md">حزمة التسليم الأصلية ↓</a>
      </div>
      <aside id="sidebar" className="sidebar">
        <a className="brand" href="#map">
          <span className="brand-logo">
            <Icon name="map" />
          </span>
          <span>
            <strong>
              MOVER<span>.</span>
            </strong>
            <small>المواقع · المرافق · الإجراءات</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-icon">م</span>
          <span>
            <b>مجمع المؤسسة</b>
            <small>{me.primaryOrg?.name ?? 'مساحة عمل تشغيلية'}</small>
          </span>
          <span className="workspace-caret">⌄</span>
        </div>
        <span className="nav-section">مساحة العمل</span>
        <nav id="navigation" aria-label="القائمة الرئيسية">
          {NAV.map(([id, ico, label], i) => (
            <Fragment key={id}>
              {i === 5 && <div className="nav-divider" />}
              <a className={'nav-item ' + (view === id ? 'active' : '')} href={'#' + id}>
                <Icon name={ico} />
                <span>{label}</span>
                {id === 'review' && <span className="nav-count">{counts.tasks}</span>}
                {id === 'requests' && <span className="nav-count">{counts.submitted}</span>}
              </a>
            </Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="environment-dot" />
          <span>
            خادم محلي داخل الشبكة
            <br />
            <small>الحفظ في قاعدة البيانات · {me.timezone}</small>
          </span>
          <span className="version">v1.0</span>
        </div>
      </aside>
      <button id="navShade" className="nav-shade" aria-label="إغلاق القائمة" onClick={() => setNavOpen(false)} hidden={!navOpen} />
      <div className="app-shell">
        <header className="app-header">
          <button className="icon-button mobile-menu" onClick={() => setNavOpen((o) => !o)} aria-label="فتح القائمة">
            ☰
          </button>
          <div className="breadcrumb">
            <span>مجمع المؤسسة</span>
            <i>/</i>
            <b id="breadcrumbTitle">{title}</b>
          </div>
          <div className="header-actions">
            <Notifications />
            <a className="text-link handoff-link" href="#docs">
              دليل التشغيل
            </a>
            <button className="button primary compact" onClick={() => ctx.openWizard({ origin: 'LIST' })} disabled={!can('CREATE')}>
              <span>＋</span>طلب جديد
            </button>
            <IdentitySwitch me={me} setMe={setMe} onSwitched={bump} toast={toast} />
            <span className="avatar" id="roleAvatar" title={me.displayName}>
              {me.initials}
            </span>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {restriction(view, can, me.summaryOnly) ? <NoAccess /> : pages[view]()}
        </main>
        <footer className="app-footer">
          <span>MOVER / FACILITIES WORKSPACE</span>
          <span>إدارة مرافق وموافقات إدارية · خادم وقاعدة بيانات وسجل تدقيق داخل الشبكة</span>
        </footer>
      </div>
      <RequestWizard request={wizard} onClose={() => setWizard(null)} />
      <div id="toast" className="toast" role="status" hidden={!toastMsg}>
        {toastMsg}
      </div>
    </AppContext.Provider>
  );
}

/** The signed-in identity and logout (which also ends the identity provider's session). */
function IdentitySwitch({ me, setMe }: { me: Me; setMe: (m: Me | null) => void; onSwitched: () => void; toast: (m: string) => void }) {
  const logout = async () => {
    let target = '/';
    try {
      target = (await api.logout()).redirect || '/';
    } finally {
      setMe(null);
      window.location.assign(target);
    }
  };
  return (
    <div className="role-switch">
      <label>{me.primaryRole?.name ?? 'المستخدم'}</label>
      <span className="identity-name">{me.displayName}</span>
      <button className="text-link link-button" onClick={logout}>
        خروج
      </button>
    </div>
  );
}

function Notifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    api
      .notifications()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);
  const unread = items.filter((n) => !n.readAt).length;
  const read = async (n: Notification) => {
    if (!n.readAt) {
      try {
        await api.markRead(n.id);
      } catch {
        /* ignore */
      }
      load();
    }
    if (n.requestId) {
      setOpen(false);
      location.hash = 'requests';
    }
  };
  return (
    <div className="notif-wrap">
      <button className="icon-button" aria-label={'الإشعارات' + (unread ? ' — ' + unread + ' غير مقروءة' : '')} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" />
        {unread > 0 && <span className="notif-badge">{unread}</span>}
      </button>
      {open && (
        <div className="card notif-pop" role="dialog" aria-label="الإشعارات">
          <div className="flex spread">
            <h3>الإشعارات</h3>
            <span className="pill">{items.length}</span>
          </div>
          {items.length ? (
            items.slice(0, 20).map((n) => (
              <button key={n.id} className={'notif-item ' + (n.readAt ? '' : 'unread')} onClick={() => read(n)}>
                <b>{n.title}</b>
                <small>{n.body}</small>
                <small className="muted">{fullTime(n.createdAt)}</small>
              </button>
            ))
          ) : (
            <p className="micro muted">لا توجد إشعارات.</p>
          )}
        </div>
      )}
    </div>
  );
}
