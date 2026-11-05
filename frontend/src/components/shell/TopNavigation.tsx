import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Me, Notification, RestationingListItem } from '../../api/types';
import { useApp, type View } from '../../lib/app';
import { fullTime } from '../../lib/dates';
import { activeEntry, restriction, type NavLink } from '../../lib/navigation';
import { Icon } from '../ui';

const POLL_MS = 30_000;

/** The TMRKZ mark: three stacked terrain chevrons (drawn here; no image file, nothing remote). */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg className="tz-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path d="M24 6 42 22h-8L24 13 14 22H6Z" fill="#2bc4a8" />
      <path d="M24 17 40 31h-8l-8-7-8 7H8Z" fill="#c9a76b" />
      <path d="M24 28 38 40H10Z" fill="#1d8f7c" />
    </svg>
  );
}

/**
 * The dark top bar of the operational shell (owner brief, §4): brand and workspace on the right, the five entries of
 * the reference, «المزيد» with every other page the person may open, search, notifications and the identity menu.
 * Links come from `primaryNav`/`moreNav`, which mirror the server's permissions; the server still decides every call.
 */
export function TopNavigation({ me, view, links, more, onLogout, navOpen, setNavOpen }: {
  me: Me;
  view: View;
  links: NavLink[];
  more: NavLink[];
  onLogout: () => void;
  navOpen: boolean;
  setNavOpen: (o: boolean) => void;
}) {
  const app = useApp();
  const active = activeEntry(view, links);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => moreRef.current && !moreRef.current.contains(e.target as Node) && setMoreOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  useEffect(() => setMoreOpen(false), [view]);

  return (
    <header className="tz-top" role="banner">
      <button className="tz-icon-btn tz-burger" aria-label="فتح القائمة" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>
        <Icon name="menu" />
      </button>
      <a className="tz-brand" href="#home" aria-label="TMRKZ — الرئيسية">
        <BrandMark />
        <span className="tz-wordmark">
          <b>تمركز</b>
          <small>TMRKZ</small>
        </span>
      </a>
      <span className="tz-workspace" title="الجهة الحالية">
        <Icon name="building" />
        <span>{me.primaryOrg?.name ?? 'مساحة العمل'}</span>
      </span>
      <nav id="navigation" className={'tz-nav' + (navOpen ? ' open' : '')} aria-label="القائمة الرئيسية">
        {links.map((l) => (
          <a key={l.view} className={'nav-item tz-nav-item' + (active === l.view ? ' active' : '')} href={'#' + l.view} aria-current={active === l.view ? 'page' : undefined}>
            <Icon name={l.icon} />
            <span>{l.label}</span>
          </a>
        ))}
        {more.length > 0 && (
          <div className="tz-more" ref={moreRef}>
            <button className={'nav-item tz-nav-item' + (active === 'more' ? ' active' : '')} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
              <Icon name="grid" />
              <span>المزيد</span>
              <Icon name="chevron" />
            </button>
            {(moreOpen || navOpen) && (
              <div className="tz-menu" role="menu">
                {more.map((l) => (
                  <a key={l.view} role="menuitem" className={'tz-menu-item' + (view === l.view ? ' active' : '')} href={'#' + l.view}>
                    <Icon name={l.icon} />
                    <span>{l.label}</span>
                    {l.view === 'review' && app.counts.tasks > 0 && <span className="tz-count">{app.counts.tasks}</span>}
                  </a>
                ))}
                {app.can('CREATE') && (
                  <button role="menuitem" className="tz-menu-item" onClick={() => app.openWizard({ origin: 'LIST', layout: 'dialog' })}>
                    <Icon name="plus" />
                    <span>طلب مرفق جديد</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </nav>
      <div className="tz-top-tools">
        <GlobalSearch />
        <Notifications />
        <IdentityMenu me={me} onLogout={onLogout} />
      </div>
    </header>
  );
}

type Hit = { kind: 'unit' | 'site' | 'request'; id: string; title: string; sub: string };

/**
 * Search across the units, sites and re-stationing requests this person can already see (the lists the server returned
 * to them); choosing a result opens its page.
 */
function GlobalSearch() {
  const app = useApp();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<RestationingListItem[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const canRequests = !restriction('restationing', app.can, app.summaryOnly);
  useEffect(() => {
    if (!open || requests || !canRequests) return;
    api.restationingRequests().then(setRequests).catch(() => setRequests([]));
  }, [open, requests, canRequests]);
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const hits = useMemo<Hit[]>(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const has = (...s: (string | undefined)[]) => s.some((x) => x?.toLowerCase().includes(t));
    return [
      ...(requests ?? []).filter((r) => has(r.number, r.requestingUnit.name)).slice(0, 5)
        .map((r) => ({ kind: 'request' as const, id: r.id, title: r.number, sub: r.requestingUnit.name })),
      ...app.orgs.filter((o) => has(o.name, o.code)).slice(0, 5).map((o) => ({ kind: 'unit' as const, id: o.id, title: o.name, sub: o.code })),
      ...app.sites.filter((s) => has(s.name, s.code)).slice(0, 5).map((s) => ({ kind: 'site' as const, id: s.id, title: s.name, sub: s.code })),
    ];
  }, [q, requests, app.orgs, app.sites]);
  const go = (h: Hit) => {
    setOpen(false);
    setQ('');
    if (h.kind === 'request') location.hash = 'restationing/' + h.id;
    else if (h.kind === 'site') {
      app.setSelectedSiteId(h.id);
      location.hash = 'stationing';
    } else location.hash = 'org';
  };
  const KIND = { request: 'طلب', unit: 'وحدة', site: 'موقع' };
  return (
    <div className="tz-search" ref={box}>
      <Icon name="search" />
      <input
        type="search"
        placeholder="البحث في الوحدات والمواقع والطلبات…"
        aria-label="البحث في الوحدات والمواقع والطلبات"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onKeyDown={(e) => e.key === 'Enter' && hits[0] && go(hits[0])}
      />
      {open && q.trim().length >= 2 && (
        <div className="tz-pop tz-search-pop" role="listbox">
          {hits.length === 0 && <p className="tz-muted">لا نتائج ضمن ما تراه.</p>}
          {hits.map((h) => (
            <button key={h.kind + h.id} role="option" className="tz-hit" onClick={() => go(h)}>
              <span className="tz-hit-kind">{KIND[h.kind]}</span>
              <b>{h.title}</b>
              <small>{h.sub}</small>
            </button>
          ))}
        </div>
      )}
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
      <button className="tz-icon-btn" aria-label={'الإشعارات' + (unread ? ' — ' + unread + ' غير مقروءة' : '')} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" />
        {unread > 0 && <span className="notif-badge">{unread}</span>}
      </button>
      {open && (
        <div className="tz-pop notif-pop" role="dialog" aria-label="الإشعارات">
          <div className="tz-pop-head">
            <h3>الإشعارات</h3>
            <span className="tz-chip">{items.length}</span>
          </div>
          {items.length ? (
            items.slice(0, 20).map((n) => (
              <button key={n.id} className={'notif-item ' + (n.readAt ? '' : 'unread')} onClick={() => read(n)}>
                <b>{n.title}</b>
                <small>{n.body}</small>
                <small className="tz-muted">{fullTime(n.createdAt)}</small>
              </button>
            ))
          ) : (
            <p className="tz-muted">لا توجد إشعارات.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The signed-in identity and logout (which also ends the identity provider's session). */
function IdentityMenu({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="tz-identity" ref={box}>
      <button className="tz-avatar-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={me.displayName}>
        <span className="avatar" id="roleAvatar">{me.initials}</span>
        <span className="tz-identity-text">
          <b className="identity-name">{me.displayName}</b>
          <small>{me.primaryRole?.name ?? 'المستخدم'}</small>
        </span>
      </button>
      {open && (
        <div className="tz-pop tz-identity-pop" role="menu">
          <b>{me.displayName}</b>
          <small>{me.primaryRole?.name ?? 'المستخدم'}</small>
          {me.primaryOrg && <small>{me.primaryOrg.name}</small>}
          <small className="tz-muted">المنطقة الزمنية: {me.timezone}</small>
          <a role="menuitem" className="tz-menu-item" href="#docs">
            <Icon name="download" />
            <span>التوثيق والتشغيل</span>
          </a>
          <button role="menuitem" className="tz-menu-item danger" onClick={onLogout}>
            <Icon name="logout" />
            <span>خروج</span>
          </button>
        </div>
      )}
    </div>
  );
}
