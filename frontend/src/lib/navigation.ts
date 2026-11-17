import type { Permission } from '../api/types';
import { FLOW_STUDIO_UI_ENABLED, NAV, type View } from './app';

/**
 * Navigation of the operational shell (owner brief «FULL APPLICATION UI REBUILD», §4): the same views and the same
 * permission rule as before, grouped for the top bar. Nothing here grants access: the server decides on every call;
 * this only keeps a person from being offered a page they cannot open.
 */

// one right opens re-stationing and deployment-area requests; initial stationing is set up in «تهيئة المواقع» only (ADR-078)
const STATIONING_REQUEST_RIGHTS: Permission[] = ['CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION'];
// the final approver also decides a request's lifecycle actions and what exceeds the policy (ADR-078): no separate rights
const STATIONING_RIGHTS: Permission[] = [...STATIONING_REQUEST_RIGHTS, 'VIEW', 'APPROVE', 'APPROVE_HIERARCHY', 'ACTIVATE_STATIONING', 'DECIDE_UNIT_OPERATIONS',
  'FINAL_APPROVE_STATIONING', 'MANAGE_FYI_DISTRIBUTION'];

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
  if (view === 'siteSetup') return !(can('MANAGE_FACILITIES') || can('MANAGE_SITE_LINKS') || can('CORRECT_STATIONING'));
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
  return !(can('VIEW') || can('CREATE'));
}

export type NavLink = { view: View; label: string; icon: string };

/**
 * The five top-bar entries of the reference (الرئيسية، الطلبات، المواقع، الوحدات، التقارير), each an existing view; an
 * entry falls back to the next view of its group the person may open and disappears when there is none.
 */
const PRIMARY: { label: string; icon: string; views: View[] }[] = [
  { label: 'الرئيسية', icon: 'home', views: ['home'] },
  // next to «الرئيسية» (owner, 11 Nov 2026), out of «المزيد»
  { label: 'تهيئة المواقع', icon: 'boundary', views: ['siteSetup'] },
  { label: 'إعادة التمركز', icon: 'layers', views: ['restationing'] },
  { label: 'الطلبات', icon: 'file', views: ['allRequests', 'requests'] },
  { label: 'المواقع', icon: 'pin', views: ['stationing'] },
  { label: 'الوحدات', icon: 'tree', views: ['org'] },
  { label: 'التقارير', icon: 'chart', views: ['audit', 'calendar'] },
];

/** The views known to this build (Stationing V3 views only when the flag is on, as NAV lists them). */
const known = (v: View) => v === 'home' || NAV.some(([id]) => id === v);

export function primaryNav(can: (p: Permission) => boolean, summaryOnly: boolean): NavLink[] {
  const out: NavLink[] = [];
  for (const p of PRIMARY) {
    const view = p.views.find((v) => known(v) && !restriction(v, can, summaryOnly));
    if (view) out.push({ view, label: p.label, icon: p.icon });
  }
  return out;
}

/** Names that would repeat a top-bar entry's name for another page. */
const MORE_LABEL: Partial<Record<View, string>> = { requests: 'طلبات المرافق والحجوزات', restationing: 'إعادة التمركز', allRequests: 'الطلبات' };

/** Every other view the person may open, in NAV order, for the «المزيد» menu. */
export function moreNav(can: (p: Permission) => boolean, summaryOnly: boolean): NavLink[] {
  const primary = new Set(primaryNav(can, summaryOnly).map((l) => l.view));
  return NAV.filter(([id]) => !primary.has(id) && !restriction(id, can, summaryOnly)).map(([view, icon, label]) => ({ view, icon, label: MORE_LABEL[view] ?? label }));
}

/** The top-bar entry of a view: its own entry, or «المزيد» for a view of that menu. */
export function activeEntry(view: View, links: NavLink[]): View | 'more' {
  return links.some((l) => l.view === view) ? view : 'more';
}
