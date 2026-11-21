import type { Permission } from '../api/types';
import { FLOW_STUDIO_UI_ENABLED, NAV, type View } from './app';
import { hubWays, mayByRule } from './stationingHub';

/**
 * Navigation of the operational shell (owner brief «FULL APPLICATION UI REBUILD», §4): the same views and the same
 * permission rule as before, grouped for the top bar. Nothing here grants access: the server decides on every call;
 * this only keeps a person from being offered a page they cannot open.
 */

// one right opens re-stationing and deployment-area requests; initial stationing is set up in «تهيئة المواقع» only (ADR-078)
const STATIONING_REQUEST_RIGHTS: Permission[] = ['CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION'];
// the final approver also decides a request's lifecycle actions and what exceeds the policy (ADR-078): no separate rights
const STATIONING_RIGHTS: Permission[] = [...STATIONING_REQUEST_RIGHTS, 'VIEW', 'APPROVE', 'APPROVE_HIERARCHY', 'DECIDE_UNIT_OPERATIONS',
  'FINAL_APPROVE_STATIONING'];

let supportSeat: string | null = null;
/** «لوحة الدعم» opens for a support seat (ADR-053), which is not a permission: the shell tells navigation who holds one. */
export function setSupportSeat(seat: string | null | undefined) {
  supportSeat = seat ?? null;
}

/**
 * A system administrator («مدير النظام», owner 17 Nov 2026, ADR-075) does not see «طلب صلاحية» (they manage access and cannot be
 * granted a role by themselves) nor «طلب جديد» when their only request right is the role's own «طلب إعادة التمركز» — that is
 * started from «إعادة التمركز». A request right from any other grant keeps «طلب جديد».
 */
let systemAdmin = false;
let otherRequestRights = false;
export function setGrantFacts(grants: { roleCode: string; permissions: Permission[] }[] | null | undefined) {
  const list = grants ?? [];
  systemAdmin = list.some((g) => g.roleCode === 'SYSTEM_ADMIN');
  otherRequestRights = list.some((g) => g.roleCode !== 'SYSTEM_ADMIN' && g.permissions.some((p) => STATIONING_REQUEST_RIGHTS.includes(p)));
}

/** Where «＋ طلب جديد» goes: «طلب جديد», or straight to the re-stationing editor for a system administrator who does not see it. */
export function newRequestHref(): string {
  return systemAdmin && !otherRequestRights ? '#restationing/new?purpose=RESTATIONING' : '#newRequest';
}

