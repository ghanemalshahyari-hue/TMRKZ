import { setTheme, useTheme } from '../lib/theme';

/** Chooses the light or dark colours; kept in this browser. */
export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'الوضع الداكن' : 'الوضع الفاتح';
  return (
    <button type="button" className="theme-toggle" data-testid="theme-toggle" data-theme-now={theme} aria-label={label} title={label} onClick={() => setTheme(next)}>
      {next === 'dark' ? (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="currentColor" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" /></svg>
      )}
    </button>
  );
}
