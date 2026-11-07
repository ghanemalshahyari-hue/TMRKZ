import { createContext, useContext } from 'react';
import type { Me, OrgNode, Permission, RequestType, Settings, Site } from '../api/types';
import { STATIONING_V3_ENABLED } from './stationingV3';

/** The chart studio's page is a rollout of its own. Only a build that says «false» leaves it out (docker-compose defaults to that). */
export const FLOW_STUDIO_UI_ENABLED = import.meta.env.VITE_FLOW_STUDIO !== 'false';

export type View = 'home' | 'newRequest' | 'allRequests' | 'posture' | 'siteSetup' | 'stationing' | 'restationing' | 'stationingPolicy' | 'requests' | 'review' | 'calendar' | 'org' | 'workflow' | 'forms' | 'permissions' | 'settings' | 'audit' | 'docs' | 'requestAccess' | 'accessInbox';

/**
 * The views, in the prototype NAV's order (the last entry replaces «حزمة البناء»). #stationing is now «المواقع», the
 * registered sites workspace; re-stationing is only «إعادة التمركز» (owner decision of 5 Nov 2026). The retired
 * «الخريطة والمرافق» route (#map) opens «المواقع».
 */
export const NAV: [View, string, string][] = [
  // the registered sites workspace (owner decision of 5 Nov 2026): re-stationing itself is only «إعادة التمركز»
  ['stationing', 'pin', 'المواقع'],
  ...(STATIONING_V3_ENABLED
    ? ([
        ['newRequest', 'file', 'طلب جديد'],
        ['allRequests', 'file', 'الطلبات'],
        ['posture', 'map', 'الموقف العملياتي'],
        ['siteSetup', 'boundary', 'تهيئة المواقع والتمركز'],
      ] as [View, string, string][])
    : []),
  // Stationing V3 re-stationing requests (ADR-033): only in builds with VITE_STATIONING_V3=true until accepted
  ...(STATIONING_V3_ENABLED ? ([['restationing', 'layers', 'إعادة التمركز']] as [View, string, string][]) : []),
  ...(STATIONING_V3_ENABLED ? ([['stationingPolicy', 'filter', 'سياسة التمركز']] as [View, string, string][]) : []),
  ['requests', 'file', 'الطلبات الإدارية'],
  ['review', 'check', 'صندوق المراجعة'],
  ['calendar', 'clock', 'الإشغال والحجوزات'],
  ['org', 'tree', 'الهيكل التنظيمي'],
  // the workflow engine runs whatever this says; only the page of the chart studio follows its own rollout (ADR-045)
  ...(FLOW_STUDIO_UI_ENABLED ? ([['workflow', 'layers', 'مسار الموافقات']] as [View, string, string][]) : []),
  ['forms', 'grid', 'نماذج الطلبات'],
  ['permissions', 'shield', 'مركز الصلاحيات'],
  ['accessInbox', 'check', 'طلبات الصلاحية'],
  ['requestAccess', 'shield', 'طلب صلاحية'],
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
