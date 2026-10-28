// Date helpers copied from the prototype. Storage/API is UTC; display is Asia/Dubai (UTC+4, no DST).
export const TIMEZONE = 'Asia/Dubai';

/** Converts a Dubai-local `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` into a UTC ISO string. */
export function dubaiISO(v: string): string {
  return new Date(v.length === 10 ? v + 'T00:00:00+04:00' : v.slice(0, 16) + ':00+04:00').toISOString();
}

export function fullDate(v: string | null | undefined): string {
  return v
    ? new Intl.DateTimeFormat('ar-AE', { timeZone: TIMEZONE, year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(v))
    : 'دائم';
}

export function fullTime(v: string | null | undefined): string {
  return v
    ? new Intl.DateTimeFormat('ar-AE', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(v))
    : 'دون نهاية';
}

/** UTC ISO → Dubai-local `YYYY-MM-DDTHH:mm` for datetime-local inputs. */
export function localInput(v: string | null | undefined): string {
  return v
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(new Date(v))
        .replace(' ', 'T')
    : '';
}

/** UTC ISO → Dubai-local `YYYY-MM-DD`. */
export function localDay(v: string | null | undefined): string {
  return localInput(v).slice(0, 10);
}

/** Adds whole days to a `YYYY-MM-DD` string (calendar arithmetic, timezone independent). */
export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today in Dubai as `YYYY-MM-DD`. */
export function todayDubai(now: Date = new Date()): string {
  return localDay(now.toISOString());
}

/** `2026-11-03` → «03 نوفمبر» (calendar label; the input is already a Dubai-local day). */
export function dayLabel(day: string): string {
  return day.slice(8, 10) + ' ' + new Intl.DateTimeFormat('ar-AE', { timeZone: 'UTC', month: 'long' }).format(new Date(day + 'T00:00:00Z'));
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' بايت';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' ك.ب';
  return (n / 1024 / 1024).toFixed(1) + ' م.ب';
}
