import type { DbMigrationBackup, DbMigrationConnectInput, DbMigrationDecisions, DbMigrationTable } from '../api/types';

/**
 * «مركز ترحيل قاعدة البيانات» (ADR-094): the pure rules of the screen — what the connection form still lacks, which tables
 * are chosen by default, which chosen tables still need a conflict decision, the totals of a selection, and whether the
 * backup gate lets the commit through. The server applies the same rules; these only keep the buttons honest.
 */

export type ConnectionForm = { host: string; port: string; database: string; username: string; password: string; schema: string };

export const EMPTY_FORM: ConnectionForm = { host: '', port: '5432', database: '', username: '', password: '', schema: 'public' };

/** The form's first problem in plain words, or '' when the server may be asked. */
export function formProblem(f: ConnectionForm): string {
  if (!f.host.trim()) return 'اكتب اسم الخادم أو عنوانه';
  if (/[\s/@:?]/.test(f.host.trim())) return 'اسم الخادم بلا مسار أو بيانات دخول';
  const port = Number(f.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'المنفذ رقم بين 1 و65535';
  if (!f.database.trim()) return 'اكتب اسم قاعدة البيانات';
  if (!f.username.trim()) return 'اكتب اسم المستخدم';
  if (!f.password) return 'اكتب كلمة المرور';
  if (f.schema.trim() && !/^[a-z_][a-z0-9_]*$/.test(f.schema.trim())) return 'اسم المخطط حروف صغيرة وأرقام وشرطة سفلية';
  return '';
}

export function toConnectInput(f: ConnectionForm): DbMigrationConnectInput {
  return {
    type: 'CONNECTION',
    host: f.host.trim(),
    port: Number(f.port),
    database: f.database.trim(),
    username: f.username.trim(),
    password: f.password,
    schema: f.schema.trim() || 'public',
  };
}

/** The default selection: every shared table with new rows. */
export function defaultSelection(tables: DbMigrationTable[]): string[] {
  return tables.filter((t) => t.newRows > 0).map((t) => t.table);
}

/** The chosen tables with conflicts that have neither the KEEP default confirmed nor every listed record decided. */
export function undecidedTables(tables: DbMigrationTable[], chosen: string[], decisions: DbMigrationDecisions): string[] {
  return tables
    .filter((t) => chosen.includes(t.table) && t.conflicts > 0)
    .filter((t) => {
      const d = decisions[t.table];
      if (d?.confirmed) return false;
      const listed = t.conflictDetails.length;
      const decided = Object.keys(d?.records ?? {}).filter((k) => t.conflictDetails.some((c) => c.key === k)).length;
      return !(t.conflicts === listed && listed > 0 && decided === listed);
    })
    .map((t) => t.table);
}

/** New, identical, conflicting and taken-from-source counts over the chosen tables. */
export function selectionTotals(tables: DbMigrationTable[], chosen: string[], decisions: DbMigrationDecisions) {
  const out = { tables: 0, newRows: 0, identical: 0, conflicts: 0, takeSource: 0 };
  for (const t of tables) {
    if (!chosen.includes(t.table)) continue;
    out.tables += 1;
    out.newRows += t.newRows;
    out.identical += t.identical;
    out.conflicts += t.conflicts;
    out.takeSource += Object.values(decisions[t.table]?.records ?? {}).filter((v) => v === 'TAKE_SOURCE').length;
  }
  return out;
}

/** Why the commit is still closed, or '' when the backup gate lets it through (with the attestation when needed). */
export function backupGateProblem(b: DbMigrationBackup | null, attested: boolean): string {
  if (!b) return 'حالة النسخة الاحتياطية لم تُقرأ بعد';
  if (!b.found) return b.problem || 'لا نسخة احتياطية؛ خذ نسخة بـ sh ops/backup.sh أولاً';
  if (!b.current) return b.problem || 'آخر نسخة احتياطية قديمة؛ خذ نسخة جديدة';
  if (!b.verified && !attested) return 'النسخة لم يُتحقق منها: شغّل sh ops/verify-backup.sh ' + b.dir + ' ثم أكد نجاحه';
  return '';
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' بايت';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' ك.ب';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' م.ب';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' ج.ب';
}
