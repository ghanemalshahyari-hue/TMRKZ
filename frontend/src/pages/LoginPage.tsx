import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AuthStatus } from '../api/types';
import '../styles/signin.css';

/** Messages for the error the server put in the address after a refused sign-in (never a fallback sign-in). */
const ERRORS: Record<string, string> = {
  IDENTITY_NOT_LINKED: 'تحقق الدليل المؤسسي من حسابك، لكنه غير مربوط بسجل في الموارد البشرية.',
  IDENTITY_SIGN_IN_FAILED: 'لم يكتمل الدخول. أعد المحاولة.',
  IDENTITY_PROVIDER_UNAVAILABLE: 'خدمة الدخول المؤسسي غير متاحة الآن. لا يوجد دخول بديل؛ حاول لاحقاً أو أبلغ الدعم الفني.',
  IDENTITY_PROVIDER_NOT_CONFIGURED: 'الدخول المؤسسي غير مهيأ في هذه البيئة. أبلغ مدير النظام.',
  PROVIDER_ACCESS_DENIED: 'رفضت خدمة الدخول إتمام العملية.',
};
const REASONS: Record<string, string> = {
  NO_MATCH: 'لم يُعثر على سجلك في الموارد البشرية؛ أُحيل الطلب إلى مسؤول الصلاحيات في جهتك.',
  INACTIVE: 'سجلك غير نشط في الموارد البشرية.',
  AMBIGUOUS: 'مفتاح الربط يطابق أكثر من سجل؛ أُحيل الطلب إلى مسؤول الصلاحيات للتحقق.',
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

/**
 * Without a session the application goes straight to the sign-in page (username and password, checked by the
 * organisation's directory). This TMRKZ page appears only when sign-in cannot start or was refused, in the same design,
 * with the reason and a way back to the sign-in page.
 */
export function LoginPage() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error] = useState(() => readError(window.location.hash));
  const startUrl = '/api/v1/auth/oidc/start?return=' + encodeURIComponent('/' + (error ? '' : window.location.hash));

  useEffect(() => {
    api
      .authStatus()
      .then((s) => {
        setStatus(s);
        if (!error && s.configured && s.reachable) window.location.replace(startUrl);
      })
      .catch(() => setStatus({ provider: 'OIDC', configured: false, reachable: false }));
    if (error) history.replaceState(null, '', window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = !!status?.configured && status.reachable;
  const message = error ?? (status && !ready ? (status.configured ? ERRORS.IDENTITY_PROVIDER_UNAVAILABLE : ERRORS.IDENTITY_PROVIDER_NOT_CONFIGURED) : null);

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
              {message && (
                <div className={'tm-alert ' + (error ? 'tm-alert-error' : 'tm-alert-warning')}>
                  <span>{message}</span>
                </div>
              )}
            </div>
            {!message && <p className="tm-help">جارٍ فتح صفحة الدخول…</p>}
            {message && (
              <a className="tm-submit" href={ready ? startUrl : undefined} aria-disabled={!ready} onClick={(e) => !ready && e.preventDefault()}>
                <span className="tm-submit-label">{ready ? 'العودة إلى تسجيل الدخول' : 'خدمة الدخول غير متاحة'}</span>
              </a>
            )}
            <p className="tm-foot">بيئة تشغيل داخلية معزولة · TMRKZ</p>
          </div>
        </main>
        <aside className="tm-board" aria-label="إرشادات الدخول">
          <header className="tm-board-head">
            <strong>إرشادات الدخول</strong>
            <small>نظام المواقع والمرافق والإجراءات الإدارية</small>
          </header>
          <article className="tm-note">
            <span className="tm-note-meta">الحساب</span>
            <b>استخدم حسابك في الدليل المؤسسي</b>
            <p>اسم المستخدم وكلمة المرور نفسها المستخدمة في أجهزة العمل. يتحقق منها الدليل المؤسسي، ولا يحفظها النظام.</p>
          </article>
          <article className="tm-note">
            <span className="tm-note-meta">الصلاحيات</span>
            <b>الصلاحيات من جهتك</b>
            <p>تُمنح الصلاحيات وفق انتمائك الوظيفي والمسؤوليات المعتمدة، ولا تُمنح بمجرد امتلاك حساب.</p>
          </article>
          <article className="tm-note">
            <span className="tm-note-meta">الحماية</span>
            <b>حماية الحساب</b>
            <p>يُوقف الدخول مؤقتاً بعد محاولات خاطئة متكررة. لا تشارك كلمة المرور، وسجّل الخروج عند الانتهاء.</p>
          </article>
          <footer className="tm-board-foot">التشغيل داخل الشبكة الداخلية فقط</footer>
        </aside>
      </section>
    </div>
  );
}
