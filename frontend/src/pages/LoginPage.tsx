import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AuthStatus } from '../api/types';
import { Icon } from '../components/ui';

/** Messages for the error the server put in the address after a refused sign-in (never a fallback sign-in). */
const ERRORS: Record<string, string> = {
  IDENTITY_NOT_LINKED: 'تحقق مزود الهوية من حسابك، لكنه غير مربوط بسجل في الموارد البشرية.',
  IDENTITY_SIGN_IN_FAILED: 'لم يكتمل الدخول. ابدأ من جديد من هذه الصفحة.',
  IDENTITY_PROVIDER_UNAVAILABLE: 'مزود الهوية غير متاح الآن. لا يوجد دخول بديل؛ حاول لاحقاً أو أبلغ الدعم الفني.',
  IDENTITY_PROVIDER_NOT_CONFIGURED: 'الدخول المؤسسي غير مهيأ في هذه البيئة. أبلغ مدير النظام.',
  PROVIDER_ACCESS_DENIED: 'رفض مزود الهوية إتمام الدخول.',
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
 * Enterprise sign-in only: the button sends the browser to the organisation's identity provider (passwords are checked by
 * the directory there, never here). The current address is kept so the person returns to the screen they asked for.
 */
export function LoginPage() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error] = useState(() => readError(window.location.hash));

  useEffect(() => {
    api
      .authStatus()
      .then(setStatus)
      .catch(() => setStatus({ provider: 'OIDC', configured: false, reachable: false }));
    if (error) history.replaceState(null, '', window.location.pathname);
  }, [error]);

  const returnTo = '/' + (error ? '' : window.location.hash);
  const ready = !!status?.configured && status.reachable;

  return (
    <div className="login-shell">
      <div className="login-layout">
        <section className="login-visual card" aria-hidden="true">
          <div className="login-visual-grid" />
          <div className="login-visual-content">
            <span className="eyebrow">TMRKZ PLATFORM</span>
            <h2>منصة إدارية للمرافق والحجوزات والموافقات</h2>
            <p className="micro">
              تشغيل داخلي آمن، صلاحيات مفصولة، وسير عمل واضح من الطلب حتى الاعتماد النهائي دون تعارض في الحجوزات.
            </p>
            <ul className="login-highlights">
              <li>خريطة مرافق موحّدة مع التحقق من الإتاحة</li>
              <li>موافقات متسلسلة ومتوازية بسجل تدقيق كامل</li>
              <li>دخول مؤسسي وجلسات خادم داخل بيئة تشغيل معزولة</li>
            </ul>
          </div>
        </section>
        <div className="card login-card">
          <div className="login-brand">
            <span className="brand-logo">
              <Icon name="map" />
            </span>
            <span>
              <strong>
                TMRKZ<span>.</span>
              </strong>
              <small>المواقع · المرافق · الإجراءات</small>
            </span>
          </div>
          <span className="eyebrow">SIGN IN / ENTERPRISE IDENTITY</span>
          <h1>تسجيل الدخول</h1>
          <p className="micro muted login-note">
            يتم الدخول بحسابك في الدليل المؤسسي. تُدار الجلسة في الخادم وتُقيّم الصلاحيات عند كل إجراء وفق جهتك وانتمائك الوظيفي.
          </p>
          {error && (
            <div className="note red" role="alert" style={{ marginBottom: 14 }}>
              {error}
            </div>
          )}
          {status && !ready && (
            <div className="note orange" role="status" style={{ marginBottom: 14 }}>
              {status.configured ? ERRORS.IDENTITY_PROVIDER_UNAVAILABLE : ERRORS.IDENTITY_PROVIDER_NOT_CONFIGURED}
            </div>
          )}
          <a
            className={'button primary full' + (ready ? '' : ' disabled')}
            href={ready ? '/api/v1/auth/oidc/start?return=' + encodeURIComponent(returnTo) : undefined}
            aria-disabled={!ready}
          >
            {status ? 'الدخول بالحساب المؤسسي' : 'جارٍ التحقق من مزود الهوية…'}
          </a>
        </div>
      </div>
    </div>
  );
}
