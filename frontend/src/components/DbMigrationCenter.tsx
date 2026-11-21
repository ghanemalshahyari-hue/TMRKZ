import { Fragment, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { DbMigration, DbMigrationBackup, DbMigrationDecisions, DbMigrationInbox, DbMigrationListItem, DbMigrationTable } from '../api/types';
import { KeyValue } from './ui';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';
import { EMPTY_FORM, backupGateProblem, defaultSelection, formProblem, formatBytes, selectionTotals, toConnectInput, undecidedTables, type ConnectionForm } from '../lib/dbMigration';

const STATE: Record<string, [string, string]> = {
  PREVIEWED: ['معاينة', 'orange'],
  VALIDATED: ['متحقق', 'orange'],
  MIGRATED: ['رُحّل', 'green'],
  FAILED: ['لم يُنفذ', 'red'],
};

/**
 * «مركز ترحيل قاعدة البيانات» (owner, 20 Nov 2026; ADR-094): the data of an older TMRKZ database — a live connection or a
 * pg_dump file — brought into the current one, which is never replaced. Choose the source → the schema versions and the
 * tables by category → choose the tables and decide each conflict (the current record wins unless the administrator takes
 * the source's) → the plan in dependency order → the backup gate → the migration → the report.
 */
export function DbMigrationCenter() {
  const app = useApp();
  const [mode, setMode] = useState<'CONNECTION' | 'DUMP'>('CONNECTION');
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM);
  const [inbox, setInbox] = useState<DbMigrationInbox | null>(null);
  const [dumpFile, setDumpFile] = useState('');
  const [migration, setMigration] = useState<DbMigration | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<DbMigrationDecisions>({});
  const [openTable, setOpenTable] = useState<string | null>(null);
  const [backup, setBackup] = useState<DbMigrationBackup | null>(null);
  const [attested, setAttested] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [history, setHistory] = useState<DbMigrationListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refreshHistory = () => api.dbMigrations().then(setHistory, () => setHistory([]));
  const refreshInbox = () => api.dbMigrationInbox().then(setInbox, () => setInbox(null));
  const refreshBackup = () => api.dbMigrationBackupStatus().then(setBackup, () => setBackup(null));
  useEffect(() => {
    refreshHistory();
    refreshBackup();
  }, []);
  useEffect(() => {
    if (mode === 'DUMP') refreshInbox();
  }, [mode]);

  const act = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      if (done) app.toast(done);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const load = (m: DbMigration) => {
    setMigration(m);
    setBackup(m.backup);
    if (m.preview) {
      setChosen(m.selection?.tables ?? defaultSelection(m.preview.tables));
      const d: DbMigrationDecisions = {};
      Object.entries(m.selection?.decisions ?? {}).forEach(([t, x]) => (d[t] = { confirmed: x.confirmed, records: x.records }));
      setDecisions(d);
    }
    setAttested(false);
    setUnderstood(false);
  };

  const connect = () =>
    act(async () => {
      const input = mode === 'DUMP' ? { type: 'DUMP' as const, file: dumpFile } : toConnectInput(form);
      load(await api.connectDbMigration(input));
      setForm({ ...form, password: '' });
      refreshHistory();
    }, 'فُحص المصدر وحُفظت المعاينة');

  const upload = (file: File) =>
    act(async () => {
      const info = await api.uploadDbMigrationDump(file);
      setDumpFile(info.file);
      await refreshInbox();
      if (!info.pgdmp) setErr('الملف ليس نسخة pg_dump بالصيغة المخصصة (-Fc)');
    }, 'رُفع الملف إلى مجلد الترحيل');

  const validate = () =>
    act(async () => {
      if (!migration) return;
      load(await api.selectDbMigrationTables(migration.id, { tables: chosen, decisions }));
      refreshHistory();
    }, 'تحقق النظام من الاختيار وترتيب الجداول');

  const run = () =>
    act(async () => {
      if (!migration) return;
      const m = await api.runDbMigration(migration.id, attested);
      load(m);
      refreshHistory();
      if (m.state !== 'MIGRATED') setErr(m.report?.error ?? 'لم يُنفذ الترحيل');
    });

  const abandon = () =>
    act(async () => {
      if (!migration) return;
      await api.abandonDbMigration(migration.id);
      setMigration(null);
      refreshHistory();
    }, 'أُلغيت المعاينة');

  const openOld = (id: string) => act(async () => load(await api.dbMigration(id)));

  const setDecision = (table: string, key: string, value: 'KEEP' | 'TAKE_SOURCE') =>
    setDecisions({ ...decisions, [table]: { ...decisions[table], records: { ...(decisions[table]?.records ?? {}), [key]: value } } });
  const setConfirmed = (table: string, confirmed: boolean) => setDecisions({ ...decisions, [table]: { ...decisions[table], confirmed } });
  const toggle = (table: string) => setChosen(chosen.includes(table) ? chosen.filter((t) => t !== table) : [...chosen, table]);

  const preview = migration?.preview ?? null;
  const editable = migration?.state === 'PREVIEWED' || migration?.state === 'VALIDATED';
  const undecided = preview ? undecidedTables(preview.tables, chosen, decisions) : [];
  const totals = preview ? selectionTotals(preview.tables, chosen, decisions) : null;
  const gate = backupGateProblem(backup, attested);
  const field = (k: keyof ConnectionForm, label: string, type = 'text', hint?: string) => (
    <label className="field">
      <span>{label}{hint ? <small className="muted"> — {hint}</small> : null}</span>
      <input type={type} dir="ltr" autoComplete={type === 'password' ? 'new-password' : 'off'} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} aria-label={label} />
    </label>
  );

  const conflicts = (t: DbMigrationTable) => (
    <div className="note" style={{ marginTop: 6 }} data-testid={'conflicts-' + t.table}>
      <div className="flex spread" style={{ gap: 10, flexWrap: 'wrap' }}>
        <b>تعارضات «{t.table}»: {t.conflicts}</b>
        <label className="flex" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={!!decisions[t.table]?.confirmed} disabled={!editable} onChange={(e) => setConfirmed(t.table, e.target.checked)} />
          <span>أؤكد إبقاء السجلات الحالية لكل سجل لم أقرر له غير ذلك</span>
        </label>
      </div>
      <p className="micro muted" style={{ margin: '4px 0 8px' }}>
        السجل الحالي يبقى كما هو ما لم تختر «أخذ قيم المصدر» له؛ عندها تُحدَّث أعمدته المشتركة من المصدر. تُعرض أول {t.conflictDetails.length} تعارضاً{t.conflictDetailsTruncated ? '؛ البقية تبقى على الحالي' : ''}.
      </p>
      <table className="data-table compact">
        <thead>
          <tr><th>المفتاح</th><th>العمود</th><th>الحالي</th><th>المصدر</th><th>القرار</th></tr>
        </thead>
        <tbody>
          {t.conflictDetails.map((c) => (
            c.columns.map((col, i) => (
              <tr key={c.key + col.column}>
                {i === 0 && <td rowSpan={c.columns.length}><code dir="ltr" className="tiny">{c.key}</code></td>}
                <td><code dir="ltr" className="tiny">{col.column}</code></td>
                <td dir="auto">{col.current ?? <i className="muted">فارغ</i>}</td>
                <td dir="auto">{col.source ?? <i className="muted">فارغ</i>}</td>
                {i === 0 && (
                  <td rowSpan={c.columns.length}>
                    <select value={decisions[t.table]?.records?.[c.key] ?? 'KEEP'} disabled={!editable} onChange={(e) => setDecision(t.table, c.key, e.target.value as 'KEEP' | 'TAKE_SOURCE')} aria-label={'قرار ' + c.key}>
                      <option value="KEEP">إبقاء الحالي</option>
                      <option value="TAKE_SOURCE">أخذ قيم المصدر</option>
                    </select>
                  </td>
                )}
              </tr>
            ))
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="card padding" data-testid="db-migration-center" style={{ gridColumn: '1 / -1' }}>
      <span className="eyebrow">ترحيل البيانات</span>
      <h2>مركز ترحيل قاعدة البيانات</h2>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>
        يجلب بيانات قاعدة TMRKZ أقدم إلى القاعدة الحالية. القاعدة الحالية لا تُستبدل أبداً؛ السجل الموجود لا يتغير إلا بقرار منك لكل سجل؛ الجلسات وكلمات المرور وأسرار التكامل ومحرك سير العمل لا تُرحَّل.
      </p>

      {/* 1. the source */}
      <div className="flex" style={{ gap: 8, marginBottom: 8 }}>
        {(['CONNECTION', 'DUMP'] as const).map((m) => (
          <button type="button" key={m} className={'button small' + (mode === m ? ' primary' : '')} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === 'CONNECTION' ? 'اتصال بقاعدة قديمة' : 'ملف نسخة pg_dump'}
          </button>
        ))}
      </div>
      {mode === 'CONNECTION' ? (
        <div className="form-grid">
          {field('host', 'الخادم')}
          {field('port', 'المنفذ', 'number')}
          {field('database', 'قاعدة البيانات')}
          {field('username', 'اسم المستخدم', 'text', 'يكفي حق القراءة')}
          {field('password', 'كلمة المرور', 'password', 'تُحفظ مشفرة ولا تُعرض')}
          {field('schema', 'المخطط', 'text', 'عادة public')}
        </div>
      ) : (
        <div>
          <div className="form-grid">
            <label className="field">
              <span>رفع ملف نسخة (pg_dump -Fc){inbox ? ' — حتى ' + formatBytes(inbox.maxUploadBytes) : ''}</span>
              <input type="file" accept=".dump,.backup,.pgdump,application/octet-stream" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} aria-label="ملف النسخة" />
            </label>
            <label className="field">
              <span>أو ملف موجود في مجلد الترحيل {inbox ? <code dir="ltr" className="tiny">{inbox.folder}</code> : null}</span>
              <select value={dumpFile} onChange={(e) => setDumpFile(e.target.value)} aria-label="ملف من المجلد">
                <option value="">— اختر —</option>
                {inbox?.files.map((f) => (
                  <option key={f.file} value={f.file}>{f.file} · {formatBytes(f.size)}{f.pgdmp ? '' : ' · ليس pg_dump'}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="micro muted">الملفات الكبيرة توضع في المجلد مباشرة (data/files/migration-inbox). تُستعاد النسخة في قاعدة مؤقتة معزولة على الخادم نفسه وتُحذف بعد الترحيل.</p>
        </div>
      )}
      <div className="flex" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="button primary" data-testid="dbm-connect" disabled={busy || (mode === 'CONNECTION' ? !!formProblem(form) : !dumpFile)} onClick={connect}>
          {busy ? 'جارٍ…' : 'فحص المصدر'}
        </button>
        {mode === 'CONNECTION' && formProblem(form) && <span className="micro muted" style={{ alignSelf: 'center' }}>{formProblem(form)}</span>}
      </div>
      {err && <p className="note red" role="alert" style={{ marginTop: 10 }}>{err}</p>}

      {/* 2. the preview */}
      {migration && preview && (
        <div style={{ marginTop: 16 }} data-testid="dbm-preview">
          <div className="flex spread" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>المعاينة</h3>
            <span className={'pill ' + (STATE[migration.state]?.[1] ?? '')}>{STATE[migration.state]?.[0] ?? migration.state}</span>
          </div>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <KeyValue k="المصدر" v={<code dir="ltr" className="tiny">{migration.sourceType === 'DUMP' ? migration.source.file : `${migration.source.host}:${migration.source.port}/${migration.source.database} (${migration.source.schema})`}</code>} />
            <KeyValue k="إصدار مخطط المصدر" v={migration.sourceVersion ?? '—'} />
            <KeyValue k="إصدار المخطط الحالي" v={migration.currentVersion ?? '—'} />
            <KeyValue k="المعاينة" v={fullTime(migration.createdAt) + (migration.createdBy ? ' · ' + migration.createdBy : '')} />
          </div>
          <table className="data-table compact" style={{ marginTop: 10 }} data-testid="dbm-categories">
            <thead>
              <tr><th>الفئة</th><th>جداول</th><th>جديدة</th><th>متطابقة</th><th>متغيرة</th><th>متعارضة</th><th>لا تُرحَّل</th></tr>
            </thead>
            <tbody>
              {preview.categories.filter((c) => c.tables || c.unsupported).map((c) => (
                <tr key={c.code}>
                  <td>{c.label}</td><td>{c.tables}</td><td>{c.newRows}</td><td>{c.identical}</td><td>{c.changed}</td><td>{c.conflicts}</td><td>{c.unsupported}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="micro muted" style={{ margin: '6px 0' }}>«متغيرة» هي التعارضات التي قررت أخذ قيم المصدر لها؛ «لا تُرحَّل» جداول التشغيل والأسرار التي لا يقرؤها المركز ولا يكتبها.</p>

          {/* 3. the tables and the decisions */}
          <table className="data-table compact" style={{ marginTop: 10 }} data-testid="dbm-tables">
            <thead>
              <tr><th></th><th>الجدول</th><th>الفئة</th><th>في المصدر</th><th>في الحالي</th><th>جديدة</th><th>متعارضة</th><th>متطابقة</th><th>يعتمد على</th></tr>
            </thead>
            <tbody>
              {preview.tables.map((t) => (
                <Fragment key={t.table}>
                  <tr data-table={t.table}>
                    <td><input type="checkbox" checked={chosen.includes(t.table)} disabled={!editable} onChange={() => toggle(t.table)} aria-label={'اختيار ' + t.table} /></td>
                    <td><code dir="ltr" className="tiny">{t.table}</code>{t.secretColumns.length ? <small className="muted"> · بلا {t.secretColumns.join('، ')}</small> : null}</td>
                    <td>{preview.categories.find((c) => c.code === t.category)?.label ?? t.category}</td>
                    <td>{t.sourceRows}</td>
                    <td>{t.currentRows}</td>
                    <td><b>{t.newRows}</b></td>
                    <td>
                      {t.conflicts ? (
                        <button type="button" className="button small" onClick={() => setOpenTable(openTable === t.table ? null : t.table)} aria-expanded={openTable === t.table}>
                          {t.conflicts} {undecided.includes(t.table) && chosen.includes(t.table) ? '· بلا قرار' : ''}
                        </button>
                      ) : 0}
                    </td>
                    <td>{t.identical}</td>
                    <td className="micro muted" dir="ltr">{t.dependsOn.join(', ')}</td>
                  </tr>
                  {openTable === t.table && t.conflicts > 0 && (
                    <tr><td colSpan={9}>{conflicts(t)}</td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {preview.excluded.length > 0 && (
            <details className="int-more" style={{ marginTop: 8 }}>
              <summary>الجداول التي لا تُرحَّل ({preview.excluded.length})</summary>
              <ul className="micro muted">
                {preview.excluded.map((e) => (
                  <li key={e.table}><code dir="ltr" className="tiny">{e.table}</code> — {e.reason}</li>
                ))}
                {preview.sourceOnlyTables.map((t) => (
                  <li key={'src-' + t}><code dir="ltr" className="tiny">{t}</code> — موجود في المصدر فقط</li>
                ))}
              </ul>
            </details>
          )}
          {totals && (
            <p className="micro" style={{ marginTop: 8 }} data-testid="dbm-totals">
              المختار: {totals.tables} جدولاً · {totals.newRows} صفاً جديداً · {totals.conflicts} تعارضاً، منها {totals.takeSource} تؤخذ من المصدر
              {undecided.length ? <span style={{ color: 'var(--danger, #b42318)' }}> · قرر تعارضات: {undecided.join('، ')}</span> : null}
            </p>
          )}
          {editable && (
            <div className="flex" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="button primary" data-testid="dbm-validate" disabled={busy || !chosen.length || undecided.length > 0} onClick={validate}>تحقق</button>
              <button className="button" disabled={busy} onClick={abandon}>إلغاء هذه المعاينة</button>
            </div>
          )}

          {/* 4. the plan and the gate */}
          {migration.selection && (
            <div style={{ marginTop: 14 }} data-testid="dbm-plan">
              <h3 style={{ margin: '0 0 6px' }}>خطة الترحيل (بترتيب الاعتماد)</h3>
              <ol className="micro">
                {migration.selection.plan.map((s) => (
                  <li key={s.table}><code dir="ltr" className="tiny">{s.table}</code> · {s.newRows} جديدة · {s.conflicts} متعارضة{s.takeSource ? ` (${s.takeSource} تؤخذ من المصدر)` : ''}</li>
                ))}
              </ol>
              {migration.selection.warnings.map((w, i) => (
                <p key={i} className="note orange">{w.message}</p>
              ))}
              {migration.state === 'VALIDATED' && (
                <div className="note" style={{ marginTop: 8 }} data-testid="dbm-gate">
                  <b>النسخة الاحتياطية قبل الترحيل</b>
                  {backup?.found ? (
                    <p className="micro" style={{ margin: '4px 0' }}>
                      آخر نسخة: <code dir="ltr" className="tiny">{backup.dir}</code> · {backup.createdAt ? fullTime(backup.createdAt) : '—'} · {backup.verified ? 'تُحقق منها' + (backup.verifiedAt ? ' ' + fullTime(backup.verifiedAt) : '') : 'لم يُتحقق'}{backup.current ? '' : ' · قديمة'}
                    </p>
                  ) : (
                    <p className="micro" style={{ margin: '4px 0' }}>{backup?.problem ?? 'لا نسخة احتياطية.'}</p>
                  )}
                  {backup?.found && backup.current && !backup.verified && (
                    <label className="flex" style={{ gap: 6, alignItems: 'center' }}>
                      <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} data-testid="dbm-attest" />
                      <span>أؤكد أن <code dir="ltr" className="tiny">sh ops/verify-backup.sh {backup.dir}</code> نجح (يُسجل في سجل الأثر)</span>
                    </label>
                  )}
                  <label className="flex" style={{ gap: 6, alignItems: 'center', marginTop: 6 }}>
                    <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} data-testid="dbm-understood" />
                    <span>أفهم أن القاعدة الحالية لا تُستبدل، وأن السجلات الموجودة لا تتغير إلا بالقرارات أعلاه، وأن أي فشل يُلغي الترحيل كله.</span>
                  </label>
                  <div className="flex" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                    <button className="button primary" data-testid="dbm-run" disabled={busy || !understood || !!gate} onClick={run}>{busy ? 'جارٍ الترحيل…' : 'ترحيل'}</button>
                    <button className="button small" disabled={busy} onClick={refreshBackup}>تحديث حالة النسخة</button>
                    {gate && <span className="micro muted" style={{ alignSelf: 'center' }}>{gate}</span>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 5. the report */}
          {migration.report && (
            <div className={'note ' + (migration.report.ok ? '' : 'red')} style={{ marginTop: 12 }} data-testid="dbm-report">
              <b>{migration.report.ok ? 'تم الترحيل' : 'لم يُنفذ الترحيل'}</b>
              {migration.report.error && <div>{migration.report.error}</div>}
              {migration.report.fingerprintChanged && <div className="micro">تغير المصدر منذ المعاينة؛ افحصه من جديد.</div>}
              {migration.report.finishedAt && <div className="micro muted">{migration.report.startedAt ? fullTime(migration.report.startedAt) + ' ← ' : ''}{fullTime(migration.report.finishedAt)}</div>}
              {migration.report.tables?.length ? (
                <table className="data-table compact" style={{ marginTop: 6 }}>
                  <thead><tr><th>الجدول</th><th>في المصدر</th><th>أُدرجت</th><th>حُدّثت من المصدر</th><th>تُركت</th><th>متعارضة</th></tr></thead>
                  <tbody>
                    {migration.report.tables.map((t) => (
                      <tr key={t.table}><td><code dir="ltr" className="tiny">{t.table}</code></td><td>{t.sourceRows}</td><td><b>{t.inserted}</b></td><td>{t.updated}</td><td>{t.skipped}</td><td>{t.conflicts}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* the last migrations */}
      {history.length > 0 && (
        <details className="int-more" style={{ marginTop: 14 }} data-testid="dbm-history">
          <summary>الترحيلات السابقة ({history.length})</summary>
          <table className="data-table compact">
            <thead><tr><th>التاريخ</th><th>المصدر</th><th>الإصدار</th><th>الحالة</th><th>من</th><th></th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{fullTime(h.createdAt)}</td>
                  <td><code dir="ltr" className="tiny">{h.sourceType === 'DUMP' ? h.file : `${h.host}/${h.database} (${h.schema})`}</code></td>
                  <td>{h.sourceVersion ?? '—'} ← {h.currentVersion ?? '—'}</td>
                  <td><span className={'pill ' + (STATE[h.state]?.[1] ?? '')}>{STATE[h.state]?.[0] ?? h.state}</span></td>
                  <td>{h.createdBy ?? '—'}</td>
                  <td><button type="button" className="button small" disabled={busy} onClick={() => openOld(h.id)}>فتح</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
