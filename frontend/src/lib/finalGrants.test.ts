import { describe, expect, it } from 'vitest';
import type { AccessScopeTree } from '../api/client';
import { branchLevels, counter, incomplete, initialChoice, toSpec, today } from './finalGrants';

const unit = { id: 'u-sec', name: 'قسم صحة 1-أ' };
const names = new Map([['u-a', 'وحدة أ']]);

describe('final access approval, role by role (ADR-069)', () => {
  it('starts each role from the scope advised or asked, at the person’s unit', () => {
    expect(initialChoice({ code: 'REQUESTER', name: 'مقدم الطلب' }, false, null, unit, names, []).byDefault).toBe(true);
    expect(initialChoice({ code: 'REQUESTER', name: 'x' }, false, { mode: 'UNIT', ids: [] }, unit, names, []).units).toEqual([{ id: 'u-sec', name: 'قسم صحة 1-أ', mode: 'ONE', levels: [] }]);
    expect(initialChoice({ code: 'REQUESTER', name: 'x' }, false, { mode: 'UNIT_TREE', ids: [] }, unit, names, []).units[0].mode).toBe('BRANCH');
    expect(initialChoice({ code: 'REQUESTER', name: 'x' }, false, { mode: 'UNITS', ids: ['u-a'] }, unit, names, []).units[0].name).toBe('وحدة أ');
    expect(initialChoice({ code: 'FYI', name: 'x' }, false, { mode: 'SITES', ids: ['s1'] }, unit, names, [{ id: 's1', name: 'موقع' }]).sites).toEqual([{ id: 's1', name: 'موقع' }]);
  });

  it('sends exactly the grant/target/levels model: «إدارة الصحة» with levels 9 and 10 for unit operations', () => {
    const c = { ...initialChoice({ code: 'UNIT_OPERATIONS_APPROVER', name: 'معتمد عمليات الوحدة' }, true, null, unit, names, []), byDefault: false,
      units: [{ id: 'u-health', name: 'إدارة الصحة', mode: 'LEVELS' as const, levels: [10, 9] }], validTo: '2027-11-16' };
    const spec = toSpec(c, new Date('2026-11-16T10:00:00'));
    expect(spec.role).toBe('UNIT_OPERATIONS_APPROVER');
    expect(spec.scope).toEqual({ mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: 'u-health', includeDescendants: true, levels: [9, 10] }] });
    expect(spec.validFrom).toBeUndefined();
    expect(new Date(spec.validTo!).getDate()).toBe(16);
    expect(toSpec({ ...c, byDefault: true }).scope).toBeUndefined();
    expect(toSpec({ ...c, units: [{ id: 'u', name: 'u', mode: 'ONE', levels: [] }] }).scope?.targets?.[0]).toEqual({ kind: 'ORGANIZATION', id: 'u', includeDescendants: false, levels: null });
  });

  it('a start today is «from the activation»; a later start is sent', () => {
    const now = new Date('2026-11-16T10:00:00');
    const c = { ...initialChoice({ code: 'R', name: 'r' }, false, null, unit, names, []) };
    expect(toSpec({ ...c, validFrom: today(now) }, now).validFrom).toBeUndefined();
    expect(toSpec({ ...c, validFrom: '2026-12-01' }, now).validFrom).toBe(new Date('2026-12-01T00:00:00').toISOString());
  });

  it('says what is missing before a preview', () => {
    const c = initialChoice({ code: 'R', name: 'مقدم الطلب' }, false, null, unit, names, []);
    expect(incomplete(c)).toBeNull();
    expect(incomplete({ ...c, byDefault: false })).toContain('اختر وحدة');
    expect(incomplete({ ...c, byDefault: false, units: [{ id: 'u', name: 'u', mode: 'LEVELS', levels: [] }] })).toContain('مستوى');
    expect(incomplete({ ...c, validFrom: '2027-01-02', validTo: '2027-01-01' })).toContain('قبل بدايتها');
  });

  it('counts what a choice covers in the branch, and lists its levels', () => {
    const tree: AccessScopeTree = {
      unitId: 'c', rootId: 'm', path: ['c', 'b', 'm'], units: [
        { id: 'm', name: 'الرئيسية', parentId: null, depth: 0, level: 6, main: true },
        { id: 'b', name: 'إدارة الصحة', parentId: 'm', depth: 1, level: 7, main: false },
        { id: 'c', name: 'قسم 1', parentId: 'b', depth: 2, level: 9, main: false },
        { id: 'd', name: 'قسم 2', parentId: 'b', depth: 2, level: 9, main: false },
        { id: 'e', name: 'فرع', parentId: 'c', depth: 3, level: 10, main: false },
      ] };
    const count = counter(tree);
    expect(count('b', 'ONE', [])).toBe(1);
    expect(count('b', 'BRANCH', [])).toBe(4);
    expect(count('b', 'LEVELS', [9, 10])).toBe(3);
    expect(count('zz', 'ONE', [])).toBeUndefined();
    expect(branchLevels(tree).map((l) => [l.level, l.units])).toEqual([[6, 1], [7, 1], [9, 2], [10, 1]]);
  });
});
