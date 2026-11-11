import { describe, expect, it } from 'vitest';
import type { WorkspaceColumn, WorkspacePerson } from '../../api/client';
import { bulk, cellKey, changes, counts, lockOf, ticked, toggle } from './stage';

const col = (code: string, over: Partial<WorkspaceColumn> = {}): WorkspaceColumn => ({ code, name: code, mode: 'CHECK', finalOnly: false, lock: null, ...over });
const person = (id: string, held: string[] = [], over: Partial<WorkspacePerson> = {}): WorkspacePerson => ({
  id,
  displayName: id,
  employeeNo: id,
  active: true,
  added: false,
  acting: false,
  withoutHr: false,
  lock: null,
  cells: Object.fromEntries(held.map((c) => [c, { direct: { id: 'g-' + c, scopeText: '', validTo: '', all: false, units: 0 }, inherited: null, temporary: false }])),
  effective: held.length,
  grants: [],
  ...over,
});

describe('the staged changes of the access workspace (ADR-058)', () => {
  it('ticks a box as a pending change and unticks it back to nothing', () => {
    const p = person('p1');
    const once = toggle({}, p, 'REQ');
    expect(once[cellKey('p1', 'REQ')]).toEqual({ personId: 'p1', roleCode: 'REQ', action: 'GRANT' });
    expect(ticked(once, 'p1', 'REQ', p.cells.REQ)).toBe(true);
    expect(toggle(once, p, 'REQ')).toEqual({});
  });

  it('unticking a held role stages its removal', () => {
    const p = person('p1', ['REQ']);
    const next = toggle({}, p, 'REQ');
    expect(next[cellKey('p1', 'REQ')].action).toBe('REVOKE');
    expect(ticked(next, 'p1', 'REQ', p.cells.REQ)).toBe(false);
    expect(ticked({}, 'p1', 'REQ', p.cells.REQ)).toBe(true);
  });

  it('bulk add skips rows that already hold it and locked rows, and counts what it staged', () => {
    const rows = [person('a'), person('b', ['REQ']), person('c', [], { lock: 'حسابك' })];
    const { pending, staged } = bulk({}, rows, col('REQ'), 'GRANT');
    expect(staged).toBe(1);
    expect(Object.keys(pending)).toEqual([cellKey('a', 'REQ')]);
    expect(bulk({}, rows, col('REQ', { lock: 'لا تملك' }), 'GRANT').staged).toBe(0);
    expect(bulk({}, rows, col('REQ', { mode: 'ASSIGN' }), 'GRANT').staged).toBe(0);
  });

  it('bulk remove drops an opposite pending change instead of staging a no-op', () => {
    const a = person('a');
    const staged = toggle({}, a, 'REQ');
    expect(bulk(staged, [a], col('REQ'), 'REVOKE').pending).toEqual({});
  });

  it('counts and words the pending changes', () => {
    const p = toggle(toggle({}, person('a'), 'X'), person('b', ['X']), 'X');
    expect(counts(p)).toEqual({ total: 2, grants: 1, revokes: 1 });
    expect([1, 2, 3, 11].map(changes)).toEqual(['تعديل واحد', 'تعديلان', '3 تعديلات', '11 تعديلاً']);
    expect(lockOf(person('a', [], { lock: 'سبب' }), col('X'))).toBe('سبب');
  });
});
