import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_NAMES, permissionName } from './labels';

// The actions the server knows after ADR-095 — mirror of ae.mover.access.Permission. ACTIVATE_STATIONING and
// MANAGE_FYI_DISTRIBUTION were retired by ADR-095 (activation runs with the final approval; FYI is a per-unit
// configuration), so neither appears in the current catalogue.
const SERVER = ['VIEW', 'VIEW_SUMMARY', 'CREATE', 'EDIT', 'REVIEW', 'APPROVE', 'EXPORT', 'EXECUTE', 'MANAGE_FACILITIES', 'MANAGE_ACCESS', 'CONFIGURE', 'AUDIT',
  'VIEW_SOURCE_IDENTIFIERS', 'CLOSE', 'CORRECT_STATIONING', 'MANAGE_SITE_LINKS', 'REPLAY_STATIONING_EVENTS', 'CREATE_RESTATIONING',
  'REQUEST_SITE_REGISTRATION', 'DECIDE_UNIT_OPERATIONS', 'FINAL_APPROVE_STATIONING', 'VIEW_OPERATIONAL_POSTURE', 'APPROVE_HIERARCHY'];

describe('the actions of the role catalogue', () => {
  it('lists exactly the server\'s actions, each with its Arabic name', () => {
    expect([...PERMISSIONS].sort()).toEqual([...SERVER].sort());
    expect(Object.keys(PERMISSION_NAMES).sort()).toEqual([...SERVER].sort());
  });

  it('one right opens re-stationing and deployment-area requests', () => {
    expect(PERMISSION_NAMES.CREATE_RESTATIONING).toBe('طلب إعادة التمركز ومناطق الانتشار');
  });

  it('an unknown action name reads as its code, never as nothing', () => {
    expect(permissionName('SOMETHING_UNKNOWN')).toBe('SOMETHING_UNKNOWN');
    expect(permissionName('FINAL_APPROVE_STATIONING')).toBe('اعتماد نهائي');
  });
});
