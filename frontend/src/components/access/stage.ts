import type { StagedOp, WorkspaceCell, WorkspaceColumn, WorkspacePerson } from '../../api/client';

/**
 * The pending changes of «إدارة الصلاحيات والوحدات» (ADR-058, as TNQL): ticking a box stages a change and saves nothing;
 * ticking it back undoes it. «حفظ التعديلات» sends them together for review, then applies them under one audit reference.
 */
export type Pending = Record<string, StagedOp>;

export const cellKey = (personId: string, roleCode: string) => personId + '|' + roleCode;

/** Why a cell cannot be ticked here, or null: the person's lock (one's own row, a system account) or the column's. */
export function lockOf(person: WorkspacePerson, column: WorkspaceColumn): string | null {
  return person.lock ?? column.lock;
}

/** Stages the opposite of what the cell holds directly, or undoes the change already staged on it. */
export function toggle(pending: Pending, person: WorkspacePerson, roleCode: string): Pending {
  const key = cellKey(person.id, roleCode);
  const next = { ...pending };
  if (next[key]) delete next[key];
  else next[key] = { personId: person.id, roleCode, action: person.cells[roleCode]?.direct ? 'REVOKE' : 'GRANT' };
  return next;
}

/** Whether the box shows ticked: the staged change, or else whether the person holds it directly here. */
export function ticked(pending: Pending, personId: string, roleCode: string, cell: WorkspaceCell | undefined): boolean {
  const staged = pending[cellKey(personId, roleCode)];
  return staged ? staged.action === 'GRANT' : !!cell?.direct;
}

/**
 * «إضافة صلاحية» / «إزالة صلاحية» over the chosen rows: stages it for every row where it changes something and the cell is
 * not locked; rows that already match are left as they are. Returns the new pending set and how many rows were staged.
 */
export function bulk(pending: Pending, people: WorkspacePerson[], column: WorkspaceColumn, action: 'GRANT' | 'REVOKE'): { pending: Pending; staged: number } {
  const next = { ...pending };
  let staged = 0;
  for (const p of people) {
    if (lockOf(p, column) || column.mode !== 'CHECK') continue;
    const held = !!p.cells[column.code]?.direct;
    const key = cellKey(p.id, column.code);
    if ((action === 'GRANT') === held) {
      // already as asked: drop a staged change that would undo it
      if (next[key]) delete next[key];
      continue;
    }
    next[key] = { personId: p.id, roleCode: column.code, action };
    staged++;
  }
  return { pending: next, staged };
}

export function counts(pending: Pending): { total: number; grants: number; revokes: number } {
  const ops = Object.values(pending);
  const grants = ops.filter((o) => o.action === 'GRANT').length;
  return { total: ops.length, grants, revokes: ops.length - grants };
}

/** Arabic count of changes, as the page reads it: «تعديل واحد», «تعديلان», «3 تعديلات», «11 تعديلاً». */
export function changes(n: number): string {
  if (n === 1) return 'تعديل واحد';
  if (n === 2) return 'تعديلان';
  if (n >= 3 && n <= 10) return n + ' تعديلات';
  return n + ' تعديلاً';
}
