import { describe, expect, it } from 'vitest';
import type { Permission } from '../api/types';
import { EMPTY_ROLE, emptyRoleCodes, isEmptyRole, pickableRoles, withoutEmptyRoles } from './rolePicker';

const role = (code: string, permissions: Permission[], system = false) => ({ code, name: code, permissions, system });
const catalogue = [
  role('SYSTEM_ADMIN', ['CONFIGURE', 'MANAGE_ACCESS'], true),
  role('STATIONING_REQUESTER', ['VIEW', 'CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION']),
  role('REQUESTER', []),
  role('DEPLOYMENT_REQUESTER', []),
  role('FINAL_APPROVER', ['VIEW', 'REVIEW', 'APPROVE', 'EXPORT', 'FINAL_APPROVE_STATIONING']),
];

describe('role pickers never offer a role with no permissions (owner, 17 Nov 2026)', () => {
  it('keeps the roles with permissions, without the system role unless the page lists it', () => {
    expect(pickableRoles(catalogue).map((r) => r.code)).toEqual(['STATIONING_REQUESTER', 'FINAL_APPROVER']);
    expect(pickableRoles(catalogue, { system: true }).map((r) => r.code)).toEqual(['SYSTEM_ADMIN', 'STATIONING_REQUESTER', 'FINAL_APPROVER']);
    expect(isEmptyRole(role('X', []))).toBe(true);
    expect(EMPTY_ROLE).toBe('بلا صلاحيات');
  });

  it('filters an offered list against the catalogue, and leaves it to the server when the catalogue cannot be read', () => {
    const offered = [{ code: 'REQUESTER', name: 'مقدم الطلب (مرافق — غير مستخدم)' }, { code: 'STATIONING_REQUESTER', name: 'مقدم الطلب' }, { code: 'UNKNOWN', name: 'دور لا يعرفه الفهرس' }];
    expect(withoutEmptyRoles(offered, catalogue).map((r) => r.code)).toEqual(['STATIONING_REQUESTER', 'UNKNOWN']);
    expect(withoutEmptyRoles(offered, null)).toHaveLength(3);
    expect([...emptyRoleCodes(catalogue)]).toEqual(['REQUESTER', 'DEPLOYMENT_REQUESTER']);
    expect(emptyRoleCodes(undefined).size).toBe(0);
  });
});
