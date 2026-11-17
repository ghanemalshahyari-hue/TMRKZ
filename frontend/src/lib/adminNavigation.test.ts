import { afterEach, describe, expect, it } from 'vitest';
import type { Permission } from '../api/types';
import { newRequestHref, restriction, setGrantFacts } from './navigation';

// «مدير النظام» sees neither «طلب صلاحية» nor «طلب جديد»; its «طلب إعادة التمركز» starts from «إعادة التمركز» (owner, 17 Nov 2026)
const ADMIN = { roleCode: 'SYSTEM_ADMIN', permissions: ['CONFIGURE', 'MANAGE_ACCESS', 'MANAGE_FACILITIES', 'VIEW_SOURCE_IDENTIFIERS', 'CREATE_RESTATIONING'] as Permission[] };
const REQUESTER = { roleCode: 'STATIONING_REQUESTER', permissions: ['VIEW', 'CREATE_INITIAL_STATIONING', 'CREATE_DEPLOYMENT_REQUEST', 'CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION'] as Permission[] };
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
});
