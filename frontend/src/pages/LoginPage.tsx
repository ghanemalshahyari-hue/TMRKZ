import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api/client';
import type { AuthStatus, Me } from '../api/types';
import '../styles/signin.css';

/** Messages for the error the server put in the address after a refused automatic sign-in (never a fallback). */
const ERRORS: Record<string, string> = {
  IDENTITY_NOT_LINKED: 'تحقق الدليل المؤسسي من حسابك، لكنه غير مربوط بسجل في الموارد البشرية.',
  IDENTITY_SIGN_IN_FAILED: 'لم يكتمل الدخول. أعد المحاولة.',
  IDENTITY_PROVIDER_UNAVAILABLE: 'خدمة الدخول الآلي غير متاحة الآن. حاول لاحقاً أو استخدم الإدخال اليدوي.',
  IDENTITY_PROVIDER_NOT_CONFIGURED: 'الدخول الآلي غير مهيأ في هذه البيئة.',
  PROVIDER_ACCESS_DENIED: 'رفضت خدمة الدخول الآلي إتمام العملية.',
};
const REASONS: Record<string, string> = {
  NO_MATCH: 'لم يُعثر على سجلك في الموارد البشرية؛ أُحيل الطلب إلى مسؤول الصلاحيات في جهتك.',
  INACTIVE: 'سجلك غير نشط في الموارد البشرية.',
  AMBIGUOUS: 'الحساب يطابق أكثر من سجل؛ أُحيل الطلب إلى مسؤول الصلاحيات للتحقق.',
  STALE_SOURCE: 'بيانات الموارد البشرية غير محدثة؛ لا يُربط حساب جديد حتى تنجح المزامنة.',
  NO_KEY: 'لا يحمل حسابك في الدليل مفتاح الربط المؤسسي؛ أُحيل الطلب إلى مسؤول الصلاحيات.',
  ALREADY_LINKED: 'سجلك مرتبط بحساب آخر؛ أُحيل الطلب إلى مسؤول الصلاحيات.',
};

