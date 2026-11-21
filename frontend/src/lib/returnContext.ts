/**
 * Return context (owner UX consolidation §9, 20 Nov 2026): when the user starts a stationing action from a non-stationing
 * workspace (Sites, Units, Requests, Home, Notification…), the origin's hash is kept in sessionStorage so the «إلغاء والعودة»
 * button goes back to the same page with the same selection, not to a generic home. The storage key is session-scoped and
 * clears itself on use; it carries only hashes, never any business data.
 */
const KEY = 'tmrkz.returnTo';

export function rememberReturn(href: string | null | undefined): void {
  try { if (href) sessionStorage.setItem(KEY, href); } catch { /* storage disabled */ }
}

export function peekReturn(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

export function popReturn(fallback = '#home'): string {
  try {
    const v = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return v ?? fallback;
  } catch { return fallback; }
}

/** The one-liner used by links that start a stationing action: remember where we came from, then navigate. */
export function startStationing(from: string, to: string): void {
  rememberReturn(from);
  location.hash = to.startsWith('#') ? to.slice(1) : to;
}
