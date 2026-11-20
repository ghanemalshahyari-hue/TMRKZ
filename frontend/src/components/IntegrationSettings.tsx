import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { DirectoryTestResult, IntegrationView, OidcTestResult } from '../api/types';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';
import {
  AD_PRESET,
  SOURCE_LABEL,
  STANDARD_PRESET,
  bindDescription,
  directoryFromSaved,
  directoryProblem,
  directoryUrl,
  isIpAddress,
  oidcFromSaved,
  oidcIssuer,
  oidcProblem,
  portFor,
  type DirectoryForm,
  type OidcForm,
  type SecurityMode,
} from '../lib/integrationSettings';

/**
 * «إعدادات التكامل» (owner, 20 Nov 2026; ADR-092), as MOVER's page: the enterprise directory of the manual sign-in and the
 * Keycloak of the automatic button, entered here by whoever configures the system, tested with the values on the screen,
 * saved on the server (secrets encrypted, never shown again) and in force at once — no file on the server, no restart.
 * Nothing saved, or a section switched off: the server's .env applies, and the screen shows those values.
 */
export function IntegrationSettings() {
  return (
    <>
      <DirectorySection />
      <OidcSection />
    </>
  );
}

function Source({ view }: { view: IntegrationView | null }) {
  if (!view) return <p className="micro muted">جارٍ التحميل…</p>;
  return (
    <p className="micro muted" style={{ margin: '6px 0 12px' }}>
      الحالة: <b>{SOURCE_LABEL[view.source] ?? view.source}</b>
      {view.updatedAt ? ' · آخر حفظ ' + fullTime(view.updatedAt) : ''}
      {!view.keyConfigured && <span className="note red" style={{ display: 'block', marginTop: 6 }}>مفتاح حماية الإعدادات (TMRKZ_HR_SETTINGS_KEY) غير مهيأ في بيئة التشغيل؛ لا يمكن حفظ كلمة مرور أو سر.</span>}
      {view.secretError && <span className="note orange" style={{ display: 'block', marginTop: 6 }}>{view.secretError}</span>}
      {view.error && <span className="note red" style={{ display: 'block', marginTop: 6 }}>{view.error}</span>}
    </p>
  );
}

