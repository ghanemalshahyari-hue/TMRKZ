import { describe, expect, it } from 'vitest';
import { faviconFor } from './theme';
import { APP_NAME, pageName, tabTitle } from './title';
import type { NavLink } from './navigation';

const links: NavLink[] = [
  { view: 'home', label: 'الرئيسية', icon: 'home' },
  { view: 'restationing', label: 'طلب مناطق انتشار', icon: 'layers', id: 'DEPLOYMENT_AREAS', href: '#restationing/new?purpose=DEPLOYMENT_AREAS' },
  { view: 'restationing', label: 'طلب إعادة تمركز', icon: 'swap', id: 'RESTATIONING', href: '#restationing/new?purpose=RESTATIONING' },
  { view: 'allRequests', label: 'الطلبات', icon: 'file' },
];

describe('browser tab (owner, 27 Nov 2026)', () => {
  it('names the page, then the application, all in Arabic', () => {
    expect(tabTitle('الرئيسية')).toBe('الرئيسية — تمركز');
    expect(tabTitle('  ')).toBe(APP_NAME);
    expect(tabTitle(null)).toBe('تمركز');
    expect(tabTitle('تسجيل الدخول')).not.toMatch(/[A-Za-z]/);
  });

  it('takes the top-bar entry of the address, then of the view, then the page name', () => {
    expect(pageName('home', links, '#home')).toBe('الرئيسية');
    expect(pageName('restationing', links, '#restationing/new?purpose=RESTATIONING')).toBe('طلب إعادة تمركز');
    expect(pageName('restationing', links, '#restationing/new?purpose=DEPLOYMENT_AREAS')).toBe('طلب مناطق انتشار');
    expect(pageName('allRequests', links, '#allRequests')).toBe('الطلبات');
    expect(pageName('settings', [], '#settings')).toBeTruthy();
    expect(pageName('home', [], '')).toBe('الرئيسية');
  });

  it('shows the application mark of the chosen theme', () => {
    expect(faviconFor('light')).toBe('/favicon-light.svg');
    expect(faviconFor('dark')).toBe('/favicon-dark.svg');
  });
});
