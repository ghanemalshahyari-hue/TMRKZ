import type { Administrative, Availability, MapFeature, ResourceStateName } from '../api/types';
import { addDays, dubaiISO, todayDubai } from './dates';

/** Every map colour has a name, a symbol and an explanation; colour is never the only signal. */
export type StateStyle = { label: string; color: string; symbol: string; pill: string; hint: string };

export const MAP_COLORS = {
  free: '#2f8f6f',
  partial: '#4f78b0',
  busy: '#c25b56',
  pending: '#d0892e',
  approved: '#2f8f6f',
  neutral: '#8c9a9e',
};

export const AVAILABILITY_STYLE: Record<Availability, StateStyle> = {
  FREE: { label: 'متاح', color: MAP_COLORS.free, symbol: '✓', pill: 'green', hint: 'يمكن طلبه للفترة وفق سياسته؛ المعاينة لا تمنح حجزاً.' },
  PARTIAL: { label: 'إشغال جزئي', color: MAP_COLORS.partial, symbol: '◐', pill: 'blue', hint: 'بعض الموارد محجوزة أو مستخدمة، وبعضها متاح؛ راجع حالة كل مورد.' },
  BUSY: { label: 'غير متاح', color: MAP_COLORS.busy, symbol: '✕', pill: 'red', hint: 'كل الموارد المطلوبة متعارضة مع حجز معتمد خلال الفترة.' },
  NO_RESOURCES: { label: 'لا موارد للطلب', color: MAP_COLORS.neutral, symbol: '–', pill: '', hint: 'لا توجد موارد قابلة للطلب مسجلة لهذا الموقع.' },
};

export const ADMIN_STYLE: Record<Administrative, StateStyle> = {
  PENDING: { label: 'قيد المراجعة', color: MAP_COLORS.pending, symbol: '⏳', pill: 'orange', hint: 'طلب مقدم ينتظر القرار؛ لا يعد حجزاً حصرياً.' },
  APPROVED: { label: 'معتمد', color: MAP_COLORS.approved, symbol: '✓', pill: 'green', hint: 'حجز معتمد خلال الفترة.' },
  NONE: { label: 'دون طلب', color: MAP_COLORS.neutral, symbol: '–', pill: '', hint: 'لا طلبات ظاهرة لك على الموقع في الفترة.' },
};

/** Neutral state when data is missing or the last refresh failed: nothing is guessed. */
export const UNKNOWN_STYLE: StateStyle = {
  label: 'تعذر التحديث',
  color: MAP_COLORS.neutral,
  symbol: '?',
  pill: '',
  hint: 'لم تكتمل البيانات أو فشل تحديثها؛ لا تُعرض إتاحة غير مؤكدة.',
};

export const RESOURCE_STYLE: Record<ResourceStateName, StateStyle> = {
  FREE: { label: 'متاح', color: MAP_COLORS.free, symbol: '✓', pill: 'green', hint: '' },
  BLOCKED: { label: 'غير متاح', color: MAP_COLORS.busy, symbol: '✕', pill: 'red', hint: '' },
  SHARED_IN_USE: { label: 'مشترك — مستخدم', color: MAP_COLORS.partial, symbol: '◐', pill: 'blue', hint: '' },
};

export type MapMode = 'availability' | 'requests';

export function featureStyle(f: MapFeature, mode: MapMode, stale: boolean): StateStyle {
  if (stale) return UNKNOWN_STYLE;
  return mode === 'availability' ? AVAILABILITY_STYLE[f.availability] : ADMIN_STYLE[f.administrative];
}

// ---- period (organisation time zone Asia/Dubai; server stores UTC; half-open [start, end)) -------------------

export type PeriodMode = 'HOURS' | 'DAYS' | 'OPEN';
export type MapPeriod = { mode: PeriodMode; start: string; end: string };

export function defaultPeriod(): MapPeriod {
  const d = todayDubai();
  return { mode: 'DAYS', start: d, end: addDays(d, 1) };
}

/** Server query values for the period; for days the end day is excluded (1 → 3 covers the 1st and 2nd). */
export function periodQuery(p: MapPeriod): { from: string; to: string | null; open: boolean } | null {
  if (!p.start) return null;
  const from = dubaiISO(p.mode === 'HOURS' ? p.start : p.start.slice(0, 10));
  if (p.mode === 'OPEN') return { from, to: null, open: true };
  if (!p.end) return null;
  const to = dubaiISO(p.mode === 'HOURS' ? p.end : p.end.slice(0, 10));
  if (new Date(to) <= new Date(from)) return null;
  return { from, to, open: false };
}

export function switchPeriodMode(p: MapPeriod, mode: PeriodMode): MapPeriod {
  const day = (p.start || todayDubai()).slice(0, 10);
  if (mode === 'HOURS') return { mode, start: day + 'T08:00', end: day + 'T12:00' };
  if (mode === 'DAYS') return { mode, start: day, end: addDays(day, 1) };
  return { mode, start: p.mode === 'HOURS' ? p.start : day, end: '' };
}

// ---- per-person map context ------------------------------------------------------------------------------

/**
 * What the person last looked at: identifiers, period and view settings only — never map data or package content.
 * Keyed by person, validated against the server on restore, and cleared at sign-out.
 */
export type SavedMapContext = {
  org?: { id: string; name: string; includeSub: boolean };
  siteId?: string;
  period?: MapPeriod;
  view?: { center: [number, number]; zoom: number };
  packageId?: string | null;
  layers?: LayerSettings;
  mode?: MapMode;
  tab?: 'orgs' | 'sites';
  toolsCollapsed?: boolean;
  dirCollapsed?: boolean;
};

export type LayerSettings = {
  sites: { visible: boolean; opacity: number };
  zones: { visible: boolean; opacity: number };
  markers: boolean;
  labels: boolean;
  colours: boolean;
  requests: boolean;
  zonesOnTop: boolean;
  backgroundOpacity: number;
};

export const DEFAULT_LAYERS: LayerSettings = {
  sites: { visible: true, opacity: 0.22 },
  zones: { visible: true, opacity: 0.3 },
  markers: true,
  labels: true,
  colours: true,
  requests: true,
  zonesOnTop: true,
  backgroundOpacity: 1,
};

const KEY = 'tmrkz.map.context.';

export function loadMapContext(personId: string): SavedMapContext {
  try {
    const raw = localStorage.getItem(KEY + personId);
    return raw ? (JSON.parse(raw) as SavedMapContext) : {};
  } catch {
    return {};
  }
}

export function saveMapContext(personId: string, ctx: SavedMapContext): void {
  try {
    localStorage.setItem(KEY + personId, JSON.stringify(ctx));
  } catch {
    /* storage unavailable: the map still works, it only forgets the view */
  }
}

/** Sign-out: forget every map context kept in this browser. */
export function clearMapContexts(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

export function formatArea(m2: number | undefined | null): string {
  if (m2 == null) return '—';
  if (m2 >= 1_000_000) return (m2 / 1_000_000).toFixed(2) + ' كم²';
  return Math.round(m2).toLocaleString('ar-AE') + ' م²';
}
