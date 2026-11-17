import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_NAMES, permissionName } from './labels';

// The actions the server knows after ADR-078 (owner, 17 Nov 2026): the mirror of ae.mover.access.Permission.
const SERVER = ['VIEW', 'VIEW_SUMMARY', 'CREATE', 'EDIT', 'REVIEW', 'APPROVE', 'EXPORT', 'EXECUTE', 'MANAGE_FACILITIES', 'MANAGE_ACCESS', 'CONFIGURE', 'AUDIT',
  'VIEW_SOURCE_IDENTIFIERS', 'CLOSE', 'CORRECT_STATIONING', 'MANAGE_SITE_LINKS', 'REPLAY_STATIONING_EVENTS', 'CREATE_RESTATIONING', 'ACTIVATE_STATIONING',
  'REQUEST_SITE_REGISTRATION', 'DECIDE_UNIT_OPERATIONS', 'FINAL_APPROVE_STATIONING', 'MANAGE_FYI_DISTRIBUTION', 'VIEW_OPERATIONAL_POSTURE', 'APPROVE_HIERARCHY'];
const REMOVED = ['CREATE_INITIAL_STATIONING', 'CREATE_DEPLOYMENT_REQUEST', 'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION', 'DECIDE_PRE_ACTIVATION_CANCELLATION',
  'ACTIVATE_TEMPORARY_EXTENSION', 'DECIDE_EARLY_RETURN', 'DECIDE_BEFORE_START_CANCELLATION'];

describe('the actions of the role catalogue (ADR-078)', () => {
  it('lists exactly the server\'s actions, each with its Arabic name, and none of the removed ones', () => {
    expect([...PERMISSIONS].sort()).toEqual([...SERVER].sort());
    expect(Object.keys(PERMISSION_NAMES).sort()).toEqual([...SERVER].sort());
    for (const r of REMOVED) expect(PERMISSIONS as string[]).not.toContain(r);
  });

  it('one right opens re-stationing and deployment-area requests', () => {
    expect(PERMISSION_NAMES.CREATE_RESTATIONING).toBe('طلب إعادة التمركز ومناطق الانتشار');
  });

  it('a removed action in a version\'s history reads as its code, never as nothing', () => {
    expect(permissionName('CREATE_DEPLOYMENT_REQUEST')).toBe('CREATE_DEPLOYMENT_REQUEST');
    expect(permissionName('FINAL_APPROVE_STATIONING')).toBe('الاعتماد النهائي للتمركز');
  });
});
