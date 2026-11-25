import { useMemo, useRef, useState } from 'react';
import { api, type ImportPreview, type ImportTest } from '../api/client';
import { useApp } from '../lib/app';
import { missingFields, selectionKey } from '../lib/certificateFiles';

const STATUS: Record<string, string> = { NEW: 'جديد', SAME: 'مطابق', CONFLICT: 'تعارض', ABSENT: '—', MISSING_FILE: 'الملف غير موجود' };
const FORMAT: Record<string, string> = { TMRKZ: 'ملف إعدادات تمركز', COMPATIBLE: 'ملف إعدادات تطبيق متوافق', UNKNOWN: 'لم يُتعرف على إعدادات مدعومة' };

/**
 * «استيراد ملف إعدادات» (ADR-105): choose a compatible application's configuration file; see each recognised setting against the
 * one in force (new, the same, in conflict), what would still be missing, and what is never imported; test the chosen values
 * live; apply them to «إعدادات التكامل». The file is read in the browser and sent once; .env is never written.
 */
export function EnvImport() {
  const app = useApp();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tested, setTested] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ImportTest | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setBusy('قراءة الملف …');
    setResult(null);
    setTested({});
    try {
      if (preview) void api.discardImport(preview.importId).catch(() => undefined);
      const p = await api.previewImport(f.name, await f.text());
      setPreview(p);
      setSelected(new Set(p.sections.flatMap((s) => s.fields.filter((x) => x.selectedByDefault).map((x) => x.path))));
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const key = useMemo(() => selectionKey(selected), [selected]);
  const touched = Object.keys(key);
  const allTested = touched.length > 0 && touched.every((s) => tested[s] === key[s]);
  const missing = preview ? preview.sections.map((s) => ({ s, m: missingFields(s, selected) })).filter((x) => x.m.length > 0) : [];

  const toggle = (path: string) => setSelected((cur) => {
    const n = new Set(cur);
    if (n.has(path)) n.delete(path); else n.add(path);
    return n;
  });

  const test = async () => {
    if (!preview) return;
    setBusy('اختبار الاتصال بالقيم المختارة …');
    try {
      const r = await api.testImport(preview.importId, Array.from(selected));
      setResult(r);
      const ok: Record<string, string> = {};
      for (const [s, v] of Object.entries(r.results)) if (v.ok) ok[s] = key[s];
      setTested(ok);
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy('تطبيق …');
    try {
      const r = await api.applyImport(preview.importId, Array.from(selected), reason.trim());
      app.toast(`حُفظت الأقسام: ${r.saved.join('، ')} (مسجلة في التدقيق)`);
      setPreview(null);
      setSelected(new Set());
      setResult(null);
      setReason('');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="card padding" data-testid="env-import" style={{ gridColumn: '1 / -1' }}>
      <h2>استيراد ملف إعدادات</h2>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>
        اختر ملف الإعدادات (.env) لتطبيق متوافق: يتعرف تمركز على إعدادات الدليل المؤسسي وKeycloak والمساعد، ويقارنها بالمعمول به، ويختبرها
        قبل الحفظ في «إعدادات التكامل». لا يُكتب ملف .env، ولا تُستورد أبداً بيانات قاعدة البيانات ولا مفاتيح التوقيع أو التشفير ولا إعدادات هذا الجهاز.
      </p>
      <input ref={picker} type="file" data-testid="env-file" style={{ display: 'none' }}
        onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
      <button className="button" disabled={!!busy} onClick={() => picker.current?.click()}>اختيار ملف الإعدادات</button>
      {busy && <p className="micro" data-testid="env-busy">{busy}</p>}

      {preview && (
        <div data-testid="env-preview" style={{ marginTop: 12 }}>
          <p className="micro" data-testid="env-format" data-format={preview.format}>
            <b dir="ltr">{preview.fileName}</b> · {FORMAT[preview.format]} · {preview.recognised} إعداداً متعرَّفاً من {preview.settingsInFile}
          </p>
          {preview.problems.length > 0 && <ul className="micro">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          {preview.sections.filter((s) => s.inFile).map((s) => (
            <div key={s.section} className="card padding" data-testid="env-section" data-section={s.section} style={{ marginTop: 8 }}>
              <div className="flex spread">
                <b>{s.label}</b>
                <span className="micro muted">المعمول به الآن: {s.source === 'SAVED' ? 'محفوظ في إعدادات التكامل' : s.source === 'ENV' ? 'من ملف بيئة هذا الجهاز' : 'غير مهيأ'}</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead><tr><th /><th>الإعداد</th><th>في الملف</th><th>المعمول به</th><th>القيمة المستوردة</th><th>الحالة</th></tr></thead>
                  <tbody>
                    {s.fields.filter((f) => f.status !== 'ABSENT').map((f) => (
                      <tr key={f.path} data-testid="env-field" data-path={f.path} data-status={f.status}>
                        <td><input type="checkbox" aria-label={f.label} disabled={!f.selectable} checked={selected.has(f.path)} onChange={() => toggle(f.path)} /></td>
                        <td>{f.label}{f.warning && <><br /><small className="pill orange">{f.warning}</small></>}</td>
                        <td dir="ltr" className="micro">{f.sourceKey}</td>
                        <td dir="ltr" className="micro">{f.current ?? '—'}</td>
                        <td dir="ltr" className="micro">
                          {f.imported ?? '—'}
                          {f.certificate && <><br /><span className="muted">{f.certificate.folder}/{f.certificate.file}: {f.certificate.certificates.map((c) => c.subjectCn).join('، ')}</span></>}
                        </td>
                        <td><span className={`pill ${f.status === 'CONFLICT' || f.status === 'MISSING_FILE' ? 'orange' : f.status === 'NEW' ? 'green' : 'blue'}`}>{STATUS[f.status]}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {s.missing.length > 0 && (
                <p className="micro" data-testid="env-section-incomplete">لا يكتمل هذا القسم من الملف وحده (ينقصه: {s.missing.join('، ')})؛ لم يُختر تلقائياً.</p>
              )}
              {result?.results[s.section] && (
                <p className="micro" data-testid="env-test-result" data-ok={String(result.results[s.section].ok)}>
                  {result.results[s.section].ok ? '✓ ' : '✗ '}{result.results[s.section].message}
                </p>
              )}
            </div>
          ))}
          {missing.length > 0 && (
            <p className="micro" data-testid="env-missing">ما زال ناقصاً: {missing.map((x) => `${x.s.label}: ${x.m.join('، ')}`).join(' · ')}</p>
          )}
          <details className="micro" style={{ marginTop: 8 }} open>
            <summary>ما لا يُستورد</summary>
            <p data-testid="env-protected">لا تُستورد أبداً (محمية، أسماء فقط): <span dir="ltr">{preview.protectedKeys.join(', ') || '—'}</span></p>
            <p>خاصة بالتطبيق الآخر: <span dir="ltr">{preview.notApplicableKeys.join(', ') || '—'}</span></p>
            <p>غير مستخدمة في تمركز: <span dir="ltr">{preview.ignoredKeys.join(', ') || '—'}</span></p>
          </details>
          <div className="flex" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="button" data-testid="env-test" disabled={!!busy || touched.length === 0} onClick={test}>اختبار القيم المختارة</button>
            <input data-testid="env-reason" placeholder="سبب الاستيراد (يُسجل في التدقيق)" value={reason} onChange={(e) => setReason(e.target.value)}
              style={{ flex: 1, minWidth: 220 }} />
            <button className="button primary" data-testid="env-apply" disabled={!!busy || !allTested || missing.length > 0 || reason.trim().length < 3}
              title={allTested ? '' : 'اختبر الاختيار نفسه أولاً'} onClick={apply}>
              تطبيق على إعدادات التكامل
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
