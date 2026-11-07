import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'tmrkz-theme';

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** What the person chose in this browser; until they choose, the sand. */
export function initialTheme(saved: Theme | null): Theme {
  return saved ?? 'light';
}

let current: Theme = initialTheme(stored());
const listeners = new Set<() => void>();

function apply(theme: Theme) {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
}

apply(current); // on import, before the first paint

export function setTheme(theme: Theme) {
  current = theme;
  apply(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // a browser refusing storage still gets the theme for this page
  }
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
}
