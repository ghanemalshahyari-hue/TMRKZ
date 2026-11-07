import type { RequestStatus } from '../api/types';

/**
 * What the administrative requests list shows, kept for the session so coming back from a request returns to the same
 * place, and what the server is asked for. The list is paged by the server: the page holds only the rows on screen.
 */
export type SortKey = 'updated' | 'number' | 'period';
export type ListState = {
  status: 'all' | RequestStatus;
  q: string;
  type: string;
  from: string;
  to: string;
  mine: boolean;
  sort: SortKey;
  dir: 'asc' | 'desc';
  page: number;
  size: number;
};

export const PAGE_SIZES = [25, 50, 100];
export const INITIAL_LIST: ListState = { status: 'all', q: '', type: '', from: '', to: '', mine: false, sort: 'updated', dir: 'desc', page: 0, size: 25 };

const KEY = 'tmrkz.requests.list';

export function loadListState(): ListState {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? { ...INITIAL_LIST, ...(JSON.parse(raw) as Partial<ListState>) } : INITIAL_LIST;
  } catch {
    return INITIAL_LIST;
  }
}

export function saveListState(s: ListState): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // a remembered filter is a convenience only
  }
}

/** A day chosen on the page is a whole day in Dubai, as every date in the application is shown. */
export const dayStart = (d: string) => (d ? new Date(d + 'T00:00:00+04:00').toISOString() : undefined);
export const dayEnd = (d: string) => (d ? new Date(d + 'T23:59:59+04:00').toISOString() : undefined);

export const activeFilters = (s: ListState) => [s.q.trim(), s.type, s.from, s.to, s.mine ? 'mine' : ''].filter(Boolean).length;

/** «1–25 من 12,430», and which page numbers to offer: the first, the last and those around the current one. */
export function pageInfo(page: number, size: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / size));
  const first = total === 0 ? 0 : page * size + 1;
  const last = Math.min(total, (page + 1) * size);
  const near = [...new Set([0, page - 1, page, page + 1, pages - 1])].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b);
  return { pages, first, last, near };
}

const REL = new Intl.RelativeTimeFormat('ar-u-nu-latn', { numeric: 'auto' });

/** «قبل 3 أيام»: how long since a request last changed. */
export function sinceText(iso: string, now = Date.now()): string {
  const min = Math.round((new Date(iso).getTime() - now) / 60000);
  if (Math.abs(min) < 60) return REL.format(min, 'minute');
  const h = Math.round(min / 60);
  if (Math.abs(h) < 24) return REL.format(h, 'hour');
  const d = Math.round(h / 24);
  if (Math.abs(d) < 31) return REL.format(d, 'day');
  const mo = Math.round(d / 30);
  return Math.abs(mo) < 12 ? REL.format(mo, 'month') : REL.format(Math.round(d / 365), 'year');
}
