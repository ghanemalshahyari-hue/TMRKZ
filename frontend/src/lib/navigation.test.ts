import { describe, expect, it } from 'vitest';
import type { Permission } from '../api/types';
import { primaryNav, createActions, setGrantFacts, setSupportSeat } from './navigation';
import { STATIONING_V3_ENABLED } from './stationingV3';

describe('navigation — top-bar ways restored (owner, 20 Nov 2026 reversal)', () => {
  // The three «way» tabs stand right after «الرئيسية»: one click and the work opens. The way views are V3-gated; the unit
  // test build is V3-off by design (stationingV3.test.ts), so here we only assert the V3-off behaviour — the V3-on behaviour
  // stays covered by stationingHub.test.ts.
  it('primary nav carries no «way» tab when the restationing view is absent from the build (STATIONING_V3 off)', () => {
    setGrantFacts([]);
    setSupportSeat(null);
    const canAll = () => true;
    const links = primaryNav(canAll as (p: Permission) => boolean, false);
    if (!STATIONING_V3_ENABLED) {
      // without the restationing/siteSetup views in this build, the way tabs disappear — the ways still open through «＋ إنشاء»
      expect(links.some((l) => l.id === 'SITE_SETUP' || l.id === 'DEPLOYMENT_AREAS' || l.id === 'RESTATIONING')).toBe(false);
    }
  });

  it('«الاعتمادات» is hidden when the person holds no REVIEW capability (admin top-bar refusal fix)', () => {
    setGrantFacts([]);
    setSupportSeat(null);
    const withoutReview = (p: Permission) => p === 'CONFIGURE' || p === 'MANAGE_ACCESS' || p === 'AUDIT' || p === 'VIEW';
    const labels = primaryNav(withoutReview, false).map((l) => l.label);
    expect(labels).not.toContain('الاعتمادات');
  });

  it('«＋ إنشاء» offers every stationing way the person may use plus «طلب صلاحية»', () => {
    setGrantFacts([]);
    setSupportSeat(null);
    const can = (p: Permission) => ['CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION', 'MANAGE_FACILITIES', 'CORRECT_STATIONING', 'VIEW', 'CREATE'].includes(p);
    const actions = createActions(can, false);
    const ids = actions.map((a) => a.id);
    expect(ids).toContain('ACCESS');
    expect(actions.length).toBeGreaterThan(1);
    expect(actions.every((a) => a.href.startsWith('#'))).toBe(true);
  });

  it('«＋ إنشاء» for a zero-access person offers only «طلب صلاحية» — their one entry into the system', () => {
    setGrantFacts([]);
    setSupportSeat(null);
    const canNone = () => false;
    const actions = createActions(canNone as (p: Permission) => boolean, false);
    expect(actions.map((a) => a.id)).toEqual(['ACCESS']);
  });
});
