import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type CertificateInfo, type CertificateOverview, type CertificateSession, type CertificateStore } from '../api/client';
import { useApp } from '../lib/app';
import { fileToBase64, healthLabel } from '../lib/certificateFiles';
import { fullTime } from '../lib/dates';
import { StepUpNotice, takeResume } from './StepUpNotice';

const TARGET: Record<string, string> = {
  HTTPS: 'شهادة https للخادم',
  DIRECTORY: 'ثقة الدليل المؤسسي (LDAP)',
  OIDC: 'ثقة Keycloak المؤسسة',
};
const STORE: Record<string, string> = {
  HTTPS: 'مجلد شهادة https',
  TRUST_FOLDER: 'مجلد الثقة المشترك (للقراءة)',
  CERTS: 'مجلد الشهادات certs/',
  DIRECTORY: 'ثقة الدليل المؤسسي — «إعدادات التكامل»',
  OIDC: 'ثقة Keycloak المؤسسة — «إعدادات التكامل»',
};
const STATE: Record<string, string> = {
  CHECKED: 'فُحص — بانتظار التطبيق الصريح',
  BLOCKED: 'لا يُطبق — فشل فحص',
  APPROVED: 'اعتُمد — بانتظار عامل الصيانة',
  APPLYING: 'تثبيت (نسخة احتياطية أولاً)',
  VERIFYING: 'التحقق مما تقدمه نقطة https',
  APPLIED: 'طُبق وتحقق',
  APPLIED_INACTIVE: 'ثُبت — https غير مفعل بعد',
  FAILED_ROLLED_BACK: 'فشل التحقق وأُعيد السابق تلقائياً',
  RESTORE_REQUESTED: 'طُلبت الاستعادة — بانتظار عامل الصيانة',
  RESTORING: 'استعادة السابق',
  RESTORED: 'أُعيد السابق',
  DISCARDED: 'أُلغي',
  REJECTED: 'رفضه عامل الصيانة — لم يُكتب شيء',
  ERROR: 'خطأ — راجع التشخيص',
};
const BUSY = new Set(['APPROVED', 'APPLYING', 'VERIFYING', 'RESTORE_REQUESTED', 'RESTORING']);
const MARK: Record<string, string> = { PASS: '✓', WARN: '!', FAIL: '✗', INFO: 'i' };

function Health({ c }: { c: CertificateInfo }) {
  const h = healthLabel(c);
  return <span className={`pill ${h.tone === 'bad' ? 'red' : h.tone === 'warn' ? 'orange' : 'green'}`} data-health={c.health}>{h.text}</span>;
}

function CertRow({ c, file, action }: { c: CertificateInfo; file?: string; action?: React.ReactNode }) {
  return (
    <tr data-testid="cert-row" data-sha={c.sha256}>
      {file !== undefined && <td dir="ltr" style={{ fontFamily: 'monospace', fontSize: 12 }}>{file}</td>}
      <td><b dir="ltr">{c.subjectCn}</b><br /><small className="muted" dir="ltr">من {c.issuerCn}</small></td>
      <td className="micro">{c.role === 'ROOT' ? 'جذرية' : c.role === 'INTERMEDIATE' ? 'وسيطة' : 'خادم'} · {c.keyAlgorithm} {c.keyBits}</td>
      <td className="micro" dir="ltr">{[...c.dnsNames, ...c.ipAddresses].join(', ') || '—'}</td>
      <td><Health c={c} /><br /><small className="muted">{fullTime(c.notAfter)}</small></td>
      <td className="micro" dir="ltr" title={c.sha256}>{c.sha256.slice(0, 16)}…</td>
      {action !== undefined && <td>{action}</td>}
    </tr>
  );
}

/**
 * «الشهادات» (ADR-105): the certificates this installation uses (the https folder, the shared trust folder, the machine's certs/
 * folder, each service's own trust), their health, and their replacement: choose files (or a certificate already on the machine),
 * see every check and what will change, apply explicitly with a reason, follow the health check, restore. A private key is sent
 * only for https and never shown back.
 */