function EnvRow({ env, keys }: { env: Record<string, unknown>; keys: [string, string][] }) {
  const rows = keys.filter(([k]) => env[k] != null && env[k] !== '' && env[k] !== false);
  if (!rows.length) return <p className="micro muted">لا قيم في ملف البيئة.</p>;
  return (
    <dl className="int-env">
      {rows.map(([k, label]) => (
        <div key={k}>
          <dt>{label}</dt>
          <dd dir="ltr">{String(env[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

function DirectorySection() {
  const app = useApp();
  const [view, setView] = useState<IntegrationView | null>(null);
  const [form, setForm] = useState<DirectoryForm>(directoryFromSaved(null));
  const [testLogin, setTestLogin] = useState('');
  const [testPassword, setTestPassword] = useState('');
  const [test, setTest] = useState<DirectoryTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEnv, setShowEnv] = useState(false);

  const load = () =>
    api.integrationDirectory().then((v) => {
      setView(v);
      setForm(directoryFromSaved(v.saved as never));
    }, (e: Error) => app.toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passwordStored = !!(view?.saved && (view.saved as { bindPasswordSet?: boolean }).bindPasswordSet);
  const problem = directoryProblem(form, passwordStored);
  const set = (p: Partial<DirectoryForm>) => {
    setForm({ ...form, ...p });
    setTest(null);
  };
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) app.toast(done);
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof DirectoryForm, label: string, hint?: string, type = 'text') => (
    <label className="field">
      <span>
        {label}
        {hint ? <small className="muted"> — {hint}</small> : null}
      </span>
      <input
        type={type}
        dir="ltr"
        value={String(form[key] ?? '')}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        onChange={(e) => set({ [key]: type === 'number' ? Number(e.target.value) : e.target.value } as Partial<DirectoryForm>)}
      />
    </label>
  );

  return (
    <section className="card padding int-settings" data-testid="integration-directory" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>إعدادات التكامل — الدليل المؤسسي (LDAP)</h2>
        <span className="pill">{view ? SOURCE_LABEL[view.source] : '…'}</span>
      </div>
      <Source view={view} />
      <p className="micro muted" style={{ margin: '0 0 12px' }}>
        الدخول اليدوي: يُتحقق من اسم المستخدم وكلمة المرور بربطٍ مباشر بالدليل عبر اتصال مؤمَّن (LDAPS أو StartTLS) بشهادة الجهة المصدرة، كما في MOVER.
        التغيير يسري فور الحفظ من غير إعادة تشغيل، ويتقدم على قيم ملف البيئة.
      </p>
      <div className="form-grid">
        {field('server', 'خادم الدليل', 'الاسم الذي صدرت له الشهادة')}
        <label className="field">
          <span>وضع التأمين</span>
          <select value={form.securityMode} onChange={(e) => set({ securityMode: e.target.value as SecurityMode, port: portFor(e.target.value as SecurityMode, form.port) })}>
            <option value="ldaps">LDAPS (636)</option>
            <option value="starttls">StartTLS (389)</option>
          </select>
        </label>
        {field('port', 'المنفذ', undefined, 'number')}
        {field('domain', 'نطاق الدخول', 'يدخل كل شخص بحسابه user@domain')}
        {field('baseDn', 'قاعدة البحث (Base DN)', 'مثل DC=example,DC=local')}
        {field('bindDn', 'حساب الخدمة (اختياري مع نطاق الدخول)', 'الاسم المميز')}
        <label className="field">
          <span>كلمة مرور حساب الخدمة {passwordStored ? '(محفوظة؛ اتركها فارغة للإبقاء عليها)' : ''}</span>
          <input type="password" dir="ltr" autoComplete="new-password" value={form.bindPassword} onChange={(e) => set({ bindPassword: e.target.value })} />
        </label>
        {field('timeoutSeconds', 'المهلة (ثانية)', undefined, 'number')}
      </div>
      <p className="micro muted" style={{ margin: '4px 0 10px' }} data-testid="directory-derived">
        العنوان: <code dir="ltr">{directoryUrl(form) || '—'}</code> · {bindDescription(form)}
        {isIpAddress(form.server) ? ' · كُتب الخادم كعنوان IP: يجب أن تذكر الشهادة هذا العنوان، وإلا فاكتب اسم الخادم.' : ''}
      </p>
      <details className="int-more">
        <summary>السمات (أسماء الحقول في الدليل)</summary>
        <div className="flex" style={{ gap: 8, margin: '8px 0' }}>
          <button type="button" className="button small" onClick={() => set(AD_PRESET)}>
            Active Directory (كما في MOVER)
          </button>
          <button type="button" className="button small" onClick={() => set(STANDARD_PRESET)}>
            دليل قياسي (inetOrgPerson)
          </button>
        </div>
        <div className="form-grid">
          {field('usernameAttribute', 'سمة اسم الدخول')}
          {field('uuidAttribute', 'سمة المعرّف الثابت')}
          {field('userObjectClass', 'صنف الكائن')}
          {field('employeeNumberAttribute', 'سمة الرقم الوظيفي / العسكري')}
          {field('rankAttribute', 'سمة الرتبة', 'اختياري')}
          {field('positionAttribute', 'سمة المنصب', 'اختياري')}
          {field('unitIdAttribute', 'سمة معرّف الوحدة', 'اختياري')}
          {field('unitNameAttribute', 'سمة اسم الوحدة', 'اختياري')}
          {field('mainUnitIdAttribute', 'سمة الوحدة الرئيسية', 'اختياري')}
        </div>
      </details>
      <label className="field" style={{ marginTop: 10 }}>
        <span>شهادة الجهة المصدرة (CA) بصيغة PEM — تُلصق هنا، وتُضاف إلى شهادات مجلد الخادم</span>
        <textarea dir="ltr" rows={5} spellCheck={false} value={form.caCertificatesPem} onChange={(e) => set({ caCertificatesPem: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" />
      </label>
      <label className="setting-row">
        <span>
          <b>تفعيل هذه الإعدادات</b>
          <small>معطلة: تعود القيم إلى ملف البيئة على الخادم</small>
        </span>
        <input className="toggle" type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label="تفعيل إعدادات الدليل" />
      </label>
      <div className="int-test">
        <b>اختبار الاتصال</b>
        <small className="muted">يستخدم القيم المكتوبة أعلاه كما هي، ولا يُحفظ منها شيء. مع اسم مستخدم وكلمة مرور يُجرَّب دخول ذلك الشخص نفسه.</small>
        <div className="form-grid">
          <label className="field"><span>اسم مستخدم للتجربة (اختياري)</span><input dir="ltr" autoComplete="off" value={testLogin} onChange={(e) => setTestLogin(e.target.value)} /></label>
          <label className="field"><span>كلمة مروره</span><input type="password" dir="ltr" autoComplete="new-password" value={testPassword} onChange={(e) => setTestPassword(e.target.value)} /></label>
        </div>
      </div>
      {problem && <p className="micro" style={{ color: 'var(--danger, #b42318)' }}>{problem}</p>}
      <div className="flex" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="button" disabled={busy || !!problem} onClick={() => act(async () => setTest(await api.testIntegrationDirectory(form, testLogin || undefined, testPassword || undefined)))}>
          اختبار الاتصال
        </button>
        <button className="button primary" disabled={busy || !!problem} onClick={() => act(async () => { setView(await api.saveIntegrationDirectory(form)); setForm({ ...form, bindPassword: '' }); }, 'حُفظت إعدادات الدليل المؤسسي وسرت فوراً')}>
          حفظ
        </button>
        {view?.saved && (
          <button className="button" disabled={busy} onClick={() => act(async () => { setView(await api.clearIntegrationDirectory()); setForm(directoryFromSaved(null)); }, 'أُزيلت الإعدادات المحفوظة؛ تسري قيم ملف البيئة')}>
            العودة إلى إعدادات ملف البيئة
          </button>
        )}
        <button type="button" className="button small" onClick={() => setShowEnv(!showEnv)}>
          {showEnv ? 'إخفاء قيم ملف البيئة' : 'عرض قيم ملف البيئة'}
        </button>
      </div>
      {test && (
        <div className={'note ' + (test.ok ? '' : 'red')} style={{ marginTop: 10 }} data-testid="directory-test-result">
          {test.message} ({test.elapsedMs} م.ث)
          {test.dn ? <div dir="ltr" className="micro">{test.dn}{test.displayName ? ' — ' + test.displayName : ''}</div> : null}
        </div>
      )}
      {showEnv && view && (
        <div style={{ marginTop: 10 }}>
          <EnvRow
            env={view.env}
            keys={[
              ['server', 'الخادم'],
              ['port', 'المنفذ'],
              ['securityMode', 'وضع التأمين'],
              ['domain', 'نطاق الدخول'],
              ['directBindPattern', 'نمط الربط'],
              ['baseDn', 'قاعدة البحث'],
              ['bindDn', 'حساب الخدمة'],
              ['usernameAttribute', 'سمة اسم الدخول'],
              ['uuidAttribute', 'سمة المعرّف'],
              ['employeeNumberAttribute', 'سمة الرقم'],
              ['userObjectClass', 'صنف الكائن'],
              ['caDir', 'مجلد الشهادات'],
            ]}
          />
          {view.saved && view.source === 'SAVED' && (
            <button type="button" className="button small" style={{ marginTop: 6 }} onClick={() => setForm(directoryFromSaved({ ...view.env, enabled: true } as never))}>
              نسخ قيم ملف البيئة إلى النموذج
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function OidcSection() {
  const app = useApp();
  const [view, setView] = useState<IntegrationView | null>(null);
  const [form, setForm] = useState<OidcForm>(oidcFromSaved(null));
  const [test, setTest] = useState<OidcTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEnv, setShowEnv] = useState(false);

  const load = () =>
    api.integrationOidc().then((v) => {
      setView(v);
      setForm(oidcFromSaved(v.saved as never));
    }, (e: Error) => app.toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const secretStored = !!(view?.saved && (view.saved as { clientSecretSet?: boolean }).clientSecretSet);
  const problem = oidcProblem(form, secretStored);
  const set = (p: Partial<OidcForm>) => {
    setForm({ ...form, ...p });
    setTest(null);
  };
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) app.toast(done);
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof OidcForm, label: string, hint?: string, type = 'text') => (
    <label className="field">
      <span>
        {label}
        {hint ? <small className="muted"> — {hint}</small> : null}
      </span>
      <input type={type} dir="ltr" value={String(form[key] ?? '')} autoComplete={type === 'password' ? 'new-password' : 'off'} onChange={(e) => set({ [key]: e.target.value } as Partial<OidcForm>)} />
    </label>
  );
  const envRedirect = view?.env && (view.env as { redirectUri?: string }).redirectUri;

  return (
    <section className="card padding int-settings" data-testid="integration-oidc" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>إعدادات التكامل — الدخول الآلي (Keycloak)</h2>
        <span className="pill">{view ? SOURCE_LABEL[view.source] : '…'}</span>
      </div>
      <Source view={view} />
      <p className="micro muted" style={{ margin: '0 0 12px' }}>
        زر «الدخول بالحساب المؤسسي» يفتح Keycloak المؤسسي الذي يُكتب هنا (الخادم، المجال، عميل تمركز وسره)، كما في MOVER. حسابا المنصة
        admin وdeveloper يبقيان على Keycloak المحلي ولا يتأثران. اطلب من فريق Keycloak عميلاً سرياً بتدفق الرمز (Authorization Code + PKCE)
        وعنوان العودة المبين أدناه.
      </p>
      <div className="form-grid">
        {field('serverUrl', 'عنوان خادم Keycloak', 'الذي يفتحه المتصفح، مثل https://sso.example.local/auth')}
        {field('realm', 'المجال (Realm)')}
        {field('clientId', 'معرّف العميل (Client ID)')}
        <label className="field">
          <span>سر العميل (Client Secret) {secretStored ? '(محفوظ؛ اتركه فارغاً للإبقاء عليه)' : ''}</span>
          <input type="password" dir="ltr" autoComplete="new-password" value={form.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} />
        </label>
        {field('internalUrl', 'العنوان الداخلي', 'اختياري: عنوان الخادم من داخل الشبكة إن اختلف')}
        {field('issuer', 'المُصدر (Issuer)', 'اختياري: إن لم يكن <الخادم>/realms/<المجال>')}
        {field('redirectUri', 'عنوان العودة', envRedirect ? 'فارغ = ' + envRedirect : 'العنوان العام لتمركز + /api/v1/auth/oidc/callback')}
      </div>
      <p className="micro muted" style={{ margin: '4px 0 10px' }} data-testid="oidc-derived">
        المُصدر المتوقع في كل رمز: <code dir="ltr">{oidcIssuer(form) || '—'}</code>
      </p>
      <label className="field">
        <span>شهادة الجهة المصدرة (CA) لخادم Keycloak بصيغة PEM — إن كانت من جهة داخلية</span>
        <textarea dir="ltr" rows={4} spellCheck={false} value={form.caCertificatesPem} onChange={(e) => set({ caCertificatesPem: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" />
      </label>
      <label className="setting-row">
        <span>
          <b>تفعيل هذه الإعدادات</b>
          <small>معطلة: يعود الدخول الآلي إلى ما في ملف البيئة (Keycloak المحلي عادةً)</small>
        </span>
        <input className="toggle" type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label="تفعيل إعدادات Keycloak" />
      </label>
      {problem && <p className="micro" style={{ color: 'var(--danger, #b42318)' }}>{problem}</p>}
      <div className="flex" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="button" disabled={busy || !!problem} onClick={() => act(async () => setTest(await api.testIntegrationOidc(form)))}>
          اختبار الاتصال
        </button>
        <button className="button primary" disabled={busy || !!problem} onClick={() => act(async () => { setView(await api.saveIntegrationOidc(form)); setForm({ ...form, clientSecret: '' }); }, 'حُفظت إعدادات Keycloak وسرت فوراً')}>
          حفظ
        </button>
        {view?.saved && (
          <button className="button" disabled={busy} onClick={() => act(async () => { setView(await api.clearIntegrationOidc()); setForm(oidcFromSaved(null)); }, 'أُزيلت الإعدادات المحفوظة؛ تسري قيم ملف البيئة')}>
            العودة إلى إعدادات ملف البيئة
          </button>
        )}
        <button type="button" className="button small" onClick={() => setShowEnv(!showEnv)}>
          {showEnv ? 'إخفاء قيم ملف البيئة' : 'عرض قيم ملف البيئة'}
        </button>
      </div>
      {test && (
        <div className={'note ' + (test.ok ? '' : 'red')} style={{ marginTop: 10 }} data-testid="oidc-test-result">
          {test.message} ({test.elapsedMs} م.ث)
          <div dir="ltr" className="micro">redirect: {test.redirectUri}</div>
        </div>
      )}
      {showEnv && view && (
        <div style={{ marginTop: 10 }}>
          <EnvRow
            env={view.env}
            keys={[
              ['issuer', 'المُصدر'],
              ['internalUrl', 'العنوان الداخلي'],
              ['clientId', 'العميل'],
              ['redirectUri', 'عنوان العودة'],
              ['local', 'Keycloak المحلي'],
            ]}
          />
        </div>
      )}
    </section>
  );
}
