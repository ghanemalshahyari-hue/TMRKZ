import type { PostureUnit } from '../api/client';

/**
 * Operational posture status model (owner, 21 Nov 2026 — brief «TMRKZ — FINISH THE OPERATIONAL POSTURE MEANING LAYER»).
 *
 * Two dimensions. The right-rail tabs, the list rows, the detail card, the bottom dock and the map filters all read
 * from the SAME helper so there is one source of truth for «what is this unit's status?».
 *
 * Dimension 1 — Completeness (from the current approved posture only):
 *   COMPLETE                 — site + PRIMARY + ALTERNATIVE
 *   INCOMPLETE_DEPLOYMENT    — site but PRIMARY and/or ALTERNATIVE missing
 *   NO_STATIONING            — no effective approved stationing
 *
 * Dimension 2 — Timing (comes from the stationing kind + plannedEnd):
 *   PERMANENT                — the unit's current stationing is permanent
 *   TEMPORARY                — temporary and not near its end
 *   TEMPORARY_EXPIRING       — temporary and ending within EXPIRING_DAYS
 *   NONE                     — the unit has no current stationing
 *
 * A row that is COMPLETE + TEMPORARY is both valid and legible: the badge carries both parts.
 */

export type Completeness = 'COMPLETE' | 'INCOMPLETE_DEPLOYMENT' | 'NO_STATIONING';
export type Timing = 'PERMANENT' | 'TEMPORARY' | 'TEMPORARY_EXPIRING' | 'NONE';

/** Threshold for «ينتهي قريبًا». Re-used from the home dashboard's nearReturnStations filter (30-day window). */
export const EXPIRING_DAYS = 30;
const DAY = 86_400_000;

export function completenessOf(u: Pick<PostureUnit, 'site' | 'primary' | 'alternative'>): Completeness {
  if (!u.site) return 'NO_STATIONING';
  if (u.primary && u.alternative) return 'COMPLETE';
  return 'INCOMPLETE_DEPLOYMENT';
}

export function timingOf(u: Pick<PostureUnit, 'site' | 'kind' | 'plannedEnd'>, now = Date.now()): Timing {
  if (!u.site) return 'NONE';
  if (u.kind !== 'TEMPORARY') return 'PERMANENT';
  if (u.plannedEnd) {
    const ms = new Date(u.plannedEnd).getTime();
    if (!Number.isNaN(ms) && ms - now < EXPIRING_DAYS * DAY) return 'TEMPORARY_EXPIRING';
  }
  return 'TEMPORARY';
}

export type MissingArea = null | 'PRIMARY' | 'SUB' | 'BOTH';
export function missingOf(u: Pick<PostureUnit, 'site' | 'primary' | 'alternative'>): MissingArea {
  if (!u.site) return null;
  if (!u.primary && !u.alternative) return 'BOTH';
  if (!u.primary) return 'PRIMARY';
  if (!u.alternative) return 'SUB';
  return null;
}

/** Arabic label for the completeness dimension, as shown in list rows and the detail card. */
export const COMPLETENESS_LABEL: Record<Completeness, string> = {
  COMPLETE: 'موقف مكتمل',
  INCOMPLETE_DEPLOYMENT: 'مناطق الانتشار غير مكتملة',
  NO_STATIONING: 'بلا تمركز معتمد',
};

/** Arabic label for the timing dimension (shown as a secondary badge beside completeness when relevant). */
export const TIMING_LABEL: Record<Timing, string> = {
  PERMANENT: 'دائم',
  TEMPORARY: 'تمركز مؤقت',
  TEMPORARY_EXPIRING: 'مؤقت — ينتهي قريبًا',
  NONE: '—',
};

export const MISSING_LABEL: Record<Exclude<MissingArea, null>, string> = {
  PRIMARY: 'ينقص الرئيسية',
  SUB: 'ينقص الفرعية',
  BOTH: 'تنقص الرئيسية والفرعية',
};

/**
 * Semantic row colour tokens. Match the CSS swatches in app.css (`.tz-sw-ok`, `.tz-sw-warn`, `.tz-sw-off` and the
 * clock-tone classes). The map paint layers read from these same values so the map legend and the right-rail dots
 * carry the same meaning.
 */
export const COMPLETENESS_TONE: Record<Completeness, 'ok' | 'warn' | 'off'> = {
  COMPLETE: 'ok',
  INCOMPLETE_DEPLOYMENT: 'warn',
  NO_STATIONING: 'off',
};
export const TIMING_TONE: Record<Timing, '' | 'temp' | 'expiring'> = {
  PERMANENT: '',
  TEMPORARY: 'temp',
  TEMPORARY_EXPIRING: 'expiring',
  NONE: '',
};

/**
 * The right rail's four tabs and the bottom dock's six clickable chips read from the same union: one filter drives
 * list AND map, so the filtered right-rail population and the map's rendered population are always the same set.
 */
export type PostureFilter =
  | 'ALL'
  | 'COMPLETE'
  | 'INCOMPLETE'
  | 'NO_STATIONING'
  | 'REQUESTS'
  | 'TEMPORARY'
  | 'EXPIRING';

/** Does a unit belong to a given filter? NO_STATIONING units never belong to COMPLETE/INCOMPLETE/TEMPORARY/EXPIRING. */
export function matchesFilter(u: Pick<PostureUnit, 'site' | 'primary' | 'alternative' | 'kind' | 'plannedEnd' | 'request'>, f: PostureFilter, now = Date.now()): boolean {
  if (f === 'ALL') return true;
  const c = completenessOf(u);
  const t = timingOf(u, now);
  if (f === 'COMPLETE') return c === 'COMPLETE';
  if (f === 'INCOMPLETE') return c === 'INCOMPLETE_DEPLOYMENT';
  if (f === 'NO_STATIONING') return c === 'NO_STATIONING';
  if (f === 'REQUESTS') return !!u.request;
  if (f === 'TEMPORARY') return t === 'TEMPORARY' || t === 'TEMPORARY_EXPIRING';
  if (f === 'EXPIRING') return t === 'TEMPORARY_EXPIRING';
  return true;
}

/** Live counts for the bottom dock and tab badges — zero hard-coded numbers; everything is computed from the payload. */
export function postureCounts(units: readonly PostureUnit[], now = Date.now()) {
  const list = units ?? [];
  let complete = 0, incomplete = 0, noStationing = 0, temporary = 0, expiring = 0, withPrimary = 0, withSub = 0, both = 0, requests = 0;
  const sites = new Set<string>();
  for (const u of list) {
    const c = completenessOf(u);
    if (c === 'COMPLETE') complete++;
    else if (c === 'INCOMPLETE_DEPLOYMENT') incomplete++;
    else noStationing++;
    const t = timingOf(u, now);
    if (t === 'TEMPORARY' || t === 'TEMPORARY_EXPIRING') temporary++;
    if (t === 'TEMPORARY_EXPIRING') expiring++;
    if (u.primary) withPrimary++;
    if (u.alternative) withSub++;
    if (u.primary && u.alternative) both++;
    if (u.request) requests++;
    if (u.site) sites.add(u.site.id);
  }
  return {
    all: list.length,
    complete,
    incomplete,
    noStationing,
    temporary,
    expiring,
    withPrimary,
    withSub,
    both,
    requests,
    sites: sites.size,
  };
}

