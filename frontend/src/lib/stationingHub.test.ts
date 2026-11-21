import { describe, expect, it } from 'vitest';
import type { Permission } from '../api/types';
import { hubWays } from './stationingHub';
import { activeEntry, moreNav, primaryNav, type NavLink } from './navigation';
import { STATIONING_V3_ENABLED } from './stationingV3';

const holding = (...ps: Permission[]) => (p: Permission) => ps.includes(p);

describe('the three ways of stationing, as tabs of the top bar (owner, 17 Nov 2026)', () => {
  it('in the reference order, with the owner\'s words; deployment areas apart from re-stationing', () => {
    const ways = hubWays(holding('MANAGE_SITE_LINKS', 'CREATE_RESTATIONING'));
    expect(ways.map((w) => w.title)).toEqual(['تحديد مواقع التمركز المبدئية', 'طلب مناطق انتشار', 'طلب إعادة تمركز']);
    expect(ways.map((w) => w.icon)).toEqual(['tent', 'layers', 'swap']);
    expect(ways.every((w) => w.allowed)).toBe(true);
    expect(ways[0].href).toBe('#siteSetup');
    expect(ways[1].href).toContain('purpose=DEPLOYMENT_AREAS');
    expect(ways[2].href).toContain('purpose=RESTATIONING');
  });

  it('a way shows only to whoever may take it', () => {
    expect(hubWays(holding('VIEW', 'CREATE_RESTATIONING')).map((w) => w.allowed)).toEqual([false, true, true]);
    expect(hubWays(holding('MANAGE_FACILITIES')).map((w) => w.allowed)).toEqual([true, false, false]);
  });

  it('right after «الرئيسية» and «مساحة التمركز»; the list of requests stays in «المزيد» (owner, 20 Nov 2026 order)', () => {
    const can = holding('VIEW', 'MANAGE_SITE_LINKS', 'CREATE_RESTATIONING');
    const bar = primaryNav(can, false);
    if (STATIONING_V3_ENABLED) {
      expect(bar.slice(0, 5).map((l) => l.label)).toEqual(['الرئيسية', 'مساحة التمركز', 'تحديد مواقع التمركز المبدئية', 'طلب مناطق انتشار', 'طلب إعادة تمركز']);
      expect(bar.slice(2, 5).map((l) => l.id)).toEqual(['SITE_SETUP', 'DEPLOYMENT_AREAS', 'RESTATIONING']);
      expect(moreNav(can, false).map((l) => l.view)).toContain('restationing');
    } else {
      // a Stationing V3 build only (VITE_STATIONING_V3=true), as the views they open
      expect(bar.some((l) => l.id)).toBe(false);
    }
  });

  it('highlights the way whose address is open, never both request ways', () => {
    const links: NavLink[] = [
      { view: 'home', label: 'الرئيسية', icon: 'home' },
      { id: 'SITE_SETUP', view: 'siteSetup', label: 'تحديد مواقع التمركز المبدئية', icon: 'tent' },
      { id: 'DEPLOYMENT_AREAS', view: 'restationing', label: 'طلب مناطق انتشار', icon: 'layers', href: '#restationing/new?purpose=DEPLOYMENT_AREAS' },
      { id: 'RESTATIONING', view: 'restationing', label: 'طلب إعادة تمركز', icon: 'swap', href: '#restationing/new?purpose=RESTATIONING' },
    ];
    expect(activeEntry('restationing', links, '#restationing/new?purpose=DEPLOYMENT_AREAS&unit=u1')).toBe('DEPLOYMENT_AREAS');
    expect(activeEntry('restationing', links, '#restationing/new?purpose=RESTATIONING')).toBe('RESTATIONING');
    expect(activeEntry('siteSetup', links, '#siteSetup')).toBe('SITE_SETUP');
    expect(activeEntry('restationing', links, '#restationing')).toBe('more');
    expect(activeEntry('home', links, '#home')).toBe('home');
  });
});
