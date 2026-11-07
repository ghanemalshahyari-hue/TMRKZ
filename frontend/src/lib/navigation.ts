import type { Permission } from '../api/types';
import { FLOW_STUDIO_UI_ENABLED, NAV, type View } from './app';

/**
 * Navigation of the operational shell (owner brief «FULL APPLICATION UI REBUILD», §4): the same views and the same
 * permission rule as before, grouped for the top bar. Nothing here grants access: the server decides on every call;
 * this only keeps a person from being offered a page they cannot open.
 */

const STATIONING_REQUEST_RIGHTS: Permission[] = ['CREATE_RESTATIONING', 'CREATE_INITIAL_STATIONING', 'CREATE_DEPLOYMENT_REQUEST', 'REQUEST_SITE_REGISTRATION'];
const STATIONING_RIGHTS: Permission[] = [...STATIONING_REQUEST_RIGHTS, 'VIEW', 'APPROVE', 'ACTIVATE_STATIONING', 'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION', 'DECIDE_PRE_ACTIVATION_CANCELLATION',
  'ACTIVATE_TEMPORARY_EXTENSION', 'DECIDE_EARLY_RETURN', 'DECIDE_BEFORE_START_CANCELLATION', 'DECIDE_UNIT_OPERATIONS', 'FINAL_APPROVE_STATIONING', 'MANAGE_FYI_DISTRIBUTION'];

/** Server-enforced permissions decide what each screen shows; this mirrors them for navigation only. */
export function restriction(view: View, can: (p: Permission) => boolean, summaryOnly: boolean): boolean {
  if (view === 'docs' || view === 'home' || view === 'requestAccess') return false;
  // the read-only posture opens with its own right, and that right opens nothing else
  if (view === 'posture') return !can('VIEW_OPERATIONAL_POSTURE');
  if (view === 'siteSetup') return !(can('MANAGE_FACILITIES') || can('MANAGE_SITE_LINKS') || can('CORRECT_STATIONING'));
  if (view === 'newRequest') return !STATIONING_REQUEST_RIGHTS.some((p) => can(p));
  if (view === 'allRequests') return !STATIONING_RIGHTS.some((p) => can(p)) && !can('REVIEW');
  if (view === 'accessInbox') return !can('REVIEW');
  if (view === 'workflow' && !FLOW_STUDIO_UI_ENABLED) return true;
  if (['workflow', 'forms', 'settings'].includes(view)) return !can('CONFIGURE');
  if (view === 'permissions') return !can('MANAGE_ACCESS');
  if (view === 'org') return !(can('VIEW') || can('MANAGE_ACCESS') || can('MANAGE_FACILITIES') || can('CONFIGURE'));
  if (['stationing', 'calendar'].includes(view)) return !(can('VIEW') || can('VIEW_SUMMARY') || can('MANAGE_FACILITIES'));
  if (view === 'stationingPolicy') return !can('CONFIGURE');
  // the lifecycle rights (ADR-034) open the page too: their holders decide the requests they act on
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
  { label: 'الطلبات', icon: 'file', views: ['allRequests', 'restationing', 'requests'] },
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
