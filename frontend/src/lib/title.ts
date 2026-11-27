import { NAV, type View } from './app';
import type { NavLink } from './navigation';

/**
 * The browser tab (owner, 27 Nov 2026): the page the person is on, then the application's Arabic name, all in Arabic so the
 * tab reads right to left and nothing is cut in the middle («الرئيسية — تمركز»). The icon beside it follows the theme
 * (lib/theme.ts).
 */
export const APP_NAME = 'تمركز';

export function tabTitle(page?: string | null): string {
  const p = page?.trim();
  return p ? `${p} — ${APP_NAME}` : APP_NAME;
}

/** The name of the page on screen: the top-bar entry for this address or view, else the page's own name. */
export function pageName(view: View, links: NavLink[], hash = ''): string | null {
  const byAddress = links.find((l) => l.href && hash.startsWith(l.href));
  if (byAddress) return byAddress.label;
  const plain = links.find((l) => !l.href && l.view === view);
  if (plain) return plain.label;
  if (view === 'home') return 'الرئيسية';
  return NAV.find(([id]) => id === view)?.[2] ?? null;
}