/** Server-enforced permissions decide what each screen shows; this mirrors them for navigation only. */
export function restriction(view: View, can: (p: Permission) => boolean, summaryOnly: boolean): boolean {
  if (view === 'requestAccess') return systemAdmin;
  if (view === 'docs' || view === 'home' || view === 'support') return false;
  // a configuration administrator opens it to give the first seats; the queue itself answers seat holders only
  if (view === 'supportConsole') return !supportSeat && !can('CONFIGURE');
  // the read-only posture opens with its own right, and that right opens nothing else
  if (view === 'posture') return !can('VIEW_OPERATIONAL_POSTURE');
  if (view === 'siteSetup') return !(can('MANAGE_FACILITIES') || can('MANAGE_SITE_LINKS') || can('CORRECT_STATIONING') || mayByRule());
  if (view === 'newRequest') return !STATIONING_REQUEST_RIGHTS.some((p) => can(p)) || (systemAdmin && !otherRequestRights);
  if (view === 'allRequests') return !STATIONING_RIGHTS.some((p) => can(p)) && !can('REVIEW');
  if (view === 'accessInbox') return !can('REVIEW');
  if (view === 'workflow' && !FLOW_STUDIO_UI_ENABLED) return true;
  if (['workflow', 'forms', 'settings'].includes(view)) return !can('CONFIGURE');
  if (view === 'permissions') return !can('MANAGE_ACCESS');
  if (view === 'org') return !(can('VIEW') || can('MANAGE_ACCESS') || can('MANAGE_FACILITIES') || can('CONFIGURE'));
  if (['stationing', 'calendar'].includes(view)) return !(can('VIEW') || can('VIEW_SUMMARY') || can('MANAGE_FACILITIES'));
  if (view === 'stationingPolicy') return !can('CONFIGURE');
  // every stage holder opens it, the final approver too: it decides the lifecycle actions of the requests in its reach (ADR-078)
  if (view === 'restationing')
    // one request sent «للعلم» opens by its address, whatever else the person holds; the server decides whether it is theirs
    return !STATIONING_RIGHTS.some((p) => can(p)) && !(typeof location !== 'undefined' && /^#restationing\/[0-9a-f-]{36}$/.test(location.hash));
  if (summaryOnly) return true;
  if (view === 'review') return !can('REVIEW');
  if (view === 'audit') return !can('AUDIT');
  if (view === 'requestHealth') return !can('CONFIGURE');
  return !(can('VIEW') || can('CREATE'));
}

/** A top-bar entry: a view, or (the stationing ways) a view opened at an address of its own, told apart by {@code id}. */
export type NavLink = { view: View; label: string; icon: string; id?: string; href?: string; title?: string };

/**
 * Top-bar entries. The three «way» tabs (تحديد مواقع التمركز المبدئية، طلب مناطق انتشار، طلب إعادة تمركز) sit right after
 * «الرئيسية» so one click starts the work — the owner's 17 Nov 2026 arrangement, kept against the 20 Nov consolidation
 * because the owner said the ways must remain visible. They share a view with the editor they open but each carries its
 * own address through `wayKey`, so `activeEntry` can highlight the right tab for the current hash. Ways still appear in
 * «＋ إنشاء» for anyone who prefers to start from there.
 */
const PRIMARY: { label: string; icon: string; views: View[]; wayKey?: 'SITE_SETUP' | 'DEPLOYMENT_AREAS' | 'RESTATIONING' }[] = [
  { label: 'الرئيسية', icon: 'home', views: ['home'] },
  // Owner, 21 Nov 2026 UI closure §2: the posture tab opens the posture or disappears. Falling back to the re-stationing
  // editor was a semantic mismatch — a tab labelled «الموقف العملياتي» must never open «طلب إعادة تمركز».
  { label: 'الموقف العملياتي', icon: 'map', views: ['posture'] },
  { label: 'تحديد مواقع التمركز المبدئية', icon: 'tent', views: ['siteSetup'], wayKey: 'SITE_SETUP' },
  { label: 'طلب مناطق انتشار', icon: 'layers', views: ['restationing'], wayKey: 'DEPLOYMENT_AREAS' },
  { label: 'طلب إعادة تمركز', icon: 'swap', views: ['restationing'], wayKey: 'RESTATIONING' },
  { label: 'الطلبات', icon: 'file', views: ['allRequests', 'requests'] },
  // Owner, 20 Nov 2026: «المواقع» is merged into «الموقف العملياتي» — the posture map already shows every site this person
  // may see. The SitesPage view stays reachable from «المزيد» for people who want the list view.
  { label: 'الوحدات', icon: 'tree', views: ['org'] },
  // «الاعتمادات» appears only when the person actually holds REVIEW (admin without it no longer lands on a refusal page)
  { label: 'الاعتمادات', icon: 'shield', views: ['review', 'accessInbox'] },
  { label: 'التقارير', icon: 'chart', views: ['audit', 'calendar'] },
  { label: 'إدارة النظام', icon: 'filter', views: ['settings'] },
];

/** The views known to this build (Stationing V3 views only when the flag is on, as NAV lists them). */
const known = (v: View) => v === 'home' || NAV.some(([id]) => id === v);

export function primaryNav(can: (p: Permission) => boolean, summaryOnly: boolean): NavLink[] {
  const out: NavLink[] = [];
  const ways = hubWays(can);
  for (const p of PRIMARY) {
    if (p.wayKey) {
      // a way tab shows only when the server would let the person use it; the way's own href is read by activeEntry
      const w = ways.find((x) => x.key === p.wayKey);
      if (w && w.allowed) {
        const view: View = w.key === 'SITE_SETUP' ? 'siteSetup' : 'restationing';
        if (known(view) && !restriction(view, can, summaryOnly)) {
          out.push({ view, label: p.label, icon: p.icon, id: p.wayKey, href: w.href });
        }
      }
      continue;
    }
    const view = p.views.find((v) => known(v) && !restriction(v, can, summaryOnly));
    if (view) out.push({ view, label: p.label, icon: p.icon });
  }
  return out;
}

/** The actions behind the global «＋ إنشاء» menu (owner UX consolidation §10). Each one opens its target workspace. */
export type CreateAction = { id: string; label: string; href: string; icon: string };
export function createActions(can: (p: Permission) => boolean, summaryOnly: boolean): CreateAction[] {
  const out: CreateAction[] = [];
  for (const w of hubWays(can)) {
    if (!w.allowed) continue;
    if (w.key === 'SITE_SETUP') {
      if (!restriction('siteSetup', can, summaryOnly)) out.push({ id: w.key, label: w.title, href: '#siteSetup', icon: w.icon });
    } else {
      out.push({ id: w.key, label: w.title, href: w.href ?? '#restationing', icon: w.icon });
    }
  }
  // «طلب اعتماد موقع» remains a business request family (ADR-078 kept SITE_REGISTRATION creatable; the server's
  // /request-hub decides per-unit allowance and reasons). The quick menu entry opens the full hub page so the person
  // picks the right unit — the same path as «طلب جديد» without the extra click. Without the permission this entry stays
  // hidden; the server still refuses anything else.
  if (can('REQUEST_SITE_REGISTRATION')) {
    out.push({ id: 'SITE_REGISTRATION', label: 'طلب اعتماد موقع', href: '#newRequest', icon: 'boundary' });
  }
  if (!restriction('requestAccess', can, summaryOnly)) out.push({ id: 'ACCESS', label: 'طلب صلاحية', href: '#requestAccess', icon: 'shield' });
  return out;
}

/** Names that would repeat a top-bar entry's name for another page. */
const MORE_LABEL: Partial<Record<View, string>> = { requests: 'طلبات المرافق والحجوزات', restationing: 'إعادة التمركز', allRequests: 'الطلبات' };

/** Every other view the person may open, in NAV order, for the «المزيد» menu. */
export function moreNav(can: (p: Permission) => boolean, summaryOnly: boolean): NavLink[] {
  // every view already reachable from the top bar — way tabs included — stays out of «المزيد» (owner, 20 Nov 2026): no
  // duplicate entries, and «تهيئة المواقع والتمركز» in particular is not shown twice (its primary entry on top is enough).
  const primary = new Set<View>(primaryNav(can, summaryOnly).map((l) => l.view));
  return NAV.filter(([id]) => !primary.has(id) && !restriction(id, can, summaryOnly)).map(([view, icon, label]) => ({ view, icon, label: MORE_LABEL[view] ?? label }));
}

/**
 * The top-bar entry to highlight: a way whose address is the current one (the two request ways share a view), else the entry of
 * the view, else «المزيد».
 */
export function activeEntry(view: View, links: NavLink[], hash = ''): string {
  const byAddress = links.find((l) => l.href && hash.startsWith(l.href));
  if (byAddress) return byAddress.id ?? byAddress.view;
  const plain = links.find((l) => !l.href && l.view === view);
  return plain ? plain.id ?? plain.view : 'more';
}