function readError(hash: string): string | null {
  if (!hash.startsWith('#auth-error=')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const code = params.get('auth-error') ?? '';
  const reason = params.get('reason');
  return (reason && REASONS[reason]) || ERRORS[code] || (code.startsWith('PROVIDER_') ? ERRORS.PROVIDER_ACCESS_DENIED : ERRORS.IDENTITY_SIGN_IN_FAILED);
}

type Alert = { kind: 'error' | 'warning' | 'success' | 'info'; text: string };

const Icon = {
  key: (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="8" cy="14" r="4.2" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M11.2 11.4 20 3m-4 4 2.5 2.5M14 9l2 2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="8" r="4" fill="currentColor" />
      <path d="M4 20c1.2-4 4.4-6 8-6s6.8 2 8 6" fill="currentColor" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2.2" fill="currentColor" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  eye: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  ),
  eyeOff: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  ),
  forward: (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M19 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M5 12h14m-6-6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/**
 * The sign-in page, laid out like TNQL's: one card with two ways in.
 * «الدخول الآلي» goes through the identity provider (Keycloak); «الإدخال اليدوي» opens the username and password form in
 * the same card, checked by the enterprise directory (LDAP). TMRKZ keeps no password.
 */
export function LoginPage({ onLogin }: { onLogin: (me: Me) => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [manual, setManual] = useState(() => new URLSearchParams(window.location.search).get('mode') === 'manual');
  const [alert, setAlert] = useState<Alert | null>(() => {
    const error = readError(window.location.hash);
    if (error) return { kind: 'error', text: error };
    if (new URLSearchParams(window.location.search).has('signed-out')) return { kind: 'success', text: 'تم تسجيل الخروج بنجاح' };
    return null;
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const returnTo = '/' + (window.location.hash.startsWith('#auth-error') ? '' : window.location.hash);

  useEffect(() => {
    api
      .authStatus()
      .then(setStatus)
      .catch(() => setStatus({ provider: 'OIDC', configured: false, reachable: false, manual: false }));
    if (window.location.hash.startsWith('#auth-error') || window.location.search) history.replaceState(null, '', '/');
  }, []);

  useEffect(() => {
    if (manual) usernameRef.current?.focus();
  }, [manual]);

  const automaticReady = !!status?.configured && status.reachable;

  const back = () => {
    setManual(false);
    setPassword('');
    setReveal(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) return setAlert({ kind: 'error', text: 'أدخل اسم المستخدم وكلمة المرور.' });
    setBusy(true);
    setAlert(null);
    try {
      const me = await api.directoryLogin(username.trim(), password);
      if (returnTo !== '/') history.replaceState(null, '', returnTo);
      onLogin(me);
    } catch (err) {
      const ae = err as ApiError;
      const reason = (ae.details as Record<string, string> | undefined)?.reason;
      setAlert({ kind: ae.code === 'SIGN_IN_THROTTLED' || ae.code?.startsWith('DIRECTORY') ? 'warning' : 'error', text: (reason && REASONS[reason]) || ae.message });
      setPassword('');
      setReveal(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tm" dir="rtl">
      <section className="tm-shell">
        <div className="tm-backdrop" aria-hidden="true" />
        <main className="tm-main">
          <div className="tm-card">
            <h1 className="tm-logo">
              <span className="tm-mark" aria-hidden="true">
                <svg viewBox="0 0 48 48" width="48" height="48">
                  <path d="M24 4 41 14v20L24 44 7 34V14Z" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
                  <path d="M24 13c-4.4 0-8 3.4-8 7.8C16 27 24 35 24 35s8-8 8-14.2C32 16.4 28.4 13 24 13Zm0 11a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Z" fill="currentColor" />
                </svg>
              </span>
              <span className="tm-word">TMRKZ</span>
            </h1>
            <p className="tm-sub">المواقع · المرافق · الإجراءات الإدارية</p>
            <span className="tm-rule" aria-hidden="true" />
            <div className="tm-messages" role="status" aria-live="polite">
              {alert && (
                <div className={'tm-alert tm-alert-' + alert.kind}>
                  <span>{alert.text}</span>
                </div>
              )}
            </div>

            {!status && <p className="tm-help">جارٍ التحقق من خدمات الدخول…</p>}

            {status && !manual && (
              <div className="tm-choices">
                {status.configured && (
                  <a
                    className="tm-submit"
                    href={automaticReady ? '/api/v1/auth/oidc/start?return=' + encodeURIComponent(returnTo) : undefined}
                    aria-disabled={!automaticReady}
                    onClick={(e) => !automaticReady && e.preventDefault()}
                  >
                    {Icon.key}
                    <span className="tm-submit-label">{automaticReady ? 'الدخول الآلي بالحساب المؤسسي' : 'الدخول الآلي غير متاح الآن'}</span>
                  </a>
                )}
                {status.manual && (
                  <button type="button" className="tm-ghost" onClick={() => setManual(true)}>
                    {Icon.user}
                    <span>إدخال اسم المستخدم وكلمة المرور يدوياً</span>
                  </button>
                )}
                {!status.configured && !status.manual && (
                  <div className="tm-alert tm-alert-warning">
                    <span>لم تُهيأ خدمات الدخول في هذه البيئة. أبلغ مدير النظام.</span>
                  </div>
                )}
              </div>
            )}

            {status && manual && (
              <form className="tm-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && back()} noValidate>
                <div className="tm-field">
                  <label className="tm-sr" htmlFor="tm-username">
                    اسم المستخدم
                  </label>
                  <input id="tm-username" ref={usernameRef} placeholder="اسم المستخدم" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
                  <span className="tm-glyph">{Icon.user}</span>
                </div>
                <div className="tm-field tm-with-reveal">
                  <label className="tm-sr" htmlFor="tm-password">
                    كلمة المرور
                  </label>
                  <input
                    id="tm-password"
                    type={reveal ? 'text' : 'password'}
                    placeholder="كلمة المرور"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <span className="tm-glyph">{Icon.lock}</span>
                  <button type="button" className="tm-reveal" aria-controls="tm-password" aria-pressed={reveal} aria-label="إظهار كلمة المرور أو إخفاؤها" onClick={() => setReveal(!reveal)}>
                    {reveal ? Icon.eyeOff : Icon.eye}
                  </button>
                </div>
                <button className={'tm-submit' + (busy ? ' is-loading' : '')} type="submit" disabled={busy}>
                  <span className="tm-submit-label">تسجيل الدخول</span>
                  <span className="tm-spinner" aria-hidden="true" />
                  <span className="tm-arrow">{Icon.forward}</span>
                </button>
                <button type="button" className="tm-ghost" onClick={back}>
                  <span className="tm-arrow">{Icon.back}</span>
                  <span>العودة إلى خيارات الدخول</span>
                </button>
                <p className="tm-help">يتحقق الدليل المؤسسي من كلمة المرور ولا يحفظها النظام.</p>
              </form>
            )}
            <p className="tm-foot">بيئة تشغيل داخلية معزولة · TMRKZ نسخة 1.0.0</p>
          </div>
        </main>
        <aside className="tm-board" aria-label="إرشادات الدخول">
          <header className="tm-board-head">
            <strong>إرشادات الدخول</strong>
            <small>نظام المواقع والمرافق والإجراءات الإدارية</small>
          </header>
          <article className="tm-note">
            <span className="tm-note-meta">الدخول الآلي</span>
            <b>بالحساب المؤسسي</b>
            <p>يتم عبر خدمة الدخول المؤسسية، ولا يطلب كلمة المرور إذا كنت قد سجلت الدخول فيها حديثاً.</p>
          </article>
          <article className="tm-note">
            <span className="tm-note-meta">الإدخال اليدوي</span>
            <b>اسم المستخدم وكلمة المرور</b>
            <p>بيانات حسابك في الدليل المؤسسي نفسها المستخدمة في أجهزة العمل. يتحقق منها الدليل، ولا يحفظها النظام.</p>
          </article>
          <article className="tm-note">
            <span className="tm-note-meta">الصلاحيات والحماية</span>
            <b>الصلاحيات من جهتك</b>
            <p>تُمنح الصلاحيات وفق انتمائك الوظيفي. يُوقف الدخول مؤقتاً بعد محاولات خاطئة متكررة.</p>
          </article>
          <footer className="tm-board-foot">التشغيل داخل الشبكة الداخلية فقط</footer>
        </aside>
      </section>
    </div>
  );
}
