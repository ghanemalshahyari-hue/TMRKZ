import { describe, expect, it } from 'vitest';
import type { DbMigrationBackup, DbMigrationTable } from '../api/types';
import { EMPTY_FORM, backupGateProblem, defaultSelection, formProblem, selectionTotals, toConnectInput, undecidedTables } from './dbMigration';

const table = (t: Partial<DbMigrationTable> & { table: string }): DbMigrationTable => ({
  category: 'OTHER',
  primaryKey: 'id',
  sourceRows: 0,
  currentRows: 0,
  newRows: 0,
  conflicts: 0,
  identical: 0,
  conflictSamples: [],
  conflictDetails: [],
  conflictDetailsTruncated: false,
  sharedColumns: [],
  secretColumns: [],
  sourceOnlyColumns: [],
  currentOnlyColumns: [],
  dependsOn: [],
  ...t,
});

describe('the migration center rules (ADR-094)', () => {
  it('names what the connection form still lacks, then builds the request', () => {
    expect(formProblem(EMPTY_FORM)).toBe('اكتب اسم الخادم أو عنوانه');
    const f = { ...EMPTY_FORM, host: 'old-db', database: 'mover', username: 'mover', password: 'x' };
    expect(formProblem(f)).toBe('');
    expect(formProblem({ ...f, host: 'user@old-db' })).toContain('بلا مسار');
    expect(formProblem({ ...f, port: '70000' })).toContain('المنفذ');
    expect(formProblem({ ...f, schema: 'Old Schema' })).toContain('المخطط');
    expect(toConnectInput({ ...f, schema: '' })).toEqual({ type: 'CONNECTION', host: 'old-db', port: 5432, database: 'mover', username: 'mover', password: 'x', schema: 'public' });
  });

  it('chooses every table with new rows by default', () => {
    const tables = [table({ table: 'organization', newRows: 2 }), table({ table: 'person', identical: 5 }), table({ table: 'site', newRows: 1, conflicts: 1 })];
    expect(defaultSelection(tables)).toEqual(['organization', 'site']);
  });

  it('a chosen table with conflicts needs the KEEP default confirmed or every listed record decided', () => {
    const conflicts = [{ key: 'a', columns: [] }, { key: 'b', columns: [] }];
    const tables = [table({ table: 'organization', newRows: 1, conflicts: 2, conflictDetails: conflicts }), table({ table: 'site', newRows: 1 })];
    expect(undecidedTables(tables, ['organization', 'site'], {})).toEqual(['organization']);
    expect(undecidedTables(tables, ['site'], {})).toEqual([]);
    expect(undecidedTables(tables, ['organization'], { organization: { confirmed: true } })).toEqual([]);
    expect(undecidedTables(tables, ['organization'], { organization: { records: { a: 'TAKE_SOURCE' } } })).toEqual(['organization']);
    expect(undecidedTables(tables, ['organization'], { organization: { records: { a: 'TAKE_SOURCE', b: 'KEEP' } } })).toEqual([]);
    // more conflicts than the preview lists: only the table confirmation covers them
    const many = [table({ table: 'audit_event', conflicts: 300, conflictDetails: conflicts })];
    expect(undecidedTables(many, ['audit_event'], { audit_event: { records: { a: 'KEEP', b: 'KEEP' } } })).toEqual(['audit_event']);
    expect(undecidedTables(many, ['audit_event'], { audit_event: { confirmed: true } })).toEqual([]);
  });

  it('totals the selection, counting the records taken from the source', () => {
    const tables = [table({ table: 'organization', newRows: 2, identical: 3, conflicts: 2 }), table({ table: 'person', newRows: 4, conflicts: 1 })];
    expect(selectionTotals(tables, ['organization'], { organization: { records: { a: 'TAKE_SOURCE', b: 'KEEP' } } })).toEqual({ tables: 1, newRows: 2, identical: 3, conflicts: 2, takeSource: 1 });
    expect(selectionTotals(tables, ['organization', 'person'], {})).toEqual({ tables: 2, newRows: 6, identical: 3, conflicts: 3, takeSource: 0 });
  });

  it('the backup gate: a current backup, verified by its result file or attested by the administrator', () => {
    const b: DbMigrationBackup = { found: true, dir: 'tmrkz-mover-20261120T100000Z', createdAt: '2026-11-20T10:00:00Z', schemaVersion: 56, verified: false, verifiedAt: null, current: true, maxAgeHours: 24, problem: null };
    expect(backupGateProblem(null, false)).toContain('لم تُقرأ');
    expect(backupGateProblem({ ...b, found: false, problem: 'لا نسخة' }, true)).toBe('لا نسخة');
    expect(backupGateProblem({ ...b, current: false, problem: 'قديمة' }, true)).toBe('قديمة');
    expect(backupGateProblem(b, false)).toContain('verify-backup.sh tmrkz-mover-20261120T100000Z');
    expect(backupGateProblem(b, true)).toBe('');
    expect(backupGateProblem({ ...b, verified: true }, false)).toBe('');
  });
});
