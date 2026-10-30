import { createContext, useContext } from 'react';
import type { Me, OrgNode, Permission, RequestType, Settings, Site } from '../api/types';

export type View = 'map' | 'stationing' | 'requests' | 'review' | 'calendar' | 'org' | 'workflow' | 'forms' | 'permissions' | 'settings' | 'audit' | 'docs';

/** Same order, icons and labels as the prototype NAV (the last entry replaces «حزمة البناء»). */
export const NAV: [View, string, string][] = [
  ['map', 'map', 'الخريطة والمرافق'],
  ['stationing', 'map', 'مساحة التمركز'],
  ['requests', 'file', 'الطلبات'],
  ['review', 'check', 'صندوق المراجعة'],
  ['calendar', 'clock', 'الإشغال والحجوزات'],
  ['org', 'tree', 'الهيكل التنظيمي'],
  ['workflow', 'layers', 'استوديو التدفقات'],
  ['forms', 'grid', 'استوديو النماذج'],
  ['permissions', 'shield', 'مركز الصلاحيات'],
  ['settings', 'filter', 'إعدادات النظام'],
  ['audit', 'clock', 'سجل الإجراءات'],
  ['docs', 'download', 'التوثيق والتشغيل'],
];

/** Selection carried from the map into the request form (validated again by the server). */
export type WizardPrefill = {
  ownerOrgId?: string;
  resourceIds?: string[];
  unit?: 'DAYS' | 'HOURS';
  start?: string;
  end?: string;
  permanent?: boolean;
  siteName?: string;
};

export type WizardRequest = {
  origin: 'MAP' | 'LIST';
  siteId?: string;
  requestId?: string;
  typeCode?: string;
  targetReservationId?: string;
  prefill?: WizardPrefill;
  /** drawer: docked beside the map, keeps map and selection visible; dialog: the full form. */
  layout?: 'drawer' | 'dialog';
};

export type FlatOrg = OrgNode & { depth: number };

export type AppContextValue = {
  me: Me;
  refreshMe: () => Promise<void>;
  can: (p: Permission) => boolean;
  summaryOnly: boolean;
  toast: (message: string) => void;
  openWizard: (w: WizardRequest) => void;
  /** Incremented after every mutation so pages reload server state. */
  revision: number;
  bump: () => void;
  selectedSiteId: string | null;
  setSelectedSiteId: (id: string | null) => void;
  selectedRequestId: string | null;
  setSelectedRequestId: (id: string | null) => void;
  mapDate: string;
  setMapDate: (d: string) => void;
  sites: Site[];
  requestTypes: RequestType[];
  orgs: FlatOrg[];
  settings: Settings | null;
  counts: { tasks: number; submitted: number };
  navigate: (view: View) => void;
  /** The map's left column where an open request is docked (null when the map is not shown). */
  requestSlot: HTMLElement | null;
  setRequestSlot: (el: HTMLElement | null) => void;
  /** A request started beside the map is open (docked or minimised). */
  wizardActive: boolean;
};

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext missing');
  return ctx;
}

export function flattenOrgs(nodes: OrgNode[], depth = 0, out: FlatOrg[] = []): FlatOrg[] {
  for (const n of nodes) {
    out.push({ ...n, depth });
    flattenOrgs(n.children ?? [], depth + 1, out);
  }
  return out;
}

/** Sites that can be requested: visible (not tree context), active, with at least one bookable resource. */
export function facilitySites(sites: Site[]): Site[] {
  return sites.filter((s) => s.view !== 'CONTEXT' && s.resources.length > 0 && s.status !== 'RETIRED').sort((a, b) => a.code.localeCompare(b.code));
}