export function CertificateCenter() {
  const app = useApp();
  const [overview, setOverview] = useState<CertificateOverview | null>(null);
  const [target, setTarget] = useState<'HTTPS' | 'DIRECTORY' | 'OIDC'>('DIRECTORY');
  const [mode, setMode] = useState<'ADD' | 'REPLACE'>('ADD');
  const [hostname, setHostname] = useState('');
  const [password, setPassword] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [refs, setRefs] = useState<{ store: string; file: string }[]>([]);
  const [session, setSession] = useState<CertificateSession | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');
  const [stepUp, setStepUp] = useState<null | { action: 'apply' | 'restore'; reason: string }>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = () => api.certificates().then((o) => { setOverview(o); setLoadError(''); }).catch((e: Error) => setLoadError(e.message));
  useEffect(() => {
    void load();
    const back = takeResume('cert:');
    if (back) api.certificateSession(back).then(setSession).catch(() => undefined);
  }, []);
  useEffect(() => { if (!hostname && overview?.config.publicHost) setHostname(overview.config.publicHost); }, [overview]);

  useEffect(() => {
    if (!session || !BUSY.has(session.state)) return;
    const t = window.setTimeout(() => {
      api.certificateSession(session.id).then((s) => { setSession(s); if (!BUSY.has(s.state)) void load(); }).catch(() => setSession({ ...session }));
    }, 1500);
    return () => window.clearTimeout(t);
  }, [session]);

  const check = async () => {
    setBusy('فحص الملفات …');
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, contentBase64: await fileToBase64(f) })));
      const s = await api.checkCertificates({ target, mode, hostname: target === 'HTTPS' ? hostname.trim() : undefined,
        password: password || undefined, files: payload, fromInventory: refs });
      setSession(s);
      setPassword('');
      setReason('');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const needsStepUp = (e: unknown) => e instanceof ApiError && e.code === 'REAUTHENTICATION_REQUIRED';

  const apply = async (why = reason.trim()) => {
    if (!session) return;
    setBusy('تطبيق …');
    try {
      setSession(await api.applyCertificates(session.id, why));
      setStepUp(null);
      void load();
    } catch (e) {
      if (needsStepUp(e)) setStepUp({ action: 'apply', reason: why });
      else app.toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const restore = async (given?: string) => {
    if (!session) return;
    const why = given ?? window.prompt('سبب استعادة الشهادات السابقة؟');
    if (!why || why.trim().length < 3) return;
    try {
      setSession(await api.restoreCertificates(session.id, why.trim()));
      setStepUp(null);
      void load();
    } catch (e) {
      if (needsStepUp(e)) setStepUp({ action: 'restore', reason: why.trim() });
      else app.toast((e as Error).message);
    }
  };

  const discard = async () => {
    if (!session) return;
    try {
      setSession(await api.discardCertificates(session.id));
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const useFromStore = (store: string, file: string) => {
    setRefs((r) => (r.some((x) => x.store === store && x.file === file) ? r : [...r, { store, file }]));
  };

  const storeBlock = (s: CertificateStore) => {
    const dbStore = s.id === 'DIRECTORY' || s.id === 'OIDC';
    return (
      <div key={s.id} className="card padding" data-testid="cert-store" data-store={s.id} style={{ marginTop: 10 }}>
        <div className="flex spread" style={{ flexWrap: 'wrap', gap: 6 }}>
          <b>{STORE[s.id] ?? s.id}</b>
          <span className="micro muted" dir="ltr">{dbStore ? (s.server ?? '') : s.path}</span>
        </div>
        {s.usedBy && <p className="micro muted" style={{ margin: '4px 0' }}>يستخدمه: {s.usedBy}</p>}
        {s.note && <p className="micro">{s.note}</p>}
        {dbStore && !s.saved && <p className="micro muted">القسم غير محفوظ في «إعدادات التكامل»؛ تُوثق الخدمة بمجلد الثقة المشترك وحده.</p>}
        {!dbStore && s.exists === false && s.visible !== false && <p className="micro muted">المجلد غير موجود.</p>}
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <tbody>
              {(dbStore ? s.certificates ?? [] : []).map((c) => <CertRow key={c.sha256} c={c} />)}
              {(s.files ?? []).map((f) => f.kind === 'CERTIFICATES'
                ? (f.certificates ?? []).map((c, i) => (
                  <CertRow key={f.name + c.sha256} c={c} file={i === 0 ? f.name : ''} action={i === 0 ? (
                    <button className="button small" data-testid="cert-use" onClick={() => useFromStore(s.id, f.name)}>استخدام</button>) : null} />
                ))
                : (
                  <tr key={f.name} data-testid="cert-key-row">
                    <td dir="ltr" style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.name}</td>
                    <td colSpan={6} className="micro">
                      {f.kind === 'KEY'
                        ? `مفتاح خاص ${f.keyAlgorithm ?? ''} — ${f.matches && f.matches.length ? 'يطابق ' + f.matches.join('، ') : 'لا يطابق شهادة في هذا المجلد'}`
                          + (f.permissions ? ` · الصلاحيات ${f.permissions}` : '') + (f.note ? ` · ${f.note}` : '') + ' (لا يُعرض محتواه)'
                        : 'ملف ليس شهادة'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const plan = session?.plan as Record<string, unknown> | undefined;
  const failed = session?.checks.some((c) => c.status === 'FAIL');
  return (
    <section className="card padding" data-testid="cert-center" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread" style={{ flexWrap: 'wrap', gap: 6 }}>
        <h2>الشهادات</h2>
        <span className="micro" data-testid="cert-summary">
          {!overview ? (loadError || 'تحميل …') : (
            <>
              {overview.summary.expired > 0 && <span className="pill red">منتهية {overview.summary.expired}</span>}{' '}
              {overview.summary.expiring > 0 && <span className="pill orange">تنتهي قريباً {overview.summary.expiring}</span>}{' '}
              {overview.worker.alive ? 'عامل الصيانة يعمل' : 'عامل الصيانة لا يعمل — شهادة https لا تُكتب'}
            </>
          )}
        </span>
      </div>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>
        لكل خدمة ثقتها: الدليل وKeycloak المؤسسة في «إعدادات التكامل» (تسري فوراً بعد اختبار اتصال حي)، وشهادة https للخادم يكتبها عامل
        الصيانة بعد نسخة احتياطية ويتحقق مما تقدمه نقطة https. المفتاح الخاص لا يُعرض ولا يُسجل أبداً.
      </p>
      {overview && (
        <p className="micro" data-testid="cert-config">
          مجلد https: <b dir="ltr">{overview.config.tlsDir ?? '—'}</b> ({overview.config.tlsDirSource === '.env' ? 'من .env' : 'الافتراضي'}) ·
          مجلد الثقة: <b dir="ltr">{overview.config.trustDir ?? '—'}</b> · https {overview.config.httpsEnabled ? 'مفعل' : 'غير مفعل'}
          {overview.config.publicHost && <> · الاسم: <b dir="ltr">{overview.config.publicHost}</b></>}
        </p>
      )}
      {overview?.stores.map(storeBlock)}

      <div className="card padding" data-testid="cert-import" style={{ marginTop: 14 }}>
        <h3>استيراد أو تجديد شهادة</h3>
        <div className="flex" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="flex" style={{ gap: 6 }}>الخدمة
            <select data-testid="cert-target" value={target} onChange={(e) => { setTarget(e.target.value as typeof target); setSession(null); }}>
              {Object.entries(TARGET).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          {target !== 'HTTPS' && (
            <label className="flex" style={{ gap: 6 }}>الطريقة
              <select data-testid="cert-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="ADD">إضافة إلى القائمة الحالية</option>
                <option value="REPLACE">استبدال القائمة</option>
              </select>
            </label>
          )}
          {target === 'HTTPS' && (
            <label className="flex" style={{ gap: 6 }}>اسم الخادم
              <input dir="ltr" data-testid="cert-hostname" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="tmrkz.example.local" />
            </label>
          )}
        </div>
        <input ref={picker} type="file" multiple data-testid="cert-files" style={{ display: 'none' }}
          accept=".pem,.crt,.cer,.der,.p7b,.p7c,.pfx,.p12,.key"
          onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <div className="flex" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="button" onClick={() => picker.current?.click()}>اختيار ملفات (PEM · CER · P7B · PFX)</button>
          {files.map((f) => <span key={f.name} className="chip" dir="ltr">{f.name}</span>)}
          {refs.map((r) => (
            <span key={r.store + r.file} className="chip" dir="ltr" data-testid="cert-ref">{r.store}/{r.file}
              <button className="button small" aria-label="إزالة" onClick={() => setRefs(refs.filter((x) => x !== r))}>×</button></span>
          ))}
        </div>
        <div className="flex" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <input type="password" autoComplete="off" data-testid="cert-password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="كلمة مرور ملف PFX أو المفتاح المشفر (إن وجدت)" style={{ flex: 1, minWidth: 220 }} />
          <button className="button primary" data-testid="cert-check" disabled={!!busy || files.length + refs.length === 0} onClick={check}>فحص ومعاينة</button>
        </div>
        {busy && <p className="micro" data-testid="cert-busy">{busy}</p>}
      </div>

      {session && (
        <div className="card padding" data-testid="cert-session" style={{ marginTop: 12 }}>
          <div className="key-value"><span>الخدمة</span><b>{TARGET[session.target]}</b></div>
          <div className="key-value"><span>الحالة</span><b data-testid="cert-state" data-state={session.state}>{STATE[session.state] ?? session.state}</b></div>
          {session.message && <p className="micro" data-testid="cert-message">{session.message}</p>}
          <ul className="micro" data-testid="cert-checks" style={{ listStyle: 'none', padding: 0 }}>
            {session.checks.map((c, i) => (
              <li key={i} data-code={c.code} data-status={c.status} style={{ margin: '3px 0' }}>
                <span className={`pill ${c.status === 'FAIL' ? 'red' : c.status === 'WARN' ? 'orange' : c.status === 'PASS' ? 'green' : 'blue'}`}>{MARK[c.status]}</span>{' '}
                {c.message}
              </li>
            ))}
          </ul>
          {plan && session.target !== 'HTTPS' && Array.isArray(plan.after) && (
            <div data-testid="cert-plan">
              <p className="micro">قبل: {(plan.before as CertificateInfo[]).length} شهادة · بعد: {(plan.after as CertificateInfo[]).length} شهادة · {String(plan.restart ?? '')}</p>
              <div style={{ overflowX: 'auto' }}>
                <table className="table"><tbody>{(plan.after as CertificateInfo[]).map((c) => <CertRow key={c.sha256} c={c} />)}</tbody></table>
              </div>
            </div>
          )}
          {plan && session.target === 'HTTPS' && plan.next != null && (
            <div data-testid="cert-plan">
              <p className="micro">المجلد: <b dir="ltr">{String(plan.folder)}</b> · {String(plan.restart ?? '')}</p>
              <div style={{ overflowX: 'auto' }}>
                <table className="table"><tbody>
                  {plan.current != null && <CertRow c={plan.current as CertificateInfo} file="الحالية" />}
                  <CertRow c={plan.next as CertificateInfo} file="الجديدة" />
                </tbody></table>
              </div>
              <ul className="micro">{(plan.writes as string[] ?? []).map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          {stepUp && (
            <StepUpNotice resume={'cert:' + session.id} onCancel={() => setStepUp(null)}
              onConfirmed={() => (stepUp.action === 'apply' ? apply(stepUp.reason) : restore(stepUp.reason))} />
          )}
          {session.state === 'CHECKED' && !failed && (
            <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <input data-testid="cert-reason" placeholder="سبب التطبيق (يُسجل في التدقيق)" value={reason} onChange={(e) => setReason(e.target.value)}
                style={{ flex: 1, minWidth: 220 }} />
              <button className="button primary" data-testid="cert-apply" disabled={!!busy || reason.trim().length < 3} onClick={() => apply()}>تطبيق</button>
              <button className="button" data-testid="cert-discard" onClick={discard}>إلغاء</button>
            </div>
          )}
          {session.state === 'BLOCKED' && <button className="button" data-testid="cert-discard" onClick={discard}>إغلاق</button>}
          {session.progress.length > 0 && (
            <ol className="micro" data-testid="cert-progress" style={{ marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
              {session.progress.map((p, i) => <li key={i}><span className="muted">{p.at ? fullTime(p.at) : ''}</span> {p.text}</li>)}
            </ol>
          )}
          {session.canRestore && <button className="button" data-testid="cert-restore" onClick={() => restore()}>استعادة الشهادات السابقة</button>}
        </div>
      )}

      {overview && overview.sessions.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>الطلبات السابقة</h3>
          {overview.sessions.map((s) => (
            <div key={s.id} className="key-value" data-testid="cert-history-row">
              <span>{TARGET[s.target] ?? s.target} <small className="muted">· {s.createdBy} · {s.createdAt ? fullTime(s.createdAt) : ''}</small></span>
              <span className="flex" style={{ gap: 8 }}>
                <span>{STATE[s.state] ?? s.state}</span>
                <button className="button small" onClick={() => api.certificateSession(s.id).then(setSession).catch((e: Error) => app.toast(e.message))}>عرض</button>
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
