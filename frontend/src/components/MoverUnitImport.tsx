import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { DbMigrationInbox, MoverUnitCommit, MoverUnitPreview, MoverUnitVerdict } from '../api/types';
import { useApp } from '../lib/app';
import { formatBytes } from '../lib/dbMigration';

/**
 * ADR-097 «استيراد وحدات MOVER»: upload a MOVER SQLite file, see a per-unit verdict (NEW / EXISTING / CODE_CONFLICT),
 * then commit the NEW rows into TMRKZ's organization tree. Idempotent by (source='MOVER', source_external_id=<unit id>).
 * CONFIGURE only; uploaded SQLite files are the same inbox the pg_dump path uses.
 */
export function MoverUnitImport() {
  const app = useApp();
  const [inbox, setInbox] = useState<DbMigrationInbox | null>(null);
  const [file, setFile] = useState('');
  const [upload, setUpload] = useState<File | null>(null);
  const [preview, setPreview] = useState<MoverUnitPreview | null>(null);
  const [result, setResult] = useState<MoverUnitCommit | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refreshInbox = () => api.dbMigrationInbox().then(setInbox, () => setInbox(null));
  useEffect(() => {
    refreshInbox();
  }, []);

  const sqliteFiles = useMemo(
    () => inbox?.files.filter((f) => f.kind === 'SQLITE' || f.sqlite) ?? [],
    [inbox],
  );

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doUpload = () => upload && act(async () => {
    const info = await api.uploadDbMigrationDump(upload);
    setFile(info.file);
    setUpload(null);
    await refreshInbox();
    if (!(info.kind === 'SQLITE' || info.sqlite)) {
      setErr('الملف المرفوع ليس قاعدة SQLite — المسار الحالي يقبل ملف SQLite فقط لاستيراد الوحدات.');
    }
  });

  const doPreview = () => file && act(async () => {
    const p = await api.moverUnitsPreview(file);
    setPreview(p);
    setResult(null);
  });

  const doCommit = () => file && act(async () => {
    const r = await api.moverUnitsCommit(file);
    setResult(r);
    const fresh = await api.moverUnitsPreview(file);
    setPreview(fresh);
    app.toast(`أُنشئت ${r.created} وحدة من MOVER`);
  });

  return (
    <section className="card padding" data-testid="mover-unit-import" style={{ gridColumn: '1 / -1' }}>
      <span className="eyebrow">ترحيل البيانات</span>
      <h2>استيراد وحدات MOVER من SQLite</h2>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>
        يستورد الوحدات من ملف قاعدة بيانات SQLite لـ MOVER إلى شجرة الجهات. الوحدة الموجودة فعلياً لا تتغير؛ تعارض الرموز
        يُبلَّغ فقط. العملية متكررة بأمان: نفس الملف لا يُنشئ نسخاً ثانية.
      </p>

      <div className="form-grid" style={{ gap: 12 }}>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>ارفع ملف SQLite من حاسوبك</span>
          <input
            type="file"
            accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/x-sqlite3"
            onChange={(e) => setUpload(e.target.files?.[0] ?? null)}
            aria-label="ملف قاعدة SQLite"
            dir="ltr"
          />
          <button
            type="button"
            className="button primary"
            disabled={!upload || busy}
            style={{ marginTop: 8, width: 'fit-content' }}
            onClick={doUpload}
            data-testid="mui-upload"
          >
            {busy ? '...' : 'رفع إلى مجلد الترحيل'}
          </button>
        </label>

        {sqliteFiles.length > 0 && (
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>أو اختر ملفاً مرفوعاً سابقاً</span>
            <select value={file} onChange={(e) => (setFile(e.target.value), setPreview(null), setResult(null))} dir="ltr" aria-label="ملف مرفوع سابقاً">
              <option value="">—</option>
              {sqliteFiles.map((f) => (
                <option key={f.file} value={f.file}>
                  {f.file} ({formatBytes(f.size)})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {err && <div className="note red" style={{ marginTop: 12 }}>{err}</div>}

      <div className="flex" style={{ gap: 10, marginTop: 12 }}>
        <button className="button" disabled={!file || busy} onClick={doPreview} data-testid="mui-preview">
          معاينة التحقق
        </button>
        <button
          className="button primary"
          disabled={!preview || preview.newCount === 0 || busy}
          onClick={doCommit}
          data-testid="mui-commit"
        >
          استيراد الوحدات الجديدة ({preview?.newCount ?? 0})
        </button>
      </div>

      {preview && (
        <div className="note" style={{ marginTop: 12 }}>
          إجمالي {preview.total} وحدة · جديد {preview.newCount} · موجودة {preview.existingCount} · تعارض رمز {preview.conflictCount}
        </div>
      )}

      {result && (
        <div className={'note ' + (result.conflicts.length ? 'orange' : 'green')} style={{ marginTop: 12 }}>
          أُنشئت {result.created} · تُركت موجودة {result.existing} · تُجووزت بسبب تعارض {result.skipped}
          {result.conflicts.length > 0 && (
            <ul style={{ margin: '8px 0 0 20px' }}>
              {result.conflicts.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
        </div>
      )}

      {preview && preview.rows.length > 0 && (
        <table className="table" style={{ marginTop: 16, width: '100%' }} data-testid="mui-preview-table">
          <thead>
            <tr>
              <th>رمز الوحدة</th>
              <th>الاسم</th>
              <th>المستوى</th>
              <th>الحالة</th>
              <th>الوالد في MOVER</th>
              <th>الوضع</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.slice(0, 500).map((r: MoverUnitVerdict) => (
              <tr key={r.moverId}>
                <td><code dir="ltr" className="tiny">{r.code}</code></td>
                <td>{r.name}</td>
                <td>{r.level}</td>
                <td>{r.status === 'ACTIVE' ? 'نشطة' : 'منتهية'}</td>
                <td className="tiny muted">{r.parentMoverId ?? '—'}</td>
                <td>
                  {r.category === 'NEW' && <span className="pill green">جديدة</span>}
                  {r.category === 'EXISTING' && <span className="pill muted">موجودة مسبقاً</span>}
                  {r.category === 'CODE_CONFLICT' && <span className="pill red">تعارض رمز</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview && preview.rows.length > 500 && (
        <p className="micro muted">يُعرض 500 صف من أصل {preview.rows.length}؛ تُستورد جميع الوحدات الجديدة عند التنفيذ.</p>
      )}
    </section>
  );
}
