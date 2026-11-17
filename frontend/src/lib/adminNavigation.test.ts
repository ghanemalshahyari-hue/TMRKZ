import { afterEach, describe, expect, it } from 'vitest';
import type { Permission } from '../api/types';
import { newRequestHref, restriction, setGrantFacts } from './navigation';

// «مدير النظام» sees neither «طلب صلاحية» nor «طلب جديد»; its «طلب إعادة التمركز» starts from «إعادة التمركز» (owner, 17 Nov 2026)
const ADMIN = { roleCode: 'SYSTEM_ADMIN', permissions: ['CONFIGURE', 'MANAGE_ACCESS', 'MANAGE_FACILITIES', 'VIEW_SOURCE_IDENTIFIERS', 'CREATE_RESTATIONING', 'MANAGE_SITE_LINKS', 'CORRECT_STATIONING', 'REPLAY_STATIONING_EVENTS'] as Permission[] };
// «إنشاء طلبات التمركز» after ADR-078: one right for re-stationing and deployment areas, and site registration
const REQUESTER = { roleCode: 'STATIONING_REQUESTER', permissions: ['VIEW', 'CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION'] as Permission[] };
const can = (grants: { permissions: Permission[] }[]) => (p: Permission) => grants.some((g) => g.permissions.includes(p));

describe('system administrator navigation', () => {
  afterEach(() => setGrantFacts(null));

  it('a system administrator has no «طلب صلاحية» and no «طلب جديد»; «＋ طلب جديد» opens the re-stationing editor', () => {
    setGrantFacts([ADMIN]);
    expect(restriction('requestAccess', can([ADMIN]), false)).toBe(true);
    expect(restriction('newRequest', can([ADMIN]), false)).toBe(true);
    expect(restriction('restationing', can([ADMIN]), false)).toBe(false);
    expect(newRequestHref()).toBe('#restationing/new?purpose=RESTATIONING');
  });

  it('a request right from another grant keeps «طلب جديد» for an administrator who also requests', () => {
    setGrantFacts([ADMIN, REQUESTER]);
    expect(restriction('newRequest', can([ADMIN, REQUESTER]), false)).toBe(false);
    expect(restriction('requestAccess', can([ADMIN, REQUESTER]), false)).toBe(true);
    expect(newRequestHref()).toBe('#newRequest');
  });

  it('everyone else keeps both: a requester, and a person with no permission at all', () => {
    setGrantFacts([REQUESTER]);
    expect(restriction('requestAccess', can([REQUESTER]), false)).toBe(false);
    expect(restriction('newRequest', can([REQUESTER]), false)).toBe(false);
    expect(newRequestHref()).toBe('#newRequest');
    setGrantFacts([]);
    expect(restriction('requestAccess', can([]), false)).toBe(false);
    expect(restriction('newRequest', can([]), false)).toBe(true);
  });

  it('ADR-078: site registration alone keeps «طلب جديد»; the final approver, who now decides the lifecycle actions, opens «إعادة التمركز» and requests nothing', () => {
    const SITES = { roleCode: 'SITE_REGISTRATION_REQUESTER', permissions: ['VIEW', 'REQUEST_SITE_REGISTRATION'] as Permission[] };
    setGrantFacts([SITES]);
    expect(restriction('newRequest', can([SITES]), false)).toBe(false);
    const FINAL = { roleCode: 'FINAL_APPROVER', permissions: ['FINAL_APPROVE_STATIONING'] as Permission[] };
    setGrantFacts([FINAL]);
    expect(restriction('restationing', can([FINAL]), false)).toBe(false);
    expect(restriction('allRequests', can([FINAL]), false)).toBe(false);
    expect(restriction('newRequest', can([FINAL]), false)).toBe(true);
  });

  it('ADR-078: «معتمد عمليات الوحدة» manages facilities and site links, so «تهيئة المواقع» opens for it', () => {
    const OPS = { roleCode: 'UNIT_OPERATIONS_APPROVER', permissions: ['VIEW', 'REVIEW', 'DECIDE_UNIT_OPERATIONS', 'MANAGE_FACILITIES', 'MANAGE_SITE_LINKS'] as Permission[] };
    setGrantFacts([OPS]);
    expect(restriction('siteSetup', can([OPS]), false)).toBe(false);
    expect(restriction('newRequest', can([OPS]), false)).toBe(true);
  });
});
